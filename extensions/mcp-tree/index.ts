/**
 * mcp-tree — **任意 MCP 工具块**的树形展示（接线）
 *
 * 把 MCP 工具块的观感改造成与 `bash-command-collapse.ts` / `memory/` / `tool-search-tree/` /
 * `web-search-tree/` 同一套：`• ` 开头、`│ ` 续段、`└ ` 只出现一次的树，**没有底色、没有
 * 上下边界空行**（用户 2026-10-16 定的三条诉求）。形状与列位规则全在 `render.ts`（不 import
 * pi，`node --test` 能直跑），本文件只做一件事：注册一个渲染器解析器，委托内置 MCP 渲染器
 * 再把它的行重排成树。
 *
 * ## 为什么用 `pi.registerToolRenderer` 而不是 `registerTool`（与同目录的兄弟们不同）
 *
 * `codemode-tree` / `tool-search-tree` / `web-search-tree` 都走**捕获 + 同名重注册**，因为
 * 它们的工具定义在别人的闭包里（内置扩展 / npm 包），而 `renderCall` / `renderResult` 是
 * `ToolDefinition` 的字段 —— pi 没有「事后替换某个已注册工具的渲染器」这种机制。这条路的
 * 代价是：包得先别自动加载（`settings.json` 的 `packages` 过滤）、`-builtin:` 消 warning、
 * 关了开关工具会整个消失。
 *
 * MCP 工具**不需要**付这些代价：pi 提供了 `pi.registerToolRenderer((toolName, next) => …)`，
 * 文档原话是它 "chooses renderers for calls to **any** tool, including tools that are not
 * registered yet, such as MCP tools in a resumed session before their server connected"。
 * 解析器按扩展加载顺序串联，`next()` 交给下一个解析器、最后是**已注册的工具**——
 * 而内置 MCP 扩展自己也用这个钩子注册了一个（`dist/extensions/mcp/index.js`：
 * `/^mcp__(.+?)__(.+)$/` → `createMcpToolRenderers`），且它写的是 `next() ?? mine`。
 *
 * 所以只要我们的解析器**不调 `next()`** 就能盖过它，两个加载顺序都安全：
 *   - 我们排在内置**之前**：我们的解析器看到 `next()` 存在（内置那个），但不调它；
 *   - 我们排在内置**之后**：内置先跑，它返回的是 `next() ?? createMcp…`，而它调用 `next()`
 *     时轮到的是我们的解析器（排在它后面 → 更靠后给下一环）…… 这条要看实际顺序。
 *
 * 稳妥做法是**两条都挡**：我们的解析器直接返回自己的渲染器（不调 `next()`），同时不依赖
 * 「内置一定排在我们后面」。实测（见 `index.test.ts`）：无论哪种顺序，最终生效的都是我们这份。
 *
 * ## 覆盖范围：`direct` / `deferred` 曝露的 MCP 工具
 *
 * 只有这两种曝露的工具会**独立成块**。`codemode`（内置默认）的 MCP 工具走
 * `codemode` 脚本调用，pi 对带 `parentToolCallId` 的嵌套调用直接跳过 ——
 * `interactive-mode.js` 的 `tool_execution_start` 分支原话是
 * "Nested calls (from codemode scripts) are shown inside their parent's row"，
 * 它们出现在 **codemode 块内部**、已由 `codemode-tree` 接管，与本扩展无关。
 *
 * 所以本扩展是**全局**匹配 `mcp__*`（用户 2026-10-16 问的「能否适用到所有自定义接入的 mcp」
 * —— 可以，这是 pi 给的钩子本身的粒度），而不是只针对某一个 server。若将来只想收窄到某个
 * server，把 `MANAGED_PREFIX` 换成 `mcp__<server>__` 即可。
 *
 * ## 工具名 → 显示标签
 *
 * 内置渲染器认的 `label` 是 `server/tool`（`createMcpToolDefinition` 里 `label` 就是这个），
 * 而 pi 工具名是 `mcp__server__tool`。我们**不自己拼 label**，而是让内置渲染器自己画它认识
 * 的那份（`formatToolCallWithArgs(label, args, …)`）—— 这样工具名加粗、`toolTitle` 色、
 * 折叠态 `key=value` / 展开态逐行 `key:`、100 字符截断全都照内置行为走，我们只在最前面
 * 加一颗圆点（用户 2026-10-16 定：参数保留在标题行）。
 *
 * ## 壳（`renderShell: "self"`）
 *
 * 内置 MCP 渲染器**没有**设 `renderShell`（实测 `createMcpToolRenderers()` 返回的对象里
 * 只有 `renderCall` / `renderResult`），于是 pi 走默认分支套 `contentBox = Box(1, 1, bgFn)`：
 * 整块刷 `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` 底色，`paddingY = 1` 给上下各一行
 * 空行。解析器返回的是 `ToolRenderers = Pick<ToolDefinition, "renderShell" | "renderCall" |
 * "renderResult">` —— **壳也在可控范围内**，声明 `"self"` 即可（与 bash / memory 同一手法）。
 *
 * `PI_MCP_TREE=off` 关闭（注册期读一次，与 `PI_CODEMODE_TREE` / `PI_WEB_SEARCH_TREE` /
 * `PI_TOOL_SEARCH_TREE` 同一约定）。**关闭后 MCP 工具照常可用**，只是回到内置观感 ——
 * 这一点比兄弟们便宜：它们的 off 会让工具整个消失（因为内置已被 settings 禁用），
 * 本扩展没动过任何注册，所以 off 是纯回退。
 */

import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";

import {
	contentWidth,
	isFailureResult,
	shapeResultLines,
	stateDotSlot,
	trimLeadingBlanks,
	trimTrailingBlanks,
	withCallGutter,
} from "./render.ts";

/** 接管哪些工具：pi 给 MCP 工具的名字形如 `mcp__<server>__<tool>`。 */
const MANAGED_PREFIX = "mcp__";

/**
 * 环境开关。注册期读一次 —— 与 `PI_CODEMODE_TREE` / `PI_WEB_SEARCH_TREE` 同一约定
 * （运行期改它不会生效，要 `/reload`）。
 */
function isDisabled(): boolean {
	return process.env.PI_MCP_TREE?.trim().toLowerCase() === "off";
}

/** pi 传给 renderCall / renderResult 的渲染上下文里我们用到的字段（跨帧同一个 state 对象）。 */
interface McpToolRenderContext {
	state?: { innerCall?: InnerComponent; innerResult?: InnerComponent; failed?: boolean };
	isPartial?: boolean;
	isError?: boolean;
}

/** 内置渲染器返回的组件（`Text` / `Container`，只要能 render 就行）。 */
interface InnerComponent {
	render(width: number): string[];
	invalidate?(): void;
}

/** 一个什么都不画的空组件 —— 内置渲染器缺失时的兜底，避免把 `undefined` 传下去。 */
const EMPTY_COMPONENT: InnerComponent = { render: () => [], invalidate: () => {} };

/** 内置渲染器返回的可能是 `Container`（带 children）也可能是单个组件 —— 统一成行数组。 */
function componentLines(component: InnerComponent | undefined, width: number): string[] {
	if (!component) return [];
	const children = (component as unknown as { children?: InnerComponent[] }).children;
	if (!Array.isArray(children) || children.length === 0) {
		return typeof component.render === "function" ? component.render(width) : [];
	}
	const lines: string[] = [];
	for (const child of children) {
		if (child && typeof child.render === "function") lines.push(...child.render(width));
	}
	return lines;
}

/**
 * 把**原始结果**里的 text 块拼成行数组 —— 失败判定读它，不读渲染后的行。
 *
 * 为什么不用 `componentLines`：那个要求宽度、要跑渲染器，而失败判定必须**同步且无宽度**地在
 * `renderResult` 里算完（见那里的注释）。这里只做字符串拼接，零成本、无副作用。
 */
function resultTextLines(result: unknown): string[] {
	const blocks = (result as { content?: ReadonlyArray<{ type?: string; text?: string }> } | undefined)?.content;
	if (!Array.isArray(blocks)) return [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.flatMap((block) => (block.text as string).split("\n"));
}

/**
 * 按**宽度 + 形状键**缓存行数组：`render(width)` 每帧都调，而委托链路不便宜（要跑内置渲染器
 * 再重排）。键里必须带上状态 —— 圆点颜色、续段前缀都随状态变，只按宽度缓存会把上一帧的形状
 * 钉死（`codemode-tree` / `web-search-tree` 踩过同一个坑）。
 */
function createCachedComponent(render: (width: number) => string[], cacheKey: () => string, invalidateInner?: () => void) {
	let cachedWidth: number | undefined;
	let cachedKey: string | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const key = cacheKey();
			if (cachedLines === undefined || cachedWidth !== width || cachedKey !== key) {
				cachedWidth = width;
				cachedKey = key;
				cachedLines = render(width);
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedKey = undefined;
			cachedLines = undefined;
			invalidateInner?.();
		},
	};
}

/**
 * 给内置 MCP 渲染器套上树形外壳。
 *
 * 与 `web-search-tree` 的 `withTreeShell` 是**同一套手法**（委托内层 + 重排行），区别只在
 * 输入来源：那边来自被捕获的工具定义，这边来自解析器拿到的 `next()`。
 */
function withTreeShell(inner: { renderCall?: Function; renderResult?: Function } | undefined) {
	return {
		// 见文件头「壳」：内置渲染器不声明它，我们声明 "self" 拿掉底色与上下空行。
		renderShell: "self" as const,
		renderCall(args: unknown, theme: Theme, context: McpToolRenderContext) {
			const state = (context.state ??= {});
			// 传给内置渲染器的 `lastComponent` 必须是**它自己上次返回的那个内层组件**：
			// 内置的 renderCall 里有 `context.lastComponent ?? new Text(...)` 的复用逻辑，
			// 把我们的 wrapper（没有 setText()）传进去会抛 `TypeError`，而 pi 的
			// `updateDisplay()` 会**静默**退回 fallback —— 形状悄悄变回默认，没有任何报错
			//（web-search-tree 踩过这个坑，注释记在那里）。
			const innerComponent =
				inner?.renderCall?.(args, theme, { ...context, lastComponent: state.innerCall }) ?? EMPTY_COMPONENT;
			state.innerCall = innerComponent;
			return createCachedComponent(
				(width) => {
					// 圆点色彩读 `state.failed` 而不是 `context.isError`：MCP 有若干失败路径是**正常返回**
					// 一个带 `details.error` 的对象（不是 throw），pi 不会把它标成 isError，只看
					// `context.isError` 会让那些路径永远显示绿点。`state.failed` 由 renderResult 写入
					// —— `updateDisplay()` 先 call 后 result，但两个组件的 `render()` 都在这之后才
					// 跑，所以同一帧里读得到（与下面 `state.innerResult` 判「树接上没有」同一套时点）。
					const dot = theme.fg(stateDotSlot(context.isPartial === true, state.failed === true), "\u2022");
					const pipe = theme.fg("muted", "\u2502 ");
					const connected = state.innerResult !== undefined;
					return withCallGutter(componentLines(innerComponent, contentWidth(width)), dot, pipe, connected);
				},
				() => `${state.innerResult === undefined ? "loose" : "connected"}:${stateDotSlot(context.isPartial === true, state.failed === true)}`,
				() => innerComponent.invalidate?.(),
			);
		},
		renderResult(result: unknown, options: { expanded?: boolean }, theme: Theme, context: McpToolRenderContext) {
			const state = (context.state ??= {});
			// 失败判定必须**在这里同步算完**（不能推进下面的懒渲染闭包）：`updateDisplay()` 先跑
			// renderCall、再跑本函数，而容器渲染时两个组件的 `render()` 是**先 call 后 result** ——
			// 把判定放在下面的闭包里，renderCall 那颗圆点就会看到上一帧的（未置位的）`state.failed`，
			// 于是失败块显示绿点（web-search-tree 实测踩到）。判定读原始 result 而不是渲染后的行，
			// 所以同步算得出来，也不需要宽度。
			const failed = isFailureResult(
				context.isError === true,
				resultTextLines(result),
				(result as { details?: unknown } | undefined)?.details,
			);
			state.failed = failed;
			// 同一个 `lastComponent` 契约（见 renderCall 里的说明）。
			const innerComponent =
				inner?.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResult }) ?? EMPTY_COMPONENT;
			state.innerResult = innerComponent;
			return createCachedComponent(
				(width) => {
					// 两个 trim 都要做：
					//   头 —— 内置渲染器在标题与正文之间垫的那个 `Spacer(1)`，不削就是一根悬空的 `│`；
					//   尾 —— 展开态正文可能以空行结尾，不削就是「下面一行空行」。
					const lines = trimTrailingBlanks(trimLeadingBlanks(componentLines(innerComponent, contentWidth(width))));
					return shapeResultLines(lines, theme);
				},
				() => `result:${failed ? "err" : "ok"}:${options.expanded ? "expanded" : "collapsed"}`,
				() => innerComponent.invalidate?.(),
			);
		},
	};
}

export default function mcpTree(pi: ExtensionAPI): void {
	if (isDisabled()) return;

	const resolver = (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		if (!toolName.startsWith(MANAGED_PREFIX)) return next();
		// 拿内置 MCP 渲染器（`next()` 会依次走到内置 MCP 扩展注册的那个解析器，最后才是
		// 已注册的工具定义）。它可能是 undefined（比如内置 MCP 被别的扩展替换了）——
		// 那种情况下 withTreeShell 会退化成「只有圆点 + 树前缀」，仍然比默认壳接近目标观感。
		const base = next();
		return withTreeShell(base);
	};
	pi.registerToolRenderer(resolver);
}
