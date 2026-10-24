/**
 * glob-tool / match —— 模式归一的纯函数测试（零 pi 依赖，`node --test` 直跑）。
 *
 * 这一文件的用例不是编出来的：每一条都对应一个实测过的 `path.matchesGlob` 行为
 * （见 spec §6），包括那个必须绕开的「段首点是特殊字符」规则。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/match.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatOutput, matchesPattern, normalizePattern, selectPaths } from "./match.ts";

test("normalizePattern：不含斜杠的模式隐式递归", () => {
	assert.equal(normalizePattern("*.ts"), "**/*.ts");
	assert.equal(normalizePattern("Makefile"), "**/Makefile");
	assert.equal(normalizePattern("*.{ts,js}"), "**/*.{ts,js}");
});

test("normalizePattern：显式 ./ 前缀表示只搜根层", () => {
	assert.equal(normalizePattern("./*.ts"), "*.ts");
	assert.equal(normalizePattern("./src/a.ts"), "src/a.ts");
});

test("normalizePattern：尾斜杠补 **，含斜杠的不动", () => {
	assert.equal(normalizePattern("src/"), "src/**");
	assert.equal(normalizePattern("src/**/*.ts"), "src/**/*.ts");
});

test("normalizePattern：** 与 * 不被二次加前缀", () => {
	// `**` 若走「不含斜杠就加 **/」会变 `**/**`：语义等价但逐字不等，测试钉逐字。
	assert.equal(normalizePattern("**"), "**");
	// `*` 变成 `**/*` 是**正确**的（任意深度的任意一项），这里钉住它。
	assert.equal(normalizePattern("*"), "**/*");
});

test("normalizePattern：反斜杠统一成正斜杠", () => {
	assert.equal(normalizePattern("src\\*.ts"), "src/*.ts");
	assert.equal(normalizePattern("src\\**\\*.ts"), "src/**/*.ts");
});

test("matchesPattern：轨道点文件参与匹配", () => {
	assert.ok(matchesPattern(".github/workflows/ci.yml", "**/*.yml"));
	assert.ok(matchesPattern("src/.env.example", "**/*.example"));
	assert.ok(matchesPattern(".gitignore", normalizePattern(".gitignore")));
	assert.ok(matchesPattern(".hid/x.ts", "**/*.ts"));
});

test("matchesPattern：递归与根层语义", () => {
	assert.ok(matchesPattern("README.md", normalizePattern("*.md")));
	assert.ok(matchesPattern("a/b/c/d.md", normalizePattern("*.md")));
	assert.ok(!matchesPattern("src/a.ts", normalizePattern("./*.ts")));
	assert.ok(matchesPattern("a.ts", normalizePattern("./*.ts")));
	assert.ok(matchesPattern("src/a.ts", "src/**/*.ts"));
	assert.ok(matchesPattern("src/x/y/a.ts", "src/**/*.ts"));
	assert.ok(!matchesPattern("lib/a.ts", "src/**/*.ts"));
});

test("matchesPattern：大括号与字符类", () => {
	assert.ok(matchesPattern("a.ts", normalizePattern("*.{ts,js}")));
	assert.ok(matchesPattern("a.js", normalizePattern("*.{ts,js}")));
	assert.ok(!matchesPattern("a.css", normalizePattern("*.{ts,js}")));
	assert.ok(matchesPattern("src/b.ts", "src/[a-c].ts"));
	assert.ok(!matchesPattern("src/d.ts", "src/[a-c].ts"));
	assert.ok(matchesPattern("src/a.ts", "src/?.ts"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2：候选过滤、排序与输出格式化
//
// `statMtime` 与 `truncate` 都由调用方注入 —— `match.ts` 因此保持零 pi 依赖、零文件系统
// 依赖，测试不需要真文件、也不需要真截断。注入边界正是"这条逻辑对不对"的分界线。
// ─────────────────────────────────────────────────────────────────────────────

test("selectPaths：默认路径升序，确定性", async () => {
	const r = await selectPaths({ candidates: ["b.ts", "a.ts", "c.ts"], pattern: "*.ts" });
	assert.deepEqual(r.paths, ["a.ts", "b.ts", "c.ts"]);
	assert.equal(r.skippedNewlines, 0);
	assert.equal(r.limitReached, undefined);
});

test("selectPaths：只保留匹配项，目录条目（尾斜杠）丢弃", async () => {
	const r = await selectPaths({ candidates: ["a.ts", "nested/", "b.js"], pattern: "*.ts" });
	assert.deepEqual(r.paths, ["a.ts"]);
});

test("selectPaths：含换行的路径跳过并计数", async () => {
	const r = await selectPaths({ candidates: ["ok.ts", "bad\nname.ts"], pattern: "*.ts" });
	assert.deepEqual(r.paths, ["ok.ts"]);
	assert.equal(r.skippedNewlines, 1);
});

test("selectPaths：limit 命中时报告 limitReached", async () => {
	const candidates = Array.from({ length: 5 }, (_, i) => `f${i}.ts`);
	const r = await selectPaths({ candidates, pattern: "*.ts", limit: 3 });
	assert.equal(r.paths.length, 3);
	assert.equal(r.limitReached, 3);
});

test("selectPaths：limit 恰好等于结果数时不算超限", async () => {
	const r = await selectPaths({ candidates: ["a.ts", "b.ts"], pattern: "*.ts", limit: 2 });
	assert.equal(r.paths.length, 2);
	assert.equal(r.limitReached, undefined);
});

test("selectPaths：limit 为 0 / 负数 / NaN 回落 1000", async () => {
	const candidates = Array.from({ length: 3 }, (_, i) => `f${i}.ts`);
	for (const bad of [0, -5, Number.NaN, 1.5]) {
		const r = await selectPaths({ candidates, pattern: "*.ts", limit: bad });
		assert.equal(r.paths.length, 3, `limit=${bad} 不该清空结果`);
	}
});

test("selectPaths：sortByMtime 降序，取不到 mtime 的项丢弃", async () => {
	const mtimes: Record<string, number | undefined> = { "a.ts": 100, "b.ts": 300, "c.ts": undefined };
	const r = await selectPaths({
		candidates: ["a.ts", "b.ts", "c.ts"],
		pattern: "*.ts",
		sortByMtime: true,
		statMtime: async (rel) => mtimes[rel],
	});
	assert.deepEqual(r.paths, ["b.ts", "a.ts"]);
});

test("selectPaths：sortByMtime 平手时按路径升序（确定性）", async () => {
	const r = await selectPaths({
		candidates: ["z.ts", "a.ts"],
		pattern: "*.ts",
		sortByMtime: true,
		statMtime: async () => 42,
	});
	assert.deepEqual(r.paths, ["a.ts", "z.ts"]);
});

test("formatOutput：纯路径列表没有 notices 时不加空行", () => {
	const out = formatOutput(["a.ts", "b.ts"], { skippedNewlines: 0 });
	assert.equal(out.text, "a.ts\nb.ts");
	assert.deepEqual(out.details, {});
});

test("formatOutput：limit 提示与跳过提示的文案", () => {
	const out = formatOutput(["a.ts"], { limitReached: 1000, skippedNewlines: 2 });
	assert.match(out.text, /^a\.ts\n\n\[1000 results limit reached\. Use limit=2000 for more, or refine pattern\]/);
	assert.match(out.text, /\[skipped 2 paths containing newlines\]/);
	assert.equal(out.details.resultLimitReached, 1000);
});

test("formatOutput：字节截断用注入的 truncate，提示带上限", () => {
	const out = formatOutput(
		["f0.ts", "f1.ts"],
		{ skippedNewlines: 0 },
		() => ({ content: "f0.ts", truncated: true, maxBytes: 51200 }),
	);
	assert.equal(out.text.split("\n")[0], "f0.ts");
	assert.match(out.text, /\[50\.0KB limit reached\]/);
	assert.equal(out.details.truncated, true);
});

test("formatOutput：两种限制同时命中时的顺序与分隔", () => {
	const out = formatOutput(
		["a.ts"],
		{ limitReached: 1000, skippedNewlines: 0 },
		() => ({ content: "a.ts", truncated: true, maxBytes: 51200 }),
	);
	assert.match(out.text, /\[1000 results limit reached[^\]]*\]\. \[50\.0KB limit reached\]/);
	assert.equal(out.details.resultLimitReached, 1000);
	assert.equal(out.details.truncated, true);
});

test("formatOutput：truncate 未截断时不加字节提示", () => {
	const out = formatOutput(["a.ts"], { skippedNewlines: 0 }, (text) => ({ content: text, truncated: false }));
	assert.equal(out.text, "a.ts");
	assert.equal(out.details.truncated, undefined);
});

test("selectPaths：路径序模式下也做存在性过滤（statMtime 返回 undefined 即丢弃）", async () => {
	// 回归：过滤曾经只写在 mtime 分支里，于是默认排序下 `git ls-files --cached` 里那些
	// "已 rm 但没 git add" 的名字会漏给模型。
	const r = await selectPaths({
		candidates: ["gone.ts", "stays.ts"],
		pattern: "*.ts",
		statMtime: async (rel) => (rel === "gone.ts" ? undefined : 1),
	});
	assert.deepEqual(r.paths, ["stays.ts"]);
});

test("matchesPattern：大括号里的点开头的备选也要能匹配（{.env,.env.*}）", () => {
	// 回归：`unhide` 原来只代理「段首字面 .」，`{.env,...}` 的段首是 `{`，于是 .env 永远匹配不上。
	assert.ok(matchesPattern(".env", normalizePattern("{.env,.env.*}")));
	assert.ok(matchesPattern(".env.local", normalizePattern("{.env,.env.*}")));
	// 字符类里的点同理（`[.]env`）
	assert.ok(matchesPattern(".env", normalizePattern("[.]env")));
	// 普通模式不能被这次改动碰坏
	assert.ok(matchesPattern("a.ts", normalizePattern("*.ts")));
	assert.ok(!matchesPattern("a.css", normalizePattern("*.{ts,js}")));
});
