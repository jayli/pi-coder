/**
 * Tests for index.ts — 端到端：pi 自己的扩展加载器真的加载本扩展，补丁真的落在 **pi 渲染用的
 * 那个** `UserMessageComponent` 上，再用 pi 自己的组件渲染一条用户消息做 A/B 对照
 * （同一份文本、同一个宽度：补丁前 vs 补丁后）。
 *
 * Run with:  node --test clients/pi/extensions/user-message-bar/index.test.ts
 *
 * 为什么非得绕这一圈（不直接 new 一个组件来渲染）：这个特性的**唯一**风险就是「补丁打在另一个类
 * 上」—— `pi` 命令跑的是 `dist/bundle/cli.js`，pi 的类内联在 chunk 里，而扩展 import 到的是扩展
 * 加载器 virtualModules 给的那一份。只有真过一遍 pi 的加载器 + pi 自己的渲染组件，才能证明这两者
 * **是同一个类**（链路见 `bar.ts` 文件头）。`bar.test.ts` 覆盖纯逻辑与边界条件。
 *
 * 断言口径（A/B 逐行对照，比"看起来对不对"硬）：
 *   - 每一行的可见宽度与补丁前**完全一致**（pi-tui 对超宽行直接抛错，多一格都不行）；
 *   - 去掉零宽序列后，正文与补丁前逐字相同，只有行首那两格从「空格 + 正文」变成「竖线 + 空格」，
 *     而那多出来的一格是从**行尾补白**里吃的（宽度不变）；
 *   - 竖线颜色 = 皮肤 `accent`（强调色；这里注入的是一份自造皮肤，色值可控）；
 *   - OSC 133 zone 标记仍在首行最前面（不能被竖线挤到后面）；
 *   - 会话替换窗口内（旧 ctx 已作废、新 ctx 未到）渲染不抛异常、只是不画竖线（2026-09-20 回归）。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const ESC = "\u001b";

const BAR = "\u258f";
/** 自造皮肤的 `accent`（`#95c4ce` = 本机 `pi-coder-summer-night` 的 sky）—— 默认取色槽。 */
const ACCENT = "#95c4ce";
const ACCENT_FG = "\u001b[38;2;149;196;206m";
/** 默认取用的颜色（= accent），A/B 对照与 `undoBar` 用它。 */
const BAR_FG = ACCENT_FG;
/** 自造皮肤的 `toolDiffAdded`（`#89b8c2` = 该皮肤的 teal）：仅当 `accent` 缺失时的兜底槽。 */
const DIFF_ADDED = "#89b8c2";
const DIFF_ADDED_FG = "\u001b[38;2;137;184;194m";
/** `#2d2c5d` = 该皮肤的 select 色：背景槽，用来验证显式指定背景槽时的 38/48 转换。 */
const SELECTED_BG = "#2d2c5d";
const SELECTED_BG_FG = "\u001b[38;2;45;44;93m";

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

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	errors: Array<{ path: string; error: string }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	getMarkdownTheme: () => Record<string, unknown>;
	initTheme: (name?: string) => void;
	Theme: new (
		fgColors: Record<string, string>,
		bgColors: Record<string, string>,
		mode: string,
	) => unknown;
	UserMessageComponent: new (
		text: string,
		markdownTheme: unknown,
		outputPad: number,
		transformers: unknown[],
	) => { render(width: number): string[] };
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 注入给扩展的 `ctx.ui.theme`：一份自造皮肤，色值可控。
 *  `muted` / `thinkingXhigh` / `text` 是 Theme 构造器做兜底时读的（scrollbarTrack ← muted 等），
 *  少了它们构造器会在 `fgAnsi(undefined)` 上抛。 */
function createTheme(): unknown {
	assert.ok(pi);
	return new pi.Theme(
		{ accent: ACCENT, text: "#c6c8d1", muted: "#818596", thinkingXhigh: "#626262", toolDiffAdded: DIFF_ADDED },
		{ selectedBg: SELECTED_BG, userMessageBg: "#1b1c1d" },
		"truecolor",
	);
}

function createTestBus(): { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void } {
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

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-user-message-bar-"));
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

/** 用 pi 自己的加载器加载本扩展（`./bar.ts` 的 import 也一起验证）。 */
async function loadExtension(workspace: { agentDir: string; projectDir: string }): Promise<LoadedExtension> {
	assert.ok(pi);
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

/** 触达 pi 真实事件链路的那一步：`session_start` 带 ctx，扩展在这里拿到皮肤。 */
async function fireSessionStart(extension: LoadedExtension, theme: unknown): Promise<void> {
	await fireSessionStartWithCtx(extension, { ui: { theme } });
}

/** 同上，但直接给整个 ctx —— 用来注入一个「任何属性读取都抛」的作废 ctx。 */
async function fireSessionStartWithCtx(extension: LoadedExtension, ctx: unknown): Promise<void> {
	const handlers = extension.handlers.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "本扩展必须注册 session_start（否则拿不到皮肤）");
	for (const handler of handlers) await handler({ type: "session_start" }, ctx);
}

/** pi 的会话替换 / reload 先 emit 这个事件，再把旧 ctx 作废（`extensionRunner.invalidate()`）。 */
async function fireSessionShutdown(extension: LoadedExtension): Promise<void> {
	const handlers = extension.handlers.get("session_shutdown") ?? [];
	assert.ok(handlers.length > 0, "本扩展必须注册 session_shutdown（旧 ctx 作废前摘掉取色源）");
	for (const handler of handlers) await handler({ type: "session_shutdown", reason: "new" }, undefined);
}

/** pi 作废旧 ctx 时抛的那一句（`ExtensionRunner.assertActive()`）。 */
const STALE_CTX = "This extension ctx is stale after session replacement or reload.";

/** 一个与作废后的旧 ctx 行为一致的 ctx：读任何属性都抛。 */
function staleCtx(): unknown {
	return new Proxy(
		{},
		{
			get() {
				throw new Error(STALE_CTX);
			},
		},
	);
}

/** 走 pi 自己的组件渲染一条用户消息（`outputPad = 1`，与真实渲染一致）。 */
function renderUserMessage(text: string, width: number): string[] {
	assert.ok(pi);
	pi.initTheme("dark");
	const markdownTheme = { ...pi.getMarkdownTheme(), codeBlockIndent: "  " };
	return new pi.UserMessageComponent(text, markdownTheme, 1, []).render(width);
}

/** 去掉 CSI 颜色与 OSC 133 标记（用户消息首尾各挂一个）。 */
const plainText = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/**
 * 可见列数：剥掉零宽序列后按列数算（fixture 里只有 ASCII、汉字与 `▏`；汉字 2 列，其余 1 列）。
 * 独立实现一份是为了验证 pi 自己算出来的宽度与我们一致 —— 它是会不会撞上 pi-tui 超宽抛错的判据。
 */
const visibleWidth = (line: string): number => {
	let width = 0;
	for (const ch of plainText(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
};

/** 竖线（含取色与前景复位）及其后面那一格缩进空白：正好就是扩展写进每一行的那一段。 */
const barOf = (fg: string): string => `${fg}${BAR}\u001b[39m `;

/**
 * 把打完补丁的那一行**逐字节还原**成未打补丁的样子：竖线 + 缩进换回行首内边距那一格空格，
 * 再从行尾补白里还回它吃掉的一格。还原不回来就说明补丁动了别的东西。
 */
const undoBar = (line: string, fg: string): string =>
	line.replace(barOf(fg), " ").replace(/\u001b\[49m$/, (reset) => ` ${reset}`);

const MESSAGE = "第一行正文\n第二行更长的正文正文正文正文正文正文正文正文正文";
const WIDTH = 46;

/** 原型补丁是**进程级**的，一旦装上就活到进程结束 —— 这条必须排在任何一次真实安装之前，
 *  否则看到的是前面用例留下的补丁。真实世界里 off 是启动开关（模块根本不加载），没有这个问题。 */
test("PI_USER_MESSAGE_BAR=off 时连补丁都不装", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_USER_MESSAGE_BAR = "off";
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.size, 0, "off 时连 session_start 都不注册");
		const lines = renderUserMessage(MESSAGE, WIDTH);
		assert.equal(lines.some((line) => line.includes(BAR)), false, "不画竖线");
	} finally {
		delete process.env.PI_USER_MESSAGE_BAR;
		workspace.cleanup();
	}
});

test("扩展能被 pi 的加载器加载，并把补丁装在 pi 自己的 UserMessageComponent 上", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.get("session_start")?.length, 1, "注册了一个 session_start");
		assert.equal(extension.handlers.get("session_shutdown")?.length, 1, "注册了一个 session_shutdown");
		assert.equal(extension.handlers.size, 2, "只注册这两个事件");
	} finally {
		workspace.cleanup();
	}
});

test("补丁前 pi 的渲染原样（扩展刚加载、还没拿到皮肤时不加竖线）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		await loadExtension(workspace);

		const lines = renderUserMessage(MESSAGE, WIDTH);
		assert.equal(lines.length >= 3, true, "至少上下留白 + 一行正文");
		assert.equal(lines.some((line) => line.includes(BAR)), false, "没有皮肤时不画竖线");
	} finally {
		workspace.cleanup();
	}
});

test("拿到皮肤后：每行行首一条竖线 + 正文前一格缩进，颜色是强调色 accent，行宽与正文一字不差", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const before = renderUserMessage(MESSAGE, WIDTH);
		await fireSessionStart(extension, createTheme());
		const after = renderUserMessage(MESSAGE, WIDTH);

		assert.equal(after.length, before.length, "行数不变");
		for (const [i, line] of after.entries()) {
			assert.equal(line.includes(`${BAR_FG}${BAR}\u001b[39m`), true, `第 ${i} 行的竖线用的是 accent 色`);
			assert.equal(plainText(line).startsWith(`${BAR} `), true, `第 ${i} 行行首是竖线 + 一格空白`);
			// 竖线跟着消息底色：不插任何背景开关序列，底色块左边缘不被抠出缺角
			assert.equal(line.split("\u001b[49m").length - 1, 1, `第 ${i} 行只有行尾那一个关背景`);
			assert.equal(undoBar(line, BAR_FG), before[i], `第 ${i} 行只多了竖线 + 缩进、没动别的`);
			assert.equal(visibleWidth(line), visibleWidth(before[i] ?? ""), `第 ${i} 行可见宽度不变`);
		}
		assert.equal(after[0].startsWith(`${ESC}]133;A\u0007`), true, "zone 标记仍在首行最前");
		const joined = after.map(plainText).join("\n");
		assert.equal(joined.includes("第一行正文"), true, "正文内容在");
		assert.equal(joined.includes("第二行更长的正文"), true, "折行后的正文也在");
	} finally {
		workspace.cleanup();
	}
});

/**
 * 正文折到满行的那些行：Box 给孩子的宽度是 `width - 2`，正文总能留下至少一格行尾补白，
 * 所以竖线 + 缩进永远吃得下。这里用一条长正文把 pi 的折行真的跑出来，逐行验宽度。
 */
test("正文折行到满行时也能空出那一格：每行仍然正好 width 列", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		const long = "正文".repeat(60);
		await fireSessionStart(extension, createTheme());
		const lines = renderUserMessage(long, WIDTH);

		assert.equal(lines.length > 3, true, "长正文应该折成多行");
		for (const [i, line] of lines.entries()) {
			assert.equal(visibleWidth(line), WIDTH, `第 ${i} 行正好 ${WIDTH} 列（超一格 pi-tui 就抛错）`);
			assert.equal(plainText(line).startsWith(`${BAR} `), true, `第 ${i} 行行首是竖线 + 缩进`);
		}
	} finally {
		workspace.cleanup();
	}
});

test("PI_USER_MESSAGE_BAR_COLOR=toolDiffAdded 显式换成另一个前景槽（不做 38/48 转换）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_USER_MESSAGE_BAR_COLOR = "toolDiffAdded";
	try {
		const extension = await loadExtension(workspace);
		await fireSessionStart(extension, createTheme());
		const lines = renderUserMessage(MESSAGE, WIDTH);

		for (const line of lines) {
			assert.equal(line.includes(`${DIFF_ADDED_FG}${BAR}`), true, "竖线用 toolDiffAdded");
			assert.equal(line.includes(ACCENT_FG), false, "没有用默认的 accent");
		}
	} finally {
		delete process.env.PI_USER_MESSAGE_BAR_COLOR;
		workspace.cleanup();
	}
});

test("PI_USER_MESSAGE_BAR_COLOR=selectedBg 也能用：背景槽转成前景（38/48）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_USER_MESSAGE_BAR_COLOR = "selectedBg";
	try {
		const extension = await loadExtension(workspace);
		await fireSessionStart(extension, createTheme());
		const lines = renderUserMessage(MESSAGE, WIDTH);

		for (const line of lines) {
			assert.equal(line.includes(`${SELECTED_BG_FG}${BAR}`), true, "竖线用 selectedBg 的 38 等值");
			assert.equal(line.includes(BAR_FG), false, "没有用默认的 accent");
			assert.equal(line.includes(`\u001b[48;2;45;44;93m${BAR}`), false, "不该把背景槽直接当背景铺上去");
		}
	} finally {
		delete process.env.PI_USER_MESSAGE_BAR_COLOR;
		workspace.cleanup();
	}
});

/**
 * 回归：会话被替换的那一瞬间（`/clear`、`/new`、`/resume`、`/fork`、`/reload`），pi 会让旧 ctx
 * 作废、但旧消息还挂在 `chatContainer` 上、新 ctx 还没到手 —— 这段时间里的渲染 tick 一读旧 ctx
 * 就会抛，而这个异常从渲染回调抛出没人接得住，直接把 pi `exit(1)`（2026-09-20 实测）。
 * 所以「拿不到皮肤」必须是这一帧不画竖线，而不是把异常放出去。
 */
test("旧 ctx 已作废时渲染不抛、也不画竖线（渲染 tick 落进替换窗口不能掀翻 pi）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		await fireSessionStartWithCtx(extension, staleCtx());

		const lines = renderUserMessage(MESSAGE, WIDTH); // 以前这里抛 → 直达 pi 的 uncaughtException
		assert.equal(lines.some((line) => line.includes(BAR)), false, "读不到皮肤就不画竖线");
		assert.equal(lines.length >= 3, true, "消息本身照常渲染（上下留白 + 正文）");
		assert.equal(plainText(lines.join("\n")).includes("第一行正文"), true, "正文一字不少");
	} finally {
		workspace.cleanup();
	}
});

/**
 * 回归：`session_shutdown` 一到就复位取色源。断言方式是「让旧 ctx 之后开始抛」—— 复位生效的话
 * 渲染根本不会去读它；没复位则会像上一条那样抛。
 */
test("session_shutdown 后不画竖线，且渲染不再碰旧 ctx（旧 ctx 此后开始抛也不炸）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		let live = true;
		const theme = createTheme();
		await fireSessionStartWithCtx(extension, {
			ui: {
				get theme() {
					if (!live) throw new Error(STALE_CTX);
					return theme;
				},
			},
		});
		const before = renderUserMessage(MESSAGE, WIDTH);
		assert.equal(before.some((line) => line.includes(`${BAR_FG}${BAR}`)), true, "换之前有皮肤，画竖线");

		await fireSessionShutdown(extension);
		live = false; // 此刻起旧 ctx 已作废：只要有人读它就会抛
		const after = renderUserMessage(MESSAGE, WIDTH);

		assert.equal(after.some((line) => line.includes(BAR)), false, "shutdown 之后不画竖线");
		for (const [i, line] of after.entries()) assert.equal(line, undoBar(before[i] ?? "", BAR_FG), `第 ${i} 行回到未打补丁的样子`);
	} finally {
		workspace.cleanup();
	}
});
