/**
 * codemode-tree — 纯逻辑：把 pi 内置 codemode 渲染器产出的**行数组**重排成一棵树。
 *
 * 本模块不 import pi、不碰 pi-tui，所以 `node --test` 能直跑（与 `fenceless-code-block/render.ts`、
 * `user-message-bar/bar.ts` 同一条路子）。着色只用到注入进来的 `theme.fg`。
 *
 * ## 目标形状（用户 2026-10-01 定，与 `bash-command-collapse.ts` 的树同构）
 *
 * ```
 * • codemode
 *   │ const PI_PKG = "…";
 *   │ const cmds = [
 *   │ … (8 more lines, ctrl+o to expand)
 *   │
 *   └ ✓ bash {"command":"grep -n …"} 158ms
 *     ✓ bash {"command":"grep -rn …"} 382ms
 *
 *     $ grep -n "can explain its own features"
 *     … (36 more lines, ctrl+o to expand)
 * ```
 *
 * 圆点三态（用户 2026-10-01 定）：执行中白（`text`）/ 成功绿（`toolDiffAdded`，与 bash 同色）/ 失败红
 *（`toolDiffRemoved`）—— 见 `stateDotSlot`。
 *
 * ## 列位（实测钉过，必须与 bash / read 块逐列对齐）
 *
 * | 元素 | 列 | 谁占的 |
 * | --- | --- | --- |
 * | 圆点 `•` | 0 | 左边距（`MARGIN_WIDTH` = 2） |
 * | `codemode` / `│` / `└` | 2 | 左边距之后 |
 * | `│ ` `└ ` 之后的正文 | 4 | gutter 再占 2 列 |
 *
 * 于是**所有子内容都按 `width - 4` 渲染**（`CONTENT_OFFSET`）—— 命令侧也一样，虽然它在
 * 「还没出结果」时只挂 2 列缩进（那两列刻意空着）：预算按最宽的前缀算，折行宽度才不会在
 * 结果到达的那一刻跳变（bash 侧踩过同款「提前折行 / 折行跳变」，见其文件头）。
 *
 * ## 为什么是「后处理行数组」而不是「自己解析 result」
 *
 * 结果里的嵌套调用清单（`✓ bash {…} 158ms`）、成本汇总行、输出预览与截断提示全是内置
 * 渲染器画的，而 `getTextOutput` 没有从包根导出 —— 自己解析 `result.content` 等于复刻
 * 一遍内置逻辑，pi 升级时会静默漂移。所以入口（`index.ts`）把内置的两个渲染器
 * **委托执行一次**拿到渲染好的行，再用本模块重排：形状由我们定，行的内容始终跟着 pi 走。
 */

/** 圆点那一列：`• ` = 1 个字符 + 1 个空格 = 2 列。 */
export const MARGIN_WIDTH = 2;
/** 结构符占的列数：`│ ` / `└ ` = 1 个 box-drawing 字符 + 1 个空格 = 2 列。 */
export const GUTTER_WIDTH = 2;
/** 子内容要扣掉的列数：左边距 + 结构符（结构符落在列 2、正文落在列 4）。 */
export const CONTENT_OFFSET = MARGIN_WIDTH + GUTTER_WIDTH;

/** 结构符前面的留白（左边距）：两格。`│` / `└` 因此落在列 2。 */
export const GUTTER_LEAD = " ".repeat(MARGIN_WIDTH);
/** `│ ` / `└ ` 之后的正文列：4 格（与 bash 块同一列）。 */
export const BODY_INDENT = " ".repeat(CONTENT_OFFSET);
/** 「还没出结果」时命令续行的缩进：两格（与 `codemode` 的 `c` 同列）。 */
export const LOOSE_INDENT = " ".repeat(MARGIN_WIDTH);

/** 子组件（pi 内置渲染器渲染出来的那一坨）该按多宽渲染。 */
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
 * 圆点该用哪个颜色槽（用户 2026-10-01 定）—— 三态：
 *
 *   - 执行中（`isPartial`）→ `text`（普通前景色 / 白，用户明确要的，**与 bash 的 `dim` 不同**）
 *   - 执行完且成功 → `toolDiffAdded`（diff 新增行的绿，**与 bash 成功圆点同色**）
 *   - 执行完且失败（脚本 `isError`）→ `toolDiffRemoved`（diff 删除行的红）
 *
 * 中间那个绿槽是 `toolDiffAdded` 而**不是** `success`：bash / read 两颗绿圆点用的都是
 * `toolDiffAdded`，拿 `success` 会在有的皮肤里与它们不同色（两者恰好同值时看不出，换皮就露）。
 *
 * 判定读 `context.isError`（pi 调 resultRenderer 时不带 `isError` 字段，只在 getRenderContext
 * 里给 —— 读 `result.isError` 会永远拿到 undefined）。
 */
export function stateDotSlot(isPartial: boolean, isError: boolean): "text" | "toolDiffAdded" | "toolDiffRemoved" {
	if (isPartial) return "text";
	return isError ? "toolDiffRemoved" : "toolDiffAdded";
}

/**
 * 截断提示行 —— 内置渲染器里所有「还有 N 条没显示，按 ctrl+o 展开」的写法，本函数必须全部认得。
 *
 * 两种省略号都要认：`...` 是 pi `truncateToWidth` 的写法、`…` 是 pi 预览组件自己的。
 *
 * 名词有**两种**，实测都出现过（少认一种就会把 `└ ` 错挂到提示行上，用户 2026-10-01 在大例子里看出来）：
 *   - `lines` —— 代码预览（`… (N more lines, …)`，`expandHint(theme, n, "lines")`）与输出预览
 *     （`... (N earlier lines, …)`，bash 侧也有同款）
 *   - `calls` —— **嵌套调用清单**的折叠提示（`... (N earlier calls, …)`，只出现在 codemode）
 *
 * 所以骨架是「`(数字 [词] <lines|calls>`」——中间那格词可有可无（`(2 earlier calls)` / `(5 lines)`
 * 都出现过），不能写死 `earlier`/`more`。它是**结构提示行**：该挂 `│ ` 而不是吃掉 `└ `。
 */
export function isExpandHintLine(line: string): boolean {
	return /^\s*(?:\.\.\.|…)\s*\(\d+\s+(?:\S+\s+)?(?:lines?|calls?)\b/.test(stripSgr(line));
}

/**
 * 命令侧：给每一行挂上树形前缀 —— 首行 `• `（圆点由调用方上好色），其余行按 `connected`
 * 选 `│ `（结果已到，树接上了）或两格缩进（还在跑，与 bash 的「执行中」形态一致）。
 *
 * 空行保持空行：给空行补空格会把「这一行是空的」这个信息擦掉，外层判空还得先剔 ANSI 再 trim。
 */
export function withCallGutter(lines: string[], dotAnsi: string, pipe: string, connected: boolean): string[] {
	const continuation = connected ? `${GUTTER_LEAD}${pipe}` : LOOSE_INDENT;
	return lines.map((line, index) => {
		if (index === 0) return `${dotAnsi} ${line}`;
		return line === "" ? "" : `${continuation}${line}`;
	});
}

/**
 * 结果侧：把整块结果的行数组画成树 —— **第一个实质内容行**挂 `└ `，它**上面**的行
 * （分隔空行、截断提示）挂 `│ `，它**下面**的每一行都走四格缩进（树在那里就落地了）。
 *
 * 与 bash 的 `prefixTreeLines` 同一套规则，四个不能想当然的点：
 *
 *   ① **整块只出现一次 `└ `**：调用方必须先把所有 child 的行拼成一个数组再交给本函数
 *      （内置渲染器把嵌套调用清单和 `Text("\n" + 输出)` 分成两个 child），逐 child 各画
 *      一棵树会长出两个拐角符。
 *   ② **提示行挂 `│ ` 而不是吃 `└ `**：`… (35 lines, ctrl+o to expand)` 是「下文还有」的
 *      标记，`└ ` 要留给真正的正文第一行，否则整块全是提示、看不到内容。
 *   ③ **`└ ` 之上的空行要带 `│ `、之下不补**：上面的空行是内置渲染器 `Spacer(1)` 画的
 *      分隔行（命令与结果之间那一格，用户样例里就是一根 `│`），光秃秃地空着会把树断开；
 *      下面的空行已在树落地之后，再画竖线反而像树还没完。
 *   ④ **前导空行照样带 `│ `**：`inner.render()` 的第一行就是那个 `Spacer(1)` 的空行 ——
 *      它是**结果这一截的开头**，不是整块的上边界（整块的上边界由 pi 的 self shell 给，
 *      见 `index.ts` 的说明）。
 *
 * 只有提示行、没有实质内容（脚本没输出也没有嵌套调用）时，提示行挂 `│ ` 保留下来 ——
 * 整块丢掉会把「还有内容可以展开」这个唯一的线索也一起扔掉。
 */
export function shapeResultLines(lines: string[], theme: { fg: (color: string, text: string) => string }): string[] {
	if (lines.length === 0) return [];

	// 第一个实质内容行（跳过空行与提示行）
	let start = 0;
	while (start < lines.length && (isBlankLine(lines[start]!) || isExpandHintLine(lines[start]!))) start++;

	const pipe = `${GUTTER_LEAD}${theme.fg("muted", "│ ")}`;
	const corner = `${GUTTER_LEAD}${theme.fg("muted", "└ ")}`;

	// 只有提示行、没有实质内容：整段挂 `│ `，不丢内容。
	// 但**一个提示行都没有**时（全空输入）要返回空数组 —— pi 的 `updateDisplay()` 靠
	// 「两个渲染器都没产出」来置 `hideComponent`，这里返回一行空 `│` 会让整块白占一行。
	if (start >= lines.length) {
		if (!lines.some(isExpandHintLine)) return [];
		return lines.map((line) => (isBlankLine(line) ? pipe : `${pipe}${line}`));
	}

	return lines.map((line, index) => {
		if (index === start) return `${corner}${line}`;
		if (index < start) return isBlankLine(line) ? pipe : `${pipe}${line}`;
		return isBlankLine(line) ? "" : `${BODY_INDENT}${line}`;
	});
}
