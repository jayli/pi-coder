/**
 * Tests for working-indicator/index.ts — 「长提示词异步请模型压成一句话」这条链路。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/index.test.ts
 *
 * pi 自己的扩展加载器真的加载 `index.ts`（所以 `./summary-request.ts` 的 import、
 * 事件注册面都在覆盖范围内），假的是扩展外面的一切：ctx（录制 `setWorkingMessage`
 * 与 `modelRegistry.complete`）和事件总线的另一端。模型调用是手动 resolve 的
 * promise，于是「旧请求回来时新提示词已经就位」这类时序能被精确摆出来。
 *
 * 终端宽度：`process.stdout.columns` 在测试进程里是 undefined，`terminalWidth()` 退回
 * 80；于是可用宽度 = min(40 - 2, 76 - 34 - 1 - 2) = 38 列，触发线就是 38 列（默认倍数 1，
 * 放不下一列就请求）。用例里的长提示词都远超它、短提示词都远低于它。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DEFAULT_FRAMES_PER_COLOR,
	SPINNER_COLOR_TOKENS,
	SPINNER_FRAMES,
	SPINNER_INTERVAL_MS,
} from "./spinner-frames.ts";
import { TURN_MARKER_VERBS, TURN_MARKER_WIDGET_KEY } from "./turn-marker.ts";

/**
 * 摘要失败重试的延时（与下面写进 `PI_WORKING_SUMMARY_RETRY_MS` 的值一致）。用例靠它
 * 分两半断言：「延时内不该重试」/「延时后重试了一次」。300ms 比默认 3s 快一个数量级，
 * 又足够宽裕，不会被慢机器上的调度抖动搔成假阴性。
 */
const RETRY_DELAY_MS = 300;
// index.ts 的重试延时是**模块级常量**，必须在扩展第一次被加载之前设置（pi 的加载器
// 只会读一次）；下面所有用例共用这个值。
process.env.PI_WORKING_SUMMARY_RETRY_MS = String(RETRY_DELAY_MS);

/**
 * watchdog 提示的触发延时（同样是模块级常量，必须在加载前设）。200ms 比默认 2s
 * 快一个数量级，用例里等它触发不用真等两秒。
 */
const WATCHDOG_DELAY_MS = 200;
process.env.PI_WORKING_INDICATOR_WATCHDOG_DELAY_MS = String(WATCHDOG_DELAY_MS);

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 后者是**扩展包的安装根**，`pi update --extensions` 会用
 * `--config.auto-install-peers=false` 把自动装进去的 `@earendil-works/pi-*` 同伴包剪掉，
 * 于是那份副本只剩空壳（文件都在、import 报 `ERR_MODULE_NOT_FOUND`；2026-09 升
 * pi-subagents 0.68.0 时实测踩到）。
 *
 * 判定方式是**能不能真 import**，不是路径存不存在 —— 只有真 import 一次才分得清空壳。
 * 全都不行就返回 undefined，调用方整体 skip（不假装通过）。
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			// npm 的 shim 是符号链接
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
const skip = piEntry === undefined ? SKIP : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface TestBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createTestBus(): TestBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.set(channel, set);
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

/** 一次 `modelRegistry.complete` 调用的记录。 */
interface CompleteCall {
	/** 请求提示词（user 消息里的文本）。 */
	prompt: string;
	maxTokens: number | undefined;
	temperature: number | undefined;
	/** 手动放行这次调用。 */
	resolve: (text: string) => void;
	/** 让这次调用失败（模型报错 / 超时）。 */
	reject: (error: Error) => void;
}

interface Recorder {
	completes: CompleteCall[];
	/** 每次 `setWorkingMessage(<string>)` 记一条。 */
	workingMessages: string[];
	/** 无参 `setWorkingMessage()`（回合结束恢复默认）次数。 */
	resets: number;
}

interface ContextOptions {
	/** 主题 `fg` 实现；缺省恒等（保持既有布局用例的宽度口径）。 */
	themeFg?: (color: string, text: string) => string;
	/** 每次 `setWorkingIndicator` 记一条（`undefined` = 无参调用，即恢复 pi 默认帧）。 */
	onIndicator?: (options: { frames?: string[]; intervalMs?: number } | undefined) => void;
	/** 每次 `setWidget` 记一条（`content === undefined` = 清掉这个 key）。 */
	onWidget?: (key: string, content: unknown) => void;
}

/** 取请求上下文里的 user 文本（请求体形状由 `summary-request.ts` 决定）。 */
function promptTextOf(context: unknown): string {
	const messages = (context as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages ?? [];
	return messages.map((message) => message.content?.map((block) => block.text ?? "").join("") ?? "").join("");
}

function createContext(recorder: Recorder, options: ContextOptions = {}): unknown {
	return {
		mode: "tui",
		hasUI: true,
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {} }),
			complete: (_model: unknown, context: unknown, options: { maxTokens?: number; temperature?: number }) =>
				new Promise((resolve, reject) => {
					recorder.completes.push({
						prompt: promptTextOf(context),
						maxTokens: options?.maxTokens,
						temperature: options?.temperature,
						resolve: (text: string) => resolve({ content: [{ type: "text", text }] }),
						reject,
					});
				}),
		},
		ui: {
			theme: { fg: options.themeFg ?? ((_color: string, text: string) => text) },
			setWorkingIndicator: (indicator?: { frames?: string[]; intervalMs?: number }) =>
				options.onIndicator?.(indicator),
			setWorkingMessage: (message?: string) => {
				if (message === undefined) recorder.resets += 1;
				else recorder.workingMessages.push(message);
			},
			setWidget: (key: string, content?: unknown) => options.onWidget?.(key, content),
		},
	};
}

/**
 * 把 widget 工厂渲染成行（假 TUI + 假主题）。结束符是工厂形式（要拿 theme 的 live proxy，
 * 见 index.ts 的 `showTurnMarker`），所以断言得先把它调出来。
 */
function renderWidgetLines(content: unknown, themeFg?: (color: string, text: string) => string): string[] {
	assert.equal(typeof content, "function", "应该是 widget 工厂（函数），不是字符串数组");
	const factory = content as (tui: unknown, theme: { fg: (color: string, text: string) => string }) => {
		render(width: number): string[];
	};
	const component = factory({}, { fg: themeFg ?? ((_color: string, text: string) => text) });
	return component.render(120);
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-working-indicator-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return {
		agentDir,
		projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	errors: Array<{ path: string; error: string }>;
}

/** 用 pi 自己的加载器加载本扩展（`./summary-request.ts` 等 import 也一起验证）。 */
async function loadExtension(workspace: { agentDir: string; projectDir: string }): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions(
		[EXTENSION_PATH],
		workspace.projectDir,
		workspace.agentDir,
		createTestBus(),
	);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	return extension;
}

function handlersOf(extension: LoadedExtension): {
	input: Handler;
	agentStart: Handler;
	agentEnd: Handler;
	agentSettled: Handler;
	agentBeforeSettle: Handler;
	beforeCompact: Handler;
	shutdown: Handler;
} {
	const input = extension.handlers.get("input")?.[0];
	const agentStart = extension.handlers.get("agent_start")?.[0];
	const agentEnd = extension.handlers.get("agent_end")?.[0];
	const agentSettled = extension.handlers.get("agent_settled")?.[0];
	const agentBeforeSettle = extension.handlers.get("agent_before_settle")?.[0];
	const beforeCompact = extension.handlers.get("session_before_compact")?.[0];
	const shutdown = extension.handlers.get("session_shutdown")?.[0];
	assert.ok(input, "应该注册了 input");
	assert.ok(agentStart, "应该注册了 agent_start");
	assert.ok(agentEnd, "应该注册了 agent_end");
	assert.ok(agentSettled, "应该注册了 agent_settled");
	assert.ok(agentBeforeSettle, "应该注册了 agent_before_settle");
	assert.ok(beforeCompact, "应该注册了 session_before_compact");
	assert.ok(shutdown, "应该注册了 session_shutdown");
	return { input, agentStart, agentEnd, agentSettled, agentBeforeSettle, beforeCompact, shutdown };
}

/** 等谓词成立；超时把「在等什么」一并报出来。 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等不到：${what}（超时 ${timeoutMs}ms）`);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 远超 76 列触发线的多行中文提示词。 */
const LONG_PROMPT = [
	"帮我优化一下 working 行尾的提示词摘要",
	"现在长提示词被生硬地截断，看不出在干什么",
	"希望超过可显示宽度时让模型压成一句话",
	"而且这个请求要和主任务并行，不要互相影响",
].join("\n");

test("长提示词异步请求一次摘要，回来后替换行尾原文；请求不阻塞主回合", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);

		assert.equal(recorder.completes.length, 1, "长提示词应该发一次摘要请求");
		const call = recorder.completes[0];
		assert.ok(call);
		// 请求里带上了算好的目标长度（38 列可用 × 0.9 = 34）与列宽口径。
		assert.match(call.prompt, /34 display columns/);
		assert.match(call.prompt, /CJK\/full-width character counts as 2 columns/);
		// 压平后的原文整段都在（多行 → 一句）。
		assert.ok(call.prompt.includes("帮我优化一下 working 行尾的提示词摘要"));
		// 不传 temperature：本机这些路由在 0 温度下会退化成停不下来的长思考（实测）。
		assert.equal(call.temperature, undefined);
		// maxTokens 必须容下强制 thinking（网关给这些路由写死了 thinking: enabled，关不掉）。
		assert.ok((call.maxTokens ?? 0) >= 512, `maxTokens 应给 thinking 留足份额，实际 ${call.maxTokens}`);

		// 摘要还没回来：先显示的是截断后的原文。
		const before = recorder.workingMessages.at(-1) ?? "";
		assert.match(before, /✦ /);
		assert.ok(!before.includes("模型压缩"), "模型还没回包时不该凭空出现摘要");

		call.resolve("把行尾长提示词交给模型压成一句话");

		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("把行尾长提示词交给模型压成一句话"),
			"摘要替换成模型返回的一句话",
		);
		const after = recorder.workingMessages.at(-1) ?? "";
		assert.ok(after.includes("✦ "), "摘要仍带 `✦ ` 前缀");
		assert.ok(!after.includes("希望超过可显示宽度时"), "摘要应该顶掉原文，而不是两者并存");

		await agentSettled({}, ctx);
		assert.equal(recorder.resets, 1, "回合结束应恢复 pi 默认文案");
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("请求不阻塞 input：模型永不回包时 input handler 也立刻返回", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		const startedAt = Date.now();
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		const elapsed = Date.now() - startedAt;
		assert.equal(recorder.completes.length, 1, "请求已发出");
		assert.ok(elapsed < 500, `input handler 不能等模型（耗时 ${elapsed}ms）`);

		// 请求一直挂着也不影响后续事件：回合照常结束。
		await handlersOf(extension).agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("短提示词不请求；同一条消息重复 input 也不重复请求", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: "hi", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 0, "短提示词整段放得下，不该请求");

		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 1, "第一次长提示词请求");
		// 扩展命令的 sendUserMessage 会让同一条消息走两次 input。
		await input({ text: LONG_PROMPT, source: "extension" }, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 1, "同一条文本重复触发不该重新请求");

		// 换一条真正不同的长提示词才会发第二次。
		await input({ text: `${LONG_PROMPT}（第二版）`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "新提示词的第二次请求");
		assert.ok(recorder.completes[1]?.prompt.includes("（第二版）"));

		// 会话被替换后，同一条文本必须重新请求（去重键不能跨会话留着）。
		await shutdown({}, ctx);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 3, "新会话里的同一条提示词");
	} finally {
		workspace.cleanup();
	}
});

test("触发线就是可用宽度：39 列（放不下一列）请求，38 列（刚好放得下）不请求", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		// 测试进程里终端宽度退回 80 → 摘要可用 38 列（推导见文件头注释）。
		await input({ text: "a".repeat(38), source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await delay(50);
		assert.equal(recorder.completes.length, 0, "刚好放得下不该请求");

		await input({ text: "a".repeat(39), source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 1, "放不下一列就该请求");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("新提示词作废旧请求：旧摘要回来也不会顶掉新的", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "第一条提示词的请求");
		await input({ text: `${LONG_PROMPT} 改成模型压缩`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "第二条提示词的请求");

		// 旧请求后回来：必须被丢弃（abort + 序号两道护栏）。
		recorder.completes[0]?.resolve("第一条的摘要");
		await delay(50);
		assert.ok(
			!recorder.workingMessages.some((message) => message.includes("第一条的摘要")),
			"过期摘要绝不能显示",
		);

		recorder.completes[1]?.resolve("第二条的摘要");
		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("第二条的摘要"),
			"当前提示词的摘要",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("摘要超长只截断、不追问：成功返回后不会二次请求", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		const overlong = "这是一段远超可用宽度的模型摘要".repeat(20);
		recorder.completes[0]?.resolve(overlong);

		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("…"),
			"超长摘要被截断补省略号",
		);
		const message = recorder.workingMessages.at(-1) ?? "";
		assert.ok(!message.includes("这是一段远超可用宽度的模型摘要这是一段"), "超长摘要应被截掉大半");
		// 等过一个 1s tick，确认没有任何「第二次请求」。
		await delay(1_200);
		assert.equal(recorder.completes.length, 1, "回来的摘要再长也不重试");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("首次失败静默退回截断后的原文，延时后自动重试一次；重试成功就换上摘要", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		recorder.completes[0]?.reject(new Error("boom"));

		// 重试还在延时里：这一格先退回截断后的原文（不空着、也不急着重新发）。
		await delay(Math.floor(RETRY_DELAY_MS / 3));
		const fallback = recorder.workingMessages.at(-1) ?? "";
		assert.ok(fallback.includes("✦ "), "失败后仍显示摘要段（这里是截断后的原文）");
		assert.ok(fallback.includes("帮我优化"), "原文前缀还在");
		assert.equal(recorder.completes.length, 1, "延时未到不该重试");

		await waitFor(() => recorder.completes.length === 2, "失败后的自动重试");
		assert.equal(recorder.completes[1]?.prompt, recorder.completes[0]?.prompt, "重试问的是同一个问题");
		recorder.completes[1]?.resolve("把行尾长提示词交给模型压成一句话");
		await waitFor(
			() => (recorder.workingMessages.at(-1) ?? "").includes("把行尾长提示词交给模型压成一句话"),
			"重试回来的摘要上屏",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("空回复（只出了 thinking、没有正文）也算失败：同样重试一次", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		recorder.completes[0]?.resolve(""); // 清洗后空串（真实场景：只出了 thinking）

		await waitFor(() => recorder.completes.length === 2, "空回复后的自动重试");
		assert.ok(
			(recorder.workingMessages.at(-1) ?? "").includes("帮我优化"),
			"空回复什么都没换上，仍是截断后的原文",
		);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("重试也失败就彻底放弃：每个提示词最多两次请求", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		recorder.completes[0]?.reject(new Error("boom-1"));
		await waitFor(() => recorder.completes.length === 2, "失败后的自动重试");
		recorder.completes[1]?.reject(new Error("boom-2"));

		await delay(RETRY_DELAY_MS * 2);
		assert.equal(recorder.completes.length, 2, "第二次失败后不再重试");
		assert.ok((recorder.workingMessages.at(-1) ?? "").includes("帮我优化"), "仍显示截断后的原文");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("新提示词作废待重试的那次：不会为旧提示词补发", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "第一条提示词的请求");
		recorder.completes[0]?.reject(new Error("boom"));

		// 先等失败落地、重试定时器真的排上，再换提示词 —— 否则被下面的 `seq` 护栏挡住了，
		// 根本没机会验证「待重试的那次会被取消」。
		await delay(Math.floor(RETRY_DELAY_MS / 6));
		await input({ text: `${LONG_PROMPT}（第二版）`, source: "interactive" }, ctx);
		await waitFor(() => recorder.completes.length === 2, "新提示词的请求");
		assert.ok(recorder.completes[1]?.prompt.includes("（第二版）"));

		await delay(RETRY_DELAY_MS * 2);
		assert.equal(recorder.completes.length, 2, "旧提示词的待重试定时器应该被清掉");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("回合结束作废待重试的那次：不会在回合外补发请求", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);
		await input({ text: LONG_PROMPT, source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.completes.length === 1, "摘要请求");
		recorder.completes[0]?.reject(new Error("boom"));

		// 同上：先让重试定时器排上，再结束回合（`agentSettled` → `stopActivity` → 清定时器）。
		await delay(Math.floor(RETRY_DELAY_MS / 6));
		await agentSettled({}, ctx); // 回合结束 → stopActivity → 清掉待重试的定时器
		await delay(RETRY_DELAY_MS * 2);
		assert.equal(recorder.completes.length, 1, "回合结束后不该再有重试");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

// ---------------------------------------------------------------------------
// spinner 幻彩帧（`spinner-frames.ts` + index.ts 的三个安装时机）
// ---------------------------------------------------------------------------

/** 七色假主题；`colors` 就地改就是「换肤」（`theme.fg` 的 live proxy 替身）。 */
function createMutableTheme(): { colors: Record<string, string>; fg: (color: string, text: string) => string } {
	const colors: Record<string, string> = Object.fromEntries(
		SPINNER_COLOR_TOKENS.map((token, index) => [token, `<c${index}>`]),
	);
	return { colors, fg: (color, text) => `${colors[color] ?? `<${color}>`}${text}` };
}

/** 一次 `setWorkingIndicator` 调用的记录（`undefined` = 无参调用，即恢复 pi 默认帧）。 */
type IndicatorCall = { frames?: string[]; intervalMs?: number } | undefined;

test("回合开始装上幻彩帧表：十帧盲文 × 七色、间隔 80ms、每色 19 帧（≈1.5s）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);

		const installed = calls.at(-1);
		assert.ok(installed, "agent_start 应该装一次 indicator");
		assert.equal(installed.intervalMs, SPINNER_INTERVAL_MS);
		const frames = installed.frames as string[];
		// 帧表周期 = lcm(10, 19 × 7) = 1330：既是一轮调色板的整数倍，也是盲文圈长的整数倍（回绕不跳色）。
		assert.equal(frames.length, 1330);
		assert.equal(frames.length % (DEFAULT_FRAMES_PER_COLOR * SPINNER_COLOR_TOKENS.length), 0);
		assert.equal(frames.length % SPINNER_FRAMES.length, 0);
		for (const [index, frame] of frames.entries()) {
			assert.equal(frame.at(-1), SPINNER_FRAMES[index % SPINNER_FRAMES.length]);
			assert.equal(
				frame.slice(0, -1),
				theme.colors[
					SPINNER_COLOR_TOKENS[
						Math.floor(index / DEFAULT_FRAMES_PER_COLOR) % SPINNER_COLOR_TOKENS.length
					] as string
				],
			);
		}

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("换主题后一秒内重装帧表：指纹没变不重装、变了才重装", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const messageUpdate = extension.handlers.get("message_update")?.[0];
		assert.ok(messageUpdate, "应该注册了 message_update");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);
		assert.equal(calls.length, 1, "回合开始装一次");

		// 主题没变：每个流式 delta 都跑的 refresh 不该反复重装（重装会复位动画相位）。
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "hi" } }, ctx);
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "!" } }, ctx);
		assert.equal(calls.length, 1, "指纹没变就不该重装");

		// 换肤：下一次 refresh 现读到的新颜色让指纹变化 → 重装。
		theme.colors.accent = "<new-accent>";
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "?" } }, ctx);
		assert.equal(calls.length, 2, "换肤后应该重装一次");
		const refreshed = calls[1]?.frames?.[0] as string;
		assert.ok(refreshed.startsWith("<new-accent>"), `新帧表应该用新主题的颜色，实际 ${refreshed}`);

		// 再刷新也不会重复装。
		await messageUpdate({ assistantMessageEvent: { type: "text_delta", delta: "?" } }, ctx);
		assert.equal(calls.length, 2, "同主题下不该再装");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("问卷结束时补装彩帧（ask-user-question 的冻结会把它换成 pi 默认帧）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const toolEnd = extension.handlers.get("tool_execution_end")?.[0];
		assert.ok(toolEnd, "应该注册了 tool_execution_end");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const theme = createMutableTheme();
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);
		const afterStart = calls.length;

		// 别的工具结束不碰 indicator（每次工具结束都重装会把动画相位按工具调用切碎）。
		await toolEnd({ toolCallId: "1", toolName: "bash" }, ctx);
		assert.equal(calls.length, afterStart, "非问卷工具不该重装");

		// 问卷结束：补装一次彩帧（questionnaire 的 finally 已经无参恢复成 pi 默认帧）。
		await toolEnd({ toolCallId: "2", toolName: "ask_user_question" }, ctx);
		assert.equal(calls.length, afterStart + 1, "问卷结束应该补装");
		assert.equal((calls.at(-1)?.frames as string[]).length, 1330);

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("单色主题（NO_COLOR / 恒等 fg）不下发帧表，而是无参交回 pi 默认 spinner", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		// 不传 themeFg：既有 fake ctx 的恒等主题，七个色槽取出来是同一个颜色。
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		await agentStart({}, ctx);

		assert.equal(calls.length, 1, "仍然要交回一次控制权");
		assert.equal(calls[0], undefined, "单色主题应恢复 pi 默认帧而不是装一张假动画");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

// =============================================================================
// 弹窗期间冻结重绘（ui_prompt_start / ui_prompt_end）
// =============================================================================

test("弹窗开始：spinner 冻结成单帧、读秒定时器停（1.2s 内无新文案）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const promptStart = extension.handlers.get("ui_prompt_start")?.[0];
		assert.ok(promptStart, "应该注册了 ui_prompt_start");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		await input({ text: "跑一个长命令", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.workingMessages.length >= 1, "回合开始后的第一条文案");

		await promptStart({}, ctx);

		// 冻结帧：单帧盲文全集字符（与 ask-user-question 同字），accent 上色。
		const frozen = calls.at(-1);
		assert.ok(frozen?.frames, "弹窗开始应装冻结帧");
		assert.equal(frozen.frames.length, 1, "单帧才能停掉 Loader 的 80ms 动画定时器");
		assert.ok(frozen.frames[0].endsWith("⠿"), "冻结帧应是盲文全集字符");

		// 定时器已停：等过一个 TICK（1s）也不该有新文案。
		const countAtFreeze = recorder.workingMessages.length;
		await delay(1_200);
		assert.equal(recorder.workingMessages.length, countAtFreeze, "弹窗期间读秒定时器不该再出文案");

		await agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("弹窗结束：重装幻彩帧表、重启读秒、立即补刷一次", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentSettled, shutdown } = handlersOf(extension);
		const promptStart = extension.handlers.get("ui_prompt_start")?.[0];
		const promptEnd = extension.handlers.get("ui_prompt_end")?.[0];
		assert.ok(promptStart && promptEnd, "应该注册了 ui_prompt_start / ui_prompt_end");
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		// 用可区分的七色主题：默认恒等主题是单色的，`spinnerPalette` 会返回 null 帧表
		// （恢复时走无参调用），测不到「重装 1330 帧幻彩」这一步。
		const theme = createMutableTheme();
		const ctx = createContext(recorder, { themeFg: theme.fg, onIndicator: (o) => calls.push(o) });

		await input({ text: "跑一个长命令", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await waitFor(() => recorder.workingMessages.length >= 1, "回合开始后的第一条文案");

		await promptStart({}, ctx);
		await promptEnd({}, ctx);

		// 帧表重装成 1330 帧幻彩（覆盖掉单帧冻结帧）。恢复时的立即 refresh 受 lastMessage
		// 去重保护：弹窗只持续几毫秒、文案没变就不重发 —— 那是设计行为，不是 bug。
		const restored = calls.at(-1);
		assert.equal((restored?.frames as string[] | undefined)?.length, 1330, "应重装完整幻彩帧表");

		// 定时器重启：再过 1.2s 应继续出文案。
		const countAfterResume = recorder.workingMessages.length;
		await waitFor(() => recorder.workingMessages.length > countAfterResume, "恢复后读秒定时器继续走", 3_000);

		await agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("回合外的弹窗（无 agent_start）：冻结不崩、结束不起定时器", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const promptStart = extension.handlers.get("ui_prompt_start")?.[0];
		const promptEnd = extension.handlers.get("ui_prompt_end")?.[0];
		const shutdown = extension.handlers.get("session_shutdown")?.[0];
		assert.ok(promptStart && promptEnd && shutdown);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const calls: IndicatorCall[] = [];
		const ctx = createContext(recorder, { onIndicator: (o) => calls.push(o) });

		// 没有 agent_start：ctxRef 为 null、turnStartedAt 为 null。
		await promptStart({}, ctx);
		assert.equal(calls.length, 1, "仍应装一次冻结帧");
		await promptEnd({}, ctx);
		// 不该凭空起读秒定时器：等过一个 TICK 也没有文案。
		await delay(1_200);
		assert.equal(recorder.workingMessages.length, 0, "回合外不该有读秒文案");

		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

// ---------------------------------------------------------------------------
// watchdog 审查提示（agent_end 后阻塞窗口 → WATCHDOG_LABEL）
// ---------------------------------------------------------------------------

test("agent_end 后迟迟不 settle：文案切成 Subagent watchdog reviewing", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentEnd, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: "short prompt", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await agentEnd({}, ctx); // watchdog 开始阻塞（模拟）

		await waitFor(
			() => recorder.workingMessages.some((m) => m.includes("Subagent watchdog reviewing")),
			"watchdog 文案出现",
		);
		// 文案就是用户指定的那一句，不带时长 / token 段
		const last = recorder.workingMessages.at(-1) as string;
		assert.equal(last.includes("tokens"), false, "watchdog 文案不该带 token 段");
		assert.equal(/\d+s\)/.test(last), false, "watchdog 文案不该带时长");

		// 回合结束：恢复默认（无参 setWorkingMessage）
		await agentSettled({}, ctx);
		assert.ok(recorder.resets >= 1, "settle 后应恢复默认文案");
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("agent_end 后立刻 settle：不显示 watchdog 文案（正常回合不误报）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentEnd, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: "short prompt", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await agentEnd({}, ctx);
		await agentSettled({}, ctx); // 毫秒级 settle：定时器还没到点就被清掉

		await delay(WATCHDOG_DELAY_MS * 3);
		assert.equal(
			recorder.workingMessages.some((m) => m.includes("Subagent watchdog reviewing")),
			false,
			"正常回合不该出现 watchdog 文案",
		);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("agent_before_settle 到达：复位提示（不误标 verify-loop 的 /goal 评估）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentEnd, agentBeforeSettle, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: "short prompt", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await agentEnd({}, ctx);
		await waitFor(
			() => recorder.workingMessages.some((m) => m.includes("Subagent watchdog reviewing")),
			"watchdog 文案出现",
		);

		// verify-loop 的 /goal 评估发生在 agent_before_settle（watchdog 已结束）
		await agentBeforeSettle({}, ctx);
		const countAfterReset = recorder.workingMessages.length;
		await delay(WATCHDOG_DELAY_MS * 3);
		assert.equal(
			recorder.workingMessages.length,
			countAfterReset,
			"agent_before_settle 之后不该再刷 watchdog 文案",
		);
		await agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("session_before_compact 到达：复位提示（不误标自动压缩）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentEnd, beforeCompact, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: "short prompt", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await agentEnd({}, ctx);
		await waitFor(
			() => recorder.workingMessages.some((m) => m.includes("Subagent watchdog reviewing")),
			"watchdog 文案出现",
		);

		await beforeCompact({}, ctx);
		const countAfterReset = recorder.workingMessages.length;
		await delay(WATCHDOG_DELAY_MS * 3);
		assert.equal(recorder.workingMessages.length, countAfterReset, "压缩开始后不该再刷 watchdog 文案");
		await agentSettled({}, ctx);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("watchdog 提示显示中新回合开始：立刻复位，不残留到下一回合", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { input, agentStart, agentEnd, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const ctx = createContext(recorder);

		await input({ text: "short prompt", source: "interactive" }, ctx);
		await agentStart({}, ctx);
		await agentEnd({}, ctx);
		await waitFor(
			() => recorder.workingMessages.some((m) => m.includes("Subagent watchdog reviewing")),
			"watchdog 文案出现",
		);

		// 新回合开始（agent_start 复位）：之后不该再出现 watchdog 文案
		await agentStart({}, ctx);
		const countAfterReset = recorder.workingMessages.length;
		await delay(WATCHDOG_DELAY_MS * 3);
		assert.equal(
			recorder.workingMessages.slice(countAfterReset).some((m) => m.includes("Subagent watchdog reviewing")),
			false,
			"新回合开始后不该再有 watchdog 文案",
		);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

/**
 * 回合结束符（`turn-marker.ts` + `agent_settled` 里的 `showTurnMarker`）。用户 2026-10-07 定：
 * spinner 消失后原地留一行 `✻ <词> for <时长> · done <时刻>`，dim 色，只有正常完成的回合才画。
 */
test("正常完成：settle 画出结束符（✻ 词 + 时长 + 时刻，dim 色），agent_start 清掉", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, agentBeforeSettle, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const widgets: Array<{ key: string; content: unknown }> = [];
		const ctx = createContext(recorder, { onWidget: (key, content) => widgets.push({ key, content }) });

		await agentStart({}, ctx);
		await agentBeforeSettle({ outcome: "completed" }, ctx);
		await agentSettled({}, ctx);

		const drawn = widgets.filter((w) => w.key === TURN_MARKER_WIDGET_KEY && w.content !== undefined);
		assert.equal(drawn.length, 1, "settle 时应画一次结束符");
		const colors: string[] = [];
		const rendered = renderWidgetLines(drawn[0]?.content, (color, text) => {
			colors.push(color);
			return text;
		});
		assert.equal(rendered.length, 2, "两行：结束符 + 行尾空行（spinner 下方原本就有一条）");
		const line = rendered[0] as string;
		assert.equal(rendered[1], "", "第二行必须是空行 —— 否则结束符会和编辑器贴在一起、整块上移一格");
		assert.ok(
			TURN_MARKER_VERBS.some((verb) => line.startsWith(` ✻ ${verb} for `)),
			`词必须来自词表：${line}`,
		);
		assert.match(line, /^ ✻ \S+ for \d+s · done \d{1,2}:\d{2} (AM|PM)$/);
		assert.deepEqual(colors, ["dim"], "整行（含 ✻）走 dim 色槽（与 recap 的 `Recap:` 标签同档）");

		// 下一回合开始（agent_start）：结束符退场，让位给新的 spinner
		widgets.length = 0;
		await agentStart({}, ctx);
		assert.deepEqual(
			widgets.map((w) => [w.key, w.content]),
			[[TURN_MARKER_WIDGET_KEY, undefined]],
			"agent_start 应清掉结束符",
		);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("打断 / 报错收尾不画结束符（只有正常完成才画）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, agentBeforeSettle, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const widgets: Array<{ key: string; content: unknown }> = [];
		const ctx = createContext(recorder, { onWidget: (key, content) => widgets.push({ key, content }) });

		for (const outcome of ["aborted", "error"] as const) {
			await agentStart({}, ctx);
			await agentBeforeSettle({ outcome }, ctx);
			await agentSettled({}, ctx);
		}
		// 连 agent_before_settle 都没到（拿不到结局）时同样不画
		await agentStart({}, ctx);
		await agentSettled({}, ctx);

		assert.equal(
			widgets.filter((w) => w.content !== undefined).length,
			0,
			"非 completed 的回合不该出现结束符",
		);
		await shutdown({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("无 UI（print / json 模式）不画结束符", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const { agentStart, agentBeforeSettle, agentSettled, shutdown } = handlersOf(extension);
		const recorder: Recorder = { completes: [], workingMessages: [], resets: 0 };
		const widgets: Array<{ key: string; content: unknown }> = [];
		const ctx = createContext(recorder, { onWidget: (key, content) => widgets.push({ key, content }) });
		const headless = { ...(ctx as Record<string, unknown>), hasUI: false };

		await agentStart({}, headless);
		await agentBeforeSettle({ outcome: "completed" }, headless);
		await agentSettled({}, headless);

		assert.equal(widgets.length, 0, "无 UI 时不该碰任何 widget");
		await shutdown({}, headless);
	} finally {
		workspace.cleanup();
	}
});
