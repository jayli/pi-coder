/**
 * glob-tool / ignore —— `.gitignore` 子集匹配器的纯函数测试。
 *
 * 这些用例对应 spec §5.3 的"保守方向"要求：**宁可多列（漏忽略），不可误剪（少列）**。
 * 少列会让模型以为文件不存在，是静默的错误；多列只是噪声。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/ignore.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createIgnoreDecider, createIgnoreMatcher } from "./ignore.ts";

test("ignore：注释与空行不生效", () => {
	const m = createIgnoreMatcher(["# comment", "", "*.log"]);
	assert.ok(m("a.log", false));
	assert.ok(!m("a.txt", false));
	assert.ok(!m("comment", false));
});

test("ignore：! 否定能救回文件（后出现者胜）", () => {
	const m = createIgnoreMatcher(["*.log", "!keep.log"]);
	assert.ok(m("a.log", false));
	assert.ok(!m("keep.log", false));
	// 顺序反过来：先否定后忽略 → 忽略胜
	const m2 = createIgnoreMatcher(["!keep.log", "*.log"]);
	assert.ok(m2("keep.log", false));
});

test("ignore：尾斜杠只匹配目录", () => {
	const m = createIgnoreMatcher(["build/"]);
	assert.ok(m("build", true));
	assert.ok(!m("build", false));
	// 目录规则要能剪掉它下面的所有东西 —— 由遍历层负责，这里只要求目录本身命中
	assert.ok(m("a/build", true));
});

test("ignore：不含斜杠的模式匹配任意层，含斜杠的锚定根", () => {
	const m = createIgnoreMatcher(["node_modules", "/dist"]);
	assert.ok(m("a/node_modules", true));
	assert.ok(m("node_modules", true));
	assert.ok(m("dist", true));
	assert.ok(!m("a/dist", true));
});

test("ignore：通配与大括号", () => {
	const m = createIgnoreMatcher(["*.min.js", "build-{a,b}/"]);
	assert.ok(m("dist/x.min.js", false));
	assert.ok(!m("dist/x.js", false));
	assert.ok(m("build-a", true));
	assert.ok(m("build-b", true));
	assert.ok(!m("build-c", true));
});

test("ignore：根层 / 前缀锚定不匹配更深一层", () => {
	const m = createIgnoreMatcher(["/top.txt"]);
	assert.ok(m("top.txt", false));
	assert.ok(!m("a/top.txt", false));
});

test("ignore：不认识的语法保守放行（不剪枝）", () => {
	// 未闭合的字符类：编译失败的规则必须被跳过，而不是匹配一切或抛异常
	const m = createIgnoreMatcher(["a[b"]);
	assert.doesNotThrow(() => m("a[b", false));
});

test("ignore：空规则表永远不命中", () => {
	const m = createIgnoreMatcher([]);
	assert.ok(!m("anything", false));
	assert.ok(!m("anything", true));
});

test("ignore：区分「没命中」与「命中并否定」（三态），父级忽略 + 子级否定要能救回", () => {
	// 回归：把两层合成一个布尔时，「本层否定」与「本层没命中」无法区分，
	// 于是父级的 `*.log` 会在子级 `!keep.log` 之后又被问一次、把 keep.log 剪掉。
	const m = createIgnoreMatcher(["*.log", "!keep.log"]);
	assert.equal(m("a.log", false), true);
	assert.equal(m("keep.log", false), false);
	assert.equal(m("other.ts", false), false);
	// 三态版本：`decide` 返回 true / false / undefined（无意见）
	assert.equal(createIgnoreDecider(["*.log"])("a.log", false), true);
	assert.equal(createIgnoreDecider(["!keep.log"])("keep.log", false), false);
	assert.equal(createIgnoreDecider(["*.md"])("a.ts", false), undefined);
});
