/**
 * explored-group / shrink —— 把一条短语缩到终端宽度以内：**尽量不折行**。
 *
 * 用户 2026-10-27 定（同一天两轮，第二轮的规则取代第一轮）：
 *
 *     └ Search "glass_block\|purple_stained_glass" in tools/cloudland-kit-fingerpri
 *       nt.mjs                        ← 折行：看着像两条调用，续行也没有动词可依靠
 *
 * 改成把**路径**缩到一行装下（砍头保尾，保住文件名）。第二轮补充的更重要的一条 ——
 * 搜索的**模式串**也可能太长，那时只缩路径会缩出「文件名都没了」的一行：
 *
 *     └ Search "export function blockInd…columnKey|COLUMN_HEIGHT" in src/voxel/cons
 *         tants.js
 *
 * 所以缩略按**三个阶段**推进，每一步都先试着「这样能不能不折行」，能就停：
 *
 * | 阶段 | 动什么 | 为什么 |
 * |---|---|---|
 * | A | **只丢目录层级**，文件名保持全称 | 目录是最不值钱的信息（同目录下常有几十个文件），文件名才是「读的是哪个」 |
 * | B | **只缩模式串**（中间省略，保头保尾），文件名仍保持全称 | 用户：「文件名最好保留全称，然后再去缩略搜索的字符串」 |
 * | C | 模式串缩到地板后仍不够，才**连文件名一起缩**（每轮砍当前最宽的） | 用户：「实在不行…该缩略就缩略文件名」，多个可缩段之间保持相对平均 |
 *
 * 地板：路径 `…` + `MIN_TAIL_COLS` 列（再短就只剩一个 `…`，看不出是哪个文件），
 * 模式 `MIN_PATTERN_COLS` 列（别把搜索字符串缩没了）。都到地板还装不下（极窄终端、
 * 超长模式）就返回 `overflow: true`，由调用方退回折行。
 *
 * ## 两种缩法的方向相反
 *
 * - **路径**：砍头保尾（`tools/cloudland-kit-fingerprint.mjs` → `…kit-fingerprint.mjs`）。
 *   文件名在末尾，头部信息量最低。
 * - **模式**：中间省略、两头都保（`export function blockInd…columnKey`）。正则 / 关键字
 *   常见形态是「前缀 + 中部 + 后缀」（`foo.*bar`、`^(?!x)y$`），砍头会把锚点丢掉。
 *
 * ## 为什么是结构化片段
 *
 * 用户明确要求「只缩这几段」。动词、`in`、行号区间、包裹模式串的引号都不能动
 * （缩引号就没法判断这是模式串，缩区间会撒谎）。所以短语由调用方拆成 `PhrasePiece[]`，
 * 本模块只动标了 `shrink` 的那些段。
 *
 * 纯逻辑：零 pi 依赖，宽度量度由调用方注入（渲染侧传 pi-tui 的 `visibleWidth`），
 * 所以 `node --test` 能直跑。
 */

/** 缩略前缀（U+2026），与 `phrases.ts` 的路径缩略、bash 侧折叠的 `…` 同一字形。 */
export const ELLIPSIS = "…";
/** 路径缩到地板时尾部至少保留的可见列数（不含 `…`）。 */
export const MIN_TAIL_COLS = 8;
/** 模式串缩到地板时至少保留的可见列数（不含包裹它的引号）。 */
export const MIN_PATTERN_COLS = 12;

/** 可缩段的缩法：路径砍头，模式串省略中间。 */
export type ShrinkKind = "path" | "pattern";

/**
 * 短语的一段。
 *
 * 标了 `shrink` 的段在行超宽时会被缩（`path` 砍头保尾 / `pattern` 中间省略）；
 * 其余（动词、`in`、引号、行号区间）一律固定，缩的时候一个字符都不动。
 */
export interface PhrasePiece {
	text: string;
	shrink?: ShrinkKind;
}

/** 可见宽度量度（渲染侧注入 `visibleWidth`；测试里给一个按码点计数的即可）。 */
export type WidthFn = (text: string) => number;

/** 片段拼回一行文本。 */
export function joinPieces(pieces: readonly PhrasePiece[]): string {
	let out = "";
	for (const piece of pieces) out += piece.text;
	return out;
}

/** 一条短语的可见宽度。 */
export function piecesWidth(pieces: readonly PhrasePiece[], width: WidthFn): number {
	return width(joinPieces(pieces));
}

/**
 * 路径缩到 `maxWidth` 列：装得下原样返回；装不下就**砍头、保留尾部**，前面补 `…`。
 *
 * 从尾部按**码点**往前取（`[...value]`：代理对不会被劈成两半），宽字符（CJK）按它真实的
 * 列宽记账 —— 所以缩出来的宽度与 `visibleWidth` 一致，不会缩了还是超宽。
 */
export function shrinkPath(value: string, maxWidth: number, width: WidthFn): string {
	if (maxWidth <= 0) return "";
	if (width(value) <= maxWidth) return value;
	const ellipsisWidth = width(ELLIPSIS);
	if (maxWidth <= ellipsisWidth) return ELLIPSIS;
	let tail = "";
	let used = ellipsisWidth;
	const chars = [...value];
	for (let i = chars.length - 1; i >= 0; i--) {
		const charWidth = width(chars[i]!);
		if (used + charWidth > maxWidth) break;
		tail = chars[i]! + tail;
		used += charWidth;
	}
	return ELLIPSIS + tail;
}

/**
 * 模式串缩到 `maxWidth` 列：装得下原样返回；装不下就**省略中间**，头尾交替各留一点。
 *
 * 与 `shrinkPath` 相反的方向是刻意的：正则的开头（`^`、`export function `）与结尾
 * （`$`、`COLUMN_HEIGHT`）都是承重信息，砍掉任何一头都认不出搜的是什么。
 */
export function elideMiddle(value: string, maxWidth: number, width: WidthFn): string {
	if (maxWidth <= 0) return "";
	if (width(value) <= maxWidth) return value;
	const ellipsisWidth = width(ELLIPSIS);
	if (maxWidth <= ellipsisWidth) return ELLIPSIS;
	const chars = [...value];
	let head = "";
	let tail = "";
	let used = ellipsisWidth;
	let left = 0;
	let right = chars.length - 1;
	let takeHead = true; // 头尾交替地取，两边的压缩比例才一致
	while (left <= right) {
		const char = takeHead ? chars[left]! : chars[right]!;
		const charWidth = width(char);
		if (used + charWidth > maxWidth) break;
		if (takeHead) {
			head += char;
			left++;
		} else {
			tail = char + tail;
			right--;
		}
		used += charWidth;
		takeHead = !takeHead;
	}
	return `${head}${ELLIPSIS}${tail}`;
}

/** 路径最后一段（文件名 / 目录名）；两种分隔符都认（Windows 的 `~C:\…`）。 */
function baseName(value: string): string {
	const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	return cut < 0 ? value : value.slice(cut + 1);
}

/**
 * 一条路径的缩略**阶梯**，从长到短（阶段 A 用）。
 *
 * 逐级丢掉靠前的目录、**文件名始终完整**；只有当某一级不比上一级更短时才跳过它
 *（`…/voxel/constants.js` 比 `src/voxel/constants.js` 还长，留着没有意义）。
 * 最后一级永远是裸文件名 —— 再往下就轮到阶段 C 的字符级砍头了。
 *
 * 例：`src/voxel/constants.js` → [`src/voxel/constants.js`, `…/voxel/constants.js`, `constants.js`]
 *     `~/a/b/c.ts`             → [`~/a/b/c.ts`, `…/b/c.ts`, `c.ts`]
 */
export function pathStages(value: string, width: WidthFn): string[] {
	const stages = [value];
	const base = baseName(value);
	if (base === value || base === "") return stages;
	const dirs = value.slice(0, value.length - base.length).replace(/[/\\]+$/, "").split(/[/\\]+/).filter(Boolean);
	for (let keep = dirs.length - 1; keep >= 0; keep--) {
		const next = keep === 0 ? base : `${ELLIPSIS}/${dirs.slice(-keep).join("/")}/${base}`;
		const previous = stages[stages.length - 1]!;
		if (next === previous || width(next) >= width(previous)) continue;
		stages.push(next);
	}
	if (stages[stages.length - 1] !== base) stages.push(base);
	return stages;
}

export interface ShrinkResult {
	pieces: PhrasePiece[];
	/** 缩到地板后仍然超宽 —— 调用方只能退回折行。 */
	overflow: boolean;
}

/** 该段的缩略地板（可见列）。没标 `shrink` 的段不参与缩略，地板无意义。 */
function floorFor(piece: PhrasePiece, currentWidth: number, width: WidthFn): number {
	if (piece.shrink === "pattern") return Math.min(currentWidth, MIN_PATTERN_COLS);
	if (piece.shrink === "path") return width(ELLIPSIS) + MIN_TAIL_COLS;
	return currentWidth;
}

/** 按目标宽度缩一段（没标 `shrink` 的段原样返回）。 */
function shrinkTo(piece: PhrasePiece, target: number, width: WidthFn): string {
	if (piece.shrink === "pattern") return elideMiddle(piece.text, target, width);
	if (piece.shrink === "path") return shrinkPath(piece.text, target, width);
	return piece.text;
}

/**
 * 把整条短语缩到 `budget` 列以内（A → B → C 三阶段，见文件头）。
 *
 * 返回值**永远不是 null**：装不下时给「已经尽力缩过」的片段 + `overflow: true`，调用方可以
 * 直接把它交给 `hardWrap`（缩过的总比原样折行好）。
 */
export function shrinkPieces(
	pieces: readonly PhrasePiece[],
	budget: number,
	width: WidthFn,
): ShrinkResult {
	if (piecesWidth(pieces, width) <= budget) return { pieces: [...pieces], overflow: false };

	// ── 阶段 A：只丢目录层级，文件名保持全称 ────────────────────────────────
	const stageLists = pieces.map((piece) => (piece.shrink === "path" ? pathStages(piece.text, width) : [piece.text]));
	const staged = pieces.map((piece) => ({ ...piece }));
	const deepest = Math.max(...stageLists.map((stages) => stages.length));
	for (let level = 1; level < deepest; level++) {
		for (let i = 0; i < staged.length; i++) {
			const next = stageLists[i]![level];
			if (next !== undefined) staged[i] = { ...staged[i]!, text: next };
		}
		if (piecesWidth(staged, width) <= budget) return { pieces: staged, overflow: false };
	}

	// ── 阶段 B / C：按「先模式串、后文件名」的顺序砍到装下 ──────────────────
	const targets = staged.map((piece) => width(piece.text));
	const floors = staged.map((piece, i) => floorFor(piece, targets[i]!, width));
	const fixedWidth = staged.reduce((sum, piece, i) => (piece.shrink ? sum : sum + targets[i]!), 0);
	const available = budget - fixedWidth;
	let total = staged.reduce((sum, piece, i) => (piece.shrink ? sum + targets[i]! : sum), 0);

	/** 每轮砍当前最宽的、还没到地板的段（同类之间因此被压到相近长度）。 */
	const squeeze = (only: ShrinkKind | null): void => {
		while (total > available) {
			let pick = -1;
			for (let i = 0; i < staged.length; i++) {
				if (!staged[i]!.shrink) continue;
				if (only !== null && staged[i]!.shrink !== only) continue;
				if (targets[i]! <= floors[i]!) continue;
				if (pick === -1 || targets[i]! > targets[pick]!) pick = i;
			}
			if (pick === -1) return;
			targets[pick]!--;
			total--;
		}
	};

	squeeze("pattern"); // 阶段 B：文件名还完整，先把搜索字符串缩到地板
	squeeze(null); // 阶段 C：还不够才连文件名一起缩

	const out = staged.map((piece, i) => ({ ...piece, text: shrinkTo(piece, targets[i]!, width) }));
	return { pieces: out, overflow: total > available };
}
