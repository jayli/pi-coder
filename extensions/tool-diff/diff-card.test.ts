/**
 * Tests for `tool-diff.ts` 的 diff 卡片形状：行首竖线（新增行绿 `▏` / 删除行红 `▏`，用户 2026-10-10 定）、
 * 无横线边框、hunk 分隔用 `⋮`（与 `+/-` 同列）、标题行前置 `•` 结局灯（用户 2026-10-28 定）——
 * 端到端：pi 自己的扩展加载器加载本扩展 → 用**真主题**渲染 renderResult / renderCall 返回的组件 →
 * 断言拼出来的行。
 *
 * Run with:  node --test clients/pi/extensions/tool-diff/diff-card.test.ts
 *
 * 为什么值得单独立一个测试文件：这是纯观感改动，坏掉的方式是**静默**的，而且每一类都很难在终端里
 * 一眼看出 ——
 *   1. **颜色**：竖线要跟同一行**行号的前景色**同槽（`toolDiffAdded` / `toolDiffRemoved`），
 *      写错槽位（比如用 `FG_CTX` 或某个写死的绿色）在深色皮肤上可能看着还行，换皮肤就穿帮；
 *   2. **宽度**：竖线占的是 `DIFF_INDENT` 的首格，`gutterWidthOf` / 折行预算必须一格不差 ——
 *      pi 的主屏渲染器发现任何一行超过终端宽度就**直接抛错**（整个 TUI 崩掉），
 *      而 `▏` 在折行续行上特别容易漏（续行走的是 `blankGutter` 那条分支）；
 *   3. **底色**：竖线自带 `FG_RESET`（只重置前景），若哪天改成 `\x1b[0m`，那一格之后的整行
 *      底色会被自己清掉 —— 而 ANSI 串上的差别肉眼看不出来；
 *   4. **列位**：`⋮` 必须落在 `+` / `-` 那一列（用户指定的对齐），差一列就是差一格空格。
 * 所以这里断言的是**渲染结果**（真 `Theme` 的转义、真 `layoutRows` 的排版），不是函数返回值。
 *
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tool-diff.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const BAR = "\u258F";
const DOT = "\u2022";
const SEPARATOR = "\u22EE";
const FG_RESET = "\x1b[39m";
/** 载入中的闪烁标记（与 `title-row.ts` 的 `BLINK_MARKER` 同一个字形） */
const BLINK = "\u25CF";

/** 与 `prompt-metadata.test.ts` 同一套反查：shim 里的 `# cmd-shim-target=` → 真实入口。 */
function findPiEntry(): string | undefined {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shim = path.join(dir, "pi");
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shim, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 不是 npm / pnpm 的 shim：跳过
		}
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** 真主题：`initTheme("dark")` + 包根下的主题模块（`theme` 单例不在包根导出里，见 startup-logo 的注释）。 */
async function loadRealTheme(piEntry: string): Promise<ThemeLike | undefined> {
	const entryDir = path.dirname(piEntry);
	const packageRoot = /[\\/]dist[\\/](bundle[\\/])?$/.test(`${entryDir}${path.sep}`)
		? path.resolve(entryDir, "..", "..")
		: path.resolve(entryDir, "..");
	const modulePath = path.join(packageRoot, "dist/modes/interactive/theme/theme.js");
	if (!fs.existsSync(modulePath)) return undefined;
	const themeModule = (await import(pathToFileURL(modulePath).href)) as {
		getThemeByName: (name: string) => ThemeLike | undefined;
	};
	return themeModule.getThemeByName("dark");
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
}

interface RenderComponent {
	render(width: number): string[];
}

interface ToolDefinitionLike {
	renderResult?: (
		result: unknown,
		options: { expanded: boolean; isPartial: boolean; cwd: string },
		theme: ThemeLike,
		context: unknown,
	) => RenderComponent;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: ToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
}

const piEntry = findPiEntry();
let pi: PiApi | undefined;
let theme: ThemeLike | undefined;
let tools: Map<string, { definition: ToolDefinitionLike }> | undefined;
let projectDir = "";
let cleanup: (() => void) | undefined;

if (piEntry) {
	pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;
	pi.initTheme("dark");
	theme = await loadRealTheme(piEntry);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-diff-card-"));
	const agentDir = path.join(root, "agent");
	projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	tools = loaded.extensions[0]?.tools;
	assert.ok(tools, "本扩展必须注册工具");
}

test.after(() => cleanup?.());

const skip = pi === undefined || theme === undefined ? (pi === undefined ? SKIP : "拿不到 pi 内置 dark 主题") : false;

/** 一份标准的 unified patch：1 ctx / 1 del / 2 add / 1 ctx。 */
const PATCH = [
	"--- a/x.ts",
	"+++ b/x.ts",
	"@@ -1,3 +1,4 @@",
	" context line",
	"-const value = 1;",
	"+const value = 2;",
	"+const extra = 'x';",
	" tail line",
].join("\n");

/** 渲染一张 diff 卡片。edit 走 `details.patch`，write 走 `state.oldContent` + `args.content`。 */
function renderCard(
	tool: string,
	input: { patch?: string; content?: string; oldContent?: string },
	width: number,
	expanded = false,
): string[] {
	assert.ok(tools && theme);
	const definition = tools.get(tool)?.definition;
	assert.equal(typeof definition?.renderResult, "function", `${tool} 必须自带 renderResult`);
	const component = definition!.renderResult!(
		{ content: [{ type: "text", text: "ok" }], details: input.patch === undefined ? undefined : { patch: input.patch } },
		{ expanded, isPartial: false, cwd: projectDir },
		theme,
		{
			args: { path: "x.ts", content: input.content },
			cwd: projectDir,
			isError: false,
			executionStarted: true,
			invalidate() {},
			// write 的 renderResult 用执行前抓到的旧内容自己算 patch（edit 的 renderResult 不读 state）
			state: input.oldContent === undefined ? undefined : { oldContent: input.oldContent, path: "x.ts" },
		},
	);
	return component.render(width);
}

/** 去掉 SGR 后的可见文本 */
function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 可见列宽：本用例的字符只有 ASCII + `▏`，都占 1 列。 */
function widthOf(line: string): number {
	return [...plain(line)].length;
}

/** 该侧的竖线片段（颜色 + 字形 + 只重置前景的收尾） */
function barCell(theme_: ThemeLike, type: "add" | "del"): string {
	return `${theme_.getFgAnsi(type === "add" ? "toolDiffAdded" : "toolDiffRemoved")}${BAR}${FG_RESET}`;
}

test("add / del 行行首是竖线：颜色 = 该侧行号前景色，整行底色仍从第 0 列铺开", { skip }, () => {
	assert.ok(theme);
	const lines = renderCard("edit", { patch: PATCH }, 60);

	const added = lines.filter((line) => plain(line).includes("+ const"));
	const removed = lines.filter((line) => plain(line).includes("- const"));
	assert.equal(added.length, 2, "patch 里有两行新增");
	assert.equal(removed.length, 1, "patch 里有一行删除");

	for (const line of added) {
		assert.ok(line.includes(barCell(theme, "add")), `新增行行首该是绿色竖线：${JSON.stringify(plain(line))}`);
		assert.ok(line.startsWith(theme.getBgAnsi("toolSuccessBg")), "底色仍从第 0 列开始（竖线坐在底色上）");
		// 竖线就在行首：底色之后紧接着就是竖线那一段（占掉原来那格缩进），再往后才是行号
		assert.ok(
			line.slice(theme.getBgAnsi("toolSuccessBg").length).startsWith(barCell(theme, "add")),
			`竖线必须紧跟在行首底色之后：${JSON.stringify(plain(line))}`,
		);
	}
	for (const line of removed) {
		assert.ok(line.includes(barCell(theme, "del")), `删除行行首该是红色竖线：${JSON.stringify(plain(line))}`);
		assert.ok(line.startsWith(theme.getBgAnsi("toolErrorBg")), "删除行底色仍从第 0 列开始");
	}
});

test("ctx 行没有竖线（行首仍是缩进空格，代码列与 add / del 对齐）", { skip }, () => {
	const lines = renderCard("edit", { patch: PATCH }, 60);
	const ctxLines = lines.filter((line) => plain(line).includes("context line") || plain(line).includes("tail line"));
	assert.equal(ctxLines.length, 2, "patch 里有两行上下文");
	for (const line of ctxLines) {
		assert.ok(!line.includes(BAR), `ctx 行不该有竖线：${JSON.stringify(plain(line))}`);
		assert.equal(plain(line).indexOf("context line") >= 0 || plain(line).indexOf("tail line") >= 0, true);
	}
	// 代码列对齐：ctx 行的正文与 add 行的正文落在同一列
	const ctxColumn = plain(ctxLines[0]!).indexOf("context line");
	const addLine = lines.find((line) => plain(line).includes("+ const value"))!;
	assert.equal(plain(addLine).indexOf("+ const value"), ctxColumn - 2, "add 行的符号与 ctx 行正文同一列（符号前还有 `▏ ` 两格）");
});

test("折行续行也带同一条竖线（续行走的是 blankGutter 分支）", { skip }, () => {
	assert.ok(theme);
	const longPatch = [
		"--- a/x.ts",
		"+++ b/x.ts",
		"@@ -1 +1,2 @@",
		"-short",
		"+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	].join("\n");
	const lines = renderCard("edit", { patch: longPatch }, 30);
	const addedRows = lines.filter((line) => line.startsWith(theme.getBgAnsi("toolSuccessBg")));
	assert.ok(addedRows.length >= 3, `长新增行该折成多行（实得 ${addedRows.length}）`);
	for (const line of addedRows) {
		assert.ok(line.includes(barCell(theme, "add")), `折行续行也要有竖线：${JSON.stringify(plain(line))}`);
	}
	// 续行不重复行号：竖线后面直接是空白行号槽
	const continuation = addedRows.slice(2);
	for (const line of continuation) assert.match(plain(line), /^\u258F\s{3,}a+/, "续行的行号槽留空");
});

/**
 * 回归（用户 2026-10-28 定）：卡片**没有任何横线** —— 上下那两条 `╌` 虚线框和满行 `┄` 分隔
 * 全部去掉；hunk / 空档的分隔改成一颗 `⋮`，落在 `+` / `-` 那一列。
 */
function multiHunkPatch(): string {
	const first = ["@@ -1,2 +1,2 @@", " a", "-old one", "+new one"];
	const second = ["@@ -80,2 +80,2 @@", " b", "-old two", "+new two"];
	return ["--- a/x.ts", "+++ b/x.ts", ...first, ...second].join("\n");
}

test("卡片没有横线：没有 `╌` 边框，也没有满行 `┄`", { skip }, () => {
	const lines = renderCard("edit", { patch: multiHunkPatch() }, 60);
	for (const glyph of ["╌", "┄"]) {
		assert.equal(
			lines.some((line) => plain(line).includes(glyph)),
			false,
			`卡片里不该再出现 ${glyph}：${JSON.stringify(lines.map(plain))}`,
		);
	}
	// 卡的每一行都是内容：6 行 diff + 1 行 `⋮`，没有任何边框行
	assert.equal(lines.length, 7, `卡片不该有边框行：${JSON.stringify(lines.map(plain))}`);
});

test("hunk / 空档分隔是一颗 `⋮`，与 `+` / `-` 同列", { skip }, () => {
	const lines = renderCard("edit", { patch: multiHunkPatch() }, 60);
	const separators = lines.filter((line) => plain(line).trim() === SEPARATOR);
	assert.equal(separators.length, 1, `两个 hunk 之间应有且只有一条分隔：${JSON.stringify(lines.map(plain))}`);

	const signColumn = plain(lines.find((line) => plain(line).includes("+ new one"))!).indexOf("+ new one");
	assert.equal(plain(separators[0]!).indexOf(SEPARATOR), signColumn, "`⋮` 必须与 `+` / `-` 落在同一列");
	// 分隔行也补满宽度，否则 pi 的主屏渲染器会因为行宽不一致把整行重新折行
	assert.equal(widthOf(separators[0]!), 60, "分隔行必须铺满整个宽度");
});

test("行号槽位置：行号与标题行的工具名错开一格", { skip }, () => {
	const lines = renderCard("edit", { patch: PATCH }, 60);
	// 首行是 ctx（无符号），取带 `+` 的那行看符号列
	const addLine = plain(lines.find((line) => plain(line).includes("+ const value"))!);
	// `DIFF_INDENT` 2 列 + 行号槽（2 列数字）+ 1 空格 ⇒ `+` / `-` 在列 5
	assert.equal(addLine.indexOf("+"), 5, `符号列应在列 5（缩进 2 + 行号 2 + 1 空格）：${JSON.stringify(addLine)}`);
	// 行号首位数字在列 3，比工具名的首字母（列 2）再右错一格；而 ctx 行同理
	const ctxLine = plain(lines[0]!);
	assert.equal(/\d/.exec(ctxLine)?.index, 3, `行号应在列 3：${JSON.stringify(ctxLine)}`);
});

test("每一行的可见宽度精确等于渲染宽度（多一格 pi 的主屏渲染器会直接抛错）", { skip }, () => {
	for (const width of [20, 30, 41, 60, 97]) {
		const lines = renderCard("edit", { patch: PATCH }, width);
		for (const line of lines) {
			assert.equal(widthOf(line), width, `宽度 ${width} 时行宽必须相等：${JSON.stringify(plain(line))}`);
		}
	}
});

test("write 走同一条渲染路径：新增 / 删除行同样带竖线", { skip }, () => {
	assert.ok(theme);
	const oldContent = ["context line", "const value = 1;", "tail line"].join("\n");
	const newContent = ["context line", "const value = 2;", "const extra = 'x';", "tail line"].join("\n");
	const lines = renderCard("write", { content: newContent, oldContent }, 60);
	assert.ok(
		lines.some((line) => line.includes(barCell(theme, "add"))),
		`write 的新增行该有绿色竖线：${JSON.stringify(lines.map(plain))}`,
	);
	assert.ok(
		lines.some((line) => line.includes(barCell(theme, "del"))),
		`write 的删除行该有红色竖线：${JSON.stringify(lines.map(plain))}`,
	);
	for (const line of lines) assert.equal(widthOf(line), 60, "write 卡片的行宽同样必须精确");
});

/**
 * 回归（用户 2026-10-26 定）：两个工具的折叠阈值**不同** —— edit 25 行、write 15 行，
 * 超出的部分一行都不画，只留卡片下方那条 `… N more diff lines (ctrl+e to expand)`。
 *
 * 这里用「每行一个新行号」的长 patch，于是卡片里的内容行数 = 折叠阈值（不多不少）：
 * 内容 N + 提示 1（卡片没有上下边框）。任何一处算错都会让 N 变成 N±1。
 */
function longPatch(lineCount: number): string {
	const body = Array.from({ length: lineCount }, (_, i) => `+line ${i + 1}`);
	return [`--- a/x.ts`, `+++ b/x.ts`, `@@ -0,0 +1,${lineCount} @@`, ...body].join("\n");
}

/** 卡片里的内容行（带行号槽 / 符号的 diff 行，不含提示行）。
 *  行号槽右对齐（两位数行号紧贴竖线，单位数带一格空白），所以竖线后不能写死空格。 */
function contentRows(lines: readonly string[]): string[] {
	return lines.filter((line) => /^\u258F\s*\d+ \+ line \d+$/.test(plain(line).trim()));
}

test("折叠阈值：edit 最多 25 行、write 最多 15 行，多出的只给一句提示", { skip }, () => {
	assert.ok(theme);
	const long = longPatch(60);

	const editLines = renderCard("edit", { patch: long }, 80);
	assert.equal(contentRows(editLines).length, 25, "edit 折叠态只画 25 行 diff");
	assert.equal(plain(editLines.at(-1)), "  … 35 more diff lines (ctrl+e to expand)", "提示行在展示区域下面，行数 = 60 − 25");

	const writeLines = renderCard("write", { content: longPatch(40).split("\n").slice(3).map((l) => l.slice(1)).join("\n"), oldContent: "" }, 80);
	assert.equal(contentRows(writeLines).length, 15, "write 折叠态只画 15 行 diff");
	assert.equal(plain(writeLines.at(-1)), "  … 25 more diff lines (ctrl+e to expand)", "write 的提示行同样在下面");
});

test("展开态不受折叠阈值限制（edit / write 都不再画提示行）", { skip }, () => {
	const long = longPatch(60);
	for (const [tool, input] of [
		["edit", { patch: long }],
		["write", { content: longPatch(60).split("\n").slice(3).map((l) => l.slice(1)).join("\n"), oldContent: "" }],
	] as const) {
		const lines = renderCard(tool, input, 80, true);
		assert.equal(contentRows(lines).length, 60, `${tool} 展开态该画全部 60 行`);
		assert.equal(lines.some((line) => plain(line).includes("more diff")), false, `${tool} 展开态不该有提示行`);
	}
});

/** 渲染错误提示（noteLine 路径）：只给一个 text 结果，`isError: true`。 */
function renderErrorNote(tool: string, text: string, width: number): string[] {
	assert.ok(tools && theme);
	const definition = tools.get(tool)?.definition;
	assert.equal(typeof definition?.renderResult, "function", `${tool} 必须自带 renderResult`);
	const component = definition!.renderResult!(
		{ content: [{ type: "text", text }] },
		{ expanded: false, isPartial: false, cwd: projectDir },
		theme,
		{ args: { path: "x.ts" }, cwd: projectDir, isError: true, executionStarted: true, invalidate() {}, state: {} },
	);
	return component.render(width);
}

/**
 * 回归（用户 2026-10-19 报）：错误提示很长、被 `Text` 折行时，续行不能顶格。
 * 缩进必须交给 `Text` 的 `paddingX`（逐行补），拼进字符串就只有第一视觉行有那几格。
 * 缩进宽度现在是 `DIFF_INDENT`（2 列）—— 提示行与行号槽同起点。
 */
test("错误提示折行时每行都有行首缩进（write / edit 同一路径）", { skip }, () => {
	const message =
		"Could not find the exact text in /very/long/path/to/the/project/file.ts. The old text must match exactly including all whitespace and newlines.";
	for (const tool of ["edit", "write"]) {
		const lines = renderErrorNote(tool, message, 40);
		assert.ok(lines.length >= 2, `${tool} 的长错误应该折行（实得 ${lines.length} 行）`);
		for (const [i, line] of lines.entries()) {
			assert.match(plain(line), /^ {2}\S/, `${tool} 第 ${i} 行应以 2 格缩进开头：${JSON.stringify(plain(line))}`);
			assert.equal(widthOf(line), 40, `${tool} 第 ${i} 行应正好 40 列`);
		}
		assert.ok(plain(lines[0]).includes("Could not find"), "首行是错误正文");
	}
});

/** 渲染标题行（renderCall 路径）。`argsComplete` / `isPartial` / `isError` 决定圆点的三态。 */
function renderTitle(
	tool: string,
	options: {
		argsComplete?: boolean;
		isPartial?: boolean;
		isError?: boolean;
		args?: Record<string, unknown>;
		state?: Record<string, unknown>;
	} = {},
	width = 80,
): string[] {
	assert.ok(tools && theme);
	const definition = tools.get(tool)?.definition as
		| ((ToolDefinitionLike & { renderCall?: unknown }) | undefined)
		| undefined;
	const renderCall = (definition as { renderCall?: (args: unknown, theme: ThemeLike, context: unknown) => RenderComponent })
		?.renderCall;
	assert.equal(typeof renderCall, "function", `${tool} 必须自带 renderCall`);
	const component = renderCall!(options.args ?? { path: "x.ts", content: "hello\n" }, theme, {
		args: options.args ?? { path: "x.ts", content: "hello\n" },
		cwd: projectDir,
		isError: options.isError ?? false,
		isPartial: options.isPartial ?? false,
		argsComplete: options.argsComplete ?? true,
		executionStarted: false,
		expanded: false,
		invalidate() {},
		state: options.state ?? {},
	});
	return component.render(width);
}

/**
 * 回归（用户 2026-10-28 第二轮定）：载入中（参数还在流 / 工具还在跑）行尾一颗闪烁的 `●`，
 * 亮灭各 500ms；参数收完就消失。亮灭两态**恒 1 列**，否则路径预算每 500ms 跳一格。
 */
test("载入中行尾有闪烁标记，参数收完就熄灯", { skip }, () => {
	assert.ok(theme);
	const lit = `${theme.getFgAnsi("dim")}${BLINK}${FG_RESET}`;

	for (const tool of ["edit", "write"]) {
		const loading = plain(renderTitle(tool, { isPartial: true, argsComplete: false, args: { path: "x.ts" } })[0] ?? "");
		assert.ok(loading.endsWith(`x.ts ${BLINK}`), `${tool} 载入中行尾应有 ●：${JSON.stringify(loading)}`);

		const done = plain(renderTitle(tool, { args: { path: "x.ts" } })[0] ?? "");
		assert.equal(done.includes(BLINK), false, `${tool} 参数收完后不该再有 ●：${JSON.stringify(done)}`);
	}

	// 标记在该亮的那一帧用的是 dim 槽（与 working-indicator 的 bash `●` 同一个）
	assert.ok((renderTitle("edit", { isPartial: true, argsComplete: false, args: { path: "x.ts" } })[0] ?? "").includes(lit));
});

/**
 * 回归（用户 2026-10-28 第二轮定）：`Write` / `Edit` 后面一定要有东西 ——
 * 路径还没解出来时用 `files` 顶位（`text` 槽，与真路径同槽），路径一到就换成真路径。
 */
test("路径未到时用 `files` 占位，路径一到就换成真路径", { skip }, () => {
	assert.ok(theme);
	const textSlot = theme.getFgAnsi("text");

	for (const tool of ["edit", "write"]) {
		// 参数刚开流：path 还是空串
		const placeholder = renderTitle(tool, { isPartial: true, argsComplete: false, args: { path: "" } })[0] ?? "";
		assert.ok(plain(placeholder).includes(" files"), `${tool} 无路径时应显示 files 占位：${JSON.stringify(plain(placeholder))}`);
		assert.ok(placeholder.includes(`${textSlot}files`), `${tool} 占位符应用 text 槽（与真路径同槽）`);

		// path 解出来了（仍载入中）：占位符被真路径替掉
		const real = plain(renderTitle(tool, { isPartial: true, argsComplete: false, args: { path: "src/a.ts" } })[0] ?? "");
		assert.ok(real.includes(" src/a.ts"), `${tool} 路径到了就该显示真路径：${JSON.stringify(real)}`);
		assert.equal(real.includes("files"), false, `${tool} 有真路径时不该再留占位符：${JSON.stringify(real)}`);
	}
});

/**
 * 回归（用户 2026-10-28 第二轮定）：闪烁 **真的在闪**（亮灭各 500ms，与 working-indicator 的
 * bash `●` 同节拍），结果一到就停表 —— 而不仅仅是一个恒定不变的 `●`。
 *
 * 用假定时器驱动：真定时器在这里只会把用例变成 flaky。`invalidate` 的调用次数就是「有没有
 * 在按节拍重绘」的测量。
 */
test("闪烁真的亮灭：500ms 一翻，结果到了就停表", { skip }, (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const state: Record<string, unknown> = {};
	let renders = 0;
	const args = { path: "x.ts" };

	const frame = (options: { isPartial?: boolean; argsComplete?: boolean }): string => {
		// 用同一个 state（对应 pi 里每行一份的 rendererState），定时器句柄才活得下去
		const definition = tools!.get("edit")!.definition as {
			renderCall: (args: unknown, theme: ThemeLike, context: unknown) => RenderComponent;
		};
		const lines = definition.renderCall(args, theme!, {
			args,
			cwd: projectDir,
			isError: false,
			isPartial: options.isPartial ?? true,
			argsComplete: options.argsComplete ?? false,
			executionStarted: false,
			expanded: false,
			invalidate: () => {
				renders += 1;
			},
			state,
		}).render(80);
		return plain(lines[0] ?? "");
	};

	assert.ok(frame({}).endsWith(BLINK), "第一帧就亮着（不留 500ms 空窗）");
	t.mock.timers.tick(500);
	assert.equal(frame({}).endsWith(BLINK), false, "500ms 后熄）；灭态位置由等宽空格撑住");
	t.mock.timers.tick(500);
	assert.ok(frame({}).endsWith(BLINK), "1000ms 后又亮");
	assert.ok(renders >= 2, "节拍应通过 invalidate 请求重绘");

	const before = renders;
	frame({ isPartial: false, argsComplete: true });
	t.mock.timers.tick(5000);
	assert.equal(renders, before, "结果到了就停表，之后不再请求重绘");
	assert.equal(frame({ isPartial: false, argsComplete: true }).includes(BLINK), false, "熄灯后不再出现标记");
});

/**
 * 回归（用户 2026-10-28 第二轮定）：闪烁不能把路径挤得左右揺 ——
 * 亮 / 灭两态等宽，所以长路径在两种帧里的截断结果必须完全一致。
 */
test("闪烁亮灭两态的标题长度一致（长路径不被挤得左右揺）", { skip }, () => {
	const longPath = "/very/long/directory/chain/that/needs/truncation/at/the/head/src/final-file.ts";
	for (const tool of ["edit", "write"]) {
		const state = {};
		const args = { path: longPath };
		const first = renderTitle(tool, { isPartial: true, argsComplete: false, args, state }, 40)[0] ?? "";
		const second = renderTitle(tool, { isPartial: true, argsComplete: false, args, state }, 40)[0] ?? "";
		assert.equal(widthOf(first), widthOf(second), `${tool} 两帧宽度应相同：${JSON.stringify(plain(first))} / ${JSON.stringify(plain(second))}`);
		assert.ok(widthOf(first) <= 40, `${tool} 标题不得超宽（pi 主屏渲染器会直接抛错）：${widthOf(first)}`);
		assert.equal(plain(first).replace(BLINK, " "), plain(second).replace(BLINK, " "), `${tool} 除标记外两帧应逐字相同`);
	}
});

/**
 * 回归（用户 2026-10-28 定）：标题行行首一颗状态圆点，**颜色**就是结局 ——
 * 结果没到（灰）/ 成功（绿）/ 失败（红）。载入中的闪烁标记只在 `isPartial` 时出现（见下一用例）。
 */
test("标题行行首是 `•`：未完成灰 / 成功绿 / 失败红", { skip }, () => {
	assert.ok(theme);
	const cases = [
		["pending", { isPartial: true, argsComplete: false }, "dim"],
		["success", {}, "toolDiffAdded"],
		["error", { isError: true }, "toolDiffRemoved"],
	] as const;

	for (const tool of ["edit", "write"]) {
		for (const [label, options, slot] of cases) {
			const line = renderTitle(tool, options)[0] ?? "";
			const expected = `${theme.getFgAnsi(slot)}${DOT}${FG_RESET}`;
			assert.ok(line.includes(expected), `${tool} ${label} 态的圆点应用 ${slot}：${JSON.stringify(plain(line))}`);
			assert.equal(plain(line).indexOf(DOT), 0, `${tool} 的圆点应顶格在列 0（与其它工具块同列）`);
			assert.ok(plain(line).includes(" x.ts"), `${tool} 标题应带路径：${JSON.stringify(plain(line))}`);
			if (label !== "pending") {
				assert.equal(plain(line).includes(BLINK), false, `${tool} 结果已到就不该再闪：${JSON.stringify(plain(line))}`);
			}
		}
	}
});

/** 标题与卡片同起点：工具名 / 符号列都靠 `DIFF_INDENT` 对齐（用户 2026-10-28 定）。 */
test("标题行与卡片内容的左边界：工具名在列 2，行号在列 3", { skip }, () => {
	const title = plain(renderTitle("edit")[0] ?? "");
	const card = renderCard("edit", { patch: PATCH }, 80);
	const bodyLine = plain(card[0] ?? "");

	assert.equal(title.indexOf("Edit"), 2, `工具名从列 2 起（圆点 + 空格）：${JSON.stringify(title)}`);
	// 行号数字（两位数）从列 3 起，故意与工具名的 `E`（列 2）错开一格
	assert.equal(/\d/.exec(bodyLine)?.index, 3, `行号的首位数字应在列 3：${JSON.stringify(bodyLine)}`);
});
