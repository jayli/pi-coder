/**
 * logo.ts — 启动 logo 的字形（静态）+ header 的行序与标题行格式化
 *
 * 字形是 `curl -fsSL https://pi.dev/install.sh | sh` 顶部那只 π 印记，取自
 * `npm:pi-claude-code-tui@0.1.14`（它自己也是照抄安装脚本）。上游把它做成 22 帧动画，
 * 本仓库只要一只静态 logo，所以这里**只留落定态那一格的形状**，帧表、笔画推进、底座闪动
 * 全部去掉。
 *
 * 形状用 4×4 的布尔格（一格 = 三个 `█`，实心 / 空格），比上游那张「1 基坐标 + 逐帧取色」
 * 的表好读也好测。
 *
 * **刻意补了上游漏掉的一格**：上游落定帧（phase 6）的格子表是
 * `3,2 3,3 3,4 4,2 4,4 5,2 5,3 6,2 6,5`，而它前几帧（phase 4/5 以及白闪帧）都带 `(5,5)`。
 * 少了这格，右腿会断成「悬空的一只脚」，静态显示时特别明显（动画里一闪而过没人注意），
 * 显然是上游那张表的笔误。这里按 `(5,5)` 在场的那版形状画。
 *
 * 本文件不 import pi / pi-tui：颜色由 `index.ts` 用 `theme.fg("accent", …)` 现取，
 * 所以 `/theme` 换肤能跟随；也让 `node --test clients/pi/extensions/startup-logo/*.test.ts` 能直接跑。
 */

/** 一格 = 三个块字符。 */
export const MARK_CELL = "███";

/** 空格占位（与 `MARK_CELL` 等宽，保证每行可见宽度一致，侧栏才对得齐）。 */
export const MARK_BLANK = " ".repeat(MARK_CELL.length);

/**
 * header 的统一左侧留白：**每一行**前面一个空格（印记行、提示行、说明行共用同一个常量）。
 *
 * 顶格贴着终端最左边看着太挤，统一缩进一格；`composeHeaderLines` 拿它缩提示行与说明行，
 * 印记行则由 `markLines` 自己带上（这一格算进 `MARK_WIDTH`，侧栏列与窄终端判定都跟着走）。
 * 两处**必须是同一格**，否则印记与文字会错开一列。
 */
export const MARK_INDENT = " ";

/** 4×4 布尔格，1 = 实心。行序自上而下，列序自左而右。 */
const MARK_GRID: readonly (readonly (0 | 1)[])[] = [
	[1, 1, 1, 0],
	[1, 0, 1, 0],
	[1, 1, 0, 1],
	[1, 0, 0, 1],
];

/** 印记高度（行）。 */
export const MARK_ROWS = MARK_GRID.length;

/** 印记本体宽度（列）× 每格字符数 = 12。 */
export const MARK_COLS = MARK_GRID[0]!.length;
export const MARK_GLYPH_WIDTH = MARK_COLS * MARK_CELL.length;

/** 每行可见宽度（含左侧留白）= 13。 */
export const MARK_WIDTH = MARK_INDENT.length + MARK_GLYPH_WIDTH;

/** 单格查询（越界当作空格），给单测和调试用。 */
export function markCellFilled(row: number, col: number): boolean {
	return MARK_GRID[row]?.[col] === 1;
}

/**
 * 印记行的画笔：收「这一格实不实心」，返回**可见宽度为 3** 的字符串。
 *
 * 刻意做成逐格而不是「整行交给一个 paint」：整行包色会把行尾那几个占位空格也吃进色块里，
 * 于是「每行可见宽度 == MARK_WIDTH」这个不变量在带色版本上就不成立了（侧栏列会歪）。
 *
 * 默认画笔返回未着色的 `███` / 空格，方便单测。
 */
export type MarkCellPainter = (filled: boolean) => string;

export function markLines(paintCell: MarkCellPainter = (filled) => (filled ? MARK_CELL : MARK_BLANK)): string[] {
	return MARK_GRID.map((row) => MARK_INDENT + row.map((filled) => paintCell(filled === 1)).join(""));
}

/**
 * 把侧栏文字（已着色）贴到印记右侧，**垂直居中**（2 条落在第 1、2 行）。
 *
 * 前提：传进来的行**可见宽度已等于 `MARK_WIDTH`**（`markLines` 保证），所以直接接在行尾就
 * 对得齐，这里不按字符串长度补 —— 行里有 ANSI 时按长度补一定歪。左侧留白（`MARK_INDENT`）
 * 已经算在 `MARK_WIDTH` 里，所以侧栏列也跟着右移一格，不需要在这里额外处理。
 *
 * **不裁行尾占位空格**：它们是「每行 `MARK_WIDTH` 列」这个不变量的一部分。上游那种整行包色的写法
 * 在这里也不成立（行尾是 ANSI 重置符而不是空白，`trimEnd` 会静默变成空操作），所以统一不裁，
 * 让行为与调用方怎么上色无关。这些空格没有底色，终端里不可见，pi 也照样按宽度截断。
 */
export function attachSideText(lines: readonly string[], side: readonly string[], gap = 2): string[] {
	if (lines.length === 0) return [];
	const start = Math.max(0, Math.floor((lines.length - side.length) / 2));
	return lines.map((line, i) => {
		const text = side[i - start];
		return i >= start && text ? `${line}${" ".repeat(gap)}${text}` : line;
	});
}

export interface HeaderSections {
	/** 已着色的 logo 行（含侧栏文字）。 */
	logo: readonly string[];
	/** 已着色的快捷键提示行（内置 header 那一行紧凑版）。 */
	hints?: string;
	/** 已着色的说明行。 */
	onboarding?: string;
}

/**
 * 完整 header 行序：logo → 空行 → 提示 → 空行 → 说明。
 * 缺某段就不留多余空行（窄终端回退时 logo 段为空）。
 *
 * 提示行与说明行在这里补上 `MARK_INDENT` —— header 的每一行都不顶格，且与印记左边对齐；
 * logo 段自己已经带缩进，所以不重复补。空行保持空行。
 */
export function composeHeaderLines(sections: HeaderSections): string[] {
	const lines = [...sections.logo];
	if (sections.hints) {
		if (lines.length > 0) lines.push("");
		lines.push(MARK_INDENT + sections.hints);
	}
	if (sections.onboarding) {
		if (lines.length > 0) lines.push("");
		lines.push(MARK_INDENT + sections.onboarding);
	}
	return lines;
}

/** header 里上色用的最小主题接口（`index.ts` 的 `theme` 直接赋值进来）。 */
export interface HeaderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * header 的标题行：`pi v0.99.2 (deepseek-flash-qd with max effort)`。
 *
 * 版本号后面直接跟当前模型与推理档位（用户 2026-10-01 定：版本信息后面要显示模型）。
 * 模型 id 或档位读不到时只省掉缺的那截 —— 整个括号都不显示（`model` 缺失），或退成
 * `(model)`（档位缺失，例如非推理模型 / 旧 ctx）。`version` 由 `index.ts` 从 pi 的
 * `VERSION` 传进来，本文件依旧不 import pi。
 */
export function formatTitleLine(
	theme: HeaderTheme,
	version: string,
	model: string | undefined,
	level: string | undefined,
): string {
	const title = `${theme.bold(theme.fg("accent", "pi"))} ${theme.fg("dim", `v${version}`)}`;
	if (!model) return title;
	const effort = level ? `${theme.fg("dim", " with ")}${theme.fg("syntaxFunction", level)}${theme.fg("dim", " effort")}` : "";
	return `${title} ${theme.fg("dim", "(")}${theme.fg("accent", model)}${effort}${theme.fg("dim", ")")}`;
}

/** 绝对路径缩短：家目录内显示成 `~/...`。 */
export function shortenPath(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}
