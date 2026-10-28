/**
 * goal.ts — /goal 的纯状态机：设定 / 清除 / 从会话条目重建 / 本轮该不该评估。
 *
 * CC 原型（code.claude.com/docs/en/goal，已核实）：
 *   - `/goal <条件>` 设定一个**会话级**完成条件，一个会话同时只有一个 goal；
 *     设定即立刻起一轮（"Setting a goal starts a turn immediately"）。
 *   - 此后**每次回合结束自动**评估：把条件 + 到目前为止的对话发给小快模型，
 *     三裁决 —— 未达成（继续干，reason 当下一轮指导）/ 达成（清除并记录）/
 *     不可能（清除并记录失败）。
 *   - 防呆：连续几轮模型只用文字回应、不调任何工具 = 无进展 → 停循环、警告、
 *     **goal 保留**（"stops the loop, prints a warning, and returns control to you
 *     with the goal still set"）；后台有子代理/后台命令在跑 → 本轮跳过评估。
 *   - resume 恢复 goal 但**重置轮数计时**；`/goal clear` 清除；`/clear` 新会话清除。
 *   - 条件上限 4000 字符。
 *
 * ## 计数器为什么从投影里数，而不是内存态
 *
 * 与 gate.ts 同一个理由：`agent_start` 在每次边界续跑时都会再 fire 一次
 * （`runAgentLoopContinue` 里 `emit({type:"agent_start"})`），任何挂在 agent_start
 * 上的复位都会在续跑链里把计数清零，上限失效。所以「已续跑几次」「连续几轮无进展」
 * 都从投影里已有的注入消息数出来 —— 天然分支正确、resume 后仍正确、无可变状态。
 *
 * 持久化的只有 goal 本身（条件 + 状态 + 已评估轮数 + 最近裁决），走 `pi.appendEntry`
 * （simple-task / plan-mode 同款），`session_start` 从 `getBranch()` 重建 ——
 * 于是 resume 自然恢复、新会话自然清除，对应 CC 的 resume 语义。
 *
 * 本文件不 import pi，全部纯函数，可 `node --test` 直测。
 */

import { countInjected, findRunStart, scanRun, VERIFY_LOOP_CUSTOM_TYPE, type GateMessage } from "./gate.ts";

/** 评估器的三种裁决（CC 的 not yet met / met / impossible）。 */
export type Verdict = "met" | "not_met" | "impossible";

/** goal 的生命周期状态（持久化的那部分）。 */
export type GoalStatus = "active" | "achieved" | "impossible";

export interface GoalState {
	/** 用户给的完成条件原文；空串 = 没有 goal。 */
	condition: string;
	/** 设定时刻（ms）。 */
	setAt: number;
	status: GoalStatus;
	/** 已经评估过几轮（CC status 里的 "how many turns have been evaluated"）。 */
	evaluatedTurns: number;
	/** 最近一次裁决与理由（CC status 里的 "the evaluator's most recent reason"）。 */
	lastVerdict?: Verdict;
	lastReason?: string;
}

/** 空状态：没有 goal。 */
export function emptyGoal(): GoalState {
	return { condition: "", setAt: 0, status: "active", evaluatedTurns: 0 };
}

/** 有没有一个还在跑的 goal（达成/不可能之后为假，不再评估）。 */
export function hasGoal(state: GoalState): boolean {
	return state.condition !== "" && state.status === "active";
}

/** CC 的条件长度上限。 */
export const MAX_CONDITION_CHARS = 4000;

/** 连续无工具调用的轮数上限（CC："no tool use for several turns in a row"）。 */
export const NO_PROGRESS_LIMIT = 2;

/** 强制续跑上限（CC 的 Stop-hook block cap 默认值）。 */
export const DEFAULT_GOAL_CAP = 8;

export interface GoalConfig {
	/** 强制续跑上限。 */
	cap: number;
}

/** /goal clear 接受的别名（CC：stop / off / reset / none / cancel）。 */
export const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** 设定 goal：新条件替换旧的（CC："If a goal is already active, the new one replaces it"）。 */
export function setGoal(condition: string, now: number): GoalState {
	return {
		condition: condition.slice(0, MAX_CONDITION_CHARS),
		setAt: now,
		status: "active",
		evaluatedTurns: 0,
	};
}

/** 清除 goal。 */
export function clearGoal(): GoalState {
	return emptyGoal();
}

/** 应用裁决后的新状态（达成/不可能即清除，CC："clears the goal and records an entry"）。 */
export function applyVerdict(state: GoalState, verdict: Verdict, reason: string): GoalState {
	const evaluatedTurns = state.evaluatedTurns + 1;
	if (verdict === "met") return { ...state, status: "achieved", evaluatedTurns, lastVerdict: verdict, lastReason: reason };
	if (verdict === "impossible") return { ...state, status: "impossible", evaluatedTurns, lastVerdict: verdict, lastReason: reason };
	return { ...state, status: "active", evaluatedTurns, lastVerdict: verdict, lastReason: reason };
}

// =============================================================================
// 本轮该不该评估（全部从投影推导）
// =============================================================================

export type GoalGateAction =
	/** 没有活跃 goal。 */
	| { action: "none" }
	/** 续跑次数到上限：停循环、把控制权交还用户、goal 保留。 */
	| { action: "cap"; continuations: number }
	/** 连续几轮没有工具调用：停循环、警告、goal 保留（CC 的无进展检测）。 */
	| { action: "halt"; streak: number }
	/** 可以评估。 */
	| { action: "evaluate"; continuations: number; toolCallCount: number };

/**
 * 已续跑几次 = run 窗口里 `goal-not-met` 注入消息的条数。
 */
export function countContinuations(messages: readonly GateMessage[]): number {
	return countInjected(messages, "goal-not-met");
}

/**
 * 连续几轮「没有任何工具调用」。
 *
 * 把 run 窗口按 `goal-not-met` 注入点切成段：每个注入点之后到下一个注入点 = 一次续跑轮。
 * 从最后一段往前数，直到遇到一段里有工具调用为止。
 *
 * 第一个段（任何注入之前）不算 —— 那是设定 goal 的初始轮，无进展检测只针对
 * 「被评估器打回去之后」的续跑轮（CC："If Claude keeps answering the evaluator
 * without making progress (no tool use for several turns in a row)"）。
 */
export function countNoProgressStreak(messages: readonly GateMessage[]): number {
	const runStart = findRunStart(messages);
	const marks: number[] = [];
	for (let i = runStart + 1; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role !== "custom" || message.customType !== VERIFY_LOOP_CUSTOM_TYPE) continue;
		const details = message.details as { kind?: unknown } | undefined;
		if (details?.kind === "goal-not-met") marks.push(i);
	}

	let streak = 0;
	for (let i = marks.length - 1; i >= 0; i -= 1) {
		const scan = scanRun(messages, undefined, marks[i]);
		if (scan.toolCallCount > 0) break;
		streak += 1;
	}
	return streak;
}

/**
 * 本轮要不要评估。
 *
 * 后台子代理在跑的跳过判定放在 index.ts —— 那需要问 pi-subagents 的 RPC，
 * 不是纯函数能做的（CC："If a subagent or a background shell command is still
 * running when a turn ends, Claude Code skips the evaluation for that turn"）。
 */
export function decideGoalGate(state: GoalState, messages: readonly GateMessage[], config: GoalConfig): GoalGateAction {
	if (!hasGoal(state)) return { action: "none" };

	const continuations = countContinuations(messages);
	if (continuations >= config.cap) return { action: "cap", continuations };

	const streak = countNoProgressStreak(messages);
	if (streak >= NO_PROGRESS_LIMIT) return { action: "halt", streak };

	const runStart = findRunStart(messages);
	const toolCallCount = scanRun(messages, undefined, runStart).toolCallCount;
	return { action: "evaluate", continuations, toolCallCount };
}

// =============================================================================
// 注入文本
// =============================================================================

/** 未达成时注入的续跑指令（CC：reason 作为下一轮的 guidance）。 */
export function renderNotMetMessage(state: GoalState, reason: string, config: GoalConfig, continuations: number): string {
	return (
		`/goal 评估：条件尚未达成（已续跑 ${continuations + 1}/${config.cap} 次，累计评估 ${state.evaluatedTurns + 1} 轮）。\n` +
		`条件：${state.condition}\n` +
		`评估器给出的理由：${reason}\n` +
		`请据此继续工作。注意：评估器只读对话内容、自己不能跑命令，所以**证据必须出现在你的输出里**` +
		`（跑命令并贴出输出），否则下一轮仍会判未达成。`
	);
}

/** 达成 / 不可能时记录到 transcript 的条目（CC：records an achieved / failed entry）。 */
export function renderTerminalMessage(state: GoalState, verdict: Verdict, reason: string): string {
	if (verdict === "met") {
		return `/goal 达成 ✔（累计评估 ${state.evaluatedTurns} 轮）\n条件：${state.condition}\n理由：${reason}`;
	}
	return `/goal 判定为不可能达成，已清除 ✘\n条件：${state.condition}\n理由：${reason}`;
}

/** 无进展停循环（CC：stops the loop, prints a warning, goal still set）。 */
export function renderHaltMessage(state: GoalState, streak: number): string {
	return (
		`/goal 已暂停：连续 ${streak} 轮没有任何工具调用，判定为无进展，把控制权交还给你。条件仍保留。\n` +
		`条件：${state.condition}\n` +
		`再发一条消息即恢复评估；或用 /goal clear 清除。`
	);
}

/** 到上限（CC：force-ends the turn after N consecutive blocks）。 */
export function renderCapMessage(state: GoalState, config: GoalConfig): string {
	return (
		`/goal 已连续续跑 ${config.cap} 次仍未达成，停止自动循环、把控制权交还给你。条件仍保留。\n` +
		`条件：${state.condition}\n用 /goal 查看状态，或 /goal clear 清除。`
	);
}

// =============================================================================
// 会话条目重建（appendEntry → getBranch()）
// =============================================================================

/** appendEntry 的 customType。 */
export const GOAL_ENTRY_TYPE = "verify-loop-goal";

/** 落盘形状。 */
export interface GoalEntryData {
	condition: string;
	setAt: number;
	status: GoalStatus;
	evaluatedTurns: number;
	lastVerdict?: Verdict;
	lastReason?: string;
}

export function toEntryData(state: GoalState): GoalEntryData {
	return {
		condition: state.condition,
		setAt: state.setAt,
		status: state.status,
		evaluatedTurns: state.evaluatedTurns,
		lastVerdict: state.lastVerdict,
		lastReason: state.lastReason,
	};
}

/**
 * 从会话分支条目重建 goal。取最后一条 —— 每条都是全量快照。
 *
 * 已达成/已不可能的 goal 不恢复（CC："does not restore a goal that was already
 * achieved or cleared"）。轮数计时也重置（CC："carries the condition over but
 * resets the turn count, timer, and token-spend baseline"）—— 只带走条件本身；
 * 续跑/无进展计数本来就从投影数，重建时恒为 0。
 */
export function reconstructGoal(entries: readonly unknown[]): GoalState {
	let latest: GoalEntryData | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== GOAL_ENTRY_TYPE) continue;
		const data = record.data as GoalEntryData | undefined;
		if (data && typeof data.condition === "string") latest = data;
	}
	if (latest === undefined || latest.condition === "") return emptyGoal();
	if (latest.status !== "active") return emptyGoal();
	return {
		condition: latest.condition,
		setAt: typeof latest.setAt === "number" ? latest.setAt : 0,
		status: "active",
		evaluatedTurns: 0,
		lastVerdict: latest.lastVerdict,
		lastReason: latest.lastReason,
	};
}

/** /goal 无参时的状态文本（CC status：条件、时长、轮数、最近理由）。 */
export function renderStatus(state: GoalState, now: number, config: GoalConfig, continuations: number): string {
	if (state.condition === "") return "No /goal is set. Usage: /goal <completion condition>; /goal clear clears it.";
	const minutes = state.setAt > 0 ? Math.max(0, Math.round((now - state.setAt) / 60_000)) : 0;
	const lines = [
		`◎ /goal ${state.status === "active" ? "active" : state.status}`,
		`Condition: ${state.condition}`,
		`Running for ${minutes} min, ${state.evaluatedTurns} evaluations, ${continuations}/${config.cap} auto-continuations`,
	];
	if (state.lastVerdict !== undefined) {
		lines.push(`Last verdict: ${state.lastVerdict}${state.lastReason ? ` — ${state.lastReason}` : ""}`);
	}
	return lines.join("\n");
}
