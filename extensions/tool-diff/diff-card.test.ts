/**
 * Tests for `tool-diff.ts` 的 **diff 卡片行首竖线**（新增行绿 `▏` / 删除行红 `▏`，用户 2026-10-10 定）——
 * 端到端：pi 自己的扩展加载器加载本扩展 → 用**真主题**渲染 renderResult 返回的组件 → 断言拼出来的行。
 *
 * Run with:  node --test clients/pi/extensions/tool-diff/diff-card.test.ts
 *
 * 为什么值得单独立一个测试文件：这是纯观感改动，坏掉的方式是**静默**的，而且每一类都很难在终端里
 * 一眼看出 ——
 *   1. **颜色**：竖线要跟同一行**行号的前景色**同槽（`toolDiffAdded` / `toolDiffRemoved`），
 *      写错槽位（比如用 `FG_CTX` 或某个写死的绿色）在深色皮肤上可能看着还行，换皮肤就穿帮；
 *   2. **宽度**：竖线占的是原本就存在的那一格缩进，`DIFF_INDENT` / `gutterWidthOf` / 折行预算
 *      必须一格不差 —— pi 的主屏渲染器发现任何一行超过终端宽度就**直接抛错**（整个 TUI 崩掉），
 *      而 `▏` 在折行续行上特别容易漏（续行走的是 `blankGutter` 那条分支）；
 *   3. **底色**：竖线自带 `FG_RESET`（只重置前景），若哪天改成 `\x1b[0m`，那一格之后的整行
 *      底色会被自己清掉 —— 而 ANSI 串上的差别肉眼看不出来。
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
const FG_RESET = "\x1b[39m";

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
): string[] {
	assert.ok(tools && theme);
	const definition = tools.get(tool)?.definition;
	assert.equal(typeof definition?.renderResult, "function", `${tool} 必须自带 renderResult`);
	const component = definition!.renderResult!(
		{ content: [{ type: "text", text: "ok" }], details: input.patch === undefined ? undefined : { patch: input.patch } },
		{ expanded: false, isPartial: false, cwd: projectDir },
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

test("ctx 行没有竖线（行首仍是原来那格缩进，代码列与 add / del 对齐）", { skip }, () => {
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
	for (const line of continuation) assert.match(plain(line), /^▏\s{3,}a+/, "续行的行号槽留空");
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
 * 缩进必须交给 `Text` 的 `paddingX`（逐行补），拼进字符串就只有第一视觉行有那一格。
 */
test("错误提示折行时每行都有行首缩进（write / edit 同一路径）", { skip }, () => {
	const message =
		"Could not find the exact text in /very/long/path/to/the/project/file.ts. The old text must match exactly including all whitespace and newlines.";
	for (const tool of ["edit", "write"]) {
		const lines = renderErrorNote(tool, message, 40);
		assert.ok(lines.length >= 2, `${tool} 的长错误应该折行（实得 ${lines.length} 行）`);
		for (const [i, line] of lines.entries()) {
			assert.match(plain(line), /^ \S/, `${tool} 第 ${i} 行应以一格缩进开头：${JSON.stringify(plain(line))}`);
			assert.equal(widthOf(line), 40, `${tool} 第 ${i} 行应正好 40 列`);
		}
		assert.ok(plain(lines[0]).includes("Could not find"), "首行是错误正文");
	}
});
