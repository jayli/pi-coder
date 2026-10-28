/**
 * glob-tool / render —— 标题与结果正文的**纯格式化**。零 pi 依赖。
 *
 * 两个函数都返回**结构**（哪一段是什么），不返回上过色的字符串：着色必须由 `index.ts`
 * 用 pi 的 `theme` 做 —— 本目录 import 到的是 loader alias 指向的 npm/dist 副本，而 pi
 * 运行时用的是 bundle 那份，两个模块实例的 theme 单例互不相通（`read-path-collapse.ts`
 * 文件头记过这个坑）。把着色留在 `index.ts`、把"哪一段是什么"留在这里，`node --test`
 * 才能直接跑本文件。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/render.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatGlobBody, formatGlobTitle } from "./render.ts";

/** 测试里用的简单 shortenPath：有值就原样返回，无值返回 null。 */
const identity = (value: string | undefined): string | null => (value === undefined || value === "" ? null : value);

test("formatGlobTitle：有 path", () => {
	const r = formatGlobTitle({ pattern: "**/*.ts", path: "src" }, identity);
	assert.deepEqual(r, { pattern: "**/*.ts", where: "src" });
});

test("formatGlobTitle：无 path 时 where 为 null（渲染成 cwd 的简写）", () => {
	assert.deepEqual(formatGlobTitle({ pattern: "*.md" }, identity), { pattern: "*.md", where: null });
});

test("formatGlobTitle：pattern 缺失或空串当 null（参数还在流）", () => {
	assert.deepEqual(formatGlobTitle({}, identity), { pattern: null, where: null });
	assert.deepEqual(formatGlobTitle({ pattern: "" }, identity), { pattern: null, where: null });
	assert.deepEqual(formatGlobTitle({ pattern: "   " }, identity), { pattern: null, where: null });
});

test("formatGlobBody：折叠到 20 行并报剩余行数", () => {
	const text = Array.from({ length: 25 }, (_, i) => `f${i}.ts`).join("\n");
	const r = formatGlobBody(text, { expanded: false, expandKey: "ctrl+o" });
	assert.equal(r.lines.length, 20);
	assert.equal(r.moreLines, 5);
	assert.equal(r.expandHint, "... (5 more lines, ctrl+o to expand)");
	assert.equal(r.warning, null);
});

test("formatGlobBody：恰好 20 行不产生提示", () => {
	const text = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join("\n");
	const r = formatGlobBody(text, { expanded: false, expandKey: "ctrl+o" });
	assert.equal(r.lines.length, 20);
	assert.equal(r.moreLines, 0);
	assert.equal(r.expandHint, null);
});

test("formatGlobBody：expanded 时不折叠也没有提示", () => {
	const text = Array.from({ length: 25 }, (_, i) => `f${i}.ts`).join("\n");
	const r = formatGlobBody(text, { expanded: true, expandKey: "ctrl+o" });
	assert.equal(r.lines.length, 25);
	assert.equal(r.moreLines, 0);
	assert.equal(r.expandHint, null);
});

test("formatGlobBody：截断警告只报 limit（CC 的 Showing 行已在正文里，只进 details）", () => {
	const r = formatGlobBody("a.ts", { expanded: false, expandKey: "ctrl+o", limit: 100 });
	assert.equal(r.warning, "[Truncated: 100 results limit]");
});

test("formatGlobBody：截断警告两项都报", () => {
	const r = formatGlobBody("a.ts", { expanded: false, expandKey: "ctrl+o", limit: 100, truncated: true });
	assert.equal(r.warning, "[Truncated: 100 results limit, 50.0KB limit]");
});

test("formatGlobBody：空结果不产生空行数组", () => {
	const r = formatGlobBody("", { expanded: false, expandKey: "ctrl+o" });
	assert.deepEqual(r.lines, []);
	assert.equal(r.expandHint, null);
});

test("formatGlobBody：不去掉尾随空行（正文原样切分）", () => {
	// 只剥首尾整段空白行会让"最后一个路径"和提示行之间少一行，与内置 find 不一致。
	const r = formatGlobBody("a.ts\nb.ts\n", { expanded: false, expandKey: "ctrl+o" });
	assert.deepEqual(r.lines, ["a.ts", "b.ts"]);
});

test("formatGlobBody：CC 形状的 Showing 行不会被误判成路径", () => {
	// 折叠态最后一行可能就是这句提示；它只是正文的一行，照常列出（不剥）。
	const text = `a.ts\n(Showing 1 of 142 matching files; 141 more are not listed. Narrow the pattern or path to see the rest.)`;
	const r = formatGlobBody(text, { expanded: false, expandKey: "ctrl+o", limit: 100 });
	assert.equal(r.lines.length, 2);
	assert.match(r.lines[1]!, /^\(Showing 1 of 142 matching files/);
	assert.equal(r.warning, "[Truncated: 100 results limit]");
});
