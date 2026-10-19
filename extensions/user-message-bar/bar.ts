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
 * 框的**上方**再有一行发送时间（用户 2026-10-19 定；竖线照旧在最前，底色从消息底色
 * `userMessageBg` 变暗 25% 起**逐字渐到背景黑**，跨度是本行文字的格数 + 20，之后到行尾保持背景色，
 * 所以右半截直接融进页面背景）：
 *
 *     ▏You 12:04 #12 · 1 compactions
 *     ▏
 *     ▏ 正文正文
 *     ▏
 *
 * 最前面的引导符 `▏`（与消息框竖线同字形）用 `dim`（与回合结束符 `✻ Churned for 3m 37s · done
 * 11:52 PM` 同一个色槽）、`You` 加粗 + 主题的 `syntaxKeyword`（语法关键字色）、时间 /` #12` /
 * ` · N compactions` 用 `dim`；时间走 **本地 24 小时制、两位补零**（`formatClock`，`9:33` →
 * `09:33`）。`#12` 是当前会话里的第几条用户消息（1 起，回放 / 重建时沿用原编号）；` · N
 * compactions` 是**这条消息发出时**已经压缩过几次（0 也画；按当时的分支数，不是当前的累计值 ——
 * 见 `setCompactionLookup`），且在**渲染时现查**（不在打戳时快照：会话替换会先把历史重画、
 * 再发 `session_start`，那时查询函数还没装上），引导符与 `You` 之间不空。
 * 时间来自 user 消息对象上的 `timestamp`（毫秒，session 文件里持久化同一份），不是渲染时钟 ——
 * 所以 resume / fork 回放出来的历史消息显示的是**当初的发送时间**。组件构造处拿不到 message，
 * 由 `installUserMessageTimestamp` 在 `InteractiveMode.prototype.addMessageToChat` 外层打戳。
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

/** 抬头里 `You` 的固定文案。 */
export const HEADER_LABEL = "You";

/** 抬头最前面的引导符（`▏` U+258F，与消息框竖线同字形；用户 2026-10-19 定）。 */
export const HEADER_LEAD = "\u258F";

/** 引导符槽位：皮肤的 `dim` —— 与 `working-indicator` 的回合结束符 `✻ … · done …` 同槽。 */
const HEADER_LEAD_COLOR = "dim";
/** 发件人槽位：皮肤的语法关键字色（`pi-coder-1337` 的 `keyword` 变量就挂在它上面）。 */
const HEADER_LABEL_COLOR = "syntaxKeyword";
/** 时间槽位：皮肤的 `dim`。 */
const HEADER_TIME_COLOR = "dim";

/** 抬头底色的**渐变起点**：用户消息框的底色（`userMessageBg`）变暗 25%（用户 2026-10-19 定）。
 * 渐变**终点是终端背景色**（≈ 纯黑，见 `HEADER_BG_END_RGB`），不是消息底色。
 */
const HEADER_BG_COLOR_NAME = "userMessageBg";
/** 变暗 25% = 每个通道乘 0.75。 */
const HEADER_BG_SCALE = 0.75;
/**
 * 渐变在**文字之后**再多走 20 格（用户 2026-10-19 定）：文字不落在渐变末端，尾巴还有一段
 * 慢慢化进背景；碰到行右边界时以边界为准（渐变总长 = min(行宽, 文字格数 + 20)）。
 */
const HEADER_BG_TAIL = 20;
/**
 * 渐变终点：行背后的终端背景。pi 不画页面底色（那是终端的），也拿不到终端通过 OSC 11
 * 上报的底色 —— 本机的背景是纯黑一档，所以直接取纯黑。终端背景若不是黑，右端会有一条
 * 不明显的接缝（改这个常量即可）。
 */
const HEADER_BG_END_RGB: readonly [number, number, number] = [0, 0, 0];

/** 槽位缺失时的兜底顺序（旧皮肤可能没有 `syntaxKeyword` / `dim`）。 */
const HEADER_LEAD_FALLBACKS = ["muted", "text"] as const;
const HEADER_LABEL_FALLBACKS = ["accent", "text"] as const;
const HEADER_TIME_FALLBACKS = ["muted", "text"] as const;

/** 前景槽 ANSI；缺失返回 undefined（调用方据此不套颜色，而不是抛）。 */
function headerColor(
	source: ThemeColorSource | undefined,
	preferred: string,
	fallbacks: readonly string[],
): string | undefined {
	if (!source) return undefined;
	for (const name of [preferred, ...fallbacks]) {
		try {
			const ansi = source.getFgAnsi(name);
			if (ansi.startsWith("\u001b[38;")) return ansi;
		} catch {
			// 这个皮肤没有这个槽位：试下一个
		}
	}
	return undefined;
}

/** xterm 256 色号 → RGB；只认 16..255（0..15 是终端自定义色，猜不得）。 */
function indexedRgb(index: number): [number, number, number] | undefined {
	if (!Number.isInteger(index) || index < 16 || index > 255) return undefined;
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return [level, level, level];
	}
	const cube = [0, 95, 135, 175, 215, 255];
	const offset = index - 16;
	return [cube[Math.floor(offset / 36)]!, cube[Math.floor(offset / 6) % 6]!, cube[offset % 6]!];
}

/** RGB → 最近的 xterm 256 色号（同样只在 16..255 里找）。 */
function nearestIndexed(rgb: readonly [number, number, number]): number {
	let best = 16;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 16; index <= 255; index += 1) {
		const candidate = indexedRgb(index);
		if (!candidate) continue;
		const dr = rgb[0] - candidate[0];
		const dg = rgb[1] - candidate[1];
		const db = rgb[2] - candidate[2];
		const distance = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = index;
		}
	}
	return best;
}

/** 一个底色槽位拆成「RGB + 按当前色彩模式编码」两个东西。 */
interface BgColor {
	rgb: [number, number, number];
	encode: (rgb: readonly [number, number, number]) => string;
}

/**
 * 把 `getBgAnsi` 的输出拆回 RGB，并给出同模式的编码器。
 *
 * truecolor 原样编码成 `48;2`；256 色皮肤落回最近的色号（保持同一色彩模式，不硬塞 `48;2`）。
 * 0..15 是终端自定义色、`49m` 是终端默认底色 —— 这两种拿不到 RGB，返回 undefined。
 */
function parseBgAnsi(ansi: string): BgColor | undefined {
	const truecolor = /^\u001b\[48;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
	if (truecolor) {
		const rgb: [number, number, number] = [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
		return {
			rgb,
			encode: ([r, g, b]) => `\u001b[48;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`,
		};
	}
	const indexed = /^\u001b\[48;5;(\d+)m$/.exec(ansi);
	if (!indexed) return undefined;
	const rgb = indexedRgb(Number(indexed[1]));
	if (!rgb) return undefined;
	return { rgb, encode: (color) => `\u001b[48;5;${nearestIndexed(color)}m` };
}

/** 一帧抬头的渐变底色。 */
export interface HeaderBackground {
	/** 每个可见格一个背景 ANSI：第 0 格是变暗 25% 的消息底色，最后一格已经是背景色。 */
	cells: string[];
	/** 背景色 ANSI（渐变终点）—— 字符结束之后到行尾都用它铺满。 */
	end: string;
}

/** 渐变结果按「消息底色 ANSI + 可见格数」缓存：同一屏几十条消息、每帧都要用。 */
const headerBackgroundCache = new Map<string, HeaderBackground | undefined>();

/**
 * 抬头底色渐变（用户 2026-10-19 定）：从 `userMessageBg` 变暗 25% 起步，渐到**背景色**（纯黑），
 * 跨度是这一行**文字格数 + 20 格**（`HEADER_BG_TAIL`，碰到行右边界就以边界为准）——
 * 文字不落在渐变末端，尾巴还有一段慢慢化进背景，不会出现一段悬空的色块。
 *
 * 取不到消息底色（旧皮肤没这个槽 / 槽位是空串 / 0..15 系统色）= 返回 undefined，这一行就不铺
 * 底色、也不补白，与加底色之前逐字一致。
 */
export function headerBackground(
	source: ThemeColorSource | undefined,
	length: number,
): HeaderBackground | undefined {
	if (!source || length < 1) return undefined;
	let raw: string;
	try {
		raw = source.getBgAnsi(HEADER_BG_COLOR_NAME);
	} catch {
		return undefined;
	}
	const key = `${raw}\u0000${length}`;
	if (headerBackgroundCache.has(key)) return headerBackgroundCache.get(key);

	const color = parseBgAnsi(raw);
	if (!color) return undefined;
	const start = color.rgb.map((value) => value * HEADER_BG_SCALE) as [number, number, number];
	const end = HEADER_BG_END_RGB;
	const cells: string[] = [];
	for (let index = 0; index < length; index += 1) {
		// 只有一格时没有距离可渐变，就停在起点
		const t = length < 2 ? 0 : index / (length - 1);
		cells.push(
			color.encode([
				start[0] + (end[0] - start[0]) * t,
				start[1] + (end[1] - start[1]) * t,
				start[2] + (end[2] - start[2]) * t,
			]),
		);
	}
	const background: HeaderBackground = { cells, end: color.encode(end) };
	// 正常一屏只用一两个可见格数（换终端宽度 / 换皮肤才会多），超了就整体清掉重算
	if (headerBackgroundCache.size >= 16) headerBackgroundCache.clear();
	headerBackgroundCache.set(key, background);
	return background;
}

/**
 * 毫秒时间戳（或 ISO 串）→ **本地** `HH:MM`；非法 / 缺失返回 undefined。
 * 用本地时区是刻意的：用户看的是自己墙上的钟，不是 UTC。
 */
export function formatClock(timestamp: unknown): string | undefined {
	let ms: number;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
		ms = timestamp;
	} else if (typeof timestamp === "string" && timestamp.trim() !== "") {
		ms = Date.parse(timestamp);
	} else {
		return undefined;
	}
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return undefined;
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 抬头那一行：`▏You 12:04 #12 · 1 compactions`。顶格画在消息框上方；底色是从消息底色
 * 变暗 25% 到**背景黑**的**逐字渐变**（`headerBackground`），长度 = 文字格数 + 20、碰到行右边界
 * 就截到边界，之后到行尾是背景色。
 *
 * `width` 是这一帧的渲染宽度：完整抬头（#12 + ` · 1 compactions`）时 29 列，正常终端永远装得下，
 * 但窄到装不下时**必须截断** —— pi-tui 的主屏渲染器发现任何一行超过终端宽度就抛错，整个 TUI 会崩。
 * 这里按**码点**逐个吃预算（引导符 / 空格 / `You` / 时间 / `#12` / 压缩段都只占 1 列），颜色开关
 * 不占预算。
 *
 * 尾缀是点缀，放不下就按「压缩次数 → 轮次号」的顺序**整段丢掉**，绝不截出 `#1` / `· 1` 这种假值，
 * 时间照常画。拿不到皮肤时输出**无色**的同一行（时间仍然有用），而不是整行不画；
 * 单个槽位缺失时该段退到兜底槽，全都缺失则该段无色。
 */
export function buildHeaderLine(
	source: ThemeColorSource | undefined,
	clock: string | undefined,
	width: number,
	turn?: number,
	compactions?: number,
): string | undefined {
	if (!clock || !Number.isFinite(width) || width < 1) return undefined;

	const lead = headerColor(source, HEADER_LEAD_COLOR, HEADER_LEAD_FALLBACKS);
	const label = headerColor(source, HEADER_LABEL_COLOR, HEADER_LABEL_FALLBACKS);
	const time = headerColor(source, HEADER_TIME_COLOR, HEADER_TIME_FALLBACKS);

	let remaining = Math.floor(width);
	const segments: Array<{ text: string; open: string; close: string }> = [];
	const push = (text: string, open: string, close: string): void => {
		if (remaining < 1) return;
		// 按码点切：将来若再出现代理对字符（emoji 等），也不会被劈成孤立代理项
		const visible = Array.from(text).slice(0, remaining);
		if (visible.length === 0) return;
		remaining -= visible.length;
		segments.push({ text: visible.join(""), open, close });
	};

	// 引导符走 `dim`：某些皮肤里它是 faint 标记（`\x1b[2m`），复位必须带上 `22`
	push(HEADER_LEAD, lead ?? "", lead ? "\u001b[22;39m" : "");
	push(HEADER_LABEL, label ? `${label}\u001b[1m` : "", label ? "\u001b[22m\u001b[39m" : "");
	// ` HH:MM #N · N compactions`：时间 → 轮次号 → 压缩次数（用户 2026-10-19 定），整段走 `dim`；
	// 开头那一格就是 `You` 后的空格
	const turnText = typeof turn === "number" && Number.isFinite(turn) ? ` #${turn}` : "";
	const compactionText =
		typeof compactions === "number" && Number.isFinite(compactions) ? ` · ${compactions} compactions` : "";
	// 尾缀整段放得下才画；放不下就从右往左丢（先压缩次数、再轮次号 —— 宁可少画，不能报假号），时间照常
	const bodyText =
		[` ${clock}${turnText}${compactionText}`, ` ${clock}${turnText}`, ` ${clock}`].find(
			(text) => Array.from(text).length <= remaining,
		) ?? ` ${clock}`;
	push(bodyText, time ?? "", time ? "\u001b[22;39m" : "");
	const columns = Math.floor(width);
	const length = columns - remaining;
	if (length < 1) return undefined;

	// 渐变跨度 = 文字格数 + 20 格（用户 2026-10-19 定）；碰到行右边界就以边界为准
	const gradientLength = Math.min(columns, length + HEADER_BG_TAIL);
	const background = headerBackground(source, gradientLength);
	let line = "";
	let column = 0;
	for (const segment of segments) {
		line += segment.open;
		for (const char of segment.text) {
			line += `${background?.cells[column] ?? ""}${char}`;
			column += 1;
		}
		line += segment.close;
	}
	if (background === undefined) return line;

	// 文字之后先把剩下的渐变尾巴铺完（每格一个空格，最多 20 格），剩下的行尾用背景色（渐变最后一格已经是它）
	let tail = "";
	for (let index = column; index < gradientLength; index += 1) tail += `${background.cells[index]} `;
	const rest = columns - gradientLength;
	// 行尾用 `49m` 收底，免得溢出到下一行
	return `${line}${tail}${rest > 0 ? `${background.end}${" ".repeat(rest)}` : ""}\u001b[49m`;
}

/** 组件实例上的发送时间槽位。`Symbol.for` 让 `/reload` 后新模块实例也读得到。 */
const TIMESTAMP_KEY = Symbol.for("pi-user-message-bar.timestamp");

/**
 * 组件实例上的发送时间（`HH:MM`），没有则 undefined。
 */
export function messageClock(component: object): string | undefined {
	const value = (component as Record<symbol, unknown>)[TIMESTAMP_KEY];
	return typeof value === "string" ? value : undefined;
}

/** 组件实例上的轮次号槽位（当前会话里第几条用户消息，1 起）。 */
const TURN_KEY = Symbol.for("pi-user-message-bar.turn");

/** 组件实例上的用户消息槽位（渲染时据此现查「发出时压缩过几次」）。 */
const MESSAGE_KEY = Symbol.for("pi-user-message-bar.message");

/** 组件上的用户消息对象，没有则 undefined。 */
function messageFor(component: object): object | undefined {
	const value = (component as Record<symbol, unknown>)[MESSAGE_KEY];
	return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * 「这条用户消息发出时压缩过几次」的查询函数，由 `index.ts` 用当前会话的分支实现。
 *
 * 挂 `globalThis`（`Symbol.for`）而不是模块作用域：`/reload` 后模块重新求值，但原型补丁仍在，
 * 它读的必须是同一个槽位；会话替换时由 `index.ts` 摘掉 —— 旧 sessionManager 可能随旧 ctx 一起
 * 作废。查询本身按消息现算、不按会话缓存（`/tree` 换分支、`/compact` 后再渲染都得按那一刻的
 * 分支算）；`messageCompactions` 里那份缓存是按**消息对象**的（详见那里的注解）。
 */
const COMPACTION_LOOKUP_KEY = Symbol.for("pi-user-message-bar.compaction-lookup");

export type CompactionLookup = (message: object) => number | undefined;

/** 装上 / 摘掉压缩次数查询函数（`undefined` = 摘掉，抬头就不画那一段）。 */
export function setCompactionLookup(lookup: CompactionLookup | undefined): void {
	const host = globalThis as Record<symbol, unknown>;
	if (lookup === undefined) delete host[COMPACTION_LOOKUP_KEY];
	else host[COMPACTION_LOOKUP_KEY] = lookup;
}

/**
 * 消息 → 压缩次数缓存。一条消息的压次是它自己那个条目的属性（父链定下就不再变），与当前
 * 分支无关，所以可以永久缓存（`WeakMap`，消息对象回收时一起没）。刚发出、还没落盘的消息查到
 * 的是「当前分支里已有的压缩数」，也就是它将要落的条目之后那个值 —— 同样不变。
 */
const COMPACTION_CACHE_KEY = Symbol.for("pi-user-message-bar.compaction-cache");

function compactionCache(): WeakMap<object, number> {
	const host = globalThis as Record<symbol, unknown>;
	let cache = host[COMPACTION_CACHE_KEY] as WeakMap<object, number> | undefined;
	if (cache === undefined) {
		cache = new WeakMap();
		host[COMPACTION_CACHE_KEY] = cache;
	}
	return cache;
}

/**
 * 组件上的压缩次数 —— **在渲染时现查**，不在 `addMessageToChat` 时快照。
 *
 * 这是必需的：`/resume` / `/new` / `/fork` 这些会话替换走的是
 * `rebindCurrentSession({ renderBeforeBind: true })` —— pi **先重画历史、再发 `session_start`**，
 * 所以那时查询函数还没装上（旧会话的已经随 `session_shutdown` 摘掉了）。快照的话这整屏历史就
 * 永远没有这一段；现查则下一帧查到就补上（主题颜色也是同一条路：渲染时现读）。
 *
 * 没装查询函数，或它抛异常（旧会话已作废）都返回 undefined —— 抬头少画这一段，而不是把异常
 * 扔进渲染 tick（那里没人接得住，会打死整个 pi）。
 */
export function messageCompactions(component: object): number | undefined {
	const message = messageFor(component);
	if (message === undefined) return undefined;
	const cache = compactionCache();
	const cached = cache.get(message);
	if (cached !== undefined) return cached;

	const lookup = (globalThis as Record<symbol, unknown>)[COMPACTION_LOOKUP_KEY];
	if (typeof lookup !== "function") return undefined;
	let count: number | undefined;
	try {
		const value = (lookup as CompactionLookup)(message);
		count = typeof value === "number" && Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
	if (count !== undefined) cache.set(message, count);
	return count;
}

/** 轮次计数的共享状态：`/reload` 后模块重新求值也要看到同一份，所以挂 `globalThis`。 */
const TURN_STATE_KEY = Symbol.for("pi-user-message-bar.turn-state");

interface TurnState {
	counter: number;
	assigned: WeakMap<object, number>;
}

function turnState(): TurnState {
	const host = globalThis as Record<symbol, unknown>;
	let state = host[TURN_STATE_KEY] as TurnState | undefined;
	if (state === undefined) {
		state = { counter: 0, assigned: new WeakMap() };
		host[TURN_STATE_KEY] = state;
	}
	return state;
}

/**
 * 清空轮次计数：新会话（startup / new / resume / fork）从 `#1` 开始。
 *
 * **`/reload` 不能清**：pi 会先 `rebuildChatFromMessages()` 重放整个聊天区、再发
 * `session_start`，此时号已经按历史重新摆好了，再清就会让下一条新消息从 `#1` 开始，
 * 而屏幕上明明还是 `#20` 那些号。
 */
export function resetUserMessageTurns(): void {
	const state = turnState();
	state.counter = 0;
	state.assigned = new WeakMap();
}

/**
 * 下一条用户消息的轮次号。重放时**沿用该消息上次拿到的号**（把它当游标回拨），
 * 于是 `/reload`、压缩重建、树导航这些「重新画一段历史」的路径上看到的编号与之前一致。
 * 没有记录的才是真正的新消息，序号递增。
 */
function assignTurn(message: object): number {
	const state = turnState();
	const previous = state.assigned.get(message);
	if (previous !== undefined) {
		state.counter = previous;
		return previous;
	}
	state.counter += 1;
	state.assigned.set(message, state.counter);
	return state.counter;
}

/** 组件上的轮次号，没有则 undefined。 */
export function messageTurn(component: object): number | undefined {
	const value = (component as Record<symbol, unknown>)[TURN_KEY];
	return typeof value === "number" ? value : undefined;
}

/**
 * 原型上的补丁状态。`Symbol.for` 走全局注册表，`/reload`（模块重新求值）后仍认得出这个原型
 * 已经被包过 —— 状态挂在原型上而不是模块作用域，为的是让 reload 后的新实例**更新取色源**
 * 而不是再包一层（旧的 ctx 可能已经作废，取色源必须换成新的）。
 */
const PATCH_KEY = Symbol.for("pi-user-message-bar.state");

/** 「打时间戳」补丁自己的幂等标记（它装在 `InteractiveMode` 原型上，与竖线补丁不共用一个原型）。 */
const TIMESTAMP_PATCHED = Symbol.for("pi-user-message-bar.timestamp.patched");

/** OSC 133 的「提示开始」zone 标记（pi 把用户消息的首行挂在 shell 集成 zone 里）。 */
const ZONE_START = "\u001b]133;A\u0007";

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
		const body = bar ? lines.map((line) => addBarToLine(line, bar)) : lines;

		const clock = messageClock(this as object);
		const turn = messageTurn(this as object);
		const compactions = messageCompactions(this as object);
		const width = typeof args[0] === "number" ? args[0] : 0;
		const header =
			clock === undefined ? undefined : buildHeaderLine(state.theme(), clock, width, turn, compactions);
		if (!header) return body;
		return [liftZoneStart(header, body), ...body];
	};
	return true;
}

/**
 * 抬头插在消息框上方，但 OSC 133 的 zone 起点必须留在整个消息的**第一行最前面**
 * （否则终端/shell 集成会把抬头排除在消息之外）。所以把首行开头的 zone 标记挪到抬头行上。
 * 就地改 `body[0]`（调用方传进来的就是我们自己 map 出来的新数组）。
 */
function liftZoneStart(header: string, body: string[]): string {
	const first = body[0] ?? "";
	if (!first.startsWith(ZONE_START)) return header;
	body[0] = first.slice(ZONE_START.length);
	return ZONE_START + header;
}

/** `addMessageToChat` 的容器只需要这一个字段（pi 的 `Container` 公开它）。 */
interface ChatContainerLike {
	children?: unknown[];
}

export interface UserMessageTimestampOptions {
	/** pi 的 `InteractiveMode` 类（补丁打在它的 `addMessageToChat` 上）。 */
	InteractiveMode: { prototype: Record<string | symbol, unknown> };
	/** pi 的 `UserMessageComponent` 类 —— 只用它的原型做 `instanceof`。 */
	UserMessageComponent: Function & { prototype: object };
}

/**
 * 装上「给用户消息打发送时间」的补丁，返回本次是否真的装了。
 *
 * 时间戳只存在于 `addMessageToChat(message)` 的 `message.timestamp` 上（实时发送与
 * resume 回放都有），而 `UserMessageComponent` 的构造参数里没有它。所以包住
 * `addMessageToChat`：调用期间新增的 `UserMessageComponent` 实例全部打上格式化后的时间。
 *
 * **必须装在 `session_start`**（此时所有扩展的模块求值都已完成，包装处在调用链最外层）：
 * 首屏历史消息在 `session_start` 之后才渲染，装在这里不会漏；而装早了会排到别的扩展补丁
 * 的里面 —— `skill-invocation-reorder` 对 `/skill:` 消息自己 `new UserMessageComponent`、
 * 不调用原函数，里层包装就永远看不到那条消息。
 */
export function installUserMessageTimestamp(options: UserMessageTimestampOptions): boolean {
	const prototype = options.InteractiveMode.prototype;
	if (prototype[TIMESTAMP_PATCHED]) return false;
	const original = prototype.addMessageToChat;
	if (typeof original !== "function") return false;

	const UserMessageComponent = options.UserMessageComponent;
	prototype[TIMESTAMP_PATCHED] = true;
	prototype.addMessageToChat = function (
		this: { chatContainer?: ChatContainerLike },
		message: { role?: string; timestamp?: unknown },
		...rest: unknown[]
	): unknown {
		const container = message?.role === "user" ? this.chatContainer : undefined;
		const children = container?.children;
		const before = Array.isArray(children) ? children.length : -1;
		try {
			return (original as (...args: unknown[]) => unknown).apply(this, [message, ...rest]);
		} finally {
			// 注意：finally 里不能 `return`，那会把原函数的返回值 / 异常一起吞掉
			if (before >= 0 && Array.isArray(children)) {
				const clock = formatClock(message?.timestamp);
				let turn: number | undefined;
				for (const child of children.slice(before)) {
					if (!(child instanceof UserMessageComponent)) continue;
					const record = child as Record<symbol, unknown>;
					if (clock !== undefined) record[TIMESTAMP_KEY] = clock;
					// 压缩次数不在这里快照：渲染时现查（会话替换先画历史、后发 session_start，见 messageCompactions）
					record[MESSAGE_KEY] = message;
					// 只有真的画出了一个用户消息组件才消耗一个轮次
					turn ??= assignTurn(message as object);
					record[TURN_KEY] = turn;
				}
			}
		}
	};
	return true;
}
