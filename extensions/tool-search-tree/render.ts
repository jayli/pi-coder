/**
 * tool-search-tree — 内置 `tool_search` 工具调用块的**展示形态**纯逻辑层。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入、折行由 index.ts 那侧做
 * （那边才拿得到真 theme 与 `wrapTextWithAnsi`），所以 `node --test` 能直接断言标题装配、
 * 结局分类、树前缀、预览截断这些**决定**。与 `memory/render.ts`、`background-tasks/render.ts`
 * 同一套取舍：纯模块定形态，接线模块上色折行。
 *
 * ## 形态（用户 2026-10-13 定：照 memory 工具块同款）
 *
 * 内置 `tool_search` 扩展没有渲染器，走 pi 默认工具壳：整块套 `toolSuccessBg` 底色、
 * `Box(1, 1)` 的 paddingY 给上下各一行空行、结果全文平铺（裁 10 行）。改成树形观感：
 *
 * ```
 * • tool_search memory 渲染
 *   │ Loaded 1 tool. They are available from your next call:
 *   │ - memory_read: Read one memory's full body by name, or list all memories when name is omitted.
 *   └ … (3 more lines, ctrl+o to expand)
 * ```
 *
 * **工具块只有圆点、不打任何标记**（`checkmark-means-task-finished-not-call-succeeded`
 * 那条记忆定的界面语言）：点的颜色就是结局灯 —— 绿 = 成功、灰 = 执行中、红 = 真错误。
 * 几何与 memory / plan / 后台任务块是**同一张表**：标题行从圆点起**顶格**，正文树前面挂
 * **2 列**缩进（`BODY_INDENT`），于是 `•` 在列 0、`│` / `└` 在列 2、正文在列 4 ——
 * `│` 正好落在 `tool_search` 首字母 `t` 正下方。结构符 `│` / `└` 走 `dim` 槽且**自成一段
 * SGR**（不让后面正文的颜色透上来），正文走 `text` 槽。
 *
 * ## 着色（用户 2026-10-18 定：照 memory 的两个已有位置）
 *
 * - **标题里的工具名**走 `toolTitle` 槽（外加加粗），与 memory 工具块标题里的
 *   `memory_write` 同一支笔 —— 调用方必须**逐字**用 `theme.fg("toolTitle", theme.bold(name))`，
 *   顺序反了 SGR 嵌套就不同，index.test.ts 拿 memory 那侧做逐字节对照会挂。
 * - **正文里每条 `- <name>: <描述>` 的工具名**（含 `- ` 与冒号，与 memory_read 元信息头
 *   的 `name:` 同一条连续前缀）走 `syntaxKeyword` 槽，描述留在 `text`。判定在
 *   `toolSearchResultToolLineLength`，调用方只对**源行的首块**上色 —— 窄终端把名字切开时
 *   放弃上色（memory 同款取舍）。
 *
 * ## 标题行带 query（用户 2026-10-13 定）
 *
 * `tool_search` 的调用参数里唯一有信息量的就是 `query`（搜的是什么），标题行照着 memory 的
 * `• memory_write` 加上它：`• tool_search <query>`；`limit` 显式给了且不是默认 8 时附
 * ` · limit=N`。query 来自模型输出，做三层清洗：剥 ANSI 转义（防污染标题配色）、折叠
 * 空白为单空格（多行 / 制表符会破坏树形块）、按**可见宽度**截断为单行（CJK 记 2 列，
 * 与 pi-tui 的折行口径一致）。
 *
 * 本模块**零包导入**（与 background-tasks/render.ts 同一条规矩）：`node --test` 直跑时解析不到
 * 包的裸说明符，而这里也没有非要从包里拿的运行时依赖 —— 默认 limit 8 写死常量，由
 * index.test.ts 对着真捕获的内置定义（schema description 里的 "Defaults to 8"）核对。
 */

/** 树前缀：`│ ` = 还有下文，`└ ` = 末行。各自 2 列（box-drawing 字符 + 空格）。 */
export const TREE_PIPE = "│ ";
export const TREE_LAST = "└ ";

/**
 * 正文树的前导缩进与树形 gutter 的几何（与 memory / plan-mode / background-tasks 同值）：
 * `•` 在列 0、`│` / `└` 在列 2、正文在列 4。
 */
export const BODY_INDENT = "  ";
export const GUTTER_WIDTH = 2;

/**
 * 非展开态下正文最多渲染的**视觉行**数（与 pi 默认壳的 `FALLBACK_PREVIEW_LINES` 同值，
 * 保持从默认壳换到 self 壳后截断行为不回归）。展开态（ctrl+o）不受此限。
 */
export const PREVIEW_MAX_LINES = 10;

/** 内置 execute 的默认 limit —— 变了的话 index.test.ts 会拿 schema description 拦下。 */
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

/** 工具名本身（标题着色与宽度预算都要用**纯文本**那份，不能拿带 SGR 的字符串去量宽）。 */
export const TOOL_SEARCH_NAME = "tool_search";

/** 一次工具调用的**展示结局**。`pending` 是「结果还没到」，不进入结果侧分类。 */
export type ToolSearchOutcome = "pending" | "success" | "error";

/** 标题行的点能用的语义槽（三套本机皮肤与 pi 内置 dark/light 都有）。 */
export type ToolSearchSlot = "dim" | "success" | "error";

/** 主题注入的最小面（与 memory / background-tasks 的 render.ts 同款）。 */
export interface ThemeLike {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * 把一次工具结果分类成展示结局。这个工具的失败只有 execute 抛异常一条路
 * （参数非法），pi 会把它标成 isError，所以读 isError 就够 —— 没有 memory 那种
 * 「正常返回但没办成」的 declined 形态。
 */
export function classifyToolSearchOutcome(isError: boolean): ToolSearchOutcome {
	return isError ? "error" : "success";
}

/** 工具块标题行该画什么：只有点的色槽（工具块**不打任何标记**）。 */
export interface ToolSearchTitleParts {
	dotSlot: ToolSearchSlot;
}

/**
 * 标题装饰：只有圆点，**不打任何标记**（与 memory / background-tasks 同一套语言）。
 * 点的颜色就是结局灯：绿 = 成功（`success`）、灰 = 执行中（`dim`）、红 = 真错误（`error`）。
 */
export function toolSearchTitleParts(outcome: ToolSearchOutcome): ToolSearchTitleParts {
	switch (outcome) {
		case "error":
			return { dotSlot: "error" };
		case "pending":
			return { dotSlot: "dim" };
		default:
			return { dotSlot: "success" };
	}
}

/** 去掉 SGR 转义序列 —— query 是模型输出，可能夹带转义。 */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

/** 宽字符（CJK / 全角等）按 2 列计的可见宽度 —— 与 pi-tui 的折行口径对齐的近似。 */
function charWidth(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	const wide =
		code >= 0x1100 &&
		(code <= 0x115f ||
			code === 0x2329 ||
			code === 0x232a ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x20000 && code <= 0x3fffd));
	return wide ? 2 : 1;
}

function visibleWidth(text: string): number {
	let width = 0;
	for (const ch of Array.from(text)) width += charWidth(ch);
	return width;
}

/**
 * 标题里的 query 文本：缺失 / 非字符串 / 空白 → 占位符 `…`（参数还没流完或模型没传），
 * 否则剥 ANSI、折叠空白为单空格。
 */
export function toolSearchQueryText(args: unknown): string {
	const raw = (args as { query?: unknown } | undefined)?.query;
	if (typeof raw !== "string") return "…";
	const cleaned = stripAnsi(raw).replace(/\s+/g, " ").trim();
	return cleaned === "" ? "…" : cleaned;
}

/** limit 尾缀：显式给了、是正整数且 ≠ 默认值才显示（` · limit=N`）。 */
export function toolSearchLimitSuffix(args: unknown): string {
	const raw = (args as { limit?: unknown } | undefined)?.limit;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return "";
	if (raw === DEFAULT_TOOL_SEARCH_LIMIT) return "";
	return ` · limit=${raw}`;
}

/**
 * 标题行：`• tool_search <query>[ · limit=N]`，单行、按可见宽度截断（超宽补 `…`）。
 *
 * `dotAnsi` 是调用方上好色的圆点（含 SGR），这里只负责拼装与截断 —— 截断发生在**文本层**，
 * 再套 SGR 就不会把转义序列算进宽度。
 */
export function toolSearchTitleLine(args: unknown, width: number, dotAnsi: string, theme: ThemeLike): string {
	// 与 memory 标题逐字同形（fg 在外、bold 在内），index.test.ts 对此做逐字节对照
	const name = theme.fg("toolTitle", theme.bold(TOOL_SEARCH_NAME));
	const query = toolSearchQueryText(args);
	const suffix = toolSearchLimitSuffix(args);
	// 宽度预算按**纯文本**工具名算：name 里带 SGR，visibleWidth 会把转义符当可见字符，
	// 每层着色多算十几列，query 就会提前截断。
	const prefixWidth = 2 + TOOL_SEARCH_NAME.length + 1; // `• ` + 工具名 + 空格
	const budget = Math.max(10, width - prefixWidth);

	let text = query + suffix;
	if (visibleWidth(text) > budget) {
		// 按可见宽度逐字截断；末尾补 …。suffix 只有几列，被截掉也不影响语义。
		let out = "";
		let used = 0;
		for (const ch of Array.from(query + suffix)) {
			const w = charWidth(ch);
			if (used + w > budget - 1) break;
			out += ch;
			used += w;
		}
		text = `${out}…`;
	}
	return `${dotAnsi} ${name} ${theme.fg("text", text)}`;
}

/**
 * 内置 execute 的正文里，一行 `- <name>: <描述>` 的**着色前缀长度**（字符数，含 `- ` 与冒号），
 * 0 表示这行不是工具条目（标题句 `Loaded N tools…`、空行、截断续行等）。
 *
 * 判定照 memory 的 `memoryMetaKeyLength`：只认行首这一种形状，且工具名不含空白与冒号
 * （`- mcp__server__tool: 描述`）—— 于是描述里再出现 `- x:` 也不会被误着色，折行碎片不是
 * 源行首也拿不到（调用方只对源行的首块用它）。
 *
 * 返回的是**字符**数而非可见宽度：调用方只拿它切字符串；工具名在现代工具集里都是 ASCII。
 */
export function toolSearchResultToolLineLength(line: string): number {
	const match = /^- ([^\s:]+):/.exec(line);
	if (!match) return 0;
	return "- ".length + match[1]!.length + 1;
}

/**
 * 每行的树前缀：末行 `└ `，其余 `│ `。
 *
 * 0 行返回空数组（调用方据此不画正文），1 行返回 `["└ "]`（只有一行时它就是末行）。
 * 传入的行数是**折行 + 预览截断之后**的视觉行数 —— 折行碎片与截断提示行各算独立行，
 * 否则一个折成三行的长句会在第一片就画上 `└`，看起来像树提前结束了。
 */
export function toolSearchResultTreePrefixes(lineCount: number): string[] {
	if (lineCount <= 0) return [];
	const prefixes: string[] = [];
	for (let index = 0; index < lineCount; index += 1) {
		prefixes.push(index === lineCount - 1 ? TREE_LAST : TREE_PIPE);
	}
	return prefixes;
}

/**
 * 预览被裁时的提示行文案（不含树前缀与缩进，由调用方挂）。`hidden` 是被裁掉的视觉行数。
 *
 * 措辞与 pi 默认壳的 `... (N more lines, ctrl+o to expand)` 同族（memory 块同款）；
 * `ctrl+o` 是 `app.tools.expand` 的默认绑定。
 */
export function previewMoreLinesHint(hidden: number): string {
	return `… (${hidden} more line${hidden === 1 ? "" : "s"}, ctrl+o to expand)`;
}
