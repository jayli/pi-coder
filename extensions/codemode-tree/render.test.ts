/**
 * codemode-tree/render.ts — 纯逻辑测试（不 import pi，`node --test` 直跑）。
 *
 * 覆盖两件事：**列位**（圆点列 0 / `│` `└` 列 2 / 正文列 4，与 bash 块对齐）与**树的结构规则**
 * （`└ ` 只出现一次、提示行挂 `│ `、前导空行不吃 `└ `、只有提示行时不丢内容）。
 *
 * 用**假主题**（`fg` 只是加可辨识的包裹标记）而不是 pi 的真 Theme：本文件要钉的是布局，
 * 真主题的 SGR 只会让断言噪音变多；真正"过 pi 加载器 + `ToolExecutionComponent`"的端到端
 * 验证在 `index.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BODY_INDENT,
	CONTENT_OFFSET,
	GUTTER_LEAD,
	MARGIN_WIDTH,
	contentWidth,
	isBlankLine,
	isExpandHintLine,
	shapeResultLines,
	stateDotSlot,
	withCallGutter,
} from "./render.ts";

/** 假主题：`muted` 包 `<>`，`text` 包 `[]` —— 断言里能看出用的是哪个槽。 */
const theme = {
	fg: (color: string, text: string): string => (color === "muted" ? `<${text}>` : `[${text}]`),
};

/** 剥掉假主题的标记，只留可见字符（列位断言看这个）。 */
const plain = (line: string): string => line.replace(/[<>[\]]/g, "");

/** 一行第一个非空字符的列号（宽字符不在 fixture 里出现）。 */
function firstColumn(line: string): number {
	return plain(line).search(/[^\s]/);
}

/** 结构符行：剥掉假主题标记后，从列 0 开始的整行（**含那两格左边距**）。 */
const glyphs = (line: string): string => plain(line);

test("列位：圆点在列 0、正文列 2、gutter 之后的正文在列 4", () => {
	const call = withCallGutter(["codemode", "const x = 1;"], "[•]", "<│ >", false);
	assert.equal(firstColumn(call[0]!), 0, `圆点该在列 0：${JSON.stringify(call[0])}`);
	assert.equal(plain(call[0]!).slice(2), "codemode", "工具名该从列 2 开始");
	assert.equal(firstColumn(call[1]!), MARGIN_WIDTH, `命令续行该在列 2（与 codemode 同列）：${JSON.stringify(call[1])}`);

	const result = shapeResultLines(["✓ bash {...} 158ms", "line 0 of output"], theme);
	assert.equal(firstColumn(result[0]!), MARGIN_WIDTH, "`└` 该在列 2");
	assert.equal(glyphs(result[0]!).slice(0, 4), "  └ ", "`└ ` 前面是两格左边距，后面直接接正文");
	assert.equal(firstColumn(result[1]!), MARGIN_WIDTH + 2, "`└ ` 之下的正文该在列 4（与 bash 块同列）");

	// 与 bash 块同一列位：`└ ` 之后的正文落在 MARGIN + GUTTER = 4
	assert.equal(MARGIN_WIDTH + 2, 4);
	assert.equal(BODY_INDENT.length, MARGIN_WIDTH + 2);
});

test("宽度预算：子组件按 width - 4 渲染（命令侧与结果侧同一口径）", () => {
	// 命令侧虽然"执行中"只挂 2 列缩进，预算也按最宽的 4 列算 —— 否则结果到达那一刻折行会跳变
	assert.equal(CONTENT_OFFSET, MARGIN_WIDTH + 2);
	assert.equal(contentWidth(100), 96);
	assert.equal(contentWidth(10), 6);
	// 极窄终端：绝不能返回 0 或负数（子组件会拿到非法宽度）
	assert.equal(contentWidth(4), 1);
	assert.equal(contentWidth(0), 1);
});

test("命令行连接状态：结果没到用两格缩进、到了换成 │", () => {
	const loose = withCallGutter(["codemode", "line"], "[•]", "<│ >", false);
	assert.equal(glyphs(loose[1]!), "  line", `结果没到该是两格缩进：${JSON.stringify(loose[1])}`);

	const connected = withCallGutter(["codemode", "line"], "[•]", "<│ >", true);
	assert.equal(glyphs(connected[1]!), "  │ line", `结果到了该接上树：${JSON.stringify(connected[1])}`);
	assert.equal(firstColumn(connected[1]!), MARGIN_WIDTH, "`│` 与 `codemode` 同列");
});

test("命令行不会把空行的空白补出来（外层判空要靠它）", () => {
	const lines = withCallGutter(["codemode", "", "tail"], "[•]", "<│ >", true);
	assert.equal(lines[1], "", "空行必须原样留空，否则外层判不出「这一行是空的」");
	assert.ok(isBlankLine(lines[1]!));
});

test("圆点槽位：执行中白、成功绿、失败红（用户 2026-10-01 定）", () => {
	// 执行中（partial）→ `text`（普通前景色）
	assert.equal(stateDotSlot(true, false), "text", "执行中该用普通前景色");
	// partial 期间即使 isError 已置位，仍算「还在跑」—— 结局未定
	assert.equal(stateDotSlot(true, true), "text", "执行中优先于 isError");
	// 执行完成功 → `toolDiffAdded`（**必须与 bash / read 的绿圆点同槽**，不能用 success）
	assert.equal(stateDotSlot(false, false), "toolDiffAdded", "成功该用 bash 圆点同款绿");
	// 执行完失败 → `toolDiffRemoved`
	assert.equal(stateDotSlot(false, true), "toolDiffRemoved", "失败该用红");
});

test("结果树：`└ ` 只出现一次，挂在第一个实质内容行上", () => {
	const lines = shapeResultLines(["", "✓ bash a 158ms", "✓ bash b 382ms", "", "output line"], theme);
	const corners = lines.filter((line) => plain(line).includes("└")).length;
	assert.equal(corners, 1, `整块只该有一个拐角符：${JSON.stringify(lines.map(plain))}`);
	// 第一行是内置渲染器的分隔空行 → 带 `│ `（用户样例里就是那根）
	assert.equal(glyphs(lines[0]!), "  │ ", `分隔空行该带 ` + "`│ `" + `：${JSON.stringify(lines[0])}`);
	assert.equal(glyphs(lines[1]!), "  └ ✓ bash a 158ms", "`└ ` 挂在第一个嵌套调用上");
	assert.equal(glyphs(lines[2]!), "    ✓ bash b 382ms", "第二个调用走四格缩进，不再画树");
	assert.equal(glyphs(lines[3]!), "", "树落地之后的空行留空，不补 `│`、也不补缩进");
});

test("结果树：截断提示行挂 `│ `，不吃 `└ `", () => {
	const hint = "... (35 more lines, ctrl+o to expand)";
	const lines = shapeResultLines(["", hint, "output line"], theme);
	assert.equal(glyphs(lines[1]!), `  │ ${hint}`, "提示行是「下文还有」，该挂 `│ `");
	assert.equal(glyphs(lines[2]!), "  └ output line", "`└ ` 留给正文第一行");
	assert.ok(isExpandHintLine(hint));
	// 三种实测措辞都要认：内置 codemode 是 `more lines`、bash 预览是 `earlier lines`、
	// 还有不带中间词那种 —— 只认 earlier/more 会让前两种之外的提示行抢走 `└ `
	assert.ok(isExpandHintLine("… (12 earlier lines, ctrl+o to expand)"));
	assert.ok(isExpandHintLine("… (5 lines, ctrl+o to expand)"));
	assert.ok(isExpandHintLine("... (1 more line, ctrl+o to expand)"), "单数 lines 也要认");
	// **`calls` 是另一种名词**（嵌套调用清单的折叠提示）—— 2026-10-01 大例子里实测踩到：
	// 只认 `lines` 时这行没被识别成提示行，`└ ` 就错挂在它头上了。
	assert.ok(isExpandHintLine("... (2 earlier calls,  to expand)"), "嵌套调用清单的折叠提示必须认");
	assert.ok(isExpandHintLine("... (1 earlier call,  to expand)"), "单数 call 也要认");
	// 不能把正文里的点号误认成提示行
	assert.equal(isExpandHintLine("... (not a hint"), false);
	assert.equal(isExpandHintLine("some text ... (3 lines)"), false);
	assert.equal(isExpandHintLine("... (3 apples, ctrl+o to expand)"), false, "名词只有 lines / calls 两种，别的词不算提示行");
});

test("结果树：嵌套调用清单的折叠提示不吃 `└ `（大例子的回归）", () => {
	// 10 次嵌套调用 → 内置渲染器只显示最后 8 条，首行是 `... (2 earlier calls, ctrl+o to expand)`。
	// `└ ` 必须落在**第一条真实的嵌套调用**上，提示行挂 `│ `。
	const hint = "... (2 earlier calls,  to expand)";
	const lines = shapeResultLines(["", hint, "✓ bash {\"command\":\"pwd\"} 120ms", "✓ bash {…} 157ms"], theme);
	assert.equal(glyphs(lines[1]!), `  │ ${hint}`, "提示行该挂 `│ `");
	assert.equal(glyphs(lines[2]!), "  └ ✓ bash {\"command\":\"pwd\"} 120ms", "`└ ` 该落在第一条嵌套调用上");
	assert.equal(lines.filter((l) => plain(l).includes("└")).length, 1, "`└ ` 仍然只出现一次");
});

test("结果树：没有实质内容时提示行不丢（整段挂 `│ `）", () => {
	const hint = "… (5 lines, ctrl+o to expand)";
	const lines = shapeResultLines(["", hint], theme);
	assert.equal(lines.length, 2, "只有提示行也必须保留，不能整块丢掉");
	assert.equal(glyphs(lines[1]!), `  │ ${hint}`);
	assert.equal(lines.filter((l) => plain(l).includes("└")).length, 0, "没有正文就不该有 `└ `");
});

test("结果树：全空输入返回空数组（`hideComponent` 那条路要靠它）", () => {
	assert.deepEqual(shapeResultLines([], theme), []);
	assert.deepEqual(shapeResultLines(["", "   "], theme), []);
});

test("结果树：`└ ` 之上的空行带 `│`、之下不补（与 bash 的 ⑤ 同规则）", () => {
	// 提示行 + 空行都排在 `└ ` 之前 → 都该带 `│ `
	const lines = shapeResultLines(["", "… (5 lines, ctrl+o to expand)", "", "body"], theme);
	assert.equal(glyphs(lines[0]!), "  │ ");
	assert.equal(glyphs(lines[1]!), "  │ … (5 lines, ctrl+o to expand)");
	assert.equal(glyphs(lines[2]!), "  │ ", "`└ ` 之前的空行不能把栅栏断开");
	assert.equal(glyphs(lines[3]!), "  └ body");
	// 结构符与正文之间没有多余空格：`└ ` 自带那一格
	assert.equal(glyphs(lines[3]!).indexOf("body"), 4);
	assert.equal(GUTTER_LEAD.length, MARGIN_WIDTH);
});
