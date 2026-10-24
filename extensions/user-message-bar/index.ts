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
 * 换竖线颜色（默认 `accent`，即皮肤的强调色；想要更暗可以试 `selectedBg`）。抬头两个色块固定取
 * `syntaxKeyword`（第一段底色再压暗 40%）与 `thinkingText`（第二段底色再压暗 30%），三个竖线字形
 * 的前景分两档（行首那个不压暗、另外两个全黑），都不走这个开关。
 *
 * 抬头末尾的第二段 ` N compactions ` 也在这里接：`session_start` 时把「这条消息发出时压缩过几次」的
 * 查询函数（读当前会话分支，见 `sessionCompactionLookup`）交给 `bar.ts`，`session_shutdown` 时
 * 摘掉 —— 与取色源同一个理由，旧 sessionManager 会随旧 ctx 一起作废。
 *
 * 行尾的会话时长同理，但多一条硬要求：它按**这条消息发出那一刻**算一次就冻结（`sessionAgeLookup`
 * 收消息、`bar.ts` 缓存），绝不在渲染时读「现在」—— 否则跨分钟的一次重绘就会改掉视口之上的历史行，
 * pi 的主屏渲染器会因此 `fullRender(true)` 清屏 + 清 scrollback（2026-10-24 实测）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, UserMessageComponent } from "@earendil-works/pi-coding-agent";

import {
	DEFAULT_COLOR_NAME,
	installUserMessageBar,
	installUserMessageTimestamp,
	resetUserMessageTurns,
	setAgeLookup,
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
		setAgeLookup(sessionAgeLookup(ctx));
	});
	pi.on("session_shutdown", () => {
		dropThemeSource();
		setCompactionLookup(undefined);
		setAgeLookup(undefined);
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

/** 会话管理器的最小形状：只用到 `getBranch`，条目只看 `type` / `timestamp` / `message`。 */
interface SessionManagerLike {
	getBranch(): Array<{ type?: string; message?: object; timestamp?: string }>;
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

/**
 * 「这条消息发出时，当前上下文窗口已经跑了多久」：从分支里**最近一次 `compaction` 之后的第一条
 * 条目**算到**这条消息发出那一刻**。
 *
 * 为什么不是整个会话的第一条：压缩会重写整个上下文（旧消息全部离开这个窗口），效果与 `/clear`
 * 同类；抬头旁边那两段恰好是同一件事的另外两面 —— 轮次号是全会话累计的、`N compactions` 数到这条
 * 消息为止，只有时长能说出「这个窗口自己活了多久」。用户 2026-10-24 的原话是「从 clear 后的第一轮
 * 对话开始」，而 `/clear` 开的是全新会话（分支里没有旧条目），天然也就等于第一条。
 *
 * 终点是**这条消息自己的 `timestamp`**，不是 `Date.now()`：抬头在视口之上，一变就会触发 pi 的清屏
 * + 清 scrollback 整屏重画（2026-10-24 实测）。用消息时间戳 ⇒ 同一个消息每次都得到同一个值。
 * 消息没有可用时间戳时退到「此刻」（它反正只算一次，之后就冻在缓存里）。
 *
 * `message` 是当前要渲染的那条用户消息（由 `bar.ts` 从组件上取），按对象识别它在分支里的位置；
 * 找不到（还没落盘、或不是本分支的消息）时不影响终点 —— 终点只依赖它自己的时间戳。
 *
 * 边界：压缩之后还没任何新条目时，起点就是那个 `compaction` 自己（那一刻屏幕上就是压缩结果）；
 * 整个分支拿不到可用时间戳时返回 undefined，抬头右端就不画那一段。
 */
function sessionAgeLookup(ctx: ExtensionContext): ((message: object) => number | undefined) | undefined {
	const manager = liveSessionManager(ctx);
	if (!manager) return undefined;
	return (message) => {
		// `start` = 当前窗口里**最近一次压缩之后**的第一条可用时间；压缩后还没新条目时为空，
		// 那就退回 `compactionAt`（压缩条目自身那一刻 —— 屏幕上正显示的就是压缩结果）。
		// 时间戳解不出来的条目直接跳过，不让它把整个结果毒成 NaN。
		let start: number | undefined;
		let compactionAt: number | undefined;
		for (const entry of manager.getBranch()) {
			const ms = parseEntryTime(entry.timestamp);
			if (entry.type === "compaction") {
				start = undefined;
				compactionAt = Number.isNaN(ms) ? undefined : ms;
				continue;
			}
			if (start !== undefined || Number.isNaN(ms)) continue;
			start = ms;
		}
		const base = start ?? compactionAt;
		if (base === undefined) return undefined;
		// 终点取这条消息发出那一刻（不是现在）：抬头一旦画出来就不再变，见 bar.ts 的 messageAge
		const sentAt = parseMessageTime(message);
		const end = Number.isNaN(sentAt) ? Date.now() : sentAt;
		return Math.max(0, end - base);
	};
}

/** 消息对象上的时间戳（毫秒）；不可用返回 NaN。`bar.ts` 的 `formatClock` 吃同一形状。 */
function parseMessageTime(message: object): number {
	const value = (message as { timestamp?: unknown }).timestamp;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") return Date.parse(value);
	return Number.NaN;
}

/** 条目时间戳（ISO 串，session 文件里就是这个形状）；不可解析返回 NaN。 */
function parseEntryTime(value: string | undefined): number {
	if (typeof value !== "string" || value.length === 0) return Number.NaN;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : Number.NaN;
}
