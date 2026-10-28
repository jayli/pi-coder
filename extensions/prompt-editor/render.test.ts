/**
 * Tests for prompt-editor.ts — `!` bash 模式在**真编辑器**上的渲染契约。
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/render.test.ts
 *
 * pi 自己的扩展加载器真的加载 `../prompt-editor.ts`（语法、import 面、session_start 注册都在
 * 覆盖范围内），假的只有编辑器外面的一切：tui 只要 `terminal.rows` 与 `requestRender()`，
 * 主题的 `borderColor` 是恒等函数，keybindings 的 `matches` 一律 false。于是
 * 「gutter 换成 `!`、正文里输入的 `!` 不再显示、光标进不到被摘掉的那一列、点选跨过那一列、
 * 退格删掉 `!` 就退出模式」这条链能被逐行 / 逐光标列断言。纯逻辑另在 `bash-prompt.test.ts`。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompt-editor.ts",
);
/**
 * 建议请求的缓冲延时（模块级常量，必须在加载扩展前设）。
 *
 * 默认 300ms 是真的为了「让结论先上屏」；测试里只要它比断言里的轮询间隔小就行 ——
 * 给 20ms 让 `waitFor` 只需等一两轮，又仍然大于 0，能真实经过「先排定时器、再发请求」这条路径。
 */
const SUGGESTION_DELAY_MS = 20;
process.env.PI_EDITOR_SUGGEST_DELAY_MS = String(SUGGESTION_DELAY_MS);
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

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

function createTestBus(): {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
} {
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

interface EditorLike {
	setText(text: string): void;
	getText(): string;
	getCursor(): { line: number; col: number };
	handleInput(data: string): void;
	handleMouse(event: Record<string, unknown>): unknown;
	render(width: number): string[];
	setSuggestion(text: string | null): void;
	getSuggestion(): string | null;
	/** `Editor` 的公开接口：装上之后打 `/` 就会拉起真的补全列表。 */
	setAutocompleteProvider(provider: unknown): void;
	focused: boolean;
}

/** 假皮肤：`dim` 画成一层可认的 ANSI 前景色，其余槽位一律原样。 */
const DIM_START = "\x1b[2m";
const DIM_END = "\x1b[0m";
const FAKE_UI_THEME = {
	fg(slot: string, text: string): string {
		return slot === "dim" ? `${DIM_START}${text}${DIM_END}` : text;
	},
};

/**
 * 提示符 `›` 的配色断言用的假皮肤：`accent` 前景 + `bold` 各给一条可认的 SGR。
 *
 * `theme.bold()` / `theme.fg()` 在真皮肤里走 pi 自带的 chalk，而 chalk 在**模块求值时**就
 * 定好「要不要输出样式」—— 这里不碰它，直接在假皮肤里写自己能认出来的序列（要断的是
 * 「扩展把 `theme.bold` / `theme.fg("accent")` 用在了字形上」，不是 chalk 自己怎么写）。
 *
 * 序列形状与真 `Theme` 逐字同构：`fg` 在前、`bold` 在内，
 * `\x1b[38;2;…m\x1b[1m›\x1b[0m` —— 真皮肤下就是这个字节串（tmux 实机录过）。
 *
 * `warning` 故意给一条**不同**的序列：实现若退回「提示符用 warning」的旧版本，断言会当场捕获。
 */
const ACCENT_PROMPT_ANSI = "\x1b[38;2;134;171;220m";
const WARNING_ANSI = "\x1b[38;2;253;176;130m";
const BOLD_START = "\x1b[1m";
const RESET = "\x1b[0m";
const PROMPT_THEME = {
	fg(slot: string, text: string): string {
		if (slot === "accent") return `${ACCENT_PROMPT_ANSI}${text}${RESET}`;
		if (slot === "warning") return `${WARNING_ANSI}${text}${RESET}`;
		return text;
	},
	bold(text: string): string {
		return `${BOLD_START}${text}${RESET}`;
	},
};

/**
 * 补全菜单选中行的配色断言用的假皮肤：前景 `accent` + 底色 `userMessageBg`
 * （= prompt message 的底色）各给一条可认的 SGR。
 *
 * 这里刻意自己写一份、而不是拿真 `Theme`：要断的是「扩展把这两个槽用在了选中行上」，
 * 不是皮肤本身长什么样；而且真 `Theme` 要跑 `initTheme()`、拿不到就抛。
 *
 * **`selectedBg` 故意给一个完全不同的值**：实现若退回上一个版本用的那个槽，断言会当场捕获。
 */
const TEXT_ANSI = "\x1b[38;2;248;248;242m";
const ACCENT_ANSI = "\x1b[38;2;134;171;220m";
const SELECTED_BG_ANSI = "\x1b[48;2;36;36;36m";
const OTHER_BG_ANSI = "\x1b[48;2;60;83;114m";
const FG_END = "\x1b[39m";
const BG_END = "\x1b[49m";
const EDITOR_THEME = {
	// EditorTheme 的边框色（pi 传进来的那一份）
	borderColor: (text: string) => text,
	// **逐字照抄 pi 的 `getSelectListTheme()`**：选中行只有前景（没有底色，这正是本次要补的缺口），
	// 描述段是 `muted` —— 重绘前必须先剥掉它，否则它尾部的 `\x1b[39m` 会把前景洗回默认色。
	selectList: {
		selectedPrefix: (text: string) => `${ACCENT_ANSI}${text}${FG_END}`,
		selectedText: (text: string) => `${ACCENT_ANSI}${text}${FG_END}`,
		description: (text: string) => `${MUTED_START}${text}${FG_END}`,
		scrollInfo: (text: string) => `${MUTED_START}${text}${FG_END}`,
		noMatch: (text: string) => `${MUTED_START}${text}${FG_END}`,
	},
	// 扩展从 `ctx.ui.theme` 取的那一份：选中行用 `accent` + `userMessageBg`
	fg(slot: string, text: string): string {
		if (slot === "accent") return `${ACCENT_ANSI}${text}${FG_END}`;
		if (slot === "text") return `${TEXT_ANSI}${text}${FG_END}`;
		return text;
	},
	bg(slot: string, text: string): string {
		if (slot === "userMessageBg") return `${SELECTED_BG_ANSI}${text}${BG_END}`;
		if (slot === "selectedBg") return `${OTHER_BG_ANSI}${text}${BG_END}`;
		return text;
	},
};

/** 描述段 / 滚动提示的颜色（`getSelectListTheme()` 的 `muted`），用来验证重绘前先剥色。 */
const MUTED_START = "\x1b[38;2;90;90;90m";

/**
 * 已挂载的扩展 + 编辑器：`emit` 可以把任意事件丢给 pi 的 handlers（`agent_settled` 等），
 * `setText` 走真编辑器的公开接口，`complete` 是假的模型调用（记录调用参数、回预设回复）。
 */
interface Mounted {
	editor: EditorLike;
	/** 把事件派发给扩展注册的 handlers（按注册顺序 await）。 */
	emit: (type: string, event?: Record<string, unknown>) => Promise<void>;
	/**
	 * 等缓冲到期 + 假模型回包落定。建议请求现在是「`turn_end` 后延迟一小段再发」的，
	 * 所以触发事件返回只代表定时器排上了，必须再等这一下才能断言。
	 */
	settle: () => Promise<void>;
	/** 假模型回复的队列：每次 `complete` 取一个。 */
	responses: string[];
	/** 每次 `complete` 的请求快照。 */
	requests: Array<{ prompt: string; signal?: AbortSignal }>;
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-editor-"));
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

/**
 * 用 pi 自己的加载器加载扩展，再调用它注册的 session_start，抓出编辑器工厂并实例化。
 * 编辑器外面全部是假的：`paddingX: 0` 的 Editor 只需要 `tui.terminal.rows`，
 * 主题只需要一个恒等的 `borderColor`，keybindings 只需要一个永远不命中的 `matches`
 * （Editor 自己的键位走 pi-tui 的全局默认表，所以 Ctrl+A / 退格都是真按真绑定的行为）。
 */
async function mountEditor(options: { theme?: unknown; editorTheme?: unknown; keybindings?: unknown } = {}): Promise<EditorLike> {
	return (await mount(options)).editor;
}

/** 挂载扩展并拿到事件发射口（供 `agent_settled` 用例驱动）。 */
async function mount(options: { theme?: unknown; editorTheme?: unknown; keybindings?: unknown } = {}): Promise<Mounted> {
	const workspace = makeWorkspace();
	try {
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ handlers: Map<string, Handler[]> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions(
			[EXTENSION_PATH],
			workspace.projectDir,
			workspace.agentDir,
			createTestBus(),
		);
		assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
		const extension = loaded.extensions[0];
		assert.ok(extension, "扩展应该被加载");
		const sessionStart = extension.handlers.get("session_start")?.[0];
		assert.ok(sessionStart, "扩展应该注册 session_start");

		let factory: ((tui: unknown, theme: unknown, keybindings: unknown) => EditorLike) | undefined;
		const responses: string[] = [];
		const requests: Array<{ prompt: string; signal?: AbortSignal }> = [];
		const ctx = {
			hasUI: true,
			mode: "tui",
			cwd: workspace.projectDir,
			model: { provider: "fake", id: "fake-model" },
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: { role: "user", content: "给输入框加建议" } },
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "加好了，测试全过。" }],
						},
					},
				],
			},
			modelRegistry: {
				find: () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
				complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }, opts: { signal?: AbortSignal }) => {
					requests.push({ prompt: context.messages[0]!.content[0]!.text, signal: opts.signal });
					const text = responses.shift() ?? "";
					return { content: text === "" ? [] : [{ type: "text", text }] };
				},
			},
			ui: {
				theme: options.theme,
				setEditorComponent(next: typeof factory) {
					factory = next;
				},
			},
		};
		await sessionStart({}, ctx);
		assert.ok(factory, "session_start 应该注册编辑器工厂");

		const editor = (factory as (tui: unknown, theme: unknown, keybindings: unknown) => EditorLike)(
			{ terminal: { rows: 40 }, requestRender() {} },
			options.editorTheme ?? { borderColor: (text: string) => text },
			options.keybindings ?? { matches: () => false },
		);

		return {
			editor,
			responses,
			requests,
			settle: () => delay(SUGGESTION_DELAY_MS * 4),
			emit: async (type, event = {}) => {
				for (const handler of extension.handlers.get(type) ?? []) {
					await handler({ type, ...event }, ctx);
				}
			},
		};
	} finally {
		workspace.cleanup();
	}
}

/** 睡一小段（等缓冲定时器到期 / 请求链跑完）。 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 去掉 CSI 与 APC（CURSOR_MARKER）转义，剩下纯文本。 */function plainLines(lines: string[]): string[] {
	return lines.map((line) =>
		line
			.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
			.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""),
	);
}

/** Editor.handleMouse 要的完整事件形状；x / y 是组件内坐标。 */function mouseClick(x: number, y: number): Record<string, unknown> {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 40,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

test("提示符 › 用 accent 色 + 加粗（用户 2026-10-28 定）；bash 模式的 ! 不跟着变", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor({ theme: PROMPT_THEME });
	editor.setText("hello");

	const raw = editor.render(40)[1] as string;
	// 字形两边包上 accent + 粗体（两层各自的收尾 SGR 都在字形之后），
	// 然后紧跟一个**不上色**的补齐空格（gutter = 2 列）
	const glyphAt = raw.indexOf("›");
	assert.equal(
		raw.slice(0, glyphAt),
		`${ACCENT_PROMPT_ANSI}${BOLD_START}`,
		`提示符前面应该只开着 accent 前景 + 粗体：${JSON.stringify(raw.slice(0, 40))}`,
	);
	assert.equal(raw.includes(WARNING_ANSI), false, `提示符不该再用 warning 色：${JSON.stringify(raw.slice(0, 48))}`);
	assert.match(
		raw.slice(glyphAt + 1),
		/^(?:\x1b\[[0-9;]*m)+ hello/,
		`字形之后只允许收色 SGR，补齐空格不能染色：${JSON.stringify(raw.slice(0, 48))}`,
	);
	assert.equal(plainLines([raw])[0]?.startsWith("› hello"), true, "可见文本不变");

	// bash 模式的 `!` 仍走边框色（= pi 的 bashMode 色），不染 accent
	const bashEditor = await mountEditor({ theme: PROMPT_THEME });
	bashEditor.setText("!ls");
	const bashRaw = bashEditor.render(40)[1] as string;
	assert.equal(bashRaw.includes(ACCENT_PROMPT_ANSI), false, `bash 模式的 ! 不跟 accent 走：${JSON.stringify(bashRaw.slice(0, 48))}`);
	assert.equal(bashRaw.includes(BOLD_START), false, "bash 模式的 ! 也不加粗（那是边框色那一套）");
	assert.equal(plainLines([bashRaw])[0]?.startsWith("! ls"), true, "bash 模式画法不变");
});

test("没有皮肤时提示符不抛、不上色（退回边框色）", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("hello");

	const raw = editor.render(40)[1] as string;
	assert.equal(raw.includes(ACCENT_PROMPT_ANSI), false, "拿不到皮肤时不该凭空出现颜色");
	assert.equal(raw.includes(BOLD_START), false, "也不该凭空加粗");
	assert.equal(plainLines([raw])[0]?.startsWith("› hello"), true);
});

test("普通输入：gutter 是 ›，正文原样", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("hello");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("› hello"), `第一行正文应是 "› hello"：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.length, 40, "每行都要满宽（gutter + contentWidth）");
	assert.equal(lines[0]?.length, 40, "上边框也要满宽");
});

test("`!` 开头：gutter 换成 !，正文里输入的 ! 不再显示", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls -la");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("! ls -la"), `gutter 应是 "! " 且正文紧接其后：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.includes("!ls"), false, "正文里不能再出现那个 `!`");
	assert.equal(lines[1]?.length, 40, "摘掉一列后要补回满宽");
	assert.equal(lines[0]?.length, 40, "上边框不受影响");
});

test("`!!`（不进上下文）只藏第一个 !，第二个留在正文里可见", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!!ls");

	const lines = plainLines(editor.render(40));
	assert.ok(lines[1]?.startsWith("! !ls"), `第二个 "!" 要留在正文里：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]?.length, 40);
});

test("正文只剩 `!` 时按退格退出模式：gutter 自己变回 ›", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!");
	assert.ok(plainLines(editor.render(40))[1]?.startsWith("! "), "先进入 bash 模式");

	editor.handleInput("\x7f"); // backspace
	assert.equal(editor.getText(), "", "退格删掉了那个 `!`");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	assert.ok(
		plainLines(editor.render(40))[1]?.startsWith("› "),
		"退出模式后 gutter 自然回到 ›",
	);
});

test("Ctrl+A 把光标挡在隐藏的 `!` 之后：继续打字不会顶掉 bash 模式", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls");

	editor.handleInput("\x01"); // ctrl+a
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "光标不该落到被摘掉的那一列");

	editor.handleInput("c");
	assert.equal(editor.getText(), "!cls", "插入点在第 1 列之后，`!` 还在最前面");
	assert.ok(plainLines(editor.render(40))[1]?.startsWith("! cls"), "仍然是 bash 模式的画法");
});

test("普通正文的 Ctrl+A 不受影响：光标可以到第 0 列", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("ls");

	editor.handleInput("\x01"); // ctrl+a
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test("点选：正文左移一列后坐标仍然对得上（点 gutter 也会被挡回第 1 列）", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	editor.setText("!ls");
	editor.render(40); // handleMouse 依赖最近一次 render 的宽度与行数

	// 可见正文：gutter 占 x=0/1，`l` 在 x=2，`s` 在 x=3
	editor.handleMouse(mouseClick(3, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 }, "点在 `s` 上 → 光标在 `s` 之前");

	editor.handleMouse(mouseClick(2, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "点在 `l` 上 → 光标在 `l` 之前");

	editor.handleMouse(mouseClick(0, 1));
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 }, "点 gutter（隐藏列）被挡回第 1 列");
});

// ── ⑤ 空输入框占位符（用户 2026-10-19 定）──

const PLACEHOLDER_LINE = "Type your message or @file";
/** 行首缩进（用户 2026-10-19 定：两个空格）；拼在 `› ` 之后就是完整可见前缀。 */
const PLACEHOLDER_VISIBLE = `  ${PLACEHOLDER_LINE}`;

/** 取正文第一行（已剥掉 gutter 的 `› `）。 */
function bodyLine(editor: EditorLike): string {
	const plain = plainLines(editor.render(40));
	assert.ok(plain[1] !== undefined, "应该有正文首行");
	return plain[1] as string;
}

test("空输入框：正文首行显示占位符，色槽是 dim（与回合结束行同槽）", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor({ theme: FAKE_UI_THEME });

	assert.equal(editor.getText(), "", "初始状态应该是空输入框");
	const plain = bodyLine(editor);
	assert.ok(plain.startsWith(`› ${PLACEHOLDER_VISIBLE}`), `占位符应紧跟在提示符后（并缩进两格）：${JSON.stringify(plain)}`);
	assert.equal(plain.length, 40, "占位符行也要满宽");

	// 着色必须真的走 theme.fg("dim")：原始行里能找到 dim 的转义
	const raw = editor.render(40)[1] as string;
	assert.ok(raw.includes(DIM_START), `占位符应是 dim 色：${JSON.stringify(raw)}`);
});

test("敲第一个字符占位符就消失；删空后重新出现", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor({ theme: FAKE_UI_THEME });
	assert.ok(bodyLine(editor).includes(PLACEHOLDER_LINE), "初始有占位符");

	editor.handleInput("h");
	assert.equal(editor.getText(), "h");
	assert.ok(!bodyLine(editor).includes(PLACEHOLDER_LINE), "有内容后不该再画占位符");

	editor.handleInput("\x7f"); // backspace
	assert.equal(editor.getText(), "");
	assert.ok(bodyLine(editor).includes(PLACEHOLDER_LINE), "删空后占位符回来");
});

test("敲一个空格也算有内容：占位符不显示", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor({ theme: FAKE_UI_THEME });
	editor.handleInput(" ");
	assert.equal(editor.getText(), " ");
	assert.ok(!bodyLine(editor).includes(PLACEHOLDER_LINE), "空格不算空输入框");
});

test("`!` bash 模式不画占位符（占位符只属于普通空输入）", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor({ theme: FAKE_UI_THEME });
	editor.handleInput("!");
	assert.equal(editor.getText(), "!");
	assert.ok(!bodyLine(editor).includes(PLACEHOLDER_LINE), "bash 模式下没有占位符");
});

test("没拿到皮肤也能渲染：占位符退化成不着色，不抛", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor();
	const plain = bodyLine(editor);
	assert.ok(plain.includes(PLACEHOLDER_LINE), "没有 theme 时依然画占位符");
	const raw = editor.render(40)[1] as string;
	assert.equal(raw.includes(DIM_START), false, "但不应该凭空出现 dim 转义");
});

test("占位符把硬件光标留在正文第 0 列（与 pi-tui 的 Input 同口径）", { skip, timeout: 30_000 }, async () => {
	const editor = await mountEditor({ theme: FAKE_UI_THEME });
	// 假 TUI 不会自己设焦点，手动置位（真运行时由 TUI 接管）
	editor.focused = true;

	const raw = editor.render(40)[1] as string;
	const markerAt = raw.indexOf("\x1b_pi:c\x07");
	assert.ok(markerAt >= 0, "聚焦时应该有 CURSOR_MARKER");
	// gutter（`› ` = 2 列）之后就是正文第 0 列，中间只允许零宽的 dim 转义 ——
	// 两个空格的缩进是「光标之后的占位符内容」，不是把光标推右两个格
	const before = raw.slice(0, markerAt).replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "");
	assert.equal(before, "› ", "光标标记应紧跟在 gutter 之后");

	// 未聚焦时不该有标记（否则 TUI 会把硬件光标放到一个不存在的输入上）
	editor.focused = false;
	assert.equal(editor.render(40)[1]?.includes("\x1b_pi:c\x07"), false);
});

// ── ⑥ 回合结束后的「下一步建议」（用户 2026-10-20 定）──

const SUGGESTION = "跑一下 node --test 确认没回归";
/** Tab 的裸编码（pi 的 `tui.input.tab` 默认就是 `\t`；真终端在 Kitty 协议下可能发别的）。 */
const TAB = "\t";
/** 只认 `\t` 的假 keybindings：证明扩展走的是 pi 的 keybindings，而不是硬编码。 */
const TAB_KEYBINDINGS = {
	matches: (data: string, id: string) => id === "tui.input.tab" && data === TAB,
};

/**
 * 粗略的可见宽度：把 CJK / 全角字符算 2 列。测试只用它断言「建议行满宽」，
 * 不追求与 pi-tui 的 `visibleWidth` 逐码位对齐。
 */
function visibleWidthOf(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		width += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
	}
	return width;
}

/** 一轮结束（`agent_settled`）→ 等缓冲 → 等假模型回包 → 建议该画在首行。 */
async function settleWithSuggestion(text = SUGGESTION): Promise<Mounted> {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(text);
	await mounted.emit("agent_settled", { aborted: false });
	await mounted.settle();
	return mounted;
}

/** 一条「本轮结论」的 assistant 消息（`stopReason: "stop"` + 可见文本），供 `turn_end` 用例用。 */
function concludingMessage(text = "加好了，测试全过。"): Record<string, unknown> {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] };
}

/** 中间轮的 assistant 消息：带工具调用，`stopReason: "toolUse"`。 */
function toolUseMessage(): Record<string, unknown> {
	return {
		role: "assistant",
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "我先看一下文件。" },
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		],
	};
}

test("回合结束后画出建议：灰字（dim）、行首缩进两格、优先于占位符", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();
	assert.equal(mounted.requests.length, 1, "应该发一次生成请求");
	assert.equal(mounted.requests[0]!.prompt.includes("给输入框加建议"), true, "摘要要带用户请求");

	const raw = mounted.editor.render(40)[1] as string;
	assert.ok(raw.includes(DIM_START), `建议应是 dim 色：${JSON.stringify(raw)}`);
	const plain = plainLines([raw])[0] as string;
	// gutter（`› ` = 2 列）+ 建议自己的行首缩进（2 列）
	assert.ok(plain.startsWith(`›   ${SUGGESTION}`), `建议行首缩进两格：${JSON.stringify(plain)}`);
	assert.equal(plain.includes(PLACEHOLDER_LINE), false, "有建议时不该再画占位符");
	// gutter（`› ` = 2 列）+ contentWidth（38 列）= 整行 40 列；建议含中文，按可见列量
	assert.equal(visibleWidthOf(plain), 40, "建议行也要满宽");
});

test("Tab 把建议填进输入框（带上行首两格、光标落尾），不发送、不画占位符", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();
	assert.equal(mounted.editor.getText(), "", "接受前输入框必须还是空的");
	const before = plainLines(mounted.editor.render(40))[1] as string;

	mounted.editor.handleInput(TAB);

	// 用户 2026-10-20 定：填入时把行首那两格也带上，否则文字会当场往左跳两列
	assert.equal(mounted.editor.getText(), `  ${SUGGESTION}`, "Tab 应把整句（含行首两格）填进输入框");
	assert.deepEqual(
		mounted.editor.getCursor(),
		{ line: 0, col: SUGGESTION.length + 2 },
		"光标落尾（算上两格缩进）",
	);
	assert.equal(mounted.editor.getSuggestion(), SUGGESTION, "接受只是填入：建议本身留着，删空还能再露出来");

	const after = plainLines(mounted.editor.render(40))[1] as string;
	// 位置不错位的判据：建议的文字起点列在 Tab 前后一模一样（`› ` gutter + 两格缩进）
	assert.equal(
		after.indexOf(SUGGESTION),
		before.indexOf(SUGGESTION),
		`文字不能因为 Tab 而左右跳动：\n前 ${JSON.stringify(before)}\n后 ${JSON.stringify(after)}`,
	);
	assert.ok(after.startsWith(`›   ${SUGGESTION}`), "填入后文字停在建议原来的那两列之后");
	assert.equal(after.includes("Type your message or @file"), false, "有内容了不该有占位符");
});

test("Tab 填进去的句子被逐格退格删空：重新露出同一句建议，不退回默认占位符", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();

	// 真终端里按 Tab 发的是裸 `\t`，填入后用户想丢掉它，一格一格退格删到底
	mounted.editor.handleInput(TAB);
	assert.equal(mounted.editor.getText(), `  ${SUGGESTION}`, "Tab 先把整句填进去");

	const typed = `  ${SUGGESTION}`;
	for (let index = 0; index < typed.length; index++) mounted.editor.handleInput("\x7f");

	assert.equal(mounted.editor.getText(), "", "退格到底后正文为空");
	assert.equal(mounted.editor.getSuggestion(), SUGGESTION, "Tab 填入只是「拿来用用」：建议本身不该被销毁");
	const plain = plainLines(mounted.editor.render(40))[1] as string;
	assert.ok(plain.includes(SUGGESTION), `删空后应该重新露出那句建议：${JSON.stringify(plain)}`);
	assert.equal(plain.includes(PLACEHOLDER_LINE), false, "有建议时不该退回默认占位符");
});

test("Tab 没有被 keybindings 认出来时不动（交给 pi 的补全）", { skip, timeout: 30_000 }, async () => {
	// 默认假 keybindings 永远不命中
	const mounted = await mount({ theme: FAKE_UI_THEME });
	assert.ok(mounted.responses.length === 0);
	mounted.responses.push(SUGGESTION);
	await mounted.emit("agent_settled", { aborted: false });
	await mounted.settle();
	assert.notEqual(mounted.editor.getSuggestion(), null, "建议已经挂上");

	mounted.editor.handleInput(TAB);
	assert.equal(mounted.editor.getText(), "", "keybindings 没命中时 Tab 不算接受");
});

test("敲一个字符只是把建议藏起来：删空后重新露出同一句（用户 2026-10-21 定）", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();

	mounted.editor.handleInput("h");
	assert.equal(mounted.editor.getSuggestion(), SUGGESTION, "打字不清掉建议，只是渲染层藏起来");
	assert.ok(!plainLines(mounted.editor.render(40))[1]?.includes(SUGGESTION));
	assert.ok(!plainLines(mounted.editor.render(40))[1]?.includes(PLACEHOLDER_LINE), "有内容时两者都不画");

	mounted.editor.handleInput("\x7f"); // backspace
	assert.equal(mounted.editor.getText(), "");
	assert.equal(mounted.editor.getSuggestion(), SUGGESTION, "删空后建议还在");
	assert.ok(
		plainLines(mounted.editor.render(40))[1]?.includes(SUGGESTION),
		"删空后露出的应该是那句建议，而不是退回占位符",
	);
});

test("空格 + 退格（用户报的原样操作）：建议重新露出，不退回占位符", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();

	mounted.editor.handleInput(" ");
	assert.equal(mounted.editor.getText(), " ");
	assert.ok(!plainLines(mounted.editor.render(40))[1]?.includes(SUGGESTION), "空格期间建议不可见");

	mounted.editor.handleInput("\x7f"); // backspace，回到一个字都没有
	assert.equal(mounted.editor.getText(), "");
	const plain = plainLines(mounted.editor.render(40))[1] as string;
	assert.ok(plain.includes(SUGGESTION), `删光内容后建议应该回来：${JSON.stringify(plain)}`);
	assert.equal(plain.includes(PLACEHOLDER_LINE), false, "有建议时不该画默认占位符");
});

test("压缩（session_compact）后旧建议作废，退回占位符", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();
	assert.notEqual(mounted.editor.getSuggestion(), null);

	await mounted.emit("session_compact", { fromExtension: false });
	assert.equal(mounted.editor.getSuggestion(), null, "压缩后建议必须清掉（上下文已经换了一份）");
	assert.ok(
		plainLines(mounted.editor.render(40))[1]?.includes(PLACEHOLDER_LINE),
		"压缩后退回默认占位符",
	);
});

test("回车提交那一帧就丢掉建议：不会在上一条被发出去的回合里闪回来", { skip, timeout: 30_000 }, async () => {
	// 提交相关的键位要能命中；Tab 也要可用，才能验证「闪回来之后能被 Tab 接受」这个真危害
	const keybindings = {
		matches: (data: string, id: string) =>
			(id === "tui.input.tab" && data === TAB) || (id === "tui.input.submit" && data === "\r"),
	};
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings });
	mounted.responses.push(SUGGESTION);
	await mounted.emit("agent_settled", { aborted: false });
	await mounted.settle();
	assert.notEqual(mounted.editor.getSuggestion(), null, "先挂上一条建议");

	// 用户直接在建议上开始打字（建议仍在、但不可见），再回车提交：这一路不经过 Tab，
	// 所以提交那一刻建议**仍然在** —— 正好是旧实现那个抖动窗口。
	mounted.editor.setText(SUGGESTION);
	mounted.editor.handleInput("\r");

	assert.equal(mounted.editor.getText(), "", "提交后正文被清空");
	assert.equal(mounted.editor.getSuggestion(), null, "提交就是清除点：不能等 agent_start");
	assert.ok(
		!plainLines(mounted.editor.render(40))[1]?.includes(SUGGESTION),
		"刚提交上一条的输入框里不该再画出建议",
	);
});

test("编辑器已有内容时不请求建议（不抢用户正在写的东西）", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.editor.setText("already typing");
	mounted.responses.push(SUGGESTION);
	await mounted.emit("agent_settled", { aborted: false });
	await mounted.settle();
	assert.equal(mounted.requests.length, 0, "不该发请求");
	assert.equal(mounted.editor.getSuggestion(), null);
});

test("aborted 回合（用户按 ESC）不猜下一步", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(SUGGESTION);
	await mounted.emit("agent_settled", { aborted: true });
	await mounted.settle();
	assert.equal(mounted.requests.length, 0);
	assert.equal(mounted.editor.getSuggestion(), null);
});

test("建议回来之前用户已经开写：迟到结果被丢弃", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(SUGGESTION);
	const pending = mounted.emit("agent_settled", { aborted: false });
	// 请求在飞（假 complete 是同步 resolve，但 handler 的 await 链仍然分帧）→ 先输入一个字符
	mounted.editor.handleInput("x");
	await pending;
	await mounted.settle();
	assert.equal(mounted.editor.getSuggestion(), null, "用户已经开写，迟到的建议不该覆盖");
});

test("模型回空 / 只回标签：不留建议，渲染退回占位符", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion("Next:");
	assert.equal(mounted.editor.getSuggestion(), null);
	assert.ok(
		plainLines(mounted.editor.render(40))[1]?.includes(PLACEHOLDER_LINE),
		"没有可用建议时应退回占位符",
	);
});

test("新回合开跑（agent_start）立刻清掉上一轮的建议并 abort 在飞的请求", { skip, timeout: 30_000 }, async () => {
	const mounted = await settleWithSuggestion();
	assert.notEqual(mounted.editor.getSuggestion(), null);

	await mounted.emit("agent_start");
	assert.equal(mounted.editor.getSuggestion(), null, "新回合开始建议就该消失");
});

// ── ⑦ 主触发点提前到结论那条 `turn_end`（用户 2026-10-20 定）──
//
// 为什么：`agent_settled` 要等所有 `agent_end` 处理器 settle，pi-subagents 的 watchdog 审查就挂在
// 那里（实测 7~17s），挂 settled 上是两段串行。`turn_end` 是最早能拿到本轮结论的时机，watchdog
// 甚至还没起跑，于是两件事并行。settled 降为兜底（`length` 截断 / 工具 `terminate` 收尾）。

test("结论那条 turn_end 就发请求：不必等 settle，watchdog 不再挡在前面", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(SUGGESTION);

	await mounted.emit("turn_end", { message: concludingMessage() });
	await mounted.settle();

	assert.equal(mounted.requests.length, 1, "turn_end 之后就该发请求（不等 agent_settled）");
	assert.equal(mounted.editor.getSuggestion(), SUGGESTION, "建议已经画上");
	// 回合结论直接取 `turn_end` 那条消息，不依赖分支扫描
	assert.ok(mounted.requests[0]!.prompt.includes("加好了，测试全过。"), "摘要要带本轮结论");
});

test("中间轮的 turn_end（停不下来 / 带工具调用）不猜下一步", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(SUGGESTION);

	await mounted.emit("turn_end", { message: toolUseMessage() });
	await mounted.settle();
	assert.equal(mounted.requests.length, 0, "带 toolCall 的中间轮不发请求");

	// `length` 截断（pi 可能接着做恢复）同样不是结论
	await mounted.emit("turn_end", {
		message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "说到一半" }] },
	});
	await mounted.settle();
	assert.equal(mounted.requests.length, 0, "length 截断的轮次不发请求");
	assert.equal(mounted.editor.getSuggestion(), null);
});

test("turn_end 已发过请求：随后的 agent_settled 不再重复发（不白花一次请求）", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(SUGGESTION, "第二次不该被取用");

	await mounted.emit("turn_end", { message: concludingMessage() });
	await mounted.emit("agent_settled", { aborted: false });
	await mounted.settle();

	assert.equal(mounted.requests.length, 1, "两个触发点共用去重位，只发一次");
	assert.equal(mounted.editor.getSuggestion(), SUGGESTION, "画的是第一次那个建议");
});

test("turn_end 门槛没盖住的回合（length 截断）：settle 时兜底补一次", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push("补一次的建议");

	await mounted.emit("turn_end", {
		message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "说到一半" }] },
	});
	await mounted.emit("agent_settled", { aborted: false });
	await mounted.settle();

	assert.equal(mounted.requests.length, 1, "settled 兜底发一次");
	assert.equal(mounted.editor.getSuggestion(), "补一次的建议");
});

test("缓冲期内用户开写 / 新回合开跑：请求根本不发", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push(SUGGESTION);

	// 缓冲期里用户先敲了一个字（编辑器不再是空的）
	await mounted.emit("turn_end", { message: concludingMessage() });
	mounted.editor.handleInput("x");
	await mounted.settle();
	assert.equal(mounted.requests.length, 0, "用户已经在写，缓冲期的请求作废");

	// 另一条：缓冲期里新回合开始（排队续跑 / steering）
	mounted.editor.setText("");
	await mounted.emit("turn_end", { message: concludingMessage() });
	await mounted.emit("agent_start");
	await mounted.settle();
	assert.equal(mounted.requests.length, 0, "新回合开始后，上一轮的缓冲请求不再发出");
});

test("同一 run 内续跑（turn_start）：上一条建议作废，新结论重新猜", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: FAKE_UI_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.responses.push("旧建议", "给续跑后的新建议");

	await mounted.emit("turn_end", { message: concludingMessage() });
	await mounted.settle();
	assert.equal(mounted.editor.getSuggestion(), "旧建议");

	// watchdog 认可了问题 / `/goal` 验证不通过 → 同一个 run 里再起一轮（不会重发 agent_start）
	await mounted.emit("turn_start");
	assert.equal(mounted.editor.getSuggestion(), null, "续跑时上的旧建议必须清掉");

	await mounted.emit("turn_end", { message: concludingMessage("按审查意见补上了。") });
	await mounted.settle();
	assert.equal(mounted.requests.length, 2, "续跑后的新结论要重新请求一次");
	assert.equal(mounted.editor.getSuggestion(), "给续跑后的新建议");
});

// ── ⑧ 补全菜单选中行铺底色（用户 2026-10-28 定）──
//
// 背景：pi 的 `getSelectListTheme()` 把选中行写成 `theme.fg("accent", t)`，整个 select-list
// 路径上 `theme.bg(…)` 一次都没有 —— 满屏命令里只有字色差一点、光标停在哪一行很难一眼看出。
// 这里在渲染层把它重绘成 `accent` 前景 + `selectedBg` 底色。
//
// 走真链路：给真 `Editor` 装一个只答命令补全的 provider（`pi-tui` 在仓库目录解析不到，
// 装不了真的 `CombinedAutocompleteProvider`），然后打 `/` 让它自己拉起**真的** `SelectList` ——
// 行的来源（`→ ` 前缀、描述列、补白）全部由 pi-tui 自己产生，断的只是扩展在输出层做了什么。

/** 只答两个命令的假 provider：真 `Editor` 拿它建真 `SelectList`，`/` 一到就有列表。 */
const SLASH_COMMANDS = [
	{ name: "skill:commit", description: "Commit current changes" },
	{ name: "compact", description: "Compact the conversation" },
];
const SLASH_PROVIDER = {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: Array<{ value: string; label: string; description?: string }>; prefix: string } | null> {
		const text = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
		if (!text.startsWith("/") || text.includes(" ")) return null;
		const query = text.slice(1).toLowerCase();
		const items = SLASH_COMMANDS.filter((command) => command.name.toLowerCase().includes(query)).map(
			(command) => ({ value: command.name, label: command.name, description: command.description }),
		);
		return items.length === 0 ? null : { items, prefix: text };
	},
	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: { value: string }, prefix: string) {
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		return {
			lines: lines.map((value, index) => (index === cursorLine ? `${before}/${item.value} ` : value)),
			cursorLine,
			cursorCol: before.length + item.value.length + 2,
		};
	},
};

/** 打一个 `/` 并等补全列表真的建起来（请求是 async 的，得让出几个 tick）。 */
async function openSlashMenu(editor: EditorLike): Promise<void> {
	editor.setText("");
	editor.handleInput("/");
	for (let attempt = 0; attempt < 20; attempt++) {
		await delay(5);
		if (plainLines(editor.render(40)).some((line) => line.includes("skill:commit"))) return;
	}
	assert.fail("补全列表没出来");
}

/** 这一帧里选中行 / 未选中行的原始行（带上全部 SGR）。 */
function menuRows(lines: string[]): { selected: string; unselected: string } {
	const selected = lines.find((line) => plainLines([line])[0]?.includes("→ skill:commit"));
	const unselected = lines.find((line) => plainLines([line])[0]?.includes("  compact"));
	assert.ok(selected, "应该有选中行（第一项是 skill:commit）");
	assert.ok(unselected, "应该有未选中行（compact）");
	return { selected, unselected };
}

test("补全菜单选中行：accent 前景 + prompt message 底色（userMessageBg），未选中行不上色", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: EDITOR_THEME, editorTheme: EDITOR_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.editor.setAutocompleteProvider(SLASH_PROVIDER);
	await openSlashMenu(mounted.editor);

	const lines = mounted.editor.render(40);
	const { selected, unselected } = menuRows(lines);
	assert.ok(
		selected.includes(SELECTED_BG_ANSI),
		`选中行底色应是 userMessageBg（prompt message 的底色）：${JSON.stringify(selected)}`,
	);
	assert.equal(
		selected.includes(OTHER_BG_ANSI),
		false,
		`选中行不该用 selectedBg（用户改成了 prompt message 的底色）：${JSON.stringify(selected)}`,
	);
	assert.ok(selected.includes(ACCENT_ANSI), `选中行前景应是 accent：${JSON.stringify(selected)}`);

	// pi 自己给的选中行本来就只有前景、而且描述段带着 muted 色。重绘前必须先剥掉，
	// 否则那一段的 `\x1b[39m` 会把前景洗回默认色 —— 所以这里断「整行只有一种前景色」。
	const foregrounds = selected.match(/\x1b\[38;2;[0-9;]+m/g) ?? [];
	assert.deepEqual(foregrounds, [ACCENT_ANSI], `整行只能有一种前景色：${JSON.stringify(selected)}`);

	// 未选中行：一字未动（没有底色、也没有被改色）
	assert.equal(unselected.includes(SELECTED_BG_ANSI), false, `未选中行不该铺底色：${JSON.stringify(unselected)}`);
	assert.equal(unselected.includes(ACCENT_ANSI), false, `未选中行不该被重绘：${JSON.stringify(unselected)}`);

	// 宽度只增不减（见下一条用例），但绝不能窄
	const plainSelected = plainLines([selected])[0] as string;
	assert.ok(
		visibleWidthOf(plainSelected) >= visibleWidthOf(plainLines([unselected])[0] as string),
		"重绘后不比未选中行窄",
	);
});

test("选中条要从头到尾：行首 gutter 到终端右边界整条都包在底色里（用户 2026-10-28 定）", { skip, timeout: 30_000 }, async () => {
	const mounted = await mount({ theme: EDITOR_THEME, editorTheme: EDITOR_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.editor.setAutocompleteProvider(SLASH_PROVIDER);
	await openSlashMenu(mounted.editor);

	const { selected } = menuRows(mounted.editor.render(40));

	// ① 开头的 SGR 必须在任何可见字符之前（行首那格 gutter 空白也在底色里）
	assert.equal(
		selected.startsWith(`${ACCENT_ANSI}${SELECTED_BG_ANSI}`),
		true,
		`底色要从行首第一格就开着：${JSON.stringify(selected.slice(0, 40))}`,
	);
	// ② 并一路开到行尾：整行只有末尾那一对关色 SGR，之后没有任何可见字符（补白必须在里面）
	assert.equal(selected.split(BG_END).length, 2, "中途不掉色");
	assert.equal(
		selected.endsWith(`${BG_END}${FG_END}`),
		true,
		`关色的 SGR 必须在整行（含补白）之后：${JSON.stringify(selected.slice(-24))}`,
	);

	// ③ 整行铺到终端宽。pi 自己只铺到 `gutter - shift + contentWidth`（默认 39 列，比终端窄一列），
	// 选中行由扩展补齐到 `width` —— 这就是「从头到尾」与「只包住文字」的差别。
	const { unselected: other } = menuRows(mounted.editor.render(40));
	const selectedWidth = visibleWidthOf(plainLines([selected])[0] as string);
	const unselectedWidth = visibleWidthOf(plainLines([other])[0] as string);
	assert.equal(selectedWidth, 40, `选中条正好铺满 40 列（实际 ${selectedWidth}）`);
	assert.equal(selectedWidth > unselectedWidth, true, "选中行要比未选中行宽（多铺的那几列也带底色）");

	// ④ 未选中行不受影响：宽度还是 pi 自己铺的那一列数，且没有底色
	assert.equal(unselectedWidth, 39, "未选中行仍是 pi 自己的宽度（不替它补宽）");
	assert.equal(other.includes(SELECTED_BG_ANSI), false);
});

test("没有皮肤时不抛、也不铺底色（只保留 pi 自己的 accent）", { skip, timeout: 30_000 }, async () => {
	// 只给 EditorTheme，不给 ctx.ui.theme：`paintSelectedRow` 走 undefined 退化分支
	const mounted = await mount({ editorTheme: EDITOR_THEME, keybindings: TAB_KEYBINDINGS });
	mounted.editor.setAutocompleteProvider(SLASH_PROVIDER);
	await openSlashMenu(mounted.editor);

	const { selected } = menuRows(mounted.editor.render(40));
	assert.equal(selected.includes(SELECTED_BG_ANSI), false, "拿不到皮肤时不上底色");
});

test("皮肤里没有 userMessageBg 槽：退回纯 accent 前景，不留半成品", { skip, timeout: 30_000 }, async () => {
	const noUserBg = {
		borderColor: (text: string) => text,
		selectList: (EDITOR_THEME as { selectList: unknown }).selectList,
		fg(slot: string, text: string): string {
			return slot === "accent" ? `${ACCENT_ANSI}${text}${FG_END}` : text;
		},
		bg(): string {
			throw new Error("Unknown theme color: userMessageBg");
		},
	};
	const mounted = await mount({ theme: noUserBg, editorTheme: noUserBg, keybindings: TAB_KEYBINDINGS });
	mounted.editor.setAutocompleteProvider(SLASH_PROVIDER);
	await openSlashMenu(mounted.editor);

	const { selected } = menuRows(mounted.editor.render(40));
	assert.equal(selected.includes(SELECTED_BG_ANSI), false, "没有底色槽就不铺底色");
	assert.ok(selected.includes(ACCENT_ANSI), "但前景仍是 accent（pi 原来的样子）");
});
