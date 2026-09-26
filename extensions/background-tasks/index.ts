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
 * ## 最简版明确不做
 *
 * 跨 pi 重启的任务恢复、超时自动杀（CC 的后台 bash 也没有超时参数）、agent 类任务、
 * footer 任务 dock、stdout/stderr 分流（两路合并，等价 `2>&1`）。
 *
 * 开关：`PI_BACKGROUND_TASKS=off` 整体关闭；`PI_BACKGROUND_TASKS_DIR` 覆盖日志根目录
 * （测试隔离用）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

const CUSTOM_TYPE = "background-task";

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
		logPath: task.logPath,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		exitCode: task.exitCode,
		signal: task.signal,
		elapsedMs: (task.endedAt ?? now) - task.startedAt,
	};
}

/** 终态通知正文（模型看到的就是这段）。 */
function buildNotification(task: BackgroundTask, now: number): string {
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
		`这是终态事实，不需要再调 background_output 确认状态；只有需要看输出内容时才调它（id: ${task.id}）。`,
		`完整日志：${task.logPath}`,
		"</background-task-notification>",
	].join("\n");
}

export default function backgroundTasks(pi: ExtensionAPI): void {
	if (process.env.PI_BACKGROUND_TASKS === "off") return;

	let registry: Registry | undefined;
	/** 最近一次见到的 ctx：终态回调发生在子进程事件里，那时手上没有 ctx。 */
	let lastCtx: ExtensionContext | undefined;
	/** shutdown 与新会话之间不再注入通知（否则会在旧会话结束后凭空起一轮）。 */
	let disposed = false;
	let logDir = "";

	// 会话替换（/clear、/new、/resume）也会发 session_shutdown，但扩展实例不死：
	// 新会话的 session_start 一到就把 disposed 复位，否则新会话里的后台任务
	// 完成时永远注入不了通知。reload 是另一回事 —— 那里旧 runtime 整个被换掉，
	// 新工厂重新跑，这里的复位不会漏。
	pi.on("session_start", () => {
		disposed = false;
	});

	function ensureRegistry(ctx: ExtensionContext): Registry {
		lastCtx = ctx;
		if (registry) return registry;
		let sessionId = "no-session";
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? "no-session";
		} catch {
			// 拿不到会话 id 就用固定目录（同机多会话会共用，最简版可接受）
		}
		logDir = path.join(resolveLogRoot(), sessionId);
		const reg = createRegistry({
			onTerminal: (task) => {
				// 只认当前 registry 的任务：会话替换后新建了 registry，
				// 旧会话被 killAll 的任务的迟到 exit 不该注入新会话。
				if (disposed || reg !== registry) return;
				pi.sendMessage(
					{
						customType: CUSTOM_TYPE,
						content: buildNotification(task, Date.now()),
						display: true,
						details: { kind: "terminal", task: taskDetails(task, Date.now()) },
					},
					// 空闲 → 直接起一轮；流式中 → 排到本轮结束后（不打断当前推理）
					{ triggerTurn: true, deliverAs: lastCtx?.isIdle?.() ? undefined : "followUp" },
				);
			},
		});
		registry = reg;
		return registry;
	}

	// ── run_in_background ──────────────────────────────────────────────────

	pi.registerTool({
		name: "run_in_background",
		label: "Run In Background",
		description: [
			"Start a shell command in the background and return immediately with a task id and log path.",
			"Use it instead of bash for anything expected to outlive one tool call: test suites, builds, dev servers, watchers, long downloads.",
			"The command keeps running while you do other work. When it reaches a terminal state you are woken automatically by a <background-task-notification> message — do NOT sleep, poll, or call background_output merely to wait for it.",
			"After starting a task, continue with independent work that does not depend on its result, or end the turn; the notification will bring you back.",
			"Background commands do NOT run inside the seatbelt delete boundary that the foreground bash tool uses — treat them as the user having run `cmd &` themselves, and keep destructive work in the foreground.",
		].join("\n"),
		promptSnippet: "Start a long-running shell command in the background; a terminal notification wakes you, so never poll to wait.",
		promptGuidelines: [
			"Use run_in_background instead of bash for commands expected to run longer than a tool timeout (test suites, builds, dev servers, watchers).",
			"It returns immediately. A terminal state is delivered automatically as <background-task-notification> and starts a follow-up turn — never sleep or poll background_output just to wait.",
			"Treat that notification as terminal truth: do not re-check status after it; call background_output only when you actually need the output.",
			"Background commands bypass the seatbelt delete boundary; keep destructive commands in the foreground bash tool.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run in the background (executed with /bin/bash -c)" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; relative paths resolve against the session cwd. Defaults to the session cwd" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = String(params?.command ?? "").trim();
			if (!command) return textResult("command 不能为空。", { ok: false });
			const reg = ensureRegistry(ctx);
			const cwd = params?.cwd ? path.resolve(ctx.cwd, String(params.cwd)) : ctx.cwd;
			if (!fs.existsSync(cwd)) return textResult(`工作目录不存在：${cwd}`, { ok: false });

			const task = reg.startTask({ command, cwd, logDir });
			if (task.spawnError) {
				return textResult(`启动失败：${task.spawnError}`, { ok: false, task: taskDetails(task, Date.now()) });
			}
			return textResult(
				[
					`已在后台启动 ${task.id}（pid ${task.pid ?? "?"}）。`,
					`命令：${truncateCommand(task.command, 120)}`,
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

	// ── 终态通知的渲染 ─────────────────────────────────────────────────────

	pi.registerMessageRenderer<{ kind: string; task: Record<string, unknown> }>(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const body = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
		const task = message.details?.task;
		const exit = task?.exitCode;
		const failed = task?.status === "killed" || (typeof exit === "number" && exit !== 0);
		const label = failed ? theme.fg("warning", `⚠ 后台任务 ${String(task?.id ?? "")} 结束:`) : theme.fg("success", `✓ 后台任务 ${String(task?.id ?? "")} 结束:`);
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		// 正文里的 <background-task-notification> 包裹标签是写给模型的，界面上不重复显示
		const visible = body.replace(/<\/?background-task-notification>/g, "").trim();
		box.addChild(new Text(`${label}\n${visible}`, 0, 0));
		return box;
	});

	// ── 生命周期：任务随会话生死 ───────────────────────────────────────────

	pi.on("session_shutdown", () => {
		disposed = true;
		registry?.killAll();
		registry?.dispose();
		registry = undefined;
		lastCtx = undefined;
	});
}
