/**
 * subagents.ts — 探测「此刻有没有子代理在跑」。
 *
 * recap 是**闲置制**触发的：回合结束（`agent_settled`）后静止 30s 就生成摘要。
 * 但异步子代理是**脱离回合**的：`subagent({ async: true })` 一发出去主回合就结束，
 * 子代理还在后台跑几十秒甚至几分钟，结果稍后由被唤醒的回合带回来。这时 30s 到点，
 * 摘要会把「刚把任务发出去、还在等」总结成「这轮干完了」。所以生成摘要前必须问一句
 * 「还有子代理在跑吗」，有就只重查、不生成 —— 等它们都结束了再重新起 30s 定时。
 *
 * 为什么走 pi-subagents 的进程内 RPC，而不是自己数 `subagent` 工具调用：
 *   - **数不出来**。异步调用立刻返回（`details.asyncId`），结果由后续回合带回，工具调用
 *     本身看不出"还在跑"；状态只活在 pi-subagents 的进程内 state 里（`asyncJobs` /
 *     `foregroundControls`），没有 session 条目、没有落盘文件可以读。
 *   - **它的文档就给了这个口子**。`pi-subagents/docs/extension-api.md` 的
 *     "In-process event-bus RPC" 一节是给「其他 Pi 扩展」用的公开接口：发
 *     `subagents:rpc:v1:request`、在 `subagents:rpc:v1:reply:<requestId>` 上收回复；
 *     `status` 方法（不带任何 target）的回包里带 `data.fleet`（Fleet status DTO v1），
 *     `totalActive` 就是当前会话的活跃子代理数（前台 + 异步 + 排队都算）。
 *   - **不 import pi-subagents 的任何文件**。它是独立安装的 npm 包，不是本扩展可解析的
 *     依赖；而且它也可能没装（换台机器就没装）。协议是版本化的字符串频道 + JSON 回包，
 *     按结构化最小接口对接即可。同理本文件**也不 import pi**（总线按下面的接口注入），
 *     所以 `node --test` 能拿假总线直接跑：
 *
 *         node --test clients/pi/extensions/recap/subagents.test.ts
 *
 * 失败一律当「没有」：没装 pi-subagents、协议版本变了、回包格式不认识、超时/抛异常 ——
 * 全部返回 false（fail-open）。宁可偶尔在子代理运行中生成一条摘要，也不能因为探测环节
 * 把 recap 整个弄停摆。探测超时 1s：没有子代理时对端回的是内存快照，毫秒级就到。
 */

/** pi 事件总线的子集（真实的 pi `EventBus` 结构兼容）。 */
export interface SubagentEventBus {
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
	emit(channel: string, data: unknown): void;
}

/** pi-subagents 的 RPC 频道（见其 docs/extension-api.md，协议版本 1）。 */
export const SUBAGENT_RPC_REQUEST = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_VERSION = 1;

/** 探测超时：没有子代理时对端秒回，超时就当对端不在。 */
export const SUBAGENT_RPC_TIMEOUT_MS = 1_000;

let requestSeq = 0;

/** 每个请求一个唯一 id —— 只认自己那条回复频道，不会吃到别人的回复。 */
export function nextSubagentRequestId(now = Date.now()): string {
	requestSeq += 1;
	return `recap-${requestSeq}-${now.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从 `status` 的回复里判断「有子代理在跑」。
 *
 * 主判据是 `data.fleet.totalActive`（有界 entries 之外的**全量**活跃数，所以超过
 * entries 窗口的也不会漏）。`asyncSnapshot.runs` 里的 `queued` / `running` 是兜底：
 * fleet 是 v1 才有的能力（`ping.capabilities.fleetStatus` 没有就整个不出现），
 * 快照在旧版本里也可能单独存在。两条都不认识就返回 false（fail-open）。
 */
export function isSubagentWorkActive(reply: unknown): boolean {
	if (!isRecord(reply) || reply.success !== true) return false;
	const data = reply.data;
	if (!isRecord(data)) return false;

	const fleet = data.fleet;
	if (isRecord(fleet) && typeof fleet.totalActive === "number" && fleet.totalActive > 0) return true;

	const snapshot = data.asyncSnapshot;
	const runs = isRecord(snapshot) ? snapshot.runs : undefined;
	if (!Array.isArray(runs)) return false;
	return runs.some((run) => isRecord(run) && (run.state === "queued" || run.state === "running"));
}

/**
 * 问一次 pi-subagents：现在有子代理在跑吗。
 *
 * 正常路径：先订阅回复频道 → 发 request → 收到回复（或超时）→ 退订 → 解析。
 * 任何一步出错都当「没有」，本函数**不抛异常**。
 */
export async function hasActiveSubagentWork(
	events: SubagentEventBus,
	options: { timeoutMs?: number; requestId?: string } = {},
): Promise<boolean> {
	const timeoutMs = options.timeoutMs ?? SUBAGENT_RPC_TIMEOUT_MS;
	const requestId = options.requestId ?? nextSubagentRequestId();

	const reply = await new Promise<unknown>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (value: unknown) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			try {
				unsubscribe?.();
			} catch {
				// 退订失败无所谓：handler 已经 settled，再来回复也直接忽略。
			}
			resolve(value);
		};

		try {
			const off = events.on(`${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`, finish);
			if (typeof off === "function") unsubscribe = off;
			timer = setTimeout(() => finish(undefined), timeoutMs);
			// **不要 unref 这个定时器**（2026-10-18 实测）：在后台子代理里（pi-subagents 的
			// runner 子进程）根本没有 RPC 应答方，这个超时就是唯一能把 Promise 解开的句柄；
			// unref 掉之后事件循环会在超时前耗尽，Node 直接 exit 0 —— 子代理产出完整但结果
			// 文件永远不写，父会话报 "exited with code 0 before writing a result"。
			// 代价只是最坏多等一个 timeoutMs（对端在线时毫秒级就到）。
			events.emit(SUBAGENT_RPC_REQUEST, {
				version: SUBAGENT_RPC_VERSION,
				requestId,
				method: "status",
				// 不带 target = 只要当前会话的舰队概要（对端走内存快照，秒回）。
				params: {},
				source: { extension: "recap" },
			});
		} catch {
			finish(undefined);
		}
	});

	return isSubagentWorkActive(reply);
}
