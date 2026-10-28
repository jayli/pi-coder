/**
 * goal.ts 的验证：纯状态机，直接 `node --test`。
 *
 *   node --test clients/pi/extensions/verify-loop/goal.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_LOOP_CUSTOM_TYPE, type GateMessage } from "./gate.ts";
import {
	applyVerdict,
	clearGoal,
	CLEAR_ALIASES,
	countContinuations,
	countNoProgressStreak,
	decideGoalGate,
	DEFAULT_GOAL_CAP,
	emptyGoal,
	GOAL_ENTRY_TYPE,
	hasGoal,
	MAX_CONDITION_CHARS,
	NO_PROGRESS_LIMIT,
	reconstructGoal,
	renderStatus,
	setGoal,
	toEntryData,
	type GoalState,
} from "./goal.ts";

// =============================================================================
// 构造投影消息的辅助函数
// =============================================================================

function user(text: string): GateMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolCalls(...calls: Array<{ name: string; args?: Record<string, unknown> }>): GateMessage {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({
			type: "toolCall",
			id: `call-${index}-${call.name}`,
			name: call.name,
			arguments: call.args ?? {},
		})),
	};
}

function assistantText(text: string): GateMessage {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function injected(kind: string): GateMessage {
	return { role: "custom", customType: VERIFY_LOOP_CUSTOM_TYPE, content: "...", details: { kind, at: 1 } };
}

const config = { cap: DEFAULT_GOAL_CAP };

function activeGoal(condition = "所有测试通过"): GoalState {
	return setGoal(condition, 1_700_000_000_000);
}

// =============================================================================
// setGoal / clearGoal / hasGoal
// =============================================================================

test("setGoal: 条件截断到 CC 的 4000 字符上限", () => {
	const state = setGoal("x".repeat(MAX_CONDITION_CHARS + 100), 1);
	assert.equal(state.condition.length, MAX_CONDITION_CHARS);
	assert.equal(state.status, "active");
	assert.equal(state.evaluatedTurns, 0);
});

test("clearGoal: 回到空状态，hasGoal 为假", () => {
	assert.equal(hasGoal(activeGoal()), true);
	assert.equal(hasGoal(clearGoal()), false);
});

test("CLEAR_ALIASES: CC 的 stop/off/reset/none/cancel 都在", () => {
	for (const alias of ["clear", "stop", "off", "reset", "none", "cancel"]) {
		assert.equal(CLEAR_ALIASES.has(alias), true, alias);
	}
});

// =============================================================================
// applyVerdict
// =============================================================================

test("applyVerdict: not_met 留在 active、评估轮数 +1", () => {
	const state = applyVerdict(activeGoal(), "not_met", "测试还没跑");
	assert.equal(state.status, "active");
	assert.equal(state.evaluatedTurns, 1);
	assert.equal(state.lastVerdict, "not_met");
	assert.equal(state.lastReason, "测试还没跑");
	assert.equal(hasGoal(state), true);
});

test("applyVerdict: met → achieved，不再评估", () => {
	const state = applyVerdict(activeGoal(), "met", "测试输出显示全过");
	assert.equal(state.status, "achieved");
	assert.equal(hasGoal(state), false);
});

test("applyVerdict: impossible → impossible，不再评估", () => {
	const state = applyVerdict(activeGoal(), "impossible", "目标文件不存在");
	assert.equal(state.status, "impossible");
	assert.equal(hasGoal(state), false);
});

// =============================================================================
// decideGoalGate：计数全部从投影推导
// =============================================================================

test("decideGoalGate: 没有 goal → none", () => {
	assert.deepEqual(decideGoalGate(emptyGoal(), [user("a")], config), { action: "none" });
});

test("decideGoalGate: goal 已达成 → none", () => {
	const state = applyVerdict(activeGoal(), "met", "done");
	assert.deepEqual(decideGoalGate(state, [user("a")], config), { action: "none" });
});

test("decideGoalGate: 正常可评估", () => {
	const messages = [user("a"), assistantToolCalls({ name: "bash", args: { command: "npm test" } })];
	const gate = decideGoalGate(activeGoal(), messages, config);
	assert.equal(gate.action, "evaluate");
	if (gate.action === "evaluate") {
		assert.equal(gate.continuations, 0);
		assert.equal(gate.toolCallCount, 1);
	}
});

test("countContinuations: 数 run 窗口里的 goal-not-met 注入", () => {
	const messages = [user("a"), injected("goal-not-met"), assistantText("继续"), injected("goal-not-met"), assistantText("再试")];
	assert.equal(countContinuations(messages), 2);
});

test("decideGoalGate: 续跑次数到上限 → cap（CC 的 8 次强制放行）", () => {
	const messages = [user("a")];
	for (let i = 0; i < DEFAULT_GOAL_CAP; i += 1) {
		messages.push(injected("goal-not-met"), assistantText("继续"));
	}
	const gate = decideGoalGate(activeGoal(), messages, config);
	assert.equal(gate.action, "cap");
});

test("countNoProgressStreak: 初始轮不算（设定 goal 的那轮）", () => {
	const messages = [user("a"), assistantText("我觉得已经完成了")];
	assert.equal(countNoProgressStreak(messages), 0);
});

test("countNoProgressStreak: 被打回后只回文字 → 1", () => {
	const messages = [user("a"), injected("goal-not-met"), assistantText("我觉得已经完成了")];
	assert.equal(countNoProgressStreak(messages), 1);
});

test("countNoProgressStreak: 被打回后用了工具 → 0", () => {
	const messages = [
		user("a"),
		injected("goal-not-met"),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
	];
	assert.equal(countNoProgressStreak(messages), 0);
});

test("countNoProgressStreak: 连续两轮无工具 → 2", () => {
	const messages = [
		user("a"),
		injected("goal-not-met"),
		assistantText("完成了"),
		injected("goal-not-met"),
		assistantText("真的完成了"),
	];
	assert.equal(countNoProgressStreak(messages), 2);
});

test("countNoProgressStreak: 中间一轮用了工具 → 只数最后那段", () => {
	const messages = [
		user("a"),
		injected("goal-not-met"),
		assistantToolCalls({ name: "bash", args: { command: "npm test" } }),
		injected("goal-not-met"),
		assistantText("完成了"),
	];
	assert.equal(countNoProgressStreak(messages), 1);
});

test("decideGoalGate: 连续无进展到上限 → halt（goal 保留）", () => {
	const messages = [user("a")];
	for (let i = 0; i < NO_PROGRESS_LIMIT; i += 1) {
		messages.push(injected("goal-not-met"), assistantText("完成了"));
	}
	const gate = decideGoalGate(activeGoal(), messages, config);
	assert.equal(gate.action, "halt");
	if (gate.action === "halt") assert.equal(gate.streak, NO_PROGRESS_LIMIT);
});

// =============================================================================
// 会话条目重建（appendEntry → getBranch()）
// =============================================================================

test("reconstructGoal: 从分支条目取最后一条快照", () => {
	const entries = [
		{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(setGoal("旧条件", 1)) },
		{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(setGoal("新条件", 2)) },
		{ type: "custom", customType: "simple-task-state", data: {} },
	];
	const state = reconstructGoal(entries);
	assert.equal(state.condition, "新条件");
	assert.equal(state.status, "active");
});

test("reconstructGoal: 已达成/已不可能的 goal 不恢复（CC 语义）", () => {
	const achieved = applyVerdict(setGoal("条件", 1), "met", "done");
	assert.equal(reconstructGoal([{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(achieved) }]).condition, "");
	const impossible = applyVerdict(setGoal("条件", 1), "impossible", "nope");
	assert.equal(reconstructGoal([{ type: "custom", customType: GOAL_ENTRY_TYPE, data: toEntryData(impossible) }]).condition, "");
});

test("reconstructGoal: 轮数计时重置（CC：resume resets the turn count）", () => {
	const entries = [{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { ...toEntryData(setGoal("条件", 1)), evaluatedTurns: 5 } }];
	const state = reconstructGoal(entries);
	assert.equal(state.condition, "条件");
	assert.equal(state.evaluatedTurns, 0);
	assert.equal(state.lastVerdict, undefined);
	// 续跑/无进展计数从投影数，与重建无关
	const messages = [user("a"), injected("goal-not-met")];
	assert.equal(countContinuations(messages), 1);
});

test("reconstructGoal: 无条目 / 空条件 → 空状态", () => {
	assert.equal(reconstructGoal([]).condition, "");
	assert.equal(reconstructGoal([{ type: "custom", customType: GOAL_ENTRY_TYPE, data: { condition: "" } }]).condition, "");
});

// =============================================================================
// renderStatus
// =============================================================================

test("renderStatus: 无 goal 时给用法提示", () => {
	assert.match(renderStatus(emptyGoal(), 0, config, 0), /No \/goal is set/);
});

test("renderStatus: 有 goal 时给条件与计数", () => {
	const text = renderStatus(activeGoal("所有测试通过"), 1_700_000_120_000, config, 3);
	assert.match(text, /所有测试通过/);
	assert.match(text, /3\/8 auto-continuations/);
	assert.match(text, /0 evaluations/);
});
