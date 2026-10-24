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
 * 框的**上方**再有一行发送时间（用户 2026-10-19 定；竖线照旧在最前）。形状是**两段带底色的
 * 文字块**，两段各以一个引导符 `▏` 起头（用户 2026-10-23 定，取代原先「整行纯文字」），
 * 行尾右端另有一段**只上前景 `dim` 的会话时长**（用户 2026-10-24 定）：
 *
 *     ▏You 12:04 #12 ▏0 compactions▕                          +38m
 *     ▏
 *     ▏ 正文正文
 *     ▏
 *
 * 时长右对齐贴到最后一列（用补白推到 `width`），口径是「**这条消息发出时**当前上下文窗口已经跑了
 * 多久」—— 见 `formatSessionAge` 与 `index.ts` 的 `sessionAgeLookup`。它不铺底色、不带竖线字形：那是
 * **这一行的注释**，不是第三个字块，压在色块里会抢走 `N compactions` 的视觉重量。
 *
 * **时长一旦画出来就冻结**（用户 2026-10-24 定）。这**不是**审美偏好，是正确性要求：抬头在视口之上，
 * 而 pi 的主屏渲染器（`TuiMainScreen`）一旦发现「首行变化落在视口之上」就 `fullRender(true)` ——
 * 写 `\x1b[2J\x1b[H\x1b[3J`，**清屏并清空整个 scrollback**，再从启动 logo 重画。旧实现让 `+Nm` 在
 * 渲染时读 `Date.now()`，于是任何一次重绘跨过分钟边界（`statusline` 每 30s 一次的 git 轮询就够了）
 * 都会改掉历史里的这一行 ⇒ 用户只是上翻看历史、什么都没动，屏幕就被拽回底部、历史也被抹掉。
 * 所以口径必须是**每条消息自己的、不变的**值（见 `messageAge`）。
 *
 * 行里有**三个竖线字形**：第一段开头的引导符 `▏`、第二段开头的 `▏`、第二段末尾的镜像 `▕`。它们就在
 * 各自的底色块里：**最左边那个保持 `text` 原色**（`HEADER_LEAD_DARKEN = 0`），**另外两个全黑**
 * （`HEADER_GLYPH_DARKEN = 1`，用户 2026-10-23 定）；同一块
 * 底色里的 `You` / 时间 / `#N` / `N compactions` 仍是原样的 `text`，加粗只作用于 `You`。
 * 第一段 `▏You 12:04 #12 `（**含尾随那一格**）的底色是 **`syntaxKeyword` 压暗 40%**
 * （`HEADER_BG_DARKEN` / `darkenAnsiBackground`）；第二段 `▏0 compactions▕` 两头各一个竖线字形 —— 开头是
 * 引导符 `▏`（`0` 左边那格，不再是空格）、结尾是它的镜像 `▕`（U+2595，替换原来那格行尾留白）；底色是
 * `thinkingText`（用户说的「Think 字体颜色」= pi 里 thinking 正文的那个槽）**再压暗 30%**
 * （`HEADER_THOUGHT_BG_DARKEN`）。`mdKeyword` 不是 pi 的主题槽（schema 里 `md*` 只有 heading / link /
 * code / quote / hr / listBullet），所以按「关键字色」落到 `syntaxKeyword`。
 *
 * 两块之间只有第一段尾格那一格空格；整行末尾也是**裸着的**（`49m` 收底），所以这一行不像消息框那样
 * 连成一片。
 * 时间走 **本地 24 小时制、两位补零**（`formatClock`，`9:33` → `09:33`）。`#12` 是当前会话里的第
 * 几条用户消息（1 起，回放 / 重建时沿用原编号）；` 0 compactions` 是**这条消息发出时**已经压缩
 * 过几次（0 也画；按当时的分支数，不是当前的累计值 —— 见 `setCompactionLookup`），且在**渲染时
 * 现查**（不在打戳时快照：会话替换会先把历史重画、再发 `session_start`，那时查询函数还没装上）。
 * 引导符与 `You` 之间不空；`You` 之后是 ` HH:MM #N `（时间前那格起头、轮次号后那格收尾）。
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
 * 竖线颜色取皮肤的 **`accent`** —— 这套皮肤里"强调/正向"的那个亮色。
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

/**
 * 抬头行**最左边**那个引导符 `▏` 的前景**压暗的比例**（用户 2026-10-23 定：`0` = 不压暗，
 * 与 `You` / 时间一样是原样的 `text`）。
 */
export const HEADER_LEAD_DARKEN = 0;

/**
 * 另外两个竖线字形（第二段开头的 `▏`、末尾的 `▕`）的前景**压暗的比例**（用户 2026-10-23 定：
 * `1` = 全暗，直接画成黑色）。
 *
 * 只作用于字形本身：同一块底色里的 `You` / 时间 / `#N` / `N compactions` 仍是原样的 `text`。
 * 按**已经解析出来的** `text` 色值算（见 `darkenAnsiForeground`），所以换肤自动跟随。
 */
export const HEADER_GLYPH_DARKEN = 1;

/** 抬头最前面的引导符（`▏` U+258F，与消息框竖线同字形；用户 2026-10-19 定）。 */
export const HEADER_LEAD = "\u258F";

/**
 * 第二段末尾的收尾符（`▕` U+2595，右八分之一块 —— `▏` 的镜像；用户 2026-10-23 定：
 * `compactions` 后面那格空格换成它，前景同样走 `text`）。
 */
export const HEADER_TAIL = "\u2595";

/**
 * 抬头第一段（`You HH:MM #N`）的底色槽：皮肤的语法关键字色（`pi-coder-1337` 的 `keyword` 变量就
 * 挂在它上面）。用户 2026-10-23 说的 `mdKeyword` 在 pi 的主题 schema 里**不存在**（`md*` 只有
 * heading / link / code / quote / hr / listBullet 那几个），按「关键字色」落到这个槽。
 */
const HEADER_BG_COLOR = "syntaxKeyword";

/**
 * 第一段（`▏You HH:MM #N `）的底色**压暗的比例**（用户 2026-10-23 定：10% → 30%；2026-10-24 再深一档到 40%）。
 *
 * 只作用于**底色**：两段文字的前景是皮肤正文色 `text`，不受它影响。压暗按**已经解析出来的那个
 * 颜色**算 —— 同一个槽位在不同皮肤 / 终端色深下是不同色值，逐皮肤改是不可能的（见
 * `darkenAnsiBackground`）。
 */
export const HEADER_BG_DARKEN = 0.4;

/** 第二段（` N compactions `）的底色槽：pi 里 thinking 正文用的那个槽（用户说的「Think 字体颜色」）。 */
const HEADER_THOUGHT_BG_COLOR = "thinkingText";

/**
 * 第二段底色的**压暗的比例**（用户 2026-10-23 定：20%，与第一段的 30% 分开；2026-10-24 两段各加
 * 10 个百分点 → 30%，仍比第一段浅一档）。
 *
 * 本来就比第一段暗的槽（nightfox 的 `thinkingText` 是 `#6d6d6d`）只会变更深，不会变亮。
 */
export const HEADER_THOUGHT_BG_DARKEN = 0.3;

/** 两段文字共用的前景槽：皮肤的正文色。 */
const HEADER_TEXT_COLOR = "text";

/** 抬头右端那个时长用的前景槽（用户 2026-10-24 定：只上前景、不铺底色 —— 它是这一行的注释，
 * 不是第三个字块，压在色块里会抢走 `N compactions` 的视觉重量）。 */
const HEADER_AGE_COLOR = "dim";

/** 槽位缺失时的兜底顺序（旧皮肤可能没有这些槽；正文色没有就整个不铺字了，直接用终端默认）。 */
const HEADER_BG_FALLBACKS = ["accent", "selectedBg", "muted", "text"] as const;
const HEADER_THOUGHT_BG_FALLBACKS = ["dim", "muted", "selectedBg", "text"] as const;
const HEADER_TEXT_FALLBACKS = ["userMessageText"] as const;

/**
 * xterm 256 色阶：6×6×6 立方体的六个阶 + 24 阶灰阶。只用于索引 ↔ RGB 反算。
 * 基本 16 色（索引 < 16）不在这张表里 —— 它们由终端自己决定色值，换算会换掉色系。
 */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];
const GRAY_LEVELS = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** 256 色索引 → RGB（≥16 时，与 pi-tui 的 `indexedToRgb` 同表）。 */
function indexedToRgb(index: number): Rgb {
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return { r: gray, g: gray, b: gray };
	}
	const cube = index - 16;
	return {
		r: CUBE_LEVELS[Math.floor(cube / 36)] ?? 0,
		g: CUBE_LEVELS[Math.floor((cube % 36) / 6)] ?? 0,
		b: CUBE_LEVELS[cube % 6] ?? 0,
	};
}

/** 最接近 `target` 的那一阶（同距取靠前，与 pi-tui 一致）。 */
function closestIndex(values: readonly number[], target: number): number {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < values.length; index += 1) {
		const distance = Math.abs(target - (values[index] ?? 0));
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}

/** 加权色距（灰度感知权重，与 pi-tui 的 `colorDistance` 一致）。 */
const weightedDistance = (a: Rgb, b: Rgb): number => {
	const dr = a.r - b.r;
	const dg = a.g - b.g;
	const db = a.b - b.b;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
};

/** RGB → 最接近的 256 色索引（与 pi-tui 的 `rgbToAnsi256` 同算法，含灰阶优先判定）。 */
function rgbToIndexed({ r, g, b }: Rgb): number {
	const rIndex = closestIndex(CUBE_LEVELS, r);
	const gIndex = closestIndex(CUBE_LEVELS, g);
	const bIndex = closestIndex(CUBE_LEVELS, b);
	const cube: Rgb = {
		r: CUBE_LEVELS[rIndex] ?? 0,
		g: CUBE_LEVELS[gIndex] ?? 0,
		b: CUBE_LEVELS[bIndex] ?? 0,
	};
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayOffset = closestIndex(GRAY_LEVELS, gray);
	const grayValue = GRAY_LEVELS[grayOffset] ?? 0;
	const spread = Math.max(r, g, b) - Math.min(r, g, b);
	if (spread < 10 && weightedDistance({ r, g, b }, { r: grayValue, g: grayValue, b: grayValue }) < weightedDistance({ r, g, b }, cube)) {
		return 232 + grayOffset;
	}
	return 16 + 36 * rIndex + 6 * gIndex + bIndex;
}

/**
 * 把一段**前景色** ANSI 按比例压暗（`amount` = 0.2 表示暗 20%），输出仍是同一色深下的前景序列。
 *
 * 三种情形：
 *   - `\x1b[38;2;r;g;b m`（truecolor）：三通道各乘 `1 - amount` —— 就是「这个色值暗 20%」的直白读法。
 *   - `\x1b[38;5;N m`（256 色）：先按 xterm 调色板反算 RGB、压暗，再量化回最接近的索引，
 *     所以输出的仍是终端认识的那个色深（不会在 256 色终端里冒出 truecolor 序列）；
 *     基本 16 色（N < 16）原样返回 —— 它们的实际色值由终端自己决定，换算会换掉色系。
 *   - 其它（无色、非前景序列、参数个数不认识）：原样返回，不猜。
 *
 * 序列尾部的附加属性（例如 `dim` 槽位带的 `\x1b[2m`）原样保留。
 *
 * `amount` 允许到 `1`：那是「全暗」，三通道全部归零（黑色）；只有 `> 1` 这种算不出来的比例才原样返回。
 */
export function darkenAnsiForeground(ansi: string, amount: number): string {
	return darkenAnsi(ansi, amount, 38);
}

/**
 * 把一段**背景色** ANSI 按比例压暗；规则与 `darkenAnsiForeground` 完全同构，只是认 `48` 那条序列
 * （24 位色 `48;2;r;g;b` 与 256 色 `48;5;N`），输出仍是背景序列。
 *
 * 抬头的底色块走这条路：`theme.getBgAnsi` 给的就是 `\x1b[48;…m`，压暗后直接当底色用。
 */
export function darkenAnsiBackground(ansi: string, amount: number): string {
	return darkenAnsi(ansi, amount, 48);
}

/** `darkenAnsiForeground` / `darkenAnsiBackground` 的共同实现（`slot` 是 `38` 或 `48`）。 */
function darkenAnsi(ansi: string, amount: number, slot: 38 | 48): string {
	// `amount === 1` 是合法的「全暗」（乘 0 = 黑色），只有 0 / 越界 / 非数字才不碰
	if (!Number.isFinite(amount) || amount <= 0 || amount > 1) return ansi;
	const match = new RegExp(`^\\u001b\\[${slot};([25]);([0-9;]+)m([\\s\\S]*)$`).exec(ansi);
	if (!match) return ansi;
	const kind = match[1];
	const params = (match[2] ?? "").split(";").map((value) => Number.parseInt(value, 10));
	const tail = match[3] ?? "";
	if (params.some((value) => !Number.isFinite(value))) return ansi;
	const factor = 1 - amount;

	if (kind === "2") {
		if (params.length !== 3) return ansi;
		const [r, g, b] = params as [number, number, number];
		const dark = (channel: number): number => Math.round(channel * factor);
		return `\u001b[${slot};2;${dark(r)};${dark(g)};${dark(b)}m${tail}`;
	}

	if (params.length !== 1) return ansi;
	const index = params[0] as number;
	if (index < 16 || index > 255) return ansi;
	const rgb = indexedToRgb(index);
	const dark: Rgb = { r: rgb.r * factor, g: rgb.g * factor, b: rgb.b * factor };
	return `\u001b[${slot};5;${rgbToIndexed(dark)}m${tail}`;
}

/** 前景槽 ANSI；缺失返回 undefined（调用方据此不套颜色，而不是抛）。 */
function headerFg(
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

/**
 * 背景槽 ANSI（**原样的背景序列**，不做 48→38 的转换）；缺失 / 该槽其实是终端默认底色时返回
 * undefined —— 调用方据此不铺底色，而不是把文字埋在看不见的地方。
 *
 * 背景槽也可能被皮肤写在**前景**位（旧皮肤、以及 `thinkingText` 这种本来就只有前景的槽）：
 * 那就把 `38` 等值换成 `48` 拿来当底色用。
 */
function headerBg(
	source: ThemeColorSource | undefined,
	preferred: string,
	fallbacks: readonly string[],
): string | undefined {
	if (!source) return undefined;
	for (const name of [preferred, ...fallbacks]) {
		try {
			const ansi = source.getBgAnsi(name);
			if (ansi.startsWith("\u001b[48;")) return ansi;
		} catch {
			// 不是背景槽：接着当前景槽试
		}
		try {
			const ansi = source.getFgAnsi(name);
			if (ansi.startsWith("\u001b[38;")) return ansi.replace("\u001b[38;", "\u001b[48;");
		} catch {
			// 这个皮肤没有这个槽位：试下一个
		}
	}
	return undefined;
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
 * 会话时长（用户 2026-10-24 定）：从**当前上下文窗口的第一轮对话**算到**这条消息发出那一刻**，
 * 形如 `+38m`。**算一次就定死**，不随渲染时钟更新（理由见文件头：视口之上的一行一变就会触发
 * pi 的清屏 + 清 scrollback 整屏重画）。
 *
 * 单位选择与 `background-tasks` 的 `formatElapsed` 刻意不同 —— 那个是给后台任务报进展的，
 * 精确到秒（`38m7s`）；这里是「这场对话跑了多久」的粗粒度提示，只换一次量级，位数更稳定：
 *   - 不足一分钟 → `+0m`（不报秒：快速问答不值得占两格去秒级抖动）
 *   - 一小时以内 → `+38m`
 *   - 超过一小时 → `+2h35m`（不丢分钟：到了这个量级，`+2h` 太粗）
 * 负值 / 非数 / 传入 undefined 一律当 0（时钟回拨不该在抬头上画出 `+-3m`）。
 */
export function formatSessionAge(ms: number | undefined): string {
	const safe = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
	const minutes = Math.floor(safe / 60_000);
	if (minutes < 60) return `+${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `+${hours}h${minutes % 60}m`;
}

/**
 * 抬头那一行：`▏You 12:04 #12   0 compactions`（两段带底色的文字块，中间空两格）。
 *
 *   1. `▏You 12:04 #12 `（**含前面那个引导符与尾部那一格**）：底 = `syntaxKeyword` **压暗 40%**，字 = `text`，`You` 加粗；
 *   2. `▏0 compactions▕`（**两头各一个竖线字形**：开头的引导符 + 结尾的镜像 `▕`）：底 = `thinkingText`
 *      （用户说的「Think 字体颜色」）**再压暗 30%**，字 = `text`。
 *
 * 竖线字形的前景：行首那个 `▏` 就是 `text` 本来的颜色（不压暗），第二段的 `▏` 与末尾的 `▕` 全黑
 * （`leadColor` / `glyphColor`，`applyGlyphColor` 逐个字形换色后立刻
 * 还原，所以后面的字符不会继承暗色）。
 *
 * 用户 2026-10-23 的原话把竖线也算在第一段里（「这几个字的前景色都改为 fg 的颜色」）—— 所以引导符
 * 就坐在第一块底色里、也是 `text` 前景，不在外面裸着。
 *
 * 两段之间没有额外分隔，就是「第一段的尾格」那一格空格；两段之间的底色断开（每块自己 `49m` 收尾），
 * 所以看着是两个色块而不是一条长条。
 *
 * `width` 是这一帧的渲染宽度：窄到装不下时**必须退** —— pi-tui 的主屏渲染器发现任何一行超过终端
 * 宽度就抛错，整个 TUI 会崩。这里按**码点**逐个吃预算（引导符 / 空格 / `You` / 时间 / `#12` /
 * 压缩段都只占 1 列），颜色开关不占预算。
 *
 * 退化顺序：压缩块整段丢掉 → `#12` 整段丢掉（连同它前面那格）→ 最后才截时间；绝不截出 `0` /
 * `#1` 这种假值。拿不到皮肤时输出**无色**的同一行（时间仍然有用），而不是整行不画；
 * 单个槽位缺失时该段退到兜底槽，全都缺失则该段无色（不铺底）。
 */
export function buildHeaderLine(
	source: ThemeColorSource | undefined,
	clock: string | undefined,
	width: number,
	turn?: number,
	compactions?: number,
	age?: number,
): string | undefined {
	if (!clock || !Number.isFinite(width) || width < 1) return undefined;

	const columns = Math.floor(width);
	// 第一段底色 = `syntaxKeyword` **压暗 40%**；引导符就在这块底色里（用户 2026-10-24 定）
	const partBg = headerBg(source, HEADER_BG_COLOR, HEADER_BG_FALLBACKS);
	const cardBg = partBg === undefined ? undefined : darkenAnsiBackground(partBg, HEADER_BG_DARKEN);
	// 第二段底色 = thinking 正文色（用户说的「Think 字体颜色」）**再压暗 30%**
	const thoughtSource = headerBg(source, HEADER_THOUGHT_BG_COLOR, HEADER_THOUGHT_BG_FALLBACKS);
	const thoughtBg =
		thoughtSource === undefined ? undefined : darkenAnsiBackground(thoughtSource, HEADER_THOUGHT_BG_DARKEN);
	// 两段文字都是皮肤的正文色。最左边的引导符不压暗（= 就是 `text`），另外两个竖线字形全暗
	// （用户 2026-10-23 定）；`darkenAnsiForeground` 的比例为 0 时原样返回，所以前者天然等于 `fgColor`
	const fgColor = headerFg(source, HEADER_TEXT_COLOR, HEADER_TEXT_FALLBACKS);
	const leadColor = fgColor === undefined ? undefined : darkenAnsiForeground(fgColor, HEADER_LEAD_DARKEN);
	const glyphColor = fgColor === undefined ? undefined : darkenAnsiForeground(fgColor, HEADER_GLYPH_DARKEN);
	// 右端时长：只上前景，不铺底色（用户 2026-10-24 定）。取不到 dim 就整段不画 —— 用 `text` 顶上
	// 会让它和左边字块里的正文同色，视觉上抢戏，比不显示更差
	const ageColor = headerFg(source, HEADER_AGE_COLOR, []);
	const ageText = typeof age === "number" && Number.isFinite(age) ? formatSessionAge(age) : undefined;

	const turnText = typeof turn === "number" && Number.isFinite(turn) ? ` #${turn}` : "";
	const compactionText =
		typeof compactions === "number" && Number.isFinite(compactions) ? `${compactions} compactions` : undefined;

	/** 一个带底色的字块：底色贯穿整段（含首尾那几格空格），字块结尾同时收掉底色与前景。 */
	interface Chunk {
		text: string;
		bg: string | undefined;
	}
	const chunk = (text: string, bg: string | undefined): Chunk => ({ text, bg });
	const widthOf = (chunks: readonly Chunk[]): number =>
		chunks.reduce((sum, item) => sum + Array.from(item.text).length, 0);

	// 放不下就整段丢：先丢压缩块、再丢轮次号，最后才截时间（绝不截出 `0` / `#1` 这种假值）。
	// 两段之间没有额外空格 —— 已包含在第一段的尾格与第二段的首格里（用户 2026-10-23 定）。
	// 第二段是 `▏N compactions▕`：`0` 左边那格也是引导符（不再是空格），末尾那格是它的镜像
	// `▕`（不再是行尾留白）；两块之间那一格由第一段的尾格提供，前景两边都是 `text`
	const thoughtText =
		compactionText === undefined ? undefined : `${HEADER_LEAD}${compactionText}${HEADER_TAIL}`;
	const layouts: Chunk[][] = [];
	for (const head of [`${HEADER_LEAD}${HEADER_LABEL} ${clock}${turnText} `, `${HEADER_LEAD}${HEADER_LABEL} ${clock} `]) {
		if (thoughtText !== undefined) layouts.push([chunk(head, cardBg), chunk(thoughtText, thoughtBg)]);
		layouts.push([chunk(head, cardBg)]);
	}
	// 右端时长与左段之间的间隔就是第一段那个尾随空格 + 这里的一格 —— 右段自己带前导空格，
	// 于是至少总能和左边的色块分开（贴上去会看着像被人挤到了色块边上）。
	// 它**不参与 layout 选择**：选哪一级只由左边两块决定，窄了就少画它（age 是装饰性的右侧平衡，
	// 不该夺走 `N compactions` 这种真信息）
	const ageChunk =
		ageText === undefined || ageColor === undefined ? undefined : { text: ` ${ageText}`, color: ageColor };
	const chosen = layouts.find((items) => widthOf(items) <= columns);

	// 连最短那一级都放不下：与旧行为一致，按码点截断（引导符先占一格）
	if (chosen === undefined) {
		const visible = Array.from(`${HEADER_LEAD}${HEADER_LABEL} ${clock}`).slice(0, columns).join("");
		return fgColor === undefined ? visible : `${fgColor}${visible}\u001b[39m`;
	}

	// 最后一个字块没底色、也没前景时（拿不到皮肤、或槽位全缺），尾格只剩白地白字 —— 吃掉，别拉出
	// 一行白边。有底色 / 有前景时**不吃**：那一格是块尾留白，或者已经是收尾符 `▕`
	const tail = chosen[chosen.length - 1];
	if (tail !== undefined && tail.bg === undefined && fgColor === undefined) {
		chosen[chosen.length - 1] = { text: tail.text.trimEnd(), bg: tail.bg };
	}

	let line = "";
	for (const [index, item] of chosen.entries()) {
		const colors = `${fgColor ?? ""}${item.bg ?? ""}`;
		const close = item.bg === undefined ? (fgColor === undefined ? "" : "\u001b[39m") : "\u001b[49m\u001b[39m";
		if (index === 0 && fgColor !== undefined) {
			// `You` 加粗（用户没让它取消）：`22m` 只收粗体，不碰同一个字块里的前景与底色。
			// 拿不到皮肤时不加粗，整行保持无色的纯文本
			const bold = `${HEADER_LEAD}${HEADER_LABEL}`;
			const rest = item.text.slice(bold.length);
			// 加粗段里也换竖线色：38 不改粗体状态，所以换完仍是粗体。
			// 这一段开头的 `▏` 就是整行最左边那个，走不压暗的 `leadColor`
			line += `${colors}\u001b[1m${applyGlyphColor(bold, leadColor, glyphColor, fgColor, true)}\u001b[22m${rest}${close}`;
			continue;
		}
		line += `${colors}${applyGlyphColor(item.text, leadColor, glyphColor, fgColor, false)}${close}`;
	}
	// 右端时长：把整行补到 `columns` 宽再写它，于是它总贴着终端右边缘（且不前导空格吃掉半边）；
	// 宽度不够时整段不画 —— 绝不截出假值，也绝不拒不让位给左边两块
	if (ageChunk !== undefined) {
		const pad = columns - widthOf(chosen) - Array.from(ageChunk.text).length;
		if (pad >= 0) line += `${" ".repeat(pad)}${ageChunk.color}${ageChunk.text}\u001b[22;39m`;
	}
	return line;
}

/**
 * 把一段文本里的竖线字形（`▏` / `▕`）换成各自的前景色 —— 底色不动，字块里其余字符继续用原来的
 * `text`。
 *
 * 两档色是分开的：`firstIsLead` 为真时，这一段**第一个字符**若就是 `▏`（整行最左边那个引导符），
 * 用 `leadColor`（默认不压暗）；其余字形用 `darkColor`。某个色缺省、或者算出来与 `fgColor` 一模一样
 * 时，那个字形直接跟正文同色、不插多余的转义。
 *
 * 每个字形后面立刻补回原来的前景色，所以后面那个字符不会继承竖线的暗色。
 */
function applyGlyphColor(
	text: string,
	leadColor: string | undefined,
	darkColor: string | undefined,
	fgColor: string | undefined,
	firstIsLead: boolean,
): string {
	const restore = fgColor === undefined ? "\u001b[39m" : fgColor;
	let out = "";
	let index = 0;
	for (const char of text) {
		const glyph = char === HEADER_LEAD || char === HEADER_TAIL;
		const color = !glyph ? undefined : firstIsLead && index === 0 && char === HEADER_LEAD ? leadColor : darkColor;
		out += color === undefined || color === fgColor ? char : `${color}${char}${restore}`;
		index += 1;
	}
	return out;
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

/**
 * 「这场对话跑了多久」的查询函数（毫秒），由 `index.ts` 用当前会话的分支实现。
 *
 * 与 `CompactionLookup` 同一套生命周期（`globalThis` + `Symbol.for`，`session_shutdown` 时摘掉）——
 * 旧 sessionManager 会随旧 ctx 一起作废。它是**整行共用的值**（不按消息），因为抬头画的是「现在
 * 这个上下文窗口已经跑了多久」，与这条消息何时发出无关。
 */
const AGE_LOOKUP_KEY = Symbol.for("pi-user-message-bar.age-lookup");

export type AgeLookup = (message: object) => number | undefined;

/** 装上 / 摘掉会话时长查询函数（`undefined` = 摘掉，抬头右端就不画那一段）。 */
export function setAgeLookup(lookup: AgeLookup | undefined): void {
	const host = globalThis as Record<symbol, unknown>;
	if (lookup === undefined) delete host[AGE_LOOKUP_KEY];
	else host[AGE_LOOKUP_KEY] = lookup;
}

/**
 * 消息 → 会话时长缓存。与压缩次数同一套理由，但更硬：**这里缓存的是「冻结」本身**。
 *
 * 抬头在视口之上，pi 的主屏渲染器一旦发现视口之上有任何一行变了就整屏重画并清 scrollback
 * （见文件头）。所以一条消息的抬头必须**逐字节稳定**：第一次算出来是什么，之后永远是什么。
 */
const AGE_CACHE_KEY = Symbol.for("pi-user-message-bar.age-cache");

function ageCache(): WeakMap<object, number> {
	const host = globalThis as Record<symbol, unknown>;
	let cache = host[AGE_CACHE_KEY] as WeakMap<object, number> | undefined;
	if (cache === undefined) {
		cache = new WeakMap();
		host[AGE_CACHE_KEY] = cache;
	}
	return cache;
}

/**
 * 这条消息的抬头该显示的会话时长（毫秒）—— **第一次问就定死**，同一个消息对象之后永远返回同一个值。
 *
 * 为什么不再「渲染时现算」：那会让 `+Nm` 跨过分钟边界时改掉历史里的一行，而 pi 的主屏渲染器看到
 * 视口之上有变化就会清屏 + 清 scrollback 整屏重画 —— 用户只是上翻看历史、什么都没动，屏幕却被
 * 拽回底部、历史也被抹掉（2026-10-24 实测：`statusline` 每 30s 的 git 轮询是那次重绘的鼓点）。
 *
 * 口径因此是「**这条消息发出时**窗口已经跑了多久」，它只依赖两个都不再变的量（消息自己的
 * `timestamp`、以及当时窗口的起点），天然稳定，重放 / 恢复会话也是同一个值。
 *
 * 缓存还兼任会话替换窗口的保护：`session_shutdown` 摘掉查询函数后、下一个 `session_start` 之前，
 * pi 会先把历史重画一遍（`renderBeforeBind`）—— 已算过的消息走缓存照常显示，不会闪成没有右段。
 *
 * 没装查询函数 / 拿不到这条消息的值 / 它抛异常（旧会话已作废）都返回 undefined —— 抬头右端少画
 * 这一段，而不是把异常扔进渲染 tick（那里没人接得住，会打死整个 pi）。
 */
export function messageAge(component: object): number | undefined {
	const message = messageFor(component);
	if (message === undefined) return undefined;
	const cache = ageCache();
	const cached = cache.get(message);
	if (cached !== undefined) return cached;

	const lookup = (globalThis as Record<symbol, unknown>)[AGE_LOOKUP_KEY];
	if (typeof lookup !== "function") return undefined;
	let age: number | undefined;
	try {
		const value = (lookup as AgeLookup)(message);
		age = typeof value === "number" && Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
	if (age !== undefined) cache.set(message, age);
	return age;
}

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
		// 已冻结的「发出时窗口跑了多久」—— 不能改成实时值，见 messageAge
		const age = messageAge(this as object);
		const width = typeof args[0] === "number" ? args[0] : 0;
		const header =
			clock === undefined
				? undefined
				: buildHeaderLine(state.theme(), clock, width, turn, compactions, age);
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
