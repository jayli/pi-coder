/**
 * Tests for viewport.ts — 任务清单视口的滚动窗口算法。
 *
 * Run with:  node --test clients/pi/extensions/simple-task/viewport.test.ts
 *
 * 被测模块不 import pi / pi-tui（与 gap.ts 同一约定），所以纯代数断言就够。
 *
 * 规则（用户 2026-10-02 定）：窗口内**固定 8 条任务项**（两侧的 `… N more` 提示行另算，
 * 不占名额），锚点 = **第一个未完成项**，采用**最小位移滚动**：
 *   - 锚点已经在窗口内 → 窗口不动（不为了居中而乱滚）；
 *   - 锚点越出下沿 → 下滚到锚点正好落在窗口末行；
 *   - 滚到底也追不上（锚点太靠后）→ 窗口贴住底边；
 *   - 全部完成（没有未完成项）→ 窗口停在末尾，不跳回开头。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeViewport } from "./viewport.ts";
import type { Task, TaskStatus } from "./types.ts";

function task(id: number, status: TaskStatus): Task {
	return { id, text: `Task ${id}`, status };
}

/** 造 n 条任务：前 doneCount 条 done，其余 pending。 */
function tasks(n: number, doneCount = 0): Task[] {
	return Array.from({ length: n }, (_, index) => task(index + 1, index < doneCount ? "done" : "pending"));
}

describe("computeViewport", () => {
	it("任务数不超过视口时窗口就是全部任务，两侧都没有隐藏", () => {
		assert.deepEqual(computeViewport([task(1, "in_progress"), task(2, "pending"), task(3, "pending")]), {
			start: 0,
			end: 3,
			head: 0,
			tail: 0,
		});
	});

	it("默认视口是 8 项：13 条全 pending 时停在 #1..#8，只在下沿折叠 5 条", () => {
		assert.deepEqual(computeViewport(tasks(13)), { start: 0, end: 8, head: 0, tail: 5 });
	});

	it("前 10 项完成、第 11 项 in_progress → 窗口滚到 #4..#11", () => {
		const list = tasks(13, 10);
		list[10] = task(11, "in_progress");
		assert.deepEqual(computeViewport(list), { start: 3, end: 11, head: 3, tail: 2 });
	});

	it("第 11 项还没开始（pending）时窗口已经滚过去 —— 锚点是第一个未完成项", () => {
		assert.deepEqual(computeViewport(tasks(13, 10)), { start: 3, end: 11, head: 3, tail: 2 });
	});

	it("锚点还在窗口内时窗口不动（最小位移，不为了居中而滚）", () => {
		const list = tasks(20, 5);
		list[5] = task(6, "in_progress");
		assert.deepEqual(computeViewport(list), { start: 0, end: 8, head: 0, tail: 12 });
	});

	it("全部完成时窗口停在末尾 8 条，不跳回开头", () => {
		const list = tasks(13).map((item) => ({ ...item, status: "done" as TaskStatus }));
		assert.deepEqual(computeViewport(list), { start: 5, end: 13, head: 5, tail: 0 });
	});

	it("锚点靠近末尾时窗口贴住底边，不会滚过头", () => {
		const list = tasks(20, 19);
		list[19] = task(20, "in_progress");
		assert.deepEqual(computeViewport(list), { start: 12, end: 20, head: 12, tail: 0 });
	});

	it("视口宽度可调，窗口随 maxVisible 走", () => {
		const list = tasks(6, 3);
		list[3] = task(4, "in_progress");
		assert.deepEqual(computeViewport(list, 3), { start: 1, end: 4, head: 1, tail: 2 });
	});

	it("空列表返回空窗口", () => {
		assert.deepEqual(computeViewport([]), { start: 0, end: 0, head: 0, tail: 0 });
	});
});
