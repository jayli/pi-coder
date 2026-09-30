/**
 * Tests for render.ts — background-tasks 三个工具块 + 终态通知的展示形态纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/background-tasks/render.test.ts
 *
 * render.ts 不 import pi / pi-tui，所以这里直接断言结局分类、标题装饰、树前缀、预览截断
 * 这些**决定**（上色与折行在 index.ts 那侧，由 index.test.ts 走真加载器覆盖）。与
 * plan-mode/render.test.ts 同形。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BODY_INDENT,
	GUTTER_WIDTH,
	PREVIEW_MAX_LINES,
	TREE_LAST,
	TREE_PIPE,
	bgNotificationTitleParts,
	bgResultTreePrefixes,
	bgToolTitleParts,
	classifyBgNotificationOutcome,
	classifyBgToolOutcome,
	previewMoreLinesHint,
} from "./render.ts";

describe("工具块：结局分类（读 details.ok）", () => {
	it("isError 优先于 details 里的任何字段", () => {
		assert.equal(classifyBgToolOutcome(true, { ok: true }), "error");
		assert.equal(classifyBgToolOutcome(true, undefined), "error");
	});

	it("details.ok 严格为 true 才算成功", () => {
		assert.equal(classifyBgToolOutcome(false, { ok: true }), "success");
		assert.equal(classifyBgToolOutcome(false, { ok: true, task: { id: "bg_1" } }), "success");
	});

	it("其余都算 declined：ok:false / 无 details / 非对象 / 字符串 true", () => {
		assert.equal(classifyBgToolOutcome(false, { ok: false }), "declined");
		assert.equal(classifyBgToolOutcome(false, undefined), "declined");
		assert.equal(classifyBgToolOutcome(false, null), "declined");
		assert.equal(classifyBgToolOutcome(false, "not-an-object"), "declined");
		assert.equal(classifyBgToolOutcome(false, { ok: "true" }), "declined", "字符串 true 不算严格 true");
	});
});

describe("终态通知：结局分类（读 details.task）", () => {
	it("exit 0 → success", () => {
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: 0 }), "success");
	});

	it("被 kill / 非 0 退出 → error（与改形前的二值 failed 判定同语义）", () => {
		assert.equal(classifyBgNotificationOutcome({ status: "killed", signal: "SIGTERM" }), "error");
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: 1 }), "error");
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: 137, signal: "SIGKILL" }), "error");
	});

	it("task 缺失 / 形状认不出 → error（画红比画绿诚实）", () => {
		assert.equal(classifyBgNotificationOutcome(undefined), "error");
		assert.equal(classifyBgNotificationOutcome(null), "error");
		assert.equal(classifyBgNotificationOutcome("nope"), "error");
	});

	it("exitCode 非数字（还在跑 / 未知）且非 killed → success（不误报失败）", () => {
		assert.equal(classifyBgNotificationOutcome({ status: "exited" }), "success");
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: null }), "success");
	});
});

describe("工具块标题装饰（只有圆点、无任何标记）", () => {
	it("成功：只有绿点（任务才刚开始，✔ 只属于终态通知）", () => {
		assert.deepEqual(bgToolTitleParts("success"), { dotSlot: "success" });
	});

	it("没成但不是错：只有灰点（✘ 也不要：圆点已表达结局，正文里已写了原因）", () => {
		assert.deepEqual(bgToolTitleParts("declined"), { dotSlot: "dim" });
	});

	it("真错误：只有红点", () => {
		assert.deepEqual(bgToolTitleParts("error"), { dotSlot: "error" });
	});

	it("执行中：灰点", () => {
		assert.deepEqual(bgToolTitleParts("pending"), { dotSlot: "dim" });
	});
});

describe("终态通知标题装饰（只要结束就是 ✔，成败靠圆点颜色）", () => {
	it("成功：绿点 + 行末绿 ✔", () => {
		assert.deepEqual(bgNotificationTitleParts("success"), { dotSlot: "success", mark: "✔", markSlot: "success" });
	});

	it("失败：红点 + 行末**红 ✔**（不是 ✘：✔ 断言的是「结束」而非「成功」）", () => {
		assert.deepEqual(bgNotificationTitleParts("error"), { dotSlot: "error", mark: "✔", markSlot: "error" });
	});

	it("其余态（实际走不到）同样是 ✔，点色与工具块同源", () => {
		assert.deepEqual(bgNotificationTitleParts("declined"), { dotSlot: "dim", mark: "✔", markSlot: "dim" });
		assert.deepEqual(bgNotificationTitleParts("pending"), { dotSlot: "dim", mark: "✔", markSlot: "dim" });
	});

	it("四态都不会出现 ✘", () => {
		for (const outcome of ["success", "declined", "error", "pending"] as const) {
			assert.equal(bgNotificationTitleParts(outcome).mark, "✔", `${outcome} 应为 ✔`);
		}
	});
});

describe("树前缀（└ 跟到最后一行）", () => {
	it("0 行 → 空数组，1 行 → 单个 └", () => {
		assert.deepEqual(bgResultTreePrefixes(0), []);
		assert.deepEqual(bgResultTreePrefixes(1), [TREE_LAST]);
	});

	it("多行：除末行外全是 │，末行是 └", () => {
		assert.deepEqual(bgResultTreePrefixes(2), [TREE_PIPE, TREE_LAST]);
		assert.deepEqual(bgResultTreePrefixes(3), [TREE_PIPE, TREE_PIPE, TREE_LAST]);
		const five = bgResultTreePrefixes(5);
		assert.equal(five.length, 5);
		assert.equal(five[4], TREE_LAST);
		assert.ok(five.slice(0, 4).every((prefix) => prefix === TREE_PIPE));
	});
});

describe("几何常量（与 plan 块同一张表）", () => {
	it("正文缩进 2 列、gutter 2 列：• 列 0 / │└ 列 2 / 正文列 4", () => {
		assert.equal(BODY_INDENT, "  ");
		assert.equal(GUTTER_WIDTH, 2);
		assert.equal(BODY_INDENT.length + GUTTER_WIDTH, 4, "正文从列 4 起");
	});

	it("预览上限与 pi 默认壳的 FALLBACK_PREVIEW_LINES 同值（换 self 壳后截断不回归）", () => {
		assert.equal(PREVIEW_MAX_LINES, 10);
	});
});

describe("预览截断提示", () => {
	it("单数 / 复数分别拼 line / lines", () => {
		assert.equal(previewMoreLinesHint(1), "… (1 more line, ctrl+o to expand)");
		assert.equal(previewMoreLinesHint(12), "… (12 more lines, ctrl+o to expand)");
	});
});
