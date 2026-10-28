/**
 * user-message-bar — 用户消息正文首行标记（接线）
 *
 * 本文件只做接线：补丁装在 pi 的 `UserMessageComponent.prototype.render`（加粗首行 `›` + 上方那条空行）与
 * `InteractiveMode.prototype.addMessageToChat`（给第一条用户消息打空行标记）上，取色源来自
 * `ctx.ui.theme`；全部逻辑在 `bar.ts`（不 import pi，`node --test` 能直跑）。
 *
 * 补丁在**模块求值 / session_start 时**装：
 *   - 标记补丁在模块求值时先装一次（此时取色源还是空，`bar.ts` 会安静地不加标记），这样它一定赶在
 *     第一次渲染之前到位，不依赖事件顺序。`session_start` 一到就把取色源补成 `ctx.ui.theme` ——
 *     那是个跨 `/theme` 换肤的活 Proxy，换肤下一帧即跟随。
 *
 * 取色源还必须在**会话被替换的那一瞬间**摘掉，否则会打死整个 pi（2026-09-20 修，`/clear` 实测
 * 崩过）。pi 的 `teardownCurrent()` 顺序是：emit `session_shutdown` → `resetExtensionUI()` →
 * `session.dispose()`（里面 `extensionRunner.invalidate()`）—— 从第三步入起，旧 ctx 的**任何**
 * 属性读取都抛；而旧消息这时还挂在 `chatContainer` 上，pi 要等**下一次** `rebindCurrentSession()`
 * 里的 `renderCurrentSessionState()` 才清，新 ctx 更要等 `session_start` 才到手。这几步之间夹着
 * 多个 await，pi-tui 那个 16ms 节流的渲染 tick 足以落进去 —— 渲染 tick 里抛出的异常没人接得住，
 * 直达 pi 的 `uncaughtException` 让进程 `exit(1)`（`/clear`、`/new`、`/resume`、`/fork`、
 * `/reload` 全走这条路；恢复会话时窗口更长，`renderInitialMessages()` 还在 bind 之前）。
 * 所以：`session_shutdown` 一到就把取色源复位成空（该事件一定先于 `invalidate()`），读皮肤再
 * 兜一层 try/catch —— 最坏只是那几帧不画标记，下一个 `session_start` 自动恢复。
 *
 * `PI_USER_MESSAGE_BAR=off` 关闭；`PI_USER_MESSAGE_BAR_COLOR=<皮肤槽位名>` 换标记颜色
 * （默认 `muted`，即皮肤的弱化文字色）。
 *
 * 框上方那行抬头（`You 12:04 #12 • 0 compactions … +38m`）与它的 `/title-bar on|off` 开关
 * 已于 2026-10-27 整体移除（用户：没用了，放着浪费），连同发送时间 / 轮次号 / 压缩次数 / 会话时长
 * 一起不留 —— 本扩展现在只剩两件事：正文首行标记，与会话里**第一条**用户消息上方那条空行
 * （`installUserMessageGap` + `addMessageBoxGap`，抬头在时它是「关掉抬头之后才补」，抬头删掉后
 * 变成「一直补」，用户 2026-10-26 定的那道缝照旧保留）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_COLOR_NAME,
	installUserMessageBar,
	installUserMessageGap,
	startupLogoOwnsHeader,
	type ThemeColorSource,
} from "./bar.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_USER_MESSAGE_BAR === "off") return;
	const colorName = process.env.PI_USER_MESSAGE_BAR_COLOR?.trim() || DEFAULT_COLOR_NAME;

	const dropThemeSource = (): void => {
		installUserMessageBar({
			UserMessageComponent,
			theme: () => undefined,
			colorName,
			startupLogoHeader: startupLogoOwnsHeader,
		});
	};

	dropThemeSource();
	pi.on("session_start", (_event, ctx) => {
		installUserMessageBar({
			UserMessageComponent,
			theme: () => liveTheme(ctx),
			colorName,
			startupLogoHeader: startupLogoOwnsHeader,
		});
		// 只在 `session_start` 装：那时所有扩展的模块求值都已完成，包装才排得到调用链最外层
		// （`skill-invocation-reorder` 对 `/skill:` 消息自己 `new UserMessageComponent`、不走原函数）。
		installUserMessageGap({ InteractiveMode, UserMessageComponent });
	});
	pi.on("session_shutdown", () => {
		dropThemeSource();
	});
}

/**
 * 读当前皮肤，**永不抛**：会话被替换 / reload 后 pi 会作废旧 ctx，读 `ctx.ui` 抛
 * `This extension ctx is stale …`，而渲染 tick 里的异常没人接得住，会打死整个 pi（见文件头）。
 * 读不到就当这一帧没有皮肤（不画标记），下一个 `session_start` 补上。
 */
function liveTheme(ctx: ExtensionContext): ThemeColorSource | undefined {
	try {
		return ctx.ui.theme;
	} catch {
		return undefined;
	}
}
