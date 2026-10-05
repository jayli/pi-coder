/**
 * Tests for render.ts — web-search-tree 的纯逻辑（树形前缀、圆点槽、折叠提示）。
 *
 * Run with:  node --test clients/pi/extensions/web-search-tree/render.test.ts
 *
 * 被测模块不 import pi / pi-tui，所以这里喂假的 theme（把颜色名原样写出来，断言直接看得见
 * 用的是哪个槽）。真实的端到端链路（pi 自己的加载器 → 真 `ToolExecutionComponent`）在
 * `index.test.ts`。
 *
 * 断言口径（用户 2026-10-02 定的形状）：
 *   - 圆点 `•` 在列 0、`│` / `└` 在列 2、正文在列 4；
 *   - `└ ` 出现在**末行**（本工具与 bash 的区别，见 render.ts 文件头）；
 *   - 空行不加前缀（悬空竖线）也不是 `└ ` 的落点；
 *   - 折叠提示的措辞与包自带渲染器逐字一致，只有展开键可变。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BODY_INDENT,
	CONTENT_OFFSET,
	contentWidth,
	GUTTER_LEAD,
	isBlankLine,
	isFailureResult,
	recolorSuccessToFailure,
	shapeResultLines,
	stateDotSlot,
	trimTrailingBlanks,
	withCallGutter,
} from "./render.ts";

/** 假 theme：把槽名原样写成 `<slot>…</slot>`，断言里直接看得到用的是哪个色。 */
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

/** 有色的 `│ ` / `└ ` 前缀（结构符走 `muted`，与 bash / codemode 同一槽）。 */
const PIPE = `${GUTTER_LEAD}<muted>│ </muted>`;
const CORNER = `${GUTTER_LEAD}<muted>└ </muted>`;

describe("列位常量", () => {
	it("圆点列 + 结构符列 = 正文偏移（列 0 / 2 / 4）", () => {
		assert.equal(CONTENT_OFFSET, 4);
		assert.equal(BODY_INDENT.length, 4);
		assert.equal(GUTTER_LEAD.length, 2);
	});

	it("contentWidth 扣掉偏移，且永不为 0（极窄终端保底 1）", () => {
		assert.equal(contentWidth(80), 76);
		assert.equal(contentWidth(4), 1);
		assert.equal(contentWidth(1), 1);
	});
});

describe("状态圆点", () => {
	it("执行中 dim、成功 toolDiffAdded、失败 toolDiffRemoved", () => {
		assert.equal(stateDotSlot(true, false), "dim");
		assert.equal(stateDotSlot(true, true), "dim", "partial 优先 —— 还没出结果就谈不上成败");
		assert.equal(stateDotSlot(false, false), "toolDiffAdded");
		assert.equal(stateDotSlot(false, true), "toolDiffRemoved");
	});
});

describe("失败判定（三个信号取或）", () => {
	it("context.isError 最强", () => {
		assert.equal(isFailureResult(true, [], undefined), true);
	});

	it("details.error 非空也算（包用正常返回携带错误）", () => {
		assert.equal(isFailureResult(false, [], { error: "No query provided" }), true);
		assert.equal(isFailureResult(false, [], { error: "" }), false, "空串不算");
		assert.equal(isFailureResult(false, [], { error: "   " }), false, "空白不算");
		assert.equal(isFailureResult(false, [], {}), false);
	});

	it("正文里的 Error: 行也算（中英文冒号都认）", () => {
		assert.equal(isFailureResult(false, ["Error: boom"], undefined), true);
		assert.equal(isFailureResult(false, ["    Error: boom"], undefined), true, "缩进不影响");
		assert.equal(isFailureResult(false, ["Error：boom"], undefined), true, "全角冒号");
		assert.equal(isFailureResult(false, ["\u001b[31mError: boom\u001b[39m"], undefined), true, "带 SGR 也认");
	});
	it("mentionError 这类词不算（不能只看前缀 Error）", () => {
		assert.equal(isFailureResult(false, ["Errorless path", "no errors found"], undefined), false);
	});

	it("成功结果的普通正文不算失败", () => {
		assert.equal(isFailureResult(false, ["3/3 queries, 18 sources", "Providers used: exa"], {}), false);
	});
});

describe("命令行树形前缀", () => {
	const dot = "<dim>•</dim>";

	it("首行挂圆点 + 空格，其余行按 connected 选 `│ ` 或两格缩进", () => {
		const loose = withCallGutter(["search 3 queries", "  \"q1\"", "  \"q2\""], dot, "<muted>│ </muted>", false);
		assert.equal(loose[0], `${dot} search 3 queries`);
		assert.equal(loose[1], "    \"q1\"", "还没出结果 = 两格缩进（与 search 的 s 同列）");

		const connected = withCallGutter(["search 3 queries", "  \"q1\""], dot, "<muted>│ </muted>", true);
		assert.equal(connected[1], `${PIPE}  "q1"`, "结果到了 = 树接上，`│` 落在列 2");
	});

	it("空行保持空行（不补缩进、不画竖线）", () => {
		const out = withCallGutter(["a", "", "b"], dot, "<muted>│ </muted>", true);
		assert.equal(out[1], "");
	});

	it("每一行都以圆点或结构符开头，且正文是原行（没被改动）", () => {
		const out = withCallGutter(["x", "y", "z"], dot, "<muted>│ </muted>", true);
		assert.equal(out[0], `${dot} x`);
		assert.equal(out[1], `${PIPE}y`);
		assert.equal(out[2], `${PIPE}z`);
	});
});

describe("结果树（└ 挂在末行）", () => {
	it("末尾空行不抢 `└ `：它落在最后一个非空行上，其后的空行原样", () => {
		const out = shapeResultLines(["3/3 queries, 18 sources", "Providers used: exa", "", ""], theme);
		assert.equal(out[0], `${PIPE}3/3 queries, 18 sources`);
		assert.equal(out[1], `${CORNER}Providers used: exa`, "末个非空行 = `└ `");
		assert.equal(out[2], "", "`└ ` 之后的空行原样（树已落地）");
		assert.equal(out[3], "");
	});

	it("只有一个 `└ `，且落在最后一个非空行上", () => {
		const out = shapeResultLines(["a", "b", "", ""], theme);
		assert.equal(out.filter((line) => line.includes("└")).length, 1, "整块只出现一次");
		assert.ok(out[1]!.startsWith(CORNER), `└ 应在第 2 行（末个非空行）：${JSON.stringify(out)}`);
	});

	it("全空输入返回空数组（不白占一行）", () => {
		assert.deepEqual(shapeResultLines([], theme), []);
		assert.deepEqual(shapeResultLines(["", "   "], theme), []);
		assert.deepEqual(shapeResultLines(["\u001b[39m"], theme), [], "只有 SGR 的行也算空");
	});

	it("单行输入：它就是末行，挂 `└ `", () => {
		const out = shapeResultLines(["1/1 queries, 5 sources"], theme);
		assert.deepEqual(out, [`${CORNER}1/1 queries, 5 sources`]);
	});

	it("包渲染器产出的纯空白行在 `└ ` 之上也挂竖线", () => {
		// 包渲染器会产出 `"\n... more lines"` 那样拆出来的空白行 —— 它在 `└ ` 之上，
		// 于是拿到竖线，正是用户样例里那根 `│`。
		const out = shapeResultLines(["a", " ", "b"], theme);
		assert.equal(out[1], PIPE, "空内容行挂 `│ `");
		assert.ok(out[2]!.startsWith(CORNER), "末行仍是 `└ `");
	});
});

describe("折叠块：复用包自己的提示行，只换前缀", () => {
	// 提示行（`... (N more lines, M total, ctrl+o to expand)`）由**包自己的**渲染器产出，
	// 本扩展只是给它换上前缀 —— 措辞、行数、展开键都不在我们这边，pi-web-access 升级改了
	// 那句话我们也跟着变，不会漂移。这里用包实际产出的那行来验。
	const HINT = "<muted>... (4 more lines, 6 total, ctrl+o to expand)</muted>";
	const body = [
		`${PIPE}search …`,
		`${PIPE}"q1"`,
		`${PIPE}"q2"`,
		`${PIPE}"q3"`,
		`${PIPE}3/3 queries, 18 sources`,
		`${PIPE}Providers used: exa`,
		`${PIPE} `,
		`${CORNER}x`,
	];

	it("折叠态的末行（提示行）挂 `└ ` —— 它就是用户样例里那一行", () => {
		const out = shapeResultLines([`${PIPE}3/3 queries, 18 sources`, `${PIPE}Providers used: exa`, "", HINT], theme);
		assert.equal(out[3], `${CORNER}${HINT}`, "提示行是末行 → 挂 `└ `");
		assert.equal(out[2], PIPE, "它上面的空行被补上竖线 —— 用户样例里那根 `│` 就是这么来的");
	});

	it("只挂一个 `└ `（正文里不会另有拐角符）", () => {
		const out = shapeResultLines([`${PIPE}a`, `${PIPE}b`, HINT], theme);
		assert.equal(out.filter((line) => line.includes("└")).length, 1);
		assert.ok(out[2]!.startsWith(CORNER));
	});
});

describe("尾部空行剔除", () => {
	it("去掉末尾空行（用户要除掉的“下面一行空行”）", () => {
		assert.deepEqual(trimTrailingBlanks(["a", "", "  "]), ["a"]);
		assert.deepEqual(trimTrailingBlanks(["a", "", "b", ""]), ["a", "", "b"]);
	});

	it("不碰中间与开头的空行（用户样例中间那根 `│` 靠它）", () => {
		assert.deepEqual(trimTrailingBlanks(["", "a", "", "b"]), ["", "a", "", "b"]);
	});

	it("全空 → 空数组；本来就没空行 → 原数组", () => {
		assert.deepEqual(trimTrailingBlanks(["", ""]), []);
		const same = ["a", "b"];
		assert.equal(trimTrailingBlanks(same), same);
	});

	it("SGR-only 行也算空", () => {
		assert.deepEqual(trimTrailingBlanks(["a", "\u001b[39m"]), ["a"]);
	});
});

describe("失败块里的 `success` 绿换成失败红", () => {
	// 假 theme 带 `getFgAnsi`：真 pi 的 theme 有这个方法（`read-path-collapse` 也用它）。
	const colorTheme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		getFgAnsi: (color: string) => `<${color}>`,
	};

	it("把 success 色段换成 toolDiffRemoved（`红圆点 + 绿状态行` 的矛盾消掉）", () => {
		const lines = [`<success>3/3 queries, 18 sources</success>`, `<muted><success>1 sources</success></muted>`];
		const out = recolorSuccessToFailure(lines, colorTheme);
		assert.deepEqual(out, [
			`<toolDiffRemoved>3/3 queries, 18 sources</success>`,
			`<muted><toolDiffRemoved>1 sources</success></muted>`,
		]);
	});

	it("不碰其它颜色段（只换 success）", () => {
		const lines = [`<muted>│ </muted><accent>"q"</accent><success>5 sources</success>`];
		const out = recolorSuccessToFailure(lines, colorTheme);
		assert.equal(out[0], `<muted>│ </muted><accent>"q"</accent><toolDiffRemoved>5 sources</success>`);
	});

	it("两个色相同时原样返回（不做无谓改写）", () => {
		const same = { fg: (c: string, t: string) => t, getFgAnsi: () => "<same>" };
		const lines = ["<same>x</same>"];
		assert.equal(recolorSuccessToFailure(lines, same), lines);
	});

	it("theme 没有 getFgAnsi 时原样返回（不崩）", () => {
		const lines = ["<success>x</success>"];
		assert.deepEqual(recolorSuccessToFailure(lines, theme), lines);
	});
});

describe("空行判定", () => {
	it("SGR-only 与纯空白都算空", () => {
		assert.equal(isBlankLine(""), true);
		assert.equal(isBlankLine("   "), true);
		assert.equal(isBlankLine("\u001b[39m"), true);
		assert.equal(isBlankLine("\u001b[38;2;1;2;3m\u001b[39m"), true);
		assert.equal(isBlankLine("x"), false);
		assert.equal(isBlankLine("\u001b[32m \u001b[39m"), true);
	});
});
