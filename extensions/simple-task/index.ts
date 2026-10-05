/**
 * simple-task — 轻量级任务清单扩展。
 *
 * 2026-09-23 到 2026-09-24 之间它曾兼作 plan-mode 执行期的唯一进度表（plan-mode 批准
 * 计划时把步骤镜像进来，id = 步号、文案带 `plan: n. ` 前缀）。那套镜像已随 plan-mode
 * 的 execute 态一起删除：计划批准后进度归模型自己，它认为该建清单就调 `task_set`，
 * 扩展不再代它建、也不再读它的状态。本扩展现在是一份普通的任务清单。
 *
 * 功能参照 @thunstack/pi-task-list（会话级、agent 自主管理、无需 plan 模式），
 * 样式参照 @tintinweb/pi-tasks（● 头部统计 + ◻/◼/✔ 符号 + 星形 spinner + 完成项删除线）。
 *
 * 为什么自己写而不是用现成的两个：
 *   - @tintinweb/pi-tasks 功能全但重（十几个文件 + 文件锁 store + 一堆配置项），
 *     而且默认 taskScope 会把 `.pi/tasks/tasks-<sessionId>.json` 写进工作仓库，
 *     每个仓库都得加一条 .gitignore。
 *   - @thunstack/pi-task-list 够轻，但样式硬编码（☐ ◐ ☑ ⚠ ↷ + 📋 emoji），
 *     想改样式只能 fork 到本地路径包，得自己维护上游同步。
 *   自己写一份就不用背 fork 的维护责任，样式想怎么改都行。
 *
 * 刻意保持轻量：
 *   - 三种状态（pending / in_progress / done），无区块、无依赖图、无 note
 *   - 三个工具 + 一个命令
 *   - 零 npm 依赖：只用宿主提供的 pi / pi-tui（peerDependencies）
 *   - **零文件写入**：状态通过 pi.appendEntry() 挂在会话日志上，从不往工作仓库写东西
 *   - 颜色全走 theme.fg()，无硬编码 —— 换 pi 主题即换配色
 *   - 不强制任务标题字数（pi-task-list 的 3–15 词校验经常误伤短标题）
 *
 * **视口滚动**（用户 2026-10-02 定）：一帧最多画 8 条任务项，但窗口不再固定从 #1 开始 ——
 * 前八项做完、执行到第 9 项时列表会**跟着往下滚**，让当前项进入视口：
 *
 *     ● 13 tasks (10 done, 1 in progress, 2 open)
 *         … 3 more
 *       ✔ #4 Task 4
 *       …
 *       ✔ #10 Task 10
 *       ▣ #11 Task 11…
 *         … and 2 more
 *
 * 三条规则（`viewport.ts`，纯函数、可单测）：**锚点 = 第一个未完成项**、**最小位移**
 * （锚点已在窗口内就不动，不为了居中而乱滚）、**全部完成时停在末尾**（不跳回开头）。
 * 两侧的 `… N more` / `… and N more` 提示行**不占那 8 个名额** —— 用户要求
 * 「视口范围内的项数就是视口大小」；上行提示只在真的滚过时才出现（8 项以内与改动前逐字节相同）。
 *
 * 放在 `~/.pi/agent/extensions/simple-task/`（pi 支持 extensions 下的子目录形式：
 * 目录里放 index.ts 作为入口，见 docs/extensions.md 的放置规则表），
 * 属于自动发现目录，所以支持 `/reload` 热重载。
 *
 * 注意：注释里不能写 `extensions/`+星号+`/index.ts` 这种 glob —— 里面的星号紧跟斜杠
 * 会提前闭合块注释，导致后面全部被当成代码解析。
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cloneState,
	countByStatus,
	describeTasks,
	emptyState,
	isComplete,
	type State,
	type TaskStatus,
} from "./types.ts";
// 只引 buildWidgetLines：GLYPHS 只被 widget 自己的渲染用，本文件不再直接碰符号表。
import { buildWidgetLines } from "./widget.ts";
import { widgetGaps } from "./gap.ts";

const WIDGET_KEY = "simple-task";
const ENTRY_TYPE = "simple-task-state";
const SPINNER_MS = 150;
const TOOL_NAMES = ["task_set", "task_update", "task_get"] as const;

/** 工具返回里携带结构化状态，供 renderResult 读取计数。 */
interface ToolDetails {
	action: "set" | "update" | "get";
	state: State;
}

const STATUS_VALUES = ["pending", "in_progress", "done"] as const;

export default function simpleTaskExtension(pi: ExtensionAPI): void {
	let state: State = emptyState();
	let enabled = true;
	let frame = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;

	// ── 持久化 ────────────────────────────────────────────────────────────

	/**
	 * 状态挂在会话日志上（pi.appendEntry），不写任何文件。
	 * 这是本扩展最重要的设计决定：既不污染工作仓库，又能跨 resume 保留。
	 */
	function persist(): void {
		pi.appendEntry(ENTRY_TYPE, { state: cloneState(state), enabled, updatedAt: Date.now() });
	}

	/**
	 * 用 getBranch() 而不是 getEntries()：分支导航（回退到旧消息再继续）时必须
	 * 跟着当前分支走，否则会把已丢弃分支上的任务状态复活。
	 * 取最后一条 —— 每条都是全量快照，最新的即当前状态。
	 */
	function reconstruct(ctx: ExtensionContext): void {
		state = emptyState();
		enabled = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as { state?: State; enabled?: boolean } | undefined;
			if (data?.state) state = cloneState(data.state);
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
		}
	}

	// ── UI ────────────────────────────────────────────────────────────────

	/**
	 * spinner 定时器只在有进行中任务时运行。
	 * 帧递增只发生在这里（照抄 pi-tasks 的做法，它的注释解释得很清楚）：
	 * 若把递增放进 updateUi()，动画速度就会跟着 agent 的繁忙程度变化，
	 * 忙的时候飞转、闲的时候卡住。
	 */
	function stopTimer(): void {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	function ensureTimer(): void {
		const needsAnimation = enabled && state.tasks.some((task) => task.status === "in_progress");
		if (needsAnimation && timer === undefined) {
			timer = setInterval(() => {
				frame += 1;
				// 定时器可能比会话活得久：ctx 失效后访问 ctx.ui 会抛
				// （docs/extensions.md：捕获的 ctx 在会话替换后是 stale，使用即抛），
				// 而抛出发生在 render 之前，render 里的 try/catch 拦不住。
				// 所以这里自己兜住，并且直接停表 —— ctx 没了，动画也没意义了。
				try {
					updateUi(lastCtx);
				} catch {
					stopTimer();
					lastCtx = undefined;
				}
			}, SPINNER_MS);
		} else if (!needsAnimation) {
			stopTimer();
		}
	}

	function updateUi(ctx?: ExtensionContext): void {
		if (!ctx) return;
		lastCtx = ctx;

		const visible = enabled && state.active && state.tasks.length > 0;
		if (!visible) {
			// ctx 可能已 stale（会话结束 / reload / 切换会话），ctx.ui 的 getter 会抛。
			// 吞掉即可 —— 界面本来就要消失，没什么可渲染的。
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				/* ctx 已失效 */
			}
			ensureTimer();
			return;
		}

		// 快照 + 每次重新注册：工厂闭包住快照（所以状态不会边渲染边变），
		// 而 frame 是可变变量、在 render 时才读 —— 这就是 spinner 能转的原因。
		const snapshot = cloneState(state);
		try {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				// 自引用：render 时要用组件自己的身份，去编辑器上方的 widget 容器里定位自己，
				// 从而判断上下是否还挨着别的 widget（pi-subagents 的 async 块、recap 摘要…）
				// 并补一行空行。细节与理由见 gap.ts 的文件头。
				const component = {
					render(width: number): string[] {
						// 渲染异常绝不能逃出去崩掉宿主进程 —— 最坏情况只是这一帧 widget 为空。
						// pi-tasks 有同样的保护，它的注释说明了理由。
						try {
							const lines = buildWidgetLines(snapshot, frame, theme, width);
							if (lines.length === 0) return lines;
							const gaps = widgetGaps(tui, component, width);
							if (gaps.above) lines.unshift("");
							if (gaps.below) lines.push("");
							return lines;
						} catch {
							return [];
						}
					},
					invalidate() {},
				};
				return component;
			});
		} catch {
			stopTimer();
			lastCtx = undefined;
			return;
		}
		ensureTimer();
	}

	function setState(next: State, ctx?: ExtensionContext): void {
		state = cloneState(next);
		persist();
		updateUi(ctx);
	}

	function details(action: ToolDetails["action"]): ToolDetails {
		return { action, state: cloneState(state) };
	}

	function assertEnabled(): void {
		if (!enabled) throw new Error("Task tracking is disabled for this session. Use /tasks on to re-enable.");
	}

	// ── 工具 ──────────────────────────────────────────────────────────────

	// 三个工具都带 `renderShell: "self"`：让 pi 不再给整块套 `contentBox`
	//（tool-execution.js 里那是个 `Box(1, 1, bgFn)`），于是
	//   ① **没有底色**（pending 的 `toolPendingBg` / 成功的 `toolSuccessBg` /
	//      失败的 `toolErrorBg` 都不画 —— selfRenderContainer 是纯 Container，
	//      `renderContainer instanceof Box` 为 false，bgFn 套不上去），
	//   ② **没有上下边界空行与左右 padding**（都是那个 Box 画的）。
	// 与 bash（bash-command-collapse.ts）/ read（read-path-collapse.ts）块同一套观感：
	// 块上方只剩 pi self 模式固定的那一行留白（render() 里 `lines.push("")`），下方紧贴
	// 下一条消息。renderCall / renderResult 返回的 Text 用 `new Text(…, 1, 0)`：
	// **paddingX = 1** 补回默认壳 `Box(1, 1)` 原本提供的那一列左边距 —— 每行前置一个空格、
	// 不顶格（用户 2026-09-26 定）；**paddingY = 0** 保持上下不留空行；无 bgFn，所以不包 Box。
	pi.registerTool({
		name: "task_set",
		label: "Task Set",
		renderShell: "self",
		description:
			"Create or replace the session task list for multi-step work. Pass an empty array to clear the list.",
		promptSnippet: "Create or replace the session task list.",
		promptGuidelines: [
			"Use task_set for 3+ meaningful steps, multiple files or phases, debugging/research loops, validation passes, or when the user asks for progress tracking.",
			"Do not use task_set for simple Q&A, quick explanations, or one or two obvious actions.",
			"When the objective changes or the current list is obsolete, replace it with task_set instead of appending forever.",
			"Mark progress with task_update rather than writing done markers in prose.",
		],
		parameters: Type.Object({
			tasks: Type.Array(Type.String({ description: "Short actionable task label" }), {
				description: "Ordered task list items; an empty array clears the list",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertEnabled();
			const raw = Array.isArray(params?.tasks) ? params.tasks : [];
			// 只去空白与空串，不校验字数 —— pi-task-list 的 3–15 词限制经常误伤短标题。
			const texts = raw.map((item) => String(item).trim()).filter((text) => text.length > 0);

			if (texts.length === 0) {
				setState(emptyState(), ctx);
				return {
					content: [{ type: "text" as const, text: "Task list cleared." }],
					details: details("set"),
				};
			}

			setState(
				{
					active: true,
					nextId: texts.length + 1,
					tasks: texts.map((text, index) => ({ id: index + 1, text, status: "pending" as TaskStatus })),
				},
				ctx,
			);
			return {
				content: [{ type: "text" as const, text: `Task list set with ${texts.length} task(s).` }],
				details: details("set"),
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;
			return new Text(
				theme.fg("toolTitle", theme.bold("task_set ")) + theme.fg("muted", `${count} task(s)`),
				1,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const data = result.details as ToolDetails | undefined;
			const count = data?.state.tasks.length ?? 0;
			const text = count === 0 ? "Task list cleared." : `Task list ready: ${count} task(s)`;
			return new Text(theme.fg("success", "✔ ") + theme.fg("muted", text), 1, 0);
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Task Update",
		renderShell: "self",
		description: "Update the status of one task in the active task list.",
		promptSnippet: "Update one task's status in the active task list.",
		promptGuidelines: [
			"Use task_update immediately when starting or finishing a tracked task.",
			"Prefer marking a task in_progress before starting and done when it finishes — that is what drives the spinner. The order is not enforced, so a direct pending → done is tolerated rather than corrected.",
			"Prefer task_update over text-only done markers whenever a task list is active.",
		],
		parameters: Type.Object({
			id: Type.Number({ description: "Task ID to update" }),
			status: Type.Union(STATUS_VALUES.map((value) => Type.Literal(value)), {
				description: "New status: pending, in_progress, or done",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			assertEnabled();
			if (!state.active || state.tasks.length === 0) throw new Error("No active task list. Call task_set first.");
			const task = state.tasks.find((item) => item.id === params.id);
			if (!task) throw new Error(`Task #${params.id} not found.`);

			const next = cloneState(state);
			const target = next.tasks.find((item) => item.id === params.id);
			if (target) target.status = params.status as TaskStatus;

			setState(next, ctx);
			const completeText = isComplete(state) ? " All tasks are now complete." : "";
			return {
				content: [{ type: "text" as const, text: `Task #${params.id} → ${params.status}.${completeText}` }],
				details: details("update"),
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("task_update ")) +
					theme.fg("muted", `#${args?.id ?? "?"} → ${args?.status ?? "?"}`),
				1,
				0,
			);
		},
		renderResult(result, _options, theme) {
			// content 元素可能是 ImageContent，必须先判别再取 text
			const first = result?.content?.[0];
			const text =
				first && "text" in first && typeof first.text === "string" ? first.text : "updated";
			return new Text(theme.fg("success", "✔ ") + theme.fg("muted", text), 1, 0);
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Task Get",
		renderShell: "self",
		description: "Read the active task list with current statuses.",
		promptSnippet: "Read the active task list.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			assertEnabled();
			const lines = describeTasks(state);
			const text = lines.length === 0 ? "No active task list." : lines.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: details("get"),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("task_get")), 1, 0);
		},
		renderResult(result, _options, theme) {
			const data = result.details as ToolDetails | undefined;
			const count = data?.state.tasks.length ?? 0;
			const { done } = data ? countByStatus(data.state) : { done: 0 };
			return new Text(
				theme.fg("success", "✔ ") + theme.fg("muted", count === 0 ? "No active task list" : `${done}/${count} done`),
				1,
				0,
			);
		},
	});

	// ── 命令 ──────────────────────────────────────────────────────────────

	async function handleTasksCommand(args: string, ctx: ExtensionContext): Promise<void> {
		lastCtx = ctx;
		const sub = args.trim().toLowerCase();

		if (sub === "off" || sub === "on") {
			enabled = sub === "on";
			persist();
			updateUi(ctx);
			ctx.ui.notify(enabled ? "Task tracking enabled." : "Task tracking disabled for this session.", "info");
			return;
		}

		if (sub === "clear") {
			setState(emptyState(), ctx);
			ctx.ui.notify("Task list cleared.", "info");
			return;
		}

		// 默认（含 "status" 与无参数）：打印当前清单
		if (!enabled) {
			ctx.ui.notify("Task tracking is disabled. Use /tasks on to re-enable.", "info");
			return;
		}
		const lines = describeTasks(state);
		if (lines.length === 0) {
			ctx.ui.notify("No active task list.", "info");
			return;
		}
		const { done, inProgress, pending } = countByStatus(state);
		ctx.ui.notify(
			`${state.tasks.length} task(s) — ${done} done, ${inProgress} in progress, ${pending} open\n${lines.join("\n")}`,
			"info",
		);
	}

	pi.registerCommand("tasks", {
		description: "Show or manage the task list — /tasks [status|clear|on|off]",
		handler: async (args, ctx) => handleTasksCommand(args, ctx),
	});

	// ── 事件 ──────────────────────────────────────────────────────────────

	/**
	 * 会话结束必须立刻停表 —— spinner 定时器会在会话结束后继续 tick，
	 * 而那时 lastCtx 已被 pi 作废，读 ctx.ui 会抛。
	 * docs/extensions.md 明确要求「注册一个幂等的 session_shutdown 处理器，
	 * 关掉你启动的任何会话级资源」，这个 setInterval 就是那种资源。
	 */
	pi.on("session_shutdown", async () => {
		stopTimer();
	});

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		reconstruct(ctx);
		updateUi(ctx);
	});

	// 分支导航后必须重建：否则会把已丢弃分支上的状态复活
	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		updateUi(ctx);
	});

	// 压缩时清掉已完成的列表，给下一批工作一个干净的起点
	pi.on("session_before_compact", async (_event, ctx) => {
		if (isComplete(state)) setState(emptyState(), ctx);
	});

	/**
	 * 每轮开始前把当前清单塞进上下文（display: false，不进 TUI），
	 * 这样模型知道哪些已完成、不必自己猜。
	 */
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!enabled || !state.active || state.tasks.length === 0) return;
		const lines = describeTasks(state);
		return {
			message: {
				customType: "simple-task-context",
				content: `Current task list (update statuses with task_update as you progress):\n${lines.join("\n")}`,
				display: false,
			},
		};
	});
}
