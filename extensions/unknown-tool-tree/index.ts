/**
 * unknown-tool-tree — **没有工具定义**的工具调用块的树形展示（接线）
 *
 * 把「工具名根本没注册」这一类块的观感改造成与 bash / read / codemode / mcp / tool_search
 * 同一张列位表：`• ` 开头、`│ ` 续段、`└ ` 收在末行，**没有底色、没有上下边界空行**。
 * 形状与列位规则全在 `render.ts`（不 import pi，`node --test` 能直跑），本文件只做三件事：
 * 注册解析器、判断「这一块该不该归我」、把行拼出来。
 *
 * ## 为什么用 `registerToolRenderer`（与 mcp-tree 同一条路）
 *
 * 这类块**没有 `ToolDefinition` 可捕获**（工具名压根不存在，没有工厂、没有闭包），所以
 * codemode-tree / tool-search-tree 那条「捕获定义 + 同名重注册」的路走不了 —— 也没有必要：
 * pi 1.3.0 的 `pi.registerToolRenderer((toolName, next) => …)` 就是为「工具还没注册 / 永远不注册」
 * 的场景准备的，文档原话是它 "chooses renderers for calls to any tool, including tools that are
 * not registered yet"。
 *
 * ## 判定：只接管「这一块最终会落到 pi 兜底壳」的工具
 *
 * 解析器链按扩展加载顺序串联，`next()` 先走完剩下的解析器、最后是**已注册工具的定义**。所以
 * 三种情形要分开看：
 *
 *   - 工具注册过且有渲染器（bash / read / codemode / mcp__* / tool_search / memory_read …）→
 *     `next()` 返回那个带 `renderCall` / `renderResult` 的对象，本扩展**逐字节原样交给下游**；
 *   - 工具注册过但**没有**自带渲染器（`contact_supervisor` 这类：`pi-subagents` 只给了
 *     `execute` + `parameters`）→ `next()` 返回 definition，但里没有任何渲染器，pi 于是自己
 *     用 `createCallFallback()` / `createResultFallback()` 套上红底兜底 —— **视觉上与未注册完全
 *     同一条路**，所以也归本扩展接管（用户 2026-10-20：
 *     「任何出错的部分的渲染都走这个兜底」）；
 *   - 工具根本没注册（`codemap` 这种写错的名字）→ `next()` 返回 undefined，同样接管。
 *
 * 判据因此是「`next()` 给不出**任何**渲染器」，而不是「`next()` 返回 undefined」—— 只看后者会
 * 漏掉第二类（注册了但不画渲染器的工具），它们的块会继续显示红底 + 上下空行。
 *
 * 这条判据比「匹配名字 `codemap`」稳：它对任何一个写错的工具名、以及任何一个把它交给 pi 兜底壳
 * 的工具自动生效，且**不会**盖过任何将来由别的扩展补上的渲染器（它们排在链上，`next()` 就先拿到）。
 * 代价是它拿不到工具名以外的任何信心 —— 但这类块本来就只有名字、参数与正文内容，没有别的可依赖。
 *
 * ## 壳（`renderShell: "self"`）
 *
 * 兜底块走的是 `ToolExecutionComponent` 的 `contentText` 分支（`Box(1, 1, bgFn)` 刷
 * `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` 底色 + `paddingY = 1` 的上下空行）。
 * 声明 `"self"` 让 pi 改用 `selfRenderContainer`（纯 `Container`，套不上 bgFn），底色与上下
 * 空行就都不画了 —— 与 bash / memory / plan / mcp 同一手法。**代价说清楚**：红底原本是
 * 「这个块失败了」的唯一信号，底色去掉之后由**红圆点 + 红色正文**接手。
 *
 * ## `outputPad`
 *
 * self 壳下渲染器自己负责 pi 的 `outputPad`（默认 1，即每行前置一列左边距）。本扩展**不补**
 * 那一列：圆点要顶到列 0（用户 2026-10-20 的样例里 `codemap` 是顶格的），左侧留白由
 * `MARGIN_WIDTH` 那两格承担。这与 `mcp-tree` / `codemode-tree` / `tool-search-tree` 完全一致
 * （它们也都不读 `outputPad`）。
 *
 * ## 开关
 *
 * `PI_UNKNOWN_TOOL_TREE=off` 关闭（注册期读一次，与 `PI_CODEMODE_TREE` / `PI_MCP_TREE` 同一约定）。
 * 关闭后这类块回到 pi 的兜底壳 —— **纯回退**，因为本扩展没动过任何工具注册。
 */

import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	BODY_INDENT,
	GUTTER_LEAD,
	PREVIEW_MAX_LINES,
	TREE_LAST,
	TREE_PIPE,
	contentWidth,
	expandedArgLines,
	formatArgsSummary,
	previewMoreLinesHint,
	resultTextLines,
	stateDotSlot,
	stripAnsi,
	treePrefixes,
} from "./render.ts";

/** pi 传给 renderCall / renderResult 的渲染上下文里本扩展用到的字段（跨帧同一个 state 对象）。 */
interface FallbackRenderContext {
	state?: { failed?: boolean };
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	args?: unknown;
}

/** 折叠态标题行的工具名 —— 与其它工具块一样用 `toolTitle` + 加粗。 */
function toolNameText(toolName: string, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(stripAnsi(toolName)));
}

/**
 * 本扩展的渲染器。`toolName` 来自解析器参数 —— 这类块没有 `ToolDefinition`，名字只能从这里拿
 * （`context` 里没有 toolName 字段）。
 */
function createFallbackRenderers(toolName: string): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args: unknown, theme: Theme, context: FallbackRenderContext) {
			// 圆点颜色读 `state.failed`：`updateDisplay()` 先跑 renderCall、再跑 renderResult，而
			// 两个组件的 `render()` 都在那之后 —— 同一帧读得到（mcp-tree / tool-search-tree 同款时点）。
			// 兜底：结果没到过时按 isPartial / isError 判。
			return {
				render(width: number): string[] {
					const failed = context.state?.failed ?? context.isError === true;
					const slot = stateDotSlot(context.isPartial === true, failed);
					const dot = theme.fg(slot, "\u2022");
					const name = toolNameText(toolName, theme);
					const prefixWidth = 2 + toolName.length + 1; // `• ` + 工具名 + 空格
					const budget = Math.max(0, width - prefixWidth);
					// 展开态的参数已经逐行铺在正文里（`key:` + 值），标题行不再重复一份压缩版。
					const summary = context.expanded === true ? "" : formatArgsSummary(args, budget);
					// 标题行顶格（不挂 BODY_INDENT），所以折行预算就是整个宽度。
					const line = summary === "" ? `${dot} ${name}` : `${dot} ${name} ${theme.fg("text", summary)}`;
					return wrapTextWithAnsi(line, Math.max(1, width || 80));
				},
				invalidate() {},
			};
		},
		renderResult(
			result: unknown,
			options: { expanded?: boolean },
			theme: Theme,
			context: FallbackRenderContext,
		) {
			// isError 必须从 **context** 读：pi 传给 resultRenderer 的对象是 `{ content, details }`，
			// 没有 isError 字段（它只在 getRenderContext() 里）。分类同步写进 state，否则
			// renderCall 那颗圆点会晚一帧才变色。
			const failed = context.isError === true;
			if (context.state) context.state.failed = failed;
			const expanded = options?.expanded === true;
			const args = context.args;
			// 结果是静态的，按宽度缓存排版（每次 renderResult 调用新建，expanded / failed 已在闭包里）。
			const cache = new Map<number, string[]>();
			return {
				render(width: number): string[] {
					const key = Math.max(1, width || 80);
					const hit = cache.get(key);
					if (hit !== undefined) return hit;

					const bodyWidth = Math.max(1, contentWidth(key));
					// 正文来源：展开态先铺参数（`key:` + 缩进后的值），再铺结果；折叠态只有结果。
					// 折叠态不再把参数重复一遍 —— 标题行已经压成单行了。
					const sourceLines = [...(expanded ? expandedArgLines(args) : []), ...resultTextLines(result)];
					const rows: string[] = [];
					for (const line of sourceLines) {
						// 空行也占一行（wrapTextWithAnsi("") → [""]）：段落间距是可读性的一部分
						rows.push(...wrapTextWithAnsi(line, bodyWidth));
					}
					if (rows.every((row) => row.trim() === "")) {
						cache.set(key, []);
						return [];
					}
					// 预览截断：非展开态裁到 PREVIEW_MAX_LINES 行，提示行挂在被裁正文的末尾。
					let visible = rows;
					let hidden = 0;
					if (!expanded && rows.length > PREVIEW_MAX_LINES) {
						visible = rows.slice(0, PREVIEW_MAX_LINES);
						hidden = rows.length - visible.length;
					}
					// 前缀按**折行 + 截断之后**的视觉行数算：折行碎片与提示行各算独立行，否则
					// 一个折成三行的长句会在第一片就画上 `└`，看着像树提前结束了。
					const prefixes = treePrefixes(visible.length + (hidden > 0 ? 1 : 0));
					// 失败正文整段红（与失败圆点同槽）：底色被 self 壳去掉后，红色这一层信号由正文与
					// 圆点共同承担。成功正文走 `toolOutput`（与 bash 输出同色）。
					const bodySlot = failed ? "toolDiffRemoved" : "toolOutput";
					const lines = visible.map(
						(row, index) =>
							// 结构符落在列 2（GUTTER_LEAD 两格），它后面那一格空格把正文顶到列 4
							GUTTER_LEAD +
							// 结构符走 muted 且自成一段 SGR，不让正文颜色透上来
							theme.fg("muted", prefixes[index] ?? TREE_PIPE) +
							theme.fg(bodySlot, row),
					);
					if (hidden > 0) {
						lines.push(
							GUTTER_LEAD +
								theme.fg("muted", prefixes[visible.length] ?? TREE_PIPE) +
								theme.fg("muted", previewMoreLinesHint(hidden)),
						);
					}
					cache.set(key, lines);
					return lines;
				},
				invalidate() {
					cache.clear();
				},
			};
		},
	};
}

export default function unknownToolTree(pi: ExtensionAPI): void {
	if (process.env.PI_UNKNOWN_TOOL_TREE?.trim().toLowerCase() === "off") return;

	// 用函数声明提前返回，`next()` 只会被调用一次 —— 解析器链的其余部分与已注册工具定义
	// （含 pi 内置渲染器）一个都不多跑。
	pi.registerToolRenderer((toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const base = next();
		// 真正带渲染器的工具（或排在链上更早的解析器）→ 原样交下去，绝不改写。
		if (base !== undefined && (base.renderCall !== undefined || base.renderResult !== undefined)) return base;
		// 剩余两种都落到 pi 的兜底壳（`next()` 为 undefined = 工具没注册；有 definition 但两个渲染器
		// 都是 undefined = 工具注册了却没自带渲染器），形状统一由本扩展接管。
		return createFallbackRenderers(toolName);
	});
}
