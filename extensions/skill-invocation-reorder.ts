/**
 * skill-invocation-reorder — `/skill:name 提示词` 的显示顺序反转：先画用户消息、再画 skill 调用行。
 *
 * pi 的默认渲染（`interactive-mode.js` 的 `addMessageToChat`，`case "user"`）对一条
 * skill-wrapped 用户消息的顺序是：
 *
 *     [skill] commit (ctrl+o to expand)   ← SkillInvocationMessageComponent（先）
 *     （Spacer 1）
 *     ▏ 提示词                             ← UserMessageComponent（后）
 *
 * 用户想要的顺序反过来：**先**正常显示用户消息（`user-message-bar` 的 `▏` 竖线照常生效，
 * 内容就是用户敲的那条命令原文），**再**在下方显示 `[skill] name (ctrl+o to expand)` 折叠行：
 *
 *     ▏
 *     ▏ /skill:commit 提交一下
 *     ▏
 *
 *     [skill] commit (ctrl+o to expand)
 *
 * 且 skill 折叠行**不带底色、不留尾部空行**（用户 2026-10-14 定）：pi 给这个组件套的是
 * `Box(outputPad, 1, t => theme.bg("customMessageBg", t))`，于是整块（含上下两条内边距行）
 * 都刷上 `customMessageBg`。本扩展构造后调 `setBgFn(undefined)` 把底色拿掉 —— 底色一去，
 * **下**内边距行就只是屏幕上一条多余的空行，所以再把它裁掉；**上**内边距行要留（它是用户
 * 消息框与 `[skill]` 行之间的那条间隔，用户明确说这条是对的）。
 *
 * ## 只改显示，不改发送
 *
 * 发送给模型的仍是 pi 展开后的**一条** user 消息（`<skill>…</skill>\n\n提示词`），
 * 本扩展只接管「这条消息画到 chatContainer 里的顺序与组件」，session 记录、模型上下文、
 * ctrl+o 全局展开（`setToolsExpanded` 遍历 children 调 `setExpanded`）全部不受影响。
 *
 * ## 实现：原型补丁（与 user-message-bar 同一手法）
 *
 * pi 的扩展 API 没有「用户消息渲染」的注入点，只能包 `InteractiveMode.prototype.addMessageToChat`。
 * 补丁打得中的原因：扩展加载器把 `@earendil-works/pi-coding-agent` 映射到 pi 自己那份
 * （bundle 形态下是 `virtual-modules` 的同一命名空间），扩展 import 到的 `InteractiveMode`
 * 就是渲染用的那个类。补丁在**模块求值时**就装（此时还没有任何 InteractiveMode 实例），
 * 一定赶在第一条消息渲染之前。
 *
 * 命中条件极窄：`message.role === "user"` 且 `parseSkillBlock(text)` 非空 —— 其余一切
 * （bash / custom / assistant / 普通用户消息）原样委托给原函数，零行为变化。
 *
 * 命中时**完整复刻** pi 原分支的每一步，只调换两个组件的先后：
 *   - 前置 `Spacer(1)`（chatContainer 非空时，与原分支一致）；
 *   - `UserMessageComponent(重建的 /skill:name 提示词, …)` —— 只画命令那一行；
 *   - `SkillInvocationMessageComponent(skillBlock, …)` + `setBgFn(undefined)`（去底色）
 *     + 裁掉尾部空行 + `setExpanded(this.toolOutputExpanded)`
 *     —— 折叠行本体，点击切换展开、ctrl+o 全局展开都保留；
 *   - `options.populateHistory` 时 `this.editor.addToHistory?.(textContent)`（resume 回放历史用）。
 *
 * 取不到私有字段（`chatContainer` / `outputPad` / `getMarkdownThemeWithSettings` /
 * `getMarkdownTransformers`）时退回原函数 —— pi 改了内部结构时回到默认顺序，而不是崩。
 *
 * `Symbol.for` 全局注册表做幂等：`/reload` 后模块重新求值，补丁已在就只刷新状态、不再包一层。
 *
 * `PI_SKILL_INVOCATION_REORDER=off` 启动时关闭。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	InteractiveMode,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";

const PATCH_KEY = Symbol.for("pi-skill-invocation-reorder.patched");

/**
 * 从 skill 块**重建**用户敲的那条命令：`/skill:<name> <提示词>`。
 *
 * 为什么要重建：pi 把 `/skill:name 提示词` 展开成 `<skill>…</skill>\n\n提示词` 后才交给渲染，
 * 展开后的消息里只剩提示词，`/skill:name` 前缀已经没了。而用户要的消息框内容是「跟用户输入的
 * 完全一样」—— 包含 `/skill:name` 前缀的完整命令。
 *
 * 为什么不在 `input` 钩子里记下原文：那是**跳钩子的共享状态**，而输入可能被排队（streaming 时
 * 的 steer / followUp）延后渲染，期间再敲一条 `/skill:` 就会把前一条的原文覆盖掉 —— 画错比画少
 * 更糟。重建则无状态、无时序依赖，且 **resume 回放也能用**（回放没有 input 钩子，记原文那条路
 * 在回放时必然退化成只显示提示词）。重建与原文的差异只剩多余空白（pi 展开前已 `trim()` 过 args）。
 */
function reconstructSkillCommand(name: string, userMessage: string): string {
	return `/skill:${name} ${userMessage}`;
}

/** pi 的 user 消息（只用到这里需要的字段）。 */
interface UserMessageLike {
	role: "user";
	content: unknown;
}

/** `addMessageToChat` 的第二参数（`populateHistory` 等）。 */
type AddMessageOptions = { populateHistory?: boolean } | undefined;

/** 从 user 消息里取纯文本 —— 与 pi 的 `getUserMessageText` 同逻辑。 */
function getUserMessageText(message: UserMessageLike): string {
	const content = message.content;
	const textBlocks =
		typeof content === "string"
			? [{ type: "text", text: content }]
			: Array.isArray(content)
				? content.filter((c) => (c as { type?: string }).type === "text")
				: [];
	return textBlocks.map((c) => (c as { text?: string }).text ?? "").join("");
}

/**
 * 「视觉上空白」的一行：只有空白字符与零宽转义序列。
 * Box 的内边距行在**没有 bgFn** 时就是 `width` 个空格（`applyBg` 把空行补白到整宽后直接返回），
 * 有 bgFn 时则裹着 `\x1b[48;…m` / `\x1b[49m` —— 两种形态都要认得。
 */
const BLANK_ROW = /^(?:\s|\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))*$/;

/** 裁掉末尾的空白行（Box 的下内边距行）。全是空白时返回空数组 —— 那时确实没东西可画。 */
function trimTrailingBlankRows(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && BLANK_ROW.test(lines[end - 1]!)) end -= 1;
	return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * 去掉 skill 折叠行的**下内边距行**（底色拿掉之后它就是一条多余空行）。
 *
 * 为什么从渲染结果上裁、而不是把 `paddingY` 改成 0：`Box` 只有公开的 `setPaddingX`，
 * **没有** `setPaddingY`（`paddingY` 是 TS 私有字段）。写私有字段能在运行期生效，但 pi 一改名
 * 就静默失效；而裁剪是纯输出层的，不碰任何内部状态，pi 哪天把 `paddingY` 改成 0 也只是
 * 让这次裁剪变成空操作。上内边距行因此原样保留（用户要的那条间隔）。
 *
 * 点击展开不受影响：父容器按 `render()` 的行数算鼠标布局，`Box.handleMouse` 仍按
 * `paddingY = 1` 换算坐标 —— 裁掉的是**末尾**那行，`[skill]` 正文行的 y 坐标没变，点它照样切换。
 */
function dropTrailingPaddingRow(component: { render: (width: number) => string[] }): void {
	const innerRender = component.render.bind(component) as (width: number) => string[];
	component.render = (width: number): string[] => trimTrailingBlankRows(innerRender(width));
}

/**
 * 装补丁。返回本次是否真的装了（`/reload` 后为 false —— 已在，不重复包）。
 * `InteractiveMode` 形状不认识（没有 `addMessageToChat`）时返回 false 且什么都不做。
 */
function installReorderPatch(): boolean {
	const prototype = InteractiveMode.prototype as unknown as Record<string | symbol, unknown>;
	if (prototype[PATCH_KEY]) return false;

	const original = prototype.addMessageToChat;
	if (typeof original !== "function") return false;

	prototype[PATCH_KEY] = true;
	prototype.addMessageToChat = function (
		this: Record<string, unknown>,
		message: { role?: string },
		options?: AddMessageOptions,
	): void {
		if (message?.role !== "user") {
			return (original as (m: unknown, o?: AddMessageOptions) => void).call(this, message, options);
		}

		const textContent = getUserMessageText(message as UserMessageLike);
		const skillBlock = textContent ? parseSkillBlock(textContent) : null;
		if (!skillBlock || !skillBlock.userMessage) {
			// 没有 skill 块（或 skill 没跟提示词）：原样走 pi 的渲染。
			return (original as (m: unknown, o?: AddMessageOptions) => void).call(this, message, options);
		}

		// 取 pi 的私有渲染上下文；任何一个拿不到就退回原函数（回到默认顺序，不崩）。
		const chatContainer = this.chatContainer as { children?: unknown[]; addChild?: (c: unknown) => void } | undefined;
		const outputPad = typeof this.outputPad === "number" ? this.outputPad : undefined;
		const getMarkdownThemeWithSettings = this.getMarkdownThemeWithSettings;
		const getMarkdownTransformers = this.getMarkdownTransformers;
		if (
			!chatContainer ||
			!Array.isArray(chatContainer.children) ||
			typeof chatContainer.addChild !== "function" ||
			outputPad === undefined ||
			typeof getMarkdownThemeWithSettings !== "function" ||
			typeof getMarkdownTransformers !== "function"
		) {
			return (original as (m: unknown, o?: AddMessageOptions) => void).call(this, message, options);
		}

		const markdownTheme = (getMarkdownThemeWithSettings as () => unknown).call(this);
		const transformers = (getMarkdownTransformers as () => unknown).call(this);

		// 前置空行（与 pi 原分支一致：chatContainer 已有内容时才加）。
		if (chatContainer.children.length > 0) {
			chatContainer.addChild(new Spacer(1));
		}

		// 1) 用户消息在前（user-message-bar 的竖线补丁照常作用于它）。
		//    内容是**重建出的完整命令**（`/skill:name 提示词`），而不是展开后剩下的那截提示词。
		const userComponent = new UserMessageComponent(
			reconstructSkillCommand(skillBlock.name, skillBlock.userMessage),
			markdownTheme as never,
			outputPad,
			transformers as never,
		);
		chatContainer.addChild(userComponent);

		// 2) skill 折叠行在后。
		const skillComponent = new SkillInvocationMessageComponent(
			skillBlock as never,
			markdownTheme as never,
			outputPad,
		);
		// 去掉整块底色：pi 构造时传的是 `t => theme.bg("customMessageBg", t)`，`Box` 的公开
		// `setBgFn(undefined)` 让 `applyBg` 直接返回补白行、不再刷背景。比换掉整个组件安全：
		// 折叠/展开两态、点击切换、ctrl+o 全局展开、展开态的 Markdown 渲染全部原样保留。
		// `setExpanded` / `invalidate` 只重建 children，不会把 bgFn 装回去。
		if (typeof skillComponent.setBgFn === "function") skillComponent.setBgFn(undefined);
		// 底色没了，下内边距行就是一条多余空行 —— 裁掉（上内边距行保留，见 dropTrailingPaddingRow）。
		dropTrailingPaddingRow(skillComponent);
		const toolOutputExpanded = this.toolOutputExpanded;
		skillComponent.setExpanded(typeof toolOutputExpanded === "boolean" ? toolOutputExpanded : false);
		chatContainer.addChild(skillComponent);

		// 3) resume 回放时把原文塞回编辑器历史（与 pi 原分支一致）。
		if (options?.populateHistory) {
			const editor = this.editor as { addToHistory?: (text: string) => void } | undefined;
			editor?.addToHistory?.(textContent);
		}
	};
	return true;
}

export default function (_pi: ExtensionAPI): void {
	if ((process.env.PI_SKILL_INVOCATION_REORDER ?? "").trim().toLowerCase() === "off") return;
	installReorderPatch();
}
