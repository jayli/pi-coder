/**
 * compaction-summary/compact-style.ts — 压缩块显示形态的**纯逻辑**（不 import pi / pi-tui）。
 *
 * 宽度量度（`widthOf`，运行时传 pi-tui 的 `visibleWidth`）与 `✔` 的着色串都从外面注入，
 * 所以 `node --test` 能直接断言「哪几行被去掉、标记插在哪、可见宽度有没有变」。
 *
 * ## 目标形态（用户 2026-10-17 定）
 *
 * pi 原版（`CompactionSummaryMessageComponent`）是 `Box`（`paddingX = outputPad`、
 * `paddingY = 1`、底色 `customMessageBg`），里面依次是 `Text([compaction])`、`Spacer(1)`、
 * 正文，于是屏幕上是「底色整块 + 上下各一行空白 + 标题与正文之间一行空白」：
 *
 * ```
 *  （customMessageBg 底色块，上下各一条空行）
 *   [compaction]
 *  （空行）
 *   Compacted from 208,359 tokens (ctrl+o to expand)
 * ```
 *
 * 改成：
 *
 * ```
 *  [compaction]
 *  ✔ Compacted from 208,359 tokens (ctrl+o to expand)
 * ```
 *
 * 三件事：**去底色**、**去上下两条内边距行**、**标题与正文之间那行 Spacer 也去掉**，
 * 并在正文行首加一个 `✔ `。`[compaction]` 标签原样不动（颜色、位置、加粗都不碰）。
 *
 * ## 为什么在这一层做
 *
 * 底色只能在实例上 `setBgFn(undefined)` 处理（`Box` 的公开 API），内边距与内部 Spacer
 * 没有公开的 setter —— 但它们的产物**就是渲染结果里的行**，所以在行数组上裁剪即可：
 * 不碰任何私有字段，pi 哪天自己改成无内边距，这几步就退化成空操作。
 *
 * 与 `skill-invocation-reorder` 的差别：那边要裁的是**尾部**空行（保留顶部那条作间隔），
 * 这里上下两条都要去掉，且中间那行 Spacer 也要去掉 —— 所以按「首行是标签」这个结构直接
 * 定位，而不是按空白行数硬编码下标。
 */

/**
 * 「视觉上空白」的一行：只有空白字符与零宽转义序列。
 *
 * 去掉底色之后，`Box` 的内边距行就是 `width` 个空格；但**没去掉时**它们裹着背景序列
 * （`\x1b[48;…m` / `\x1b[49m`），两种形态都要认得 —— 这个函数在去底色之前就该可靠。
 */
const BLANK_ROW = /^(?:\s|\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))*$/;

/** 一行是不是「纯空白」（只剩零宽序列也算空白）。 */
export function isBlankRow(line: string): boolean {
	return BLANK_ROW.test(line);
}

/**
 * 去掉首尾的空白行 —— 那就是 `Box` 的 `paddingY = 1` 上下两条内边距。
 *
 * 只裁**首尾**：展开态正文里的空行是段落间隔，必须原样留着。
 * 全是空白时返回空数组（那时确实没东西可画）。
 */
export function stripPaddingRows(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRow(lines[start]!)) start += 1;
	while (end > start && isBlankRow(lines[end - 1]!)) end -= 1;
	return start === 0 && end === lines.length ? [...lines] : lines.slice(start, end);
}

/**
 * 去掉标题行与正文之间的那行 `Spacer(1)`。
 *
 * pi 的组件结构固定是「标签 / Spacer / 正文」，所以这里只丢**首行之后紧邻的**那一段空白，
 * 后面正文自己的段落空行一律不动（展开态里它们承载版式）。
 */
export function dropTitleGap(lines: readonly string[]): string[] {
	if (lines.length < 2) return [...lines];
	let index = 1;
	while (index < lines.length && isBlankRow(lines[index]!)) index += 1;
	// 整段都是空白（没有正文）：保持原样交给上层，别把内容全吃掉
	if (index >= lines.length) return [...lines];
	return index === 1 ? [...lines] : [lines[0]!, ...lines.slice(index)];
}

/**
 * 在行首加一个标记（`✔ `），**整行可见宽度不变**。
 *
 * 做法：标记占的列数从**行尾补白**里等量吃掉，与 `user-message-bar` 给行首塞竖线是同一手法。
 * 行尾补白不够（正文正好铺满那一行）时**这一行不加标记** —— 宁可少一个 `✔`，也不能让整行
 * 超宽：pi-tui 的主屏渲染器发现任何一行超过终端宽度就**直接抛错**并打死 TUI。
 *
 * 行首的内边距空格保留，所以 `✔` 落在 `[compaction]` 的 `[` 那一列，两行左边缘对齐。
 *
 * **插入点在行首内边距之后、正文自己的样式序列之前**（实测踩到）：若把 `✔` 放在正文的
 * `\x1b[38;…m` 之后，标记自带的 `\x1b[39m` 会把后面的正文颜色一并清掉，整句 `Compacted from …`
 * 就变成终端默认色。放在前面则：标记用自己的色与复位，正文的色序列紧接着重新铺上。
 *
 * 行尾那一段既可能是裸空格、也可能裹着**背景复位**（`\x1b[49m`）：本模块不假设调用方已经去过
 * 底色，所以按 token 行走 —— 空格才能吃，ANSI 序列原样保留（它们不影响可见宽度）。
 */
export function markRow(line: string, mark: string, widthOf: (text: string) => number): string {
	if (mark === "") return line;
	const tokens = tokenize(line);
	const lastChar = findLastChar(tokens);
	if (lastChar < 0) return line; // 整行空白：没正文可标
	const tail = tokens.slice(lastChar + 1);
	const needed = widthOf(mark) + 1; // 标记 + 它后面那一格空格
	if (countSpaces(tail) < needed) return line;
	// 插入点：正文之前**最后一个空格**之后。
	// 背景未去时行首是 `BG + 内边距空格 + 正文色`，去底色后是 `内边距空格 + 正文色` —— 两种都把
	// 标记放在内边距空格之后、正文色之前：底色保得住，标记自带的复位也不会把正文色洗掉。
	const bodyStart = tokens.findIndex((token) => token.kind === "char");
	let prefixEnd = bodyStart;
	while (prefixEnd > 0 && tokens[prefixEnd - 1]!.kind !== "space") prefixEnd -= 1;
	const prefix = tokens.slice(0, prefixEnd).map((token) => token.text).join("");
	const body = tokens.slice(prefixEnd, lastChar + 1).map((token) => token.text).join("");
	const rest = consumeSpaces(tail, needed).map((token) => token.text).join("");
	return `${prefix}${mark} ${body}${rest}`;
}

/** 一个行片段：ANSI/OSC 零宽序列、空格、或真字符（后两者影响可见宽度）。 */
interface LineToken {
	kind: "ansi" | "space" | "char";
	text: string;
}

const ANSI_TOKEN = /^(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;:?]*[ -/]*[@-~])/;

/** 把一行切成「零宽序列 / 单个空格 / 单个字符」，供行首行尾定位用。 */
function tokenize(line: string): LineToken[] {
	const tokens: LineToken[] = [];
	let index = 0;
	while (index < line.length) {
		const rest = line.slice(index);
		const ansi = ANSI_TOKEN.exec(rest);
		if (ansi) {
			tokens.push({ kind: "ansi", text: ansi[0] });
			index += ansi[0].length;
			continue;
		}
		const char = String.fromCodePoint(rest.codePointAt(0)!);
		tokens.push({ kind: char === " " ? "space" : "char", text: char });
		index += char.length;
	}
	return tokens;
}

/** 最后一个真字符的下标（没有则 -1）。 */
function findLastChar(tokens: readonly LineToken[]): number {
	for (let index = tokens.length - 1; index >= 0; index -= 1) {
		if (tokens[index]!.kind === "char") return index;
	}
	return -1;
}

function countSpaces(tokens: readonly LineToken[]): number {
	return tokens.filter((token) => token.kind === "space").length;
}

/** 从前向后吃掉 `count` 个空格 token，其余（含 ANSI）原序留下。 */
function consumeSpaces(tokens: readonly LineToken[], count: number): LineToken[] {
	let left = count;
	const out: LineToken[] = [];
	for (const token of tokens) {
		if (left > 0 && token.kind === "space") {
			left -= 1;
			continue;
		}
		out.push(token);
	}
	return out;
}

/**
 * 把 pi 原版的行数组改成本扩展要的形态：去内边距行 → 去标题与正文之间的间隔 →
 * 给正文首行加标记。
 *
 * `mark` 是着色后的串（调用方拼好 ANSI，本模块不碰主题）；空串表示这一帧拿不到皮肤，
 * 那就只做形态裁剪、不加标记。
 */
export function restyleCompaction(
	lines: readonly string[],
	mark: string,
	widthOf: (text: string) => number,
): string[] {
	const trimmed = dropTitleGap(stripPaddingRows(lines));
	if (trimmed.length === 0 || mark === "") return trimmed;
	if (trimmed.length === 1) return trimmed; // 只有标签行（理论上不会出现）：没有正文可标
	return [trimmed[0]!, markRow(trimmed[1]!, mark, widthOf), ...trimmed.slice(2)];
}

/** `✔` 字形（U+2714，pi-tui `visibleWidth` 实测 1 列，不是 emoji 也不必带 VS16）。 */
export const MARK_GLYPH = "\u2714";
