/**
 * tool-search-tree — pi 内置 `tool_search` 工具块的树形展示（接线）
 *
 * 把内置 `tool_search` 工具块的观感改造成与 `memory/` 工具块同款（用户 2026-10-13 定）：
 * `• tool_search <query>` 圆点标题、`│ `/`└ ` 树形正文、**没有底色、没有上下边界空行**、
 * 10 行预览截断。形状规则全在 `render.ts`（不 import pi 运行时，`node --test` 直跑），
 * 本文件做两件事：捕获内置工具定义（不复制执行逻辑）、套上 self 壳渲染器。
 *
 * ## 怎么拿到 tool_search 的**执行逻辑**（不复制一份）
 *
 * `tool_search` 是 pi 的**内置扩展**（`builtin:tool-search`），包入口只导出
 * `createToolSearchExtension()`（`createToolSearchToolDefinition` 没有公开导出），所以用
 * codemode-tree / web-search-tree 同一款**捕获**：传一个只拦截 `registerTool` 的 Proxy，
 * 其余 `pi.*` 一律转发给真 API。工厂是同步的（`tool-search/index.js` 里没有 await），
 * 这里照异步调用式写 await 也无害。
 *
 * 捕获到的定义里，`execute` 闭包持有的 `options.tools` 是这个 Proxy —— 它转发
 * `getActiveTools` / `getAllTools` / `setActiveTools` 给真 `pi`，检索与激活行为与内置
 * 完全一致；`parameters` schema 与 pi 包内部是**同一个对象引用**（包入口
 * `dist/index.js` → `extensions/tool-search/` 同一条模块图，codemode-tree 2026-10-01
 * 已实测过这条引用共享成立），MCP 扩展的 `isToolSearchTool()` 靠这个引用认
 * "这是真的 tool_search"，据此做 codemode / tool_search 的自动激活 —— 丢了这个引用，
 * MCP 工具的自动激活会静默失效。
 *
 * ## 内置让位（replaceable）
 *
 * `tool-search` 是内置扩展里声明 `replaceable: true` 的那一类（与 `codemode` / `mcp` 同）：
 * 本扩展注册同名工具后，pi 把内置整个不加载，并推一条启动 warning。settings.json 里
 * `-builtin:tool-search` 把这条 warning 一起消掉（用户 2026-10-01 在 codemode 上做过的
 * 同一个决定）。**代价**：`PI_TOOL_SEARCH_TREE=off` 从「回退到内置观感」变成「只是关闭」
 * —— settings 已禁用内置，off 时 tool_search 工具会整个消失；想恢复内置观感得把
 * settings 里那条删掉。
 *
 * ## 壳与渲染（没有可委托的内置渲染器）
 *
 * 与 codemode-tree / web-search-tree「委托包渲染器 + 重排行」不同，内置 tool_search
 * **没有渲染器**（走 pi 通用默认壳），所以渲染侧走 memory 的 `memoryToolRenderers` 同款
 * 自绘：`renderShell: "self"`（无 `Box(1,1,bgFn)` 底色、无 paddingY 空行）、标题行圆点
 * 顶格、正文 2 列缩进 + `│ `/`└ `（muted）、10 行预览截断。失败路径只有 execute 抛异常
 * （参数非法），读 `context.isError` 就够，不需要 web-search-tree 那套正文扫描。
 *
 * `PI_TOOL_SEARCH_TREE=off` 关闭（注册期读一次，与 `PI_CODEMODE_TREE` 同一约定）。
 */

import { createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
	BODY_INDENT,
	GUTTER_WIDTH,
	PREVIEW_MAX_LINES,
	classifyToolSearchOutcome,
	previewMoreLinesHint,
	toolSearchLimitSuffix,
	toolSearchQueryText,
	toolSearchResultToolLineLength,
	toolSearchResultTreePrefixes,
	toolSearchTitleLine,
	toolSearchTitleParts,
	type ToolSearchOutcome,
} from "./render.ts";

/** pi 传给 renderCall / renderResult 的渲染上下文（跨帧同一个 state 对象）。 */
interface ToolSearchRenderContext {
	state?: { outcome?: ToolSearchOutcome };
	isPartial: boolean;
	isError: boolean;
}

/** 结果块里的文本正文（tool_search 只产 text block）。 */
interface ToolSearchResultLike {
	content?: ReadonlyArray<{ type?: string; text?: string }>;
}

/** 把结果里的所有 text 块拼成行数组（按块顺序，块内按换行拆）。 */
function resultLines(result: ToolSearchResultLike | undefined): string[] {
	const blocks = Array.isArray(result?.content) ? result!.content : [];
	return blocks
		.filter((block): block is { type: string; text: string } => !!block && block.type === "text" && typeof block.text === "string")
		.flatMap((block) => block.text.split("\n"));
}

/**
 * 内置 tool_search 定义没有任何渲染器，这里套上 memory 同款的自绘 self 壳。
 * 形状决定全在 render.ts，这里只负责上色与折行。
 */
function withTreeShell(target: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
	return {
		// 展开而不是逐字段抄：`execute` / `parameters` / `description` / `promptSnippet` /
		// `exposure` / `defaultActive` 全部原样继承（prompt 元数据不会自动继承，必须显式带上）。
		...target,
		renderShell: "self",
		renderCall(args: unknown, theme: Theme, context: ToolSearchRenderContext) {
			const state = context.state;
			// state.outcome 由 renderResult 写入（updateDisplay 先跑 renderCall、再跑 renderResult，
			// 但两个组件的 render() 都在那之后 —— 同一帧读得到）。兜底：结果没到过时按
			// isPartial / isError 判。
			return {
				render(width: number): string[] {
					const outcome: ToolSearchOutcome =
						state?.outcome ?? (context.isPartial ? "pending" : context.isError ? "error" : "success");
					const parts = toolSearchTitleParts(outcome);
					const dot = theme.fg(parts.dotSlot, "\u2022");
					const line = toolSearchTitleLine(args, Math.max(1, width || 80), dot, theme);
					// 标题已在文本层截断成单行，这里折行只是保险（超宽行的最后一道防线）
					return wrapTextWithAnsi(line, Math.max(1, width || 80));
				},
				invalidate() {},
			};
		},
		renderResult(result: ToolSearchResultLike, options: { expanded?: boolean }, theme: Theme, context: ToolSearchRenderContext) {
			// isError 必须从 **context** 读：pi 传给 resultRenderer 的对象不带 isError 字段
			//（它只在 getRenderContext() 里）。分类必须**同步**写进 state —— renderCall 那颗
			// 圆点在容器渲染时才真正 render，晚一步就会显示上一帧的颜色（memory 踩过）。
			const outcome = classifyToolSearchOutcome(context.isError === true);
			if (context.state) context.state.outcome = outcome;
			const sourceLines = resultLines(result);
			const expanded = options?.expanded === true;
			// 结果是静态的，按 width 缓存排版（每次 renderResult 调用新建，expanded 已在闭包里）
			const cache = new Map<number, string[]>();
			return {
				render(width: number): string[] {
					const key = Math.max(1, width || 80);
					const hit = cache.get(key);
					if (hit !== undefined) return hit;
					const bodyWidth = Math.max(1, key - BODY_INDENT.length - GUTTER_WIDTH);
					const rows: string[] = [];
					// 每视觉行对应可着色的前缀段长（0 = 整行走 text）：只有源行折出的**首块**
					// 能拿到工具条目前缀（续行不可能是 `- name:` 开头，见 render.ts）。
					const rowKeyLengths: number[] = [];
					for (const line of sourceLines) {
						// 空行也占一行（wrapTextWithAnsi("") → [""]）：段落间距是可读性的一部分
						const wrapped = wrapTextWithAnsi(line, bodyWidth);
						const keyLength = toolSearchResultToolLineLength(line);
						wrapped.forEach((fragment, fragmentIndex) => {
							rows.push(fragment);
							// 窄终端下折行可能把工具名本身切开，只有切点落在首块内才能安全 slice
							const paintable = fragmentIndex === 0 && keyLength > 0 && keyLength <= fragment.length;
							rowKeyLengths.push(paintable ? keyLength : 0);
						});
					}
					if (rows.every((row) => row.trim() === "")) {
						cache.set(key, []);
						return [];
					}
					// 预览截断：非展开态裁到 PREVIEW_MAX_LINES 行，提示行挂在被裁正文的末尾。
					// 展开态（ctrl+o）不裁。截断按折行后的视觉行数算（与树前缀同口径）。
					let visible = rows;
					let hidden = 0;
					if (!expanded && rows.length > PREVIEW_MAX_LINES) {
						visible = rows.slice(0, PREVIEW_MAX_LINES);
						hidden = rows.length - visible.length;
					}
					// 前缀按**折行 + 截断之后**的视觉行数算：折行碎片与截断提示行各算独立行，
					// 否则一个折成三行的长句会在第一片就画上 `└`，看着像树提前结束了。
					const lineCount = visible.length + (hidden > 0 ? 1 : 0);
					const prefixes = toolSearchResultTreePrefixes(lineCount);
					const lines = visible.map(
						(row, index) =>
							BODY_INDENT +
							theme.fg("dim", prefixes[index] ?? "\u2502 ") +
							// 工具名（含 `- ` 与冒号）走 syntaxKeyword、描述留 text —— 与 memory_read
							// 元信息头的 `name:` 同一支笔，两段各自成一段 SGR。
							((rowKeyLengths[index] ?? 0) > 0
								? theme.fg("syntaxKeyword", row.slice(0, rowKeyLengths[index]!)) +
									theme.fg("text", row.slice(rowKeyLengths[index]!))
								: theme.fg("text", row)),
					);
					if (hidden > 0) {
						lines.push(
							BODY_INDENT +
								theme.fg("dim", prefixes[visible.length] ?? "\u2502 ") +
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

/** 只拦截 `registerTool` 的 Proxy：其余 `pi.*` 一律转发给真 API（见文件头）。 */
function captureToolSearchDefinition(pi: ExtensionAPI): ToolDefinition<any, any, any> {
	let captured: ToolDefinition<any, any, any> | undefined;
	const capture = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition<any, any, any>) => {
					captured = definition;
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	// 与 pi 内置加载它一样的调用方式（工厂本身无参数）
	createToolSearchExtension()(capture as ExtensionAPI);
	if (!captured) {
		throw new Error("tool-search-tree: 没能从 createToolSearchExtension() 捕获到 tool_search 工具定义");
	}
	return captured;
}

export default function toolSearchTree(pi: ExtensionAPI): void {
	if (process.env.PI_TOOL_SEARCH_TREE?.trim().toLowerCase() === "off") return;
	pi.registerTool(withTreeShell(captureToolSearchDefinition(pi)));
}
