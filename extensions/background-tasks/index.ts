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
 *     └ 本轮已结束，该任务仍在运行
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
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

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
	GUTTER_WIDTH,
	PREVIEW_MAX_LINES,
	TREE_PIPE,
	bgNotificationTitleParts,
	bgResultTreePrefixes,
	bgToolTitleParts,
	classifyBgNotificationOutcome,
	classifyBgToolOutcome,
	previewMoreLinesHint,
	type BgToolOutcome,
} from "./render.ts";

const CUSTOM_TYPE = "background-task";

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

/** 终态通知正文（模型看到的就是这段）。`extraLines` 放 worktree 的处置结果。 */
function buildNotification(task: BackgroundTask, now: number, extraLines: readonly string[] = []): string {
	const outcome =
		task.status === "killed"
			? `被终止（${task.signal ?? "SIGTERM"}）`
			: task.exitCode === 0
				? "成功结束（exit 0）"
				: `失败结束（exit=${task.exitCode ?? "?"}${task.signal ? ` signal=${task.signal}` : ""}）`;
	return [
		"<background-task-notification>",
		`后台任务 ${task.id} 已${outcome}，运行 ${formatElapsed((task.endedAt ?? now) - task.startedAt)}。`,
		`命令：${truncateCommand(task.command, 120)}`,
		...extraLines,
		`这是终态事实，不需要再调 background_output 确认状态；只有需要看输出内容时才调它（id: ${task.id}）。`,
		`完整日志：${task.logPath}`,
		"</background-task-notification>",
	].join("\n");
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

/** 把结果里的所有 text 块拼成全文（按块顺序，块之间换行）。 */
function bgResultText(result: BgToolResultLike): string {
	const blocks = Array.isArray(result.content) ? result.content : [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
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
 * `│` 落在工具名首字母正下方）—— 除末行外 `│ `，**末行 `└ `**。结构符走 `muted` 槽且
 * **自成一段 SGR**，不让正文色透上来。正文走 `text` 槽（与 `exit_plan_mode` 下方正文
 * 同色，用户 2026-09-30 定）。
 *
 * ## 预览截断（保留 pi 默认壳原有的行为）
 *
 * pi 默认壳把正文裁到 10 行并给 `... (N more lines, ctrl+o to expand)` 提示；换 self 壳
 * 后这条裁剪会消失，所以这里自己补回来（`PREVIEW_MAX_LINES` + `previewMoreLinesHint`），
 * 否则 `background_output` 一次 30000 字符的返回会平铺满屏。展开态（ctrl+o，`expanded`）
 * 不裁，与 bash / tool-diff 块一致。截断按**折行之后**的视觉行数算（与树前缀同口径）。
 */
function bgToolRenderers(toolName: string) {
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
				context.state.outcome = classifyBgToolOutcome(context.isError === true, result?.details);
			}
			const sourceLines = bgResultText(result ?? {}).split("\n");
			const expanded = options?.expanded === true;
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
						rows.push(...wrapTextWithAnsi(line, bodyWidth));
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
					const lineCount = visible.length + (hidden > 0 ? 1 : 0);
					const prefixes = bgResultTreePrefixes(lineCount);
					const lines = visible.map(
						(row, index) => BODY_INDENT + theme.fg("muted", prefixes[index] ?? TREE_PIPE) + theme.fg("text", row),
					);
					if (hidden > 0) {
						lines.push(
							BODY_INDENT +
								theme.fg("muted", prefixes[visible.length] ?? TREE_PIPE) +
								theme.fg("muted", previewMoreLinesHint(hidden)),
						);
					}
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
						? "隔离工作区：无改动，已自动清理。"
						: outcome.kind === "kept"
							? `隔离工作区：${outcome.reason}，已保留在 ${wt.path}${outcome.branch ? `（分支 ${outcome.branch}）` : ""}`
							: `隔离工作区：删除失败（${outcome.reason}），已保留在 ${wt.path}`;
			}

			// 只认当前 registry 的任务：会话替换后新建了 registry，
			// 旧会话被 killAll 的任务的迟到 exit 不该注入新会话。
			if (disposed || reg !== registry) return;
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: buildNotification(task, Date.now(), notice ? [notice] : []),
					display: true,
					details: { kind: "terminal", task: taskDetails(task, Date.now()), worktreeNotice: notice },
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
		...bgToolRenderers("run_in_background"),
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
			if (!command) return textResult("command 不能为空。", { ok: false });
			const reg = ensureRegistry(ctx);
			const cwd = params?.cwd ? path.resolve(ctx.cwd, String(params.cwd)) : ctx.cwd;
			if (!fs.existsSync(cwd)) return textResult(`工作目录不存在：${cwd}`, { ok: false });

			// 隔离是增强而非前提：不在 git 仓库 / 建失败都**静默降级**在原 cwd 跑，
			// 只把事实告诉模型（另一个选择是拒绝任务，但那会把 /tmp 里跑脚本也一并挡掉）。
			const wantWorktree = params?.worktree !== false && worktreeEnabled();
			let created: CreatedWorktree | undefined;
			let isolationNote: string | undefined;
			if (wantWorktree) {
				const prepared = await prepareWorktree({ cwd, runDir: cwd });
				if (prepared.ok) created = prepared.worktree;
				else isolationNote = `未隔离（${prepared.reason}），命令在 ${cwd} 里跑。`;
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
				return textResult(`启动失败：${task.spawnError}`, { ok: false, task: taskDetails(task, Date.now()) });
			}
			bumpDock();
			return textResult(
				[
					`已在后台启动 ${task.id}（pid ${task.pid ?? "?"}）。`,
					`命令：${truncateCommand(task.command, 120)}`,
					...(created ? [`隔离工作区：${created.path}（从 HEAD 新建的 git worktree，未提交的改动不在里面）`] : []),
					...(isolationNote ? [isolationNote] : []),
					`日志：${task.logPath}`,
					"它会自己跑；终态时你会收到 <background-task-notification> 并被叫醒。现在去做别的不依赖它的工作，或者结束本轮 —— 不要 sleep 或轮询等它。",
					`需要中途看输出用 background_output（id: ${task.id}），要停掉用 background_kill。`,
				].join("\n"),
				{ ok: true, task: taskDetails(task, Date.now()) },
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
				return textResult(`没有这个任务：${id}${known ? `（已知：${known}）` : "（本会话还没启动过后台任务）"}`, { ok: false });
			}
			const offset = typeof params?.offset === "number" ? params.offset : undefined;
			const result = reg.readOutput(task, offset);
			const notes: string[] = [];
			if (result.droppedBefore > 0) notes.push(`（请求点之前有 ${result.droppedBefore} 字符已超出内存缓冲，完整内容在日志文件里）`);
			if (result.truncatedToTail) notes.push(`（本次输出超过 ${MAX_READ_CHARS} 字符，只返回了尾部）`);
			const body = result.text.length > 0 ? result.text : "（没有新输出）";
			const header = [
				`${task.id}  ${result.status}${result.status === "running" ? `  已运行 ${formatElapsed(Date.now() - task.startedAt)}` : `  exit=${result.exitCode ?? task.signal ?? "?"}`}`,
				`offset ${result.from} → ${result.to}${notes.length > 0 ? `  ${notes.join(" ")}` : ""}`,
				`日志：${task.logPath}`,
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
			if (!result.ok) return textResult(result.reason ?? `杀不掉 ${id}`, { ok: false });
			const task = reg.resolveTask(id);
			bumpDock();
			return textResult(
				`已向 ${id} 发送 ${signal}（整个进程组）；${formatElapsed(Date.now() - (task?.startedAt ?? Date.now()))} 后仍未退出会补 SIGKILL。`,
				{ ok: true, task: task ? taskDetails(task, Date.now()) : undefined },
			);
		},
	});

	// ── /background 命令（仿 CC 的 /bashes）────────────────────────────────

	pi.registerCommand("background", {
		description: "后台任务：/background 列表；/background <id> 详情+输出尾部；/background kill <id> 停掉",
		getArgumentCompletions: (prefix: string) => {
			if (!registry) return null;
			const trimmed = prefix.trim();
			const items: Array<{ value: string; label: string; description?: string }> = [];
			if ("kill".startsWith(trimmed)) items.push({ value: "kill ", label: "kill", description: "停掉一个后台任务" });
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
					`后台任务 ${tasks.length} 个（在跑 ${running}）：`,
					formatTaskList(tasks, now),
					"",
					"日志目录：" + (logDir || resolveLogRoot()),
					"提示：后台命令不经过前台 bash 的 seatbelt 删除边界。",
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (parts[0] === "kill") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("用法：/background kill <id>", "warning");
					return;
				}
				const result = reg.killTask(id);
				bumpDock();
				ctx.ui.notify(result.ok ? `已向 ${id} 发送 SIGTERM` : (result.reason ?? `杀不掉 ${id}`), result.ok ? "info" : "warning");
				return;
			}

			const task = reg.resolveTask(parts[0]);
			if (!task) {
				ctx.ui.notify(`没有这个任务：${parts[0]}。用 /background 看列表。`, "warning");
				return;
			}
			// 详情：状态行 + 输出尾部（从 0 读会推进 readOffset，所以这里直接读日志文件尾部，
			// 不干扰模型侧 background_output 的增量语义）
			let tail = "";
			try {
				const content = fs.readFileSync(task.logPath, "utf-8");
				tail = content.length > 4000 ? `…（前面 ${content.length - 4000} 字符略）\n${content.slice(-4000)}` : content;
			} catch {
				tail = "（日志读不到）";
			}
			ctx.ui.notify(
				[
					formatTaskLine(task, now),
					`cwd: ${task.cwd}`,
					`日志: ${task.logPath}`,
					"",
					tail.trimEnd() || "（还没有输出）",
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
	 * • 后台任务 bg_1 结束 ✔
	 *   │ 后台任务 bg_1 已成功结束（exit 0），运行 5s。
	 *   └ 完整日志：/…/bg_1.log
	 * ```
	 *
	 * 标题文字走 `toolTitle` 槽（与工具名同一个 Title 色）；**只要任务结束就打 `✔`**（用户
	 * 2026-09-30 定），且 `✔` 与圆点**同色**：exit 0 时两者都走 `success`（绿），失败 / 被 kill
	 * 时两者都走 `error`（红）—— 结局分类在 `classifyBgNotificationOutcome`。所以「跑成了」与
	 * 「没跑成」靠**圆点颜色 + 正文措辞**（`已成功结束` / `已失败结束（exit=1）`）区分，而不是
	 * 靠把对号换成叉号。正文走 `text` 槽（与 `exit_plan_mode` 下方正文同色），结构符 `│` / `└`
	 * 走 `muted`。
	 *
	 * 不套 Box 也意味着不再用 `outputPad` 做水平内边距：圆点**顶格**（列 0），与 self 壳的
	 * 工具块对齐 —— 两种块相邻时树才对得上。上方仍有一行空行，那是 `CustomMessageComponent`
	 * 构造时写死的 `Spacer(1)`（去不掉，pi 的 self 壳工具块同样留一行）。
	 */
	pi.registerMessageRenderer<{ kind: string; task: Record<string, unknown> }>(CUSTOM_TYPE, (message, _options, theme) => {
		const body = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
		const task = message.details?.task;
		const outcome = classifyBgNotificationOutcome(task);
		const parts = bgNotificationTitleParts(outcome);
		const title = `后台任务 ${String(task?.id ?? "")} 结束`;
		// 正文里的 <background-task-notification> 包裹标签是写给模型的，界面上不重复显示
		const sourceLines = body.replace(/<\/?background-task-notification>/g, "").trim().split("\n");
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
					rows.push(...wrapTextWithAnsi(line, bodyWidth));
				}
				// 通知正文恒为四行量级，不做预览截断（它是要用户读的事实陈述）
				const prefixes = bgResultTreePrefixes(rows.length);
				for (let index = 0; index < rows.length; index += 1) {
					lines.push(BODY_INDENT + theme.fg("muted", prefixes[index] ?? TREE_PIPE) + theme.fg("text", rows[index]!));
				}
				cache.set(width, lines);
				return lines;
			},
			invalidate() {
				cache.clear();
			},
		};
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
