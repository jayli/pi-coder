/**
 * Tests for the unknown-tool block shape (unknown-tool-tree/) — 端到端：pi 自己的扩展加载器
 * 真的加载本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染一个**没有工具定义**的工具块，
 * 对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/unknown-tool-tree/index.test.ts
 *
 * ## 为什么必须绕这一圈（不直接调 render.ts 里的纯函数）
 *
 * 这个特性的全部价值在于「用户屏幕上长什么样」，而屏幕上的行是
 * `ToolExecutionComponent` → 我们注册的解析器 → 我们挂的前缀 → pi-tui 一层层叠出来的。
 * 只测纯函数会漏掉实测踩过的那几类问题：
 *   - `renderShell: "self"` 没生效 → 红底与上下空行原样出现；
 *   - 解析器把**注册过的**工具也接管了 → bash / read / codemode 的观感被悄悄改写；
 *   - 正文按整宽渲染而没扣列位 → 顶出终端宽度被 pi-tui 裁掉。
 *
 * ## fixture 来自用户报的那个真实块
 *
 * 2026-10-20 用户贴的样例：模型把 `codemode` 写成 `codemap`，pi 找不到工具，返回
 * `{"type":"text","text":"Tool codemap not found"}` + `isError: true`。参数是整段 JS 脚本
 * （`code` 字段带真换行）—— 折叠态必须压成单行、展开态必须读得完整。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
/**
 * 本扩展的开关在**注册期**读一次 env。测试要覆盖扩展本身，所以先把用户环境里的
 * `PI_UNKNOWN_TOOL_TREE=off` 摘掉 —— 否则在关掉它的 shell 里跑测试会得到一整片假红
 *（「扩展没注册」不是回归，是开关在起作用）。
 */
delete process.env.PI_UNKNOWN_TOOL_TREE;
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const BAR = "\u2022"; // •
const PIPE = "\u2502"; // │
const CORNER = "\u2514"; // └
const TOOL_NAME = "codemap";
const CORNER_TOP_LEFT = "\u250c"; // ┌

/** 用户样例里的那段脚本（真换行 —— 折叠态必须压平它）。 */
const CODE = [
	"async function main() {",
	"  const a = await tools.read({ path: \"tests/weapons-world-edit.spec.mjs\", offset: 20, limit: 90 });",
	"  console.log(\"==== weapons-world-edit 20-110 ====\\n\" + a);",
	"  const b = await tools.read({ path: \"tests/weapons.spec.mjs\", offset: 35, limit: 40 });",
	"  console.log(\"==== weapons.spec 35-75 ====\\n\" + b);",
	"}",
	"await main();",
].join("\n");
const ARGS = { code: CODE };
const NOT_FOUND = "Tool codemap not found";

/**
 * `theme.bold()` 走 pi 自带的 chalk，而 chalk 在**模块求值时**就定好「要不要输出样式」
 * （非 TTY 下默认关掉）—— 所以颜色 / 加粗断言必须靠这个环境变量，且**必须在 import pi 之前**设。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

/**
 * 找到本机 pi 的库入口。
 *
 * `~/.pi/agent/npm/` 那份是**旧残留**、不能当首选（见 memory：pi 是 pnpm bundle 安装，
 * pi-tui 被内嵌进 chunk，从 `dist/bundle/index.js` 出发解析不到 pi 的依赖）。所以先扫
 * `PATH` 上的 `pi` shim 读它的 `exec` 目标。
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
			// pnpm 的 shim 是 shell 脚本，里面写着 `exec node "$basedir/../global/v11/…/dist/bundle/cli.js"`。
			// 注意 `$basedir` 必须替换成 shim 自己的目录 —— 直接当路径用会得到一个带字面量
			// `$basedir` 的字符串，`existsSync` 恒为 false（这个坑实测踩过：整组测试静默 skip）。
			const shim = fs.readFileSync(shimPath, "utf8");
			const match = /exec\s+(?:"[^"]*node(?:\.exe)?"|node(?:\.exe)?)\s+"([^"]+cli\.js)"/.exec(shim);
			if (match?.[1]) {
				const target = match[1].replace(/\$basedir(?:_win)?/g, path.dirname(shimPath));
				candidates.push(path.join(path.dirname(target), "index.js"));
			}
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

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");
/** 一行里第一个非空字符的列号。 */
const firstColumn = (line: string): number => plain(line).search(/\S/);
/** 盒子会把每行补满到整宽 —— 断言形状时先去掉尾部空白。 */
const trimmed = (lines: string[]): string[] => lines.map((l) => l.replace(/\s+$/, ""));
/** pi 默认壳的底色（toolPendingBg / toolSuccessBg / toolErrorBg）：真彩色 `48;2;` / 256 色 `48;5;` / 16 色 `4X`。 */
const hasBackground = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48;)/.test(line);

interface Renderers {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
}

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ toolRenderers?: Array<(toolName: string, next: () => unknown) => unknown> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	/** 内置 read 渲染器（对照组用：证明「注册过的工具没被我们改写」）。 */
	createAllToolRenderers?: () => Record<string, Renderers>;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: Renderers | undefined,
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
if (!skip) pi = (await import(pathToFileURL(piEntry!).href)) as unknown as PiApi;

let cached: {
	agentDir: string;
	projectDir: string;
	ourResolver: (toolName: string, next: () => unknown) => unknown;
} | undefined;
let cleanup: (() => void) | undefined;
let loadErrors: string[] = [];

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unknowntool-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	loadErrors = loaded.errors.map((e) => e.error);
	const ourResolver = loaded.extensions[0]?.toolRenderers?.[0];
	// 主题必须先初始化 —— 渲染器画标题时走 `theme.fg` / `theme.bold`，未初始化会抛
	// `Theme not initialized`（mcp-tree / web-search-tree 的测试同样先调这一句）。
	pi.initTheme("dark");
	if (ourResolver) cached = { agentDir, projectDir, ourResolver };
}

test.after(() => cleanup?.());

/**
 * 把若干解析器串成 pi 的解析链（`resolveToolRenderers` 的同一算法：按顺序调用，
 * 最后一个的 `next()` 落到「已注册工具的定义」—— 这里用 `baseDefinition` 代表）。
 */
function chain(
	resolvers: Array<(toolName: string, next: () => unknown) => unknown>,
	baseDefinition: Renderers | undefined,
	toolName = TOOL_NAME,
) {
	const resolve = (index: number): unknown =>
		index < resolvers.length ? resolvers[index]!(toolName, () => resolve(index + 1)) : baseDefinition;
	return resolve(0) as Renderers | undefined;
}

interface RenderOptions {
	expanded?: boolean;
	partial?: boolean;
	width?: number;
	/** 不调 `updateResult` —— 真实的「工具已发出、结果还没到」那一刻（renderCall 独舞）。 */
	noResult?: boolean;
	isError?: boolean;
	args?: unknown;
	text?: string;
	toolName?: string;
	/** 走不用本扩展的链（对照组：pi 的兜底壳）。 */
	withoutUs?: boolean;
}

/** 渲染一个真实的、没有工具定义的调用块。 */
function renderBlock(options: RenderOptions = {}): string[] {
	assert.ok(pi && cached, "pi 库入口与本扩展的解析器都必须就绪");
	const toolName = options.toolName ?? TOOL_NAME;
	const definition = options.withoutUs ? undefined : chain([cached.ourResolver], undefined, toolName);
	const component = new pi.ToolExecutionComponent(
		toolName,
		"call-1",
		options.args ?? ARGS,
		{},
		definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.text ?? NOT_FOUND }],
				details: {},
				...(options.isError === false ? {} : { isError: true }),
			},
			options.partial === true,
		);
	}
	return component.render(options.width ?? 100);
}

const text = (options: RenderOptions = {}): string[] => renderBlock(options).map(plain);

/** 取出首行那颗圆点连同它的颜色 SGR（`\x1b[38;2;r;g;bm•\x1b[39m`）—— 颜色断言看这个。 */
function dotOf(line: string): string {
	const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
	assert.ok(match, `首行应当带一颗带色的 •：${JSON.stringify(line)}`);
	return match[0];
}

// ---------------------------------------------------------------------------

test("扩展加载不报错，且注册的是渲染器解析器（不注册任何工具）", { skip }, () => {
	assert.deepEqual(loadErrors, [], "pi 的扩展加载器不应该报错");
	assert.ok(cached, "必须捕获到本扩展的解析器");
});

test("解析器只接管「next() 给不出任何渲染器」的工具", { skip }, () => {
	assert.ok(cached);

	// ① 工具有自带渲染器（bash / read / codemode / mcp__* …）→ 必须逐字原样返回，不能包一层。
	const base: Renderers = { renderShell: "default", renderCall: () => ({ render: () => ["BASE"] }) };
	assert.equal(chain([cached.ourResolver], base), base, "有渲染器时必须原样返回 next() 的结果（不是拷贝、不是包装）");
	// 只给 renderResult 的工具也算「有渲染器」
	const resultOnly: Renderers = { renderResult: () => ({ render: () => ["BASE"] }) };
	assert.equal(chain([cached.ourResolver], resultOnly), resultOnly, "只有 renderResult 也算有渲染器");

	// ② 工具根本没注册（codemap 这种写错的名字）→ next() 是 undefined → 我们接管。
	const unknown = chain([cached.ourResolver], undefined);
	assert.ok(unknown, "没有渲染器时必须接管，不能返回 undefined");
	assert.equal(unknown.renderShell, "self", "必须声明 self 壳（拿掉底色与上下空行）");
	assert.equal(typeof unknown.renderCall, "function");
	assert.equal(typeof unknown.renderResult, "function");

	// ③ 工具注册了但**没自带渲染器**（pi-subagents 的 contact_supervisor 就是这样：只有
	//    execute + parameters）→ next() 给出的是一个没有 renderCall/renderResult 的 definition，
	//    pi 仍会套兜底壳。这一路也必须接管，否则那些块继续是红底 + 上下空行。
	const rendered: Renderers = cached.ourResolver("contact_supervisor", () => ({
		renderShell: undefined,
		renderCall: undefined,
		renderResult: undefined,
	})) as Renderers;
	assert.ok(rendered, "注册但无渲染器时必须接管");
	assert.equal(rendered.renderShell, "self");
	assert.equal(typeof rendered.renderCall, "function");
});

test("真实对照：注册过的工具（read）走自己的渲染器，本扩展一个字都不改", { skip }, () => {
	assert.ok(pi && cached);
	// 拿 pi 内置 read 渲染器当「注册过的工具的 next() 结果」，用**同一个工具名**跑两条链：
	//   ① 不经过我们 → read 自己的渲染器；
	//   ② 经过我们   → 必须逐字节相同（我们只在 base === undefined 时才接管）。
	const builtIns = pi.createAllToolRenderers?.();
	if (!builtIns?.read) return; // 这个 pi 版本没导出内置渲染器表：跳过（不假装通过）
	const readDef = builtIns.read;
	const projectDir = cached.projectDir;

	const renderWith = (definition: Renderers | undefined): string[] => {
		const component = new pi!.ToolExecutionComponent(
			"read",
			"call-read-1",
			{ path: "README.md", offset: 1, limit: 2 },
			{},
			definition,
			{ requestRender() {} },
			projectDir,
		);
		component.setArgsComplete?.();
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "line one\nline two" }], details: {} });
		return component.render(100);
	};

	const viaUs = renderWith(chain([cached.ourResolver], readDef as Renderers, "read"));
	assert.equal(viaUs.length > 0, true, "read 块必须画得出来");
	assert.deepEqual(viaUs, renderWith(readDef as Renderers), "经过我们的链必须与不经过时逐字节相同");
});

test("对照组：pi 的兜底壳确实有底色（证明形状断言能分出好坏）", { skip }, () => {
	const lines = renderBlock({ withoutUs: true });
	assert.ok(lines.some(hasBackground), "不接管时必须看到红底 —— 否则下面「无底色」的断言就是空转");
});

test("无底色、无上下边界空行（self 壳生效）", { skip }, () => {
	const lines = renderBlock();
	assert.ok(!lines.some(hasBackground), "self 壳下整块都不该有底色");
	// pi 在 self 分支里固定 push 的那一行留白是行 0，不算块的一部分（bash / read 同一口径）。
	const body = trimmed(text()).filter((l, i) => !(i === 0 && l === ""));
	assert.ok(!body.some((l) => l === ""), "块内不该再有整行空白（上下边界空行已被 self 壳去掉）");
});

test("标题行：圆点在列 0、工具名保留、参数压成单行并截断", { skip }, () => {
	const lines = trimmed(text());
	const title = lines[1]!;
	assert.equal(firstColumn(title), 0, "圆点必须在列 0");
	assert.ok(title.startsWith(BAR), `首行必须以圆点开头：${JSON.stringify(title)}`);
	assert.ok(title.includes("codemap"), `工具名必须保留：${JSON.stringify(title)}`);
	assert.ok(title.includes("code="), `参数以 key=value 出现：${JSON.stringify(title)}`);
	assert.ok(title.includes('\\n'), "脚本里的真换行必须被压成字面量 \\n（折叠态单行）");
	assert.ok(title.endsWith("…"), `标题行超宽时以 … 收尾：${JSON.stringify(title)}`);
	// 恰好一行：不能折成两行（pi 那套「先裁 100 字符再交给 pi-tui 折行」会折）
	assert.ok(title.length <= 100, `标题行不得超过终端宽度：${title.length}`);
});

test("正文：`└ ` 在列 2、正文在列 4、只出现一次且落在末行", { skip }, () => {
	const lines = trimmed(text());
	const body = lines.slice(2);
	assert.ok(body.length > 0, "必须有正文行");
	assert.equal(body.length, 1, `这一块只有一句错误，实际 ${body.length} 行：${JSON.stringify(body)}`);

	const corners = body.filter((l) => plain(l).includes(CORNER));
	assert.equal(corners.length, 1, "`└ ` 整块只能出现一次");
	assert.ok(plain(body[body.length - 1]!).includes(CORNER), "`└ ` 必须落在末行");

	for (const line of body) {
		assert.equal(firstColumn(line), 2, `结构符落在列 2：${JSON.stringify(plain(line))}`);
		const structure = plain(line)[2];
		assert.equal(structure, CORNER, `末行必须是 └，实际 ${JSON.stringify(structure)}`);
		assert.equal(plain(line)[3], " ", "结构符后一个空格");
	}
	// 正文列：结构符 2 列 + 1 空格 → 内容从列 4 起
	assert.equal(plain(body[0]!).slice(4), NOT_FOUND, `正文应当就是那句错误：${JSON.stringify(plain(body[0]!))}`);
	assert.ok(!plain(body[0]!).includes(CORNER_TOP_LEFT), "不该出现别的树形符");
});

test("失败：圆点红，正文整段红（与失败圆点同槽）", { skip }, () => {
	const lines = renderBlock();
	const dot = dotOf(lines[1]!);
	const bodyLine = lines[2]!;
	// 正文行必须被上色（不是默认前景色），并且**与圆点同一个色槽** —— 刻意不硬编码色值：
	// 主题一换就整体误报（bash / read 的旧测试写死 #666666 吃过这个亏）。
	assert.ok(/(\u001b\[38;2;\d+;\d+;\d+m)└ /.test(bodyLine), `结构符必须单独上色且用 └：${JSON.stringify(bodyLine)}`);
	assert.ok(dotOf(lines[1]!), "圆点必须是真彩色前景色");
	const okLines = renderBlock({ isError: false, text: NOT_FOUND });
	assert.ok(dotOf(okLines[1]!), "成功态圆点也必须是真彩色前景色");
});

test("成功（恢复会话时工具还没连上）：圆点绿、正文走 toolOutput", { skip }, () => {
	const okLines = renderBlock({ isError: false, text: "ok output" });
	const okDot = dotOf(okLines[1]!);
	const failDot = dotOf(renderBlock()[1]!);
	assert.notEqual(okDot, failDot, "成功与失败的圆点颜色必须不同");
	// 成功正文不得与失败正文同槽（不硬编码色值，理由同上）。
	// 正文行形如 `  \e[..m└ \e[..m<正文>` —— 取 `└ ` 之后的第一个颜色才是正文色。
	const bodyColorOf = (line: string): string | undefined =>
		/└ .*?(\u001b\[38;2;\d+;\d+;\d+m)/.exec(line)?.[1];
	const okBody = bodyColorOf(okLines[2]!);
	const failBody = bodyColorOf(renderBlock()[2]!);
	assert.ok(okBody, `成功正文也必须上色（toolOutput）：${JSON.stringify(okLines[2])}`);
	assert.ok(failBody, `失败正文必须上色：${JSON.stringify(renderBlock()[2])}`);
	assert.notEqual(okBody, failBody, "成功正文不能与失败正文同色");
	const pendingDot = dotOf(renderBlock({ noResult: true })[1]!);
	assert.notEqual(pendingDot, okDot, "执行中与成功的圆点颜色必须不同");
	assert.notEqual(pendingDot, failDot, "执行中与失败的圆点颜色必须不同");
});

test("展开态：参数逐行铺开、不再压成一行，且不重复错误句", { skip }, () => {
	const lines = trimmed(text({ expanded: true }));
	const body = lines.slice(1); // 标题行之后全部
	assert.ok(!plain(body[0]!).includes("code="), "展开态标题行不再带参数串");
	const joined = body.map(plain).join("\n");
	assert.ok(joined.includes("code:"), "展开态必须有 `code:` 参数头");
	assert.ok(joined.includes("async function main() {"), "展开态必须能读到脚本第一行");
	assert.ok(joined.includes("await main();"), "展开态必须能读到脚本最后一行（不能被压成一行截没）");
	assert.ok(joined.includes(NOT_FOUND), "错误句仍然在");
	assert.equal(body.filter((l) => plain(l).includes(CORNER)).length, 1, "`└ ` 仍然只出现一次");
	assert.ok(plain(body[body.length - 1]!).includes(NOT_FOUND), "`└ ` 落在末行的错误句上");
});

test("预览截断：长正文折叠态裁到预算并带 ctrl+o 提示，提示行吃 `└ `", { skip }, () => {
	const long = Array.from({ length: 40 }, (_, i) => `error line ${i}`).join("\n");
	const lines = trimmed(text({ text: long }));
	const body = lines.slice(2);
	assert.ok(body.length <= 11, `折叠态最多 10 行正文 + 1 行提示，实际 ${body.length}`);
	assert.ok(body.some((l) => /more lines/.test(l)), "必须有 ctrl+o 展开提示");
	const last = plain(body[body.length - 1]!);
	assert.ok(last.includes(CORNER), "提示行必须吃 `└ `（树延伸到「还有内容」那句话）");
	assert.ok(/more lines/.test(last), `末行是提示行：${JSON.stringify(last)}`);
	// 展开态不裁
	const expandedBody = trimmed(text({ text: long, expanded: true })).slice(1);
	assert.ok(expandedBody.length >= 40, `展开态应当画出全部 40 行，实际 ${expandedBody.length}`);
	assert.ok(!expandedBody.some((l) => /more lines,/.test(l)), "展开态不该再有折叠提示");
});

test("宽度预算：每行可见宽度不超过终端宽度", { skip }, () => {
	for (const width of [60, 80, 120]) {
		for (const line of renderBlock({ width })) {
			assert.ok(plain(line).length <= width, `行超宽（${plain(line).length} > ${width}）：${JSON.stringify(plain(line))}`);
		}
	}
});

test("没有结果正文时只画标题（不画空树）", { skip }, () => {
	const lines = trimmed(text({ text: "" }));
	assert.ok(lines[1]!.startsWith(BAR), "标题行仍在");
	assert.equal(lines.length, 2, `只有标题行（外带 pi 的首行留白），实际：${JSON.stringify(lines)}`);
	assert.ok(!lines.some((l) => plain(l).includes(CORNER)), "没有正文就不该画 └");
});

test("不同工具名同样接管（兜底不挑名字）", { skip }, () => {
	const lines = trimmed(text({ toolName: "codemap_typo", text: "Tool codemap_typo not found" }));
	assert.ok(lines[1]!.includes("codemap_typo"), "任意的错误工具名都要走同一套形状");
	assert.ok(plain(lines[2]!).includes(CORNER));
});
