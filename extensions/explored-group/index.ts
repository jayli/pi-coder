/**
 * explored-group —— 把连续的「只读探查」折叠成一个 `Explored` 分组块。
 *
 * 用户 2026-10-06 定。形态见 `render.ts`；判定与断组规则见 `registry.ts` / `classify.ts`。
 *
 * ## 这个扩展做三件事
 *
 * 1. **接管原生 `grep` / `find` / `ls` 的渲染** —— 它们本身没法分组（开了 `defaultTools` 之后
 *    每个块渲染 10–21 行，比被折叠的 bash 块还啰嗦），所以跟 bash / read 一样走
 *    「可折叠就并进 `Explored`，否则原样渲染」。`defaultTools` 的同步改动在
 *    `clients/pi/config/settings.json`。
 *
 * 2. **接线断组事件** —— `read` / `bash` 两个块是别的扩展（`read-path-collapse.ts` /
 *    `bash-command-collapse.ts`）注册的，它们只管渲染，不知道 thinking / 旁白 / 用户消息
 *    什么时候出现。断组的信息只在这里拿得到，所以由本文件喂给 `registry`。
 *
 * 3. **登记原生工具的成员状态** —— `tool_execution_end` 时把 ok / error 写回分组，
 *    组头那颗圆点据此变色（用户定：白 = 还在跑，绿 = 全成功，红 = 有错）。
 *
 * ## 为什么用 `message_*` 事件重放而不是 `tool_call`
 *
 * `tool_call` 只有 tool 的信息，看不到「它前面隔了个 thinking」这种顺序关系 —— 而断组
 * 规则正是按**内容顺序**判的。所以权威来源是 assistant 消息的 content 数组：
 * `replayMessage()` 按顺序走一遍，遇到 thinking / 非空 text 就断组。`message_update`
 * 随流式反复触发，`registry` 内部按消息对象记「已处理到第几块」，不会重复断。
 *
 * `tool_call` 只在**不可折叠**工具上兜一道断组（原生 grep/find/ls 与 read/bash 都由
 * 消息重放覆盖，但别的工具 —— write / edit / subagent … —— 不在 content 里的分类范围内，
 * 靠这条保证「写了一下」也会断组）。
 *
 * ## 这个文件不 import bash / read 扩展
 *
 * 三个扩展各自 import `explored-group/` 的纯函数与 registry（`globalThis` 单例），
 * 彼此不依赖 —— 少一个也能跑（只是那一侧的块不参与折叠）。
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { arm, ensureRegistered, isLeader, markMemberReady, markMessageReady, markReadyIfSettled, noteToolCall, noteUserMessage, replayMessage, setLeaderInvalidate, setMemberStatus, shouldHideWhilePending } from "./registry.ts";
import { EMPTY_COMPONENT, createGroupTree } from "./render.ts";

/**
 * 开闸：分组只在「真跑过一次会话」后生效。
 *
 * `session_start` 是交互式启动的第一个事件，但在 `--print`、`/reload`、以及某些只为了
 * 渲染历史而构造会话的场景里不一定发 —— 所以 `message_*` 也会开（`replayMessage` 内部
 * 自己 arm）。两边都开是为了让闸门不影响真运行，只挡住「加载了扩展但从未跑会话」。
 */
function armOnStart(): void {
	arm();
}

/**
 * 回放历史条目，把断组事件补上（用户 2026-10-06 第二轮）。
 *
 * ## 为什么需要这个
 *
 * 断组全靠 `message_*` / `user` 消息事件，而 **pi 重建历史时不发这些事件**：
 * `renderInitialMessages()` → `renderSessionItems()` 只构造 `ToolExecutionComponent` 并渲染，
 * 一个扩展事件都不发（实测确认：`session_start(reason:"resume")` 之后直接就是这个）。
 *
 * 于是历史里的块只能靠 `renderCall` 里的 `ensureRegistered` 登记 —— 于是**全部并进一块**：
 * 实测 367 个会话里 319 个会变成「整个会话一个 Explored」，最大的块含 326 个成员、
 * 屏幕上只显示 5 行，历史等于全丢了。HEAD 版本因为有家族断组勉强分开了几块，
 * 本轮把家族断组删掉之后这个隐患被放大，所以必须补上。
 *
 * ## 做法
 *
 * `session_start` 时（`reason` 为 `resume` / `fork`，以及任何已存历史的场景）把
 * `sessionManager.buildContextEntries()` 按顺序重放一遍 —— 与流式期间走的是**同一个**
 * `replayMessage` / `noteUserMessage`，所以断组规则只有一份，不存在两套语义。
 */
function hydrateFromHistory(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager?.buildContextEntries?.();
	if (!Array.isArray(entries)) return;
	arm();
	for (const entry of entries) {
		const message = (entry as { message?: unknown } | null)?.message ?? entry;
		if ((message as { role?: string } | null)?.role === "user") noteUserMessage();
		else {
			replayMessage(message);
			// 历史里的块都是「已经吐完」的（会话存盘时它们早已执行过）—— 必须一并开闸，
			// 否则重建出来的所有行都停在未 ready 态，整段历史在树里消失。
			markMessageReady(message);
		}
	}
}

/** 本扩展接管的原生工具（渲染 + 分组）。 */
const NATIVE_TOOLS = new Set(["grep", "find", "ls"]);

/**
 * 给一个原生只读工具装上「可折叠就并组，否则原样」的渲染。
 *
 * 与 `read-path-collapse.ts` 同一手法：`...base` 展开继承 description / parameters /
 * execute，只加 `renderShell: "self"` 与两个 renderer。`renderShell: "self"` 是必须的 ——
 * 默认壳下 `ToolExecutionComponent` 常驻一个 `Spacer(1)`，成员块投 0 行时仍会多出一条空行
 *（bash 侧踩过同一个坑，见 `bash-command-collapse.ts` 的 `renderShell` 注释）。
 */
function withGroupedRendering(base: ToolDefinition, toolName: string): ToolDefinition {
	return {
		...base,
		renderShell: "self",
		renderCall(args, theme, context) {
			// 参数还在流（构造时 args=`{}`，之后逐片填）：**一行都不画**，等 args 齐了直接画
			// `Explored`。不遮的话，这一帧会退回下面的内置渲染，屏幕上先冒出一帧原生块
			//（`grep // in .` / `find  in .`），下一帧才跳成分组（用户 2026-10-06 报的
			// 「先流出一段灰文本再折叠」）。详见 `shouldHideWhilePending`。
			if (shouldHideWhilePending(toolName, args, context.isPartial === true)) return EMPTY_COMPONENT;
			// 渲染时开闸兜底（主信号是 `message_end` / `tool_execution_end`，见 `markReadyIfSettled`）。
			markReadyIfSettled(context.toolCallId, context.argsComplete === true, context.isPartial === true);
			const group = ensureRegistered(context.toolCallId, toolName, args);
			if (!group) {
				// 确实不可折叠（例如读 SKILL.md）→ 退回内置渲染，它有自己的紧凑形态。
				return base.renderCall?.(args, theme, context) ?? EMPTY_COMPONENT;
			}
			if (!isLeader(context.toolCallId)) return EMPTY_COMPONENT;
			setLeaderInvalidate(context.toolCallId, () => context.invalidate());
			return createGroupTree({
				groupId: context.toolCallId,
				theme,
				cwd: context.cwd,
				expanded: context.expanded === true,
			});
		},
		renderResult(result, options, theme, context) {
			// 折叠态下**整组（含组长）都不画输出**，与 bash / read 侧同一条规则。
			// 展开态放行，让各成员各自展开内容。
			if (!context.expanded && ensureRegistered(context.toolCallId, toolName, context.args)) {
				return EMPTY_COMPONENT;
			}
			return base.renderResult?.(result, options, theme, context) ?? EMPTY_COMPONENT;
		},
	};
}

export default function (pi: ExtensionAPI) {
	// 开闸（见 `armOnStart`）：不跑会话就不接管任何渲染。
	// 有已存历史（resume / fork / reload）时把历史重放一遍 —— 那些场景 pi 不发 `message_*`，
	// 只能在这里补断组事件，否则整段历史会并成一块（见 `hydrateFromHistory`）。
	pi.on("session_start", (_event, ctx) => {
		armOnStart();
		hydrateFromHistory(ctx);
	});

	// ── 接管原生 grep / find / ls 的渲染 ─────────────────────────────────────
	// 这三个工具由 `defaultTools` 启用（见 `clients/pi/config/settings.json`），
	// 定义本身是 pi 内置的，这里只换渲染层。
	pi.registerTool(withGroupedRendering(createGrepToolDefinition(process.cwd()) as ToolDefinition, "grep"));
	pi.registerTool(withGroupedRendering(createFindToolDefinition(process.cwd()) as ToolDefinition, "find"));
	pi.registerTool(withGroupedRendering(createLsToolDefinition(process.cwd()) as ToolDefinition, "ls"));

	// ── 断组：按内容顺序重放 assistant 消息 ──────────────────────────────────
	// 权威来源。`message_update` 流式反复触发，registry 内部按消息对象去重。
	pi.on("message_start", (event) => {
		replayMessage(event.message);
	});
	pi.on("message_update", (event) => {
		replayMessage(event.message);
	});
	pi.on("message_end", (event) => {
		if (event.message?.role === "user") noteUserMessage();
		else {
			replayMessage(event.message);
			// 「命令吐完」的那一刻（用户 2026-10-07）：这条消息里的工具调用现在可以进树了。
			// 必须放在 replayMessage 之后 —— 先把断组与登记做定，再统一开闸。
			markMessageReady(event.message);
		}
	});

	// ── 断组兜底：不可折叠的工具调用 ────────────────────────────────────────
	// 原生 grep/find/ls 与 read/bash 已由消息重放覆盖；这条保证**其他**工具
	//（write / edit / subagent / task_* …）也会断组。
	pi.on("tool_call", (event) => {
		if (NATIVE_TOOLS.has(event.toolName) || event.toolName === "read" || event.toolName === "bash") return;
		noteToolCall(event.toolCallId, event.toolName, event.args);
	});

	// ── 成员状态 → 组头圆点颜色 ─────────────────────────────────────────────
	pi.on("tool_execution_end", (event) => {
		// 执行完了 ⇒ 参数必然已定（pi 不可能带着半截 args 去执行）。这是 `message_end`
		// 的**兜底开闸**：实测有路径拿不到那个事件（只有 `tool_execution_end`），
		// 不补这一下的话那个块会永久隐身（且模型报错、Esc 中断那些路径也是一样）。
		markMemberReady(event.toolCallId);
		setMemberStatus(event.toolCallId, event.isError ? "error" : "ok");
	});
}
