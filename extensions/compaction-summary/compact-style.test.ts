/**
 * Tests for compact-style.ts — 压缩块形态裁剪的纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/compaction-summary/compact-style.test.ts
 *
 * 本模块不 import pi / pi-tui（宽度量度与 `✔` 的着色串都注入），所以这里用一份**照 pi 真实
 * 输出抄来的**行数组直接断言：哪几行被去掉、标记插在哪一行、可见宽度有没有变。
 * `/x1b[48;…m` 那种带底色的内边距行必须是单独的用例 —— 去底色与裁空行的先后顺序是本模块的
 * 关键前提，pi 的原版行数组恰恰是带底色的那一版。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isBlankRow,
	MARK_GLYPH,
	markRow,
	dropTitleGap,
	restyleCompaction,
	stripPaddingRows,
} from "./compact-style.ts";

/** 剥 ANSI / OSC，只留可见文本（fixture 里只有 ASCII，长度即列数）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

const widthOf = (text: string): number => plain(text).length;

const BG = "\u001b[48;2;36;36;36m";
const BG_RESET = "\u001b[49m";
const FG = "\u001b[38;2;248;248;242m";
const FG_RESET = "\u001b[39m";
const LABEL = " \u001b[38;2;255;178;249m\u001b[1m[compaction]\u001b[22m\u001b[39m";
const MARK = `\u001b[38;2;137;184;194m${MARK_GLYPH}${FG_RESET}`;

/** `style` 决定内边距行带不带底色：pi 原版带，去底色之后不带。 */
function blankRow(width: number, style: "bare" | "bg"): string {
	const spaces = " ".repeat(width);
	return style === "bg" ? `${BG}${spaces}${BG_RESET}` : spaces;
}

/** 照 pi 原版 `CompactionSummaryMessageComponent` 的真实输出拼一份（正文只有一行）。 */
function stockCollapsed(width: number, style: "bare" | "bg" = "bg"): string[] {
	const label = style === "bg" ? `${BG}${LABEL}${" ".repeat(width - widthOf(LABEL))}${BG_RESET}` : `${LABEL}${" ".repeat(width - widthOf(LABEL))}`;
	const body = ` ${FG}Compacted from 208,359 tokens (${FG_RESET}${FG} to expand)${FG_RESET}`;
	const bodyPadded = style === "bg" ? `${BG}${body}${" ".repeat(width - widthOf(body))}${BG_RESET}` : `${body}${" ".repeat(width - widthOf(body))}`;
	return [blankRow(width, style), label, blankRow(width, style), bodyPadded, blankRow(width, style)];
}

describe("isBlankRow：两种内边距形态都认得", () => {
	it("裸空格行算空白", () => {
		assert.equal(isBlankRow(" ".repeat(40)), true);
		assert.equal(isBlankRow(""), true);
	});

	it("裹着背景序列的内边距行也算空白（去底色之前就要认出来）", () => {
		assert.equal(isBlankRow(blankRow(40, "bg")), true);
	});

	it("有正文的行不是空白（哪怕只有颜色、没有字符也算空白 —— 那是 pi 的样式码）", () => {
		assert.equal(isBlankRow(`${FG}Compacted from 1 tokens${FG_RESET}`), false);
		assert.equal(isBlankRow(`${BG}  [compaction]${BG_RESET}`), false);
	});
});

describe("stripPaddingRows：只裁首尾，正文里的段落空行不动", () => {
	it("去掉上下两条内边距行", () => {
		const lines = stockCollapsed(60);
		assert.equal(lines.length, 5);
		const out = stripPaddingRows(lines);
		assert.equal(out.length, 3, `应剩标签 / 间隔 / 正文：${JSON.stringify(out.map(plain))}`);
		assert.equal(plain(out[0]!).trimEnd(), " [compaction]");
		assert.match(plain(out[2]!), /Compacted from/);
	});

	it("展开态正文里的空行保留（它们只在中间）", () => {
		const width = 40;
		const body = ` ${FG}Compacted from 1 tokens${FG_RESET}`;
		const lines = [
			blankRow(width, "bg"),
			`${BG}${LABEL}${" ".repeat(width - widthOf(LABEL))}${BG_RESET}`,
			blankRow(width, "bg"),
			`${BG}${body}${" ".repeat(width - widthOf(body))}${BG_RESET}`,
			blankRow(width, "bg"),
			`${BG}${FG}para one${FG_RESET}${" ".repeat(width - 9)}${BG_RESET}`,
			blankRow(width, "bg"),
			`${BG}${FG}para two${FG_RESET}${" ".repeat(width - 9)}${BG_RESET}`,
			blankRow(width, "bg"),
		];
		const out = stripPaddingRows(lines);
		assert.equal(out.length, 7, `首尾各去一行，共 7 行：${JSON.stringify(out.map(plain))}`);
		assert.equal(plain(out[0]!).trimEnd(), " [compaction]");
		assert.equal(plain(out[1]!).trim(), "", "标题与正文之间那条 Spacer 还在（本函数不负责它）");
		assert.match(plain(out[2]!), /Compacted from/);
		assert.equal(plain(out[3]!).trim(), "", "正文自己的段落空行保留");
		assert.match(plain(out[4]!), /para one/);
		assert.equal(plain(out[5]!).trim(), "", "第二处段落空行也在");
		assert.match(plain(out[6]!), /para two/);
	});

	it("全是空白行时返回空数组（没东西可画）", () => {
		assert.deepEqual(stripPaddingRows([blankRow(10, "bare"), blankRow(10, "bare")]), []);
	});

	it("没有内边距行时原样返回（pi 将来自己去掉 paddingY 也不炸）", () => {
		const lines = [LABEL, " body text"];
		assert.deepEqual(stripPaddingRows(lines), lines);
	});
});

describe("dropTitleGap：去掉标题与正文之间那条 Spacer", () => {
	it("丢标签之后紧邻的那一段空白", () => {
		const lines = [LABEL, " ".repeat(40), " body", " ".repeat(40), " para"];
		const out = dropTitleGap(lines);
		assert.deepEqual(out.map(plain), [" [compaction]", " body", " ".repeat(40), " para"], "只丢标题后那一段");
	});

	it("没有间隔时原样返回", () => {
		const lines = [LABEL, " body"];
		assert.deepEqual(dropTitleGap(lines), lines);
	});

	it("整段都是空白时不做裁剪（不能把内容全吃成一行标签）", () => {
		const lines = [LABEL, " ".repeat(10), " ".repeat(10)];
		assert.deepEqual(dropTitleGap(lines), lines);
	});
});

describe("markRow：标记占的列数从行尾补白里吃，可见宽度不变", () => {
	it("常规行：标记落在行首内边距之后，行宽不变", () => {
		const line = ` ${FG}Compacted from 1 tokens${FG_RESET}${" ".repeat(20)}`;
		const marked = markRow(line, MARK, widthOf);
		assert.equal(plain(marked).startsWith(` ${MARK_GLYPH} Compacted`), true, `标记 + 空格 + 正文：${JSON.stringify(plain(marked))}`);
		assert.equal(widthOf(marked), widthOf(line), "可见宽度不变");
	});

	it("行尾补白不足一列时这一行不加标记（宁可不画，不能撑宽）", () => {
		const line = ` ${FG}${"x".repeat(38)}${FG_RESET}`; // 正好铺满，没有补白
		assert.equal(markRow(line, MARK, widthOf), line);
	});

	it("补白恰好够时能加（标记 1 列 + 空格 1 列 = 2 列）", () => {
		const line = ` ${FG}body${FG_RESET}  `;
		const marked = markRow(line, MARK, widthOf);
		assert.equal(plain(marked), ` ${MARK_GLYPH} body`);
		assert.equal(widthOf(marked), widthOf(line));
	});

	it("空标记串时原样返回", () => {
		const line = " body  ";
		assert.equal(markRow(line, "", widthOf), line);
	});
});

describe("restyleCompaction：三步串起来", () => {
	it("折叠态：两行 —— `[compaction]` 与带 ✔ 的 Compacted 行；没有底色、没有空行", () => {
		const out = restyleCompaction(stockCollapsed(60), MARK, widthOf);
		assert.equal(out.length, 2, `应为两行：${JSON.stringify(out.map(plain))}`);
		assert.equal(plain(out[0]!).trimEnd(), " [compaction]", "标签行原样（颜色与位置都不动）");
		assert.equal(plain(out[1]!).startsWith(` ${MARK_GLYPH} Compacted from 208,359 tokens (`), true, `正文行带 ✔：${JSON.stringify(plain(out[1]!))}`);
		// 标记必须在正文的色序列**之前**：否则它自带的 `\x1b[39m` 会把正文颜色一并清掉
		assert.ok(
			out[1]!.indexOf(MARK) < out[1]!.indexOf(FG),
			`✔ 应在正文色之前（否则正文变默认色）：${JSON.stringify(out[1]!)}`,
		);
		for (const line of out) assert.equal(widthOf(line), 60, `每行仍 60 列：${JSON.stringify(plain(line))}`);
	});

	it("标签行整行原样返回：颜色、加粗、内边距一个字都不动", () => {
		const stock = stockCollapsed(60);
		const out = restyleCompaction(stock, MARK, widthOf);
		assert.equal(out[0], stock[1], "标签行就是 pi 原版那一行（本模块只裁行、不改行内）");
		assert.match(out[0]!, /\u001b\[38;2;255;178;249m/, "标签色仍是 pi 的 customMessageLabel");
	});

	it("标记为空串（拿不到皮肤）时只做形态裁剪，不加 ✔", () => {
		const out = restyleCompaction(stockCollapsed(60), "", widthOf);
		assert.equal(out.length, 2);
		assert.equal(plain(out[1]!).startsWith(" Compacted"), true, `没有标记：${JSON.stringify(plain(out[1]!))}`);
	});

	it("同一份输入连续两次结果一致（Box 每帧都会拿 pi 原版的行再来一遍）", () => {
		const once = restyleCompaction(stockCollapsed(60), MARK, widthOf);
		const again = restyleCompaction(stockCollapsed(60), MARK, widthOf);
		assert.deepEqual(again, once, "产出的每个串都相同，屏幕不会在两帧之间跳");
	});

	it("空数组 → 空数组（没有内容可画）", () => {
		assert.deepEqual(restyleCompaction([], MARK, widthOf), []);
	});
});
