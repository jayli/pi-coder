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
 * 所以这里只钉状态行的五种形态与它们的色槽。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STATUS_KEY, type PlanTheme, formatPlanStatus } from "./render.ts";

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
