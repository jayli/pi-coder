/**
 * mcp-tree — 纯逻辑：把**任意 MCP 工具块**的行数组重排成与 `bash-command-collapse.ts` /
 * `memory/` / `tool-search-tree/` 同一套的树。
 *
 * 本模块不 import pi、不碰 pi-tui，所以 `node --test` 能直跑（与 `web-search-tree/render.ts`、
 * `codemode-tree/render.ts` 同一条路子）。着色只用注入进来的 `theme.fg`。
 *
 * ## 目标形状（用户 2026-10-16 定）
 *
 * ```
 * • knowledge-bot/search_knowledge query="版本进展" limit=8
 *   │ {
 *   │   "results": [
 *   │     {
 *   │       "repo": "example-workspace",
 *   └ ... (210 more lines, 215 total, ctrl+o to expand)
 * ```
 *
 * 四件事：① 无底色、无上下空行（`renderShell: "self"`，接线侧做）；② 标题行前置圆点 `•`，
 * 颜色就是结局灯（三态）；③ 正文行挂 `│ `/`└ ` 树形前缀；④ 加粗保留在工具名上（内置
 * `formatToolCallWithArgs` 画的 `toolTitle` + bold，不要动它）。
 *
 * ## 与 bash / codemode 块的一处刻意不同：`└ ` 挂在**末行**
 *
 * 与 `web-search-tree/` 同一条理由：折叠态的末行是 `... (N more lines, ctrl+o to expand)`
 * —— 那是**唯一**通向完整结果（你那个例子里的 210 行）的入口。把 `└ ` 挂在第一个内容行、
 * 让提示行缩进跟在后头，观感上像「树已经结束，下面是尾巴」；挂在末行，树就一直延伸到
 * 「还有内容可以展开」那句话。展开态下末行是最后一条正文，同样成立。
 *
 * ## 圆点三态
 *
 *   - 执行中（`isPartial`）→ `dim`（灰）
 *   - 执行完且成功 → `toolDiffAdded`（diff 新增行的绿，**与 bash 成功圆点同槽**）
 *   - 执行完且失败 → `toolDiffRemoved`（diff 删除行的红）
 *
 * 与 `web-search-tree` 的 `stateDotSlot` 同值同语义 —— MCP 也有「正常返回但带 `details.error`」
 * 的失败路径（见 `isFailureResult`）。
 */

/** 圆点那一列：`• ` = 1 个字符 + 1 个空格 = 2 列。 */
export const MARGIN_WIDTH = 2;
/** 结构符占的列数：`│ ` / `└ ` = 1 个 box-drawing 字符 + 1 个空格 = 2 列。 */
export const GUTTER_WIDTH = 2;
/** 子内容要扣掉的列数：左边距 + 结构符（结构符落在列 2、正文落在列 4）。 */
export const CONTENT_OFFSET = MARGIN_WIDTH + GUTTER_WIDTH;

/** 结构符前面的留白（左边距）：两格。`│` / `└` 因此落在列 2。 */
export const GUTTER_LEAD = " ".repeat(MARGIN_WIDTH);
/** `│ ` / `└ ` 之后的正文列：4 格（与 bash / codemode / memory 块同一列）。 */
export const BODY_INDENT = " ".repeat(CONTENT_OFFSET);
/** 「结果还没到」时正文的缩进：两格（与标题行第一个字符同列）。 */
export const LOOSE_INDENT = " ".repeat(MARGIN_WIDTH);

/**
 * 折叠态正文最多渲染的**视觉行**数 —— 与**内置 MCP 渲染器**同值（`tools.js` 里
 * `OUTPUT_PREVIEW_LINES = 5`，用户 2026-10-16 选它而不是 memory 的 10）。
 *
 * 为什么与 memory 不同也说得通：MCP 结果常常是一整行 JSON（缩进换行后视觉行很长），5 行
 * 已经能看出结构；memory 的正文是散文，10 行更合适。
 */
export const PREVIEW_MAX_LINES = 5;

/** 子组件（内置渲染器渲染出来的那一坨）该按多宽渲染。 */
export function contentWidth(totalWidth: number): number {
	return Math.max(1, totalWidth - CONTENT_OFFSET);
}

/** 去掉 SGR 转义序列 —— 行里可能只有颜色序列。 */
function stripSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 这一行（带样式）是不是空的。 */
export function isBlankLine(line: string): boolean {
	return stripSgr(line).trim() === "";
}

/**
 * 圆点该用哪个颜色槽 —— 三态，与 `web-search-tree` / `codemode-tree` / bash 侧同一份语义。
 */
export function stateDotSlot(isPartial: boolean, isError: boolean): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
	if (isPartial) return "dim";
	return isError ? "toolDiffRemoved" : "toolDiffAdded";
}

/**
 * 这一块是不是失败的 —— 三个信号取**或**，与 `web-search-tree` 同一套（MCP 的失败痕迹分三种）：
 *
 *   ① `context.isError`：pi 的权威信号（工具抛异常 / 结果带 `isError: true`）；
 *      内置 MCP 的 `convertMcpResult` 会把 server 的 `result.isError` 透传成 `isError: true`；
 *   ② `details.error` 非空：结构化痕迹；
 *   ③ 正文里的 `Error:` / `Error：` 行：MCP server 常有「正常返回一段以 Error: 开头的文本」
 *      的路径（不是 throw），pi 不会把它标成 isError。
 *
 * 只用 ① 会让 ③ 那些路径显示绿点；只用 ②③ 又会漏掉抛异常的路径。
 */
export function isFailureResult(isError: boolean, lines: string[], details: unknown): boolean {
	if (isError) return true;
	const d = details as { error?: unknown } | undefined;
	if (d && typeof d.error === "string" && d.error.trim() !== "") return true;
	return lines.some((line) => /^\s*Error[:：]/.test(stripSgr(line)));
}

/** 正文里的 `Error:` 行染红（`toolDiffRemoved`），与 `web-search-tree` 同槽同法。 */
export function colorizeErrorLines(
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	return lines.map((line) => (/^\s*Error[:：]/.test(stripSgr(line)) ? theme.fg("toolDiffRemoved", stripSgr(line)) : line));
}

/**
 * 标题行 —— 内置 `renderCall` 画的 `label + key=value` 参数串，前面加一颗圆点。
 *
 * 参数串**原样保留**（用户 2026-10-16 定）：内置的 `formatToolCallWithArgs` 已经处理好
 * 折叠态 `key=value` / 展开态逐行 `key: value`、100 字符截断、工具名的 bold + `toolTitle` 色，
 * 本扩展只负责在最前面加 `• `。所以这里**只处理首行**，其余行（展开态的每个参数一行）挂结构符。
 */
export function withCallGutter(lines: string[], dotAnsi: string, pipe: string, connected: boolean): string[] {
	const continuation = connected ? `${GUTTER_LEAD}${pipe}` : LOOSE_INDENT;
	return lines.map((line, index) => {
		if (index === 0) return `${dotAnsi} ${line}`;
		// 空行保持空行：给空行补空格会把「这一行是空的」这个信息擦掉（外层判空还得先剔 ANSI）。
		return line === "" ? "" : `${continuation}${line}`;
	});
}

/**
 * 结果侧：末行 `└ `、其余非空行 `│ `（见文件头「`└ ` 挂在末行」）。
 *
 * 三个不能想当然的点：
 *
 *   ① **只由本函数决定 `└ `，整块渲染一次**：调用方必须把所有 child 的行拼成一个数组再传进来
 *      （内置渲染器把正文与提示行分成两个 child），逐 child 各画一棵树会长出两个拐角符。
 *   ② **末行是空行时往前找**：展开态的正文可能以空行收尾，把 `└ ` 挂到一个空行上等于白挂
 *      —— 找不到任何非空行就整个返回空数组。
 *   ③ **`└ ` 之上的空行挂 `│ `、之下的空行原样**：与 bash / `web-search-tree` 同一条规则
 *      （空行不加前缀会看着像树断了；`└ ` 之后再画竖线又像树还没完）。
 */
export function shapeResultLines(
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	if (lines.length === 0) return [];

	// 从后往前找最后一个非空行 —— 它就是 `└ ` 的落点。
	let last = lines.length - 1;
	while (last >= 0 && isBlankLine(lines[last]!)) last--;
	if (last < 0) return [];

	const pipe = `${GUTTER_LEAD}${theme.fg("muted", "\u2502 ")}`;
	const corner = `${GUTTER_LEAD}${theme.fg("muted", "\u2514 ")}`;

	return lines.map((line, index) => {
		if (index === last) return `${corner}${line}`;
		if (index > last) return line;
		if (isBlankLine(line)) return pipe;
		return `${pipe}${line}`;
	});
}

/**
 * 去掉**尾部**的空行。内置 MCP 渲染器的折叠态以提示行收尾（不含空行），但展开态正文可能
 * 以空行结尾 —— 那些空行正是「下面一行空行」观感的来源。
 *
 * **上面的空行不删**：内置渲染器在正文与提示行之间没有空行，但正文自身的分段空行是结构的
 * 一部分（JSON 缩进块的闭合行之间就有），删了会让树里出现 `│ │` 相邻的怪观感。
 */
export function trimTrailingBlanks(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && isBlankLine(lines[end - 1]!)) end--;
	return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * 去掉**开头**的空行 —— 内置 MCP 渲染器的 `renderResult` 第一个动作是
 * `component.addChild(new Spacer(1))`（在标题与正文之间垫一行），在树形态下这一行会变成
 * 一根**悬空的 `│`**：
 *
 * ```
 * • knowledge_bot/search_knowledge query="…" limit=8
 *   │            ← 这一行是那个 Spacer
 *   │ {          ← 正文其实从这里才开始
 * ```
 *
 * 目标形态（用户 2026-10-16 参照的 memory 块）标题下面直接就是正文，没有这根悬空竖线，
 * 所以这里把开头的空行削掉。**中间的空行不碰** —— 那是正文自己的结构（JSON 缩进块）。
 *
 * 与 `trimTrailingBlanks` 拆成两个函数而不是一个「削两端」：两者的**理由完全不同**
 * （一个来自内置渲染器的尾部空行、一个来自它的前导 Spacer），将来只改一侧时能看懂为什么。
 */
export function trimLeadingBlanks(lines: string[]): string[] {
	let start = 0;
	while (start < lines.length && isBlankLine(lines[start]!)) start++;
	return start === 0 ? lines : lines.slice(start);
}
