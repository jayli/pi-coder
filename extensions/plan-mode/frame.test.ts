/**
 * Tests for frame.ts — 弹框正文线框的纯几何。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/frame.test.ts
 *
 * frame.ts 不 import pi / pi-tui：折行、量宽、上色都注入。这里用与生产同口径的本地实现
 * （折行按可见宽度切、量宽 CJK 算 2 列、上色包成 `slot(text)`），断言的是**几何与结构**
 * ——每行多宽、左右封没封边、正文走哪个槽。真观感由 pi 的组件决定（已用真主题验证）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FRAME_HEIGHT, FRAME_INSET, FRAME_SLOT, bodyTextWidth, frameBody } from "./frame.ts";

const plain = { fg: (_color: string, text: string) => text };
const painted = { fg: (color: string, text: string) => `${color}(${text})` };

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");
}

/** 与 pi-tui `visibleWidth` 同口径：ANSI 不计，CJK / 全角算 2 列。 */
function measure(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) {
		const code = char.codePointAt(0)!;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/** 按可见宽度硬断（生产注入 pi-tui 的 wrapTextWithAnsi，同样按可见列宽切）。 */
function wrap(text: string, width: number): string[] {
	if (text === "") return [""];
	const rows: string[] = [];
	let current = "";
	let used = 0;
	for (const char of text) {
		const charWidth = measure(char);
		if (used + charWidth > width && used > 0) {
			rows.push(current);
			current = char;
			used = charWidth;
			continue;
		}
		current += char;
		used += charWidth;
	}
	if (current !== "") rows.push(current);
	return rows.length > 0 ? rows : [""];
}

/** 一段文本在终端 `columns` 列宽下画出来的行（去掉末行换行）。 */
function render(text: string, columns = 40, theme = plain): string[] {
	return frameBody(theme, text, { columns, wrap, measure }).split("\n");
}

describe("几何常量", () => {
	it("框在一行里吃掉 4 列（左右边框 + 框内左右留白），在高度上吃 2 行", () => {
		assert.equal(FRAME_INSET, 4);
		assert.equal(FRAME_HEIGHT, 2);
	});

	it("内宽 = 终端列数 − FRAME_INSET，极窄终端有下限（不会算出 0 或负数）", () => {
		assert.equal(bodyTextWidth(40), 36);
		assert.equal(bodyTextWidth(100), 96);
		assert.ok(bodyTextWidth(1) >= 4);
		assert.ok(bodyTextWidth(0) >= 4);
	});
});

describe("框的形状", () => {
	it("上下是 ┌─┐ / └─┘，中间每行都是 │ … │", () => {
		const lines = render("正文");
		assert.equal(lines.length, 3, "一行正文 + 上下边框");
		assert.match(lines[0]!, /^┌─+┐$/);
		assert.match(lines[2]!, /^└─+┘$/);
		assert.match(lines[1]!, /^│ 正文 +│$/);
	});

	it("每一行的可见宽度都等于终端列数（右边框对齐，不会被挤到下一行）", () => {
		const lines = render("短句\n" + "很长的句子".repeat(12) + "\n\n尾巴", 40);
		for (const line of lines) assert.equal(measure(line), 40, `宽度不一致：${line}`);
	});

	it("上下横线与正文行同宽（框整体宽 = 终端列数）", () => {
		const lines = render("x", 40);
		assert.equal(measure(lines[0]!), 40);
		assert.equal(lines[0]!.length, bodyTextWidth(40) + 4, "左右边框各 1 + 框内留白各 1");
	});

	it("空行也封左右边（段落间距在那里，框不能断开）", () => {
		const lines = render("第一段\n\n第二段");
		assert.equal(lines.length, 5, "3 行正文（含空行）+ 上下边框");
		assert.match(lines[2]!, /^│ +│$/, "空行是左右边框夹着留白");
		assert.equal(measure(lines[2]!), 40);
	});

	it("长句折行后每一片各自封边，片数按内宽算", () => {
		const lines = render("x".repeat(200), 40);
		assert.equal(lines.length, FRAME_HEIGHT + Math.ceil(200 / bodyTextWidth(40)));
		for (const line of lines.slice(1, -1)) assert.match(line, /^│ .+ │$/);
		for (const line of lines) assert.equal(measure(line), 40);
	});

	it("CJK 按 2 列计算：一行 CJK 不会因为字节数多而溢宽", () => {
		const lines = render("中".repeat(100), 40);
		for (const line of lines) assert.equal(measure(line), 40);
		assert.ok(lines.length > FRAME_HEIGHT);
	});
});

describe("配色", () => {
	it("正文走 text 槽，边框走 dim 槽（与 plan-mode 树前缀同槽）", () => {
		const lines = render("正文", 40, painted);
		assert.match(lines[0]!, /^dim\(┌─+┐\)$/);
		assert.match(lines[1]!, /^dim\(│\) text\(正文\) +dim\(│\)$/);
		assert.match(lines[2]!, /^dim\(└─+┘\)$/);
		assert.equal(FRAME_SLOT, "dim");
	});

	it("空行不涂色（留白不是内容），补位空格在色码外（几何不涂色）", () => {
		const lines = render("A\n\nB", 40, painted);
		assert.match(lines[2]!, /^dim\(│\) +dim\(│\)$/, "空行里没有任何 text(...) 包裹");
		assert.match(lines[1]!, /text\(A\) {2,}dim\(│\)$/, "补位空格紧跟在色码收尾之后");
	});
});

describe("空输入", () => {
	it("空串返回空串（调用方据此不画这一段）", () => {
		assert.equal(frameBody(plain, "", { columns: 40, wrap, measure }), "");
	});

	it("纯空白不画框（只有空格/换行时画一个空框没有意义）", () => {
		assert.equal(frameBody(plain, "   \n\t\n", { columns: 40, wrap, measure }), "");
	});

	it("CRLF 归一成 LF（不因为 \\r 算错一列）", () => {
		const lines = render("甲\r\n乙");
		assert.equal(lines.length, 4);
		for (const line of lines) assert.equal(measure(line), 40);
	});
});
