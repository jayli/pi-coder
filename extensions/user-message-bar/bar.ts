/**
 * user-message-bar — 纯逻辑：用户消息正文首行加一个 `›` 标记
 *
 * 用户消息框本来就是 `Box(paddingX = outputPad, paddingY = 1)` + `userMessageBg` 底色，
 * 上下各一行空白内边距。本扩展只在**第一条有正文的行**行首画 `›`，后面空一格：
 *
 *     › 正文正文
 *
 * 正文续行、正文块内的空行以及 Box 自己那两条上下内边距行都不再画字形。为了保持正文的横向
 * 起点不变，所有有正文的行都沿用两格 gutter：首行是 `› `，续行是两个空格。
 *
 * 曾经还有一行**框上方的抬头**（`You 12:04 #12 • 0 compactions … +38m`）与它的 `/title-bar on|off`
 * 开关，2026-10-27 整体移除（用户：没用了，放着浪费）。抬头的文字（时间 / 轮次号 / 压缩次数 /
 * 会话时长）与那些色槽、格式化函数都一并删除。
 *
 * ## 消息框上方那条空行（用户 2026-10-26 定，抬头删后改无条件）
 *
 * 这条空行**不是**抬头的残留，是用户要的一道缝：`startup-logo` 说明段的最后一行
 * `╵  ╵   ╰─╴╰─╯╶┴╯╰─╴╵╰╴` 底下紧接就是方框的第一个内边距行，两条粘成一块。所以会话里的
 * **第一条**用户消息上方永远补一条**裸空行**（`addMessageBoxGap`）；抬头在时它是「抬头关掉之后
 * 才补」，抬头删掉后就变成「一直补」。
 *
 * “只补第一条”的理由：pi 的 `addMessageToChat` 只在聊天区**非空**时补前置 `Spacer(1)`，所以第一
 * 条才是真的贴在上面；之后每条前面本来就有 pi 自己那条空行，再补就成两条。
 *
 * 只在头顶确实是 `startup-logo` 自己画的 header 时才补（`startupLogoOwnsHeader`）：它把 pi 内置
 * header 静音的同时连下方那条 `Spacer(1)` 也一起没了；内置 header 还在时 pi 自己就给那条缝，
 * 再补就是两条。`/clear`、`/new`、`/resume` 之后聊天区又是空的，所以那条缝会被重新补上。
 *
 * 标记占的正是**原本就存在的那一格左内边距**：把正文首行第一格空格换成 `›`；正文前多空的那一格
 * （`BAR_INDENT`）则从**行尾补白**里等量吃掉，于是底色、行宽、正文折行位置全都与改之前一模一样。
 * 一格都不能靠「加一格等终端截断」省事 —— pi-tui 的主屏渲染器发现任何一行超过终端宽度就
 * **直接抛错**（`tui-main-screen.js` 先把整屏 dump 进 `pi-tui-crash.log`，再 throw
 * `Rendered line N exceeds terminal width`），整个 TUI 会崩掉。
 *
 * 行尾那格补白一定够吃：`paddingX = 1` 时 Box 只给孩子 `width - 2` 列，正文再长也留得下一格。
 * `outputPad = 0`（pi 的设置项）时行首没有内边距可占，标记 + 缩进共两格都得向行尾借 —— 借不够
 * 就先保住标记（少空那一格），连一格都借不出来时这行干脆不加（宁可少画，不能撑宽）。
 *
 * 标记颜色取皮肤的 **`muted`**，字形本身加粗，与正文形成清楚的层级差。
 * 它是**前景**槽，直接拿 `getFgAnsi` 用；想换别的槽位（包括 `selectedBg` 这种背景槽，会做一次
 * 48→38 的等值转换当前景用）用 `PI_USER_MESSAGE_BAR_COLOR=<皮肤槽位名>`。标记自带前景复位，
 * 所以标记后面那个空格不会被染上前景色。
 *
 * 标记那一格**跟着消息底色**（不抠）：Box 把整行裹在 `theme.bg("userMessageBg", …)` 里，
 * 标记就坐在里面，字形与底色块连成一片。曾经在标记前插 `49m`、画完再还原，让那一格裸着，
 * 结果底色块左边缘被抠出一个缺角 —— 实测观感更差，已回退（别再改回去）。
 *
 * 为什么必须打原型补丁：pi 的扩展 API 里跟用户消息沾边的只有 `registerMarkdownTransformer`，
 * 它是**字符串级**的、只看得见正文源文，看不见 Box 补出来的上下空白行与左内边距 —— 而那两样
 * 恰是这里要画标记的地方。所以只能接管 `UserMessageComponent.prototype.render`。
 *
 * 补丁为什么打得中（跨模块实例）：`pi` 命令跑的是 `dist/bundle/cli.js`，扩展加载器在 bundle /
 * 编译二进制形态下把 `@earendil-works/pi-coding-agent` 指向加载器那份 **bundle 自己的命名空间**
 * （`core/extensions/loader.js` 的 `virtualModules` 分支），也就是 pi 渲染时用的同一个类。
 * `index.test.ts` 断言的就是这条端到端链路（拿 pi 自己导出的 `UserMessageComponent` 渲染）。
 *
 * 本模块不 import pi / pi-tui：取色源与组件类都由调用方注入，`node --test` 能直跑。
 */

/** 正文首行标记：`›`（U+203A）。 */
export const BAR_GLYPH = "\u203A";

/** 标记与正文之间空出的半角格数（正文因此从第 3 列开始）。 */
export const BAR_INDENT = 1;

/**
 * 「启动那一刻 pi 的内置 header 被 `startup-logo` 静音了」这个进程级事实的全局符号键。
 *
 * 与 `startup-logo/boot-suppress.ts` 的 `BOOT_SUPPRESSED_KEY` **必须字面相同**。这里不 import
 * 那个模块：两扩展各自可单独装卸，写死的软连接只读一个 `Symbol.for` 键，缺一边时只是漏一条
 * 空行，不会把本扩展整体加载失败。
 */
const STARTUP_LOGO_SUPPRESSED_KEY = Symbol.for("litellm-any.pi-startup-logo.bootSuppressed");

/**
 * 头顶那块 header 是不是 `startup-logo` 自己画的（而不是 pi 内置那只 `▀▀█ v1.4.0`）。
 *
 * 只有它为真时才需要自己补那条空行：`startup-logo` 静音内置 header 之后 pi 走 minimal 分支，
 * 连内置 header **下方**那条 `Spacer(1)` 也一起没了（内置分支是 `Spacer(1) + header +
 * Spacer(1)`），于是那句 `This pi harness is powered by latest @bachi/` 字形的最后一行与消息框
 * 之间一点缝都没有。内置 header 还在时 pi 自己会给那条缝，再补就是两条。
 */
export function startupLogoOwnsHeader(): boolean {
	try {
		return (globalThis as Record<symbol, unknown>)[STARTUP_LOGO_SUPPRESSED_KEY] === true;
	} catch {
		return false;
	}
}

/** 默认取色槽：皮肤的弱化文字色（`muted`，见文件头）。 */
export const DEFAULT_COLOR_NAME = "muted";

/**
 * 组件实例上的「该拿上方那条空行」标记（见 `addMessageBoxGap`）。
 *
 * 为什么在 `addMessageToChat` 里打标记而不是渲染时现找容器：组件自己看不见兄弟、也看不见
 * 父容器，而“我是不是会话里第一条用户消息”恰好就是容器长度能回答的那个问题。
 */
const GAP_KEY = Symbol.for("pi-user-message-bar.gap");

/**
 * 首选槽位取不到时的兜底顺序（皮肤可能不定义 `muted`）：
 * 选中色 → diff 新增行行号色 → 正文色。
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
const FULL_ANSI = new RegExp(ANSI_PART, "g");

/** OSC 133 的「提示开始」zone 标记（pi 把用户消息的首行挂在 shell 集成 zone 里）。 */
const ZONE_START = "\u001b]133;A\u0007";

/**
 * 给正文首行加标记：吃掉落内边距那一格空格换成标记，正文前空 `indent` 格，
 * 空出来的这几格从行尾补白里等量吃掉 —— 整行可见宽度与原来完全一致。
 *
 * 标记**不抠底色**：它直接坐在 Box 的 `userMessageBg` 里（pi 的 Box 把整行裹在
 * `theme.bg("userMessageBg", …)` 中），于是那一格与整块消息底色连成一片、只在左边缘多出一个
 * 字形。曾经在标记前插 `49m` 再还原，结果底色块左边缘被抠出一个缺角，观感反而更差（已回退）。
 *
 * 四种边角情况（都不撑宽，最坏是这一行没有标记）：
 *   - `outputPad = 0`（pi 的设置项）时行首就是正文，那一格内边距不存在 —— 标记本身也得从
 *     行尾补白里借一格，标记插在正文前面。
 *   - 行尾补白不够空 `indent` 格时退化成「只加标记、不空那一格」。
 *   - 行尾连标记那一格都借不出来（正文正好铺满一行）时原样返回。
 */
export function addBarToLine(line: string, bar: string, indent: number = BAR_INDENT): string {
	const head = LEADING_ANSI.exec(line)?.[0] ?? "";
	const rest = line.slice(head.length);

	// Box 的左内边距（0 / 1 格）：在的话这一格直接当标记的落脚点
	const pad = rest.startsWith(" ") ? 1 : 0;
	const body = pad === 1 ? rest.slice(1) : rest;

	const padding = trailingSpaceRun(body);
	const spare = padding ? padding.end - padding.start : 0;
	const neededByBar = 1 - pad; // 标记自己要从行尾借的格数
	if (spare < neededByBar) return line;

	const used = Math.min(indent, spare - neededByBar);
	const dropped = neededByBar + used;
	const trimmed = padding ? body.slice(0, padding.end - dropped) + body.slice(padding.end) : body;

	return `${head}${bar}${" ".repeat(used)}${trimmed}`;
}

/**
 * 给正文续行补足 gutter：首行是 `› `，这些行则对齐成两格空格。
 *
 * 插入的空格同样从行尾补白里吃掉。`outputPad = 1` 时只需补一格；`outputPad = 0` 时需要补两格。
 * 行尾不够时这一行保持原样，绝不撑宽。
 */
export function addBodyIndentToLine(line: string, indent: number = BAR_INDENT): string {
	const head = LEADING_ANSI.exec(line)?.[0] ?? "";
	const rest = line.slice(head.length);
	const pad = rest.startsWith(" ") ? 1 : 0;
	const body = pad === 1 ? rest.slice(1) : rest;
	const padding = trailingSpaceRun(body);
	const spare = padding ? padding.end - padding.start : 0;
	const needed = Math.max(0, 1 + indent - pad);
	if (!padding || spare < needed) return line;

	const trimmed = body.slice(0, padding.end - needed) + body.slice(padding.end);
	return `${head}${" ".repeat(pad + needed)}${trimmed}`;
}

/** 一行在剥掉 ANSI 后是否还有正文（Box 的上下内边距行只有空格）。 */
function hasVisibleContent(line: string): boolean {
	return line.replace(FULL_ANSI, "").trim().length > 0;
}

/**
 * 给整块用户消息加 gutter：只给第一条有正文的行画标记，其余有正文的行补两个空格对齐。
 * 上下内边距行与正文块里的空行保持原样，不画任何字形。
 */
export function decorateUserMessageLines(lines: string[], marker: string): string[] {
	let marked = false;
	return lines.map((line) => {
		if (!hasVisibleContent(line)) return line;
		if (!marked) {
			marked = true;
			return addBarToLine(line, marker);
		}
		return addBodyIndentToLine(line);
	});
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

/**
 * 消息框上方那条空行（用户 2026-10-26 定；抬头 2026-10-27 删除后变成无条件）。
 *
 * `startup-logo` 说明段的最后一行 `╵  ╵   ╰─╴╰─╯╶┴╯╰─╴╵╰╴` 底下紧接就是方框的第一个内边距行
 * 第一条内边距行，两条黏成一块。给会话里的**第一条**用户消息上方插一条裸空行开一道缝。
 *
 * 只补“第一条”，因为只有它真的紧：pi 的 `addMessageToChat` 只在聊天区**非空**时补前置
 * `Spacer(1)`。启动时容器是空的 ⇒ 第一条用户消息前面什么都没有 ⇒ 它就是那句 slogan 的正下方。
 * 之后每条消息前面本来就有 pi 自己那条空行了，再补一条就变成两条。
 *
 * 插入的是一条**裸空行**（不是 Box 的内边距行）：它不属于消息底色块，读起来就是一道缝；
 * 框自己的上下内边距行原样保留（顶部那条给语法高亮块留边，少了它代码块底色会顶着上一行）。
 *
 * OSC 133 的 zone 起点必须留在整个消息的第一行最前（否则 shell 集成会把这行空行排除在消息之外），
 * 所以它从原首行**挪到这条新空行上**（`startsWith` 判断 + 直接拼在前面）：行数只加 1，不是 2。
 */
export function addMessageBoxGap(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const first = lines[0] ?? "";
	// zone 起点原封不动地挪到新空行上，原首行那截被去掉（不能留两份）
	if (first.startsWith(ZONE_START)) return [ZONE_START, first.slice(ZONE_START.length), ...lines.slice(1)];
	return ["", ...lines];
}

/** 取色源：pi 的 `Theme` 实例（只用到这两个方法，注入后本模块与 pi 解耦）。 */
export interface ThemeColorSource {
	getFgAnsi(color: string): string;
	getBgAnsi(color: string): string;
}

/**
 * 取标记的前景 ANSI（不含字形）。传入的皮肤连兜底槽位都没有时返回 `undefined` ——
 * 调用方据此放弃画标记，而不是抛。
 *
 * 槽位既可能是前景槽（`muted`）也可能是**背景**槽（`selectedBg`）：
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

/** 「空行标记」补丁自己的幂等标记（它装在 `InteractiveMode` 原型上，与首行标记补丁不共用一个原型）。 */
const GAP_PATCHED = Symbol.for("pi-user-message-bar.gap.patched");

interface BarState {
	theme: () => ThemeColorSource | undefined;
	colorName: string;
	barAnsi: () => string | undefined;
	/**
	 * 要不要给消息框上方补那条空行（见 `addMessageBoxGap`）。
	 *
	 * 传进去的是**取当前值**的回调而不是布尔值：`startup-logo` 在 `session_start` 里装 header、
	 * 而两家扩展的 `session_start` 监听顺序不定。回调在渲染时求值 ⇒ 无论谁先跑，看到的都是
	 * 「本进程是不是真的被静音了」这个已经写定的进程级事实。
	 */
	startupLogoHeader?: () => boolean;
}

export interface UserMessageBarOptions {
	/** pi 的 `UserMessageComponent` 类（扩展侧 import 到的就是 pi 渲染用的那个类，见文件头）。 */
	UserMessageComponent: { prototype: Record<string | symbol, unknown> };
	/** 取当前皮肤的 Theme，渲染时求值 —— `ctx.ui.theme` 是跨 `/theme` 换肤的活 Proxy。 */
	theme: () => ThemeColorSource | undefined;
	/** 取色槽位名，默认 `muted`（皮肤的弱化文字色）。 */
	colorName?: string;
	/** 字形，默认 `›`（U+203A），宽度必须是一列。 */
	glyph?: string;
	/** 给消息框上方留一条空行（见 `addMessageBoxGap`）；回调在渲染时求值。 */
	startupLogoHeader?: () => boolean;
}

/**
 * 装上「用户消息首行标记」补丁。返回**本次是否真的装了**：`/reload` 之后是 `false`
 * （补丁已在，只换了取色源），原型形状不认识（没有 `render`）时也是 `false` 且什么都不做 ——
 * 不猜、不抛，宁可这个特性不生效。
 */
export function installUserMessageBar(options: UserMessageBarOptions): boolean {
	const prototype = options.UserMessageComponent.prototype;
	const existing = prototype[PATCH_KEY] as BarState | undefined;
	if (existing) {
		existing.theme = options.theme;
		if (options.colorName !== undefined) existing.colorName = options.colorName;
		// 与 theme / colorName 同一套语义：重复安装只**更新**状态，不重包一层
		if (options.startupLogoHeader !== undefined) existing.startupLogoHeader = options.startupLogoHeader;
		return false;
	}

	const original = prototype.render;
	if (typeof original !== "function") return false;

	const glyph = options.glyph ?? BAR_GLYPH;
	const state: BarState = {
		theme: options.theme,
		colorName: options.colorName ?? DEFAULT_COLOR_NAME,
		barAnsi: () => undefined,
		startupLogoHeader: options.startupLogoHeader,
	};
	state.barAnsi = () => {
		const ansi = resolveBarAnsi(state.theme(), state.colorName);
		// 只加粗标记字形；随后分别复位字重与前景色，正文和后面的补白都不继承这两项样式。
		return ansi === undefined ? undefined : `${ansi}\u001b[1m${glyph}\u001b[22m\u001b[39m`;
	};

	prototype[PATCH_KEY] = state;
	prototype.render = function (this: unknown, ...args: unknown[]): string[] {
		const lines = (original as (...args: unknown[]) => string[]).apply(this, args);
		if (!Array.isArray(lines) || lines.length === 0) return lines;

		const bar = state.barAnsi();
		const body = bar ? decorateUserMessageLines(lines, bar) : lines;

		// 聊天区里的第一条用户消息（见 GAP_KEY），且头顶是 `startup-logo` 自己画的 header 时，
		// 才在上方补那条空行；否则原样返回，一行都不多加。
		const marked = GAP_KEY in (this as Record<symbol, unknown>);
		if (!marked || state.startupLogoHeader?.() !== true) return body;
		return addMessageBoxGap(body);
	};
	return true;
}

/** `addMessageToChat` 的容器只需要这一个字段（pi 的 `Container` 公开它）。 */
interface ChatContainerLike {
	children?: unknown[];
}

export interface UserMessageGapOptions {
	/** pi 的 `InteractiveMode` 类（补丁打在它的 `addMessageToChat` 上）。 */
	InteractiveMode: { prototype: Record<string | symbol, unknown> };
	/** pi 的 `UserMessageComponent` 类 —— 只用它的原型做 `instanceof`。 */
	UserMessageComponent: Function & { prototype: object };
}

/**
 * 装上「给会话里第一条用户消息打上方空行标记」的补丁，返回本次是否真的装了。
 *
 * 组件自己看不见兄弟、也看不见父容器，而「我是不是聊天区里第一条用户消息」恰好就是
 * `addMessageToChat` 里容器长度能回答的那个问题 —— 所以只能在这里打标记，渲染时再由
 * `installUserMessageBar` 的 `render` 补丁看这个标记决定补不补空行（见 `addMessageBoxGap`）。
 *
 * **必须装在 `session_start`**（此时所有扩展的模块求值都已完成，包装处在调用链最外层）：
 * 首屏历史消息在 `session_start` 之后才渲染，装在这里不会漏；而装早了会排到别的扩展补丁
 * 的里面 —— `skill-invocation-reorder` 对 `/skill:` 消息自己 `new UserMessageComponent`、
 * 不调用原函数，里层包装就永远看不到那条消息。
 */
export function installUserMessageGap(options: UserMessageGapOptions): boolean {
	const prototype = options.InteractiveMode.prototype;
	if (prototype[GAP_PATCHED]) return false;
	const original = prototype.addMessageToChat;
	if (typeof original !== "function") return false;

	const UserMessageComponent = options.UserMessageComponent;
	prototype[GAP_PATCHED] = true;
	prototype.addMessageToChat = function (
		this: { chatContainer?: ChatContainerLike },
		message: { role?: string },
		...rest: unknown[]
	): unknown {
		const container = message?.role === "user" ? this.chatContainer : undefined;
		const children = container?.children;
		const before = Array.isArray(children) ? children.length : -1;
		// 判据是「聊天区完全空」，不是「没有用户消息」：pi 只在容器**非空**时才自己补前置
		// `Spacer(1)`（`case "user"` 里那一句），所以容器空 ⇒ 这一条就是整块聊天区的第一行、
		// 而且前面没有任何空行 —— 启动时它就是 slogan 的正下方。后面每条消息前面都已有一条。
		const isFirst = message?.role === "user" && Array.isArray(children) && children.length === 0;
		try {
			return (original as (...args: unknown[]) => unknown).apply(this, [message, ...rest]);
		} finally {
			// 注意：finally 里不能 `return`，那会把原函数的返回值 / 异常一起吞掉
			if (!isFirst || before < 0 || !Array.isArray(children)) return;
			for (const child of children.slice(before)) {
				if (!(child instanceof UserMessageComponent)) continue;
				(child as Record<symbol, unknown>)[GAP_KEY] = true;
			}
		}
	};
	return true;
}
