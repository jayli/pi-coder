/**
 * Tests for render.ts — memory 四个工具块的展示形态纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/memory/render.test.ts
 *
 * render.ts 不 import pi / pi-tui，所以这里直接断言结局分类、标题装饰、树前缀、预览截断
 * 这些**决定**（上色与折行在 index.ts 那侧，由 index.test.ts 走真加载器覆盖）。与
 * background-tasks/render.test.ts 同形。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BODY_INDENT,
	GUTTER_WIDTH,
	MEMORY_META_KEYS,
	PREVIEW_MAX_LINES,
	TREE_LAST,
	TREE_PIPE,
	classifyMemoryToolOutcome,
	memoryMetaKeyLength,
	memoryPreviewRows,
	memoryReadHeaderLineCount,
	memoryResultTreePrefixes,
	memoryToolTitleParts,
	previewMoreLinesHint,
} from "./render.ts";

describe("结局分类（读 details.action）", () => {
	it("isError 优先于 details 里的任何字段", () => {
		assert.equal(classifyMemoryToolOutcome(true, { action: "created" }), "error");
		assert.equal(classifyMemoryToolOutcome(true, undefined), "error");
	});

	it("rejected / blocked / not_found 算 declined（没办成但不是错）", () => {
		assert.equal(classifyMemoryToolOutcome(false, { action: "rejected" }), "declined");
		assert.equal(classifyMemoryToolOutcome(false, { action: "blocked" }), "declined");
		assert.equal(classifyMemoryToolOutcome(false, { action: "not_found" }), "declined");
	});

	it("成功 action 都算 success", () => {
		for (const action of ["created", "updated", "list", "read", "deleted", "search"]) {
			assert.equal(classifyMemoryToolOutcome(false, { action }), "success", `action=${action}`);
		}
	});

	it("details 缺失 / 非对象 / action 非字符串 → success（旧形状按成功画，见 render.ts）", () => {
		assert.equal(classifyMemoryToolOutcome(false, undefined), "success");
		assert.equal(classifyMemoryToolOutcome(false, null), "success");
		assert.equal(classifyMemoryToolOutcome(false, "not-an-object"), "success");
		assert.equal(classifyMemoryToolOutcome(false, { action: 42 }), "success");
		assert.equal(classifyMemoryToolOutcome(false, {}), "success");
	});
});

describe("标题装饰（工具块只有圆点、无任何标记）", () => {
	it("success → 绿点；declined / pending → 灰点；error → 红点", () => {
		assert.deepEqual(memoryToolTitleParts("success"), { dotSlot: "success" });
		assert.deepEqual(memoryToolTitleParts("declined"), { dotSlot: "dim" });
		assert.deepEqual(memoryToolTitleParts("pending"), { dotSlot: "dim" });
		assert.deepEqual(memoryToolTitleParts("error"), { dotSlot: "error" });
	});

	it("标题 parts 里没有标记字段（✔ / ✘ 都不属于工具块）", () => {
		for (const outcome of ["success", "declined", "pending", "error"] as const) {
			const parts = memoryToolTitleParts(outcome) as Record<string, unknown>;
			assert.deepEqual(Object.keys(parts), ["dotSlot"], `${outcome}：只有 dotSlot 一个字段`);
		}
	});
});

describe("树前缀", () => {
	it("0 行 → 空数组；1 行 → 只有 └；多行 → 除末行外 │", () => {
		assert.deepEqual(memoryResultTreePrefixes(0), []);
		assert.deepEqual(memoryResultTreePrefixes(1), [TREE_LAST]);
		assert.deepEqual(memoryResultTreePrefixes(3), [TREE_PIPE, TREE_PIPE, TREE_LAST]);
	});

	it("└ 只在末行出现一次", () => {
		const prefixes = memoryResultTreePrefixes(5);
		assert.equal(prefixes.filter((p) => p === TREE_LAST).length, 1);
		assert.equal(prefixes[4], TREE_LAST);
	});
});

describe("几何常量（与 plan / 后台任务块同一张表）", () => {
	it("• 列 0、│/└ 列 2、正文列 4（正文对齐工具名首字母 m）", () => {
		assert.equal(BODY_INDENT, "  ", "正文树前导缩进 2 列");
		assert.equal(BODY_INDENT.length, 2);
		assert.equal(GUTTER_WIDTH, 2, "树形 gutter 2 列（box-drawing 字符 + 空格）");
		assert.equal(TREE_PIPE, "│ ");
		assert.equal(TREE_LAST, "└ ");
	});
});

describe("元信息字段名着色段（syntaxKeyword）", () => {
	it("白名单就是结果头的那四个字段（顺序即渲染顺序）", () => {
		assert.deepEqual([...MEMORY_META_KEYS], ["name", "type", "modified", "description"]);
	});

	it("四个字段名返回 key + 冒号的长度", () => {
		assert.equal(memoryMetaKeyLength("name: one"), 5);
		assert.equal(memoryMetaKeyLength("type: project"), 5);
		assert.equal(memoryMetaKeyLength("modified: 2026-10-17T14:57:46.888Z"), 9);
		assert.equal(memoryMetaKeyLength("description: 一句话说明"), 12);
	});

	it("非字段行返回 0（正文 / 单句结果 / 缩进过的同形行）", () => {
		assert.equal(memoryMetaKeyLength("body line 1"), 0);
		assert.equal(memoryMetaKeyLength('No memory named "x".'), 0);
		assert.equal(memoryMetaKeyLength(""), 0);
		assert.equal(memoryMetaKeyLength("  name: indented"), 0, "行首必须是字段名");
		assert.equal(memoryMetaKeyLength("name = one"), 0, "必须是冒号");
		assert.equal(memoryMetaKeyLength("names: one"), 0, "白名单整词匹配，不是前缀");
		assert.equal(memoryMetaKeyLength("**Why:** 原因"), 0, "正文里别的同形行不入选");
	});
});

describe("折叠态预览预算（读一条只到 description）", () => {
	it("头行数 = 第一个空行之前的源行数", () => {
		assert.equal(memoryReadHeaderLineCount(["name: x", "type: user", "modified: t", "description: d", "", "body"]), 4);
		assert.equal(memoryReadHeaderLineCount(["name: x", "", "body"]), 1);
	});

	it("没有可分离的头 → 0（无空行 / 头前就是空行）", () => {
		assert.equal(memoryReadHeaderLineCount(['No memory named "x".']), 0, "单句结果没有空行");
		assert.equal(memoryReadHeaderLineCount(["", "name: x"]), 0, "第一个空行就在开头");
		assert.equal(memoryReadHeaderLineCount(["name: x", "type: user", ""]), 2, "只有头没正文时仍返回头行数，由 preview 判断不裁");
		assert.equal(memoryReadHeaderLineCount([]), 0);
	});

	it("头分离成立：预算 = 头行数，正文全算被裁", () => {
		assert.deepEqual(memoryPreviewRows(12, 4), { visibleRows: 4, hiddenRows: 8 });
		assert.deepEqual(memoryPreviewRows(12, 11), { visibleRows: 10, hiddenRows: 2 }, "头自己超上限时按上限裁头");
	});

	it("头分离不成立（headRows 为 0 / 等于总行数）：退回平铺口径", () => {
		assert.deepEqual(memoryPreviewRows(12, 0), { visibleRows: 10, hiddenRows: 2 });
		assert.deepEqual(memoryPreviewRows(3, 3), { visibleRows: 3, hiddenRows: 0 }, "只有头没正文：不裁、不出提示行");
		assert.deepEqual(memoryPreviewRows(3, 0), { visibleRows: 3, hiddenRows: 0 });
		assert.deepEqual(memoryPreviewRows(0, 0), { visibleRows: 0, hiddenRows: 0 });
	});
});

describe("预览截断提示", () => {
	it("与 pi 默认壳同族：… (N more lines, ctrl+o to expand)", () => {
		assert.equal(previewMoreLinesHint(1), "… (1 more line, ctrl+o to expand)");
		assert.equal(previewMoreLinesHint(4), "… (4 more lines, ctrl+o to expand)");
	});

	it("预览上限与 pi 默认壳的 FALLBACK_PREVIEW_LINES 同值", () => {
		assert.equal(PREVIEW_MAX_LINES, 10);
	});
});
