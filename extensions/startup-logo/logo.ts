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

/**
 * 说明行的句子：`This pi harness is powered by latest @bachi/pi-coder.`
 *
 * 宽终端下尾部的 `pi-coder.` 会被 `POWERED_BY_ART` 的三行字形取代，只留下 `POWERED_BY_PREFIX`；
 * 装不下时整行退回这个句子（见 `poweredByLines`）。两句都导出，是为了让「字形块到底替掉了
 * 哪一截」在测试里可断言，而不是各处再抄一遍字符串。
 */
export const POWERED_BY_PREFIX = "This pi harness is powered by latest @bachi/";
export const POWERED_BY_SENTENCE = `${POWERED_BY_PREFIX}pi-coder.`;

/**
 * `pi-coder` 的字形块（3 行 × 22 列，用户 2026-10-06 换的稿）。
 *
 * 上一稿是方块字（`┏┓•` 那一族），这一稿换成实边（`╭─╮` / `├─╯` / `╵`）；三行**天然等宽**
 * （逐行都是 22 列），所以不需要上一稿那种行尾补空格 —— 但「三行等宽」仍是硬不变量，由测试钉住。
 * 接缝处**不补空格**：`POWERED_BY_PREFIX` 末尾的 `/` 直接顶住字形第一列，读起来就是用户
 * 给的 `@bachi/╭─╮…` 那个形状。
 *
 * 上色与句子同一档（`dim`，用户 2026-10-06 定）：字形不再走 `accent`，与顶部印记脱钩，
 * 整行就是一个颜色（见 `poweredByLines`）。这一块不参与入场动画那条对角线（动画只扫 4×4
 * 印记格），也不随会话重来，与提示行一样是静态文字。
 */
export const POWERED_BY_ART: readonly string[] = ["╭─╮╷   ╭─╴╭─╮╶┬╮╭─╴╭─╮", "├─╯│╶─╴│  │ │ ││├╴ ├┬╯", "╵  ╵   ╰─╴╰─╯╶┴╯╰─╴╵╰╴"];

/** 字形块宽度（列）。三行等宽（这一稿天然 22 列），取第一行即可 —— 等宽本身由测试钉住。 */
export const POWERED_BY_ART_WIDTH = POWERED_BY_ART[0]!.length;

/** 字形块 + 前缀的总列宽（不含 `composeHeaderLines` 补的那一格缩进）。 */
export const POWERED_BY_WIDTH = POWERED_BY_PREFIX.length + POWERED_BY_ART_WIDTH;

/** 单格查询（越界当作空格），给单测和调试用。 */
export function markCellFilled(row: number, col: number): boolean {
	return MARK_GRID[row]?.[col] === 1;
}

/**
 * 印记行的画笔：收「这一格实不实心」+ **格子的行列坐标**，返回**可见宽度为 3** 的字符串。
 *
 * 坐标入参是 2026-10-05 加入场动画时加的：动画要按**格子**算相位（对角波自右向左扫），
 * 而 `markLines` 是唯一知道行列的地方。不影响旧调用方：TS 里参数少的函数可以直接当参数多的
 * 用（`(filled) => …` 仍然是合法的 `MarkCellPainter`），所以静态路径一字未改。
 *
 * 刻意做成逐格而不是「整行交给一个 paint」：整行包色会把行尾那几个占位空格也吃进色块里，
 * 于是「每行可见宽度 == MARK_WIDTH」这个不变量在带色版本上就不成立了（侧栏列会歪）。
 *
 * 默认画笔返回未着色的 `███` / 空格，方便单测。
 */
export type MarkCellPainter = (filled: boolean, row: number, col: number) => string;

export function markLines(paintCell: MarkCellPainter = (filled) => (filled ? MARK_CELL : MARK_BLANK)): string[] {
	return MARK_GRID.map(
		(row, rowIndex) =>
			MARK_INDENT + row.map((filled, colIndex) => paintCell(filled === 1, rowIndex, colIndex)).join(""),
	);
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
/**
 * 侧栏从第几行开始贴（垂直居中）：`attachSideText` 与本扩展的逐行淡化共用这一条。
 *
 * 抽出来是因为入场动画要按**行**算淡化量（波头到达本行右端时文字跟着亮），而「文字到底贴
 * 在哪几行」的算法必须和 `attachSideText` 完全一致 —— 各写一份迟早会错开一帧。
 */
export function sideTextStartRow(lineCount: number, rowCount: number = MARK_ROWS): number {
	return Math.max(0, Math.floor((rowCount - lineCount) / 2));
}

export function attachSideText(lines: readonly string[], side: readonly string[], gap = 2): string[] {
	if (lines.length === 0) return [];
	const start = sideTextStartRow(side.length, lines.length);
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
	/** 已着色的说明行：宽终端是「前缀 + 字形」三行，窄终端退回一整句（见 `poweredByLines`）。 */
	onboarding?: readonly string[];
}

/**
 * 完整 header 行序：logo（含侧栏文字）→ **空行** → 提示行 → 说明段。
 *
 * 印记下方那一条空行**保留**（用户 2026-10-05 定）：大 logo 与下面的文字之间要留一口气。
 * 去掉的只是**提示行与说明段之间**那一条 —— 快捷键提示与 `@bachi/pi-coder` 字形贴成一块。
 * 两处空行不是同一条规则：一次改两处就是这两件事曾经被混为一谈的原因。
 *
 * 缺段时的处理：没有印记段就没有那条空行；提示行与说明段各自能单独出现（窄终端回退时
 * 印记段仍在，所以空行也在）。
 *
 * 提示行与说明行在这里补上 `MARK_INDENT` —— header 的每一行都不顶格，且与印记左边对齐；
 * logo 段自己已经带缩进，所以不重复补。空行保持空行。
 */
export function composeHeaderLines(sections: HeaderSections): string[] {
	const lines = [...sections.logo];
	// 印记下面的文字段：提示行先，说明段（可能是一整块字形）紧跟其后，两者之间不隔空行。
	const text = [...(sections.hints ? [MARK_INDENT + sections.hints] : []), ...(sections.onboarding ?? []).map((line) => MARK_INDENT + line)];
	// 空行只属于「印记段 → 文字段」这一条缝：两边都有内容时才补。
	if (lines.length > 0 && text.length > 0) lines.push("");
	lines.push(...text);
	return lines;
}

/** header 里上色用的最小主题接口（`index.ts` 的 `theme` 直接赋值进来）。 */
export interface HeaderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * 说明行的两种形态：宽终端是「整句前缀 + 三行字形」，装不下时退回一整句。
 *
 * 返回的行**不带** `composeHeaderLines` 补的那一格缩进，也不做截断 —— 宽度不够就整块退回句子，
 * 所以这里不需要 `truncateToWidth`（`logo.ts` 也不 import pi-tui，见文件头）。
 *
 * 为什么是「整块退回」而不是把字形截一半：字形是 3 行联动的方块，截到右侧会变成一个读不出
 * 形状的残片，不如退成一句干净的说明；用户给的字形块本身就带 44 列引导空白，装不下就没有
 * 中间状态。阈值按**含缩进**的整行宽度算（`width` 入参是终端总宽，与 `index.ts` 里其它 clamp
 * 的口径一致），判据是 `POWERED_BY_ART_WIDTH + 1 > width - POWERED_BY_PREFIX.length`：
 * 恰好等于「`POWERED_BY_WIDTH + MARK_INDENT` 装不装得下」，写成减法是为了让这个比较直接
 * 落在可用的剩余列上。
 */
export function poweredByLines(theme: HeaderTheme, width: number): string[] {
	const sentence = theme.fg("dim", POWERED_BY_SENTENCE);
	if (width < POWERED_BY_WIDTH + MARK_INDENT.length) return [sentence];
	// 引导空格不上色：它不可见，包进 `fg` 只会多几个转义。字形与句子**同走 `dim`**
	// （用户 2026-10-06 定），所以中间行整行一次上色，首末两行只给字形上色。
	const lead = " ".repeat(POWERED_BY_PREFIX.length);
	return POWERED_BY_ART.map((art, row) =>
		row === 1 ? theme.fg("dim", `${POWERED_BY_PREFIX}${art}`) : `${lead}${theme.fg("dim", art)}`,
	);
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
