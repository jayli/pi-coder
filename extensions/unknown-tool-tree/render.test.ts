/**
 * unknown-tool-tree/render.ts — 纯逻辑测试（不 import pi，`node --test` 直跑）。
 *
 * 覆盖三件事：**列位**（圆点列 0 / `│` `└` 列 2 / 正文列 4）、**参数装配**（折叠单行截断、
 * 展开逐行不压扁）、**树规则**（`└ ` 只出现一次且落在末行、预览截断提示跟着走）。
 *
 * 用假主题（`fg` 只加可辨识的包裹标记）而不是 pi 的真 Theme：本文件要钉的是布局，
 * 真主题的 SGR 只会让断言噪音变多；真正「过 pi 加载器 + `ToolExecutionComponent`」的端到端
 * 验证在 `index.test.ts`。
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
	TREE_LAST,
	TREE_PIPE,
	charWidth,
	contentWidth,
	expandedArgLines,
	formatArgsSummary,
	isFailed,
	previewMoreLinesHint,
	resultTextLines,
	stateDotSlot,
	stripAnsi,
	treePrefixes,
	truncateVisible,
	visibleWidth,
} from "./render.ts";

/** 假主题：`muted` 包 `<>`，其余包 `[]` —— 断言里能看出用的是哪个槽。 */
const theme = {
	fg: (color: string, text: string): string => (color === "muted" ? `<${text}>` : `[${text}]`),
};

/** 剥掉假主题的标记，只留可见字符（列位断言看这个）。 */
const plain = (line: string): string => line.replace(/[<>[\]]/g, "");

test("列位：圆点在列 0、结构符在列 2、正文在列 4（与 bash / codemode / mcp 同表）", () => {
	assert.equal(MARGIN_WIDTH, 2);
	assert.equal(GUTTER_WIDTH, 2);
	assert.equal(CONTENT_OFFSET, 4);
	assert.equal(GUTTER_LEAD.length, MARGIN_WIDTH, "`│` / `└` 落在列 2");
	assert.equal(BODY_INDENT.length, CONTENT_OFFSET, "正文落在列 4");
	// 标题行顶格：`• ` 之后就是工具名
	const title = `[\u2022] [codemap]`;
	assert.equal(plain(title).search(/\S/), 0, "圆点在列 0");
});

test("宽度预算：正文按 width - 4 渲染，极窄终端不低于 1", () => {
	assert.equal(contentWidth(100), 96);
	assert.equal(contentWidth(10), 6);
	assert.equal(contentWidth(4), 1, "子组件拿到非法宽度会崩，必须夹到 1");
	assert.equal(contentWidth(0), 1);
});

test("可见宽度：CJK / 全角记 2 列，ASCII 记 1 列", () => {
	assert.equal(visibleWidth("abc"), 3);
	assert.equal(visibleWidth("中文"), 4);
	assert.equal(visibleWidth("ＡＢ"), 4, "全角拉丁也是 2 列");
	assert.equal(charWidth("a"), 1);
	assert.equal(charWidth("中"), 2);
});

test("截断：按可见宽度截、末尾补 `…` 且算进预算", () => {
	assert.equal(truncateVisible("abcdef", 10), "abcdef", "不超宽就原样返回");
	assert.equal(truncateVisible("abcdef", 4), "abc…", "补的 `…` 占一列");
	assert.equal(truncateVisible("这是一段中文", 6), "这是…", "CJK 按 2 列算，只放得下两个字");
	assert.equal(truncateVisible("abc", 0), "", "预算为 0 什么都不留");
});

test("剥 ANSI：SGR 与 OSC 都要剥（工具名 / 结果正文可能夹带）", () => {
	assert.equal(stripAnsi("\u001b[31mred\u001b[39m"), "red");
	assert.equal(stripAnsi("\u001b]0;title\u0007x"), "x");
});

test("参数折叠：`key=value` 压成单行、按可见宽度截断", () => {
	const args = { code: "async function main() {\n  await tools.read({ path: \"a\" });\n}" };
	const summary = formatArgsSummary(args, 100);
	assert.ok(summary.startsWith('code="async function main() {\\n'), `字符串走 JSON（换行变 \\n）：${summary}`);
	assert.ok(!summary.includes("\n"), "折叠态必须单行");
	assert.ok(!summary.endsWith("…"), "这个 fixture 在 100 列内放得下，不该被截");

	// 预算收紧后才截断：末尾补 …，且总数不超预算
	const tight = formatArgsSummary(args, 30);
	assert.ok(visibleWidth(tight) <= 30, `超宽了：${visibleWidth(tight)}`);
	assert.ok(tight.endsWith("…"), `被截断时末尾补 …：${tight}`);

	// 不超宽时不补 …
	const short = formatArgsSummary({ limit: 8 }, 100);
	assert.equal(short, "limit=8");
});

test("参数折叠：空参数返回空串（调用方据此不在标题后加空格）", () => {
	assert.equal(formatArgsSummary(undefined, 80), "");
	assert.equal(formatArgsSummary(null, 80), "");
	assert.equal(formatArgsSummary({}, 80), "");
	assert.equal(formatArgsSummary([], 80), "");
	// 非对象参数也有一套形状（`args=`），不能悄悄丢掉
	assert.equal(formatArgsSummary("solo", 80), 'args="solo"');
	assert.equal(formatArgsSummary(42, 80), "args=42");
});

test("参数展开：每个 key 一行 `key:`，值缩进两格、保留真实换行", () => {
	const lines = expandedArgLines({ code: "line1\nline2" });
	assert.deepEqual(lines, ["code:", "  line1", "  line2"]);
	// 对象值走缩进后的 JSON
	const objLines = expandedArgLines({ opts: { a: 1 } });
	assert.deepEqual(objLines, ["opts:", "  {", '    "a": 1', "  }"]);
	assert.deepEqual(expandedArgLines(undefined), [], "没有参数就没有行");
});

test("圆点槽位：执行中灰、成功绿、失败红（与 bash 同槽）", () => {
	assert.equal(stateDotSlot(true, false), "dim", "执行中该灰");
	assert.equal(stateDotSlot(true, true), "dim", "执行中优先于 isError");
	assert.equal(stateDotSlot(false, false), "toolDiffAdded", "成功用 bash 圆点同款绿");
	assert.equal(stateDotSlot(false, true), "toolDiffRemoved", "失败用红");
});

test("失败判定只看 isError（这类块没有别的失败痕迹）", () => {
	assert.equal(isFailed(true), true);
	assert.equal(isFailed(false), false);
});

test("结果正文：text 块按顺序拆行、剥 ANSI、去 CR", () => {
	const result = { content: [{ type: "text", text: "\u001b[31mTool codemap not found\u001b[39m\r\n" }] };
	assert.deepEqual(resultTextLines(result), ["Tool codemap not found", ""]);
	// 非 text 块（image 等）跳过
	assert.deepEqual(resultTextLines({ content: [{ type: "image", data: "…" }] }), []);
	assert.deepEqual(resultTextLines(undefined), []);
});

test("树前缀：末行 `└ `、其余 `│ `；只有一行时它就是末行", () => {
	assert.deepEqual(treePrefixes(0), []);
	assert.deepEqual(treePrefixes(1), [TREE_LAST]);
	assert.deepEqual(treePrefixes(3), [TREE_PIPE, TREE_PIPE, TREE_LAST]);
	assert.equal(TREE_PIPE.length, 2, "结构符 + 一个空格 = 2 列");
	assert.equal(TREE_LAST.length, 2);
	// `└ ` 整块只出现一次
	assert.equal(treePrefixes(9).filter((p) => p === TREE_LAST).length, 1);
});

test("预览提示：单数 / 复数措辞，与 memory / tool-search 同族", () => {
	assert.equal(previewMoreLinesHint(1), "… (1 more line, ctrl+o to expand)");
	assert.equal(previewMoreLinesHint(7), "… (7 more lines, ctrl+o to expand)");
	assert.equal(PREVIEW_MAX_LINES, 10, "折叠态正文预算 10 行");
});
