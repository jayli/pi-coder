/**
 * rainbow 的**端到端**验证：用 pi 自己的扩展加载器真加载 `thinking-collapse.ts`，
 * 拿到它注册的 markdown transformer，再拿**真的 pi-tui `Markdown` 组件**渲染出口文本。
 *
 * 为什么必须走到这一步：本特性的全部价值是「屏幕上长什么样」，而最容易出问题的地方
 * 恰恰在接线处 —— 注入的转义会不会被 pi 二次处理、`visibleWidth` 量得对不对、
 * 着色后会不会超过预算被 pi 折成两行（本扩展的核心约束是出口恰好一行）。
 * 只测纯函数会漏掉这些。
 *
 *   node --test clients/pi/extensions/thinking-collapse/rainbow.e2e.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, "..", "thinking-collapse.ts");

/**
 * 找本机 pi 的库入口。
 *
 * **顺序很重要**：先看 `PATH` 上的 `pi` shim —— 那才是用户真正在跑的副本（本机是
 * 1.1.0 的 bundle）。`~/.pi/agent/npm/` 下的那份是旧版本残留（0.87.1），它的 pi-tui
 * 没有 `okhslColor` / `foregroundAnsi`（本特性要用），拿它测会“颜色静默消失”而误判成 bug。
 * 这跟 background-tasks 的 findPiLibraryEntry 同一套做法。
 */
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
			// 不是符号链接 / 不存在
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim
		}
	}

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

const cleanups: Array<() => void> = [];
test.after(() => {
	for (const fn of cleanups) fn();
});

interface TransformerLike {
	(markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }): string;
}

interface LoadedExtension {
	markdownTransformer?: TransformerLike;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
}

interface Harness {
	transform: TransformerLike;
	command(args: string): Promise<void>;
	startSession(): Promise<void>;
	/** 派发一个扩展事件（流式事件用这个驱动 `thinkingStreaming` 状态机）。 */
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	notifies: Array<{ text: string; level?: string }>;
	configFile: string;
	theme: FakeTheme;
	/** 环境色的开启序列，与 `theme.getFgAnsi` 返回的一致（序号/模式都对得上）。 */
	ambient: string;
}

/**
 * 假皮肤：只需 `getFgAnsi` / `getColorMode` / `appearance` 三个面（扩展就取这三样）。
 * 环境色转义故意用一个好认的串，测试才能断言「每个单位后面补了环境色」。
 */
interface FakeTheme {
	getFgAnsi(token: string): string;
	getColorMode(): "truecolor" | "256color";
	appearance: "dark" | "light";
}

async function loadHarness(options: { enabled?: boolean; appearance?: "dark" | "light"; mode?: "truecolor" | "256color" } = {}): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }>; runtime: Record<string, unknown> }>;
		createEventBus: () => unknown;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rainbow-e2e-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	cleanups.push(() => {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// 清理失败不影响测试结论
		}
	});

	// 配置隔离：扩展在 session_start 时按 env 解析路径，所以 env 必须在加载前设好。
	const configFile = path.join(root, "rainbow.json");
	if (options.enabled !== undefined) fs.writeFileSync(configFile, JSON.stringify({ enabled: options.enabled }));
	const savedConfig = process.env.PI_RAINBOW_CONFIG;
	const savedState = process.env.PI_RAINBOW;
	process.env.PI_RAINBOW_CONFIG = configFile;
	delete process.env.PI_RAINBOW;
	cleanups.push(() => {
		if (savedConfig === undefined) delete process.env.PI_RAINBOW_CONFIG;
		else process.env.PI_RAINBOW_CONFIG = savedConfig;
		if (savedState === undefined) delete process.env.PI_RAINBOW;
		else process.env.PI_RAINBOW = savedState;
	});

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 thinking-collapse 扩展");
	assert.ok(extension.markdownTransformer, "应该注册 markdown transformer");

	const notifies: Array<{ text: string; level?: string }> = [];
	const mode = options.mode ?? "truecolor";
	// 环境色的开启序列要和 `getColorMode()` 对得上：256 色终端上如果环境色发 truecolor，
	// 「不该出现 38;2」这类断言测的就不是我们的上色代码了。
	const ambient = mode === "256color" ? "\u001b[38;5;245m" : "\u001b[38;2;122;138;153m";
	const theme: FakeTheme = {
		getFgAnsi: () => ambient,
		getColorMode: () => mode,
		appearance: options.appearance ?? "dark",
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		ui: { notify: (text: string, level?: string) => notifies.push({ text, level }), theme },
	};

	return {
		transform: extension.markdownTransformer,
		command: async (args: string) => {
			const command = extension.commands.get("rainbow");
			assert.ok(command, "应该注册 /rainbow 命令");
			await command.handler(args, ctx);
		},
		startSession: async () => {
			for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
		},
		emit: async (event, payload = {}) => {
			for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
		},
		notifies,
		configFile,
		theme,
		ambient,
	};
}

/**
 * 建 harness 并跑一遍 `session_start`。
 *
 * 真 pi 在会话开始/恢复时**总是**发 `session_start`，transform 则在那之后才被调 ——
 * 所以这里跟着走同一个次序：不着色的那条路径（enabled:false）不需要 ctx，但统一跑一遍
 * 才能保证测的是真实生命周期。
 */
async function loadSession(
	options: { enabled?: boolean; appearance?: "dark" | "light"; mode?: "truecolor" | "256color" } = {},
): Promise<Harness> {
	const harness = await loadHarness(options);
	await harness.startSession();
	return harness;
}

const STREAMING = { messageType: "assistant-thinking", isStreaming: true, availableWidth: 60 };
const SETTLED = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 60 };

/**
 * 建 harness、跑 `session_start`，再把状态拨到「thinking 正在流式输出」。
 *
 * 着色现在要求 `thinkingStreaming` 为真（见 thinking-collapse.ts：边界是 thinking 块自己的
 * 结束，不是整条消息），而这个状态只能由 `message_update` 驱动 —— 所以需要着色效果的用例
 * 都得先走一遍这个前置。
 */
async function loadStreaming(
	options: { enabled?: boolean; appearance?: "dark" | "light"; mode?: "truecolor" | "256color" } = {},
): Promise<Harness> {
	const harness = await loadSession(options);
	await harness.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
	return harness;
}

/** 去掉所有 ANSI，拿回纯文本（与 pi-tui 的 visibleWidth 同口径地剥 CSI 序列）。 */
function plain(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

test("streaming thinking gets rainbow escapes; settled thinking does not", { skip }, async () => {
	const h = await loadSession({ enabled: true });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });

	const streaming = h.transform("alpha beta gamma", STREAMING);
	assert.ok(streaming.includes("\u001b[38;2;"), `流式应该带彩色转义：${JSON.stringify(streaming)}`);
	assert.ok(plain(streaming).startsWith("Think: "), `标签仍在行首：${JSON.stringify(plain(streaming))}`);

	// 定型后同一块重渲染：pi 会用 isStreaming=false 再调一次，颜色必须整个消失（回灰）
	const settled = h.transform("alpha beta gamma", SETTLED);
	assert.ok(!settled.includes("\u001b[38;2;"), `定型后不该带彩色转义：${JSON.stringify(settled)}`);
	assert.equal(plain(settled), plain(streaming), "着色只加转义，可见文本必须逐字相同");
});

/**
 * 着色窗口的边界 = **thinking 块自己**的结束，不是整条消息的结束。
 *
 * 用户 2026-10-10 报的 bug：thinking 早就写完了，那一行还一直亮着彩虹，要等整个回答（正文 +
 * 工具调用）都结束才变灰。根因是当时用了 `context.isStreaming`，而那个标志的粒度是整条
 * assistant 消息。这组用例把新的边界钉住。
 */
test("turns gray at thinking_end, before the answer text even starts", { skip }, async () => {
	const h = await loadSession({ enabled: true });

	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
	assert.ok(
		h.transform("思考中的内容", STREAMING).includes("\u001b[38;2;"),
		"thinking 流式中应该着色",
	);

	// thinking 块结束 —— 此时正文还没开始，但彩虹必须已经收掉
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } });
	const afterThinking = h.transform("思考中的内容", STREAMING);
	assert.ok(!afterThinking.includes("\u001b[38;2;"), `thinking 一结束就该回灰：${JSON.stringify(afterThinking)}`);
});

test("stops coloring on any content that follows the thinking block", { skip }, async () => {
	// 兼容那些不发 thinking_end 的后端（pi 自带的 pi-messages 实测一个都没有）：
	// 正文/工具调用的第一个 delta 就是兼底信号，不能等 message_end。
	for (const type of ["text_start", "text_delta", "toolcall_start", "toolcall_delta"] as const) {
		const h = await loadSession({ enabled: true });
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
		assert.ok(h.transform("内容", STREAMING).includes("\u001b[38;2;"), `${type}: 前置 thinking 应着色`);
		await h.emit("message_update", { assistantMessageEvent: { type } });
		assert.ok(
			!h.transform("内容", STREAMING).includes("\u001b[38;2;"),
			`${type}: 之后应停止着色`,
		);
	}
});

test("resumes coloring when a later thinking block starts in the same message", { skip }, async () => {
	// 交错思考：正文与工具调用之后又冒出一个 thinking 块，它自己的流式期间要重新亮起来
	const h = await loadSession({ enabled: true });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
	await h.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "x" } });
	assert.ok(!h.transform("内容", STREAMING).includes("\u001b[38;2;"), "正文期间不该着色");

	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
	assert.ok(h.transform("又一段思考", STREAMING).includes("\u001b[38;2;"), "第二个 thinking 块应重新着色");
});

test("a new assistant message starts without coloring until its thinking begins", { skip }, async () => {
	const h = await loadSession({ enabled: true });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
	assert.ok(h.transform("内容", STREAMING).includes("\u001b[38;2;"), "上一块应为着色态");

	// 新一轮 assistant 消息开始时状态必须先归零（否则上一块的颜色会渗到新消息）
	await h.emit("message_start", { message: { role: "assistant", content: [] } });
	assert.ok(!h.transform("内容", STREAMING).includes("\u001b[38;2;"), "新消息的 thinking 开始前不着色");
});

test("message_end clears the coloring state", { skip }, async () => {
	const h = await loadSession({ enabled: true });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
	await h.emit("message_end", { message: { role: "assistant", content: [] } });
	assert.ok(!h.transform("内容", STREAMING).includes("\u001b[38;2;"), "消息结束后不该着色");
});

test("color: off leaves streaming output byte-identical to the uncolored path", { skip }, async () => {
	const h = await loadStreaming({ enabled: false });
	const off = h.transform("alpha beta gamma", STREAMING);
	assert.ok(!off.includes("\u001b[38;2;"), `关了就不该有彩色：${JSON.stringify(off)}`);

	// 同一个扩展在 on 状态下的输出（另开一个 harness，读不同的配置文件）。
	// 这里必须断言“on 确实上色了”—— 否则两边都不上色时也会相等，用例就变成空跑。
	const on = await loadStreaming({ enabled: true });
	const colored = on.transform("alpha beta gamma", STREAMING);
	assert.ok(colored.includes("\u001b[38;2;"), `on 应该上色：${JSON.stringify(colored)}`);
	assert.equal(plain(colored), plain(off), "开关只影响颜色，不影响文本");
});

test("hands color back to the ambient thinking color when the run ends", { skip }, async () => {
	const h = await loadStreaming({ enabled: true });
	const out = h.transform("alpha beta", STREAMING);
	// pi 每个文本 token 只套一次 thinkingText：我们插的颜色会一直生效到下一次设色，
	// 所以着色区结束处必须把环境色交还回去，否则后续内容（code span 残余等）会沿用彩虹色。
	// （`foregroundAnsi` / `getFgAnsi` 返回的只是**开启**序列；切色靠新序列覆盖。）
	assert.ok(out.endsWith(h.ambient), `行尾应停在环境色上：${JSON.stringify(out)}`);

	// 连续着色的单位之间直接换色，**不**逐单位回填 —— 一圈文字只留一次收尾
	const escaped = h.ambient.replace(/[\u001b[\]]/g, "\\$&");
	assert.equal((out.match(new RegExp(escaped, "g")) ?? []).length, 1, `环境色应只出现在末尾：${JSON.stringify(out)}`);
});

test("keeps code spans in their own color (no rainbow inside backticks)", { skip }, async () => {
	const h = await loadSession({ enabled: true });
	const line = "before `code here` after";
	const out = h.transform(line, STREAMING);
	// code span 那段一个彩虹转义都不能夹进去
	const inner = out.slice(out.indexOf("`"), out.indexOf("`") + "`code here`".length);
	assert.ok(!inner.includes("\u001b[38;2;"), `code span 内不该着色：${JSON.stringify(inner)}`);
	assert.equal(plain(out), `Think: ${line}`);
});

test("colors follow the word, not the screen position, as the head is clipped away", { skip }, async () => {
	const h = await loadStreaming({ enabled: true });
	const long = `${"words ".repeat(20)}END`;
	const out = h.transform(long, { ...STREAMING, availableWidth: 30 });
	assert.ok(plain(out).startsWith("Think: …"), `应该头部截断：${JSON.stringify(plain(out))}`);
	// 行尾永远是最新内容
	assert.ok(plain(out).endsWith("END"), `行尾应为最新 token：${JSON.stringify(plain(out))}`);
	// 同一段文本、**不同窗口**（宽度不同 → 截断点不同）：END 的颜色必须一致。
	// 这正是「颜色跟着词走」的含义 —— 若按屏幕位置发色，这两次会不同（也就是每来一个
	// token 整行都会闪一次色）。
	const wide = h.transform(long, { ...STREAMING, availableWidth: 48 });
	const colorEndOf = (text) => {
		const visibleAt = plain(text).indexOf("END");
		let color;
		for (const match of text.matchAll(/\u001b\[(?:38;[0-9;]+)m/g)) {
			if (plain(text.slice(0, match.index)).length <= visibleAt) color = match[0];
		}
		return color;
	};
	assert.equal(colorEndOf(out), colorEndOf(wide), "同一批字在不同窗口下颜色应一致");
});

test("/rainbow on|off persists to the config file and takes effect without reload", { skip }, async () => {
	const h = await loadSession({ enabled: false });
	const streaming = async () => {
		await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "a" } });
	};

	await streaming();
	assert.ok(!h.transform("alpha beta", STREAMING).includes("\u001b[38;2;"), "初始关：不该着色");

	await h.command("on");
	await streaming();
	assert.ok(h.transform("alpha beta", STREAMING).includes("\u001b[38;2;"), "开之后应立即着色");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.configFile, "utf8")), { enabled: true }, "开要落盘");

	await h.command("off");
	await streaming();
	assert.ok(!h.transform("alpha beta", STREAMING).includes("\u001b[38;2;"), "关之后应立即停");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.configFile, "utf8")), { enabled: false }, "关也要落盘");

	// 无参数 / status 只报状态，不改状态
	await h.command("");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.configFile, "utf8")), { enabled: false });
	assert.equal(h.notifies.at(-1)?.text?.includes("关"), true, "应提示当前为关");
});

test("/rainbow rejects an unknown argument and keeps the state", { skip }, async () => {
	const h = await loadSession({ enabled: true });
	await h.command("maybe");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.configFile, "utf8")), { enabled: true }, "状态不该被改");
	assert.equal(h.notifies.at(-1)?.level, "warning");
});

test("light themes get the darker palette", { skip }, async () => {
	const dark = await loadStreaming({ enabled: true, appearance: "dark" });
	const light = await loadSession({ enabled: true, appearance: "light" });
	const text = "alpha beta gamma delta";
	const darkOut = dark.transform(text, STREAMING);
	const lightOut = light.transform(text, STREAMING);
	assert.notEqual(darkOut, lightOut, "深/浅底色应该用不同的色板");
	assert.equal(plain(darkOut), plain(lightOut), "只有颜色不同，文本一致");
});

test("256color terminals get indexed escapes, not truecolor", { skip }, async () => {
	const h = await loadStreaming({ enabled: true, mode: "256color" });
	const out = h.transform("alpha beta", STREAMING);
	assert.ok(out.includes("\u001b[38;5;"), `应该发 256 色索引序列：${JSON.stringify(out)}`);
	assert.ok(!out.includes("\u001b[38;2;"), `不该发 truecolor 序列：${JSON.stringify(out)}`);
});

/**
 * 从与 pi **同一安装**里取 pi-tui。
 *
 * 解析路径要从**真实包根**出发，不能从 `piEntry` 的字面路径出发：本机 pi 是 pnpm 全局装的，
 * shim 的 `cmd-shim-target` 指向 `~/Library/pnpm/global/<ver>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，
 * 而那个 `pi-coding-agent` 目录只是指向 pnpm store 的**符号链接**，`dist/bundle` 的旁边并没有
 * `node_modules`（pi 是 bundle 安装，pi-tui 被内嵌进 chunk，磁盘上不是它的依赖）。所以按
 * `piEntry/../node_modules/...` 拼出来的路径必然不存在 —— 这正是这个函数曾经静默走到
 * `~/.pi/agent/npm/` 那份旧残留、把「颜色消失」误判成 bug 的原因。
 *
 * 正确做法：先截出 `.../node_modules/@earendil-works/pi-coding-agent` 这一段包根，`realpathSync`
 * 解开符号链接，再从那儿的 `package.json` 起 `require.resolve("@earendil-works/pi-tui")`
 * （pnpm 会解析到 store 里的真身）；解析不出来就退到 realpath 后的**同级目录**
 * `@earendil-works/pi-tui/dist/index.js`。两者都拿的是与运行时 pi 同一版本的 pi-tui。
 */
async function loadTui(): Promise<{
	Markdown: new (
		text: string,
		padX: number,
		padY: number,
		theme: Record<string, unknown>,
		style: Record<string, unknown>,
		options: Record<string, unknown>,
	) => { render(width: number): string[] };
	visibleWidth: (text: string) => number;
}> {
	const { createRequire } = await import("node:module");
	const candidates: string[] = [];

	// 1) 从真实包根做 require.resolve（pnpm 符号链接下的唯一可靠途径）。
	const pkgMarker = `${path.sep}node_modules${path.sep}@earendil-works${path.sep}pi-coding-agent${path.sep}`;
	const markerAt = (piEntry as string).indexOf(pkgMarker);
	if (markerAt >= 0) {
		const pkgRoot = (piEntry as string).slice(0, markerAt + pkgMarker.length - 1);
		let realPkgRoot = pkgRoot;
		try {
			realPkgRoot = fs.realpathSync(pkgRoot);
		} catch {
			// 链接断了就用字面路径继续试
		}
		try {
			candidates.push(createRequire(path.join(realPkgRoot, "package.json")).resolve("@earendil-works/pi-tui"));
		} catch {
			// bundle 安装：这个包不是它的声明依赖，require.resolve 会失败 —— 改走同级目录
		}
		candidates.push(path.join(path.dirname(realPkgRoot), "pi-tui", "dist", "index.js"));
	}

	// 2) 兜底：piEntry 字面路径的旁边、以及 pi 自己装外部包的目录（版本可能更旧，排在最后）。
	candidates.push(
		path.join(path.dirname(piEntry as string), "..", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-tui/dist/index.js"),
	);

	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate) || !fs.existsSync(candidate)) continue;
		seen.add(candidate);
		const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
		// 版本对不上时（旧 pi-tui 没有色彩工具）宁可换下一份，除非已经没得选
		if (typeof mod.visibleWidth === "function" && typeof mod.Markdown === "function") return mod as never;
	}
	throw new Error(`找不到可用的 pi-tui：${[...seen].join(", ")}`);
}

const identity = (text: string) => text;
const MD_THEME = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: (text: string) => `\u001b[38;2;230;192;123m${text}\u001b[39m`,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	underline: identity,
	strikethrough: identity,
	highlightCode: (code: string) => code.split("\n"),
};

test("renders through pi-tui's real Markdown to exactly one line, and never wider than the budget", { skip }, async () => {
	const h = await loadSession({ enabled: true });
	const tui = await loadTui();

	const cases: Array<{ text: string; width: number }> = [
		{ text: "alpha beta gamma delta epsilon zeta eta theta", width: 40 },
		{ text: "中文思考内容每个字一个颜色一二三四五六七八九十", width: 30 },
		{ text: "mixed 中英 file 里的 `code span` tail", width: 36 },
		{ text: "x".repeat(300), width: 24 },
		{ text: "head `span` tail\n\n" + "再一段中文内容", width: 28 },
	];

	for (const { text, width } of cases) {
		// 走扩展的 transformer（着色）→ 交给 pi-tui 的真 Markdown 组件渲染
		const transformed = h.transform(text, {
			messageType: "assistant-thinking",
			isStreaming: true,
			availableWidth: width - 2, // Markdown 组件左右各 1 列 padding
		});
		const component = new tui.Markdown(transformed, 1, 0, MD_THEME, { color: identity, italic: false }, {});
		const lines = component.render(width);
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		assert.equal(nonEmpty.length, 1, `出口必须恰好一行：${JSON.stringify(nonEmpty)}`);
		for (const line of lines) {
			assert.ok(
				tui.visibleWidth(line) <= width,
				`行宽 ${tui.visibleWidth(line)} 超过 ${width}：${JSON.stringify(plain(line))}`,
			);
		}
	}
});

/**
 * 可见文字里出现了 CSI 参数残尾（如 `38;2;149;174;43m`）—— 那就是我们的颜色转义被
 * marked 拆开了，转义的尾巴当成普通字显示出来。这种残尾既会弄脏文字，也会把行宽顶超
 * 预算（pi 于是二次折行）。只删 CSI 后再找 `\[[0-9;]*m?` 这种形状。
 */
function leakedEscapeResidue(rendered: string): string[] {
	const visible = plain(rendered);
	return visible.match(/\[?[0-9]{1,3}(;[0-9]{1,3})+m?/g) ?? [];
}

/**
 * 把一段已着色文本里的 **所有** 终端转义剔干净（CSI 任意终止符 + OSC + APC）。
 *
 * 比文件头的 `plain()` 强：那个只剔 `m` 结尾的 SGR，而 pi 渲染链接时会发 OSC-8
 * （`\x1b]8;;url\x1b\\`）—— 不剔掉它，两边的可见文字就对不上。
 *
 * 用来算“基准渲染”：同一份文字但一条颜色转义都没有时，marked 会把它渲染成什么样。
 */
function stripAllAnsi(text: string): string {
	return text
		.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\u001b[\]_][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

/** 渲染结果去转义 + 去 padding，拿到可与基准直接比的可见文字。 */
function visibleOf(lines: readonly string[]): string {
	return lines.map((line) => stripAllAnsi(line).replace(/ +$/, "").trim()).join("");
}

/**
 * 折行的真因（用户 2026-10-12 报的 bug，已用真实会话文本逐字复现）：
 *
 * pi 会把本扩展的出口文本再交给 marked 解析一次，而我们插进去的彩虹色转义
 * `\x1b[38;2;149;174;43m` 对 marked 而言只是一串普通字符 —— 它的 email 自动链接规则
 * （`url` tokenizer 的 `[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+`）
 * 会把尾巴上的 `43m` 当成邮箱**用户名的一部分**吞进链接，转义于是被截成
 * `\x1b[38;2;149;174;` —— 没有终止字符 `m`，pi 的 `visibleWidth` 不认它，残尾就变成
 * 可见文字（屏幕上就是用户看到的 `43mpi-web-access@0.39.0`），行宽跟着超出预算，
 * pi 再折一次 —— 折出来的续行没有 `Think: ` 标签。
 *
 * 同类第二条路径：`](` 让 CSI 的 `[` 变成 markdown 链接的左括号（`[38;2;149;174;43msee foo](bar)`
 * 整个被当成链接），链接文字只剩 `38;2;149;174;43msee foo`。
 *
 * 两条路径的共同修法：把 `@` 与**窗口内未配对**的 `]` 转义成 `\@` / `\]`（marked 的 escape 规则会把
 * 反斜杠吃掉，渲染后逐字变回原样）。本用例钉住三个不变量：出口仍然恰好一行、无转义残尾、
 * 可见文字与“同一份文本不带任何颜色转义”的基准渲染逐字相同（后一条就是“转义对 markdown 必须透明”；
 * 刻意不拿原文比，因为像 `[0](x)` 这种**本来就是合法链接**的内容，marked 会渲染成 `0` ——
 * 那是内容驱动的行为，与本 bug 无关，带不带转义都一样）。
 */
test("an email-looking token after a rainbow escape does not wrap the line", { skip }, async () => {
	const h = await loadStreaming({ enabled: true });
	const tui = await loadTui();

	const cases: Array<{ text: string; width: number }> = [
		// 用户报的原句（取自 2026-10-12 真实会话的 thinking）
		{
			text:
				"The packages entry needs full dependency graph of pi-web-access@0.39.0 — same as 0.38.0 (same ranges). So: duplicate the entry.",
			width: 78,
		},
		// 最小复现：一个 email 形状的 token 就够
		{ text: "check pi-web-access@0.39.0 now", width: 40 },
		{ text: "mail foo@bar.com ok", width: 24 },
		// 同类第二路径：`]( ` 把 CSI 的 `[` 当成链接左括号
		{ text: "see foo](bar) and arr[0](x) here", width: 40 },
		{ text: "a [label](http://x.dev) b", width: 34 },
		// 带凭据的裸 URL：里面的 `@` 不转义（转了会渲染出多一个反斜杠的假 URL）
		{ text: "curl https://user:pass@localhost:8002/x now", width: 44 },
	];

	for (const { text, width } of cases) {
		const transformed = h.transform(text, {
			messageType: "assistant-thinking",
			isStreaming: true,
			availableWidth: width - 2,
		});
		const component = new tui.Markdown(transformed, 1, 0, MD_THEME, { color: identity, italic: false }, {});
		const lines = component.render(width);
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		const rendered = nonEmpty.join("");

		assert.deepEqual(
			leakedEscapeResidue(rendered),
			[],
			`颜色转义被 marked 拆开了（可见文字里出现 CSI 参数）：${JSON.stringify(stripAllAnsi(rendered))}`,
		);
		assert.equal(nonEmpty.length, 1, `出口必须恰好一行：${JSON.stringify(nonEmpty.map(plain))}`);
		for (const line of lines) {
			assert.ok(
				tui.visibleWidth(line) <= width,
				`行宽 ${tui.visibleWidth(line)} 超过 ${width}：${JSON.stringify(plain(line))}`,
			);
		}

		// 转义对 markdown 必须透明：可见文字等于“同一份文本不带任何颜色转义”的基准渲染
		const reference = visibleOf(
			new tui.Markdown(stripAllAnsi(transformed), 1, 0, MD_THEME, { color: identity, italic: false }, {})
				.render(width)
				.filter((line) => line.trim() !== ""),
		);
		assert.equal(
			visibleOf(nonEmpty),
			reference,
			`可见文字应与无色基准渲染逐字相同（原文：${JSON.stringify(text)}）`,
		);
		// 转义不得把反斜杠泄露成可见字符（marked 的 escape 规则应该把它吃掉）
		assert.ok(
			!visibleOf(nonEmpty).includes("\\"),
			`不该出现可见的反斜杠：${JSON.stringify(visibleOf(nonEmpty))}`,
		);
	}
});
