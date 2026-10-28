/**
 * recap — 极简会话摘要，取代第三方包 `@fradser/pi-recap`。
 *
 * 功能只有两条，刻意做到最小：
 *   1. `/recap` —— 手动总结当前对话；
 *   2. 对话结束后**静止 10 秒**（没有任何新输入）自动生成一条摘要，显示在输入框上方。
 *   发出新消息**立即清掉**已经显示的摘要（用户 2026-10-27 定；2026-10-26 曾改成保留，
 *   用户实测后改回）：新对话开始后旧摘要不再保留，下一轮结束、静止 10 秒后生成新的一条。
 *
 * `/recap` 是**幂等**的：同一轮对话已经生成过摘要（手动或自动都算）且此后没有新对话时，
 * 再执行直接返回 —— 不重跑模型、不清 widget、也不发通知。理由是重复执行本来就会生成一份
 * 一模一样的摘要（丢给模型的最后一轮对话根本没变），而一旦这次生成失败（模型返回空 /
 * thinking-only），那条「没能生成 recap」的提示就会把屏幕上刚生成的摘要顶掉。
 *
 * **有子代理在跑时不算「结束」**：静止 10s 只是「主回合结束了」的信号，而异步子代理
 * （`subagent({ async: true })`）是脱离回合的 —— 主回合早早 settled，子代理还在后台跑，
 * 10s 到点就会把「刚把任务发出去、还在等」总结成「这轮干完了」。所以计时器到点先问一句
 * 「还有子代理在跑吗」（pi-subagents 的进程内 RPC，见 `subagents.ts`）：有就只重查、
 * 不生成，等它们都结束了再重新起一轮 10s 定时。同一个回合还在跑时（`ctx.isIdle()`
 * 为 false，例如被异步子代理的完成通知唤醒的新回合）同样不生成。
 *
 * 为什么要自己写而不是用 pi-recap：
 *   pi-recap 的触发时机是**回合制** —— 监听 `agent_settled`，回合一结束就立刻生成并显示，
 *   于是它每轮都刷新、一直挂在输入框上方。而 recap 的用途是**提醒**：开发者离开窗口再回来时，
 *   一眼看到这个会话在做什么。那需要的是**闲置制**，不是回合制。我核过 pi-recap
 *   0.1.1~0.1.7 全部七个版本：每个都是 `pi.on("agent_settled")` 直接调 `performRecap()`，
 *   没有任何 idle / setTimeout / debounce 机制（唯一的 `setInterval` 是 spinner 转帧动画），
 *   它自己的 BDD 契约也写明是 "When an agent turn settles" —— 闲置语义它从来没有过。
 *   另外它带一堆用不上的东西：模型选择菜单、语言选择、`recap.json` 配置、session 落盘、
 *   跨会话注册表同步。本扩展把这些全部去掉。
 *
 * 刻意不做的事（都是明确要求，别"顺手补上"）：
 *   - **不做任何本地存储**：不写 `recap.json`、不写 `~/.pi/agent/directory-sessions/`。
 *   - **不落 session、不进上下文**：不调 `pi.appendEntry`。摘要只活在内存里（`currentRecap`），
 *     所以它既不会出现在会话日志里，也不会被后续请求带进上下文。生成走的是一次独立的
 *     `modelRegistry.complete()` 调用，与主对话的请求互不相干。
 *     代价：`/new` 或 `/resume` 后摘要不会恢复（这是刻意的，不是 bug）。
 *   - **不做任何配置**：闲置阈值写死 10s，语言写死中文，不提供环境变量、不提供开关命令。
 *   - 不 import `@fradser/pi-recap` 的任何文件（虽然它把 `generateRecap` / `buildRecapPrompt` /
 *     `getLastExchange` 都导出了，复用能少写约 100 行，但那会把本扩展绑死在第三方包的内部
 *     文件布局上 —— 它一升级或一卸载本扩展就崩）。提示词、清洗、取最后一轮对话全部自己实现。
 *
 * 显示格式与 pi-recap 一致：` ✦ Recap: <摘要>`，✦ 用 accent 色、"Recap:" 用 dim 色，
 * 续行按前缀宽度缩进对齐。**额外要求：摘要下方补一个空行**（render 末尾 push("")）。
 * 上方挨着别的 widget 时（`simple-task/` 的任务清单、pi-subagents 的 `async subagent`
 * 块、任何第三方扩展）**摘要上方再补一个空行** —— 判定直接复用 `simple-task/gap.ts`
 * 的「渲染邻居、看它面向自己那一侧有没有内容」，而不是按任务清单状态猜（见 `showWidget`
 * 里那段 `widgetGaps` 与重入保护的说明）。import 兄弟扩展的文件是刻意的取舍：两个扩展
 * 同仓库、同目录树、一起安装，依赖不存在的场景不存在，省掉一份重复的 walk 逻辑。
 *
 * 生命周期：
 *   `agent_start`        → 取消计时器（新一轮开始，上一轮排的摘要已经过期）
 *   `agent_settled`      → 起 10s 计时器（每轮结束都重置）
 *   计时器到点（空闲）   → 没有子代理在跑？→ 生成摘要 → 显示 widget
 *                        还有子代理在跑 → 不生成，改 10s 一次重查
 *   计时器到点（重查）   → 还在跑 → 继续重查；都没了 → 重新起 10s 定时
 *   `input`（交互输入）  → 取消计时器 + abort 生成 + 清掉屏幕上的摘要与内存状态
 *   `session_start`      → 清内存状态与 widget（新会话/恢复会话都不该带着上一会话的摘要）
 *   `session_shutdown`   → 停表 + abort
 *
 * 子代理探测放在 `subagents.ts`（不 import pi，可 `node --test` 单测）：问 pi-subagents
 * 的进程内 RPC；对方不在 / 超时 / 回包不认识一律当「没有」（fail-open）—— 不能因为探测
 * 环节把 recap 整个弄停摆。
 *
 * 必须防的坑（`simple-task/` 踩过的同一个）：
 *   **捕获的 `ctx` 在会话结束后会 stale**，访问 `ctx.ui` 会抛
 *   `"This extension ctx is stale after session replacement or reload"`。10s 计时器会比会话
 *   活得久，抛出发生在读 `ctx.ui` 那一刻、比 widget 的 `render()` 更早，所以 render 内部的
 *   try/catch 拦不住 —— 一个活过会话的定时器会**直接把宿主进程带崩**。因此三层防护：
 *   所有 `ctx.ui` 访问都包 try/catch、`session_shutdown` 里立刻停表 + abort、计时器 `unref()`。
 *   生成期间用户发新消息也要 abort，否则旧一轮的摘要会覆盖新一轮的。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { hasActiveSubagentWork } from "./subagents.ts";
import { widgetGaps } from "../simple-task/gap.ts";

/** 对话结束后静止多久才生成摘要。写死，不做配置。 */
const IDLE_MS = 10_000;
/** 还有子代理在跑时的重查间隔（只重查、不生成）。 */
const SUBAGENT_WAIT_MS = 10_000;
/** 生成的硬超时，到点 abort。 */
const GENERATE_TIMEOUT_MS = 30_000;
/** 摘要上限：单行、120 字符以内（"一眼可扫"）。 */
const MAX_RECAP_CHARS = 120;
/**
 * 摘要模型的最大输出 token。**必须同时容得下思考与正文**：claude 路由在
 * `gateway/config.yaml` 里钉了 `thinking: { type: enabled }` + `reasoning_effort: max`，摘要请求
 * 即使不传 thinking 也会先思考，而 Anthropic 的 `max_tokens` 是两者共享的预算。本机实测
 * 96 时 17 次里 6 次以 `stop_reason=max_tokens` 收场（4 次思考吃光、正文 0 字符，2 次只剩半句），
 * 512 时 8/8 完整结束；同目录 `working-indicator/` 的长思考实测到 1400 token，所以照它的结论取 1024。
 */
const MAX_TOKENS = 1024;
/** 喂给摘要模型的对话片段上限，避免把整段长回复塞进提示词。 */
const EXCHANGE_CLIP_CHARS = 4000;
/** widget key。pi-recap 已卸载，所以直接用 "recap"。 */
const WIDGET_KEY = "recap";

export default function (pi: ExtensionAPI) {
	/** 摘要只活在内存里 —— 不落盘、不进上下文。 */
	let currentRecap = "";
	/** 已生成过的回合指纹，用于去重（同一轮不重复调模型）。 */
	let completedKey: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortController: AbortController | undefined;
	/**
	 * 每次 `cancel()` 递增。计时器回调是异步的（要等一次子代理探测，最多 1s），
	 * 探测期间用户可能发新消息、新一轮可能开始 —— 回调靠这个序号判断自己是否已经过期。
	 */
	let stateToken = 0;

	// ─── 计时器 ────────────────────────────────────────────────

	function cancel(): void {
		stateToken += 1;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (abortController) {
			abortController.abort();
			abortController = undefined;
		}
	}

	/**
	 * 起一枚计时器。两种模式：
	 *   `idle`    —— 空闲倒计时，到点就生成摘要（除非发现还有活）
	 *   `waiting` —— 明知有子代理在跑，到点只重新查一次（不生成）
	 * 两者共用同一枚 `timer`（`schedule` 先 `cancel`），所以永远不会同时跑两枚。
	 */
	function schedule(ctx: ExtensionContext, mode: "idle" | "waiting"): void {
		cancel();
		const token = stateToken;
		timer = setTimeout(() => {
			timer = undefined;
			// 计时器会比会话活得久，ctx 可能已经 stale —— 整个回调都要兜住。
			void onTimerFire(ctx, mode, token).catch(() => {});
		}, mode === "idle" ? IDLE_MS : SUBAGENT_WAIT_MS);
		// 别让一个待执行的摘要把进程吊住（headless / 退出场景）。
		timer.unref?.();
	}

	/**
	 * 计时器到点：先确认「真的没事干了」，再决定生成、继续等、还是重新起表。
	 *
	 *   - 还有活（回合在跑 / 有子代理在跑） → 转 `waiting` 重查（不生成）
	 *   - `waiting` 重查到没活了         → 转 `idle` 重新起 10s 定时
	 *     —— 子代理结束的那一刻不生成摘要：结果刚回来、被唤醒的回合正要跑，
	 *        这时生成的摘要必然是半截的；让正常的回合结束 → 静止 10s 流程接管。
	 *   - `idle` 重查到没活了              → 生成摘要
	 *
	 * 探测是一次事件总线上的一问一答（最多 1s），期间用户可能发新消息、新一轮可能开始，
	 * 所以拿 `token` 在 `await` 之后重申一次：过期的回调直接退场（见 `stateToken`）。
	 */
	async function onTimerFire(ctx: ExtensionContext, mode: "idle" | "waiting", token: number): Promise<void> {
		const busy = await workInProgress(ctx);
		// 探测期间被取消（用户发了新消息 / 新一轮开始 / 换了会话）：这枚计时器已经过期。
		if (token !== stateToken) return;
		if (busy === undefined) return;
		if (busy) {
			schedule(ctx, "waiting");
			return;
		}
		if (mode === "waiting") {
			schedule(ctx, "idle");
			return;
		}
		await generate(ctx);
	}

	/**
	 * 现在还有活在跑吗。`undefined` = 已经问不出（ctx stale，会话被换掉了）——
	 * 这时什么都不做，等 `session_start` / `session_shutdown` 来清场。
	 *
	 * `ctx.isIdle()` 连着 `isCompacting`（pi 的实现是 `!streaming && !compacting`），
	 * 所以压缩期间也算「有活」。它可能抛 stale ctx 异常，必须包住。
	 */
	async function workInProgress(ctx: ExtensionContext): Promise<boolean | undefined> {
		try {
			if (!ctx.isIdle()) return true;
		} catch {
			return undefined;
		}
		try {
			return await hasActiveSubagentWork(pi.events);
		} catch {
			// 探测本身能自包异常，这里是第二层保险：拿不到答案就当作没活。
			return false;
		}
	}

	// ─── widget ────────────────────────────────────────────────

	function clearWidget(ctx: ExtensionContext): void {
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// stale ctx：会话已被替换，什么都不做。
		}
	}

	function showWidget(ctx: ExtensionContext): void {
		try {
			if (!currentRecap) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			const text = currentRecap;
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				/**
				 * 重入保护。`gap.ts` 的「看邻居」是**把邻居渲染出来**实现的，而 simple-task
				 * 那边的 gap.ts 也会反过来渲染 recap —— 两侧都走 walk 就会互递归（无保护时
				 * 递归到自己撑不住为止，靠各处的 try/catch 兜住就退化成"猜"，间隔不再可靠）。
				 * 所以本组件被重入时只输出内容行、跳过探测：外层那次 walk 随后看到的是对方
				 * **最终**的渲染结果，于是双方各自补一次、合起来恰好一行。
				 *
				 * 这个保护**不能挪进 `gap.ts`**：那里的「重入」意味着嵌套的这次 walk 一律返回
				 * 「无间隔」，于是 simple-task 会按"邻居首行有内容"补一次行尾空行、recap 再补
				 * 一次前导空行 —— 变成两行空行。粒度必须落在每个走 walk 的组件上。
				 */
				let inspectingNeighbours = false;
				const component = {
					render(width: number): string[] {
						// 格式对齐 pi-recap：` ✦ Recap: <摘要>`，✦ 用 accent、"Recap:" 用 dim。
						const prefix = ` ${theme.fg("accent", "✦")} ${theme.fg("dim", "Recap:")} `;
						const prefixWidth = visibleWidth(prefix);
						const contentWidth = Math.max(15, (width || 80) - prefixWidth);
						const indent = " ".repeat(prefixWidth);
						const wrapped = wrapTextWithAnsi(theme.fg("text", text), contentWidth);
						const lines = wrapped.map((line, i) => (i === 0 ? prefix + line : indent + line));
						// 上方挨着别的 widget（任务清单 / `async subagent` 块…）就补一行前导空行。
						// 判据与 simple-task 共用（`gap.ts` 文件头：邻居面向自己那一侧有可见内容、
						// 且不是空行 → 补）。pi 按 Map 插入顺序渲染编辑器上方的容器，recap 永远
						// 最后注册（闲置 10s 后才注册），所以上方的邻居才是常态。
						let gapAbove = false;
						if (!inspectingNeighbours) {
							inspectingNeighbours = true;
							try {
								gapAbove = widgetGaps(tui, component, width).above;
							} catch {
								// walk 出意外（pi 换了内部结构）：宁可不补空行，也不让异常崩掉这一帧。
								gapAbove = false;
							} finally {
								inspectingNeighbours = false;
							}
						}
						if (gapAbove) lines.unshift("");
						// 额外要求：摘要下方补一个空行。
						lines.push("");
						return lines;
					},
					invalidate() {},
				};
				return component;
			});
		} catch {
			// stale ctx。
		}
	}

	// ─── 生成 ──────────────────────────────────────────────────

	/**
	 * 当前对话的最后一轮 user / assistant 配对，以及它的指纹。
	 *
	 * 指纹同时用作两件事：`generate` 的去重键（同一轮不重复调模型），以及 `/recap` 的
	 * 重复执行闸门（见命令 handler）。两处必须用同一个函数算，否则两边会各算各的。
	 * 取不到（没有 model、或还没有成对的 user + assistant）时返回 undefined。
	 */
	function latestExchange(ctx: ExtensionContext):
		| { key: string; exchange: { user: string; assistant: string }; model: NonNullable<ExtensionContext["model"]> }
		| undefined {
		const model = ctx.model;
		if (!model) return undefined;

		const branch = (ctx.sessionManager?.getBranch?.() ?? []) as unknown[];
		const exchange = getLastExchange(branch);
		if (!exchange) return undefined;

		return {
			key: [exchange.user, exchange.assistant, model.provider, model.id].join("\u0000"),
			exchange,
			model,
		};
	}

	async function generate(ctx: ExtensionContext, force = false): Promise<void> {
		if (ctx.mode !== "tui") return;

		const latest = latestExchange(ctx);
		if (!latest) return;
		const { key, exchange, model } = latest;

		if (!force && completedKey === key && currentRecap) return;

		const controller = new AbortController();
		abortController = controller;
		// 用局部 const 而不是模块级的 `abortController`：`cancel()` 会把它置空，
		// 事后再读 `abortController?.signal.aborted` 就成了 undefined（守卫失效，
		// 被中断的那次生成反而会覆盖掉更新的摘要）—— 局部引用永远指向本次的 controller。
		const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return;

			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: "You generate ultra-concise, single-line session recaps.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildPrompt(exchange, currentRecap || undefined) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: controller.signal,
					maxTokens: MAX_TOKENS,
					// **不传 temperature**：这些 max 档路由在 0 温度下会退化成停不下来的长思考
					// （`working-indicator/` 实测 2048 额度也被吃光且零正文，默认温度 3s 正常返回）。
					cacheRetention: "none",
				},
			);

			// 被中断 / 被新一轮取代：丢弃结果，绝不覆盖更新的摘要。
			if (controller.signal.aborted) return;

			const text = cleanRecapText(textFromAssistant(response), response.stopReason === "length");
			if (!text) return;

			completedKey = key;
			currentRecap = text;
			showWidget(ctx);
		} catch {
			// 超时 / 中断 / 网络错误：静默放弃，不打扰用户。
		} finally {
			clearTimeout(timeout);
			if (abortController === controller) abortController = undefined;
		}
	}

	// ─── 事件 ──────────────────────────────────────────────────

	// agent_settled = "pi 不会再自动继续跑"（文档原文：no retry/compaction/follow-up left），
	// 是判定"对话结束"最准确的事件。agent_end 不行：那之后 pi 仍可能自动重试、压缩重试、
	// 或继续跑排队中的 follow-up 消息。
	// 注意：settled 只说明**主回合**结束了。异步子代理可能还在后台跑，那时待执行的摘要
	// 会被 `onTimerFire` 拦下来转成重查（见那里），所以这里无条件起表是对的。
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		schedule(ctx, "idle");
	});

	// 新一轮开始 = 又进入「任务进行中」：取消上一轮排的摘要（回合结束时 settled 会重新起表）。
	// 被异步子代理的完成通知唤醒的回合也会走到这里 —— 那时绝不能把子代理还在跑时的
	// 半截状态总结出来。已经显示在屏幕上的摘要不动（只清待执行的计时器）。
	pi.on("agent_start", () => {
		cancel();
	});

	// 发出新消息：取消待执行的生成（那条待生成的是上一轮的，新回合结束会重新排），
	// 并**立即清掉屏幕上那条与内存状态** —— 用户 2026-10-27 定：新对话开始后旧摘要不再
	// 保留（2026-10-26 曾改成保留，用户实测后改回）。下一轮结束、静止 10s 后生成新的一条。
	// 代价：`buildPrompt` 的「渐进式摘要」上一条随 `currentRecap` 一起被清，每轮摘要
	// 从零开始 —— 与「不再保留」一致，是接受过的取舍。
	// 只认交互输入（rpc / extension 来源不算"用户继续对话"）。
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive") return;
		cancel();
		currentRecap = "";
		completedKey = undefined;
		clearWidget(ctx);
	});

	// 新会话 / 恢复会话：摘要不落盘，所以什么都不该带过来。
	pi.on("session_start", (_event, ctx) => {
		cancel();
		currentRecap = "";
		completedKey = undefined;
		clearWidget(ctx);
	});

	// 关键：停表 + abort，否则定时器活过会话后访问 stale ctx 会把宿主进程带崩。
	pi.on("session_shutdown", () => {
		cancel();
	});

	// ─── 命令 ──────────────────────────────────────────────────

	pi.registerCommand("recap", {
		description: "Summarize the current conversation",
		handler: async (_args, ctx) => {
			// 重复执行闸门：已经为**当前这一轮对话**生成过摘要、且它还挂在屏幕上时，直接返回。
			// 这时再跑一遍模型只会得到同一份摘要（最后一轮对话根本没变），而万一它这次返回空
			// （失败提示会把刚生成的摘要顶掉）连屏幕上那条也保不住。所以什么都不做，让它留着。
			// 注意判据是「摘要存在 **且** 指纹相同」：指纹不同说明此后的对话已经换了一轮（例如
			// 非交互来源的新消息，`input` 处理器清不到），那就该照常重新生成。
			const latest = latestExchange(ctx);
			if (latest && currentRecap && completedKey === latest.key) return;

			cancel();
			currentRecap = "";
			completedKey = undefined;
			// 手动触发不走「有没有子代理在跑」的闸门：用户现在就要，不管后台在跑什么。
			await generate(ctx, true);
			ctx.ui.notify(currentRecap ? `✦ Recap: ${currentRecap}` : "Could not generate a recap (no usable conversation, or the model returned nothing)", "info");
		},
	});

	// ─── 纯函数（自包含，不依赖任何第三方包）──────────────────────

	/** 从消息内容（字符串或 content-block 数组）里抽纯文本。 */
	function textFromContent(content: unknown): string {
		if (typeof content === "string") return content.trim();
		if (!Array.isArray(content)) return "";
		return content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text as string)
			.join("\n")
			.trim();
	}

	/** 从 assistant 响应里抽文本（thinking-only 的输出会得到空串，于是放弃这次生成）。 */
	function textFromAssistant(message: unknown): string {
		return textFromContent((message as any)?.content);
	}

	/** 取最近一轮 user / assistant 配对。倒序扫，两个都拿到就停。 */
	function getLastExchange(entries: unknown[]): { user: string; assistant: string } | undefined {
		let lastUser: string | undefined;
		let lastAssistant: string | undefined;

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as any;
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;

			if (msg.role === "assistant" && !lastAssistant) {
				const text = textFromContent(msg.content);
				if (text) lastAssistant = text;
			} else if (msg.role === "user" && !lastUser) {
				const text = textFromContent(msg.content);
				if (text) lastUser = text;
			}
			if (lastUser && lastAssistant) break;
		}

		if (!lastUser || !lastAssistant) return undefined;
		return { user: lastUser, assistant: lastAssistant };
	}

	function clip(text: string): string {
		return text.length > EXCHANGE_CLIP_CHARS ? `${text.slice(0, EXCHANGE_CLIP_CHARS)}…` : text;
	}

	/**
	 * 提示词。带上上一条摘要做上下文延续 —— 摘要于是是"渐进式"的（新回合的信息叠加到旧摘要上），
	 * 而不是只看最后一轮。这不需要任何存储：`currentRecap` 就在内存里。
	 * 语言写死中文，直接写在规则里（不做成可配项，所以没有 LANGUAGE 常量）。
	 */
	function buildPrompt(exchange: { user: string; assistant: string }, previousRecap: string | undefined): string {
		return [
			"You are an informative session recap generator.",
			`Summarise the session progress in ONE single line of at most ${MAX_RECAP_CHARS} characters.`,
			"Include only the action, the target, and the result or current progress.",
			"No greetings, no explanations, no markdown, no surrounding quotes, no leading label like 'Recap:'.",
			"- Always output in Chinese (中文).",
			previousRecap ? `Previous recap (keep continuity and update it): ${previousRecap}` : "",
			`Latest user request: ${clip(exchange.user)}`,
			`Latest assistant response: ${clip(exchange.assistant)}`,
		]
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * 清洗模型输出：只留第一行，去掉引号 / markdown 包裹 / 冗余前缀，超长截断。
	 *
	 * `truncated` = 模型是被 `max_tokens` 切断的（`stop_reason=length`）：这时正文本就是半句，
	 * 字符数往往还不到 120，光靠长度判断看不出来 —— 必须补一个省略号，别把半句话
	 * 当成完整摘要显示。
	 */
	function cleanRecapText(raw: string, truncated = false): string {
		let text = (raw ?? "").trim();
		if (!text) return "";

		// 只取第一行（提示词要求单行，但模型偶尔会多给几行）。
		text = text.split("\n")[0].trim();

		// 去掉整体包裹的引号。
		if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
			const inner = text.slice(1, -1).trim();
			if (inner) text = inner;
		}

		// 去掉 **bold** / __bold__ 包裹。
		text = text.replace(/^(\*\*|__)(.+)\1$/, "$2").trim();

		// 去掉 "Recap:" / "摘要:" 之类的冗余前缀。
		text = text.replace(/^(recap|summary|session recap|current recap|摘要)\s*[:：]\s*/i, "").trim();

		if (!text) return "";
		if (truncated && !text.endsWith("…")) text = `${text.slice(0, MAX_RECAP_CHARS - 1)}…`;
		return text.length > MAX_RECAP_CHARS ? `${text.slice(0, MAX_RECAP_CHARS - 1)}…` : text;
	}
}
