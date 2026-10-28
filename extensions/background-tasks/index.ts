/**
 * background-tasks — 最简版 `run_in_background`（仿 Claude Code 的后台 bash）。
 *
 * pi 0.87.1 的内核没有后台执行原语（`run_in_background` 在全部 dist 里 0 命中，
 * `ExecOptions` 只有 signal / timeout / cwd），长任务只能前台阻塞到超时。本扩展用
 * 扩展 API 把这块补上：三个工具 + 一个 `/background` 命令。
 *
 * ## 工具面（CC 三件套的形状）
 *
 *   | 本扩展 | CC 对应物 |
 *   |---|---|
 *   | `run_in_background` | Bash 的 `run_in_background: true` |
 *   | `background_output` | `BashOutput` |
 *   | `background_kill` | `KillShell` |
 *
 * ## 完成即唤醒
 *
 * 任务进入终态（退出 / 失败 / 被杀）时注入一条 `<background-task-notification>`
 * 并触发一轮模型跟进：空闲时直接起新一轮，流式中则排到本轮结束之后（`deliverAs:
 * "followUp"`）。所以模型**不需要轮询** —— 工具描述里明确写了「启动后去做别的独立
 * 工作，然后结束本轮，终态通知会叫醒你」。
 *
 * ## 生命周期：任务随 pi 会话生死
 *
 * `session_shutdown` 里 `killAll()`（幂等）。spawn 用 `detached: true` 只是为了让命令
 * 当自己进程组的组长，好让 `kill(-pid)` 整组带走（`npm test` 的 worker、管道各段）；
 * **不 unref**，所以任务不会脱离 pi 独立存活，也不需要跨重启恢复逻辑。
 *
 * 三个已记录的代价：
 *   - pi 被 SIGKILL（或崩溃）时没机会跑 shutdown，detached 的任务会活下来。
 *   - `/reload` 会换掉扩展运行时并触发 shutdown，因此**重载会结束在跑的后台任务**。
 *   - 会话替换（`/clear`、`/new`、`/resume`）**也**发 `session_shutdown`，但扩展实例
 *     不死 —— 所以 `session_start` 一到就把 `disposed` 复位，否则新会话里的任务
 *     完成时永远注入不了通知（模型再也叫不醒）；同时用 registry 身份闸（`reg !==
 *     registry`）挡住旧会话被 killAll 的任务的迟到 `exit` 注入新会话。
 *
 * ## 不包 seatbelt 删除边界
 *
 * 普通 `bash` 工具是被 `bash-command-collapse.ts` 包进 seatbelt profile 跑的，而本扩展
 * 直接 `spawn`，**后台命令因此不经过删除能力边界** —— 语义上等同用户自己在终端里
 * `cmd &`。`/background` 的输出里也印了这句提示。要受边界约束的删除请走前台 bash。
 *
 * ## statusline 底部的任务 dock
 *
 * 有任务在跑（或刚进终态）时，footer 最底部多一行说明「正在跑什么」：
 *
 *   ⚙ bg_1 running 12s · npm run test --silent…
 *
 * 文案与配色在纯模块 `status.ts` 里（可单测），本文件只负责发布与节拍：一个 1s 的
 * `setInterval`（`unref`，不吊住事件循环）重算并 `ctx.ui.setStatus(STATUS_KEY, …)`，
 * 没有可显示的任务时自己停表并清键；终态行驻留 `TERMINAL_LINGER_MS`（10s）后消失。
 * 弹窗期间（`ui_prompt_start` → `ui_prompt_end`）**一次也不发布**：不只是停掉秒级 tick，
 * 连事件驱动的那一下（任务恰好在弹窗里结束时的终态回调）也跳过 —— pi 的主屏渲染每次都把
 * 视口钉在底部，一次重绘同样会把用户手动上翻的 scrollback 拽回去（working-indicator 冻结
 * 重绘的同一条理由）；弹窗一关按**当前真实状态**重算，所以什么都不丢（时长也是重算的）。
 * statusline 扩展把 `STATUS_KEY` 从拼接的第二行里摘出来单独渲染成最后一行，
 * 所以它既不占 5 条 status 的预算，也不会与长 cwd 同行被截断。
 *
 * ## 结轮提示：本轮结束了，任务还在跑
 *
 * 本轮结束（`agent_settled`）后仍在跑、且已跑满 5s 的任务，dock 行下面多一句：
 *
 *   ⚙ bg_2 running 5m10s · <cmd>
 *     └ Task is still running
 *
 * 这是**事实陈述**（回合状态由事件判定），不是「任务没用了」的推断 —— 扩展分不出
 * 「孤儿残留」与「本来就该长跑」（一个 8 分钟的 `npm test` 在主任务收工后继续跑完全
 * 正常），所以只说能确认的那半句，并且只在 `agent_start` 清除回合状态之前说。
 * 阈值 `PI_BACKGROUND_TASKS_TURN_NOTE_MS`（默认 5s）挡掉刚起几秒的正常长任务。
 *
 * `agent_settled` 在自动压缩 / verify-loop 的 `/goal` 评估之后才发（两者都跑在 app 级
 * `agent_end` 之后、`agent_settled` 之前），所以「本轮结束」的时点取的是真正的收尾。
 *
 * ## 最简版明确不做
 *
 * 跨 pi 重启的任务恢复、超时自动杀（CC 的后台 bash 也没有超时参数）、agent 类任务、
 * stdout/stderr 分流（两路合并，等价 `2>&1`）。
 *
 * 开关：`PI_BACKGROUND_TASKS=off` 整体关闭；`PI_BACKGROUND_TASKS_DIR` 覆盖日志根目录
 * （测试隔离用）；`PI_BACKGROUND_TASKS_DOCK=off` 只关 statusline 那一行（工具与通知照旧）；
 * `PI_BACKGROUND_TASKS_DOCK_LINGER_MS` 改终态行的驻留时长；
 * `PI_BACKGROUND_TASKS_TURN_NOTE_MS` 改结轮提示的运行时长阈值（默认 5s）。
 *
 * ## 第四个块：`bg_wait`（别人注册的工具，只换渲染）
 *
 * `bg_wait` 是 pi-subagents 注册的后台等待工具，本扩展**没有**它的定义，也不能重注册。
 * 它原先走 pi 默认壳（`toolSuccessBg` 底色 + 上下各一行空行 + `bg_wait id="…"` 标题）——
 * 用户 2026-10-18 定：这个场景也改成本扩展三个工具那棵树（无底色、无上下空行）。
 * 实现走 `pi.registerToolRenderer`（只换渲染、不动工具，与 mcp-tree 同一条路）：
 * 名字是 `bg_wait` 就返回同一套 self 壳渲染器，其余工具原样交给 `next()`。
 * 它的 `details` 没有 `ok`，所以结局分类用 `classifyBgWaitOutcome`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as piTui from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
// 正文色 `bashOutput` 自 pi 1.2.0 起写在皮肤 `vars` 里，见 theme-extra/colors.ts。
import { colorOpsFrom, themeVarAnsi } from "../theme-extra/colors.ts";

import {
	MAX_READ_CHARS,
	createRegistry,
	formatElapsed,
	formatTaskLine,
	formatTaskList,
	truncateCommand,
	type BackgroundTask,
	type Registry,
} from "./registry.ts";
import {
	DOCK_TICK_MS,
	STATUS_KEY as DOCK_STATUS_KEY,
	formatBackgroundStatus,
} from "./status.ts";
import {
	cleanupWorktree,
	prepareWorktree,
	type CreatedWorktree,
} from "./worktree.ts";
import {
	BODY_INDENT,
	BODY_TEXT_TOKEN,
	BODY_TEXT_VAR,
	GUTTER_WIDTH,
	PREVIEW_MAX_LINES,
	TREE_LAST,
	TREE_PIPE,
	bgNotificationTitleParts,
	bgResultTreePrefixes,
	bgToolTitleParts,
	classifyBgNotificationOutcome,
	classifyBgToolOutcome,
	classifyBgWaitOutcome,
	fitLogLine,
	previewMoreLinesHint,
	type BgToolOutcome,
} from "./render.ts";
import { renderTaskTable, TABLE_RIGHT_MARGIN, type TaskTableRole, type TaskTableRow } from "./table.ts";

const CUSTOM_TYPE = "background-task";
/** pi-subagents 注册的后台等待工具名（本扩展只接管它的**渲染**，不注册工具）。 */
const BG_WAIT_TOOL = "bg_wait";

/** 默认给每个后台任务一份隔离工作区（`PI_BACKGROUND_TASKS_WORKTREE=off` 关掉）。 */
function worktreeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.PI_BACKGROUND_TASKS_WORKTREE ?? "").trim().toLowerCase() !== "off";
}

/** 日志根目录：`PI_BACKGROUND_TASKS_DIR` 覆盖，否则 `<agentDir>/bg-tasks`。 */
function resolveLogRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_BACKGROUND_TASKS_DIR;
	if (override) return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
	return path.join(getAgentDir(), "bg-tasks");
}

function textResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

function taskDetails(task: BackgroundTask, now: number) {
	return {
		id: task.id,
		status: task.status,
		pid: task.pid,
		command: task.command,
		cwd: task.cwd,
		worktree: task.worktree,
		logPath: task.logPath,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		exitCode: task.exitCode,
		signal: task.signal,
		elapsedMs: (task.endedAt ?? now) - task.startedAt,
	};
}

/**
 * 终态通知正文（模型看到的就是这段）。`extraLines` 放 worktree 的处置结果。
 *
 * **没有「这是终态事实，不需要再调 background_output 确认状态」那句**（用户 2026-10-18 定）：
 * 同一句话已经写在 `run_in_background` 的 description / promptGuidelines 里，通知里每次重复
 * 一遍是纯冗余。「别为了确认状态而轮询」这条纪律仍由工具描述承载。
 */
function buildNotification(task: BackgroundTask, now: number, extraLines: readonly string[] = []): string {
	const outcome =
		task.status === "killed"
			? `was killed (${task.signal ?? "SIGTERM"})`
			: task.exitCode === 0
				? "finished successfully (exit 0)"
				: `failed (exit=${task.exitCode ?? "?"}${task.signal ? ` signal=${task.signal}` : ""})`;
	return [
		"<background-task-notification>",
		`Background task ${task.id} ${outcome}, ran ${formatElapsed((task.endedAt ?? now) - task.startedAt)}.`,
		`Command: ${truncateCommand(task.command, 120)}`,
		...extraLines,
		`Full log: ${task.logPath}`,
		"</background-task-notification>",
	].join("\n");
}

/**
 * 任务总览表的**快照**（`run_in_background` 的结果与终态通知共用同一份形状）。
 *
 * 用户 2026-10-16 选「快照而非实时视图」：渲染器只读这份，不读注册表，所以历史块永不重绘。
 * `tableNow` 是算时长用的时刻（已结束任务用 `endedAt`）。表格用不到的字段（日志路径 /
 * worktree）不进快照 —— 它们是给模型读的，不是给渲染器读的。
 */
function taskSnapshotDetails(registry: Registry, now: number): { tasks: Array<Record<string, unknown>>; tableNow: number } {
	return {
		tasks: registry.listTasks().map((entry) => ({
			id: entry.id,
			command: truncateCommand(entry.command, 200),
			status: entry.status,
			startedAt: entry.startedAt,
			endedAt: entry.endedAt,
			exitCode: entry.exitCode,
			signal: entry.signal,
		})),
		tableNow: now,
	};
}

// =============================================================================
// 工具调用块的渲染（run_in_background / background_output / background_kill 共用）
// =============================================================================

/**
 * 行级渲染状态（pi 的 `rendererState`，每个工具行一份、renderCall 与 renderResult 共享）。
 *
 * 它存在的唯一理由：标题行的圆点颜色取决于 `result.details`，而
 *   ① `getRenderContext()` **不暴露 result 本体**（只有 isPartial / isError / state 等），
 *   ② 同一次 `updateDisplay()` 里 callRenderer **先于** resultRenderer 执行。
 * 所以 renderResult 把分类写进 state，renderCall 返回一个**在 `render(width)` 时才读
 * state 的懒组件** —— 屏幕真正绘制发生在 updateDisplay() 之后，那时已经写好了。
 * 懒组件（只需 `render` / `invalidate`）是 bash-command-collapse 的既有做法。
 */
interface BgToolRenderState {
	outcome?: BgToolOutcome;
}

/** renderCall / renderResult 拿到的 context 里、本扩展真正会读的那几个字段。 */
interface BgToolRenderContext {
	state: BgToolRenderState;
	isPartial: boolean;
	isError: boolean;
}

/** 结果块里的文本正文（其余块类型这三个工具不会产生）。 */
interface BgToolResultLike {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
	details?: unknown;
}

/**
 * 正文用哪个色：**先看皮肤 `vars.bashOutput`，没有则用主题的 `toolOutput` 槽**。
 *
 * 用户 2026-10-06 定：后台任务（工具块与终态通知）的正文要**与 bash 工具调用后显示的
 * 输出结果同色**，而不是 `text` 槽的 fg。
 *
 * `bashOutput` 自 pi 1.2.0 起写在皮肤文件的 `vars` 里（strict schema 之后不能再当自定义
 * colors key），所以它取到的是**拼好的转义串**（读文件 + pi-tui 转）；`toolOutput` 是官方
 * 槽位，仍走 `theme.fg()`。两种形状不同，在 `paintBodyRow` 里各走各的分支。
 */
function pickBodySlot(theme: Theme): string | undefined {
	const extra = themeVarAnsi(theme as unknown as Parameters<typeof themeVarAnsi>[0], BODY_TEXT_VAR, "fg", SKIN_OPS);
	if (extra !== undefined) return extra;
	// 官方槽位也假设不了不抛（皮肤可能写坏）—— 抛就当成没有。
	try {
		theme.fg(BODY_TEXT_TOKEN, "");
		return BODY_TEXT_TOKEN;
	} catch {
		return undefined;
	}
}

/** 把一行正文染成**结果正文色**：`vars` 取到的是转义串，槽名走 `theme.fg()`；都拿不到就原样返回。 */
function paintBodyRow(theme: Theme, row: string, slot: string | undefined): string {
	if (slot === undefined) return row;
	// `vars` 路径返回的是已经拼好的 SGR 前缀（`\x1b[38;…m`），与 pi 自己上色同一套转义。
	if (slot.startsWith("\u001b[")) return `${slot}${row}\u001b[39m`;
	return theme.fg(slot as Parameters<Theme["fg"]>[0], row);
}

/** 给 `theme-extra/colors.ts` 的转换函数（与 pi 内部生成 token 转义用的同一对）。 */
const SKIN_OPS = colorOpsFrom(piTui);

/** 把结果里的所有 text 块拼成全文（按块顺序，块之间换行）。 */
function bgResultText(result: BgToolResultLike): string {
	const blocks = Array.isArray(result.content) ? result.content : [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/**
 * 从结果 `details` 里取出**任务快照**（`run_in_background` 的 execute 写进去的）。
 *
 * 形状不对就当没有：表格是不画就退化成旧形态的增强，不为它抛异常。
 * 这份快照是**渲染时刻冻结的内容**（用户 2026-10-16 选「快照而非实时视图」）—— 历史块
 * 不随任务状态变化重绘，实时进度由 statusline 的 dock 行负责。
 */
function taskSnapshot(details: unknown): { tasks: ReadonlyArray<Record<string, unknown>>; now: number } | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const record = details as { tasks?: unknown; tableNow?: unknown };
	if (!Array.isArray(record.tasks) || record.tasks.length === 0) return undefined;
	const now = typeof record.tableNow === "number" ? record.tableNow : Date.now();
	return { tasks: record.tasks as Array<Record<string, unknown>>, now };
}

/**
 * 表格拿到的宽度：正文宽度再扣掉右侧留白（用户 2026-10-17 定的 4 列）。
 *
 * `renderTaskTable` 的契约是「给多少宽就填满多少」，扣留白属于接线层的几何决策，所以工具块
 * 与终态通知两处接线共用这一个函数，免得同一张表在两处宽度不一致。
 */
function tableWidthFor(bodyWidth: number): number {
	return Math.max(1, bodyWidth - TABLE_RIGHT_MARGIN);
}

/**
 * 表格一格的色槽（用户 2026-10-17 定，三轮；2026-10-22 补表头底色；2026-10-28 改表头字色）：
 *
 * - **列标题走 `text` 前景色**（即 fg）—— 底色已经把标题行与任务行分开了，字再上色就多一层强调；
 *   2026-10-22 加：整个格子**加粗 + 刷皮肤的 surface 底色**（`userMessageBg`）—— 表头是标题行，
 *   一格一块淡色底才看着像表头。只染格子，竖线仍是 border 片段。
 * - **边框走 bash 工具调用的正文输出色**（`bashOutput` → `toolOutput`，即 `pickBodySlot`）——
 *   表格就是挂在正文树尾的延续，框线与上面那几行输出同一个色；
 * - 其余无色的格子（时长 / 命令 / 折叠提示）也走 `text` 前景色；
 * - 原本带语义色的格子保持不变 —— `id` 走 `accent`，状态词按结局 `warning` / `success` / `error`。
 */
function paintTableCell(
	theme: Theme,
	role: TaskTableRole,
	text: string,
	bodySlot: string | undefined,
	segment?: { bold?: boolean; bg?: boolean },
): string {
	const painted = paintTableCellFg(theme, role, text, bodySlot);
	// 表头底色取皮肤的 **surface** 槽（`userMessageBg`），不是 `dim` 色阶：dim 在 1337 上
	// 是 `#6d6d6d`，与 fg（`#f8f8f2`）的对比度只剩一半，标题字会发灰。`theme.bg()` 只认 7 个官方
	// `ThemeBg`，所以这里用槽名（不走 theme-extra 的 `vars` 自定色）。
	//
	// 嵌套顺序是 bg(bold(fg(text)))：三种重置码互不干扰（`\x1b[49m` / `\x1b[22m` /
	// `\x1b[39m`），底色因此覆盖整格（含两端补位空格），而格内文字仍各自上色。
	// 底色/加粗都是增强：皮肤没这个槽、或主题实现不完整时静默退回单上前景色，不能把
	// 表格整张搞没（渲染器里抛异常等于这个块消失）。
	if (segment?.bg !== true && segment?.bold !== true) return painted;
	let out = painted;
	if (segment.bold === true) {
		try {
			out = theme.bold(out);
		} catch {
			/* 主题没实现 bold：保留原样 */
		}
	}
	if (segment.bg === true) {
		try {
			out = theme.bg("userMessageBg", out);
		} catch {
			/* 主题没有这个背景槽：保留原样 */
		}
	}
	return out;
}

/** 表格一格的前景色（表头底色在 `paintTableCell` 里往上叠）。 */
function paintTableCellFg(theme: Theme, role: TaskTableRole, text: string, bodySlot: string | undefined): string {
	switch (role) {
		case "border":
			return paintBodyRow(theme, text, bodySlot);
		case "header":
			// 表头是标题行（用户 2026-10-22 定底色、2026-10-28 定字色）：底色已把它区分出来了，
			// 字不再用 mdCode，而是与正文其他无色格子同一个前景色（`text` 槽 = fg）。
			return theme.fg("text", text);
		case "id":
			return theme.fg("accent", text);
		case "status-running":
			return theme.fg("warning", text);
		case "status-success":
			return theme.fg("success", text);
		case "status-error":
			return theme.fg("error", text);
		default:
			return theme.fg("text", text);
	}
}

/**
 * 把表格行数组上色并挂树：**首行挂 `└ `**（用户 2026-10-16 选的形态），其余行挂 2 列空白。
 *
 * 这里的 2 列空白不是随手写的：正文行的几何是 `BODY_INDENT(2) + 树符(2) + 正文`，正文落在
 * 列 4；表格就是正文的替代品，所以它的首行用 `└ ` 顶替树符、其余行用等宽空白顶替，
 * 整张表的左竖线始终在列 4。
 */
function paintTableRows(rows: readonly TaskTableRow[], theme: Theme, bodySlot: string | undefined): string[] {
	return rows.map((row, index) => {
		const gutter = index === 0 ? theme.fg("dim", TREE_LAST) : "  ";
		const painted = row.map((segment) => paintTableCell(theme, segment.role, segment.text, bodySlot, segment)).join("");
		return BODY_INDENT + gutter + painted;
	});
}

/**
 * 三个工具共用的渲染器：`renderShell: "self"` + 树形标题/正文（参照 plan 工具调用块）。
 *
 * ## 为什么必须 self 壳
 *
 * 默认壳是 `contentBox = new Box(1, 1, bgFn)`（tool-execution.js）：整块套
 * `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` 底色，`paddingY = 1` 给上下各一行
 * 空行，构造时那个 `Spacer(1)` 再给上方一行。self 模式下 `render()` 绕过
 * `super.render()`（Spacer 不画）、容器是纯 `Container`（`instanceof Box` 为 false，
 * bgFn 套不上去），于是**没有底色、下方没有空行**；上方只剩 pi 在 self 分支里写死的
 * 那一行 `lines.push("")` —— 去不掉，bash / simple-task / plan 块同样如此。
 *
 * ## 形态（用户 2026-09-30 定：参照 plan 块）
 *
 * ```
 * • run_in_background
 *   │ 已在后台启动 bg_1（pid 12345）。
 *   └ 日志：/…/bg_1.log
 * ```
 *
 * 标题行 = 状态圆点 + 加粗工具原名，**从圆点起顶格、且不打任何标记**（用户 2026-09-30
 * 分两轮定）：点的颜色就是结局灯（绿=成功、灰=执行中/没办成、红=真错误，见
 * `bgToolTitleParts`）。`✔` 只属于终态通知（`run_in_background` 成功意味着任务才刚开始，
 * 打对号会被读成「已经结束」），`✘` 对工具块也是多余的（圆点已经表达结局，且「没办成」
 * 是模型自己下一步就能纠正的普通分支，正文里已写了原因）。正文是**结果全文**，前面挂
 * `BODY_INDENT` 那 2 列再折行挂树（于是
 * `│` 落在工具名首字母正下方）—— 除末行外 `│ `，**末行 `└ `**。结构符走 `dim` 槽且
 * **自成一段 SGR**，不让正文色透上来。正文走**结果正文色**：与 bash 工具调用后显示的
 * 输出结果同色（`bashOutput`，主题没定义时退回 `toolOutput`，见 `pickBodySlot`；用户
 * 2026-10-06 定，改成这条之前的旧行为是 `text` 槽 = fg）。
 *
 * ## 预览截断（保留 pi 默认壳原有的行为）
 *
 * pi 默认壳把正文裁到 10 行并给 `... (N more lines, ctrl+o to expand)` 提示；换 self 壳
 * 后这条裁剪会消失，所以这里自己补回来（`PREVIEW_MAX_LINES` + `previewMoreLinesHint`），
 * 否则 `background_output` 一次 30000 字符的返回会平铺满屏。展开态（ctrl+o，`expanded`）
 * 不裁，与 bash / tool-diff 块一致。截断按**折行之后**的视觉行数算（与树前缀同口径）。
 *
 * ## 任务总览表（`run_in_background` 带，用户 2026-10-16 定）
 *
 * `run_in_background` 的结果块末尾多一张当前全部任务的小表（形态在 `table.ts`）。它**不走
 * 正文那 10 行预览预算** —— 否则六行正文 + 七八行表必被裁掉下半截。所以顺序是：先把正文
 * 按预览预算裁好，再把表整块追加在后面（表自身靠行数上限收口，上限 5 行任务）。
 *
 * 同一个「带表」开关（`config.taskTable`）**不给 `background_output` / `background_kill`**
 * ——它们的正文已点明是哪个任务，再贴表会把增量读的输出推后。终态通知在自己的渲染器里
 * 贴同一张表（用户 2026-10-18 定），不走这里。
 *
 * **右侧留 4 列**（用户 2026-10-17 定）：表格是这块里唯一撑满可用宽度的东西，右边框顶到
 * 行尾会显得贴屏幕；字宽从 `bodyWidth` 里先扣 `TABLE_RIGHT_MARGIN` 再交给
 * `renderTaskTable`（它自己的契约是「给多少填满多少」，扣留白属于接线层的几何决策）。
 * 正文不扣 —— 按字符折行自然有参差的右边缘。
 *
 * 表只读结果 `details` 里的**快照**，不读实时注册表：历史块永不重绘。
 *
 * 有表时正文的树**不闭合**（全行 `│ `，`bgResultTreePrefixes(count, false)`），`└ ` 交给
 * 表格首行 —— 用户 2026-10-16 选的形态。
 */
function bgToolRenderers(
	toolName: string,
	config: {
		taskTable?: boolean;
		/** 结局分类；默认读 `details.ok`（本扩展三个工具），`bg_wait` 传自己的（details 形状不同）。 */
		classify?: (isError: boolean, details: unknown) => BgToolOutcome;
	} = {},
) {
	return {
		renderShell: "self" as const,
		renderCall(_args: unknown, theme: Theme, context: BgToolRenderContext) {
			// state 是跨帧同一个对象，所以 render(width) 时读到的是 renderResult 刚写的分类；
			// 兜底（state 里还没有 outcome）只发生在「结果没到过」的行：执行中按 isPartial
			// 判 pending，其余按 isError 判 error / declined。
			const state = context.state;
			return {
				render(width: number): string[] {
					const outcome: BgToolOutcome =
						state?.outcome ?? (context.isPartial ? "pending" : context.isError ? "error" : "declined");
					// 工具块只有圆点、不打任何标记（用户 2026-09-30 定）：点的颜色就是结局灯
					//（绿=成功、灰=执行中/没办成、红=真错误），标记只属于终态通知。
					const parts = bgToolTitleParts(outcome);
					const title = `${theme.fg(parts.dotSlot, "\u2022")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
					// 标题行顶格（不挂 BODY_INDENT），所以折行预算就是整个宽度
					return wrapTextWithAnsi(title, Math.max(1, width || 80));
				},
				invalidate() {},
			};
		},
		renderResult(result: BgToolResultLike, options: { expanded: boolean }, theme: Theme, context: BgToolRenderContext) {
			// isError 必须从 **context** 读：pi 传给 resultRenderer 的对象是
			// `{ content, details }`，**没有 isError 字段**（它只在 getRenderContext() 里）。
			if (context.state) {
				context.state.outcome = (config.classify ?? classifyBgToolOutcome)(context.isError === true, result?.details);
			}
			const sourceLines = bgResultText(result ?? {}).split("\n");
			const expanded = options?.expanded === true;
			// 快照在这里取一次：它是**冻结的**内容（用户 2026-10-16 选快照而非实时视图），
			// 所以按 width 缓存排版仍然安全。
			const snapshot = config.taskTable === true ? taskSnapshot(result?.details) : undefined;
			const tableTasks = snapshot?.tasks ?? [];
			const tableNow = snapshot?.now ?? 0;
			// 结果是静态的，按 width 缓存排版（同 plan 块 / tool-diff 的 DiffCard）
			const cache = new Map<number, string[]>();
			return {
				render(width: number): string[] {
					const hit = cache.get(width);
					if (hit !== undefined) return hit;
					const bodyWidth = Math.max(1, (width || 80) - BODY_INDENT.length - GUTTER_WIDTH);
					const rows: string[] = [];
					for (const line of sourceLines) {
						// 空行也占一行（wrapTextWithAnsi("") → [""]）：段落间距是可读性的一部分
						// 日志路径行**不折行**：放不下就把路径前段换成 `…`（尾部即文件名），
						// 否则树会被切出一个孤零零的 `og`（用户 2026-10-28 定）。
						rows.push(...wrapTextWithAnsi(fitLogLine(line, bodyWidth, piTui.visibleWidth), bodyWidth));
					}
					if (rows.every((row) => row.trim() === "")) {
						cache.set(width, []);
						return [];
					}
					// 预览截断：非展开态裁到 PREVIEW_MAX_LINES 行，提示行挂在被裁正文的末尾。
					// 展开态（ctrl+o）不裁。截断按折行后的视觉行数算（与树前缀同口径）。
					let visible = rows;
					let hidden = 0;
					if (!expanded && rows.length > PREVIEW_MAX_LINES) {
						visible = rows.slice(0, PREVIEW_MAX_LINES);
						hidden = rows.length - visible.length;
					}
					// 前缀按**折行 + 截断之后**的视觉行数算：折行碎片与截断提示行各算独立行，
					// 否则一个折成三行的长句会在第一片就画上 `└`，看着像树提前结束了。
					// 正文颜色：与 bash 工具调用后的输出同色（bashOutput，没定义时 toolOutput）
					const bodySlot = pickBodySlot(theme);
					// 总览表**在预览预算之外**：正文先裁好，表整块接在后面（表自己最多 5 行任务）。
					// 表格先算：它是「画得出来」还是「太窄放不下」决定了正文树要不要闭合 ——
					// `└ ` 得接在**最后一个真正画出来的**东西后面，不能为一张没画的表提前收口。
					const tableLines =
						tableTasks.length > 0
							? paintTableRows(
									renderTaskTable(tableTasks as unknown as Parameters<typeof renderTaskTable>[0], {
										// 右侧留白在这里扣：表格是这块里唯一撑满可用宽度的东西，右边框不顶到行尾
										width: tableWidthFor(bodyWidth),
										now: tableNow,
										widthOf: (text: string) => piTui.visibleWidth(text),
									}),
									theme,
									bodySlot,
								)
							: [];
					const lineCount = visible.length + (hidden > 0 ? 1 : 0);
					// 有表时正文树**不闭合**（`└ ` 交给表格首行）；没表时保持旧形态（末行 `└ `）。
					const prefixes = bgResultTreePrefixes(lineCount, tableLines.length === 0);
					const lines = visible.map(
						(row, index) =>
							BODY_INDENT +
							theme.fg("dim", prefixes[index] ?? TREE_PIPE) +
							paintBodyRow(theme, row, bodySlot),
					);
					if (hidden > 0) {
						lines.push(
							BODY_INDENT +
								theme.fg("dim", prefixes[visible.length] ?? TREE_PIPE) +
								theme.fg("muted", previewMoreLinesHint(hidden)),
						);
					}
					lines.push(...tableLines);
					cache.set(width, lines);
					return lines;
				},
				invalidate() {
					cache.clear();
				},
			};
		},
	};
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	if (process.env.PI_BACKGROUND_TASKS === "off") return;

	let registry: Registry | undefined;
	/** 最近一次见到的 ctx：终态回调发生在子进程事件里，那时手上没有 ctx。 */
	let lastCtx: ExtensionContext | undefined;
	/** shutdown 与新会话之间不再注入通知（否则会在旧会话结束后凭空起一轮）。 */
	let disposed = false;
	let logDir = "";

	// ── statusline 任务 dock ───────────────────────────────────────────────

	const DOCK_DISABLED =
		(process.env.PI_BACKGROUND_TASKS_DOCK ?? "").trim().toLowerCase() === "off";
	const dockLingerMs = Number(process.env.PI_BACKGROUND_TASKS_DOCK_LINGER_MS) || undefined;
	//	结轮提示的阈值：工厂期读一次（与另两个旋钮同口径）。
	const turnNoteMs = Number(process.env.PI_BACKGROUND_TASKS_TURN_NOTE_MS) || undefined;
	let dockTimer: ReturnType<typeof setInterval> | undefined;
	/** 弹窗期间不发布：一次重绘同样会把用户手动上翻的 scrollback 拽回底部。 */
	let dockFrozen = false;
	/**
	 * 本轮结束的时刻；`undefined` = 本轮进行中（或还没跑过轮次）。
	 * 只看它就能决定要不要补「本轮已结束」那一行，所以不需要额外的布尔量。
	 */
	let turnSettledAt: number | undefined;

	/**
	 * 重算 dock 行并发布，返回「是否还有东西在显示」。
	 * 没有可显示的任务时清键 —— 节拍由 `bumpDock` 据此决定起表还是停表。
	 */
	function refreshDock(): boolean {
		const ctx = lastCtx;
		if (DOCK_DISABLED || !ctx || !ctx.hasUI) return false;
		let text: string | undefined;
		try {
			// theme 在渲染时求值：`ctx.ui.theme` 是跨 `/theme` 换肤的活 Proxy。
			text = formatBackgroundStatus(
				ctx.ui.theme,
				registry?.listTasks() ?? [],
				Date.now(),
				dockLingerMs,
				{ settledAt: turnSettledAt, noteMs: turnNoteMs },
			);
			ctx.ui.setStatus(DOCK_STATUS_KEY, text);
		} catch {
			// stale ctx（会话被换掉）：状态栏不值得为此挂掉，停表即可。
			return false;
		}
		return text !== undefined;
	}

	function startDock(): void {
		if (DOCK_DISABLED || dockTimer || dockFrozen) return;
		const timer = setInterval(() => {
			// 驻留窗口过了 / 任务都没了 → 自己停表，不留一个空转的秒级定时器。
			if (!refreshDock()) stopDock();
		}, DOCK_TICK_MS);
		// 收尾定时器不能吊住事件循环：pi 要退出时它不该是拦路的那个。
		timer.unref?.();
		dockTimer = timer;
	}

	function stopDock(): void {
		if (!dockTimer) return;
		clearInterval(dockTimer);
		dockTimer = undefined;
	}

	/**
	 * 任务有变化（启动 / 终态 / kill）时立刻刷一次，并据此决定要不要秒级 tick。
	 * 弹窗期间**一次也不发布**（连事件驱动的那一下也不）：pi 主屏渲染每次都把视口钉在
	 * 底部，一次重绘同样会把用户手动上翻的 scrollback 拽回去。弹窗一关，`ui_prompt_end`
	 * 按当前真实状态重算，所以什么都不丢（时长也是重算的，不会停在旧值）。
	 */
	function bumpDock(): void {
		if (DOCK_DISABLED || dockFrozen) return;
		if (refreshDock()) startDock();
		else stopDock();
	}

	// 会话替换（/clear、/new、/resume）也会发 session_shutdown，但扩展实例不死：
	// 新会话的 session_start 一到就把 disposed 复位，否则新会话里的后台任务
	// 完成时永远注入不了通知。reload 是另一回事 —— 那里旧 runtime 整个被换掉，
	// 新工厂重新跑，这里的复位不会漏。
	pi.on("session_start", () => {
		disposed = false;
		// 新会话还没有「本轮」：不让上一轮的回合状态漏进来（否则第一轮刚起的长任务
		// 会立刻被标成「本轮已结束」）。
		turnSettledAt = undefined;
	});

	// 本轮开始：回合状态复位，结轮提示随之消失（新一轮进行中时那句话就是假的）。
	pi.on("agent_start", () => {
		turnSettledAt = undefined;
		bumpDock();
	});

	// 本轮结束：开表；下一帧（含秒级 tick）就会给还在跑的任务补上那句提示。
	// 代价明确：任务必须真的跑满阈值（默认 5s），且 dock 得有一帧重绘。
	pi.on("agent_settled", () => {
		if (turnSettledAt !== undefined) return;
		turnSettledAt = Date.now();
		bumpDock();
	});

	// 弹窗期间冻结 dock 的一切发布（与 working-indicator 同一套取舍）。
	pi.on("ui_prompt_start", () => {
		dockFrozen = true;
		stopDock();
	});

	pi.on("ui_prompt_end", () => {
		dockFrozen = false;
		// 只在确实有东西要显示时才重新起表。
		if (registry && registry.listTasks().length > 0) bumpDock();
	});

	function ensureRegistry(ctx: ExtensionContext): Registry {
		lastCtx = ctx;
		if (registry) return registry;

		/**
		 * 任务进终态后的两件事，顺序固定：**先清 worktree，再发通知**。
		 *
		 * 为什么不能反过来：通知是 `triggerTurn` 的 —— 它会立刻起一轮模型跟进，模型可能在
		 * 消息落地前就调 `background_output` / `ls`。先发通知就会把「worktree 还在不在」
		 * 变成一个竞态；先清完再发，通知里的处置结论就是既成事实。代价是通知晚几十毫秒。
		 *
		 * 为什么清理不能包在 `disposed` 判断里：`session_shutdown` 会 `killAll()`，
		 * 那是 worktree 泄漏最多的一条路，必须照清。
		 */
		async function finishTask(task: BackgroundTask): Promise<void> {
			const wt = task.worktree;
			let notice: string | undefined;
			if (wt) {
				const outcome = await cleanupWorktree(wt, `pi/bg_${task.id}`);
				// 三个分支都给一句话：删了要解释「怎么什么都没了」，留了要给路径。
				// 只有「保留了」的路径与分支是模型下一步可能真去用的，所以带上细节。
				notice =
					outcome.kind === "removed"
						? "Isolated worktree: no changes, cleaned up automatically."
						: outcome.kind === "kept"
							? `Isolated worktree: ${outcome.reason}, kept at ${wt.path}${outcome.branch ? ` (branch ${outcome.branch})` : ""}`
							: `Isolated worktree: removal failed (${outcome.reason}), kept at ${wt.path}`;
			}

			// 只认当前 registry 的任务：会话替换后新建了 registry，
			// 旧会话被 killAll 的任务的迟到 exit 不该注入新会话。
			if (disposed || reg !== registry) return;
			// 终态报告的末尾也贴一张任务总览表（用户 2026-10-18 定：与 `run_in_background`
			// 的块同一张表、同一份快照形状）。快照在**这个时刻**冻结 —— 通知落地后其他任务
			// 的状态变化不会重绘这张表，与工具块的口径一致（`table.ts` 决定 1）。
			const now = Date.now();
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: buildNotification(task, now, notice ? [notice] : []),
					display: true,
					details: {
						kind: "terminal",
						task: taskDetails(task, now),
						worktreeNotice: notice,
						...taskSnapshotDetails(reg, now),
					},
				},
				// 空闲 → 直接起一轮；流式中 → 排到本轮结束后（不打断当前推理）
				{ triggerTurn: true, deliverAs: lastCtx?.isIdle?.() ? undefined : "followUp" },
			);
			// dock 立刻换成终态文案（驻留窗口过后由秒级 tick 自己清掉）。
			bumpDock();
		}
		let sessionId = "no-session";
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? "no-session";
		} catch {
			// 拿不到会话 id 就用固定目录（同机多会话会共用，最简版可接受）
		}
		logDir = path.join(resolveLogRoot(), sessionId);
		const reg = createRegistry({
			onTerminal: (task) => {
				// 清理要无条件启动：`disposed` / registry 换了之后不再注入通知，
				// 但该删的 worktree 仍然得删（shutdown 里 killAll 的任务也走这条路）。
				void finishTask(task);
			},
		});
		registry = reg;
		return registry;
	}

	// ── run_in_background ──────────────────────────────────────────────────

	pi.registerTool({
		name: "run_in_background",
		label: "Run In Background",
		...bgToolRenderers("run_in_background", { taskTable: true }),
		description: [
			"Start a shell command in the background and return immediately with a task id and log path.",
			"Use it instead of bash for anything expected to outlive one tool call: test suites, builds, dev servers, watchers, long downloads.",
			"By default the task runs in a fresh git worktree of the current repository (detached at HEAD), so concurrent background tasks never share a working tree. Uncommitted changes are NOT carried over — pass worktree:false to run in the current directory (and see your working-tree edits).",
			"The worktree is deleted automatically when the task finishes without touching any file; if it changed or committed anything the worktree is kept and its path is reported in the terminal notification.",
			"The command keeps running while you do other work. When it reaches a terminal state you are woken automatically by a <background-task-notification> message — do NOT sleep, poll, or call background_output merely to wait for it.",
			"After starting a task, continue with independent work that does not depend on its result, or end the turn; the notification will bring you back.",
			"Background commands do NOT run inside the seatbelt delete boundary that the foreground bash tool uses — treat them as the user having run `cmd &` themselves, and keep destructive work in the foreground.",
		].join("\n"),
		promptSnippet: "Start a long-running shell command in the background; a terminal notification wakes you, so never poll to wait.",
		promptGuidelines: [
			"Use run_in_background instead of bash for commands expected to run longer than a tool timeout (test suites, builds, dev servers, watchers).",
			"Background tasks are isolated in a git worktree at HEAD by default. Anything the running background task itself wrote is NOT in this working tree — only committed content at the time you launched it. To test or verify your own uncommitted edits, pass worktree:false (or run it in the foreground).",
			"Isolation applies per task, so several background tasks can safely run in parallel; but exclusive physical resources (a fixed port, a fixed output directory, a GPU/window) are still shared — serialize those yourself.",
			"It returns immediately. A terminal state is delivered automatically as <background-task-notification> and starts a follow-up turn — never sleep or poll background_output just to wait.",
			"Treat that notification as terminal truth: do not re-check status after it; call background_output only when you actually need the output.",
			"When the notification says the worktree was kept, that task left changes behind — read them from the reported path before launching anything else against the same tree.",
			"Background commands bypass the seatbelt delete boundary; keep destructive commands in the foreground bash tool.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run in the background (executed with /bin/bash -c)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; relative paths resolve against the session cwd. Defaults to the session cwd" })),
			worktree: Type.Optional(
				Type.Boolean({
					description:
						"Default true: run inside a fresh git worktree of the current repo (detached at HEAD, uncommitted changes not included), deleted afterwards if no file was touched. Set false to run directly in the working directory — required when the command must see your uncommitted edits, and the only option for directories that are not git repositories.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = String(params?.command ?? "").trim();
			if (!command) return textResult("command must not be empty.", { ok: false });
			const reg = ensureRegistry(ctx);
			const cwd = params?.cwd ? path.resolve(ctx.cwd, String(params.cwd)) : ctx.cwd;
			if (!fs.existsSync(cwd)) return textResult(`Working directory does not exist: ${cwd}`, { ok: false });

			// 隔离是增强而非前提：不在 git 仓库 / 建失败都**静默降级**在原 cwd 跑，
			// 只把事实告诉模型（另一个选择是拒绝任务，但那会把 /tmp 里跑脚本也一并挡掉）。
			const wantWorktree = params?.worktree !== false && worktreeEnabled();
			let created: CreatedWorktree | undefined;
			let isolationNote: string | undefined;
			if (wantWorktree) {
				const prepared = await prepareWorktree({ cwd, runDir: cwd });
				if (prepared.ok) created = prepared.worktree;
				else isolationNote = `Not isolated (${prepared.reason}); the command runs in ${cwd}.`;
			}

			const task = reg.startTask({
				command,
				cwd: created?.runCwd ?? cwd,
				worktree: created
					? { path: created.path, repoRoot: created.repoRoot, baseCommit: created.baseCommit }
					: undefined,
				logDir,
			});
			if (task.spawnError) {
				// 任务没跑起来，它建的那份 worktree 也就没人清 —— 当场清掉
				if (created) void cleanupWorktree(task.worktree!, `pi/bg_${task.id}`);
				return textResult(`Failed to start: ${task.spawnError}`, { ok: false, task: taskDetails(task, Date.now()) });
			}
			bumpDock();
			// 总览表的**快照**（用户 2026-10-16 选「快照而非实时」）：渲染器只读这份，不读注册表。
			const now = Date.now();
			return textResult(
				[
					`Started ${task.id} in the background (pid ${task.pid ?? "?"}).`,
					`Command: ${truncateCommand(task.command, 120)}`,
					...(created
						? [`Isolated worktree: ${created.path} (a fresh git worktree at HEAD; uncommitted changes are not in it)`]
						: []),
					...(isolationNote ? [isolationNote] : []),
					`Log: ${task.logPath}`,
				].join("\n"),
				{ ok: true, task: taskDetails(task, now), ...taskSnapshotDetails(reg, now) },
			);
		},
	});

	// ── background_output ──────────────────────────────────────────────────

	pi.registerTool({
		name: "background_output",
		label: "Background Output",
		...bgToolRenderers("background_output"),
		description: [
			"Read the output of a background task started with run_in_background.",
			"Incremental by default: each call returns only what was produced since the previous read. Pass offset to re-read from an absolute character position.",
			"This is a point-in-time inspection tool, not a waiting primitive — a running task is not an instruction to call again. Terminal state arrives on its own as <background-task-notification>.",
			"Output is bounded per call; older output beyond the in-memory buffer stays in the log file, whose path is reported in the result.",
		].join("\n"),
		promptSnippet: "Read new output from a background task; incremental by default, never a polling loop.",
		promptGuidelines: [
			"Use background_output only when the user asks for an update, when you need the output content, or when there is concrete evidence a task is hung.",
			"A running result is not a reason to call it again — the terminal notification wakes you on its own.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Task id from run_in_background, e.g. bg_1" }),
			offset: Type.Optional(Type.Number({ description: "Absolute character offset to read from; omit to continue from the last read" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reg = ensureRegistry(ctx);
			const id = String(params?.id ?? "").trim();
			const task = reg.resolveTask(id);
			if (!task) {
				const known = reg.listTasks().map((entry) => entry.id).join(", ");
				return textResult(`No such task: ${id}${known ? ` (known: ${known})` : " (no background task has been started in this session)"}`, { ok: false });
			}
			const offset = typeof params?.offset === "number" ? params.offset : undefined;
			const result = reg.readOutput(task, offset);
			const notes: string[] = [];
			if (result.droppedBefore > 0)
				notes.push(
					`(${result.droppedBefore} characters before the request point already dropped from the in-memory buffer; the full content is in the log file)`,
				);
			if (result.truncatedToTail) notes.push(`(output exceeded ${MAX_READ_CHARS} characters; only the tail is returned)`);
			const body = result.text.length > 0 ? result.text : "(no new output)";
			const header = [
				`${task.id}  ${result.status}${result.status === "running" ? `  running for ${formatElapsed(Date.now() - task.startedAt)}` : `  exit=${result.exitCode ?? task.signal ?? "?"}`}`,
				`offset ${result.from} → ${result.to}${notes.length > 0 ? `  ${notes.join(" ")}` : ""}`,
				`Log: ${task.logPath}`,
			].join("\n");
			return textResult(`${header}\n\n${body}`, { ok: true, task: taskDetails(task, Date.now()), read: result });
		},
	});

	// ── background_kill ────────────────────────────────────────────────────

	pi.registerTool({
		name: "background_kill",
		label: "Background Kill",
		...bgToolRenderers("background_kill"),
		description: [
			"Stop a background task started with run_in_background.",
			"Sends SIGTERM to the task's whole process group, then SIGKILL after a grace period if it is still alive. Pass signal to override.",
			"The task still produces a terminal notification afterwards, with status killed.",
		].join("\n"),
		promptSnippet: "Stop a background task (SIGTERM to its process group, SIGKILL after a grace period).",
		parameters: Type.Object({
			id: Type.String({ description: "Task id from run_in_background, e.g. bg_1" }),
			signal: Type.Optional(Type.String({ description: "Signal name, default SIGTERM" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reg = ensureRegistry(ctx);
			const id = String(params?.id ?? "").trim();
			const signal = (String(params?.signal ?? "SIGTERM").trim() || "SIGTERM") as NodeJS.Signals;
			const result = reg.killTask(id, signal);
			if (!result.ok) return textResult(result.reason ?? `Cannot kill ${id}`, { ok: false });
			const task = reg.resolveTask(id);
			bumpDock();
			return textResult(
				`Sent ${signal} to ${id} (whole process group); if it has not exited after ${formatElapsed(Date.now() - (task?.startedAt ?? Date.now()))}, SIGKILL follows.`,
				{ ok: true, task: task ? taskDetails(task, Date.now()) : undefined },
			);
		},
	});

	// ── /background 命令（仿 CC 的 /bashes）────────────────────────────────

	pi.registerCommand("background", {
		description: "Background tasks: /background lists them; /background <id> shows details plus the output tail; /background kill <id> stops one",
		getArgumentCompletions: (prefix: string) => {
			if (!registry) return null;
			const trimmed = prefix.trim();
			const items: Array<{ value: string; label: string; description?: string }> = [];
			if ("kill".startsWith(trimmed)) items.push({ value: "kill ", label: "kill", description: "Stop a background task" });
			for (const task of registry.listTasks()) {
				if (trimmed && !task.id.startsWith(trimmed) && !`kill ${task.id}`.startsWith(trimmed)) continue;
				items.push({ value: task.id, label: task.id, description: `${task.status} ${truncateCommand(task.command, 40)}` });
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const reg = ensureRegistry(ctx);
			const now = Date.now();

			if (parts.length === 0) {
				const tasks = reg.listTasks();
				const running = reg.runningCount();
				const lines = [
					`Background tasks: ${tasks.length} (${running} running)`,
					formatTaskList(tasks, now),
					"",
					"Log directory: " + (logDir || resolveLogRoot()),
					"Note: background commands are not subject to the foreground bash seatbelt delete boundary.",
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (parts[0] === "kill") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("Usage: /background kill <id>", "warning");
					return;
				}
				const result = reg.killTask(id);
				bumpDock();
				ctx.ui.notify(result.ok ? `Sent SIGTERM to ${id}` : (result.reason ?? `Cannot kill ${id}`), result.ok ? "info" : "warning");
				return;
			}

			const task = reg.resolveTask(parts[0]);
			if (!task) {
				ctx.ui.notify(`No such task: ${parts[0]}. Run /background to list them.`, "warning");
				return;
			}
			// 详情：状态行 + 输出尾部（从 0 读会推进 readOffset，所以这里直接读日志文件尾部，
			// 不干扰模型侧 background_output 的增量语义）
			let tail = "";
			try {
				const content = fs.readFileSync(task.logPath, "utf-8");
				tail = content.length > 4000 ? `… (${content.length - 4000} earlier characters omitted)\n${content.slice(-4000)}` : content;
			} catch {
				tail = "(log unreadable)";
			}
			ctx.ui.notify(
				[
					formatTaskLine(task, now),
					`cwd: ${task.cwd}`,
					`Log: ${task.logPath}`,
					"",
					tail.trimEnd() || "(no output yet)",
				].join("\n"),
				"info",
			);
		},
	});

	// ── 终态通知的渲染（与工具块同一棵树：圆点顶格、对号在行末）────────────

	/**
	 * 终态通知不再套 `customMessageBg` 底色与 `Box(_, 1)` 的上下空行（用户 2026-09-30 定），
	 * 改成与三个工具块、plan 块同一张表的树形：
	 *
	 * ```
	 * • Background task bg_1 finished ✔
	 *   │ 后台任务 bg_1 已成功结束（exit 0），运行 5s。
	 *   │ 完整日志：/…/bg_1.log
	 *   └ ┌──────┬────────────┬─────────┬──────┐
	 *     │ id   │ command    │ status  │ time │
	 *     …
	 * ```
	 *
	 * 标题文字走 `toolTitle` 槽（与工具名同一个 Title 色）；**只要任务结束就打 `✔`**（用户
	 * 2026-09-30 定），且 `✔` 与圆点**同色**：exit 0 时两者都走 `success`（绿），失败 / 被 kill
	 * 时两者都走 `error`（红）—— 结局分类在 `classifyBgNotificationOutcome`。所以「跑成了」与
	 * 「没跑成」靠**圆点颜色 + 正文措辞**（`已成功结束` / `已失败结束（exit=1）`）区分，而不是
	 * 靠把对号换成叉号。正文走**结果正文色**（与 bash 工具调用后的输出同色：
	 * `bashOutput`，主题没定义时退回 `toolOutput`，见 `pickBodySlot`；用户 2026-10-06 定），
	 * 结构符 `│` / `└`
	 * 走 `muted`。
	 *
	 * **末尾贴任务总览表**（用户 2026-10-18 定）：与 `run_in_background` 的块用同一种表
	 * （`table.ts`）、同一份快照形状（`details.tasks` / `details.tableNow`）、同一条几何规则 ——
	 * 右侧留 `TABLE_RIGHT_MARGIN`，正文树**不闭合**、`└ ` 交给表格顶边框。读快照不读注册表，
	 * 所以这条历史消息永不重绘。表格画不出来（宽度不够）时退回旧形态（正文末行挂 `└ `）。
	 *
	 * 不套 Box 也意味着不再用 `outputPad` 做水平内边距：圆点**顶格**（列 0），与 self 壳的
	 * 工具块对齐 —— 两种块相邻时树才对得上。上方仍有一行空行，那是 `CustomMessageComponent`
	 * 构造时写死的 `Spacer(1)`（去不掉，pi 的 self 壳工具块同样留一行）。
	 */
	pi.registerMessageRenderer<{
		kind: string;
		task: Record<string, unknown>;
		/** 任务总览表的快照（旧消息没有这两个字段，那就退回旧形态）。 */
		tasks?: unknown;
		tableNow?: unknown;
	}>(CUSTOM_TYPE, (message, _options, theme) => {
		const body = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
		const details = message.details;
		const task = details?.task;
		const outcome = classifyBgNotificationOutcome(task);
		const parts = bgNotificationTitleParts(outcome);
		const title = `Background task ${String(task?.id ?? "")} finished`;
		// 正文里的 <background-task-notification> 包裹标签是写给模型的，界面上不重复显示
		const sourceLines = body.replace(/<\/?background-task-notification>/g, "").trim().split("\n");
		// 总览表快照（与 `run_in_background` 的块同一份形状）。旧消息 / 没快照 → 不画表。
		const snapshot = taskSnapshot(details);
		const tableTasks = snapshot?.tasks ?? [];
		const tableNow = snapshot?.now ?? 0;
		// 通知是静态的，按 width 缓存排版（与工具块同一套做法）
		const cache = new Map<number, string[]>();
		return {
			render(width: number): string[] {
				const hit = cache.get(width);
				if (hit !== undefined) return hit;
				const total = Math.max(1, width || 80);
				// 标题行顶格（不挂 BODY_INDENT），所以折行预算就是整个宽度。
				// 行末 `✔` 恒在（只要结束就是 ✔），与圆点同色。
				const titleText =
					`${theme.fg(parts.dotSlot, "\u2022")} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg(parts.markSlot, parts.mark)}`;
				const lines = wrapTextWithAnsi(titleText, total);
				const bodyWidth = Math.max(1, total - BODY_INDENT.length - GUTTER_WIDTH);
				const rows: string[] = [];
				for (const line of sourceLines) {
					// `Full log: <路径>` 同样不折行（与工具块里的 `Log:` 同一套处理）。
					rows.push(...wrapTextWithAnsi(fitLogLine(line, bodyWidth, piTui.visibleWidth), bodyWidth));
				}
				// 通知正文恒为四行量级，不做预览截断（它是要用户读的事实陈述）
				// 正文颜色：与 bash 工具调用后的输出同色（bashOutput，没定义时 toolOutput）
				const bodySlot = pickBodySlot(theme);
				// 表格先算：它在不在决定正文树要不要闭合 —— `└ ` 得接在最后一个**真正画出来**的
				// 东西后面，不能为一张没画的表提前收口（与工具块同一条规则）。
				const tableLines =
					tableTasks.length > 0
						? paintTableRows(
								renderTaskTable(tableTasks as unknown as Parameters<typeof renderTaskTable>[0], {
									width: tableWidthFor(bodyWidth),
									now: tableNow,
									widthOf: (text: string) => piTui.visibleWidth(text),
								}),
								theme,
								bodySlot,
							)
						: [];
				const prefixes = bgResultTreePrefixes(rows.length, tableLines.length === 0);
				for (let index = 0; index < rows.length; index += 1) {
					lines.push(
						BODY_INDENT +
							// 不闭合时**每一行**都是 `│ `（包括末行），`└ ` 交给表格首行。
							// 行数算错（比如把折行碎片漏算）会让树提前收口，所以行数交给
							// `bgResultTreePrefixes`，索引超出范围时兜底 `│ `。
							theme.fg("dim", prefixes[index] ?? TREE_PIPE) +
							paintBodyRow(theme, rows[index]!, bodySlot),
					);
				}
				lines.push(...tableLines);
				cache.set(width, lines);
				return lines;
			},
			invalidate() {
				cache.clear();
			},
		};
	});

	// ── bg_wait：pi-subagents 的后台等待工具，同一棵树 ─────────────────
	//
	// `bg_wait` 不在本扩展的工具表里（pi-subagents 注册），所以不能像上面三个工具那样
	// 直接在定义里带 `renderShell`。`pi.registerToolRenderer` 是 pi 1.3.0 提供的
	// 「只换渲染、不动工具」的钩子：解析器按加载顺序串联，`next()` 落到下一个解析器 /
	// 已注册的工具定义。这里**不调 `next()`**（我们就是要盖过默认壳的底色与上下空行），
	// 其余工具名原样交回去。
	pi.registerToolRenderer((toolName, next) => {
		if (toolName !== BG_WAIT_TOOL) return next();
		return bgToolRenderers(BG_WAIT_TOOL, { classify: classifyBgWaitOutcome });
	});

	// ── 生命周期：任务随会话生死 ───────────────────────────────────────────

	pi.on("session_shutdown", () => {
		disposed = true;
		stopDock();
		try {
			lastCtx?.ui.setStatus(DOCK_STATUS_KEY, undefined);
		} catch {
			// stale ctx：状态随会话一起消失。
		}
		registry?.killAll();
		registry?.dispose();
		registry = undefined;
		lastCtx = undefined;
	});
}
