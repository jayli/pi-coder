/**
 * subagent-log-guard —— 别让 pi-subagents 的启动诊断糊在输入框上。
 *
 * 现象：跑一个**前台**子代理时，输入框那一行（`› ` 之后）突然被
 *   [pi-subagents] Agent 'researcher': host runtime tool availability omitted [web_search, …]
 * 覆盖，widget 的后续行被这行字的续行冲掉、底色错位，看着像输入框坏了；回车 / 切窗口都刷不掉脏字。
 *
 * 根因（本机 tmux 复现过）：pi-subagents 把这行诊断交给 console.warn 打印
 * （`runs/foreground/execution.ts` 的 launch warnings、`runs/background/subagent-runner.ts` 的同名诊断等）。
 * 父进程里 console.warn 写的是**真 stderr** —— pi 只在 rpc / json / print 模式下 takeOverStdout
 * （`dist/main.js`：`shouldTakeOverStdout = appMode !== "interactive"`），交互模式不接管扩展的 console
 * 输出。于是这行字被写进 TUI 的备用屏，落点是硬件光标（编辑器里 `› ` 之后那一列）；而 pi-tui 的
 * 差分渲染器认为这些行没变、不会重画，脏字就留在屏幕上了。
 * 复现：`pi -ne -e` 一个「2.5 秒后 console.warn 一行 [pi-subagents] …」的探针扩展，
 * 6 秒后 `tmux capture-pane` 能看到同样的脏行。
 *
 * 本扩展只做一件事：在**带 UI 的进程**里包一层 process.stderr.write，凡是以 `[pi-subagents]`
 * 开头的写入（判定见 filter.ts）一律不进终端。
 *   - 默认：丢弃 —— 这些诊断（「宿主没提供你 tools: 里声明的扩展工具」之类）都是非致命的，
 *     代价是屏幕上那坨脏字，直接关掉最干净。
 *   - `PI_SUBAGENT_LOG_GUARD=notify`：不丢，改成 ctx.ui.notify(..., "warning") 由 pi 自己排版 ——
 *     信息还在、但不会再糊屏。想保留「async spawn failed」这类父进程错误信息时用它。
 *   - `PI_SUBAGENT_LOG_GUARD=off`：整层拦网不装（回到脏行的老行为），排查「这行到底谁打的」时用。
 *   - `ctx.hasUI === false` 的进程（RPC / print / cron / 异步子代理 runner）**不装**：那些进程没有
 *     TUI 可污染，异步子代理的诊断照样落在 `runner.stderr.log` 里，行为与以前完全一致。
 *   - 只拦这个前缀：别的写 stderr 的内容（pi 自己的崩溃处理、其它扩展）原样放行。
 *
 * 前台子代理是**同进程**跑的（`runs/shared/child-session.ts` 用 pi 的 createAgentSession 建会话、
 * 与宿主共用 ModelRuntime），所以子会话里任何扩展的 console.warn 也会经过这层拦网。
 *
 * 为什么不去绕开触发条件（不用那些在 tools: 里声明扩展工具的 agent，如内置的 researcher）：那等于
 * 放弃这类 agent，而这个坑的通用形态是「交互模式下任何扩展 console.warn 都会糊屏」，只是目前只有
 * pi-subagents 常这么干。上游的修法是调用点加 `if (!ctx.hasUI)`（pi 内核自己就是这么写的），或改走
 * ctx.ui.notify；本扩展是本地兜底，上游修好之后它也只是拦不到东西而已，没有副作用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chunkToText, splitSubagentDiagnostics } from "./filter.ts";

/** /reload 会重新执行本文件；包好的 write 只能有一份，所以状态挂在 process 的 symbol 上复用。 */
const STATE_KEY = Symbol.for("pi.subagent-log-guard.state");

/** 三种模式：未设置/其它值 = 丢弃（默认）；`notify` = 改走 pi 的通知；`off` = 整层不装。 */
const MODE = (process.env.PI_SUBAGENT_LOG_GUARD ?? "").trim().toLowerCase();
const DISABLED = MODE === "off";
const NOTIFY_MODE = MODE === "notify";

interface GuardState {
	/** 当前会话的通知出口；没有活跃会话时是 undefined（= 直接丢）。 */
	sink: ((text: string) => void) | undefined;
	/** 已拦下的诊断条数，仅用于排查（不上屏、不落盘）。 */
	captured: number;
}

function guardState(): GuardState | undefined {
	return (globalThis as unknown as Record<symbol, GuardState | undefined>)[STATE_KEY];
}

/**
 * 包 process.stderr.write。幂等：/reload 后复用同一份状态，不会层层嵌套。
 * 放行时把参数原样转发（chunk / encoding / callback），所以对 pi 与其它扩展完全透明。
 */
function installGuard(): GuardState {
	const existing = guardState();
	if (existing) return existing;

	const state: GuardState = { sink: undefined, captured: 0 };
	const originalWrite = process.stderr.write.bind(process.stderr);

	// 参数签名按 Node 的 write(chunk, encoding?, callback?) 原样转发；拦下时自己回调，
	// 免得调用方（console 内部 / 别的扩展）以为永远没 flush。回调按 Node 惯例异步触发。
	const guard = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		const { passThrough, captured } = splitSubagentDiagnostics(chunkToText(chunk));
		if (captured.length === 0) {
			return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
		}
		state.captured += captured.length;
		const text = captured.join(" ").trim();
		if (text) state.sink?.(text);
		const callback = rest.find((arg) => typeof arg === "function") as
			| ((error?: Error | null) => void)
			| undefined;
		if (callback) queueMicrotask(() => callback(null));
		return true;
	};

	process.stderr.write = guard as typeof process.stderr.write;
	(globalThis as unknown as Record<symbol, GuardState | undefined>)[STATE_KEY] = state;
	return state;
}

export default function subagentLogGuard(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// 无 UI 的进程（RPC / print / 异步 runner）不需要这层：stderr 本来就是它们的日志出口。
		if (DISABLED || !ctx.hasUI) return;
		const state = installGuard();
		state.sink = NOTIFY_MODE
			? (text) => {
					try {
						ctx.ui.notify(text, "warning");
					} catch {
						// 换会话的窗口里 ctx 可能已经失效，丢掉这条即可，别把宿主带崩。
					}
				}
			: undefined;
	});

	pi.on("session_shutdown", () => {
		const state = guardState();
		if (state) state.sink = undefined;
	});
}
