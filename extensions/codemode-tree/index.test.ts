/**
 * Tests for the codemode block shape (codemode-tree/) — 端到端：pi 自己的扩展加载器真的加载
 * 本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 codemode 块，对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/codemode-tree/index.test.ts
 *
 * 为什么必须绕这一圈（不直接调 render.ts 里的纯函数）：这个特性的全部价值在于"用户屏幕上长什么样"，
 * 而屏幕上的行是 `ToolExecutionComponent` → `renderCall` / `renderResult` → 我们挂的前缀 → pi-tui
 * 一层层叠出来的。只测纯函数会漏掉实测踩过的那几类问题：
 *   - 传给内置渲染器的 `lastComponent` 传错 → pi **静默**退回 fallback（形状全变，无报错）；
 *   - `renderShell: "self"` 没生效 → 底色 / 上下空行还在；
 *   - 委托的内置渲染器拿到的宽度没扣左边距 → 正文顶出终端宽度被 pi-tui 裁掉。
 * 所以断言对象是**渲染出来的行**，不是内部返回值。
 *
 * 断言口径（用户 2026-10-01 定）：圆点在列 0、`codemode` 与 `│` `└` 在列 2、正文在列 4；
 * `└ ` 整块只出现一次；无底色、无上下空行；圆点用**普通前景色**（不是 bash / read 那套三态）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const BAR = "\u2022"; // •
const PIPE = "\u2502"; // │
const CORNER = "\u2514"; // └

/**
 * pi 的库入口（非 CLI）：先从 `pi` 可执行文件反查真正的安装位置（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接），再退回 `~/.pi/agent/npm` 那份副本
 * —— 判定方式是**能不能真 import**，不是路径存不存在（那份副本可能是被剪掉同伴包的空壳）。
 * 全都不行就返回 undefined，整体 skip —— 不假装通过。
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

/**
 * `theme.bold()` 走 pi 自带的 chalk，而 chalk 在**模块求值时**就定好"要不要输出样式"
 * （非 TTY 下默认关掉）—— 所以颜色 / 加粗断言必须靠这个环境变量，且**必须在 import pi 之前**设。
 * 只影响本测试进程，且尊重用户已有的 NO_COLOR。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface CodemodeDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: CodemodeDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	getThemeByName?: (name: string) => unknown;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: CodemodeDefinitionLike,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		rendererState: Record<string, unknown>;
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 一行的可见宽度（fixture 里只有 ASCII；盒子会把每行补到整宽，所以断言只看前缀与正文）。 */
const widthOf = (line: string): number => plain(line).length;

/** 一行里第一个非空字符的列号。 */
const firstColumn = (line: string): number => plain(line).search(/\S/);

/**
 * 用 pi 自己的加载器加载本扩展（模块求值时做一次，测试之间复用注册好的工具定义）。
 * 顶层 await 是必须的：`test()` 回调是同步的，而加载是异步的。
 *
 * 注意加载路径**不能带 `-builtin:codemode`** —— 那个开关是设置项，管的是 CLI 的资源配置，
 * 而 `discoverAndLoadExtensions` 只加载显式给出的路径。所以这里正好可以断言一个更强的事实：
 * 即使 pi 内置也注册了 `codemode`，本扩展注册的定义**自己就是完整的**（渲染器、执行逻辑都在）。
 */
let cached: { agentDir: string; projectDir: string; definition: CodemodeDefinitionLike } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codemode-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(
		loaded.errors.map((e) => e.error),
		[],
		"pi 的扩展加载器不应该报错",
	);
	const definition = loaded.extensions[0]?.tools.get("codemode")?.definition;
	assert.ok(definition, "本扩展必须注册 codemode 工具");
	pi.initTheme("dark");
	cached = { agentDir, projectDir, definition };
}

test.after(() => cleanup?.());

/** 一段与用户样例同形的脚本（长路径必须能把行折起来 —— 折行是列位最容易跑偏的地方）。 */
const CODE = [
	'const PI_PKG = "/Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent";',
	"const cmds = [",
	'  `grep -n "can explain its own features" "${PI_PKG}/dist/modes/interactive/interactive-mode.js" | head`,',
	'  `grep -rn "escape interrupt" "${PI_PKG}/dist" | head -5`,',
	"];",
	"for (const cmd of cmds) await tools.bash({ command: cmd });",
].join("\n");

/** 40 行输出 —— 越过内置的 5 行预览预算，于是截断提示行必然出现。 */
const OUTPUT = Array.from({ length: 40 }, (_, i) => `line ${i} of output`).join("\n");

const CALLS = [
	{
		id: "call-1/1",
		name: "bash",
		args: '{"command":"grep -n \\"can explain its own features\\" \\"/Users/bachi/L…"}',
		status: "ok",
		durationMs: 158,
	},
	{
		id: "call-1/2",
		name: "bash",
		args: '{"command":"grep -rn \\"escape interrupt\\" \\"/Users/bachi/Library/pnpm/store/v…"}',
		status: "ok",
		durationMs: 382,
	},
];

/**
 * **真实的结果形态**：`execute.js` 的 `return { content: [{ text: header }, ...truncated.items] }`
 * —— header 是**独立的第一个 text block**，不是拼在输出前面的。早先的探针把它拼成一个 block，
 * 于是"剥 header"这件事看起来是必需的；按真实形态它压根不进来（只解析 `details.calls` + 非 header 的 block），
 * 所以这里必须按真实形态构造，否则测的是一个不存在的场景。
 */
const result = {
	content: [
		{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
		{ type: "text", text: OUTPUT },
	],
	details: { calls: CALLS },
};

interface RenderOptions {
	expanded?: boolean;
	partial?: boolean;
	width?: number;
	/** 不调 `updateResult` —— 真实的"脚本已发出、结果还没到"那一刻（renderCall 独舞）。 */
	noResult?: boolean;
	/** 只给了 partial 结果（流式中）——此时 `resultSeen` 已经置位、续行该换成 `│`。 */
	onlyPartial?: boolean;
	isError?: boolean;
}

/** 渲染一个真实的 codemode 块，调用顺序与 pi 的 interactive-mode 一致。 */
function renderBlock(options: RenderOptions = {}): string[] {
	assert.ok(pi && cached, "pi 库入口与扩展定义都必须就绪");
	const component = new pi.ToolExecutionComponent(
		"codemode",
		"call-1",
		{ code: CODE },
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		const payload = options.isError
			? { content: result.content, details: { calls: CALLS.slice(0, 1).map((c) => ({ ...c, status: "error" })) } }
			: result;
		component.updateResult({ ...payload, ...(options.isError ? { isError: true } : {}) }, options.partial === true);
	}
	return component.render(options.width ?? 100);
}

const text = (options: RenderOptions = {}): string[] => renderBlock(options).map(plain);

/** 盒子会把每行补满到整宽 —— 断言形状时先去掉尾部空白，读起来干净。 */
const trimmed = (lines: string[]): string[] => lines.map((l) => l.replace(/\s+$/, ""));

/**
 * 取出首行那颗圆点连同它的颜色 SGR（`\x1b[38;2;r;g;bm•\x1b[39m`）—— 颜色断言看这个。
 *
 * 刻意**不硬编码色值**（bash / read 的测试写死 `#666666`，主题一漂就整体误报，见 README）。
 * 真正要钉的是「成功态的圆点与 bash 工具成功态**逐字节相同**」这件事本身。
 */
function dotOf(line: string): string {
	const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
	assert.ok(match, `首行应当带一颗带色的 •：${JSON.stringify(line)}`);
	return match[0];
}

/** 用仓库里那份 bash 扩展渲染一次成功调用，取其圆点作对照。 */
let bashSuccessDot: string | undefined;
if (pi) {
	const bashExtensionPath = path.join(path.dirname(EXTENSION_PATH), "..", "bash-command-collapse.ts");
	const loadedBash = await pi.discoverAndLoadExtensions([bashExtensionPath], process.cwd(), process.cwd(), pi.createEventBus());
	const bashDefinition = loadedBash.extensions[0]?.tools.get("bash")?.definition as CodemodeDefinitionLike | undefined;
	if (bashDefinition) {
		const bash = new pi.ToolExecutionComponent(
			"bash",
			"bash-1",
			{ command: "echo hi" },
			{},
			bashDefinition,
			{ requestRender() {} },
			process.cwd(),
		);
		bash.setArgsComplete?.();
		bash.markExecutionStarted();
		bash.updateResult({ content: [{ type: "text", text: "hi" }], details: {} }, false);
		bashSuccessDot = dotOf(bash.render(96)[1]!);
	}
}

test("codemode 块：圆点三态 —— 执行中白、成功绿（与 bash 同色）、失败红", { skip }, () => {
	// 用户 2026-10-01 定：底色去掉之后，圆点就是唯一的结局灯。
	// 注意用 renderBlock（**未剔 ANSI** 的原始行）—— 颜色断言不能用 text()（那是已 strip 的）。
	// 执行中 → `text`（普通前景色，与 bash 的 `dim` 刻意不同）；结果还没到（renderCall 独舞）
	const pending = dotOf(renderBlock({ noResult: true })[1]!);
	// 成功 → `toolDiffAdded`。**关键断言：与 bash 工具成功态的圆点逐字节相同**
	const ok = dotOf(renderBlock()[1]!);
	// 失败 → `toolDiffRemoved`
	const failed = dotOf(renderBlock({ isError: true })[1]!);

	if (bashSuccessDot !== undefined) {
		assert.equal(ok, bashSuccessDot, "成功圆点必须与 bash 工具的成功圆点同色");
		assert.notEqual(pending, bashSuccessDot, "执行中的圆点不能与成功态同色");
	}
	assert.notEqual(ok, pending, "成功与执行中必须是两种颜色");
	assert.notEqual(ok, failed, "成功与失败必须是两种颜色");
	assert.notEqual(pending, failed, "执行中与失败必须是两种颜色");
});

test("codemode 块：结果到达后圆点从执行中切到结局色", { skip }, () => {
	// 缓存键必须带上状态：只按宽度缓存会把执行中的白点钉死到结果到达之后。
	const before = dotOf(renderBlock({ noResult: true })[1]!);
	const after = dotOf(renderBlock()[1]!);
	assert.notEqual(before, after, `结果到达后圆点必须换色（before=${JSON.stringify(before)}）`);
});

test("codemode 块：圆点列 0、正文列 2，命令行带状态圆点", { skip }, () => {
	const lines = trimmed(text());
	// 第 0 行是 pi self 模式的固定留白（`ToolExecutionComponent.render()` 里 `lines.push("")`），
	// 它不是块的一部分 —— bash / read 的测试用同一条口径，见 README「两个块共用同一套壳」。
	assert.equal(lines[0], "", "第 0 行是 pi 的固定留白");
	assert.equal(firstColumn(lines[1]!), 0, `块首行该以圆点开头：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]!.slice(0, 2), `${BAR} `, `圆点后面接一格空格：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]!.slice(2, 10), "codemode", `工具名该从列 2 开始：${JSON.stringify(lines[1])}`);
	// 代码正文也从列 2 开始（与 `codemode` 的 `c` 同列）
	const codeLine = lines.find((l) => l.includes("const PI_PKG"));
	assert.ok(codeLine, "代码正文必须出现");
	assert.equal(firstColumn(codeLine!), 2, `代码正文该在列 2：${JSON.stringify(codeLine)}`);
});

test("codemode 块：整块没有底色（三种状态底都不画）", { skip }, () => {
	// pi 的默认壳是 `Box(1, 1, bgFn)`，bgFn 按状态选 toolPendingBg / toolSuccessBg / toolErrorBg。
	// 真彩色背景的 SGR 是 `\x1b[48;2;…m`，256 色是 `\x1b[48;5;…m`，16 色是 `\x1b[4Xm`。
	const hasBackground = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48;)/.test(line);
	for (const [label, rendered] of [
		["成功", renderBlock()],
		["流式中", renderBlock({ partial: true })],
		["失败", renderBlock({ isError: true })],
	] as const) {
		assert.equal(
			rendered.some(hasBackground),
			false,
			`${label}态不该有任何底色：${JSON.stringify(rendered.filter(hasBackground).map(plain))}`,
		);
	}
});

test("codemode 块：上下没有 pi 默认壳画的边界空行", { skip }, () => {
	const lines = text();
	// 第 0 行是 pi self 模式的固定留白（所有 self 工具块都有，不是默认壳的 `Box(1,1)` paddingY），
	// 所以“无上边界空行”的断言从**第 1 行**看起 —— 与 bash / read 的测试同一口径。
	assert.equal(lines[0]!.trim(), "", "第 0 行是 pi 的固定留白");
	assert.notEqual(lines[1]!.trim(), "", "块的第 1 行就该是内容（默认壳会在上面再留一行）");
	assert.notEqual(lines[lines.length - 1]!.trim(), "", "最后一行也该是内容（默认壳会在下面留一行）");
});

test("codemode 块：结果树里 `└ ` 只出现一次，且挂在第一个嵌套调用上", { skip }, () => {
	const lines = trimmed(text());
	const corners = lines.filter((l) => l.includes(CORNER));
	assert.equal(corners.length, 1, `整块只该有一个拐角符：${JSON.stringify(corners)}`);
	assert.equal(firstColumn(corners[0]!), 2, `\`└\` 该在列 2：${JSON.stringify(corners[0])}`);
	assert.match(corners[0]!, /└ .*bash/, `\`└ \` 该挂在第一个嵌套调用行上：${JSON.stringify(corners[0])}`);
	// 第二个嵌套调用走四格缩进
	const second = lines.find((l) => l.includes("382ms"));
	assert.ok(second, "第二个嵌套调用必须出现");
	assert.equal(firstColumn(second!), 4, `第二个调用该在列 4（树已落地）：${JSON.stringify(second)}`);
});

test("codemode 块：代码续行与结果树都用 `│ ` 接上（列 2）", { skip }, () => {
	const lines = text();
	const pipes = lines.filter((l) => l.includes(PIPE));
	assert.ok(pipes.length > 0, "折行后的代码或结果分隔行必须带 `│`");
	for (const line of pipes) {
		assert.equal(firstColumn(line), 2, `\`│\` 该在列 2：${JSON.stringify(line)}`);
		assert.equal(line[2], PIPE, "列 2 必须是竖线本身");
	}
});
test("codemode 块：结果到达前用两格缩进、到达后换成 `│ `", { skip }, () => {
	const before = trimmed(text({ noResult: true }));
	// 还没出结果：续行是两格缩进，没有竖线
	const codeLine = before.find((l) => l.includes("const PI_PKG"));
	assert.ok(codeLine, "执行中的块也要显示代码");
	assert.equal(firstColumn(codeLine!), 2, `执行中续行该是两格缩进：${JSON.stringify(codeLine)}`);
	assert.equal(before.some((l) => l.includes(PIPE)), false, "还没出结果时不该有竖线");

	const after = trimmed(text());
	assert.ok(after.some((l) => l.includes(PIPE)), "结果到达后命令行续行必须接上 `│ `");
});

test("codemode 块：截断提示行挂 `│ ` 而不是吃掉 `└ `", { skip }, () => {
	const lines = trimmed(text());
	const hint = lines.find((l) => /…|\.\.\./.test(l) && /lines?/.test(l));
	assert.ok(hint, `40 行输出必须出现截断提示：${JSON.stringify(lines)}`);
	assert.equal(hint!.includes(CORNER), false, "提示行不该占拐角符");
	const cornerLine = lines.find((l) => l.includes(CORNER))!;
	const cornerIndex = lines.indexOf(cornerLine);
	assert.ok(lines.indexOf(hint!) > cornerIndex, "提示行出现在嵌套调用之后（输出的预览提示）");
});

test("codemode 块：不动 pi 的语义（工具名、描述、参数、执行逻辑都继承下来）", { skip }, () => {
	assert.ok(cached, "定义必须就绪");
	const definition = cached.definition as unknown as Record<string, unknown>;
	assert.equal(definition["name"], "codemode");
	assert.equal(definition["label"], "codemode");
	assert.equal(definition["exposure"], "model-only", "MCP 的 codemode 自动激活依赖这个（见文件头）");
	assert.equal(definition["defaultActive"], false, "codemode 默认不激活，要靠 defaultTools / MCP 激活");
	assert.equal(typeof definition["execute"], "function", "执行逻辑必须继承（不然工具根本跑不了）");
	assert.equal(typeof definition["prepareLoadout"], "function", "工具描述靠它按 callable 工具实时生成");
	assert.equal(typeof definition["parameters"], "object", "参数 schema 必须继承（MCP 靠引用相等认它）");
	assert.equal(definition["renderShell"], "self", "壳必须是 self，否则底色与边界空行又会回来");
});

test("codemode 块：展开态不挂树形前缀（要的就是原样）", { skip }, () => {
	// ctrl+o 展开后，内置渲染器给出完整代码与完整输出；前缀规则不变（圆点 + `│`/`└`），
	// 但不应出现「前缀把正文挤到折行之外」这种超宽行。
	const lines = renderBlock({ expanded: true });
	for (const line of lines) {
		assert.ok(widthOf(line) <= 100, `展开态也不该有超宽行：${JSON.stringify(plain(line))}`);
	}
});

test("codemode 块：宽度变化不会让正文超宽", { skip }, () => {
	// 子组件按 width - 4 渲染，挂上前缀后正好占满 —— 任何一个宽度下都不该超出。
	for (const width of [40, 60, 79, 100, 140]) {
		for (const line of renderBlock({ width })) {
			assert.ok(
				widthOf(line) <= width,
				`width=${width} 时出现超宽行（${widthOf(line)} 列）：${JSON.stringify(plain(line))}`,
			);
		}
	}
});
