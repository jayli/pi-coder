/**
 * memory/context 的纯函数测试。
 *   node --test clients/pi/extensions/memory/context.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_DISCIPLINE, buildMemoryContext } from "./context.ts";
import type { MemoryEntry } from "./store.ts";

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

test("空库不注入", () => {
	const result = buildMemoryContext([]);
	assert.equal(result.text, undefined);
	assert.equal(result.totalCount, 0);
});

test("注入块 = 纪律 + 索引 + 工具指引", () => {
	const result = buildMemoryContext([entry()]);
	assert.ok(result.text !== undefined);
	assert.ok(result.text!.includes(MEMORY_DISCIPLINE));
	assert.ok(result.text!.includes("- [sample](sample.md) — project — a sample memory"));
	assert.ok(result.text!.includes("memory_read <name>"));
});

test("纪律文本带时态判据与读取端核实义务", () => {
	assert.ok(MEMORY_DISCIPLINE.includes("past-tense observations"));
	assert.ok(MEMORY_DISCIPLINE.includes("present-tense claims"));
	assert.ok(MEMORY_DISCIPLINE.includes("Verify it still exists"));
	assert.ok(MEMORY_DISCIPLINE.includes("secrets"));
});

test("超索引上限时附警告行", () => {
	const many = Array.from({ length: 250 }, (_, i) =>
		entry({ name: `m-${String(i).padStart(3, "0")}`, filename: `m-${String(i).padStart(3, "0")}.md` }),
	);
	const result = buildMemoryContext(many);
	assert.ok(result.text!.includes("WARNING"));
	assert.ok(result.droppedCount > 0);
});
