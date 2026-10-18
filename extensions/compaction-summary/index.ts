/**
 * compaction-summary — 压缩块的显示形态简化（接线）
 *
 * ## 为什么要有这个扩展
 *
 * pi 的 `[compaction]` 块用的是 `CompactionSummaryMessageComponent`：一个 `Box(outputPad, 1,
 * t => theme.bg("customMessageBg", t))`，里面「标签 / Spacer(1) / 正文」。于是屏幕上是一整块
 * `customMessageBg` 底色，上下各一条空行，标题与正文之间还有一条空行：
 *
 * ```
 *  （customMessageBg 底色块）
 *   [compaction]
 *  （空行）
 *   Compacted from 208,359 tokens (ctrl+o to expand)
 * ```
 *
 * 用户 2026-10-17 要求简化成：
 *
 * ```
 *  [compaction]
 *  ✔ Compacted from 208,359 tokens (ctrl+o to expand)
 * ```
 *
 * 即**去掉底色、去掉上下两条空行**，并在正文行首加 `✔`；`[compaction]` 标签的颜色与位置
 * 一律照旧。标题与正文之间那行 `Spacer` 一并去掉 —— 用户那个目标形态里两行是紧邻的。
 *
 * ## 实现：`render` 层补丁，不碰 pi 内部结构
 *
 * 三处改动各有各的理由：
 *
 *   1. **底色**：`this.setBgFn(undefined)` —— `Box` 的公开 API，pi 的 `skill-invocation-reorder`
 *      早就用同一招去底色，`setExpanded` / `invalidate` 都不会把它装回去。
 *   2. **上下的内边距行**：`Box` 只有公开的 `setPaddingX`、**没有** `setPaddingY`（`paddingY`
 *      是 TS 私有字段）。写私有字段能在运行期生效，但 pi 一改名就静默失效；所以按**渲染结果**
 *      裁掉首尾的空白行 —— 纯输出层，pi 哪天自己把 `paddingY` 改成 0 也只是让这次裁剪变成
 *      空操作。展开态正文里的段落空行只出现在中间，不会被误裁（见 `stripPaddingRows`）。
 *   3. **标题与正文之间那条 Spacer**：同理，按「首行之后第一段空白」定位，不碰字段。
 *
 * 形如「这行是不是空白」的判断必须**在去底色之前**就能认（那时内边距行裹着 `\x1b[48;…m`），
 * 所以 `compact-style.ts` 的 `isBlankRow` 同时认得裸空格与带背景序列两种形态。
 *
 * ## 为什么不接管 `addMessageToChat`
 *
 * 换成一个自造组件当然更"干净"，但那样就得复刻 pi 的 `Spacer(1)`、`setExpanded`、
 * `toolOutputExpanded` 同步、鼠标点击展开、`invalidate` 重排 —— `skill-invocation-reorder`
 * 那种复刻是有代价的（那段代码一半在讲怎么不把 pi 的行为弄丢）。这里 pi 的组件本身没有
 * 一处需要改**行为**的地方，只是产出的行多了几条、带了个底色，所以留在原组件上改输出最省。
 *
 * ## 标记的颜色
 *
 * `✔` 走皮肤的 **`toolDiffAdded`**（"正向"的绿），与后台任务通知里那个 `✔` 同一套语义。
 * 拿不到（未知槽位抛异常）就退回 `success`，再不行就不加标记 —— 三种情况都只影响这一格，
 * 形态裁剪照常生效。
 *
 * `PI_COMPACTION_SUMMARY=off` 关闭（模块根本不装补丁）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { MARK_GLYPH, restyleCompaction } from "./compact-style.ts";

/**
 * 取色源：pi 的 `Theme`。只用到 `fg` 与 `themeVarAnsi` 那两条读取路径，所以收窄到这里。
 * 渲染时求值（`ctx.ui.theme` 是跨 `/theme` 换肤的活 Proxy）。
 */
interface ThemeLike {
	fg: (color: string, text: string) => string;
}

/** 补丁状态挂原型上（`Symbol.for`）：`/reload` 后模块重新求值，只换取色源、不重复包一层。 */
const PATCH_KEY = Symbol.for("pi-compaction-summary.state");

interface PatchState {
	theme: () => ThemeLike | undefined;
}

/** `✔` 的色槽候选：先 `toolDiffAdded`（正向绿），退回官方 `success`。 */
const MARK_SLOTS = ["toolDiffAdded", "success"] as const;

/**
 * 拼出着色后的 `✔`。
 *
 * 不再手工补 `\x1b[39m`：`theme.fg` 返回的串自带前景复位（`…\x1b[39m`），再补一个就是两个
 * 连续的复位序列（实测踩到：`\x1b[39m\x1b[39m`）。
 *
 * 拿不到皮肤 / 两个槽位都不认时返回空串 —— 调用方据此只做形态裁剪、不加标记。
 */
function resolveMark(theme: ThemeLike | undefined): string {
	if (!theme) return "";
	for (const slot of MARK_SLOTS) {
		try {
			const painted = theme.fg(slot, MARK_GLYPH);
			if (painted.includes(MARK_GLYPH)) return painted;
		} catch {
			// 这份皮肤没有这个槽位：试下一个
		}
	}
	return "";
}

/**
 * 装补丁。返回本次是否真的装了（`/reload` 后是 false —— 已在，只换了取色源）。
 * `CompactionSummaryMessageComponent` 形状不认识（没有 `render`）时返回 false 且什么都不做。
 */
function installCompactionPatch(): boolean {
	const prototype = CompactionSummaryMessageComponent.prototype as unknown as Record<string | symbol, unknown>;
	const existing = prototype[PATCH_KEY] as PatchState | undefined;
	if (existing) return false;

	const originalRender = prototype.render;
	if (typeof originalRender !== "function") return false;

	const state: PatchState = { theme: () => undefined };
	prototype[PATCH_KEY] = state;

	prototype.render = function (this: Record<string, unknown>, width: number): string[] {
		// 去底色：`Box` 的公开 API。先做，这样后面裁空白行时它们就是裸空格。
		try {
			(this.setBgFn as ((fn?: (text: string) => string) => void) | undefined)?.(undefined);
		} catch {
			// 形状不认识：底色留着，其余照做
		}
		let lines: string[];
		try {
			lines = (originalRender as (w: number) => string[]).call(this, width);
		} catch {
			// pi 的渲染抛了就交回去，不要让补丁把异常吞成空白块
			return (originalRender as (w: number) => string[]).call(this, width);
		}
		try {
			return restyleCompaction(lines, resolveMark(state.theme()), (text: string) => visibleWidth(text));
		} catch {
			// 形态裁剪出任何意外都退回 pi 原版的行，而不是让整块消失
			return lines;
		}
	};
	return true;
}

export default function compactionSummary(pi: ExtensionAPI): void {
	if ((process.env.PI_COMPACTION_SUMMARY ?? "").trim().toLowerCase() === "off") return;
	installCompactionPatch();

	pi.on("session_start", (_event, ctx) => {
		const state = (CompactionSummaryMessageComponent.prototype as unknown as Record<string | symbol, PatchState | undefined>)[PATCH_KEY];
		if (state) state.theme = () => liveTheme(ctx);
	});
	pi.on("session_shutdown", () => {
		const state = (CompactionSummaryMessageComponent.prototype as unknown as Record<string | symbol, PatchState | undefined>)[PATCH_KEY];
		if (state) state.theme = () => undefined;
	});
}

/**
 * 读当前皮肤，**永不抛**：会话被替换 / reload 后 pi 会作废旧 ctx，读 `ctx.ui` 抛
 * `This extension ctx is stale …`，而渲染 tick 里的异常没人接得住，会打死整个 pi。
 * 读不到就当这一帧没有皮肤（只做形态裁剪、不加标记），下一个 `session_start` 补上。
 */
function liveTheme(ctx: ExtensionContext): ThemeLike | undefined {
	try {
		const theme = ctx.ui.theme as unknown as ThemeLike;
		// 先探一次：`fg` 不在就是形状不认识
		return typeof theme?.fg === "function" ? theme : undefined;
	} catch {
		return undefined;
	}
}
