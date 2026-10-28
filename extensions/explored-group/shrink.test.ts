/**
 * explored-group / shrink —— 缩略纯逻辑的单测。
 *
 * Run with:  node --test clients/pi/extensions/explored-group/shrink.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	ELLIPSIS,
	MIN_PATTERN_COLS,
	MIN_TAIL_COLS,
	elideMiddle,
	joinPieces,
	pathStages,
	shrinkPath,
	shrinkPieces,
	type PhrasePiece,
} from "./shrink.ts";

/** 测试用的宽度量度：CJK 按 2 列、其余按 1 列（与终端实际观感一致，够验证宽字符记账）。 */
const width = (text: string): number => {
	let out = 0;
	for (const ch of text) out += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
	return out;
};

const fixed = (text: string): PhrasePiece => ({ text });
const path = (text: string): PhrasePiece => ({ text, shrink: "path" });
const pattern = (text: string): PhrasePiece => ({ text, shrink: "pattern" });

test("shrinkPath：装得下原样返回", () => {
	assert.equal(shrinkPath("src/a.ts", 20, width), "src/a.ts");
	assert.equal(shrinkPath("src/a.ts", 8, width), "src/a.ts");
});

test("shrinkPath：装不下就砍头保尾，前缀一个 `…`", () => {
	const out = shrinkPath("tools/cloudland-kit-fingerprint.mjs", 20, width);
	assert.equal(width(out), 20, out);
	assert.ok(out.startsWith(ELLIPSIS), out);
	assert.ok(out.endsWith("fingerprint.mjs"), `尾巴必须保住文件名：${out}`);
	assert.equal(out, `${ELLIPSIS}kit-fingerprint.mjs`);
});

test("shrinkPath：宽字符按真实列宽记账（不会缩了还是超宽）", () => {
	const out = shrinkPath("中文目录/文件名.txt", 10, width);
	assert.ok(width(out) <= 10, `缩完不许超宽：${JSON.stringify(out)} 宽 ${width(out)}`);
	assert.ok(out.startsWith(ELLIPSIS), out);
});

test("shrinkPath：缩到比 `…` 还窄时只留 `…`；0 列给空串", () => {
	assert.equal(shrinkPath("abcdef", 1, width), ELLIPSIS);
	assert.equal(shrinkPath("abcdef", 0, width), "");
});

test("elideMiddle：装得下原样返回", () => {
	assert.equal(elideMiddle("columnKey", 20, width), "columnKey");
});

test("elideMiddle：装不下就省略中间、两头都保（正则的锚点与结尾都承重）", () => {
	const out = elideMiddle("export function blockIndex|columnKey|COLUMN_HEIGHT", 30, width);
	assert.equal(width(out), 30, `${out} 宽 ${width(out)}`);
	assert.ok(out.startsWith("export"), `开头要保住：${out}`);
	assert.ok(out.endsWith("IGHT") || out.endsWith("HEIGHT"), `结尾要保住：${out}`);
	assert.ok(out.includes(ELLIPSIS), `中间必须省略：${out}`);
});

test("pathStages：逐级丢目录，文件名始终全称", () => {
	// 逐级丢（而不是一步跳到裸文件名）：中间那级 `…/voxel/constants.js` 保留了一级目录，
	// 比裸文件名更有信息量 —— 配额够就停在那里，不够再继续丢。
	assert.deepEqual(pathStages("src/voxel/constants.js", width), [
		"src/voxel/constants.js",
		"…/voxel/constants.js",
		"constants.js",
	]);
	assert.deepEqual(pathStages("~/a/b/c.ts", width), ["~/a/b/c.ts", "…/b/c.ts", "c.ts"]);
	// 没有目录 / 只剩文件名：不动
	assert.deepEqual(pathStages("package.json", width), ["package.json"]);
});

test("shrinkPieces：装得下时一个字符都不动", () => {
	const pieces = [fixed('Search "'), pattern("x"), fixed('" in '), path("src")];
	const result = shrinkPieces(pieces, 40, width);
	assert.deepEqual(result.pieces, pieces);
	assert.equal(result.overflow, false);
});

test("shrinkPieces：阶段 A —— 只丢目录层级，文件名不许缩", () => {
	// 用户第二轮的核心要求：**文件名最好保留全称**，路径可以全缩略掉
	const pieces = [fixed('Search "'), pattern("glass"), fixed('" in '), path("src/voxel/constants.js")];
	const result = shrinkPieces(pieces, 38, width);
	assert.equal(result.overflow, false);
	const out = joinPieces(result.pieces);
	assert.ok(width(out) <= 38, `${width(out)} > 38（${out}）`);
	assert.ok(out.endsWith("constants.js"), `文件名必须完整：${out}`);
	assert.ok(!out.includes("src/"), `目录应被丢掉：${out}`);
	// 配额够到中间那级就停住（保留一级目录比裸文件名更有信息量）
	assert.equal(result.pieces[3]!.text, "…/voxel/constants.js");
	// 模式串完全没动
	assert.equal(result.pieces[1]!.text, "glass");
});

test("shrinkPieces：阶段 B —— 目录全丢完还不够时先缩模式串，文件名仍完整", () => {
	// 用户举的真实例子：模式串长 + 文件名也长 —— 先把模式串缩掉，别先把文件名啃掉
	const pieces = [
		fixed('Search "'),
		pattern("export function blockIndex|columnKey|COLUMN_HEIGHT"),
		fixed('" in '),
		path("src/voxel/constants.js"),
	];
	const budget = 70; // 目录全丢（→ 75 列）还不够，必须动模式串
	const result = shrinkPieces(pieces, budget, width);
	assert.equal(result.overflow, false);
	const out = joinPieces(result.pieces);
	assert.ok(width(out) <= budget, `${width(out)} > ${budget}（${out}）`);
	assert.ok(out.endsWith("constants.js"), `文件名必须保持全称：${out}`);
	assert.ok(result.pieces[1]!.text.includes(ELLIPSIS), `模式串应被缩：${result.pieces[1]!.text}`);
	assert.ok(result.pieces[1]!.text.startsWith("export"), `模式串开头要保住：${result.pieces[1]!.text}`);
	assert.ok(width(result.pieces[1]!.text) >= MIN_PATTERN_COLS, `模式串不能缩没了：${result.pieces[1]!.text}`);
	// 引号是固定段，任何阶段都不许被动
	assert.equal(result.pieces[0]!.text, 'Search "');
	assert.equal(result.pieces[2]!.text, '" in ');
});

test("shrinkPieces：阶段 C —— 文件名自己就超长时才缩文件名", () => {
	const long = `${"dir/"}${"x".repeat(60)}.ts`;
	const pieces = [fixed("Read "), path(long)];
	const result = shrinkPieces(pieces, 30, width);
	assert.equal(result.overflow, false);
	const out = joinPieces(result.pieces);
	assert.ok(width(out) <= 30, `${width(out)} > 30（${out}）`);
	assert.ok(result.pieces[1]!.text.startsWith(ELLIPSIS), `砍头保尾：${out}`);
	assert.ok(result.pieces[1]!.text.endsWith(".ts"), `扩展名要保住：${out}`);
});

test("shrinkPieces：阶段 C 里多条路径相对平均（砍最宽的那条）", () => {
	const pieces = [fixed("Diff "), path("a".repeat(30)), fixed(" "), path("b".repeat(16))];
	const result = shrinkPieces(pieces, 30, width);
	const [first, second] = [result.pieces[1]!.text, result.pieces[3]!.text];
	// 「相对平均」= 两条收完的长度相近，而不是短的完全不动、长的被砍到底
	assert.ok(Math.abs(width(first) - width(second)) <= 2, `两条长度应相近：${width(first)} vs ${width(second)}`);
});

test("shrinkPieces：缩到地板仍装不下 → overflow=true，调用方退回折行", () => {
	const pieces = [fixed("Read "), path("src/a.ts")];
	const result = shrinkPieces(pieces, 3, width);
	assert.equal(result.overflow, true);
	const shrunk = result.pieces[1]!.text;
	assert.ok(width(shrunk) <= width(ELLIPSIS) + MIN_TAIL_COLS, `路径应停在地板：${shrunk}（宽 ${width(shrunk)}）`);
});

test("shrinkPieces：平衡 —— 模式串与文件名都不被单独砍没", () => {
	// 用户第二轮的取向：「模式串和文件名尽可能平衡一些，别把字符串缩略没了，也别单独把文件名缩略没了」。
	const pieces = [
		fixed('Search "'),
		pattern("abcdefghijklmnopqrst"),
		fixed('" in '),
		path(`${"x".repeat(60)}.ts`),
	];
	const result = shrinkPieces(pieces, 40, width);
	assert.equal(result.overflow, false);
	const [pat, file] = [result.pieces[1]!.text, result.pieces[3]!.text];
	assert.ok(width(joinPieces(result.pieces)) <= 40, joinPieces(result.pieces));
	// 两边都还在、都保留了特征（不是一方全没了）
	assert.ok(pat.length >= MIN_PATTERN_COLS - 1, `模式串不能被砍没：${pat}`);
	assert.ok(pat.startsWith("abc") && pat.endsWith("rst"), `模式串两头要保住：${pat}`);
	assert.ok(file.startsWith(ELLIPSIS) && file.endsWith(".ts"), `文件名要保住头部与扩展名：${file}`);
	assert.ok(width(file) >= MIN_TAIL_COLS, `文件名不能被砍没：${file}`);
});

test("shrinkPieces：模式串已经够短时不再动它，只缩文件名", () => {
	// 地板取「当前宽度」与 `MIN_PATTERN_COLS` 的较小值 —— 本来就只有 5 列的模式串没有可缩的空间
	const pieces = [fixed('Search "'), pattern("glass"), fixed('" in '), path(`${"y".repeat(60)}.ts`)];
	const result = shrinkPieces(pieces, 40, width);
	assert.equal(result.pieces[1]!.text, "glass", "短模式串不许被动");
	assert.ok(width(joinPieces(result.pieces)) <= 40, joinPieces(result.pieces));
});

test("shrinkPieces：没有可缩段时不动任何东西（超宽交给折行）", () => {
	const pieces = [fixed("Git status")];
	assert.deepEqual(shrinkPieces(pieces, 80, width).pieces, pieces);
	const long = [fixed("x".repeat(50))];
	const result = shrinkPieces(long, 10, width);
	assert.equal(result.overflow, true);
	assert.equal(result.pieces[0]!.text, "x".repeat(50), "固定段不许被改");
});
