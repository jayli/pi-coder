/**
 * user-message-bar — 纯逻辑：用户消息框每行行首加一条竖线
 *
 * 用户消息框本来就是 `Box(paddingX = outputPad, paddingY = 1)` + `userMessageBg` 底色，
 * 上下各一行空白内边距。本扩展给**每一行**（含上下那两条空白行）行首加一条竖线，正文再空一格：
 *
 *     ▏
 *     ▏ 正文正文
 *     ▏
 *
 * 竖线占的正是**原本就存在的那一格左内边距**：把行首第一格空格换成 `▏`；正文前多空的那一格
 * （`BAR_INDENT`）则从**行尾补白**里等量吃掉，于是底色、行宽、正文折行位置全都与改之前一模一样。
 * 一格都不能靠「加一格等终端截断」省事 —— pi-tui 的主屏渲染器发现任何一行超过终端宽度就
 * **直接抛错**（`tui-main-screen.js` 先把整屏 dump 进 `pi-tui-crash.log`，再 throw
 * `Rendered line N exceeds terminal width`），整个 TUI 会崩掉。
 *
 * 行尾那格补白一定够吃：`paddingX = 1` 时 Box 只给孩子 `width - 2` 列，正文再长也留得下一格。
 * `outputPad = 0`（pi 的设置项）时行首没有内边距可占，竖线 + 缩进共两格都得向行尾借 —— 借不够
 * 就先保住竖线（少空那一格），连一格都借不出来时这行干脆不加（宁可少画，不能撑宽）。
 *
 * 颜色取皮肤的 **`accent`** —— 这套皮肤里"强调/正向"的那个亮色。
 * 它是**前景**槽，直接拿 `getFgAnsi` 用；想换别的槽位（包括 `selectedBg` 这种背景槽，会做一次
 * 48→38 的等值转换当前景用）用 `PI_USER_MESSAGE_BAR_COLOR=<皮肤槽位名>`。竖线自带前景复位，
 * 所以竖线后面那个空格不会被染上前景色。
 *
 * 竖线那一格**跟着消息底色**（不抠）：Box 把整行裹在 `theme.bg("userMessageBg", …)` 里，
 * 竖线就坐在里面，字形与底色块连成一片。曾经在竖线前插 `49m`、画完再还原，让那一格裸着，
 * 结果底色块左边缘被抠出一个缺角 —— 实测观感更差，已回退（别再改回去）。
 *
 * 为什么必须打原型补丁：pi 的扩展 API 里跟用户消息沾边的只有 `registerMarkdownTransformer`，
 * 它是**字符串级**的、只看得见正文源文，看不见 Box 补出来的上下空白行与左内边距 —— 而那两样
 * 恰是这里要画竖线的地方。所以只能接管 `UserMessageComponent.prototype.render`。
 *
 * 补丁为什么打得中（跨模块实例）：`pi` 命令跑的是 `dist/bundle/cli.js`，扩展加载器在 bundle /
 * 编译二进制形态下把 `@earendil-works/pi-coding-agent` 指向加载器那份 **bundle 自己的命名空间**
 * （`core/extensions/loader.js` 的 `virtualModules` 分支），也就是 pi 渲染时用的同一个类。
 * `index.test.ts` 断言的就是这条端到端链路（拿 pi 自己导出的 `UserMessageComponent` 渲染）。
 *
 * 本模块不 import pi / pi-tui：取色源与组件类都由调用方注入，`node --test` 能直跑。
 */

/** 竖线字形：`▏`（U+258F）。 */
export const BAR_GLYPH = "\u258F";

/** 竖线与正文之间空出的半角格数（正文因此比行首竖线缩进两格）。 */
export const BAR_INDENT = 1;

/** 默认取色槽：皮肤的强调色（`accent`，见文件头）。 */
export const DEFAULT_COLOR_NAME = "accent";

/**
 * 首选槽位取不到时的兜底顺序（皮肤可能不定义 `accent`，旧皮肤尤其常见）：
 * 强调色 → 选中色 → diff 新增行行号色 → 正文色。
 */
const FALLBACK_COLOR_NAMES = ["selectedBg", "toolDiffAdded", "text"];

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * 零宽（不占列）序列：pi 的 Box 每行以 `\x1b[48;…m` 开头、`\x1b[49m` 收尾，恢复会话的首行
 * 还挂 OSC 133 的 shell 集成 zone 标记；另两种是终端里的字符集切换与键盘模式，属于防御性覆盖。
 */
const ANSI_PART = [
	`${ESC}\\[[0-9;:?]*[ -/]*[@-~]`, // CSI（SGR 颜色、光标移动）
	`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, // OSC（OSC 133 zone 标记），BEL 或 ST 收尾
	`${ESC}[()][0-9A-Za-z]`, // 字符集切换
	`${ESC}[=>]`, // 键盘模式
].join("|");

const LEADING_ANSI = new RegExp(`^(?:${ANSI_PART})*`);
const ONLY_ANSI = new RegExp(`^(?:${ANSI_PART})*$`);

/**
 * 给一行加竖线：吃掉落内边距那一格空格换成竖线，正文前空 `indent` 格，
 * 空出来的这几格从行尾补白里等量吃掉 —— 整行可见宽度与原来完全一致。
 *
 * 竖线**不抠底色**：它直接坐在 Box 的 `userMessageBg` 里（pi 的 Box 把整行裹在
 * `theme.bg("userMessageBg", …)` 中），于是那一格与整块消息底色连成一片、只在左边缘多出一个
 * 字形。曾经在竖线前插 `49m` 再还原，结果底色块左边缘被抠出一个缺角，观感反而更差（已回退）。
 *
 * 四种边角情况（都不撑宽，最坏是这一行没有竖线）：
 *   - `outputPad = 0`（pi 的设置项）时行首就是正文，那一格内边距不存在 —— 竖线本身也得从
 *     行尾补白里借一格，竖线插在正文前面。
 *   - 行尾补白不够空 `indent` 格时退化成「只加竖线、不空那一格」。
 *   - 行尾连竖线那一格都借不出来（正文正好铺满一行）时原样返回。
 */
export function addBarToLine(line: string, bar: string, indent: number = BAR_INDENT): string {
	const head = LEADING_ANSI.exec(line)?.[0] ?? "";
	const rest = line.slice(head.length);

	// Box 的左内边距（0 / 1 格）：在的话这一格直接当竖线的落脚点
	const pad = rest.startsWith(" ") ? 1 : 0;
	const body = pad === 1 ? rest.slice(1) : rest;

	const padding = trailingSpaceRun(body);
	const spare = padding ? padding.end - padding.start : 0;
	const neededByBar = 1 - pad; // 竖线自己要从行尾借的格数
	if (spare < neededByBar) return line;

	const used = Math.min(indent, spare - neededByBar);
	const dropped = neededByBar + used;
	const trimmed = padding ? body.slice(0, padding.end - dropped) + body.slice(padding.end) : body;

	return `${head}${bar}${" ".repeat(used)}${trimmed}`;
}

/**
 * 行尾「纯空格补白」这段的下标区间（相对整行），没有则 undefined。判定要求空格后面**只有**
 * 零宽序列（`\x1b[49m` 之类），否则那段空格是正文里的空格，动它会吃掉真正的字符。
 */
function trailingSpaceRun(line: string): { start: number; end: number } | undefined {
	const last = line.lastIndexOf(" ");
	if (last < 0) return undefined;
	if (!ONLY_ANSI.test(line.slice(last + 1))) return undefined;
	let start = last;
	while (start > 0 && line[start - 1] === " ") start -= 1;
	return { start, end: last + 1 };
}

/** 取色源：pi 的 `Theme` 实例（只用到这两个方法，注入后本模块与 pi 解耦）。 */
export interface ThemeColorSource {
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
}

/**
 * 取竖线的前景 ANSI（不含字形）。传入的皮肤连兜底槽位都没有时返回 `undefined` ——
 * 调用方据此放弃画竖线，而不是抛。
 *
 * 槽位既可能是前景槽（`toolDiffAdded` / `accent`）也可能是**背景**槽（`selectedBg`）：
 * `Theme.fg()` 只认前景槽、拿背景槽的名字去调会抛 `Unknown theme color`，所以背景槽这里做一次
 * 38/48 的等值转换（`bgAnsi` 与 `fgAnsi` 除这一个数字外完全同形，truecolor 与 256 色都是），
 * 转换出来的前景就是这个底色本身。
 */
export function resolveBarAnsi(
	source: ThemeColorSource | undefined,
	preferred: string = DEFAULT_COLOR_NAME,
): string | undefined {
	if (!source) return undefined;
	for (const name of [preferred, ...FALLBACK_COLOR_NAMES]) {
		const ansi = colorAnsi(source, name);
		if (ansi) return ansi;
	}
	return undefined;
}

/** 一个槽位名 → 前景 ANSI：先当 fg 用，失败再当 bg 用（背景槽转前景）。 */
function colorAnsi(source: ThemeColorSource, name: string): string | undefined {
	try {
		const fg = source.getFgAnsi(name);
		if (fg.startsWith("\u001b[38;")) return fg;
	} catch {
		// 不是这个皮肤的前景槽：接着试背景槽
	}
	try {
		const bg = source.getBgAnsi(name);
		if (bg.startsWith("\u001b[48;")) return bg.replace("\u001b[48;", "\u001b[38;");
	} catch {
		// 也不是背景槽
	}
	return undefined;
}

/**
 * 原型上的补丁状态。`Symbol.for` 走全局注册表，`/reload`（模块重新求值）后仍认得出这个原型
 * 已经被包过 —— 状态挂在原型上而不是模块作用域，为的是让 reload 后的新实例**更新取色源**
 * 而不是再包一层（旧的 ctx 可能已经作废，取色源必须换成新的）。
 */
const PATCH_KEY = Symbol.for("pi-user-message-bar.state");

interface BarState {
	theme: () => ThemeColorSource | undefined;
	colorName: string;
	barAnsi: () => string | undefined;
}

export interface UserMessageBarOptions {
	/** pi 的 `UserMessageComponent` 类（扩展侧 import 到的就是 pi 渲染用的那个类，见文件头）。 */
	UserMessageComponent: { prototype: Record<string | symbol, unknown> };
	/** 取当前皮肤的 Theme，渲染时求值 —— `ctx.ui.theme` 是跨 `/theme` 换肤的活 Proxy。 */
	theme: () => ThemeColorSource | undefined;
	/** 取色槽位名，默认 `accent`（皮肤的强调色）。 */
	colorName?: string;
	/** 字形，默认 `▏`（U+258F）。 */
	glyph?: string;
}

/**
 * 装上「用户消息行首竖线」补丁。返回**本次是否真的装了**：`/reload` 之后是 `false`
 * （补丁已在，只换了取色源），原型形状不认识（没有 `render`）时也是 `false` 且什么都不做 ——
 * 不猜、不抛，宁可这个特性不生效。
 */
export function installUserMessageBar(options: UserMessageBarOptions): boolean {
	const prototype = options.UserMessageComponent.prototype;
	const existing = prototype[PATCH_KEY] as BarState | undefined;
	if (existing) {
		existing.theme = options.theme;
		if (options.colorName !== undefined) existing.colorName = options.colorName;
		return false;
	}

	const original = prototype.render;
	if (typeof original !== "function") return false;

	const glyph = options.glyph ?? BAR_GLYPH;
	const state: BarState = {
		theme: options.theme,
		colorName: options.colorName ?? DEFAULT_COLOR_NAME,
		barAnsi: () => undefined,
	};
	state.barAnsi = () => {
		const ansi = resolveBarAnsi(state.theme(), state.colorName);
		// 字形后补一个前景色复位（与 theme.fg() 同形）：竖线不该把颜色带给后面的补白
		return ansi === undefined ? undefined : `${ansi}${glyph}\u001b[39m`;
	};

	prototype[PATCH_KEY] = state;
	prototype.render = function (this: unknown, ...args: unknown[]): string[] {
		const lines = (original as (...args: unknown[]) => string[]).apply(this, args);
		if (!Array.isArray(lines) || lines.length === 0) return lines;
		const bar = state.barAnsi();
		if (!bar) return lines;
		return lines.map((line) => addBarToLine(line, bar));
	};
	return true;
}
