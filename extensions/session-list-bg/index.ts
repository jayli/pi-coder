/**
 * session-list-bg — `/resume` 列表**选中行**的底色（接线）
 *
 * 本文件只做接线：把 `SessionSelectorComponent.prototype.render` 包一层，交给 `row.ts` 重绘；
 * 全部逻辑在 `row.ts`（不 import pi，`node --test` 能直跑）。
 *
 * ## 三件事
 *
 * 1. 选中行的底色从 `selectedBg` 换成**用户 prompt 的底色**（`userMessageBg`，用户 2026-10-28 定，
 *    与补全菜单选中行同一个 surface）。
 * 2. 修一个真 bug：标题被缩略成 `…` 之后，`…` 往右（含 `…` 本身与行尾的消息数/时间）**没有底色**。
 *    根因是 pi 先截正文、再整行上底色，而 `truncateToWidth` 截断时插了一个裸 `\x1b[0m`
 *    （全属性复位，连底色一起清掉）。逐字节证据与推演见 `row.ts` 的文件头。
 * 3. 正文**去掉加粗、改用 `accent` 颜色**（用户 2026-10-28 同一轮追加）；行尾的消息数与时间
 *    仍然走 `dim`，不跟着变色。
 * 4. 列表顶部**搜索框的提示符**从 pi-tui 默认的 `> ` 换成 `Search: `（用户 2026-10-28 定）。
 *    它跟底色无关，但同样只能从 `SessionSelectorComponent` 的原型拿到那个 `Input` 实例 ——
 *    逻辑在 `search-prompt.ts`。
 *
 * ## 为什么能打到
 *
 * bundle 运行时，扩展解析 `@earendil-works/pi-coding-agent` 走 loader 的 `virtualModules`
 * （`dist/bundle/chunks/virtual-modules-*.js`），拿到的是 chunk 自己的命名空间。**实测**
 * `VIRTUAL_MODULES["@earendil-works/pi-coding-agent"].SessionSelectorComponent
 * === chunk-MM3LKT73.SessionSelectorComponent` → `true`，而 `InteractiveMode.showSessionSelector()`
 * 就是在这个 chunk 里 `new` 的 —— 同一个类对象，所以原型补丁落在 pi 自己创建的那个实例上。
 * `statusline/footer-suppress.ts`（`FooterComponent`）与 `fenceless-code-block`（`Markdown`）
 * 是同一条前提。
 *
 * 用 `SessionSelectorComponent` 而不是列表本体：pi 的 `SessionList` 是 `session-selector.js`
 * 里的文件内私有类，包根不导出；`SessionSelectorComponent` 在包根导出，且它的 `render()`
 * 继承自 `Container`，直接透传 `sessionList.render()` 的行数组。
 *
 * ## 什么时候装
 *
 * 模块求值时就装（`statusline` 的 footer 补丁同款做法）：它在 pi 的 TUI 创建之前跑完，
 * 一定赶得上首次渲染，不依赖事件顺序。皮肤在**渲染时**才读（`theme.getBgAnsi` 走
 * `globalThis` 的活 Proxy，`/theme` 换肤下一帧即生效），所以不需要 `session_start`。
 *
 * ## 不覆盖 `pi -r`
 *
 * 启动时的 `--resume` 选择器在扩展加载**之前**就画完了：`main.js` 里 `createSessionManager()`
 * （内含 `selectSession()`）先于 `createAgentSessionServices()`（扩展在那里加载）执行。
 * 要覆盖它只能给 pi 安装目录的 bundle 打补丁，本期按用户选择不做。
 *
 * ## 约束
 *
 * - 只换 `prototype.render`，不碰实例、不碰 pi 内部状态、不读任何私有字段；
 * - 幂等：`/reload` 会重新求值模块，新实例先**更新**记录里的槽位再返回，不叠 wrapper；
 * - 任何异常都当「没打上」（渲染 tick 里抛出去没人接得住，会把 pi 打死 ——
 *   `user-message-bar` 2026-09-20 实测）；
 * - `PI_SESSION_LIST_BG=off` 关闭整个扩展；其余非空值当底色槽位名（默认 `userMessageBg`）。
 * - `PI_SESSION_LIST_TITLE=<槽位>` 改正文颜色（默认 `accent`）；`off` / `none` / `-` → 只去粗体、不染色。
 * - `PI_SESSION_LIST_PROMPT=<文本>` 改搜索框提示符（默认 `Search: `）；`off` / `none` / `-` → 保留 pi 的 `> `。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionSelectorComponent } from "@earendil-works/pi-coding-agent";

import {
	repaintSelectedRows,
	resolveRowPaintOptions,
	resolveSessionListBgEnabled,
	resolveSessionListBgSlot,
	resolveSessionListTitleSlot,
	type RowColorSource,
} from "./row.ts";
import { applySearchPrompt, resolveSearchPrompt } from "./search-prompt.ts";

/**
 * 补丁状态挂在**原型**上（`Symbol.for` 走全局注册表，`/reload` 重新求值后仍认得出这个原型
 * 已被包过）—— 于是 reload 后的新实例只**更新槽位**，不会再包一层。
 */
const PATCH_KEY = Symbol.for("litellm-any.pi-session-list-bg.state");

interface RowPatchState {
	/** 目标底色槽位名（`PI_SESSION_LIST_BG` 可改）。 */
	slot: string;
	/** 正文颜色槽位名（`PI_SESSION_LIST_TITLE` 可改；空串 = 只去粗体、不染色）。 */
	titleSlot: string;
	/** 搜索框提示符（`PI_SESSION_LIST_PROMPT` 可改；空串 = 保留 pi 的 `> `）。 */
	prompt: string;
	/** 渲染时取皮肤（`session_start` 后换成活的皮肤，见下方 `installSessionListBg`）。 */
	theme: () => RowColorSource | undefined;
}

/** 本模块用到的 `SessionSelectorComponent` 形状（不 import pi，单测直接塞假类）。 */
export interface SessionSelectorClassLike {
	prototype: Record<string | symbol, unknown>;
}

export interface InstallOptions {
	/** pi 的 `SessionSelectorComponent` 类（补丁打在它的 `prototype.render` 上）。 */
	SessionSelectorComponent: SessionSelectorClassLike;
	/** 渲染时取皮肤：读 `ctx.ui.theme`。拿不到（非 TUI / 换会话窗口）就返回 `undefined`。 */
	theme: () => RowColorSource | undefined;
	/** 目标底色槽位名，默认 `userMessageBg`。 */
	slot?: string;
	/** 正文颜色槽位名，默认 `accent`；空串 = 只去粗体、不染色。 */
	titleSlot?: string;
	/** 搜索框提示符，默认 `Search: `；空串 = 保留 pi 的 `> `。 */
	prompt?: string;
}

/**
 * 装上重绘补丁。返回**本次是否真的装了**：`/reload` 之后是 `false`（补丁已在，只换了槽位），
 * 原型形状不认识（没有 `render`）时也是 `false` 且什么都不做 —— 不猜、不抛，宁可这个特性不生效。
 */
export function installSessionListBg(options: InstallOptions): boolean {
	const prototype = options.SessionSelectorComponent.prototype;
	const slot = options.slot ?? resolveSessionListBgSlot(undefined);
	const titleSlot = options.titleSlot ?? resolveSessionListTitleSlot(undefined);
	const prompt = options.prompt ?? resolveSearchPrompt(undefined);

	const existing = prototype[PATCH_KEY] as RowPatchState | undefined;
	if (existing) {
		// 重复安装只**更新**状态，不重包一层（`/reload`、`session_start` 后重新注入皮肤都走这里）。
		// 取色源必须一起换 —— 首次安装时它还是 `() => undefined`（模块求值早于 TUI），
		// 只换槽位不换取色源的话，wrapper 会永远拿不到皮肤。
		existing.slot = slot;
		existing.titleSlot = titleSlot;
		existing.prompt = prompt;
		existing.theme = options.theme;
		return false;
	}

	const original = prototype.render;
	if (typeof original !== "function") return false;

	const state: RowPatchState = { slot, titleSlot, prompt, theme: options.theme };

	const wrapper = function (this: unknown, ...args: unknown[]): string[] {
		// 提示符要在**渲染之前**写进那个 `Input`：`Input.render` 直接拿 `this.prompt` 算宽度。
		// 拿不到实例（形状不认识）时 `applySearchPrompt` 自己安静返回 false，不会抛进渲染 tick。
		applySearchPrompt(this, state.prompt);
		const lines = (original as (...args: unknown[]) => string[]).apply(this, args);
		if (!Array.isArray(lines) || lines.length === 0) return lines;
		try {
			const paint = resolveRowPaintOptions(safeTheme(state.theme), state.slot, state.titleSlot);
			// 拿不到皮肤 / 皮肤缺槽 → 原样返回（这一帧不改，也不报错）
			if (!paint) return lines;
			return repaintSelectedRows(lines, paint);
		} catch {
			// 渲染 tick 里的异常没人接得住，宁可这一帧不重绘
			return lines;
		}
	};

	prototype[PATCH_KEY] = state;
	prototype.render = wrapper;
	return true;
}

/** 读皮肤：旧 ctx 作废后一点就抛，所以整条读取都包起来。 */
function safeTheme(read: () => RowColorSource | undefined): RowColorSource | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI): void {
	if (!resolveSessionListBgEnabled(process.env.PI_SESSION_LIST_BG)) return;
	const slot = resolveSessionListBgSlot(process.env.PI_SESSION_LIST_BG);
	const titleSlot = resolveSessionListTitleSlot(process.env.PI_SESSION_LIST_TITLE);
	const prompt = resolveSearchPrompt(process.env.PI_SESSION_LIST_PROMPT);

	// 模块求值时先装一次：此时取色源还没有，`row.ts` 会安静地原样返回；
	// 这样补丁一定赶在 pi 第一次渲染之前到位，不依赖事件顺序。
	installSessionListBg({ SessionSelectorComponent, theme: () => undefined, slot, titleSlot, prompt });

	// 拿到 ctx 之后把取色源换成活的皮肤。`session_start` 是**所有**扩展的模块求值都完成之后
	// 才发的，所以这里更新记录不会和别的扩展抢包装顺序（本补丁本来也不和别人共用原型）。
	pi.on("session_start", (_event, ctx) => {
		installSessionListBg({ SessionSelectorComponent, theme: () => liveTheme(ctx), slot, titleSlot, prompt });
	});
}

/**
 * 从 ctx 读皮肤。**不能把 `ctx.ui.theme` 在模块顶层取出来存着**：会话被替换（`/clear`、`/new`、
 * `/resume`、`/fork`、`/reload`）时旧 ctx 会作废，读它一点就抛 —— 而渲染 tick 里的异常没人接得住。
 * 所以每次渲染现读，并且整条读取都包在 `safeTheme` 里。
 */
function liveTheme(ctx: { ui: { theme: RowColorSource } }): RowColorSource | undefined {
	return ctx.ui.theme;
}
