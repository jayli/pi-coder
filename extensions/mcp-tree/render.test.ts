/**
 * Tests for the MCP block shape (mcp-tree/) — 纯逻辑层：树前缀几何、`└ ` 落点、圆点三态、
 * 失败判定、尾空行裁剪。不 import pi，`node --test` 直跑。
 *
 * Run with:  node --test clients/pi/extensions/mcp-tree/render.test.ts
 *
 * 端到端那半边（pi 真加载器 + 真 `ToolExecutionComponent` + 内置 MCP 渲染器对照）在
 * `index.test.ts`；两边都需要的「列位」常量只在这里定义一次并由 index.test.ts import。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BODY_INDENT,
	CONTENT_OFFSET,
	GUTTER_LEAD,
	GUTTER_WIDTH,
	MARGIN_WIDTH,
	PREVIEW_MAX_LINES,
	colorizeErrorLines,
	contentWidth,
	isBlankLine,
	isFailureResult,
	shapeResultLines,
	stateDotSlot,
	trimLeadingBlanks,
	trimTrailingBlanks,
	withCallGutter,
} from "./render.ts";

/** 剥掉 SGR，只留可见文本。 */
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
/** 一行里第一个非空字符的列号。 */
const firstColumn = (line: string): number => plain(line).search(/\S/);

/** 假的 theme：`fg(slot, text)` 包一层可断言的 SGR，`getFgAnsi` 给色值。 */
const theme = {
	fg: (slot: string, text: string) => `\u001b[38;2;1;2;3m${text}\u001b[39m`,
	getFgAnsi: (slot: string) => `\u001b[38;2;1;2;3m`,
};

// ---------------------------------------------------------------------------
// 列位常量：全仓统一的那张表（圆点列 0、结构符列 2、正文列 4）
// ---------------------------------------------------------------------------

test("列位常量：圆点列 0、结构符列 2、正文列 4", () => {
	assert.equal(MARGIN_WIDTH, 2, "`• ` 占 2 列");
	assert.equal(GUTTER_WIDTH, 2, "`│ ` / `└ ` 占 2 列");
	assert.equal(CONTENT_OFFSET, 4, "正文整体相对行首偏移 4 列");
	assert.equal(GUTTER_LEAD.length, 2, "结构符前面的留白是 2 格 —— `│` 因此落在列 2");
	assert.equal(BODY_INDENT.length, 4, "正文列 4");
});

test("contentWidth 扣掉左边距 + 结构符，且有下限 1", () => {
	assert.equal(contentWidth(100), 96);
	assert.equal(contentWidth(4), 1, "极窄终端也不能给 0 或负数");
	assert.equal(contentWidth(1), 1);
});

test("PREVIEW_MAX_LINES 与内置 MCP 渲染器同值（5）", () => {
	// 用户 2026-10-16 选「跟内置 MCP 一致」而不是 memory 的 10。
	assert.equal(PREVIEW_MAX_LINES, 5);
});

// ---------------------------------------------------------------------------
// 空行判定 / 尾空行裁剪
// ---------------------------------------------------------------------------

test("isBlankLine 剔掉 ANSI 后再判空", () => {
	assert.equal(isBlankLine(""), true);
	assert.equal(isBlankLine("   "), true);
	assert.equal(isBlankLine("\u001b[38;2;1;2;3m\u001b[39m"), true, "只有颜色序列也算空行");
	assert.equal(isBlankLine("  }  "), false);
});

test("trimTrailingBlanks 只裁尾部空行，中间空行保留", () => {
	assert.deepEqual(trimTrailingBlanks(["a", "", "b", "", "  ", ""]), ["a", "", "b"]);
	// 中间的空行是内容结构的一部分（JSON 缩进块的闭合行之间就有），不能删。
	assert.deepEqual(trimTrailingBlanks(["a", "", "", "b"]), ["a", "", "", "b"]);
	assert.deepEqual(trimTrailingBlanks(["", "", ""]), []);
	assert.deepEqual(trimTrailingBlanks([]), []);
	assert.deepEqual(trimTrailingBlanks(["a", "b"]), ["a", "b"], "没有尾空行时原样返回（同一个数组引用也可以）");
});

test("trimLeadingBlanks 只裁开头空行（内置渲染器的前置 Spacer 会变成悬空 `│`）", () => {
	assert.deepEqual(trimLeadingBlanks(["", "a", "b"]), ["a", "b"]);
	assert.deepEqual(trimLeadingBlanks(["", "", "a"]), ["a"]);
	// 中间的空行是正文结构（JSON 分段），不能删。
	assert.deepEqual(trimLeadingBlanks(["a", "", "b"]), ["a", "", "b"]);
	assert.deepEqual(trimLeadingBlanks(["", "", ""]), []);
	assert.deepEqual(trimLeadingBlanks([]), []);
});

test("两个 trim 配合：内置渲染器的头尾空行都去掉、中间结构保留", () => {
	// 内置 renderResult 的真实产出：前置 Spacer(1) + 正文 + 尾部空行。
	const raw = ["", "{", '  "results": [', "  ]", "}", "", "  "];
	const out = trimTrailingBlanks(trimLeadingBlanks(raw));
	assert.deepEqual(out, ["{", '  "results": [', "  ]", "}"]);
});

// ---------------------------------------------------------------------------
// 圆点三态 + 失败判定
// ---------------------------------------------------------------------------

test("stateDotSlot：执行中灰、成功绿、失败红", () => {
	assert.equal(stateDotSlot(true, false), "dim", "执行中");
	assert.equal(stateDotSlot(true, true), "dim", "执行中即便 isError 也还是灰（结果没到）");
	assert.equal(stateDotSlot(false, false), "toolDiffAdded", "成功 —— 与 bash 成功圆点同槽");
	assert.equal(stateDotSlot(false, true), "toolDiffRemoved", "失败");
});

test("isFailureResult：三个信号取或（MCP 有「正常返回但带错误」的路径）", () => {
	// ① pi 的权威信号
	assert.equal(isFailureResult(true, [], undefined), true);
	// ② details.error
	assert.equal(isFailureResult(false, [], { error: "boom" }), true);
	assert.equal(isFailureResult(false, [], { error: "   " }), false, "只有空白的 error 不算失败");
	assert.equal(isFailureResult(false, [], {}), false);
	// ③ 正文里的 Error: 行（MCP server 可能正常返回一段错误文本）
	assert.equal(isFailureResult(false, ["something", "Error: bad request"], undefined), true);
	assert.equal(isFailureResult(false, ["  Error：中文冒号也算"], undefined), true);
	assert.equal(isFailureResult(false, ["some error happened"], undefined), false, "行中间提到 error 不算");
	assert.equal(isFailureResult(false, ["ok"], undefined), false);
});

test("colorizeErrorLines 只给 Error: 行上失败红，且先剥掉原色", () => {
	const input = ["normal line", "Error: boom", "\u001b[38;2;9;9;9mError: colored\u001b[39m"];
	const out = colorizeErrorLines(input, theme);
	assert.equal(out[0], "normal line", "普通行不动");
	assert.equal(plain(out[1]), "Error: boom");
	assert.ok(out[1]!.includes(theme.getFgAnsi("toolDiffRemoved")), "Error: 行必须被染成失败红");
	assert.equal(plain(out[2]), "Error: colored", "已经带色的 Error: 行要重新上色（避免两种红并存）");
});

// ---------------------------------------------------------------------------
// 标题行侧：圆点 + 首行，其余行挂结构符
// ---------------------------------------------------------------------------

test("withCallGutter：首行前置圆点，续行按 connected 选 `│ ` 或两格缩进", () => {
	const dot = "\u001b[38;2;1;2;3m\u2022\u001b[39m";
	const pipe = "\u001b[7mX\u001b[27m";

	const loose = withCallGutter(["title line", "arg line"], dot, pipe, false);
	assert.equal(firstColumn(loose[0]!), 0, "圆点必须在列 0");
	assert.equal(plain(loose[0]!), "\u2022 title line", "圆点与标题之间一个空格");
	assert.equal(firstColumn(loose[1]!), MARGIN_WIDTH, "结果未到时续行只缩进 2 格（不画竖线）");
	assert.ok(!loose[1]!.includes("X"), "未连上时不能画结构符");

	const connected = withCallGutter(["title line", "arg line"], dot, pipe, true);
	assert.equal(firstColumn(connected[1]!), MARGIN_WIDTH, "结构符落在列 2");
	assert.ok(connected[1]!.includes("X"), "结果到达后续行换成结构符");
});

test("withCallGutter：空行保持空行（补空格会擦掉「这行是空的」）", () => {
	const out = withCallGutter(["title", "", "tail"], "\u2022", "\u2502 ", true);
	assert.equal(out[1], "", "空行不能变成带前缀的空白行");
});

// ---------------------------------------------------------------------------
// 结果侧：`└ ` 整块只出现一次、落在末行
// ---------------------------------------------------------------------------

test("shapeResultLines：`└ ` 只出现一次且落在末行，其余非空行挂 `│ `", () => {
	const lines = ["{", '  "results": [', "    {", "  ]", "}"];
	const out = shapeResultLines(lines, theme);

	assert.equal(out.length, lines.length);
	assert.equal(out.filter((l) => plain(l).includes("\u2514 ")).length, 1, "`└ ` 整块只能出现一次");
	assert.ok(plain(out[out.length - 1]!).startsWith(`${GUTTER_LEAD}\u2514 `), "`└ ` 必须落在末行（提示行就是末行）");
	for (const line of out.slice(0, -1)) {
		assert.equal(firstColumn(line), MARGIN_WIDTH, "结构符落在列 2");
		assert.equal(plain(line)[MARGIN_WIDTH], "\u2502", `非末行必须是竖线：${JSON.stringify(plain(line))}`);
		assert.equal(plain(line)[MARGIN_WIDTH + 1], " ", "结构符后一个空格，正文从列 4 起");
	}
});

test("shapeResultLines：末行是空行时往前找落点", () => {
	const out = shapeResultLines(["a", "b", "", "  "], theme);
	const cornerIndex = out.findIndex((l) => plain(l).includes("\u2514 "));
	assert.equal(cornerIndex, 1, "`└ ` 落在最后一个非空行（index 1）上");
	assert.equal(out[2], "", "`└ ` 之下的空行原样保留");
	assert.equal(out[3], "  ", "`└ ` 之后的空白行不再画竖线");
});

test("shapeResultLines：`└ ` 之上的空行挂 `│ `（否则看着像树断了）", () => {
	const out = shapeResultLines(["a", "", "b"], theme);
	// 结构符前面有两格留白（GUTTER_LEAD），所以这一行的可见内容是 `  │ `
	assert.equal(plain(out[1]!), `${GUTTER_LEAD}\u2502 `, "空行补竖线，变成一行只有 `│` 的行");
	assert.equal(firstColumn(out[1]!), MARGIN_WIDTH, "补出来的竖线与其它结构符同列");
});

test("shapeResultLines：全空 / 空数组时返回空（没地方挂 `└ `）", () => {
	assert.deepEqual(shapeResultLines([], theme), []);
	assert.deepEqual(shapeResultLines(["", "  ", ""], theme), []);
});

// ---------------------------------------------------------------------------
// 组合：一个真实形状的块（标题 + JSON 结果 + 提示行）
// ---------------------------------------------------------------------------

test("整块形状：标题圆点列 0、正文列 4、`└ ` 落在 ctrl+o 提示行", () => {
	const dot = "\u001b[38;2;1;2;3m\u2022\u001b[39m";
	const body = ["{", '  "results": [', '    { "repo": "example-workspace" }', "  ]", "}"];
	const hint = "\u001b[38;2;1;2;3m... (210 more lines, 215 total, ctrl+o to expand)\u001b[39m";

	const call = withCallGutter(['knowledge-bot/search_knowledge query="版本进展" limit=8'], dot, theme.fg("muted", "\u2502 "), true);
	const result = shapeResultLines([...body, hint], theme);
	const all = [...call, ...result];

	assert.equal(firstColumn(all[0]!), 0, "标题圆点在列 0");
	assert.ok(plain(all[0]!).includes("knowledge-bot/search_knowledge"), "工具名完整保留");
	assert.ok(plain(all[0]!).includes('query="版本进展"'), "参数完整保留在标题行（用户 2026-10-16 定）");
	assert.equal(all.filter((l) => plain(l).includes("\u2514 ")).length, 1, "整块只有一个 `└ `");
	assert.ok(plain(all[all.length - 1]!).includes("ctrl+o to expand"), "`└ ` 落在提示行 —— 树延伸到展开入口");
	for (const line of all.slice(1)) {
		assert.equal(firstColumn(line), MARGIN_WIDTH, "正文整体挂结构符（列 2）");
	}
});
