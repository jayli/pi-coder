/**
 * verify-loop 的装配验证：纯判定在 gate/goal/evaluator 各自的测试里；
 * 这里**不 mock pi**，用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）真加载
 * `index.ts`，然后直接驱动它注册的 `agent_before_settle` handler 与 `/goal` 命令。
 *
 * 加载器给的 runtime 上 `appendEntry` / `sendUserMessage` 是抛错桩
 * （loader.js 的 notInitialized），但包装函数在**调用时**才读 runtime 属性，
 * 所以测试里直接替换成记录器即可（runner.bindCore 在真 pi 里做的就是这件事）。
 *
 *   node --test clients/pi/extensions/verify-loop/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { VERIFY_LOOP_CUSTOM_TYPE } from "./gate.ts";
import { GOAL_ENTRY_TYPE } from "./goal.ts";

/**
 * `theme.bold()` 走 pi 自带的 chalk，而 chalk 在**模块求值时**就定好「要不要输出样式」
 * （非 TTY 下默认关掉）—— 所以「真的加粗了」的断言必须靠这个环境变量，且**必须在 import pi 之前**设
 * （mcp-tree/index.test.ts 同款；本文件顶层不 import pi，真正的 import 在 loadHarness 里）。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// 找到本机 pi 的库入口（core-rules/index.test.ts 同源）
// =============================================================================

async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接 / 不存在：看下面的 shim 脚本
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim：跳过
		}
	}

	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个候选
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

// =============================================================================
// 投影消息构造
// =============================================================================

type Message = Record<string, unknown>;

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCalls(...calls: Array<{ name: string; args?: Record<string, unknown> }>): Message {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call-${index}-${call.name}`,
			name: call.name,
			arguments: call.args ?? {},
		})),
	};
}

function toolResult(): Message {
	return { role: "toolResult", content: [{ type: "text", text: "ok" }] };
}

// =============================================================================
// 加载与驱动
// =============================================================================

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	messageRenderers: Map<string, unknown>;
}

interface Harness {
	/** 驱动 agent_before_settle，返回 BoundaryResult。 */
	settle(messages: Message[], outcome?: "completed" | "aborted" | "error"): Promise<unknown>;
	/** 跑 /goal 命令。 */
	goal(args: string): Promise<void>;
	/** 驱动 session_start（重建 goal）。 */
	startSession(branchEntries?: unknown[]): Promise<void>;
	/** 记录到的 appendEntry 调用。 */
	appended: Array<{ customType: string; data: unknown }>;
	/** 记录到的 sendUserMessage 调用。 */
	sentUserMessages: Array<{ content: string; options?: unknown }>;
	/** 记录到的 notify。 */
	notifies: string[];
	/** setStatus 记录。 */
	statuses: Array<{ key: string; text: string | undefined }>;
	/** 注入消息的渲染器（真加载器注册的那一个）。 */
	renderer?: (message: unknown, options: unknown, theme: unknown) => { render(width: number): string[]; invalidate?: () => void };
	/** 评估调用记录（可注入裁决）。 */
	evaluations: Array<{ prompt: string; systemPrompt: string }>;
	/** 下一次评估返回的原始文本（undefined = 评估失败）。 */
	evaluatorReply: string | undefined;
}

async function loadHarness(
	env: Record<string, string | undefined> = {},
	options: { activeSubagents?: number } = {},
): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }>; runtime: Record<string, unknown> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-loop-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	// env 隔离：保存 → 覆盖 → 加载 → 还原（配置在工厂里一次性读取）。
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}

	let loaded: Awaited<ReturnType<typeof pi.discoverAndLoadExtensions>>;
	try {
		// 子代理探测用的假总线：对 `status` 请求回「没有子代理在跑」。
		// 不回的话 `hasActiveSubagentWork` 会等满 1s 超时（fail-open 结果一样，但每个用例慢 1s）。
		const bus = createFakeEventBus(options.activeSubagents ?? 0);
		loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	} finally {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}

	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 verify-loop 扩展");

	const harness: Harness = {
		appended: [],
		sentUserMessages: [],
		notifies: [],
		statuses: [],
		evaluations: [],
		evaluatorReply: undefined,
		settle: async () => undefined,
		goal: async () => undefined,
		startSession: async () => undefined,
	};

	// runner.bindCore 的测试等价物：把抛错桩换成记录器。
	loaded.runtime.appendEntry = (customType: string, data: unknown) => {
		harness.appended.push({ customType, data });
	};
	loaded.runtime.sendUserMessage = (content: string, options?: unknown) => {
		harness.sentUserMessages.push({ content, options });
	};

	let branchEntries: unknown[] = [];

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => true,
		signal: undefined,
		ui: {
			notify: (text: string) => harness.notifies.push(text),
			setStatus: (key: string, text: string | undefined) => harness.statuses.push({ key, text }),
		},
		sessionManager: {
			getBranch: () => branchEntries,
			buildContextEntries: () => branchEntries,
		},
		model: { provider: "litellm-any", id: "deepseek-flash" },
		modelRegistry: {
			find: () => ({ provider: "litellm-any", id: "qwen3.8-flash" }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
			complete: async (_model: unknown, context: { systemPrompt?: string; messages: Array<{ content: Array<{ text?: string }> }> }) => {
				harness.evaluations.push({
					systemPrompt: context.systemPrompt ?? "",
					prompt: context.messages[0]?.content?.map((part) => part.text ?? "").join("") ?? "",
				});
				if (harness.evaluatorReply === undefined) throw new Error("evaluator unavailable");
				return { content: [{ type: "text", text: harness.evaluatorReply }] };
			},
		},
	};

	const settleHandler = extension.handlers.get("agent_before_settle")?.[0];
	const startHandler = extension.handlers.get("session_start")?.[0];
	const goalCommand = extension.commands.get("goal");
	assert.ok(settleHandler, "应该注册 agent_before_settle handler");
	assert.ok(goalCommand, "应该注册 /goal 命令");
	assert.ok(extension.messageRenderers.get(VERIFY_LOOP_CUSTOM_TYPE), "应该注册注入消息的渲染器");
	harness.renderer = extension.messageRenderers.get(VERIFY_LOOP_CUSTOM_TYPE) as Harness["renderer"];

	harness.settle = async (messages, outcome = "completed") =>
		settleHandler(
			{ type: "agent_before_settle", outcome, entries: [], continue: false, context: { contextMessages: messages } },
			ctx,
		);
	harness.goal = async (args) => goalCommand.handler(args, ctx);
	harness.startSession = async (entries = []) => {
		branchEntries = entries;
		if (startHandler) await startHandler({ type: "session_start", reason: "startup" }, ctx);
	};
	return harness;
}

function lastDraft(result: unknown): { customType?: string; content?: string; display?: boolean; details?: { kind?: string } } | undefined {
	const entries = (result as { entries?: unknown[] } | undefined)?.entries;
	if (!entries || entries.length === 0) return undefined;
	return entries[entries.length - 1] as { customType?: string; content?: string; display?: boolean; details?: { kind?: string } };
}

/**
 * 假的 pi 事件总线：只认 pi-subagents 的 RPC 频道，回 `fleet.totalActive = <n>`。
 * recap/subagents.ts 的 `isSubagentWorkActive` 读的就是这个字段。
 */
function createFakeEventBus(active = 0): { on: (channel: string, handler: (data: unknown) => void) => () => void; emit: (channel: string, data: unknown) => void } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel, data) {
			const request = data as { requestId?: string; method?: string };
			if (channel !== "subagents:rpc:v1:request" || request.method !== "status") return;
			const replyChannel = `subagents:rpc:v1:reply:${request.requestId}`;
			for (const handler of handlers.get(replyChannel) ?? []) {
				handler({ success: true, data: { fleet: { totalActive: active } } });
			}
		},
	};
}

// =============================================================================
// 闸（CC 的 command 型 Stop hook）
// =============================================================================

test(
	"改了文件没验证 → block：注入 gate 消息并 continue",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		const result = (await harness.settle(messages)) as { continue?: boolean } | undefined;
		assert.equal(result?.continue, true, "应该强制续跑一轮");
		const draft = lastDraft(result);
		assert.equal(draft?.customType, VERIFY_LOOP_CUSTOM_TYPE);
		assert.equal(draft?.details?.kind, "gate");
		assert.equal(draft?.display, true, "CC 的 Stop hook feedback 用户可见");
		assert.match(draft?.content ?? "", /没有跑过任何命令/);
		assert.match(draft?.content ?? "", /src\/a\.js/);
	},
);

test(
	"改完跑过验证 → 放行",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantToolCalls({ name: "bash", args: { command: "node --test adapter/tests/*.test.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		assert.equal(await harness.settle(messages), undefined);
	},
);

test(
	"aborted / error outcome 不触发闸（CC：abort 不触发 Stop，API 错误走 StopFailure）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		assert.equal(await harness.settle(messages, "aborted"), undefined);
		assert.equal(await harness.settle(messages, "error"), undefined);
	},
);

test(
	"PI_VERIFY_LOOP=notify → 只提示不拦",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP: "notify" });
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		const result = await harness.settle(messages);
		assert.equal(result, undefined, "notify 模式不应 continue");
		assert.ok(harness.notifies.some((text) => text.includes("[verify-loop]")), "应该有提示");
	},
);

test(
	"PI_VERIFY_LOOP=off → 什么都不做",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP: "off" });
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		assert.equal(await harness.settle(messages), undefined);
		assert.equal(harness.notifies.length, 0);
	},
);

test(
	"连续拦截达到上限 → 放行（CC 的强制放行）",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_VERIFY_LOOP_CAP: "1" });
		const messages = [
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
			{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "gate", at: 1 } },
			assistantText("还是完成了"),
		];
		assert.equal(await harness.settle(messages), undefined, "已拦过一次（上限 1）应放行");
	},
);

// =============================================================================
// /goal 命令
// =============================================================================

test(
	"/goal <条件>：落盘 + 指示器 + 立刻起一轮（条件即 directive）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("临时文件里包含 HELLO");
		assert.equal(harness.appended.length, 1);
		assert.equal(harness.appended[0].customType, GOAL_ENTRY_TYPE);
		assert.equal((harness.appended[0].data as { condition: string }).condition, "临时文件里包含 HELLO");
		assert.equal(harness.sentUserMessages.length, 1, "CC：设定 goal 立即起一轮");
		assert.match(harness.sentUserMessages[0].content, /临时文件里包含 HELLO/);
		assert.ok(harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"));
	},
);

test(
	"/goal clear：清除并记录",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("条件A");
		await harness.goal("clear");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { condition: string }).condition, "");
		assert.ok(harness.notifies.some((text) => text.startsWith("Goal cleared")));
	},
);

test(
	"/goal stop 等别名同样清除",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("条件A");
		await harness.goal("stop");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { condition: string }).condition, "");
	},
);

test(
	"/goal（无参）：显示状态，不触发评估",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("条件A");
		harness.notifies.length = 0;
		await harness.goal("");
		assert.ok(harness.notifies.some((text) => text.includes("条件A")));
		assert.equal(harness.evaluations.length, 0);
	},
);

// =============================================================================
// 评估循环（CC 的 prompt 型 Stop hook / /goal 评估器）
// =============================================================================

async function settleWithGoal(harness: Harness, messages: Message[]): Promise<{ continue?: boolean } | undefined> {
	return (await harness.settle(messages)) as { continue?: boolean } | undefined;
}

test(
	"goal 活跃 + 未达成 → 注入裁决并续跑",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"没看到测试输出"}';

		const messages = [
			user("开始"),
			assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
			toolResult(),
			assistantText("应该好了"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, true, "未达成应续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-not-met");
		assert.match(draft?.content ?? "", /没看到测试输出/);
		assert.equal(harness.evaluations.length, 1, "评估器被调用一次");
		assert.match(harness.evaluations[0].prompt, /所有测试通过/, "条件在评估提示词里");
		assert.match(harness.evaluations[0].prompt, /\[Assistant\]/, "对话序列化在评估提示词里");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { evaluatedTurns: number }).evaluatedTurns, 1, "评估轮数落盘");
	},
);

test(
	"goal 达成 → 记录 achieved 条目、不再续跑",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"met","reason":"输出显示 34/34 通过"}';

		const messages = [
			user("开始"),
			assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
			toolResult(),
			assistantText("全过了"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "达成不应续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-met");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { status: string }).status, "achieved");

		// 达成后不再评估
		harness.evaluations.length = 0;
		await settleWithGoal(harness, [...messages, assistantText("继续别的")]);
		assert.equal(harness.evaluations.length, 0);
	},
);

test(
	"goal 不可能 → 清除并记录",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("让太阳从西边升起");
		harness.evaluatorReply = '{"verdict":"impossible","reason":"物理上不可能"}';

		const messages = [user("开始"), assistantText("这做不到")];
		const result = await settleWithGoal(harness, messages);
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-impossible");
		const last = harness.appended[harness.appended.length - 1];
		assert.equal((last.data as { status: string }).status, "impossible");
	},
);

test(
	"评估器失败 → fail-open 放行（CC：hook 失败不拦回合）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = undefined; // complete() 抛错

		const messages = [user("开始"), assistantText("完成了")];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result, undefined, "评估失败应放行");
		assert.ok(harness.notifies.some((text) => text.includes("评估失败")));
	},
);

test(
	"评估器回的不是裁决 → fail-open 放行",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = "我觉得应该差不多了吧";

		const messages = [user("开始"), assistantText("完成了")];
		assert.equal(await settleWithGoal(harness, messages), undefined);
	},
);

test(
	"续跑次数到上限 → 停循环、goal 保留（CC 的 8 次强制放行）",
	{ skip },
	async () => {
		const harness = await loadHarness({ PI_GOAL_CAP: "2" });
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages: Message[] = [user("开始")];
		for (let i = 0; i < 2; i += 1) {
			messages.push(
				{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "goal-not-met", at: 1 } },
				assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
				toolResult(),
				assistantText("继续"),
			);
		}
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "到上限不再续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-cap");
		assert.match(draft?.content ?? "", /条件仍保留/);
	},
);

test(
	"连续无进展（只回文字不调工具）→ 停循环、goal 保留（CC 的无进展检测）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages: Message[] = [user("开始")];
		for (let i = 0; i < 2; i += 1) {
			messages.push(
				{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind: "goal-not-met", at: 1 } },
				assistantText("我觉得已经完成了"),
			);
		}
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, undefined, "无进展不再续跑");
		const draft = lastDraft(result);
		assert.equal(draft?.details?.kind, "goal-halted");
		assert.match(draft?.content ?? "", /无进展/);
		assert.equal(harness.evaluations.length, 0, "halt 判定在评估之前，不花模型调用");
	},
);

test(
	"后台子代理还在跑 → 本轮跳过评估（CC：background work defers evaluation）",
	{ skip },
	async () => {
		const harness = await loadHarness({}, { activeSubagents: 1 });
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages = [user("开始"), assistantText("发出去了，等子代理")];
		assert.equal(await settleWithGoal(harness, messages), undefined, "子代理在跑时不评估也不续跑");
		assert.equal(harness.evaluations.length, 0);
	},
);

// =============================================================================
// 会话生命周期
// =============================================================================

test(
	"session_start：从分支条目恢复活跃 goal（CC：resume 恢复）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.startSession([
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "所有测试通过", setAt: 1, status: "active", evaluatedTurns: 3 } },
		]);
		assert.ok(harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"), "恢复后指示器应亮起");

		// 恢复的 goal 参与评估
		harness.evaluatorReply = '{"verdict":"met","reason":"done"}';
		const result = await settleWithGoal(harness, [user("继续"), assistantText("好了")]);
		assert.equal(lastDraft(result)?.details?.kind, "goal-met");
	},
);

test(
	"session_start：已达成的 goal 不恢复（CC：不恢复已达成/已清除的 goal）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.startSession([
			{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "旧条件", setAt: 1, status: "achieved", evaluatedTurns: 1 } },
		]);
		assert.ok(!harness.statuses.some((s) => s.key === "verify-goal" && s.text === "◎ /goal active"));
		assert.equal(await settleWithGoal(harness, [user("继续"), assistantText("好了")]), undefined);
	},
);

test(
	"闸与 goal 同时在场：闸优先（先补验证，再谈 goal）",
	{ skip },
	async () => {
		const harness = await loadHarness();
		await harness.goal("所有测试通过");
		harness.evaluatorReply = '{"verdict":"not_met","reason":"还差"}';

		const messages = [
			user("开始"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		];
		const result = await settleWithGoal(harness, messages);
		assert.equal(result?.continue, true);
		assert.equal(lastDraft(result)?.details?.kind, "gate", "闸先于 goal 评估");
		assert.equal(harness.evaluations.length, 0, "闸 block 时不花评估调用");
	},
);

// =============================================================================
// 注入消息的渲染形态（用户 2026-10-18 定：与 bash / background-task 块同一棵树）
//
//   • ⚠ verify-loop:
//     │ 你声称完成，但本次 run 的文件改动（…）之后没有跑过任何命令…
//     └ 这是第 1/2 次拦截；达到上限后不再拦截。
//
// 原先走 `Box(outputPad, 1, bg customMessageBg)`：整块底色 + 上下各一行空行。
// 这里钉的是「换了什么」：圆点、加粗标题、正文挂树符、无底色、无多余空行。
// =============================================================================

/** 假主题：颜色映射成 `slot(text)`（含 `bg`），加粗映射成 `bold(text)`。 */
const slotTheme = {
	fg: (slot: string, text: string) => `${slot}(${text})`,
	bold: (text: string) => `bold(${text})`,
	bg: (slot: string, text: string) => `BG(${slot},${text})`,
};

/** 假主题：丢掉颜色与底色，只看可见文本。 */
const plainTheme = {
	fg: (_slot: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_slot: string, text: string) => text,
};

/** 渲染一条注入消息；`kind` 走 details（与真消息同一形状）。 */
async function renderMessage(kind: string, content: string, width = 80, theme: unknown = plainTheme): Promise<string[]> {
	const harness = await loadHarness();
	assert.ok(harness.renderer, "应该注册渲染器");
	return harness.renderer!({ content, details: { kind, at: 1 } }, { outputPad: 1 }, theme).render(width);
}

test(
	"渲染：标题 = 圆点 + 加粗的 ⚠ verify-loop:（同一个 warning 槽），正文挂树符",
	{ skip },
	async () => {
		const lines = await renderMessage("gate", "第一行\n第二行\n第三行", 80, slotTheme);
		assert.deepEqual(lines, [
			`warning(\u2022) warning(bold(⚠ verify-loop:))`,
			`  muted(\u2502 )第一行`,
			`  muted(\u2502 )第二行`,
			`  muted(\u2514 )第三行`,
		]);
	},
);

test(
	"渲染：圆点与标签同槽（gate → warning、达成 → success、不可能 → error、未达成 → accent）",
	{ skip },
	async () => {
		const slotOf = async (kind: string): Promise<string> => {
			const title = (await renderMessage(kind, "正文", 80, slotTheme))[0]!;
			const match = /^(\w+)\(\u2022\) (\w+)\(bold\(/.exec(title);
			assert.ok(match, `标题应是「圆点 + 加粗标签」：${JSON.stringify(title)}`);
			assert.equal(match![1], match![2], "圆点与标签必须同槽（同一个语义色）");
			return match![1]!;
		};
		assert.equal(await slotOf("gate"), "warning", "闸拦截 = 原有的警告色");
		assert.equal(await slotOf("goal-halted"), "warning");
		assert.equal(await slotOf("goal-cap"), "warning");
		assert.equal(await slotOf("goal-met"), "success");
		assert.equal(await slotOf("goal-impossible"), "error");
		assert.equal(await slotOf("goal-not-met"), "accent");
	},
);

test(
	"渲染：不套 Box —— 无底色、无上下空行（块内只有标题 + 正文行）",
	{ skip },
	async () => {
		const lines = await renderMessage("gate", "第一行\n第二行", 80, slotTheme);
		assert.ok(!lines.some((line) => line.includes("BG(")), `整块不该有底色：${JSON.stringify(lines)}`);
		assert.equal(lines.length, 3, `标题 + 2 行正文，不多空行：${JSON.stringify(lines)}`);
		assert.ok(!lines.some((line) => line.trim() === ""), "块内不该有整行空白（Box 的 paddingY）");
	},
);

test(
	"渲染：长正文先折行再挂树符（续行也是 │、末行 └、不超宽）",
	{ skip },
	async () => {
		const width = 40;
		const body = "你声称完成，但本次 run 的文件改动之后没有跑过任何命令去观察实际结果。请运行能证明这次改动正确的命令并把输出贴出来。";
		const lines = await renderMessage("gate", body, width);
		assert.ok(lines.length > 3, `宽 ${width} 下必须折成多行：${JSON.stringify(lines)}`);
		for (const line of lines) assert.ok(line.length <= width, `行超宽：${JSON.stringify(line)}`);
		const bodyLines = lines.slice(1);
		for (const line of bodyLines.slice(0, -1)) assert.ok(line.startsWith("  \u2502 "), `续行也要挂 │：${JSON.stringify(line)}`);
		assert.ok(bodyLines[bodyLines.length - 1]!.startsWith("  \u2514 "), "末行才收口");
		assert.equal(bodyLines.filter((line) => line.startsWith("  \u2514 ")).length, 1, "└ 整块只出现一次");
	},
);

test(
	"真组件端到端：无背景 SGR、标题顶格加粗、正文挂树、上方只剩 pi 固定的一行留白",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			initTheme: (name?: string) => void;
			CustomMessageComponent: new (
				message: unknown,
				renderer?: unknown,
				markdownTheme?: unknown,
				outputPad?: number,
			) => { render: (width: number) => string[] };
		};
		pi.initTheme("dark");
		const component = new pi.CustomMessageComponent(
			{ role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "第一行\n第二行", details: { kind: "gate", at: 1 } },
			harness.renderer,
		);
		const raw = component.render(80);
		const plain = (line: string): string => line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

		assert.equal(raw[0], "", "第 0 行是 pi 写死的 Spacer(1)（去不掉的两个块共同点）");
		assert.ok(!raw.some((line) => /\u001b\[(?:4[0-7]|10[0-7]|48;)/.test(line)), `不该有背景 SGR：${JSON.stringify(raw)}`);
		assert.ok(/\u001b\[1m/.test(raw[1]!), `标题必须真的加粗：${JSON.stringify(raw[1])}`);
		assert.equal(plain(raw[1]!).trim(), "\u2022 ⚠ verify-loop:", `标题顶格（圆点在列 0）：${JSON.stringify(plain(raw[1]!))}`);
		assert.equal(plain(raw[2]!).startsWith("  \u2502 "), true, `正文续行挂 │：${JSON.stringify(plain(raw[2]!))}`);
		assert.equal(plain(raw[3]!).startsWith("  \u2514 "), true, `末行收口：${JSON.stringify(plain(raw[3]!))}`);
		assert.equal(raw.length, 4, `留白 + 标题 + 2 行正文，不多空行：${JSON.stringify(raw.map(plain))}`);
	},
);

test(
	"渲染：真闸消息（renderGateMessage 三段）接上去就是那个形状",
	{ skip },
	async () => {
		const harness = await loadHarness();
		const result = await harness.settle([
			user("改一下"),
			assistantToolCalls({ name: "edit", args: { path: "src/a.js" } }),
			toolResult(),
			assistantText("完成了"),
		]);
		const draft = lastDraft(result);
		const lines = harness.renderer!({ content: draft?.content, details: draft?.details }, { outputPad: 1 }, plainTheme).render(80);
		assert.equal(lines[0], "\u2022 ⚠ verify-loop:");
		assert.ok(lines.slice(1).every((line) => /^  [\u2502\u2514] /.test(line)), `正文每行都挂树符：${JSON.stringify(lines)}`);
		assert.ok(lines[lines.length - 1]!.startsWith("  \u2514 这是第 1/2 次拦截"), `末行是最后一句：${JSON.stringify(lines[lines.length - 1])}`);
		// 三段正文在 80 列下各折成 1-3 行，但树是连续的：除末行外全是 │
		assert.ok(!lines[0]!.includes("\u2502") && !lines[0]!.includes("\u2514"), "标题行不带树符");
	},
);

