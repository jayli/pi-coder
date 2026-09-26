/**
 * background-tasks/registry.ts — 后台任务的纯生命周期层（不碰任何 pi API）。
 *
 * 职责：进程 spawn / 输出缓冲 / 增量读 / 杀进程 / 状态格式化。
 * `index.ts` 只负责把它接到 pi 的工具、命令与生命周期钩子上。
 *
 * ## 输出双写
 *
 * 每个任务的输出同时进两处：
 *
 *   - **内存环形缓冲**（`chunks` + `totalChars` / `droppedChars`）：供 `background_output`
 *     的增量读，上限 `MAX_BUFFER_CHARS`，超限丢最旧的块。
 *   - **日志文件**（`logPath`，追加写）：完整记录，不受环形上限影响。缓冲丢掉的早期输出
 *     仍然在文件里，`readOutput` 会在结果里说明这一点。
 *
 * ## offset 语义（CC 的 BashOutput 同形）
 *
 * offset 是**累计产出字符数的绝对值**，单调递增，不因环形丢弃而回退。
 * `readOutput(task)` 不传 offset 时从 `task.readOffset`（上次读到的位置）开始，
 * 读完把 `readOffset` 推到 `totalChars` —— 所以连续两次调用不会重复返回同一段输出。
 * 传了 offset 则以它为准，同样把 `readOffset` 推到末尾。
 *
 * ## 进程组
 *
 * spawn 用 `detached: true`，让命令成为自己进程组的组长，于是 `kill(-pid)` 能整组带走
 * （`npm test` 派生的 worker、shell 管道里的每一段）。**不 unref** —— 任务的生命周期
 * 跟着 pi 会话走，`session_shutdown` 里 `killAll()` 收尾。代价：pi 被 SIGKILL 时
 * 没有机会跑 shutdown，detached 的任务会活下来（已记录在扩展头注释里）。
 *
 * ## 可注入
 *
 * `spawn` / `now` / 上限 / 宽限期都可注入，测试用假子进程驱动完整状态机，
 * 不需要真起进程（真起进程的用例在 `index.test.ts`）。
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 内存环形缓冲上限（字符）。超限丢最旧的块，完整输出仍在日志文件里。 */
export const MAX_BUFFER_CHARS = 256 * 1024;

/** SIGTERM 之后多久补 SIGKILL。 */
export const KILL_GRACE_MS = 2000;

/** 单次 `background_output` 最多返回多少字符（尾部优先，与 pi 内置工具的输出预算同量级）。 */
export const MAX_READ_CHARS = 30_000;

export type TaskStatus = "running" | "exited" | "killed";

/** spawn 出来的子进程里，本模块真正用到的那一小片面（测试可以用 EventEmitter 假造）。 */
export interface ChildLike {
	pid?: number;
	stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildLike;

export interface BackgroundTask {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly logPath: string;
	readonly startedAt: number;
	pid: number | undefined;
	status: TaskStatus;
	endedAt: number | undefined;
	exitCode: number | undefined;
	signal: string | undefined;
	/** 累计产出字符数（绝对 offset，单调递增）。 */
	totalChars: number;
	/** 因环形上限被丢弃的最早字符数（= 缓冲里最旧一块的起始 offset）。 */
	droppedChars: number;
	/** 上次 `readOutput` 读到的位置。 */
	readOffset: number;
	chunks: Array<{ start: number; text: string }>;
	/** 本任务的终态是不是我们自己杀的（区分 SIGTERM 退出与崩溃信号）。 */
	killRequested: boolean;
	spawnError: string | undefined;
	child: ChildLike | undefined;
	stream: fs.WriteStream | undefined;
	killTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface StartTaskOptions {
	command: string;
	cwd: string;
	/** 日志目录，由调用方按会话算好（本模块不认识 pi 的 sessionManager）。 */
	logDir: string;
	env?: NodeJS.ProcessEnv;
}

export interface ReadResult {
	/** 本次返回的输出文本（可能为空串）。 */
	text: string;
	/** 本次读取的起点（绝对 offset）。 */
	from: number;
	/** 本次读取的终点 = 任务当前累计产出（绝对 offset）。 */
	to: number;
	/** 请求的起点早于缓冲里最旧的一块时，中间丢了多少字符（仍在日志文件里）。 */
	droppedBefore: number;
	/** 是否因为超过 `MAX_READ_CHARS` 而只返回了尾部。 */
	truncatedToTail: boolean;
	status: TaskStatus;
	exitCode: number | undefined;
}

export interface RegistryOptions {
	spawn?: SpawnFn;
	now?: () => number;
	maxBufferChars?: number;
	killGraceMs?: number;
	/** 任务进入终态时回调（`index.ts` 用它注入完成通知并唤醒模型）。 */
	onTerminal?: (task: BackgroundTask) => void;
}

export interface Registry {
	startTask(options: StartTaskOptions): BackgroundTask;
	readOutput(task: BackgroundTask, fromOffset?: number): ReadResult;
	killTask(id: string, signal?: NodeJS.Signals): { ok: boolean; reason?: string };
	killAll(): number;
	resolveTask(id: string): BackgroundTask | undefined;
	listTasks(): BackgroundTask[];
	runningCount(): number;
	/** 测试用：清掉所有定时器引用。 */
	dispose(): void;
}

export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function truncateCommand(command: string, max = 60): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 一行一个任务的状态摘要（`/background` 与工具结果共用）。 */
export function formatTaskLine(task: BackgroundTask, now: number): string {
	const elapsed = formatElapsed((task.endedAt ?? now) - task.startedAt);
	const exit = task.status === "running" ? "" : ` exit=${task.exitCode ?? task.signal ?? "?"}`;
	const pid = task.pid === undefined ? "" : ` pid=${task.pid}`;
	return `${task.id}  ${task.status.padEnd(7)} ${elapsed.padStart(6)}${pid}${exit}  ${truncateCommand(task.command)}`;
}

export function formatTaskList(tasks: readonly BackgroundTask[], now: number): string {
	if (tasks.length === 0) return "没有后台任务。";
	return tasks.map((task) => formatTaskLine(task, now)).join("\n");
}

export function createRegistry(options: RegistryOptions = {}): Registry {
	const spawnFn: SpawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
	const now = options.now ?? ((): number => Date.now());
	const maxBufferChars = options.maxBufferChars ?? MAX_BUFFER_CHARS;
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
	const onTerminal = options.onTerminal;

	const tasks = new Map<string, BackgroundTask>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let counter = 0;

	function armTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			timers.delete(timer);
			fn();
		}, ms);
		// 收尾定时器不能吊住事件循环：pi 要退出时它不该是拦路的那个。
		timer.unref?.();
		timers.add(timer);
		return timer;
	}

	function appendOutput(task: BackgroundTask, chunk: Buffer | string): void {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
		if (text.length === 0) return;
		try {
			task.stream?.write(text);
		} catch {
			// 日志写失败不该影响任务本身；缓冲里还有。
		}
		task.chunks.push({ start: task.totalChars, text });
		task.totalChars += text.length;
		trimBuffer(task);
	}

	function trimBuffer(task: BackgroundTask): void {
		let buffered = task.totalChars - task.droppedChars;
		while (buffered > maxBufferChars && task.chunks.length > 1) {
			const oldest = task.chunks.shift();
			if (!oldest) break;
			task.droppedChars = oldest.start + oldest.text.length;
			buffered = task.totalChars - task.droppedChars;
		}
	}

	function finish(task: BackgroundTask, code: number | null, signal: string | null): void {
		if (task.status !== "running") return; // 幂等：exit 与 error 可能都来
		task.status = task.killRequested ? "killed" : "exited";
		task.exitCode = code === null ? undefined : code;
		task.signal = signal ?? undefined;
		task.endedAt = now();
		if (task.killTimer) {
			clearTimeout(task.killTimer);
			timers.delete(task.killTimer);
			task.killTimer = undefined;
		}
		try {
			task.stream?.end();
		} catch {
			// 同上
		}
		task.stream = undefined;
		try {
			onTerminal?.(task);
		} catch {
			// 通知失败不能让注册表进入不一致状态
		}
	}

	function signalGroup(task: BackgroundTask, signal: NodeJS.Signals): boolean {
		const pid = task.pid;
		if (pid === undefined) return false;
		try {
			// 负 pid = 整个进程组（detached spawn 让命令当了组长）
			process.kill(-pid, signal);
			return true;
		} catch {
			// 组杀失败（组长已退 / 平台不支持）退回单进程
			try {
				task.child?.kill(signal);
				return true;
			} catch {
				try {
					process.kill(pid, signal);
					return true;
				} catch {
					return false;
				}
			}
		}
	}

	return {
		startTask({ command, cwd, logDir, env }: StartTaskOptions): BackgroundTask {
			const id = `bg_${++counter}`;
			fs.mkdirSync(logDir, { recursive: true });
			const logPath = path.join(logDir, `${id}.log`);
			// 同步建空文件：createWriteStream 是异步 open 的，不先 touch 一下的话
			// startTask 刚返回时 logPath 还不存在 —— 而工具结果与 `/background`
			// 都会把这个路径交给用户/模型，路径必须当场可用。
			try {
				fs.writeFileSync(logPath, "", { flag: "a" });
			} catch {
				// 建不了日志文件不阻止任务启动（缓冲仍在）
			}
			const task: BackgroundTask = {
				id,
				command,
				cwd,
				logPath,
				startedAt: now(),
				pid: undefined,
				status: "running",
				endedAt: undefined,
				exitCode: undefined,
				signal: undefined,
				totalChars: 0,
				droppedChars: 0,
				readOffset: 0,
				chunks: [],
				killRequested: false,
				spawnError: undefined,
				child: undefined,
				stream: undefined,
				killTimer: undefined,
			};
			tasks.set(id, task);

			let stream: fs.WriteStream | undefined;
			try {
				stream = fs.createWriteStream(logPath, { flags: "a" });
				stream.on("error", () => {
					// 日志文件写不动（磁盘满 / 权限）不该杀掉任务
					task.stream = undefined;
				});
				task.stream = stream;
			} catch {
				task.stream = undefined;
			}

			let child: ChildLike;
			try {
				child = spawnFn("/bin/bash", ["-c", command], {
					cwd,
					env: env ?? process.env,
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} catch (error) {
				task.spawnError = error instanceof Error ? error.message : String(error);
				appendOutput(task, `[background task spawn error: ${task.spawnError}]\n`);
				finish(task, null, null);
				return task;
			}

			task.child = child;
			task.pid = child.pid;
			// stdout / stderr 合并进同一条流（等价于 `2>&1`）：最简版不区分来源，
			// 与 pi 内置 bash 工具把两路都摆在结果里的做法一致。
			child.stdout?.on("data", (chunk) => appendOutput(task, chunk));
			child.stderr?.on("data", (chunk) => appendOutput(task, chunk));
			child.on("exit", (code, signal) => finish(task, code, signal));
			child.on("error", (error) => {
				task.spawnError = error instanceof Error ? error.message : String(error);
				appendOutput(task, `[background task error: ${task.spawnError}]\n`);
				finish(task, null, null);
			});
			return task;
		},

		readOutput(task: BackgroundTask, fromOffset?: number): ReadResult {
			const requested = fromOffset === undefined ? task.readOffset : Math.max(0, Math.floor(fromOffset));
			const to = task.totalChars;
			// 请求点早于缓冲最旧一块：那一段已经被环形上限挤出去了（日志文件里还有）。
			const effectiveFrom = Math.max(requested, task.droppedChars);
			const droppedBefore = effectiveFrom - requested;

			let window = to - effectiveFrom;
			let truncatedToTail = false;
			let sliceFrom = effectiveFrom;
			if (window > MAX_READ_CHARS) {
				// 尾部优先：最新输出比最旧输出有用（与 pi 内置工具截断方向一致）
				sliceFrom = to - MAX_READ_CHARS;
				window = MAX_READ_CHARS;
				truncatedToTail = true;
			}

			const parts: string[] = [];
			if (window > 0) {
				for (const chunk of task.chunks) {
					const chunkEnd = chunk.start + chunk.text.length;
					if (chunkEnd <= sliceFrom || chunk.start >= sliceFrom + window) continue;
					const localStart = Math.max(0, sliceFrom - chunk.start);
					const localEnd = Math.min(chunk.text.length, sliceFrom + window - chunk.start);
					if (localEnd > localStart) parts.push(chunk.text.slice(localStart, localEnd));
				}
			}

			task.readOffset = to;
			return {
				text: parts.join(""),
				from: sliceFrom,
				to,
				droppedBefore,
				truncatedToTail,
				status: task.status,
				exitCode: task.exitCode,
			};
		},

		killTask(id: string, signal: NodeJS.Signals = "SIGTERM"): { ok: boolean; reason?: string } {
			const task = tasks.get(id);
			if (!task) return { ok: false, reason: `没有这个任务：${id}` };
			if (task.status !== "running") return { ok: false, reason: `${id} 已经${task.status}，不需要杀` };
			task.killRequested = true;
			const sent = signalGroup(task, signal);
			if (!sent) return { ok: false, reason: `${id} 的进程已经不在了（可能刚退出）` };
			// 宽限期后补 SIGKILL：SIGTERM 被忽略的任务不能一直挂着。
			if (task.killTimer) clearTimeout(task.killTimer);
			task.killTimer = armTimer(() => {
				task.killTimer = undefined;
				if (task.status === "running") signalGroup(task, "SIGKILL");
			}, killGraceMs);
			return { ok: true };
		},

		killAll(): number {
			let count = 0;
			for (const task of tasks.values()) {
				if (task.status !== "running") continue;
				task.killRequested = true;
				if (signalGroup(task, "SIGTERM")) count++;
			}
			if (count > 0) {
				armTimer(() => {
					for (const task of tasks.values()) {
						if (task.status === "running") signalGroup(task, "SIGKILL");
					}
				}, killGraceMs);
			}
			return count;
		},

		resolveTask(id: string): BackgroundTask | undefined {
			return tasks.get(id);
		},

		listTasks(): BackgroundTask[] {
			return [...tasks.values()];
		},

		runningCount(): number {
			let count = 0;
			for (const task of tasks.values()) if (task.status === "running") count++;
			return count;
		},

		dispose(): void {
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		},
	};
}
