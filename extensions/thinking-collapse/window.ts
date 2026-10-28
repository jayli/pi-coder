/**
 * window.ts — thinking 单行连续滚动窗口的纯逻辑。
 *
 * 从 `thinking-collapse.ts` 抽出来（那个文件到处 import pi，`node --test` import 不进来）：
 * 本模块**不 import pi / pi-tui**，可见宽度函数 `widthOf` 由调用方注入（运行时传 pi-tui 的
 * `visibleWidth`，与渲染器同一套实现，量出来的宽度与 pi 实际折行用的宽度严格一致），
 * 所以能用 `node --test` 直接跑：
 *
 *     node --test clients/pi/extensions/thinking-collapse/window.test.ts
 *
 * 目录与 `thinking-collapse.ts` **同名且没有 index.ts**：pi 的扩展加载器只认
 * `extensions/<name>.ts` 与 `extensions/<name>/index.ts`（`loader.js` 的
 * `discoverExtensionsInDir` → `resolveExtensionEntries` 找不到入口就整目录跳过），
 * 所以这个目录不会被当成扩展加载（与 `tool-diff/` 同一套做法）。
 *
 * ## 显示形态：一条不间断滚动的行
 *
 * 整个 thinking 块**永远只渲染成一行**，所有 token 在这一行里连续滚动：
 *
 *     Think: …最新写下的 token 一直追加在行尾
 *
 *   - **不分段、不换行**：thinking 里所有的换行（模型自己折的行、空行分段、列表项之间、
 *     代码围栏内）全部拼进这**同一条**行 —— 上一段结束后，下一段直接接续在上一段的结尾，
 *     不另起一行。于是 Think 区域呈现的是「一条不间断的 token 流」，而不是逐段刷新的多行。
 *   - 行首带 `Think: ` 标签（7 列，从第 0 列起），标签属于「块首」，始终钉在这一行最前面。
 *   - 拼接处补什么按两侧字符决定（见 `joinSeparator`），并且**区分两种接缝**：
 *     - **段内换行**（模型自己折的行、列表项之间）：中文之间不补、英文单词之间补一个空格；
 *     - **段落接缝**（原文的空行处）：中文 ↔ 中文额外补一个**逗号** `，`，免得两段无缝粘连
 *       读起来像一句话（`第一段结尾，第二段开头`）。上一段末尾本来就有标点（。，：等）时
 *       不重复补；英文 / 中英混排仍按空格规则。
 *   - 整行超过预算时**从头部**丢掉溢出字符并在行首补一个 `…`：内容越写越长，前面的字符一路
 *     向前挤出视口，行尾永远是最新写下的 token。放得下就全量显示，不补 `…`。
 *   - 预算比终端宽度**少 3 列**（`RIGHT_INSET`）：滚动行不顶格到右边界，行尾与右边框之间
 *     始终留着约 3 个英文字符的距离（用户 2026-10-27 定：顶格不好看）。窄到扣完这 3 列就装不下
 *     「标签 + `…` + 1 列正文」时不扣，宁可顶格也要保住标签。
 *
 * 这里**没有**「短段回填补满整行」的逻辑：曾经有过（最后一段太短时把被顶出去的开头拉回来
 * 拼满行），但它会在流式过程中不断改变整行构成、打断「token 持续流动」的观感，已移除。
 * 现在短 thinking 就是短，行尾留白，不补。
 *
 * ## 硬性不折行（本扩展的核心约束，别拆）
 *
 * 出口行必须**恰好是一行**：thinking 不会被仔细阅读，格式整洁比内容完整更重要，
 * 所以宁可截掉字符也不允许 pi 二次折行。而 pi 会把本扩展的返回值再交给 marked 解析一次，
 * 于是有两类东西能把这一行弄宽：
 *
 * 1. **行内 code span 把两行并成一行**。marked 的 codespan tokenizer 会把 code span 里的换行
 *    **换成空格**（`rules.inline.code` + `newLineCharGlobal`，实测 `` `a\nb` `` → text `"a b"`），
 *    合并出来的超宽行再被 pi 按 contentWidth 折一次，折出来的续行没有标签、看上去就是凭空多出来
 *    的一行。所以出口行里的反引号必须**自身配对**：`stripUnpairedBackticks` 按 marked 的判定规则
 *    （`findCodeSpanEnd`）把配不上对的反引号整段删掉。头部截断会切在 code span 中间、留下一串
 *    落单的闭合反引号，正是同一个 bug。
 * 2. **marked 的 inline 规则吃掉我们插进去的 ANSI 转义**。窗口自己会在标签前后夹一对斜体转义
 *    `\x1b[23m` / `\x1b[3m`，对 marked 而言那只是一串普通字符 —— 它的 email 自动链接规则会把尾巴上的
 *    `3m` 当成邮箱**用户名**的一部分吞进链接，转义被截成 `\x1b[`：没有终止字符 `m`，
 *    pi 的 `visibleWidth` 不认它，残尾就以可见文字显示出来（屏幕上看到的 `3mfoo@bar.com`），
 *    行宽跟着超出预算 → pi 折行。同类第二条路径是正文里的 `](`：它让 CSI 的 `[` 变成 markdown 链接的
 *    左括号，`[3msee foo](bar)` 整个被当成链接，文字只剩 `3msee foo`。修法是 `escapeMarkdownHooks`
 *    把 `@` 与未配对的 `]` 转义成 `\@` / `\]`（marked 的 escape 规则吃掉反斜杠，渲染后逐字变回
 *    原样）；转义会让原文变长，所以宽度预算用 `hookAwareWidth` 预留这部分开销，出口行的原始宽度
 *    仍严格不超预算。
 *
 * 出口处还有一道硬截断兜底（`truncateTail`），保证任何情况下都不超宽。
 */

/** 可见宽度函数：与 pi-tui `visibleWidth` 同语义（剥 ANSI、宽字符按 2 列）。 */
export type WidthFn = (text: string) => number;

/** 首行标签：`Think: `（占 7 列，从第 0 列开始）。 */
export const HEADER_LABEL = "Think: ";

/** 省略号（1 列）：放在被头部截断的那一行最前面，表示左边还有被挤掉的内容。 */
export const ELLIPSIS = "…";

/** 斜体关 / 开。标签要正常字形、正文要斜体，所以标签前后夹一对 SGR。 */
export const ITALIC_OFF = "\u001b[23m";
export const ITALIC_ON = "\u001b[3m";

/** 内容预算的下限（列）。终端窄到装不下标签时至少还能放一个 `…`。 */
const MIN_CONTENT_WIDTH = 1;

/**
 * 右侧留白（列）：滚动行**不顶格**到右边界，可见长度收窄到「顶格 − 3 列」
 * （用户 2026-10-27 定：顶格不好看，要留出约 3 个英文字符的距离；此前是 5 列）。
 *
 * 只在放得下的时候扣：扣完还得留得下「`Think: ` 标签 + `…` + 至少 1 列正文」，否则宁可顶格 ——
 * 窄终端上为了 3 列留白把标签挤掉是本末倒置（见 `buildThinkingWindow` 里算 `width` 那两行）。
 */
export const RIGHT_INSET = 3;

/**
 * 段落接缝（原文空行处）中文 ↔ 中文补的标点：逗号。
 *
 * 选逗号而不是句号：thinking 的段落之间多是「接着想」而不是「说完了」，句号会把语气断得太死。
 * 只在**段落**接缝补，段内折行仍按原规则（中文之间不补），否则模型自己折的每一行都会多一个逗号。
 */
export const PARAGRAPH_JOIN_PUNCT = "，";

/** 可用宽度缺失 / 不合理时的兜底（列）。 */
const DEFAULT_WIDTH = 80;

/** 所有当换行处理的字符：LF / CR / CRLF / NEL / VT / FF / 行分隔符 / 段分隔符。 */
const LINE_BREAK_RE = /\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/;

/** 行内 ≥2 个连续空格折叠成 1 个（单个空格保留：单词之间那一个空格是有意义的）。 */
const SPACE_RUN_RE = / {2,}/g;

/** pi 在解析 markdown 前会把 tab 换成 3 个空格，这里先做同样的归一，宽度才算得准。 */
export function normalizeTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * 宽字符（终端占 2 列）：CJK 表意文字、假名、谚文、全角形式等。
 * 与 `joinSeparator` 的「两侧都是宽字符就不补空格」配套 —— 口径只需覆盖「中日韩正文」，
 * 不必与 wcwidth 表逐格一致（差几格只影响要不要补一个空格）。
 */
function isWideChar(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	return (
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) || // 含 CJK 标点 0x3000-0x303f
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe6f) ||
		(c >= 0xff00 && c <= 0xff60) || // 全角形式（含全角标点）
		(c >= 0xffe0 && c <= 0xffe6)
	);
}

/**
 * CJK 标点（，。、；：？！「」『』《》【】… 及全角/半角形式）：两侧都不吃空格。
 * 全角区里要排掉字母与数字（`ＡＢＣ１２３` 是正文，不是标点）。
 */
function isCjkPunct(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	if (c >= 0x3000 && c <= 0x303f) return true; // CJK 符号与标点
	if (c >= 0xfe30 && c <= 0xfe6f) return true; // 竖排/小型形式
	if (c >= 0xff61 && c <= 0xff65) return true; // 半角片假名标点 ｡｢｣､･
	if (c < 0xff01 || c > 0xff60) return false; // 全角形式区
	const digit = c >= 0xff10 && c <= 0xff19;
	const upper = c >= 0xff21 && c <= 0xff3a;
	const lower = c >= 0xff41 && c <= 0xff5a;
	return !digit && !upper && !lower;
}

/** 行尾是这些字符时不补空格：开括号 / 开引号 / 反引号 / 破折号省略号一类。 */
const NO_SPACE_AFTER = new Set(["(", "[", "{", "<", '"', "'", "`", "…", "—", "–", "·", "$"]);

/**
 * 行首是这些字符时不补空格：闭括号 / 收尾标点 / 引号 / 路径与扩展名分隔符。
 * 刻意**不含** `-` 与 `_` —— 它们开头的行更可能是 `--verbose` 这类参数或普通正文，
 * 不补空格会和上一行粘成一个词。
 */
const NO_SPACE_BEFORE = new Set([")", "]", "}", ">", ",", ".", ";", ":", "!", "?", "%", '"', "'", "`", "…"]);

/**
 * 会被 marked 的 inline 规则「吃掉」的字符：出口前按条件转义（加一个反斜杠）。
 *
 * 只有这两个字符，各自对应一条**已实测**的路径（见文件头「硬性不折行」第 2 条）：
 *
 *   - `@` —— marked 的 email 自动链接（`url` tokenizer 的
 *     `[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+`）会把紧贴在斜体转义后面的
 *     `3mpi-web-access@0.39.0` 整个当成邮箱，`3m` 是用户名的一部分 —— 转义因此少了终止字符 `m`。
 *   - `]` —— 正文里出现**未配对**的 `](` 时，CSI 的 `[` 就成了 markdown 链接的左括号，
 *     `[3msee foo](bar)` 整个被当成链接，链接文字只剩 `3msee foo`（实测：屏幕上是
 *     `\u001b3msee foo` 这种残尾）。
 *
 * 刻意**只**转义这两个：marked 的 escape 规则会把反斜杠吃掉、渲染后逐字还原，所以转义本身不改变
 * 可见文字；但每多一个转义，pi 就会多切出一个 `escape` token。实测代价：`@` 在 3450 万字 thinking 语料里
 * 出现 2113 次、`]` 7668 次（0.006% / 0.02%），每处一个字符。转义面越小越好 ——
 * 所以多转一个 `<` / `!` 的方案实测会让 129/5940 帧各多切一个 token，已否决。
 */
const MARKDOWN_HOOK_CHARS = "@]";

/**
 * 带凭据的裸 URL（`https://user:pass@host`）：这种词里的 `@` 不转义。
 *
 * 两个理由：它不会触发 email 规则（marked 的 `url` tokenizer 先把整个 `https://…` 吃掉，实测不泄漏），
 * 而在 URL 里插反斜杠 marked **不会**吃掉它 —— `url` 规则的尾巴是 `[^\s<]*` 原样输出，
 * 渲染出来就成了 `https://user:pass\@localhost:8002` 这个多一个反斜杠的假 URL（实测）。
 * 语料里这类 URL 占 0.065% 的块，不处理就是凭空弄脏它们。
 */
const URL_WORD_RE = /^(?:https?|ftp):\/\//i;
const WWW_WORD_RE = /^www\./i;

/** 正文里有没有需要转义的字符（快路径用，以 `MARKDOWN_HOOK_CHARS` 为唯一源）。 */
function hasHookChar(text: string): boolean {
	for (const ch of MARKDOWN_HOOK_CHARS) {
		if (text.includes(ch)) return true;
	}
	return false;
}

/**
 * 从 `pos` 开始的 ANSI / OSC / APC 转义序列长度，不是序列则返回 0。
 *
 * 口径与 pi-tui 的 `ansiCodeLength` 逐条对齐（CSI 以 `m`/`G`/`K`/`H`/`J` 终止，OSC/APC 以 BEL 或
 * ST 终止）：只有同口径，「我认为是转义的部分」才等于「pi 量宽度时跳过的部分」。
 */
function ansiSequenceLength(text: string, pos: number): number {
	if (pos >= text.length || text.charCodeAt(pos) !== 0x1b) return 0;
	const next = text[pos + 1];
	if (next === "[") {
		for (let j = pos + 2; j < text.length; j++) {
			const c = text.charCodeAt(j);
			// m, G, K, H, J
			if (c === 0x6d || c === 0x47 || c === 0x4b || c === 0x48 || c === 0x4a) return j + 1 - pos;
		}
		return 0;
	}
	if (next === "]" || next === "_") {
		for (let j = pos + 2; j < text.length; j++) {
			if (text.charCodeAt(j) === 0x07) return j + 1 - pos;
			if (text.charCodeAt(j) === 0x1b && text[j + 1] === "\\") return j + 2 - pos;
		}
		return 0;
	}
	return 0;
}

/**
 * 一次扫描同时产出「转义后的文本」与「插了多少个反斜杠」。
 *
 * 两者必须出自同一条扫描：窗口是按宽度裁的，而转义会让文本变长 —— 预算用的「会插几个」与实际
 * 「插了几个」如果口径不一，「出口行原始宽度 ≤ 预算」这条不变量就守不住。
 *
 * 三类位置**不动**：
 *
 *   - **转义序列内部**（CSI / OSC / APC）：marked 眼里那只是一串普通字符，插一个反斜杠就把整条
 *     转义弄坏了。`ansiSequenceLength` 整条跳过 —— 这让本函数对**已经夹了控制码**的字符串也安全。
 *   - **code span 内部**：marked 对 code span 不做 escape 处理，那里的 `\@` 会原样显示成反斜杠加 at
 *     （实测过），反而弄脏文字；code span 里的 `@` 也不会触发 email 规则 —— 它整个是一个 codespan
 *     token，不参与 inline 链接解析。配对判定用 `findCodeSpanEnd`，与上游 `stripUnpairedBackticks` 同口径。
 *   - **已经被转义过的**（前面有奇数个反斜杠）：重复转义会把 `\@` 变成 `\\@`，渲染出来就成了反斜杠加 at
 *     （marked 的 escape 规则只吃一个反斜杠）。奇偶按「跳过 ANSI 后的可见反斜杠连跑数」算，
 *     所以中间夹着颜色转义也判得准 —— 这让本函数**幂等**。
 *
 * 两个字符各自的条件也不同（都是为了不把本来正常的东西弄脏）：
 *
 *   - `@` —— 所在**可见词**是带完整开头的裸 URL（`https?://` / `ftp://` / `www.`）时不转义：那种词里
 *     marked 的 `url` tokenizer 先把整个 URL 吃掉（实测不泄漏），而 URL 内部插的反斜杠它**不会**吃 ——
 *     渲染出来就成了 `https://user:pass\@localhost:8002` 这个多一个反斜杠的假 URL。词必须是**可见**词
 *     （不含转义序列）：上游可能夹着任何 ANSI（窗口自己会夹斜体转义，旧版本还夹过彩虹色），按原始下标切片
 *     会把转义也算进词里，`https://` 于是永远匹配不上（实测的 bug）。注意「开头完整」是必要条件：头部截断把 `https://`
 *     挤掉、只剩 `pass@x.com/path` 时，email 规则照样会吃掉转义的尾巴（实测），所以那种 `@` 仍要转义。
 *   - `]` —— 只在**窗口内未配对**（前面没有可见的 `[`）时转义。配对的 `[a](b)` 是真链接，转义会把
 *     可见文字从 `a` 改成 `[a](b)`（实测），那是失真；未配对的 `](` 才会让 CSI 的 `[` 变成链接左括号。
 *     所以深度必须按**窗口**算、不能按整行算：头部截断可能把 `[` 挤掉，留下一个窗口内未配对的 `]`。
 */
function scanMarkdownHooks(text: string): { text: string; inserted: number } {
	// 快路径：正文里根本没有这两个字符时一字不改（语料里绝大多数帧都是这种）
	if (!hasHookChar(text)) return { text, inserted: 0 };
	let out = "";
	let inserted = 0;
	let i = 0;
	let backslashRun = 0;
	let depth = 0;
	/** 当前**可见**词（不含转义序列），遇空白清零 —— 判 URL 开头用。 */
	let word = "";
	while (i < text.length) {
		const length = ansiSequenceLength(text, i);
		if (length > 0) {
			// 整条跳过：既不参与转义，也不打断反斜杠奇偶、不算进当前词
			out += text.slice(i, i + length);
			i += length;
			continue;
		}
		const ch = text[i];
		if (ch === "`") {
			const end = findCodeSpanEnd(text, i);
			if (end > i) {
				// 配对的 code span：整段原样带过（marked 不对 code span 做 escape 处理）
				out += text.slice(i, end);
				i = end;
				backslashRun = 0;
				word = "";
				continue;
			}
			// 落单反引号（上游已删过，兜底再认一次）：不构成 span，按普通字符走
			out += ch;
			i++;
			backslashRun = 0;
			word += ch;
			continue;
		}
		word = /\s/.test(ch) ? "" : word + ch;
		if (ch === "[") {
			depth++;
		} else if (ch === "]") {
			if (depth > 0) depth--;
			else if (backslashRun % 2 === 0) {
				out += "\\";
				inserted++;
			}
		} else if (ch === "@") {
			// 当前词的可见前缀（不含这个 `@` 本身）
			const prefix = word.slice(0, -1);
			if (!URL_WORD_RE.test(prefix) && !WWW_WORD_RE.test(prefix) && backslashRun % 2 === 0) {
				out += "\\";
				inserted++;
			}
		}
		out += ch;
		backslashRun = ch === "\\" ? backslashRun + 1 : 0;
		i++;
	}
	return { text: out, inserted };
}

/**
 * 把会被 marked 的 inline 规则吃掉的字符转义掉（`@` → `\@`，未配对的 `]` → `\]`）。**幂等**。
 *
 * 条件与「哪些位置不能动」全在 `scanMarkdownHooks` 的注释里。渲染后逐字还原（marked 的 `escape`
 * 规则把反斜杠吃掉），所以这是**保真**变换；唯一的副作用是每个转义会让 pi 多切一个 inline token。
 * 实测代价：`@` 在 3450 万字 thinking 语料里出现 2113 次、`]` 7668 次（0.006% / 0.02%），每处一个字符。
 */
export function escapeMarkdownHooks(text: string): string {
	return scanMarkdownHooks(text).text;
}
/**
 * 这段文本转义后会**多出**多少列（= 会插入的反斜杠数）。
 *
 * 与 `escapeMarkdownHooks` 共用同一条扫描，所以「预算里预留的」与「实际插入的」严格一致。
 * code span 里的 `@` / 配对的 `]` / URL 里的 `@` 都不转义，也就不计数。
 */
export function countMarkdownHooks(text: string): number {
	return scanMarkdownHooks(text).inserted;
}

/**
 * 计入转义开销的宽度：`widthOf` 的结果再加上会插入的反斜杠数（每个 1 列）。
 *
 * 为什么要预留：转义发生在**窗口取完之后**（得先知道窗口里有哪些字符才能判配对与 URL），而窗口是按
 * `widthOf` 裁的。不预留的话，`a@b.com` 这样的正文会让出口行的**原始**宽度超出预算 —— 虽然 marked
 * 渲染时会把反斜杠吃掉、真实显示宽度不变，但「出口行原始宽度 ≤ 预算」这条本模块的既有不变量就不成立
 * 了，现有测试与「宁可截字符也不折行」的兜底都会失去依据。预留之后两个口径同时成立：
 * 原始宽度 ≤ 预算，渲染宽度 ≤ 原始宽度。
 */
export function hookAwareWidth(text: string, widthOf: WidthFn): number {
	return widthOf(text) + countMarkdownHooks(text);
}

/** 取字符串末尾一个码点（不切半个代理对）。 */
function lastCodePoint(text: string): string {
	if (text === "") return "";
	const end = text.length;
	const start = prevCodePointStart(text, end);
	return text.slice(start, end);
}

/** 取字符串开头一个码点。 */
function firstCodePoint(text: string): string {
	if (text === "") return "";
	const first = text.charCodeAt(0);
	if (first >= 0xd800 && first <= 0xdbff && text.length >= 2) return text.slice(0, 2);
	return text.slice(0, 1);
}

/** 从 end 往前退一个码点，返回它的起始下标（代理对整体退，不切半个）。 */
function prevCodePointStart(text: string, end: number): number {
	if (end <= 1) return 0;
	const low = text.charCodeAt(end - 1);
	if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
		const high = text.charCodeAt(end - 2);
		if (high >= 0xd800 && high <= 0xdbff) return end - 2;
	}
	return end - 1;
}

/**
 * 两行相接处该填什么。目标是读起来像原句：中文折行处不留空格，英文单词之间留一个，
 * 标点按它自己的排版习惯（ASCII 逗号后有空格、闭括号前没有）。
 *
 * `paragraphBreak = true` 表示这是**段落接缝**（原文空行处）而不是段内折行：此时中文 ↔ 中文
 * 补一个逗号，把「两段」在视觉上分开（否则无缝粘连读起来像一句话）。上一段末尾已经有标点
 * （。，：等 CJK 标点，或 ASCII 的收尾标点）就不重复补 —— 那个标点本身已经把段落断开了。
 */
function joinSeparator(prevEnd: string, nextStart: string, paragraphBreak = false): string {
	if (prevEnd === "" || nextStart === "") return "";
	if (isCjkPunct(prevEnd) || isCjkPunct(nextStart)) return "";
	if (paragraphBreak && isWideChar(prevEnd) && isWideChar(nextStart)) return PARAGRAPH_JOIN_PUNCT;
	if (isWideChar(prevEnd) && isWideChar(nextStart)) return "";
	if (NO_SPACE_AFTER.has(prevEnd)) return "";
	if (NO_SPACE_BEFORE.has(nextStart)) return "";
	return " ";
}

/**
 * 把 thinking 的**所有源行**拼成一条连续的行（缩进去掉、空格串折叠、接缝按两侧字符与
 * 「是否段落接缝」决定补什么）。空行（段落分隔）不产生换行，只把下一次拼接标记成段落接缝 ——
 * 于是上一段的结尾直接接续下一段的开头，中文之间补一个逗号。这正是「一条不间断 token 流」
 * 的拼接层。入参是 `body.split(LINE_BREAK_RE)` 的原始结果（**含**空行条目，它们就是段落标记）。
 */
export function joinAllLines(lines: readonly string[]): string {
	let out = "";
	let paragraphBreak = false;
	for (const line of lines) {
		const collapsed = line.trim().replace(SPACE_RUN_RE, " ");
		if (collapsed === "") {
			// 空行 = 段落分隔。只有已经攒下内容时才有意义（开头的空行不产生接缝）。
			if (out !== "") paragraphBreak = true;
			continue;
		}
		if (out === "") {
			out = collapsed;
			continue;
		}
		out += joinSeparator(lastCodePoint(out), firstCodePoint(collapsed), paragraphBreak) + collapsed;
		paragraphBreak = false;
	}
	return out;
}

/**
 * 找出从 start 开始的行内 code span 的结束位置（exclusive），配不上返回 -1。
 *
 * 判定规则对齐 marked 的 codespan tokenizer（`/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/`）：
 * 开合反引号数量必须相等、闭合串后面不能再紧跟反引号、内容首字符不能是反引号。
 * 只有和 marked 判定一致，「我这边的配对」才等于「marked 眼里的 code span」，
 * 删掉落单反引号之后才不会再出现跨行 code span。
 */
export function findCodeSpanEnd(text: string, start: number): number {
	let openerLength = 0;
	while (text[start + openerLength] === "`") openerLength++;
	const contentStart = start + openerLength;
	let i = contentStart;
	while (i < text.length) {
		if (text[i] !== "`") {
			i++;
			continue;
		}
		let closerLength = 0;
		while (text[i + closerLength] === "`") closerLength++;
		// 内容末字符必然不是反引号（我们只在反引号处停下），所以只需检查首字符。
		const content = text.slice(contentStart, i);
		if (closerLength === openerLength && text[i + closerLength] !== "`" && content[0] !== "`") {
			return i + closerLength;
		}
		i += closerLength;
	}
	return -1;
}

/**
 * 删掉配不上对的反引号（连着一整串一起删），配对的 code span 原样保留。
 *
 * 为什么必须删：marked 是在**整条 markdown** 上做 code span 配对的，一条出口行里落单的
 * 反引号会跟另一条出口行的反引号配成跨行 code span，那个 token 内部的新行会被换成空格，
 * 两行于是被并成一条超宽行、被 pi 再折一次（折出来的续行没有标签）。
 * marked 对落单反引号本来就当字面量，删掉它只是把「会显示成裸反引号」变成「不显示」，
 * 而这一行的内容本来就已经被头部截断过，代价可以忽略。
 */
export function stripUnpairedBackticks(text: string): string {
	if (!text.includes("`")) return text;
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			const end = findCodeSpanEnd(text, i);
			if (end > i) {
				out += text.slice(i, end);
				i = end;
				continue;
			}
			while (text[i] === "`") i++;
			continue;
		}
		out += text[i];
		i++;
	}
	return out;
}

/**
 * 从**头部**截断到 maxWidth 列：保留尾部，前面用一个 `…` 顶替被丢掉的字符。
 *
 * 按**码点**从后往前量（不切半个代理对）；宽度为 0 的字符（组合符 / 零宽）不占预算，
 * 跟着前面那个字符一起带上。宽字符跨在边界上时宁可少一列也不超宽。
 */
export function clipToTail(text: string, maxWidth: number, widthOf: WidthFn, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return "";
	return ellipsis + text.slice(clipToTailIndex(text, maxWidth, widthOf, widthOf(ellipsis)));
}
/**
 * `clipToTail` 的**起始下标**版（不拼 `…`）：去掉了窗口左侧多少个字符。
 *
 * 窗口逻辑本身只需要这个下标 —— 两者的宽度口径必须严格一致，所以共用同一段
 * 循环：`clipToTail` 就是本函数加一个 `…`。
 */
export function clipToTailIndex(text: string, maxWidth: number, widthOf: WidthFn, ellipsisWidth = 1): number {
	if (maxWidth <= 0) return text.length;
	if (widthOf(text) <= maxWidth) return 0;
	const budget = maxWidth - ellipsisWidth;
	if (budget <= 0) return text.length;
	let used = 0;
	let i = text.length;
	while (i > 0) {
		const start = prevCodePointStart(text, i);
		const width = widthOf(text.slice(start, i));
		if (width > 0 && used + width > budget) break;
		used += width;
		i = start;
	}
	return i;
}

/**
 * 从**尾部**截断到 maxWidth 列（保留头部，截掉的部分换成一个 `…`）。出口兜底截断用。
 *
 * 截断点正好落在空白上时那个空白一并去掉：`the …` 里的空格只是被切掉一半的空白，
 * 不表达任何信息，去掉后这一行可能比预算少 1 列（肉眼看不出来）。
 */
export function truncateTail(text: string, maxWidth: number, widthOf: WidthFn, ellipsis = ELLIPSIS): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const keep = truncateTailIndex(text, maxWidth, widthOf, widthOf(ellipsis));
	if (keep <= 0) return "";
	return `${text.slice(0, keep).replace(/\s+$/, "")}${ellipsis}`;
}

/**
 * `truncateTail` 的**保留长度**版：从尾部截断后，头部留下了多少个字符。
 *
 * 与 `truncateTail` 共用同一条循环（那个函数就是本函数加一个 `…`），所以两者的截断点
 * 严格一致。
 */
export function truncateTailIndex(text: string, maxWidth: number, widthOf: WidthFn, ellipsisWidth = 1): number {
	if (maxWidth <= 0) return 0;
	if (widthOf(text) <= maxWidth) return text.length;
	const budget = maxWidth - ellipsisWidth;
	if (budget <= 0) return 0;
	let used = 0;
	let count = 0;
	for (const ch of text) {
		const width = widthOf(ch);
		if (used + width > budget) break;
		used += width;
		count += ch.length;
	}
	return count;
}

/**
 * 把 thinking 正文压成**一条连续滚动的行**。导出供测试直接调用。
 *
 * @param markdown        thinking 块原文（pi 会把多个 thinking 块用 `\n\n` 拼起来）
 * @param availableWidth  pi 给 transform 的内容宽度（已扣掉 Markdown 组件左右各 1 列 padding）。
 *                        本函数还会再扣掉 `RIGHT_INSET`（3 列）作为右侧留白，所以出口行不会顶格。
 * @param widthOf         可见宽度函数（运行时传 pi-tui 的 `visibleWidth`）
 * @param ansi            是否夹斜体开关控制码
 */
export function buildThinkingWindow(
	markdown: string,
	availableWidth: number,
	widthOf: WidthFn,
	ansi = true,
): string {
	const body = normalizeTabs(markdown).trim();
	if (body === "") return markdown;

	// 所有源行（含空行分段）拼成一条连续的行：上一段结尾直接接续下一段开头，不换行。
	const line = joinAllLines(body.split(LINE_BREAK_RE));
	if (line === "") return markdown;

	const fullWidth = Math.max(8, Math.floor(availableWidth) || DEFAULT_WIDTH);

	const italicOff = ansi ? ITALIC_OFF : "";
	const italicOn = ansi ? ITALIC_ON : "";
	// 窄到连「标签 + `…` + 至少 1 列正文」都放不下时丢掉标签：正文比标记重要，
	// 否则标签 (7 列) 会把整行吃光、一个字都剩不下。
	const minLabeledWidth = widthOf(HEADER_LABEL) + widthOf(ELLIPSIS) + MIN_CONTENT_WIDTH;
	// 右侧留白（`RIGHT_INSET`）：滚动行不顶格到右边界，可见长度收窄到「顶格 − 3 列」。
	// 只在扣完仍放得下标签时扣 —— 否则宁可顶格，窄终端上为 3 列留白把标签挤掉是本末倒置。
	const width = fullWidth - RIGHT_INSET >= minLabeledWidth ? fullWidth - RIGHT_INSET : fullWidth;
	const useLabel = width >= minLabeledWidth;
	const label = useLabel ? HEADER_LABEL : "";
	const budget = Math.max(MIN_CONTENT_WIDTH, width - widthOf(label));
	/** 计入出口转义开销的宽度口径（见 `hookAwareWidth`）。 */
	const hookWidth = (text: string): number => hookAwareWidth(text, widthOf);

	// 落单反引号先删掉再算窗口（头部/尾部截断自己也切得出新的落单反引号，所以窗口取完还要再清一遍，见下）。
	const cleanLine = stripUnpairedBackticks(line);

	// 头部截断滚动：放得下就全显示，放不下就从头部丢掉溢出字符、行首补 `…`，行尾永远是最新 token。
	// 两个下标版函数与它们的成串版共用同一段循环，所以「算窗口」与「拼字符串」的截断点严格一致。
	//
	// 宽度口径用 `hookAwareWidth`（可见宽度 + 会插入的反斜杠数）：出口转义在**窗口取完之后**才做
	// （`]` 是否未配对、`@` 是否在 URL 里都得按窗口内的字符判），而转义会让原始文本变长。按预留了
	// 转义开销的预算裁，「出口行原始宽度 ≤ budget」这条不变量才继续成立；marked 渲染时把反斜杠吃掉，
	// 所以真实显示宽度只会更窄。不含 `@` / `]` 时 `hookAwareWidth` 与 `widthOf` 完全等价，行为不变。
	const ellipsisWidth = widthOf(ELLIPSIS);
	const ellipsisFits = budget - ellipsisWidth > 0;
	const from = ellipsisFits ? clipToTailIndex(cleanLine, budget, hookWidth, ellipsisWidth) : cleanLine.length;
	const clipped = cleanLine.slice(from);

	// 兜底：任何情况下出口行都不许超宽（超了宁可截掉尾部）。窗口已经按 budget 取过，这里
	// 理论上不会触发。
	if (from > 0 && hookWidth(clipped) > budget) {
		const fallback = truncateTail(clipped, budget, hookWidth);
		return label === ""
			? escapeMarkdownHooks(fallback)
			: italicOff + label + italicOn + stripUnpairedBackticks(escapeMarkdownHooks(fallback));
	}

	// 窗口内的落单反引号（被 cut 切出来的）再删一遍。
	let content = stripUnpairedBackticks(clipped);

	// 出口转义：必须在**拼接文字之前**做 —— `]` 的配对与 `@` 是否在 URL 里都得按窗口内的实际字符判
	// （头部截断可能把 `[` 挤掉，留下一个窗口内未配对的 `]`）；`scanMarkdownHooks` 会整条跳过
	// ANSI 序列，所以后面夹标签的斜体转义不会被它拆坏；插入的反斜杠不占可见宽度。
	content = escapeMarkdownHooks(content);

	const prefix = from > 0 && ellipsisFits ? ELLIPSIS : "";

	// 标签要正常字形（关掉 pi 给的斜体再开回来）；没有标签时正文沿用斜体。
	return label === "" ? prefix + content : italicOff + label + italicOn + prefix + content;
}
