/**
 * memory/store 的纯函数测试。
 *   node --test clients/pi/extensions/memory/store.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	INDEX_MAX_LINES,
	buildIndex,
	findProjectRoot,
	isValidMemoryName,
	loadMemories,
	parseFrontmatter,
	resolveMemoryDir,
	searchMemories,
	serializeMemoryFile,
	slugifyPath,
	truncateDescription,
	type MemoryEntry,
} from "./store.ts";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		name: "sample",
		description: "a sample memory",
		type: "project",
		modified: "2026-09-26T00:00:00.000Z",
		body: "the body",
		filename: "sample.md",
		...overrides,
	};
}

test("slugifyPath 把 / 与 . 换成 -", () => {
	assert.equal(slugifyPath("/Users/bachi/jaylli/litellm-any"), "-Users-bachi-jaylli-litellm-any");
	assert.equal(slugifyPath("/a.b/c.d"), "-a-b-c-d");
});

test("findProjectRoot 找到 git 根；非 git 目录返回自身", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-root-"));
	const nested = path.join(tmp, "a", "b");
	fs.mkdirSync(nested, { recursive: true });
	// 无 .git：返回传入目录本身
	assert.equal(findProjectRoot(nested), nested);
	// 有 .git：返回 git 根
	fs.mkdirSync(path.join(tmp, ".git"));
	assert.equal(findProjectRoot(nested), tmp);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveMemoryDir 用 PI_MEMORY_DIR 覆盖根，slug 仍生效", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-base-"));
	const proj = path.join(tmp, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const dir = resolveMemoryDir(proj, { PI_MEMORY_DIR: "/custom/root" } as NodeJS.ProcessEnv);
	assert.equal(dir, path.join("/custom/root", slugifyPath(proj)));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("isValidMemoryName 接受 kebab-case，拒绝路径成分", () => {
	assert.ok(isValidMemoryName("gitlab-push-rule"));
	assert.ok(isValidMemoryName("a1"));
	assert.ok(!isValidMemoryName("Bad_Name"));
	assert.ok(!isValidMemoryName("../etc"));
	assert.ok(!isValidMemoryName("a/b"));
	assert.ok(!isValidMemoryName(""));
});

test("frontmatter 往返：序列化后能解析回来", () => {
	const text = serializeMemoryFile({
		name: "x",
		description: "desc",
		type: "feedback",
		modified: "2026-09-26T01:02:03.000Z",
		body: "line one\nline two",
	});
	const { fields, body } = parseFrontmatter(text);
	assert.equal(fields.name, "x");
	assert.equal(fields.description, "desc");
	assert.equal(fields.type, "feedback");
	assert.equal(fields.modified, "2026-09-26T01:02:03.000Z");
	assert.equal(body, "line one\nline two");
});

test("parseFrontmatter 无 frontmatter 时原样返回 body", () => {
	const { fields, body } = parseFrontmatter("just text");
	assert.deepEqual(fields, {});
	assert.equal(body, "just text");
});

test("truncateDescription 压成一行并截断", () => {
	assert.equal(truncateDescription("  a\n\nb  "), "a b");
	const long = "x".repeat(200);
	const out = truncateDescription(long, 150);
	assert.ok(out.length <= 150);
	assert.ok(out.endsWith("…"));
});

test("buildIndex 每条一行，超限截断并报告 dropped", () => {
	const many = Array.from({ length: INDEX_MAX_LINES + 10 }, (_, i) =>
		entry({ name: `m-${String(i).padStart(3, "0")}`, filename: `m-${String(i).padStart(3, "0")}.md` }),
	);
	const result = buildIndex(many);
	assert.ok(result.droppedCount > 0);
	assert.equal(result.totalCount, many.length);
	const dataLines = result.content.split("\n").filter((l) => l.startsWith("- "));
	assert.ok(dataLines.length <= INDEX_MAX_LINES);
});

test("loadMemories 跳过索引与隐藏文件，损坏文件不炸", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mem-load-"));
	fs.writeFileSync(path.join(tmp, "MEMORY.md"), "# index");
	fs.writeFileSync(path.join(tmp, ".hidden.md"), "x");
	fs.writeFileSync(
		path.join(tmp, "good.md"),
		serializeMemoryFile({ name: "good", description: "d", type: "user", modified: "2026-01-01T00:00:00.000Z", body: "b" }),
	);
	fs.writeFileSync(path.join(tmp, "broken.md"), "---\nname: broken\n"); // 未闭合 frontmatter
	const entries = loadMemories(tmp);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].name, "good");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("searchMemories 按 frontmatter 加权命中", () => {
	const entries = [
		entry({ name: "alpha", description: "gitlab push rule", body: "about email" }),
		entry({ name: "beta", description: "unrelated", body: "mentions gitlab deep in body" }),
	];
	const hits = searchMemories(entries, "gitlab");
	assert.equal(hits.length, 2);
	assert.equal(hits[0].name, "alpha"); // description 命中权重更高
	assert.deepEqual(searchMemories(entries, ""), []);
});
