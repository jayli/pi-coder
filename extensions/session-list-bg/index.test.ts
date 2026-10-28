/**
 * Tests for index.ts — 端到端：pi 自己的扩展加载器真的加载本扩展，补丁真的落在 **pi 渲染用的
 * 那个** `SessionSelectorComponent` 上，再用 pi 自己的会话选择器渲染一份假会话列表做 A/B 对照
 * （同一份会话、同一个宽度：补丁前 vs 补丁后）。
 *
 * Run with:  node --test clients/pi/extensions/session-list-bg/index.test.ts
 *
 * 为什么非得绕这一圈（不直接 new 一个假类）：这个特性的**唯一**风险就是「补丁打在另一个类上」
 * —— `pi` 命令跑的是 `dist/bundle/cli.js`，pi 的类内联在 chunk 里，而扩展 import 到的是扩展
 * 加载器 virtualModules 给的那一份。只有真过一遍 pi 的加载器 + pi 自己的渲染组件，才能证明这两者
 * **是同一个类**。`row.test.ts` 覆盖纯逻辑与边界条件。
 *
 * 断言口径（A/B 逐行对照，比"看起来对不对"硬）：
 *   - 每行的可见宽度与补丁前**完全一致**（pi-tui 对超宽行直接抛错，多一格都不行）；
 *   - 选中行以 `userMessageBg` 的底色开头、行尾恰好收一个 `\x1b[49m`；
 *   - 按终端的真实语义走一遍 SGR：**没有任何可见字符落在底色之外**（这就是这次的 bug：
 *     pi 截断时插的裸 `\x1b[0m` 把底色清掉了）；
 *   - 非选中行逐字节不变；
 *   - 拿不到皮肤时不重绘、也不抛（会话替换窗口内的渲染 tick 不能掀翻 pi）。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 必须在 pi（以及它里面的 chalk）被 import **之前**设：chalk 在模块求值时就定死了要不要
 * 输出 ANSI，之后再设 `FORCE_COLOR` 无效（实测，见 `bash-read-render-tests-color-drift` 记忆）。
 * 不设的话 `theme.bold` 会静默返回裸文本，下面「粗体已经被去掉」的断言就成了空转 ——
 * 所以每条断言前都先用 pi 的原始输出做一次**阳性对照**。
 */
process.env.FORCE_COLOR ??= "3";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/** 长到必被缩略的标题：pi 会用 `truncateToWidth(…, "…")` 砍掉尾巴。 */
const LONG_TITLE = "修复一下 resume 列表里选中行的背景色问题，这一行很长很长很长很长很长很长很长很长很长很长很长";
const SHORT_TITLE = "短会话名字";
/** 用来看「行尾右对齐那一段」是否也有底色。 */
const MESSAGE_COUNT = 42;

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 后者是**扩展包的安装根**，`pi update --extensions` 会用
 * `--config.auto-install-peers=false` 把自动装进去的 `@earendil-works/pi-*` 同伴包剪掉，
 * 于是那份副本只剩空壳（文件都在、import 报 `ERR_MODULE_NOT_FOUND`）。
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
	commands: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	initTheme: (name?: string) => void;
	SessionSelectorComponent: new (
		currentLoader: unknown,
		allLoader: unknown,
		onSelect: (p: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options: unknown,
		currentSessionFilePath?: string,
	) => {
		render(width: number): string[];
		getSessionList(): { render(width: number): string[] };
	};
}

let pi: PiApi | undefined;
if (piEntry !== undefined) {
	pi = (await import(pathToFileURL(piEntry).href)) as PiApi;
}

/** 一个够用的 EventBus 替身（扩展加载器只用到 on / emit）。 */
function createTestBus(): unknown {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel: string, data: unknown) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-list-bg-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return {
		agentDir,
		projectDir,
		cleanup: () => {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

/** 用 pi 自己的加载器加载本扩展（`./row.ts` 的 import 也一起验证）。 */
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

/** 触达真实事件链路的那一步：`session_start` 带 ctx，扩展在这里把取色源换成活的皮肤。 */
async function fireSessionStart(extension: LoadedExtension, theme: unknown): Promise<void> {
	const handlers = extension.handlers.get("session_start") ?? [];
	assert.ok(handlers.length > 0, "本扩展必须注册 session_start（否则拿不到皮肤）");
	for (const handler of handlers) await handler({ type: "session_start" }, { ui: { theme } });
}

/** 假会话：`SessionManager.list` 的返回形状里，`SessionList.render` 真正读的那几个字段。 */
function fakeSessions(): unknown[] {
	const now = Date.now();
	return [
		{
			path: "/tmp/session-list-bg-a.jsonl",
			firstMessage: LONG_TITLE,
			messageCount: MESSAGE_COUNT,
			modified: new Date(now),
			cwd: "/Users/bachi/jaylli/litellm-any",
		},
		{
			path: "/tmp/session-list-bg-b.jsonl",
			name: SHORT_TITLE,
			firstMessage: "短标题",
			messageCount: 3,
			modified: new Date(now - 600_000),
			cwd: "/Users/bachi/jaylli/litellm-any",
		},
		{
			path: "/tmp/session-list-bg-c.jsonl",
			firstMessage: "第三个会话",
			messageCount: 7,
			modified: new Date(now - 9_000_000),
			cwd: "/Users/bachi/jaylli/litellm-any",
		},
	];
}

/**
 * new 一个 pi 自己的会话选择器并等到会话装载完成，返回**组件本体**。
 *
 * 返回值必须是组件本体而不是 `getSessionList()`：真流程里 `InteractiveMode.showSelector()`
 * 把 `SessionSelectorComponent` 整个挂进 `editorContainer`，TUI 调的是**它**的 `render()`
 * （它继承 `Container`，内部再拼 header + 列表 + 边框）—— 这也是本扩展包的就是它的原因。
 * 渲染内层列表会绕开补丁，那就不算端到端了。
 */
async function mountSessionList(): Promise<{ render(width: number): string[] }> {
	assert.ok(pi);
	const sessions = fakeSessions();
	const loader = async () => sessions;
	const selector = new pi.SessionSelectorComponent(
		loader,
		loader,
		() => {},
		() => {},
		() => {},
		() => {},
		{},
		undefined,
	);
	// 构造函数的第一次 loadScope 是异步的（await loader 之后才 setSessions）。
	await new Promise((resolve) => setTimeout(resolve, 50));
	return selector;
}

const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");
const visibleWidth = (line: string): number => [...plain(line)].length;

/**
 * pi 把当前皮肤挂在 `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` 上
 * （`theme.js` 的 `setGlobalTheme`，包根导出的 `theme` 只是个读这个键的 Proxy）。
 * 包根不导出那个 Proxy，所以测试直接读这个键 —— 拿到的**就是** pi 的会话选择器自己
 * 画选中行用的那个 `Theme` 实例：A/B 对照的底色不会因为注入了一份假皮肤而对不上。
 * `initTheme()` 负责先把键写好。
 */
const liveTheme = (): { getBgAnsi(slot: string): string; getFgAnsi(slot: string): string } => {
	const theme = (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")];
	assert.ok(theme, "initTheme() 之后必须能在 globalThis 上找到当前皮肤");
	return theme as { getBgAnsi(slot: string): string; getFgAnsi(slot: string): string };
};

/**
 * 按终端的真实语义走一遍这一行，返回**落在指定底色之外**的可见字符数。
 * `\x1b[0m` 是全属性复位 —— 它之后的字符都在默认背景上，这正是这次的 bug。
 */
function charsOutsideBg(line: string, bg: string): number {
	let outside = 0;
	let inBg = false;
	for (const token of line.match(/\u001b\[[0-9;]*m|[^\u001b]/g) ?? []) {
		if (token === bg) {
			inBg = true;
			continue;
		}
		if (token === "\u001b[0m" || token === "\u001b[49m") {
			inBg = false;
			continue;
		}
		if (token.startsWith("\u001b")) continue;
		if (!inBg) outside += 1;
	}
	return outside;
}

/** 选中行的行首底色 ANSI 用哪个槽（A/B 两条对照各用各的）。 */
function slotAnsi(slot: string): string | undefined {
	try {
		return liveTheme().getBgAnsi(slot);
	} catch {
		return undefined;
	}
}

const WIDTH = 60;

/** 原型补丁是**进程级**的，一旦装上就活到进程结束 —— 下面这些用例按顺序共用同一个补丁。 */

/* ------------------------------------------------- 搜索框提示符（用户 2026-10-28 定） */

/**
 * 列表顶部那一行就是搜索框（`SessionList.render` 第一行 push 的就是 `searchInput.render()`）。 */
const searchPromptLine = (lines: string[]): string => {
	const line = lines[0];
	assert.ok(line !== undefined, "列表至少得有一行（搜索框）");
	return line;
};

/**
 * 取出搜索框那一行：先让**外层**组件 render 一次（补丁在它的 `render` 上，得先跑过才能把
 * 提示符写到那个 `Input` 上），再单独 render 内层列表拿首行。内外都走 pi 自己的组件。
 */
const renderSearchPrompt = async (): Promise<string> => {
	const selector = await mountSessionList();
	selector.render(WIDTH);
	return searchPromptLine(selector.getSessionList().render(WIDTH));
};

/**
 * 搜索框那一行的可见宽度：先摘掉 pi-tui 的零宽 APC 序列（硬件光标 `\x1b_pi:c\x07`、
 * 伪光标 `\x1b_pi:fc\x07 … \x1b_pi:/fc\x07` —— 每个含一个空格字形，简单去色后会算重）
 * 与所有 SGR，再数字符。这一行只有 ASCII，数码点就够。
 */
const searchLineWidth = (line: string): number =>
	[...line.replace(/\u001b_pi:[^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*m/g, "")].length;

/**
 * 用户 2026-10-28：那个 `> ` 改成 `Search: `。
 *
 * **必须是本文件第一个装补丁的用例**：阳性对照（未打补丁的 pi 确实是 `> `）只能用没装过补丁的
 * 选择器拿到 —— 补丁一装上就活到进程结束。走的是真链路：pi 自己的 `SessionSelectorComponent`
 * → `SessionList` → pi-tui `Input`，不碰任何假对象。
 */
test("搜索框提示符：pi 原本是 `> `，打完补丁后变成 `Search: `（宽度仍铺满）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		pi!.initTheme("pi-coder-1337");

		// 阳性对照：扩展还什么都没装的时候，pi 的搜索框就是它自己的默认值 `> `。
		const before = await renderSearchPrompt();
		assert.equal(
			plain(before).startsWith("> "),
			true,
			`pi 原样应该以 "> " 开头（实际：${JSON.stringify(plain(before).slice(0, 12))}）`,
		);
		assert.equal(searchLineWidth(before), WIDTH, "pi 自己铺满终端宽度（对照）");

		const extension = await loadExtension(workspace);
		await fireSessionStart(extension, liveTheme());
		const after = await renderSearchPrompt();
		assert.equal(
			plain(after).startsWith("Search: "),
			true,
			`补丁后应该以 "Search: " 开头（实际：${JSON.stringify(plain(after).slice(0, 12))}）`,
		);
		// 提示符长了 6 列，补白由 pi 自己重算 ⇒ 整行仍恰好终端宽（多一格 pi-tui 就抛错）。
		assert.equal(searchLineWidth(after), WIDTH, "提示符变长后整行仍铺满终端宽度");
	} finally {
		workspace.cleanup();
	}
});

test("PI_SESSION_LIST_BG=off 时连补丁都不装", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_SESSION_LIST_BG = "off";
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.size, 0, "off 时连 session_start 都不注册");
		pi!.initTheme("pi-coder-1337");
		const list = await mountSessionList();
		const lines = list.render(WIDTH);
		const selected = lines.find((line) => line.includes("\u001b[48;"));
		assert.ok(selected, "pi 自己仍然给选中行铺底色");
	} finally {
		delete process.env.PI_SESSION_LIST_BG;
		workspace.cleanup();
	}
});

test("扩展能被 pi 的加载器加载，并注册 session_start", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		assert.equal(extension.handlers.get("session_start")?.length, 1, "注册了一个 session_start");
	} finally {
		workspace.cleanup();
	}
});

test("补丁前（还没拿到皮肤）：pi 的渲染原样，选中行仍是 selectedBg", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		await loadExtension(workspace); // 只加载，不 fire session_start ⇒ 没有皮肤
		pi!.initTheme("pi-coder-1337");
		const selectedBg = slotAnsi("selectedBg");
		assert.ok(selectedBg, "测试皮肤必须定义 selectedBg");
		const lines = (await mountSessionList()).render(WIDTH);
		const selected = lines.find((line) => line.startsWith(selectedBg));
		assert.ok(selected, "没有皮肤时不动 pi 的选中行底色");
	} finally {
		workspace.cleanup();
	}
});

test("拿到皮肤后：选中行换成 userMessageBg，且 `…` 之后也有底色", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		const theme = liveTheme(); // 别解构：`getBgAnsi` 要用 `this`
		const selectedBg = theme.getBgAnsi("selectedBg");
		const userBg = theme.getBgAnsi("userMessageBg");

		// A：补丁前的字节
		const before = (await mountSessionList()).render(WIDTH);
		const beforeSelected = before.find((line) => line.startsWith(selectedBg));
		assert.ok(beforeSelected, "补丁前选中行用的是 selectedBg");
		assert.equal(charsOutsideBg(beforeSelected, selectedBg) > 0, true, "补丁前 `…` 之后确实丢了底色（bug 证据）");

		// B：真的把皮肤交给扩展之后
		await fireSessionStart(extension, liveTheme());
		const after = (await mountSessionList()).render(WIDTH);
		const afterSelected = after.find((line) => line.startsWith(userBg));
		assert.ok(afterSelected, "选中行用的是 userMessageBg");
		assert.equal(charsOutsideBg(afterSelected, userBg), 0, "整行每一个可见字符都在底色里（含 `…` 与行尾）");
		assert.equal(afterSelected.endsWith("\u001b[49m"), true, "行尾收一个关背景");
	} finally {
		workspace.cleanup();
	}
});

/**
 * 用户 2026-10-28 的第二轮要求：皮肤里的 `selectedBg` 直接配成与 `userMessageBg` 同色。
 * 那时 `from === to`，颜色已经对了，但 pi 截断时插的裸 `\x1b[0m` 照样会清掉底色 ——
 * 这条用例把“同色皮肤下 `…` 之后仍然有底色”钉住，不让修 bug 的那半靠换色撑着。
 */
test("皮肤里两槽同色时（现在的真实配置），`…` 之后依然补回底色", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		const theme = liveTheme();
		assert.equal(
			theme.getBgAnsi("selectedBg"),
			theme.getBgAnsi("userMessageBg"),
			"这套皮肤里 selectedBg 应该与 userMessageBg 同色（用户 2026-10-28 定的皮肤改法）",
		);
		const bg = theme.getBgAnsi("userMessageBg");

		const before = (await mountSessionList()).render(WIDTH);
		const buggy = before.find((line) => line.startsWith(bg));
		assert.ok(buggy);
		assert.equal(charsOutsideBg(buggy, bg) > 0, true, "同色也照样有 bug（这跟换不换色无关）");

		await fireSessionStart(extension, theme);
		const after = (await mountSessionList()).render(WIDTH);
		const fixed = after.find((line) => line.startsWith(bg));
		assert.ok(fixed);
		assert.notEqual(fixed, buggy, "同色时也要真的重绘过");
		assert.equal(charsOutsideBg(fixed, bg), 0, "同色皮肤下 `…` 与行尾也都有底色");
		assert.equal(plain(fixed), plain(buggy), "可见字符不变");
		assert.equal(visibleWidth(fixed), visibleWidth(buggy), "宽度不变");
	} finally {
		workspace.cleanup();
	}
});

test("重绘不撑宽、不改内容：每行可见宽度与补丁前一致，非选中行逐字节不变", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		const userBg = liveTheme().getBgAnsi("userMessageBg");

		const before = (await mountSessionList()).render(WIDTH);
		await fireSessionStart(extension, liveTheme());
		const after = (await mountSessionList()).render(WIDTH);

		assert.equal(after.length, before.length, "行数不变");
		for (const [i, line] of after.entries()) {
			assert.equal(visibleWidth(line), visibleWidth(before[i] ?? ""), `第 ${i} 行可见宽度不变`);
		}
		const plainRows = (rows: string[]): string[] => rows.map(plain);
		assert.deepEqual(plainRows(after), plainRows(before), "可见字符逐字节不变");

		// 非选中行必须逐字节一致（补丁只碰选中行）
		const selectedIndexes = after.flatMap((line, i) => (line.includes(userBg) ? [i] : []));
		assert.equal(selectedIndexes.length, 1, "列表里只有一行是选中的");
		for (const [i, line] of after.entries()) {
			if (selectedIndexes.includes(i)) continue;
			assert.equal(line, before[i], `第 ${i} 行是非选中行，逐字节不变`);
		}
	} finally {
		workspace.cleanup();
	}
});

/**
 * 回归：会话被替换的那一瞬间（`/clear`、`/new`、`/resume`、`/fork`、`/reload`），pi 会让旧 ctx
 * 作废、新 ctx 还没到手 —— 这段时间里的渲染 tick 一读旧 ctx 就会抛，而这个异常从渲染回调抛出
 * 没人接得住，直接把 pi `exit(1)`（`user-message-bar` 2026-09-20 实测）。
 * 所以「拿不到皮肤」必须是这一帧不重绘，而不是把异常放出去。
 */
test("旧 ctx 已作废时渲染不抛、也不重绘（渲染 tick 落进替换窗口不能掀翻 pi）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		const stale = {
			ui: {
				get theme(): never {
					throw new Error("stale context");
				},
			},
		};
		await fireSessionStart(extension, stale);
		// 这里以前会抛 → 直达 pi 的 uncaughtException
		const lines = (await mountSessionList()).render(WIDTH);
		assert.equal(lines.length > 0, true, "列表照常渲染");
		const selected = lines.find((line) => line.includes("\u001b[48;"));
		assert.ok(selected, "读不到皮肤就保持 pi 原样");
	} finally {
		workspace.cleanup();
	}
});

test("非法槽位名退回原样（不抛、不把列表染坏）", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_SESSION_LIST_BG = "noSuchSlot";
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		await fireSessionStart(extension, liveTheme());
		const lines = (await mountSessionList()).render(WIDTH);
		const selected = lines.find((line) => line.includes("\u001b[48;"));
		assert.ok(selected, "槽位名不认识 ⇒ 这一帧不重绘");
	} finally {
		delete process.env.PI_SESSION_LIST_BG;
		workspace.cleanup();
	}
});

/* ------------------------------------------------- 正文：去粗体 + accent（用户第二轮要求） */

const BOLD_ON = "\u001b[1m";

/** 把一行按终端语义拆开：每个可见字符 + 它当时是否处在强调色里。 */
function scanLine(line: string, accent: string): Array<{ char: string; accent: boolean }> {
	const marks: Array<{ char: string; accent: boolean }> = [];
	let accentOn = false;
	for (const token of line.match(/\u001b\[[0-9;]*m|[^\u001b]+/g) ?? []) {
		if (token.startsWith("\u001b")) {
			if (token === accent) accentOn = true;
			else if (token === "\u001b[39m" || token === "\u001b[0m") accentOn = false;
			continue;
		}
		for (const char of token) marks.push({ char, accent: accentOn });
	}
	return marks;
}

/**
 * 选出行的正文区间在**可见字符坐标**里的范围：`› ` 光标之后、行尾「N 时间」之前。
 * 直接用真行的 plain 文本算，不猜位置。
 */
function bodyRange(marks: Array<{ char: string }>): { start: number; end: number; text: string } {
	const plainText = marks.map((mark) => mark.char).join("");
	const start = plainText.startsWith("\u203a ") ? 2 : 0;
	const tail = /\s+\d+ \S+\s*$/.exec(plainText);
	const end = tail ? (tail.index ?? plainText.length) : plainText.length;
	return { start, end, text: plainText.slice(start, end) };
}

/** 行尾那段（消息数 + 时间）是否仍由皮肤自己的 `dim` 着色、且不跟着正文变色。 */
function rightPartIsDim(line: string, accent: string): boolean {
	const dim = liveTheme().getFgAnsi("dim");
	const marks = scanLine(line, accent);
	const { end } = bodyRange(marks);
	const tail = marks.slice(end);
	const hasCount = tail.some((mark) => /\d/.test(mark.char));
	return hasCount && tail.every((mark) => !mark.accent) && line.includes(dim);
}

/**
 * 用户 2026-10-28：选中行的**正文**不要加粗，改成 `accent` 颜色；`11 5h` 那截不变。
 * 这里用 pi 自己渲染的真行做 A/B（不是手工拼的字符串）。
 */
test("选中行正文：pi 原本是粗体，打完补丁后没有粗体且为 accent", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		const theme = liveTheme();
		const accent = theme.getFgAnsi("accent");
		const userBg = theme.getBgAnsi("userMessageBg");

		const before = (await mountSessionList()).render(WIDTH);
		const beforeSelected = before.find((line) => line.startsWith(userBg));
		assert.ok(beforeSelected);
		// 阳性对照：不先证明「pi 原样确实有粗体」，下面的 absence 断言就是空转。
		assert.equal(beforeSelected.includes(BOLD_ON), true, "pi 自己把选中行的正文加粗了");

		await fireSessionStart(extension, theme);
		const after = (await mountSessionList()).render(WIDTH);
		const afterSelected = after.find((line) => line.startsWith(userBg));
		assert.ok(afterSelected);
		assert.equal(afterSelected.includes(BOLD_ON), false, "补丁后不再有粗体");

		// 正文每一个可见字符都要落在 accent 上（`…` 之后那截也算）。
		const marks = scanLine(afterSelected, accent);
		const { start, end, text } = bodyRange(marks);
		assert.equal(text.trim().length > 0, true, "抽得到正文");
		const bodyMarks = marks.slice(start, end).filter((mark) => mark.char.trim().length > 0);
		assert.equal(bodyMarks.length > 0, true, "正文里有可见字符");
		const outside = bodyMarks.filter((mark) => !mark.accent).length;
		assert.equal(outside, 0, `正文字符全部在 accent 里（落在外面的：${outside}）`);
		assert.equal(text.includes("…"), true, "这一行确实被缩略过（否则验不到 `…` 之后那段）");

		// 行尾那截（消息数/时间）不跟着变色。
		assert.equal(rightPartIsDim(afterSelected, accent), true, "行尾仍然是 dim、不是 accent");
		assert.equal(plain(afterSelected), plain(beforeSelected), "可见字符不变");
		assert.equal(visibleWidth(afterSelected), visibleWidth(beforeSelected), "可见宽度不变");
	} finally {
		workspace.cleanup();
	}
});

/** `PI_SESSION_LIST_TITLE=off`：只去粗体，不染色（行尾的 dim 也照旧）。 */
test("PI_SESSION_LIST_TITLE=off：只去粗体、不染色", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_SESSION_LIST_TITLE = "off";
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		const theme = liveTheme();
		const userBg = theme.getBgAnsi("userMessageBg");
		const accent = theme.getFgAnsi("accent");

		const before = (await mountSessionList()).render(WIDTH);
		const beforeSelected = before.find((line) => line.startsWith(userBg));
		assert.ok(beforeSelected?.includes(BOLD_ON), "阳性对照：pi 原样有粗体");

		await fireSessionStart(extension, theme);
		const after = (await mountSessionList()).render(WIDTH);
		const afterSelected = after.find((line) => line.startsWith(userBg));
		assert.ok(afterSelected);
		assert.equal(afterSelected.includes(BOLD_ON), false, "粗体照样去掉");

		const marks = scanLine(afterSelected, accent);
		const { start, end } = bodyRange(marks);
		const bodyMarks = marks.slice(start, end).filter((mark) => mark.char.trim().length > 0);
		assert.equal(bodyMarks.length > 0, true);
		assert.equal(bodyMarks.some((mark) => mark.accent), false, "正文没有被染成 accent");
		assert.equal(plain(afterSelected), plain(beforeSelected));
	} finally {
		delete process.env.PI_SESSION_LIST_TITLE;
		workspace.cleanup();
	}
});

/** `PI_SESSION_LIST_PROMPT=off`：保留 pi 自己的 `> `（最后一个用例，不污染前面的断言）。 */
test("PI_SESSION_LIST_PROMPT=off：搜索框仍是 pi 的 `> `", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	process.env.PI_SESSION_LIST_PROMPT = "off";
	try {
		const extension = await loadExtension(workspace);
		pi!.initTheme("pi-coder-1337");
		await fireSessionStart(extension, liveTheme());
		const line = await renderSearchPrompt();
		assert.equal(plain(line).startsWith("> "), true, "off 时不动提示符");
	} finally {
		delete process.env.PI_SESSION_LIST_PROMPT;
		workspace.cleanup();
	}
});
