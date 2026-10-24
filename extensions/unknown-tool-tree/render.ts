/**
 * unknown-tool-tree — 纯逻辑：**没有工具定义**的工具调用块的展示形态。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入，折行由 `index.ts` 那侧做
 * （那边才拿得到真 `wrapTextWithAnsi`），所以 `node --test` 能直接跑。与
 * `tool-search-tree/render.ts`、`memory/render.ts` 同一套取舍：纯模块定形态，接线模块上色折行。
 *
 * ## 这类块从哪来（2026-10-20 实测）
 *
 * 模型偶尔会把工具名写错（把 `codemode` 写成 `codemap`）。pi 在 `prepareToolCall` 里找不到
 * 这个工具，直接返回 `{ content: [{ type: "text", text: "Tool codemap not found" }], isError: true }`
 * —— 于是这条调用**没有任何 `ToolDefinition`**，`renderCall` / `renderResult` 全是 undefined，
 * 落到 pi 的通用兜底壳：
 *
 *   - `contentText` + `Box(1, 1, bgFn)`：整块刷 `toolErrorBg`（红底）、`paddingY = 1` 给上下各
 *     一行空行；
 *   - 正文是 `formatToolExecution()` 拼的 `title\n\n{JSON args}\n\noutput` —— 参数不折叠、
 *     多行代码原样铺开。
 *
 * 用户 2026-10-20 定：这类块改用与 bash / read / codemode / mcp / tool_search 同一张列位表的
 * 树形观感 —— 无底色、无上下空行、圆点结局灯、`│ `/`└ ` 树形正文。
 *
 * ## 目标形状
 *
 * ```
 * • codemap code="async function main() { const a = await tools.read({ path: \"tests/weap…"
 *   └ Tool codemap not found
 * ```
 *
 * 展开态（`ctrl+o`）参数不再压成一行、也不折断：
 *
 * ```
 * • codemap
 *   │ code:
 *   │   async function main() {
 *   │     const a = await tools.read({ path: "tests/weapons-world-edit.spec.mjs", offset: 20, … });
 *   │     …
 *   └ Tool codemap not found
 * ```
 *
 * ## 列位（与 bash / codemode / mcp / tool-search 逐列相同）
 *
 * | 元素 | 列 | 谁占的 |
 * | --- | --- | --- |
 * | 圆点 `•` | 0 | 左边距（`MARGIN_WIDTH` = 2） |
 * | `名字` / `│` / `└` | 2 | 左边距之后 |
 * | `│ ` `└ ` 之后的正文 | 4 | gutter 再占 2 列 |
 *
 * ## 与 pi 兜底壳的两处刻意不同
 *
 *   ① **参数按行宽截断**，不按 pi 的固定 100 字符：折叠态的标题行必须**永远是单行**，
 *      `key=value` 拼出来恰好铺满一行（超宽补 `…`）。pi 那套先裁 100 字符再交给 pi-tui 折行，
 *      于是长参数会折成两三行，块的高度随参数长度漂移。
 *   ② **失败正文整段红**（`toolDiffRemoved`，与失败圆点同槽），而不是靠底色表达 —— 底色已经
 *      按用户要求去掉了，红色这一层信号总得有人扛。
 */

/** 圆点那一列：`• ` = 1 个字符 + 1 个空格 = 2 列。 */
export const MARGIN_WIDTH = 2;
/** 结构符占的列数：`│ ` / `└ ` = 1 个 box-drawing 字符 + 1 个空格 = 2 列。 */
export const GUTTER_WIDTH = 2;
/** 子内容要扣掉的列数：左边距 + 结构符（结构符落在列 2、正文落在列 4）。 */
export const CONTENT_OFFSET = MARGIN_WIDTH + GUTTER_WIDTH;

/** 结构符前面的留白（左边距）：两格，于是 `│` / `└` 落在列 2。 */
export const GUTTER_LEAD = " ".repeat(MARGIN_WIDTH);
/** `│ ` / `└ ` 之后的正文列：4 格（与 bash / codemode / mcp 块同一列）。 */
export const BODY_INDENT = " ".repeat(CONTENT_OFFSET);

/** 树前缀：`│ ` = 还有下文，`└ ` = 末行（本块按用户 2026-10-20 定挂在**末行**）。 */
export const TREE_PIPE = "│ ";
export const TREE_LAST = "└ ";

/**
 * 折叠态正文最多保留的视觉行数（展开态 `ctrl+o` 不裁）。
 *
 * 10 行：这类块正常只有一两行（`Tool X not found`），10 行足够容纳「工具名写错 + 后端报一段
 * 错误正文」的形态，又不至于把一条误调撑满屏幕。取值与 memory / tool-search 块同档。
 */
export const PREVIEW_MAX_LINES = 10;

/** 子内容（正文树）该按多宽渲染。 */
export function contentWidth(totalWidth: number): number {
	return Math.max(1, totalWidth - CONTENT_OFFSET);
}

/** 去掉 SGR 转义序列 —— 工具名与结果正文都可能夹带转义（模型输出 / server 回包）。 */
export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

/**
 * 单个字符的可见列宽 —— CJK / 全角记 2 列，与 pi-tui 的折行口径对齐的近似。
 *
 * 这里刻意不复用 pi-tui 的 `visibleWidth`：本模块要能 `node --test` 直跑（不解析包的裸说明符），
 * 而标题行的截断只需要「不比真实渲染更宽」，这个近似足够。
 */
export function charWidth(ch: string): number {
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

/** 一段纯文本的可见宽度。 */
export function visibleWidth(text: string): number {
	let width = 0;
	for (const ch of Array.from(text)) width += charWidth(ch);
	return width;
}

/**
 * 按**可见宽度**截断，末尾补 `…`（补的那个字符算在 `maxWidth` 里）。
 *
 * 先截断纯文本再上色 —— 顺序反了会把 SGR 转义算进宽度（`tool-search-tree` 踩过同一个坑）。
 */
export function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	let out = "";
	let used = 0;
	for (const ch of Array.from(text)) {
		const w = charWidth(ch);
		if (used + w > maxWidth - 1) break;
		out += ch;
		used += w;
	}
	return `${out}…`;
}

/** 参数是不是「有内容」的：`undefined` / `null` / 空对象 / 空数组都算没有。 */
function hasArgs(args: unknown): boolean {
	if (args === undefined || args === null) return false;
	if (Array.isArray(args)) return args.length > 0;
	if (typeof args === "object") return Object.keys(args as Record<string, unknown>).length > 0;
	return true;
}

/** 一个参数值压成单行：字符串走 JSON（换行变 `\n`、引号转义），其余走紧凑 JSON。 */
function inlineValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

/**
 * 折叠态的参数串：`key=value key2=value2`，压成单行并按 `maxWidth` 截断（`…`）。
 *
 * 没有参数返回空串（调用方据此不在标题后加空格）。
 */
export function formatArgsSummary(args: unknown, maxWidth: number): string {
	if (!hasArgs(args) || maxWidth <= 0) return "";
	const entries = Array.isArray(args)
		? args.map((value, index) => `${index}=${inlineValue(value)}`)
		: typeof args === "object"
			? Object.entries(args as Record<string, unknown>).map(([key, value]) => `${key}=${inlineValue(value)}`)
			: [`args=${inlineValue(args)}`];
	const joined = entries.join(" ");
	return truncateVisible(stripAnsi(joined), maxWidth);
}

/**
 * 展开态的参数行：每个 key 一行 `key:`，值缩进两格、按真实换行展开（不再压成一行）。
 *
 * 值的多行形态是本块「展开才有意义」的核心 —— `codemap` 那种把整段脚本塞进 `code` 参数的错误
 * 调用，折叠态只能看到开头一截，展开态要能读完整段。
 *
 * 这里**不做宽度截断**：折行是接线层（`index.ts`）的事（它才拿得到真 `wrapTextWithAnsi`），
 * 在这里先截一刀会把长代码行硬生生切掉尾部 —— 那正是折叠态缺的信息。
 */
export function expandedArgLines(args: unknown): string[] {
	if (!hasArgs(args)) return [];
	const entries = Array.isArray(args)
		? args.map((value, index) => [String(index), value] as const)
		: typeof args === "object"
			? Object.entries(args as Record<string, unknown>)
			: [["args", args] as const];
	const lines: string[] = [];
	for (const [key, value] of entries) {
		lines.push(`${key}:`);
		const text =
			typeof value === "string"
				? stripAnsi(value).replace(/\r/g, "")
				: (() => {
						try {
							return stripAnsi(JSON.stringify(value, null, 2) ?? String(value)).replace(/\r/g, "");
						} catch {
							return stripAnsi(String(value));
						}
					})();
		for (const line of text.split("\n")) lines.push(`  ${line}`);
	}
	return lines;
}

/**
 * 圆点该用哪个颜色槽 —— 三态，与 bash / codemode / mcp / tool-search 同语义：
 *
 *   - 执行中（`isPartial`）→ `dim`（灰）
 *   - 执行完且成功 → `toolDiffAdded`（diff 新增行的绿，**与 bash 成功圆点同槽**）
 *   - 执行完且失败 → `toolDiffRemoved`（diff 删除行的红）
 *
 * 本块绝大多数时候是红的（工具名不存在 ⇒ pi 立刻返回 isError），但绿点不是摆设：恢复会话时
 * 工具所属的扩展 / MCP server 可能还没连上，历史里那条**成功**的结果就由本渲染器画。
 */
export function stateDotSlot(isPartial: boolean, isError: boolean): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
	if (isPartial) return "dim";
	return isError ? "toolDiffRemoved" : "toolDiffAdded";
}

/**
 * 这一块是不是失败的 —— `context.isError` 就够（这类块唯一的失败来源是 pi 的
 * `prepareToolCall` 返回 `isError: true`，或工具真跑了但抛异常），不需要 mcp-tree 那套正文扫描。
 */
export function isFailed(isError: boolean): boolean {
	return isError;
}

/** 结果里的文本块拼成行数组（按块顺序，块内按换行拆）。 */
export function resultTextLines(result: unknown): string[] {
	const blocks = (result as { content?: ReadonlyArray<{ type?: string; text?: string }> } | undefined)?.content;
	if (!Array.isArray(blocks)) return [];
	return blocks
		.filter((block): block is { type: string; text: string } => !!block && block.type === "text" && typeof block.text === "string")
		.flatMap((block) => stripAnsi(block.text).replace(/\r/g, "").split("\n"));
}

/**
 * 每行的树前缀：末行 `└ `，其余 `│ `（用户 2026-10-20 选「`└` 挂末行」）。
 *
 * 「末行」指**折行 + 预览截断之后**的视觉行 —— 于是错误句（折叠态下往往同时是最后一行）正好
 * 落在拐角上；正文被裁时拐角跟着 `… (N more lines, ctrl+o to expand)` 走，树一直延伸到
 * 「还有内容可以展开」那句话（与 mcp-tree / tool-search-tree 同口径）。
 */
export function treePrefixes(lineCount: number): string[] {
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
 * 措辞与 memory / tool-search 块同族；`ctrl+o` 是 `app.tools.expand` 的默认绑定。
 */
export function previewMoreLinesHint(hidden: number): string {
	return `… (${hidden} more line${hidden === 1 ? "" : "s"}, ctrl+o to expand)`;
}
