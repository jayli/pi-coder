/**
 * background-tasks/status.ts — statusline 底部任务 dock 行的纯格式化层。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入，`node --test` 能直接
 * 断言每条文案与色槽。与 `plan-mode/render.ts` 同形。
 *
 * ## 行形态（用户 2026-09-29 定的排版）
 *
 *   ⚙ bg_1 running 12s · npm run test --silent…
 *
 * 图标 dim（U+2699，实测 pi-tui `visibleWidth` = 1 列，不加 VS16）、id `accent`、
 * 状态词按结局着色（running → warning；exit 0 → success；非 0 / killed → error）、
 * 时长 muted、命令 dim。**命令恒在行尾**：这里只按 `STATUS_COMMAND_MAX` 粗截一刀，
 * 最终按终端宽度收口的是 statusline 扩展的 `truncateToWidth` —— 所以 id / 状态 / 时长
 * 永远看得见，超宽只截命令。
 *
 * ## 可选第二行：本轮已结束时仍挂着的任务
 *
 * 本轮结束（`agent_settled`）后还在跑的任务，在下面再加一行说明：
 *
 *   ⚙ bg_2 running 5m10s · <cmd>
 *     └ Task is still running
 *
 * 三个条件同时满足才出现：任务**还在跑**（终态不需要这句话）、**本轮已结束**
 * （`agent_start` 一到就清掉，所以新一轮进行中时不会说假话）、且任务**已跑满阈值**
 * （`TURN_NOTE_THRESHOLD_MS`，默认 5s）—— 阈值挡掉「本轮刚结束、长任务才起 1 秒」
 * 这种完全正常的情况。这是**事实陈述**（回合状态可由事件判定），不是「任务没用了」
 * 的推断：扩展无从区分「孤儿残留」与「本来就该长跑」，所以只报前者能确认的那半句。
 *
 * ## 显示哪个任务
 *
 * 永远一行：优先最新启动（startedAt 最大）的 **running** 任务；没有 running 时显示
 * 最新一个尚在驻留窗口（`TERMINAL_LINGER_MS`）内的终态任务。同类里其余的任务折叠成
 * 行尾的 `(+N)`。终态行由 `index.ts` 的秒级 tick 在驻留窗口过后自动清掉。
 *
 * ## 与 statusline 扩展的关系
 *
 * `STATUS_KEY` 是保留键：`index.ts` 用 `ctx.ui.setStatus(STATUS_KEY, …)` 发布，
 * `statusline/line.ts` 的 `composeFooterLines` 把这个键从拼接的第二行里**抽出来**、
 * 单独渲染成 footer 的**最后一行**（既不占 5 条 status 的预算，也不与长 cwd 同行被
 * 截断）。line.ts 直接 import 这里的常量，两份字面量永不漂移（与 plan-mode 的
 * `STATUS_KEY` 同一套跨目录 import 取舍）。
 */

import { formatElapsed, truncateCommand, type TaskStatus } from "./registry.ts";

/** statusline 侧的保留 status key（`index.ts` 发布、`statusline/line.ts` 摘出）。 */
export const STATUS_KEY = "background-tasks";

/** 终态任务的行在消失前驻留多久。`PI_BACKGROUND_TASKS_DOCK_LINGER_MS` 可覆盖（测试加速用）。 */
export const TERMINAL_LINGER_MS = 10_000;

/** dock 行里命令的粗截上限；终端宽度收口在 statusline 侧。与终态通知里展示的命令同长。 */
export const STATUS_COMMAND_MAX = 120;

/** 秒级刷新周期：运行时长每秒跳一次（弹窗期间由 index.ts 冻结）。 */
export const DOCK_TICK_MS = 1_000;

/**
 * ⚙ U+2699 GEAR。实测 pi-tui `visibleWidth` = 1 列（不是 RGI emoji，不走 2 列的
 * emoji 口径，也不需要 VS16）。源码里写转义、测试按码位钉死，防近形字符替换。
 */
export const DOCK_ICON = "\u2699";

/**
 * 结轮提示第二行的文案。**事实**：这条任务还在跑，而本轮已经结束。
 *
 * 英文（用户 2026-10-01 定）：前半句「本轮已结束」不写 —— dock 的位置本身就说明了
 * 这件事，复述一遍只会占宽；「running」这类状态词也是英文，句子里外同一种语言。
 * 文案不写结论，只陈述能证明的那半句。
 */
export const TURN_ENDED_NOTE = "Task is still running";

/**
 * 结轮提示的阈值：任务运行满这么久、且本轮已结束，才补第二行。
 * `PI_BACKGROUND_TASKS_TURN_NOTE_MS` 可覆盖。
 */
export const TURN_NOTE_THRESHOLD_MS = 5_000;

/**
 * └ U+2514 BOX DRAWINGS LIGHT UP AND RIGHT。与 bash 块同一套树形约定
 * （`└` 落在正文列、取 muted 槽），源码里写转义、测试按码位钉死。
 */
export const NOTE_GLYPH = "\u2514";

/** `└` 的缩进：落在正文列（id 首字符那一列），后面再接一个空格放文案。 */
const NOTE_INDENT = "  ";

/** 渲染 dock 行需要的任务最小面（registry 的 `BackgroundTask` 结构兼容）。 */
export interface BackgroundStatusTask {
	id: string;
	command: string;
	status: TaskStatus;
	startedAt: number;
	endedAt: number | undefined;
	exitCode: number | undefined;
	signal: string | undefined;
}

export interface BackgroundStatusTheme {
	fg(color: string, text: string): string;
}

/** 回合状态：本轮是否已经结束（决定要不要补第二行）。 */
export interface TurnSettledInput {
	/** 本轮结束的时刻；`undefined` = 本轮仍在进行（或还没跑过轮次）→ 不补第二行。 */
	settledAt: number | undefined;
	/** 阈值覆盖（index.ts 读 `PI_BACKGROUND_TASKS_TURN_NOTE_MS`）；默认 `TURN_NOTE_THRESHOLD_MS`。 */
	noteMs?: number;
}

/** 状态词与色槽：running 橙、exit 0 绿、非 0 / killed / 带信号退出 红。 */
function statusWord(task: BackgroundStatusTask): { word: string; slot: string } {
	if (task.status === "running") return { word: "running", slot: "warning" };
	if (task.status === "killed") return { word: "killed", slot: "error" };
	if (task.exitCode === 0) return { word: "exit 0", slot: "success" };
	return { word: `exit=${task.exitCode ?? task.signal ?? "?"}`, slot: "error" };
}

/**
 * dock 行文案；没有任何该显示的任务时返回 `undefined`（index.ts 据此清键停表）。
 *
 * 选取规则：有 running 只看 running（最新一个，其余 `(+N)`）；否则看驻留窗口内的
 * 终态任务（同规则）。`(+N)` 放在命令**之前**：dock 行超宽时只有行尾的命令会被
 * 终端宽度截掉，计数放前面才能永远看得见。`lingerMs` 由调用方注入（index.ts 读 env），
 * 默认 10s。
 *
 * 返回值可能含**一个换行**（结轮提示的第二行，见文件头）；statusline 侧按行拆成
 * 多个 footer 行渲染。`turn` 省略 = 本轮状态未知 → 永远单行。
 */
export function formatBackgroundStatus(
	theme: BackgroundStatusTheme,
	tasks: readonly BackgroundStatusTask[],
	now: number,
	lingerMs: number = TERMINAL_LINGER_MS,
	turn?: TurnSettledInput,
): string | undefined {
	const running = tasks.filter((task) => task.status === "running");
	const lingering = tasks.filter(
		(task) => task.status !== "running" && (task.endedAt ?? now) >= now - lingerMs,
	);
	const pool = running.length > 0 ? running : lingering;
	if (pool.length === 0) return undefined;

	// 最新启动的赢；startedAt 相同时取数组靠后的（registry 按启动顺序插入）。
	let pick = pool[0]!;
	for (const task of pool) {
		if (task.startedAt >= pick.startedAt) pick = task;
	}
	const extra = pool.length - 1;

	const { word, slot } = statusWord(pick);
	const elapsedMs = (pick.endedAt ?? now) - pick.startedAt;
	// `(+N)` 在命令之前：超宽时只有行尾的命令被截，计数永远看得见。
	const parts = [
		theme.fg("dim", DOCK_ICON),
		theme.fg("accent", pick.id),
		theme.fg(slot, word),
		theme.fg("muted", formatElapsed(elapsedMs)),
	];
	if (extra > 0) parts.push(theme.fg("muted", `(+${extra})`));
	parts.push(theme.fg("dim", "\u00b7"));
	parts.push(theme.fg("dim", truncateCommand(pick.command, STATUS_COMMAND_MAX)));
	const line = parts.join(" ");
	if (!needsTurnEndedNote(pick, now, turn)) return line;
	// `└` 单独取 muted：结构字符不吃后面文案的颜色（bash 块的同一条约定）。
	const sub = `${NOTE_INDENT}${theme.fg("muted", NOTE_GLYPH)} ${theme.fg("warning", TURN_ENDED_NOTE)}`;
	return `${line}\n${sub}`;
}

/**
 * 该不该给这一行补「本轮已结束」：还在跑 + 本轮已结束 + 已跑满阈值，三者缺一不可。
 * 终态任务不补（驻留窗口里那几秒不需要这句话），阈值挡掉刚起几秒的正常长任务。
 */
function needsTurnEndedNote(
	task: BackgroundStatusTask,
	now: number,
	turn: TurnSettledInput | undefined,
): boolean {
	if (task.status !== "running") return false;
	if (turn?.settledAt === undefined) return false;
	return now - task.startedAt >= (turn.noteMs ?? TURN_NOTE_THRESHOLD_MS);
}
