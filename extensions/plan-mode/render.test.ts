/**
 * Tests for render.ts — plan-mode 的状态行文案。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/render.test.ts
 *
 * render.ts 不 import pi / pi-tui：`plain` 主题丢掉颜色以便断言可见文本，`painted`
 * 主题把每段包成 `slot(text)` 以便断言用的是哪个语义色槽。
 *
 * 2026-09-24 起**没有步骤 widget 了**：计划是一份 markdown（没有可逐条打勾的步骤），
 * 进度归模型自己（它要建清单就 `task_set`，那是 simple-task 的 widget 该显示的事）。
 * 2026-09-27 起三态三色：dangerous 红（error）/ bypass 绿（success）/ plan 橙（warning）。
 * 2026-09-29 起补上工具调用块的形态断言：结局分类、标题装饰、树前缀（└ 跟到最后一行）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_KEY, TREE_LAST, TREE_PIPE, type PlanTheme, classifyPlanToolOutcome, formatPlanStatus, planResultTreePrefixes, planToolTitleParts } from "./render.ts";

const plain: PlanTheme = { fg: (_color, text) => text };
const painted: PlanTheme = { fg: (color, text) => `${color}(${text})` };

describe("状态行", () => {
	it("dangerous 态显示 ☢ dangerous（沙箱关闭，红色最醒目）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "dangerous" }), "☢ dangerous");
	});

	it("bypass 态显示 ⏵ bypass（这一格是模式指示，任何态都有文案）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "bypass" }), "⏵ bypass");
	});

	it("bypass 态即使残留了计划字段也保持显示（不是只在切换时才画）", () => {
		assert.equal(formatPlanStatus(plain, { phase: "bypass", pending: "残留计划" }), "⏵ bypass");
		assert.equal(formatPlanStatus(plain, { phase: "bypass", docWriting: true }), "⏵ bypass");
	});

	it("plan 态：等待模型提交时只显示 ⏸ plan", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan" }), "⏸ plan");
	});

	it("plan 态：计划已提交、等用户审批时带「待批准」", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan", pending: "# 方案" }), "⏸ plan · 待批准");
	});

	it("plan 态：写文档子态带「写文档中」，且优先于「待批准」", () => {
		assert.equal(formatPlanStatus(plain, { phase: "plan", docWriting: true }), "⏸ plan · 写文档中");
		assert.equal(
			formatPlanStatus(plain, { phase: "plan", docWriting: true, pending: "# 方案" }),
			"⏸ plan · 写文档中",
			"子态里 pending 仍在（写文档指令要用它），但状态行该说正在写文档",
		);
	});

	it("色槽：dangerous 走 error（红），bypass 走 success（绿），plan 走 warning（橙），子态尾巴走 accent", () => {
		assert.equal(formatPlanStatus(painted, { phase: "dangerous" }), "error(☢) error(dangerous)");
		assert.equal(formatPlanStatus(painted, { phase: "bypass" }), "success(⏵) success(bypass)");
		assert.equal(formatPlanStatus(painted, { phase: "plan" }), "warning(⏸) warning(plan)");
		assert.equal(formatPlanStatus(painted, { phase: "plan", pending: "x" }), "warning(⏸) warning(plan) muted(· 待批准)");
		assert.equal(
			formatPlanStatus(painted, { phase: "plan", docWriting: true }),
			"warning(⏸) warning(plan) accent(· 写文档中)",
		);
	});

	it("bypass 态不用 dim/muted（改回静息色会让它又看不见）", () => {
		const rendered = formatPlanStatus(painted, { phase: "bypass" });
		assert.ok(!rendered.includes("dim("), rendered);
		assert.ok(!rendered.includes("muted("), rendered);
	});

	it("bypass 不再用红色（红色让给 dangerous：2026-09-27 三态化）", () => {
		const rendered = formatPlanStatus(painted, { phase: "bypass" });
		assert.ok(!rendered.includes("toolDiffRemoved("), rendered);
		assert.ok(!rendered.includes("error("), rendered);
	});

	it("setStatus 的键固定为 plan-mode（statusline 第二行按注册顺序拼接，键数越少越好）", () => {
		assert.equal(STATUS_KEY, "plan-mode");
	});
});

describe("工具调用块：结局分类", () => {
	it("isError 优先于 details 里的任何字段", () => {
		assert.equal(classifyPlanToolOutcome(true, { consented: true }), "error");
		assert.equal(classifyPlanToolOutcome(true, { accepted: true }), "error");
		assert.equal(classifyPlanToolOutcome(true, undefined), "error");
	});

	it("consented / accepted 严格为 true 才算成功", () => {
		assert.equal(classifyPlanToolOutcome(false, { consented: true }), "success");
		assert.equal(classifyPlanToolOutcome(false, { phase: "plan", consented: true }), "success");
		assert.equal(classifyPlanToolOutcome(false, { accepted: true, docMode: "execute-with-doc", docPath: "/x.md" }), "success");
	});

	it("其余都算 declined：被否 / 被 brainstorming 闸拦 / 被打回 / 空计划 / 不在 plan 态 / 无 details", () => {
		assert.equal(classifyPlanToolOutcome(false, { phase: "plan", consented: false }), "declined");
		assert.equal(classifyPlanToolOutcome(false, { phase: "plan", brainstorming: true, consented: false }), "declined");
		assert.equal(classifyPlanToolOutcome(false, { accepted: false, phase: "plan" }), "declined");
		assert.equal(classifyPlanToolOutcome(false, { accepted: false, phase: "plan", docWriting: true }), "declined");
		assert.equal(classifyPlanToolOutcome(false, undefined), "declined");
		assert.equal(classifyPlanToolOutcome(false, null), "declined");
		assert.equal(classifyPlanToolOutcome(false, "not-an-object"), "declined");
		assert.equal(classifyPlanToolOutcome(false, { consented: "true" }), "declined", "字符串 true 不算严格 true");
	});
});

describe("工具调用块：标题装饰", () => {
	it("成功：绿点 + 绿 ✔", () => {
		assert.deepEqual(planToolTitleParts("success"), { dotSlot: "success", mark: "✔", markSlot: "success" });
	});

	it("没成但不是错：灰点 + 灰 ✘", () => {
		assert.deepEqual(planToolTitleParts("declined"), { dotSlot: "dim", mark: "✘", markSlot: "dim" });
	});

	it("真错误：红点 + 红 ✘", () => {
		assert.deepEqual(planToolTitleParts("error"), { dotSlot: "error", mark: "✘", markSlot: "error" });
	});

	it("执行中：灰点、无标记", () => {
		assert.deepEqual(planToolTitleParts("pending"), { dotSlot: "dim", mark: "" });
	});
});

describe("工具调用块：树前缀（└ 跟到最后一行）", () => {
	it("0 行 → 空数组，1 行 → 单个 └", () => {
		assert.deepEqual(planResultTreePrefixes(0), []);
		assert.deepEqual(planResultTreePrefixes(1), [TREE_LAST]);
	});

	it("多行：除末行外全是 │，末行是 └", () => {
		assert.deepEqual(planResultTreePrefixes(2), [TREE_PIPE, TREE_LAST]);
		assert.deepEqual(planResultTreePrefixes(3), [TREE_PIPE, TREE_PIPE, TREE_LAST]);
		const five = planResultTreePrefixes(5);
		assert.equal(five.length, 5);
		assert.equal(five[4], TREE_LAST);
		assert.ok(five.slice(0, 4).every((prefix) => prefix === TREE_PIPE));
	});
});
