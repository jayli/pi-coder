/**
 * user-message-bar — 用户消息框：行首竖线 + 框上方的发送时间（接线）
 *
 * 本文件只做接线：补丁装在 pi 的 `UserMessageComponent.prototype.render`（竖线 + 抬头）与
 * `InteractiveMode.prototype.addMessageToChat`（给用户消息打发送时间）上，取色源来自
 * `ctx.ui.theme`；全部逻辑在 `bar.ts`（不 import pi，`node --test` 能直跑）。
 *
 * 两个补丁都在**模块求值 / session_start 时**装：
 *   - 竖线补丁在模块求值时装（此时取色源还是空，`bar.ts` 会安静地不加竖线），这样它一定赶在
 *     第一次渲染之前到位，不依赖事件顺序。`session_start` 一到就把取色源补成 `ctx.ui.theme` ——
 *     那是个跨 `/theme` 换肤的活 Proxy，换肤下一帧即跟随。
 *   - 打时间戳的补丁**只在 `session_start` 装**：那时所有扩展的模块求值都已完成，我们的包装
 *     处在 `addMessageToChat` 调用链最外层（`skill-invocation-reorder` 会自己 `new
 *     UserMessageComponent`、不走原函数，装在里层会漏掉 `/skill:` 消息）；首屏历史消息在
 *     `session_start` 之后才渲染，所以也不会漏。
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
 * 兜一层 try/catch —— 最坏只是那几帧不画竖线，下一个 `session_start` 自动恢复。
 *
 * `PI_USER_MESSAGE_BAR=off` 关闭（竖线与时间一起关）；`PI_USER_MESSAGE_BAR_COLOR=<皮肤槽位名>`
 * 换竖线颜色（默认 `accent`，即皮肤的强调色；想要更暗可以试 `selectedBg`）。抬头里 `You` 固定取
 * `syntaxKeyword`、时间固定取 `dim`，不走这个开关。
 *
 * 抬头末尾的 ` · N compactions` 也在这里接：`session_start` 时把「这条消息发出时压缩过几次」的
 * 查询函数（读当前会话分支，见 `sessionCompactionLookup`）交给 `bar.ts`，`session_shutdown` 时
 * 摘掉 —— 与取色源同一个理由，旧 sessionManager 会随旧 ctx 一起作废。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_COLOR_NAME,
	installUserMessageBar,
	installUserMessageTimestamp,
	resetUserMessageTurns,
	setCompactionLookup,
	type CompactionLookup,
	type ThemeColorSource,
} from "./bar.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_USER_MESSAGE_BAR === "off") return;
	const colorName = process.env.PI_USER_MESSAGE_BAR_COLOR?.trim() || DEFAULT_COLOR_NAME;
	const dropThemeSource = (): void => {
		installUserMessageBar({ UserMessageComponent, theme: () => undefined, colorName });
	};

	dropThemeSource();
	pi.on("session_start", (event, ctx) => {
		// 新会话从 #1 重新数；`/reload` 除外 —— pi 会先重放聊天区再发 session_start（见 bar.ts）
		if (event.reason !== "reload") resetUserMessageTurns();
		installUserMessageBar({ UserMessageComponent, theme: () => liveTheme(ctx), colorName });
		installUserMessageTimestamp({ InteractiveMode, UserMessageComponent });
		setCompactionLookup(sessionCompactionLookup(ctx));
	});
	pi.on("session_shutdown", () => {
		dropThemeSource();
		setCompactionLookup(undefined);
	});
}

/**
 * 读当前皮肤，**永不抛**：会话被替换 / reload 后 pi 会作废旧 ctx，读 `ctx.ui` 抛
 * `This extension ctx is stale …`，而渲染 tick 里的异常没人接得住，会打死整个 pi（见文件头）。
 * 读不到就当这一帧没有皮肤（不画竖线），下一个 `session_start` 补上。
 */
function liveTheme(ctx: ExtensionContext): ThemeColorSource | undefined {
	try {
		return ctx.ui.theme;
	} catch {
		return undefined;
	}
}

/** 会话管理器的最小形状：只用到 `getBranch`，条目只看 `type` 与 `message`。 */
interface SessionManagerLike {
	getBranch(): Array<{ type?: string; message?: object }>;
}

/** 读 `ctx.sessionManager`，**永不抛**（理由同 `liveTheme`）。 */
function liveSessionManager(ctx: ExtensionContext): SessionManagerLike | undefined {
	try {
		return ctx.sessionManager as unknown as SessionManagerLike;
	} catch {
		return undefined;
	}
}

/**
 * 「这条用户消息发出时已经压缩过几次」：沿当前分支按时间顺序数 `compaction` 条目，数到这条消息
 * 本身为止。消息还没落进分支（刚发出的消息要到 `message_end` 才写盘）时就等于「此前的压缩全都
 * 已经发生」—— 正好是它该显示的次数。
 *
 * 特意不缓存结果：`/tree` 换分支、`/compact` 追加条目后 pi 会重画整个聊天区，那两种情形都得
 * 按**那一刻**的分支算（`bar.ts` 那边按**消息对象**缓存是安全的 —— 压次是这条消息条目自身的
 * 属性，父链定下就不再变）。分支遍历是沿 `parentId` 走，与条目总数无关，每条消息一次的开销
 * 可以忽略。
 */
function sessionCompactionLookup(ctx: ExtensionContext): CompactionLookup | undefined {
	const manager = liveSessionManager(ctx);
	if (!manager) return undefined;
	return (message) => {
		let count = 0;
		for (const entry of manager.getBranch()) {
			if (entry.type === "compaction") count += 1;
			else if (entry.type === "message" && entry.message === message) return count;
		}
		return count;
	};
}
