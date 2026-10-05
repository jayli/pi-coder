/**
 * 命令行里的**长地址缩略** —— 纯逻辑，无 IO、无 pi 依赖（与 `sandbox.ts` 同口径，
 * `node --test` 直接跑）。
 *
 * ## 为什么要有这一层
 *
 * bash 块的命令行折叠态只有 2 个视觉行，而模型发出来的命令里常常夹着整条 pnpm store 路径
 * （`/Users/…/pnpm/store/v11/links/@earendil-works/pi-coding-agent/1.0.0/<64 位 hash>/
 * node_modules/@earendil-works/pi-coding-agent`）。它一出现就把两行预算全吃掉，用户看到的
 * 是一堆目录名，认不出「这条命令到底在干什么」。用户 2026-10-03 定的方向：**重点呈现命令
 * 本身，地址只留起点和终点的目录**。
 *
 * ## 规则（用户 2026-10-03 定，一期）
 *
 * ① **只对特定地址动手**（一期刻意保守，宁可漏也不误伤）：
 *    - 命令 basename 是 `cat` / `cd` / `ls` / `ln` 时，它后面的路径参数；
 *    - 任意位置的 `NAME=<路径>` 赋值（用户样例 `P=/Users/…/pi-coding-agent` 落在这支）——
 *      赋值不看命令名，因为 `P=…; grep …` 里的命令是 `grep`，地址却是赋值的值。
 *    其余命令（典型：`import … from "/Users/…"` 那种**代码里的地址**）、其余参数一律不动。
 * ② **阈值 = 命令正文可用列的 40%**（80 列终端 ≈ 29 列，见 `pathAbbrevThreshold`）。路径可见
 *    宽度不超过阈值就原样返回 —— 只对「长到碍事」的地址动手。
 * ③ **缩略只动中间**：形态 `<头>…/<尾>`。头尾的取舍是**尾部优先**（用户选的「尾部能留几层留
 *    几层」）：先最大化尾部层数，同层数时再保开头的 2 层（放不下退 1 层）。所以
 *    `/Users/bachi/…/pi-coding-agent` 与 `/Users…/@earendil-works/pi-coding-agent` 都合法，
 *    取决于当下列宽。唯一硬约束是**不超阈值**：尾部只剩 1 层时也照缩（`…` 一定比完整路径短）。
 * ④ **只认「字面量地址」**：含变量 / 反引号 / 通配符 / 花括号 / 引号 / 反斜杠 / `~` 的词一律
 *    跳过（`"$HOME/…"`、`'…'`、`*.js`、`{a,b}` 都不动 —— 一期不碰需要求值的形态）；被点名
 *    命令的**相对路径不足 3 层**（`./clients/pi`）、根目录、`NAME=` 的值不是路径，也不动。
 * ⑤ **地址之外的每个字符都保持不变**（命令名、选项、操作符、空格、其余参数），替换是
 *    「就地替换那一个词」，不是重新拼命令 —— 会话记录与发给模型的参数也完全不受影响
 *    （本模块只被渲染层调用）。
 *
 * ## 一个安全细节：heredoc 正文不碰
 *
 * `cat <<EOF` 之后的内容是**数据**，里面出现的 `cd /very/long/path` 是文件正文而不是命令。
 * 扫描器因此维护 heredoc 状态：`<<` / `<<-` 后面的词是结束符，从下一行起直到出现该结束符
 * 为止整段跳过。同理注释（行首或词首的 `#`）也不缩。
 */

/** 缩略标记：与 bash 块其余地方的省略号同一个字形。 */
const ELLIPSIS = "…";

/** 一期点名的命令（basename 比对，`/usr/local/bin/ls` 也算 `ls`）。 */
const ABBREV_COMMANDS = new Set(["cat", "cd", "ls", "ln"]);

/** 词里出现这些字符就不缩（需要求值 / 引号包裹 / 转义路径 —— 一期不碰）。 */
const DYNAMIC_CHARS = /[$`*?{}[\]"'\\~]/;

/** `NAME=value` 赋值（值里还能带 `=`，只切第一个）。 */
const ASSIGN_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*=)([\s\S]+)$/;

/** grapheme 分段器（与 `bash-command-collapse.ts` 同款；本模块不能 import pi-tui 的实例）。 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * 可见列宽 —— **兜底实现**，调用方能用 pi-tui 的 `visibleWidth` 就传进来（渲染路径就是这么
 * 做的，两边才不会差一列）。本模块必须在 `node --test` 下无 pi 依赖地跑，所以自己带一份。
 *
 * 只处理用得到的三种情况：组合符（`\p{Mark}` / ZWJ / 变体选择符）0 列、East Asian
 * Wide / Fullwidth 2 列、其余 1 列。emoji 的宽度表在两边可能对不齐，代价是缩略判定偶尔
 * 差一列，不影响正确性（真实渲染仍由 pi-tui 自己折行）。
 */
export function fallbackVisibleWidth(text: string): number {
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const code = segment.codePointAt(0) ?? 0;
		if (segment === "\u200d" || segment === "\ufe0f" || segment === "\ufe0e" || /\p{Mark}/u.test(segment)) continue;
		width += isWideCodePoint(code) ? 2 : 1;
	}
	return width;
}

function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f9ff)
	);
}

/** 宽度函数签名（默认 `fallbackVisibleWidth`）。 */
export type WidthFn = (text: string) => number;

/**
 * 缩略阈值：命令正文可用列（终端宽扣掉块左边距与 `Run ` 前缀）的 **40%**。
 * 向下取整并兜底为 1 —— 极窄终端（正文只剩十几列）不能算出 0 来。
 */
export function pathAbbrevThreshold(bodyColumns: number): number {
	return Math.max(1, Math.floor(bodyColumns * 0.4));
}

/**
 * 单条路径的缩略：形态 `<头>…/<尾>`，**尾部优先**（详见文件头规则 ③）。
 *
 * 返回**新字符串**；不需要缩略时原样返回入参（调用方可以靠 `===` 判断有没有改）。
 * 相对路径（`./a/b/c`）与绝对路径都支持，但只有 ≥3 层才有「中间」可缩。
 */
export function compressPath(path: string, threshold: number, width: WidthFn = fallbackVisibleWidth): string {
	const limit = Math.max(1, Math.floor(threshold));
	if (width(path) <= limit) return path;
	const separator = path.includes("/") ? "/" : "\\";
	const root = path.startsWith(separator) ? separator : "";
	// 尾部斜杠（目录形态）必须保住：`ls -la <dir>/` 缩成 `…/core/` 而不是 `…/core`
	const trailing = path.endsWith(separator) ? separator : "";
	const segments = path.split(separator).filter((segment) => segment !== "");
	if (segments.length < 3) return path;

	const headOf = (layers: number) => root + segments.slice(0, layers).join(separator);
	const tailOf = (layers: number) => segments.slice(segments.length - layers).join(separator);

	// 先最大化尾部层数（用户选的「尾部能留几层留几层」），同层数时保开头的 2 层。
	let best: string | null = null;
	let bestTail = 0;
	for (const headLayers of [2, 1]) {
		const head = headOf(headLayers);
		for (let tail = segments.length - headLayers; tail >= 1; tail--) {
			const candidate = `${head}${ELLIPSIS}${separator}${tailOf(tail)}${trailing}`;
			if (width(candidate) > limit) continue;
			if (tail > bestTail) {
				best = candidate;
				bestTail = tail;
			}
			break;
		}
	}
	if (best !== null) return best;

	// 极窄终端：连「开头 1 层 + 尾部 1 层」都放不下 —— 退到只留尾部（能留几层留几层）
	for (let tail = segments.length; tail >= 1; tail--) {
		const candidate = `${ELLIPSIS}${separator}${tailOf(tail)}${trailing}`;
		if (width(candidate) <= limit) return candidate;
	}
	// 连最后一段都放不下：从右往左按 grapheme 截最后一段（`…/pi-codi`），永远不超预算
	const last = segments[segments.length - 1] ?? "";
	const prefix = `${ELLIPSIS}${separator}`;
	const budget = limit - width(prefix) - width(trailing);
	if (budget <= 0) return ELLIPSIS;
	let kept = "";
	let used = 0;
	for (const { segment } of [...graphemeSegmenter.segment(last)].reverse()) {
		const w = width(segment);
		if (used + w > budget) break;
		kept = segment + kept;
		used += w;
	}
	return prefix + kept + trailing;
}

interface Word {
	/** 词在命令串里的字符区间（`[start, end)`）。 */
	start: number;
	end: number;
	text: string;
	/** 含引号 / 转义 → 一期不碰。 */
	quoted: boolean;
}

interface Segment {
	words: Word[];
}

/** 操作符（认出来只是为了不把它当词；`<<` / `<<-` 还要顺带记 heredoc 结束符）。 */
const OPERATORS = ["<<-", "<<", "&&", "||", "|&", ";;", ";", "|", "&", "(", ")", "<", ">"];

function matchOperatorAt(line: string, index: number): string | null {
	// fd 重定向（`2>` / `1>>`）：数字串后面必须紧跟 `>` / `<` 才算操作符
	if (line[index]! >= "0" && line[index]! <= "9") {
		let j = index;
		while (j < line.length && line[j]! >= "0" && line[j]! <= "9") j++;
		return line[j] === ">" || line[j] === "<" ? line.slice(index, j + 1) : null;
	}
	// `>>` 这类双写操作符优先于单字符
	for (const op of OPERATORS) if (line.startsWith(op, index)) return op;
	if (line[index] === ">") return ">";
	return null;
}

/**
 * 把命令串切成一段段「命令」（`;` `&&` `||` `|` `&` 换行都分段），每段带自己的词表。
 *
 * 扫描**不改任何字符**：它只记录每个词的区间，替换由调用方在原文上就地做，所以命令的
 * 其余部分天然逐字保留。没有引号闭合 / 词里带引号的情况一律标 `quoted`（不缩）。
 */
function scanSegments(command: string): Segment[] {
	const segments: Segment[] = [];
	let words: Word[] = [];
	let heredocDelimiter: string | null = null;
	let pendingHeredoc = false;
	let i = 0;

	const flush = () => {
		if (words.length > 0) segments.push({ words });
		words = [];
	};

	while (i < command.length) {
		// heredoc 正文：整段跳到结束符那一行
		if (heredocDelimiter !== null) {
			const eol = command.indexOf("\n", i);
			const lineEnd = eol === -1 ? command.length : eol;
			const line = command.slice(i, lineEnd).replace(/^\t+/, "");
			if (line.trimEnd() === heredocDelimiter) heredocDelimiter = null;
			i = eol === -1 ? command.length : eol + 1;
			continue;
		}

		const char = command[i]!;
		if (char === "\n") {
			flush();
			i++;
			continue;
		}
		if (char === " " || char === "\t") {
			i++;
			continue;
		}
		// `#` 在词首才是注释（`foo#bar` 里的 `#` 是普通字符）：整行剩余部分不缩
		if (char === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1] ?? ""))) {
			flush();
			const eol = command.indexOf("\n", i);
			i = eol === -1 ? command.length : eol;
			continue;
		}

		const operator = matchOperatorAt(command, i);
		if (operator !== null) {
			if (operator === "<<" || operator === "<<-") pendingHeredoc = true;
			flush();
			i += operator.length;
			continue;
		}

		// 词：吃到空白 / 操作符 / 换行；词内的引号成对跳过（并记下 quoted）
		const start = i;
		let quoted = false;
		while (i < command.length) {
			const c = command[i]!;
			if (c === "\n" || c === " " || c === "\t") break;
			if (c === "'" || c === '"') {
				quoted = true;
				const quote = c;
				i++;
				while (i < command.length) {
					if (quote === '"' && command[i] === "\\") {
						i += 2;
						continue;
					}
					if (command[i] === quote) break;
					i++;
				}
				if (i < command.length) i++; // 闭合引号
				continue;
			}
			if (matchOperatorAt(command, i) !== null) break;
			i++;
		}
		const text = command.slice(start, i);
		if (text === "") {
			i++; // 兜底：绝不空转（异常字符）
			continue;
		}
		if (pendingHeredoc) {
			heredocDelimiter = stripQuotes(text);
			pendingHeredoc = false;
		}
		words.push({ start, end: i, text, quoted });
	}
	flush();
	return segments;
}

function stripQuotes(word: string): string {
	const match = /^(['"])([\s\S]*)\1$/.exec(word);
	return match ? match[2]! : word.replace(/^['"]|['"]$/g, "");
}

/** 这个词是不是「值得缩的字面量地址」（文件头规则 ④）。 */
function isAbbreviatablePath(word: Word): boolean {
	if (word.quoted) return false;
	if (DYNAMIC_CHARS.test(word.text)) return false;
	if (!word.text.includes("/") && !word.text.includes("\\")) return false;
	if (word.text === "/" || word.text === "./" || word.text === "../") return false;
	return true;
}

/**
 * 命令串里的地址缩略（入口）。返回新串；没改动时返回**同一个引用**。
 *
 * @param command   原始命令（可能多行）
 * @param threshold `pathAbbrevThreshold(正文可用列)`
 * @param width     可见宽度函数（渲染路径传 pi-tui 的 `visibleWidth`；默认本模块的兜底实现）
 */
export function abbreviateCommandPaths(command: string, threshold: number, width: WidthFn = fallbackVisibleWidth): string {
	if (!command) return command;
	const replacements: Array<{ start: number; end: number; text: string }> = [];

	for (const segment of scanSegments(command)) {
		let commandName = "";
		let commandSeen = false;
		for (const word of segment.words) {
			const assignment = ASSIGN_PATTERN.exec(word.text);
			if (assignment) {
				// `NAME=<路径>`：不看命令名（用户样例 `P=…; grep …` 的命令是 grep）
				const value = assignment[2]!;
				if (!DYNAMIC_CHARS.test(value) && (value.includes("/") || value.includes("\\"))) {
					const compressed = compressPath(value, threshold, width);
					if (compressed !== value) {
						replacements.push({ start: word.start, end: word.end, text: assignment[1]! + compressed });
					}
				}
				continue;
			}
			if (!commandSeen) {
				commandSeen = true;
				commandName = word.text.split(/[/\\]/).pop() ?? "";
				continue;
			}
			if (!ABBREV_COMMANDS.has(commandName)) continue;
			if (!isAbbreviatablePath(word)) continue;
			const compressed = compressPath(word.text, threshold, width);
			if (compressed !== word.text) replacements.push({ start: word.start, end: word.end, text: compressed });
		}
	}

	if (replacements.length === 0) return command;
	// 就地替换：从后往前，前面词的下标才不被后面的替换长度影响
	let out = command;
	for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, start) + text + out.slice(end);
	}
	return out;
}
