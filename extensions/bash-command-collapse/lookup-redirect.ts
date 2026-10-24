/**
 * lookup-redirect —— 「这条 bash 命令本该用原生工具」的**硬判定**。
 *
 * ## 为什么需要它
 *
 * 提示词（`promptSnippet` / `AGENTS.md`）都是**建议**：模型读了也可以不听。用户的要求
 * 是「该用原生 find/ls/grep 的时候就用」，这是确定性要求，只能落在 loop 层 —— 本模块
 * 给出判定，`bash-command-collapse.ts` 的 `tool_call` handler 据此拦下这次调用，并把
 * 正确的调用形态作为结果交给模型（用户 2026-10-06 定）。
 *
 * ## 取向：宁可不拦，不可拦错
 *
 * 只有**整条命令都是纯粹的单一探查**才拦 —— 每个有效段的动词都必须是「取回内容」类
 * （`grep` / `find` / `ls` / `cat` / `head` / `sed -n`）。一旦出现：
 *
 *   - 变换器（`awk` / `jq` / `sort` / `wc` / `cut` / `tr` / `uniq` …）—— 原生工具给不了
 *   - 执行（`node` / `python3` / `npm` / `git` / `make` …）—— 这是真在跑东西
 *   - 写重定向、`sed -i`、heredoc 命令体
 *
 * 就**不拦**。那些是 bash 该干的活，拦了只会逼模型多跑一轮，比省下的 token 更贵。
 *
 * 同理，`find` 带 `-maxdepth` / `-mtime` / `-size` / `-exec`、`grep` 带 `-v` / `-c` / `-A`、
 * `sed` 不带 `-n`、多路径 `grep pat f1 f2` —— 一律不拦：原生工具的 schema 表达不了，
 * 拦下来模型也只能改用别的 bash，净损失一轮。
 *
 * ## `.gitignore` 是必须交代的差异
 *
 * 原生 `grep` / `find` 尊重 `.gitignore`（跳过 `node_modules/`、`dist/`），bash 的
 * `grep -r` 不跳 —— 实测：同一仓库里 `rg` 只找到 `visible.txt`，`grep -rn` 另外找到
 * `ignored/hidden.txt`。所以拦截语里**必须**写明这条，并给出补偿手法（把被忽略的目录
 * 显式作为 `path` 传入即可穿透，实测有效），否则「换原生」会变成静默漏搜。
 */

import { segmentVerb, splitShellSegments } from "../explored-group/classify.ts";

export type NativeLookupTool = "glob" | "grep" | "find" | "ls" | "read";

export interface LookupRedirect {
	/** 建议改用的原生工具（多族混杂时取优先级最高的那个）。 */
	tool: NativeLookupTool;
	/** 从命令里抽出的调用提示（尽力而为，抽不到就是 undefined）。 */
	hint?: { pattern?: string; path?: string; args?: Record<string, unknown> };
	/** 命令里出现的全部原生工具族，用于措辞。 */
	tools: NativeLookupTool[];
}

/** `grep` 一族：检索文本。 */
const GREP_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
/** `find` 一族：按名字找文件。 */
const FIND_VERBS = new Set(["find", "fd"]);
/** `ls` 一族：列目录。 */
const LS_VERBS = new Set(["ls", "tree", "eza"]);
/** `read` 一族：取文件内容（`sed` 需另判 `-n`）。 */
const READ_VERBS = new Set(["cat", "bat", "head", "sed", "nl"]);

/** 纯导航/输出动词：不承载探查意图，跳过。 */
const SKIP_VERBS = new Set(["cd", "pushd", "popd", "pwd", "echo", "printf", "true", "false", ":", "export", "set"]);

/**
 * 管道末尾的截断习语（`… | head -30` / `… | tail -5`）—— 原生工具有 `limit`，
 * 这截断等于它的内建行为，不该因此把整条命令放行。
 *
 * 判定要严：只认**纯数量**形态（`-30` / `-n 30`），且**末尾无文件名** ——
 * `head -20 README.md` 是真的读文件（那是 `read`），不是截断管道。
 */
function isTruncationStage(verb: string, args: string[], isLast: boolean): boolean {
	if (!isLast) return false;
	if (verb !== "head" && verb !== "tail") return false;
	const positionals = args.filter((t) => !t.startsWith("-"));
	if (positionals.length > 0) return false; // 有文件名 = 读文件
	// `-30` / `-n 30` / `--lines=30` / 裸 `-n` / 无参 head
	if (args.length === 0) return true;
	return args.every((t) => /^-\d+$/.test(t) || t === "-n" || /^--lines(=|$)/.test(t));
}

/** 组合短旗标里允许出现的字母（`-rn` / `-i` …）。`v` / `c` / `l` / `A` / `B` / `C` 都**不**在列。 */
const GREP_OK_SHORT_FLAGS = /^-[nriIsShHEFGwxR]+$/;

/**
 * shell 展开的痕迹：通配符与命令替换。
 *
 * **原生工具不做展开** —— `ls({ path: "*.md" })` 直接 `Path not found: …/*.md`（实测）。
 * 所以带展开的调用拦下来是**拦错**：模型照抄建议必然失败，还得自己摸出「用 bash 让 shell 展开」
 * 这条出路，净亏一轮。展开交给 shell 的用法本来就该留在 bash。
 *
 * 只认 `*` `?` `` ` `` `$(`，**不认** `[` `{`：`grep -n '[a-z]\+' f` 的方括号是正则不是 glob，
 * 把它当展开会漏掉一堆本该拦的检索。
 */
const SHELL_EXPANSION = /[*?`]|\$\(/;

/**
 * 未展开的 shell 变量（`$D` / `${D}` / `$f`）。
 *
 * 与通配符同理：原生工具不做参数展开，`read({path: "$D/settings.md"})` 只会去找一个字面名为
 * `$D` 的目录。拿不准变量绑的是什么值（赋值可能写在同一行的任何位置）时就**不拦** —— 实测
 * 全库 562 条（13.8%）建议里带未展开变量，这是「照抄建议必失败」的第三个大类。
 */
const SHELL_VARIABLE = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

/** 参数里有没有需要 shell 先展开的 token。 */
function hasShellExpansion(tokens: string[]): boolean {
	return tokens.some((t) => SHELL_EXPANSION.test(t) || SHELL_VARIABLE.test(t));
}

/**
 * 把 `find -name` 的 shell 模式转成 `glob` 的模式；转不了就返回 undefined（保留 `find` 建议）。
 *
 * `*` / `?` / `[` 两边的**含义一致**：shell 的方案里它们是通配符，`glob` 的
 * `normalizePattern` 又把不含 `/` 的模式自动补上 `**` 前缀（递归），所以原样透传就是对的。
 * 真正不一致、也因此要放弃的是三类：
 *
 *   - **大括号**：`find -name '{a,b}.ts'` 匹配的是**字面**文件名 `{a,b}.ts`（fnmatch 不展开），
 *     而 glob 走 minimatch 会把它当大括号展开成 `a.ts` / `b.ts` —— 转过去是静默换了语义，不转。
 *   - 反斜杠转义（`-name 'a'` 与 `a*` 的差别在 find 里靠反斜杠表达，而 `path.matchesGlob` 不认反斜杠转义）；
 *   - 带 shell 含义的字符（`$` `` ` `` `;` 空格 / `/`）—— 它们的语义在两层之间不成立。
 *
 * 另外 minimatch 把 `*{` / `*(` 当扩展通配（`*(a|b)`），而 shell 侧它们是两个独立元字符，
 * 这种组合也一律不转。
 *
 * 背景：`-path` / `-regex` 这类谓词根本不在本闸的判定范围内（被上面那个
 * `token.startsWith("-")` 挡成不拦）。
 */
function globPatternFromName(shellPattern: string): string | undefined {
	// `find . -name 'foo/bar'` 里 `-name` 带 `/` 匹配不到东西（那是 `-path` 的用法），不转。
	if (shellPattern.includes("/")) return undefined;
	// minimatch 的扩展通配 `*{` / `*(`：shell 侧不是这个意思。
	if (/\*[{(]/.test(shellPattern)) return undefined;
	let depth = 0;
	for (const ch of shellPattern) {
		if (ch === "[") {
			depth++;
			continue;
		}
		if (ch === "]") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (depth > 0) {
			// 方括号内部：`!` / `^` 是取反（两边同义）、`-` 是区间、`*` / `?` / `{` / `}` / `,`
			// 是字面字符（minimatch 在括号内同样当字面）。
			if (ch === "!" || ch === "^" || ch === "-" || ch === "." || ch === "_") continue;
			if (ch === "*" || ch === "?" || ch === "{" || ch === "}" || ch === ",") continue;
			if (/[A-Za-z0-9]/.test(ch)) continue;
			return undefined;
		}
		// 括号外部：注意 `{` / `}` / `,` **不在**放行列表 —— find 的 fnmatch 不做大括号展开
		//（匹配字面文件名），glob 的 minimatch 会展开，转过去是静默换结果；`!` 在括号外是
		// shell 的否定运算符、在 minimatch 开头还是模式取反，也不放。
		if (ch === "*" || ch === "?") continue;
		if (ch === "." || ch === "_" || ch === "-" || /[A-Za-z0-9]/.test(ch)) continue;
		// `\` / `$` / `` ` `` / `;` / 空格 / 引号残片：不猜它的语义。
		return undefined;
	}
	// 括号不闭合（`[abc`）：fnmatch 当字面、minimatch 行为不定，不转。
	if (depth !== 0) return undefined;
	return shellPattern === "" ? undefined : shellPattern;
}

/** 去掉一层引号。 */
function unquote(value: string): string {
	return value.replace(/^(['"])(.*)\1$/s, "$2");
}

/**
 * 取一段的第一个位置参数，**引号内不切词**。
 *
 * `segmentVerb` 是按空白切词的，于是 `cd "/a b/proj"` 的落点变成 `"/a` —— 带引号的空格路径
 * 会被切碎。拿这个碎值去拼 `cd` 落点 / 当 `path`，给模型的就是一条**根本跑不通**的建议
 * （实测：`cd "/Users/…/Application Support/logs" && ls` 曾给出 `path: "\"/Users/bachi/Library/Application"`）。
 *
 * 返回已去引号的完整参数；没有位置参数时返回 undefined。
 */
function firstPositionalQuoted(segment: string): string | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (quote) {
			if (ch === quote) { quote = null; continue; }
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (/\s/.test(ch)) {
			if (current) { tokens.push(current); current = ""; }
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	// 跳过动词与旗标，取第一个位置参数。
	const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
	return rest[0];
}

/**
 * 把 `cd` 落点与一个相对路径拼起来（`cd /p && cat f` 的真实目标是 `/p/f`）。
 *
 * **这是「建议跑得通」的核心**：`hint.path` 是喂给原生工具的，而原生工具在**当前 cwd**
 * 下解析它 —— 不是命令里那个 `cd` 之后的目录。不拼的话模型会去读**另一个文件**（或直接
 * `Path not found`），而实测 74% 的拦截都带 `cd` 前缀 + 相对路径，代价极大。
 *
 * 绝对路径 / `~` / `.` / 带通配符的目标原样返回：前者已完整，后两者的相对语义就是当前目录，
 * 通配符则本来就不该走到这里（带展开的命令已在 `stageFamily` 放行）。
 */
function joinWithCd(p: string | undefined, cdTarget: string | undefined, cdUnresolved: boolean): string | undefined {
	if (typeof p !== "string" || p === "") return p;
	if (p.startsWith("/") || p.startsWith("~")) return p;
	// 通配符 / 命令替换 / 未展开变量 / 残留引号不由我们拼：前两类带这些的命令已在判定层
	// 放行，后两类是转义引号把分词切碎后的残片（如 `grep -nE "^import|from \\\""` 会把 pattern
	// 尾巴当成 path）—— 拼出来只会是一条跑不通的建议。
	if (/[*?`]|\$\(/.test(p) || SHELL_VARIABLE.test(p)) return p;
	// 残留引号 = 转义引号把分词切碎后的**残片**（`grep -nE "^import|from \\\""` 会把 pattern 尾巴
	// 当成 path）。拼也无意义、直接当建议更是错的，索性不给 path。
	if (/["']/.test(p)) return undefined;
	if (p === ".") return p;
	// `cd` 落点已知：拼成绝对路径（`cd /p && cat f` 的真实目标是 `/p/f`）。
	if (cdTarget !== undefined) {
		if (/[*?`]|\$\(/.test(cdTarget) || SHELL_VARIABLE.test(cdTarget)) return undefined;
		return `${cdTarget.replace(/\/+$/, "")}/${p}`;
	}
	// `cd` 落点**要靠 shell 展开才能知道**（`cd "$DIR" && cat f`）：相对路径在当前 cwd 下
	// 指的是**另一个文件**，静默指向错目标比报错更坏 —— 宁可不给 path，让模型自己对应。
	if (cdUnresolved) return undefined;
	return p;
}

interface Stage {
	verb: string;
	args: string[];
}

/** 把一段拆成「管道里的各 stage」——按 `|` 切，引号内的不切。 */
function splitPipeline(segment: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (quote) {
			current += ch;
			if (ch === quote && segment[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "|") {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 判定一条命令里某个 stage 属于哪一族；`"skip"` = 导航/无意义，`null` = **不可拦截**
 * （出现它整条命令就放行）。
 */function stageFamily(stage: string): NativeLookupTool | "skip" | null {
	const { verb, args } = segmentVerb(stage);
	if (!verb) return "skip";
	if (SKIP_VERBS.has(verb)) return "skip";

	if (GREP_VERBS.has(verb)) {
		// 旗标必须都是能映射到原生 schema 的（`-n` 忽略、`-r` 忽略、`-i` → ignoreCase、`--include` → glob）。
		for (const token of args) {
			if (!token.startsWith("-")) continue;
			if (GREP_OK_SHORT_FLAGS.test(token)) continue;
			if (/^--include(=|$)/.test(token)) continue;
			return null; // `-v` / `-c` / `-A` / `--exclude` … 原生表达不了
		}
		// 位置参数最多两个（pattern + 单个 path）；多个 path 不拦。
		const positionals = args.filter((t) => !t.startsWith("-"));
		if (positionals.length > 2) return null;
		// 没有 path 又不递归 = 内容来自 **stdin**（`env | grep`、`cmd | grep`、`cat f | grep pat`）。
		// 原生 grep 只能搜文件，给不出「换个调用就好」的建议 → 不拦。
		// `grep -rn pat`（递归无 path）是例外：GNU grep 会搜当前目录，原生能表达。
		//
		// 注意：`cat a.txt | grep pat` 理论上能推出 `path: a.txt`，但 `splitShellSegments`
		// **把 `|` 和 `;` 当同一种分隔符**（两者都拆成独立 segment），所以无法区分
		// `cat a.txt | grep pat`（grep 读管道）与 `cat a.txt; grep pat`（grep 读 stdin）——
		// 拿不准就不拦（实测这类合计只占可拦总量的 0.4%，不值得冒险）。
		const recursive = args.some((t) => /^-[^-]*[rR]/.test(t));
		if (positionals.length < 2 && !recursive) return null;
		// path 带通配符/命令替换 → 要 shell 先展开，原生照抄必失败。
		if (hasShellExpansion(positionals.slice(1).map(unquote))) return null;
		return "grep";
	}

	if (FIND_VERBS.has(verb)) {
		// 只认 `-name` / `-iname` / `-type`；出现别的谓词（`-maxdepth` / `-mtime` / `-exec`…）就不拦。
		let i = 0;
		let hasName = false;
		let onlyFiles = true;
		while (i < args.length) {
			const token = args[i]!;
			if (token === "-name" || token === "-iname" || token === "-type") {
				if (args[i + 1] === undefined) return null;
				if (token === "-name") hasName = true;
				// `-iname` 是大小写不敏感，glob 的匹配是敏感的 —— 转过去会静默少结果。
				if (token === "-iname") onlyFiles = false;
				// `-type d` / `-type l` 找的是目录与链接，而 glob 只返回文件。
				if (token === "-type" && args[i + 1] !== "f") onlyFiles = false;
				i += 2;
				continue;
			}
			if (token.startsWith("-")) return null;
			i += 1;
		}
		// 搜索起点只能是**第一个谓词之前**的位置参数 —— `args.filter(!startsWith("-"))` 会把
		// `-name` 的**值**（`*.ts`）也当成起点，拿它判定就会把 `find . -name "*.ts"` 误当成两个起点。
		const firstFlag = args.findIndex((t) => t.startsWith("-"));
		const dirs = args.slice(0, firstFlag === -1 ? args.length : firstFlag).map(unquote);
		// 起点是 shell 展开出来的（`find * -name x`）→ 原生照抄必失败。
		if (hasShellExpansion(dirs.slice(0, 1))) return null;
		// **多个搜索起点**（`find src tests -name "*.ts"`）：`glob` / `find` 都只收一个 `path`，
		// 照抄建议会静默漏掉其余目录 —— 与 `ls a b` 同口径（那里也是 `return null`）。
		// 2026-10-24 补：这是 find 分支一直存在的漏拦（`buildHint` 只取 `dirs[0]`），改指 glob 后同样会漏。
		if (dirs.length > 1) return null;
		// `find … -name '<模式>'` 就是「按文件名找」—— 那正是 `glob` 的本职（候选集来自仓库清单），
		// 而 `find` 是 `fd --hidden` 全量遍历。2026-10-24 之前这里一律给 `find`，等于把模型从
		// 它刚被拦下的那条路上原地挪了一步。剩下能到 `find` 的只有 `fd`、以及带 `-iname` /
		// `-type d` 这些 glob 表达不了的形态。
		//
		// 子代理会话不用在这里防：`bash-command-collapse.ts` 的 gate 在调 `detectBashLookup`
		// **之前**就用 `isSubagentSession(env, sessionFileOf(ctx))` 把子会话整个跳过了。
		// 跳过的依据是历史实测（2026-10-23 super-dingding 会话）：12 个 worker 子代理
		// 被拦 64 次，每次白烧一轮（worker 均 9.6s）却没改用原生工具 —— 只会说一句
		// 「我改」再重试。注意这**不是**因为它们读不到规则：白名单里的 `core-rules`
		// 会注入 AGENTS.core.md，Tool choice 段它们读得到（2026-10-24 实测子会话的
		// custom_message 含该段）。
		// （2026-10-24 起 `subagents.defaultExtensions` 已把 `glob-tool/` 加进白名单，
		// 子代理的工具集里有 `glob`；但 gate 跳过子会话的口径不变。）
		if (verb === "find" && hasName && onlyFiles) {
			const nameIdx = args.findIndex((t) => t === "-name");
			const pattern = nameIdx >= 0 ? globPatternFromName(unquote(args[nameIdx + 1] ?? "")) : undefined;
			if (pattern !== undefined) return "glob";
		}
		return "find";
	}

	if (LS_VERBS.has(verb)) {
		// `-R` 递归原生做不了；其余旗标放行（原生只给名字，拦截语里会说明）。
		if (args.some((t) => /^-[^-]*R/.test(t))) return null;
		// 元信息旗标（`-l` / `-t` / `-S` / `-h`）**照旧拦** —— 这是刻意保留的策略，不是遗漏：
		// 屏上多数 `ls -la` 只是想看目录里有什么，原生 `ls` 给了名字就够；真需要大小/时间时
		// 拦截语会明说改走 bash 的 `stat` / `du`（那两条不拦）。代价是极少数**确实为元信息**而发的
		// `ls -la` 会多花一轮，实测其量级很小（全库 3 次真实拦截里 2 次下一轮又用了 `ls`，
		// 即模型确实被送到了另一条 bash 而不是原生 —— 保留）。（若日后想放掉，判定改成
		// `/^-[^-]*[lthS]/` 即可，同时要同步 `explored-group` 的折叠口径与本节单测。）
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		// 通配符（`ls *.md` / `ls -d */`）要 shell 展开，原生照抄必失败。
		if (hasShellExpansion(positionals)) return null;
		// 一次列多个路径 —— 原生 `ls` 只收一个 path，照抄会静默漏掉其余（同 `cat a b` 的口径）。
		if (positionals.length > 1) return null;
		return "ls";
	}

	if (READ_VERBS.has(verb)) {
		if (verb === "sed") {
			// 只有 `sed -n '1,60p' file` 这种「打印区间」才等价于 read(offset/limit)。
			if (!args.includes("-n")) return null;
			const script = args.find((t) => !t.startsWith("-"));
			if (!script || !/^\d+(,\d+)?p$/.test(unquote(script))) return null;
		}
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		// `cat a b c` 原生 read 一次只读一个文件 → 不拦（免得逼出好几轮）。
		let files = verb === "sed" ? positionals.slice(1) : positionals;
		// `head -n 20 f` 的 `20` 是 `-n` 的**值**、不是文件名 —— 不剔掉它就会数成「两个文件」
		// 而整条放行（实测：`head -n 20 f` 漏拦，而同义的 `head -20 f` 拦得住）。
		if (verb === "head" || verb === "tail") {
			const nIdx = args.indexOf("-n");
			const count = nIdx >= 0 ? args[nIdx + 1] : undefined;
			if (count !== undefined && /^\d+$/.test(count)) files = files.filter((f) => f !== count);
		}
		if (files.length !== 1) return null;
		// `cat *.log` 要 shell 展开，原生照抄必失败。
		if (hasShellExpansion(files)) return null;
		return "read";
	}

	return null;
}

/** 抽出「照这个调用」的提示。抽不到就返回 undefined —— 措辞会退回泛指。 */
function buildHint(tool: NativeLookupTool, stages: Stage[], cdTarget: string | undefined, cdUnresolved: boolean): LookupRedirect["hint"] {
	const positionals = (args: string[]) => args.filter((t) => !t.startsWith("-")).map(unquote);
	const join = (p: string | undefined) => joinWithCd(p, cdTarget, cdUnresolved);
	for (const stage of stages) {
		if (tool === "grep" && GREP_VERBS.has(stage.verb)) {
			const pos = positionals(stage.args);
			const hint: Record<string, unknown> = { pattern: pos[0] };
			// 未给 path 时：先拿 `cd` 落点，再拿 `.`；`cd` 落点不可解时不猜（见 `joinWithCd`）。
			const path = join(pos[1] ?? (cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? "."));
			hint.path = path;
			// `^-[^-]*i`：只认**短旗标**里的 `i`。原来的 `/^-.*i/` 会把 `--include=*.ts` 里的
			// `i` 当成 `-i`（实测 `grep -rn foo --include=*.ts .` 给出 ignoreCase:true），
			// 模型照抄后检索结果被静默放大 —— 这类「照抄建议就错」比不拦更贵。
			if (stage.args.some((t) => /^-[^-]*i/.test(t))) hint.ignoreCase = true;
			const include = stage.args.find((t) => t.startsWith("--include="));
			if (include) hint.glob = unquote(include.slice("--include=".length));
			return { pattern: pos[0], path, args: { pattern: pos[0], ...hint } };
		}
		if (tool === "glob" && FIND_VERBS.has(stage.verb)) {
			const nameIdx = stage.args.findIndex((t) => t === "-name");
			const pattern = globPatternFromName(unquote(stage.args[nameIdx + 1] ?? ""));
			// 搜索起点只能是**第一个谓词之前**的位置参数 —— `positionals()` 会把 `-name` 的
			// **值**（`*.ts`）也当成位置参数拿进来，拿它当 path 就成了一条跑不通的建议。
			const firstFlag = stage.args.findIndex((t) => t.startsWith("-"));
			const leading = stage.args.slice(0, firstFlag === -1 ? stage.args.length : firstFlag).map(unquote);
			const dir = leading[0] ?? (cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? ".");
			const path = join(dir);
			// `glob({pattern, path})`：pattern 在前（它是必填），与工具 schema 同序。
			return { pattern, path, args: { pattern, path } };
		}
		if (tool === "find" && FIND_VERBS.has(stage.verb)) {
			const nameIdx = stage.args.findIndex((t) => t === "-name" || t === "-iname");
			const pattern = nameIdx >= 0 ? unquote(stage.args[nameIdx + 1] ?? "") : "";
			const path = join(positionals(stage.args)[0] ?? (cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? "."));
			return { pattern, path, args: { pattern, path } };
		}
		if (tool === "ls" && LS_VERBS.has(stage.verb)) {
			const explicit = positionals(stage.args)[0];
			const path = explicit !== undefined
				? join(explicit)
				: cdUnresolved && cdTarget === undefined ? undefined : cdTarget ?? ".";
			return { path, args: { path } };
		}
		if (tool === "read" && READ_VERBS.has(stage.verb)) {
			const pos = positionals(stage.args);
			// `head -n 20 f` 的 `20` 是 `-n` 的值，不是文件名 —— 不当心就会把 hint 写成 `path: "20"`。
			const names = stage.verb === "head" || stage.verb === "tail"
				? pos.filter((p) => !/^\d+$/.test(p) || !stage.args.includes("-n"))
				: pos;
			const file = stage.verb === "sed" ? names[1] : names[0];
			const resolved = join(file);
			const args: Record<string, unknown> = { path: resolved };
			if (stage.verb === "head") {
				// `head -20 f` 与 `head -n 20 f` 两种写法都要认（后者原先漏给 limit，光秃秃一条 read）。
				const afterN = stage.args.includes("-n") ? stage.args[stage.args.indexOf("-n") + 1] : undefined;
				const n = afterN !== undefined && /^\d+$/.test(afterN)
					? afterN
					: stage.args.find((t) => /^-\d+$/.test(t));
				if (n) args.limit = Number(String(n).replace(/^-/, ""));
			}
			if (stage.verb === "sed") {
				// `sed -n '92,121p' f` → read({path, offset: 92, limit: 121 - 92 + 1})
				// 单行形式 `sed -n '42p' f` → offset 42, limit 1
				const range = unquote(pos[0] ?? "").match(/^(\d+)(?:,(\d+))?p$/);
				if (range) {
					const start = Number(range[1]);
					const end = range[2] === undefined ? start : Number(range[2]);
					if (end >= start) {
						args.offset = start;
						args.limit = end - start + 1;
					}
				}
			}
			return { path: resolved, args };
		}
	}
	return undefined;
}

/**
 * 判定这条 bash 命令是不是「本该用原生工具的单一探查」。
 *
 * 返回非 null = 拦下来，并把建议的原生调用交给模型；返回 null = 放行给 bash。
 */
export function detectBashLookup(command: string): LookupRedirect | null {
	const trimmed = command.trim();
	if (trimmed === "") return null;

	const segments = splitShellSegments(trimmed);
	if (segments.length === 0) return null;

	// 先过一遍只读白名单：写重定向 / `sed -i` / 未知动词（node、python、git、npm…）
	// 在这里就被挡掉，语义与 explored-group 的折叠判定共用同一套 shell 解析。
	const stages: Stage[] = [];
	const families: NativeLookupTool[] = [];

	let cdTarget: string | undefined;
	// `cd` 的落点要靠 shell 展开才能知道（`cd "$DIR"` / `cd /x/*/pkg`）—— 此时相对路径不能当 path。
	let cdUnresolved = false;

	for (const segment of segments) {
		const pipeline = splitPipeline(segment);
		for (let si = 0; si < pipeline.length; si++) {
			const stage = pipeline[si]!;
			const { verb, args } = segmentVerb(stage);
			// 末尾的 `| head -N` 只是截断习语 —— 原生工具有 limit，跳过而不是放行。
			if (isTruncationStage(verb, args, si === pipeline.length - 1)) continue;
			const family = stageFamily(stage);
			if (family === null) return null;
			if (family === "skip") {
				// 顺手记下 `cd X &&` 的落点：后面 grep 没写 path 时它就是有效作用域。
				// 用引号感知的取词 —— `segmentVerb` 按空白切词会把 `"/a b"` 切成 `"/a`。
				if (verb === "cd") {
					const target = firstPositionalQuoted(stage);
					// `cd` 落点要靠 shell 展开才能知道时（`cd "$DIR"`、`cd /x/*/pkg`）**清空**它：
					// 不清的话，后面的相对路径会原样当成 `path`（如 `path: "f.ts"`），
					// 而它在当前 cwd 下指的是**另一个文件** —— 静默指向错目标比报错更坏。
					// 清空后 `buildHint` 会退回 `cdTarget` 为空的路径（通常是 `undefined` →
					// 渲染成「自行对应到 schema」），模型自己知道该去哪里找。
					cdTarget = target && target !== "-" && !SHELL_VARIABLE.test(target) && !SHELL_EXPANSION.test(target)
						? target
						: undefined;
					cdUnresolved = cdTarget === undefined;
				}
				continue;
			}
			stages.push({ verb, args });
			if (!families.includes(family)) families.push(family);
		}
	}

	if (families.length === 0 || stages.length === 0) return null;

	// 优先级：grep > glob > find > ls > read。`cat f | grep pat` 的意图是 grep（path=f），
	// 取最左会误判成 read；而 `find … -name` 现在归 glob —— 它与 grep 同现时（`find … -name x; grep foo`）
	// 真正的目的是 grep（先用 find 挑文件再搜内容），所以 grep 仍在 glob 之前。
	const priority: NativeLookupTool[] = ["grep", "glob", "find", "ls", "read"];
	const tool = priority.find((t) => families.includes(t)) ?? families[0]!;
	const hint = buildHint(tool, stages, cdTarget, cdUnresolved);
	return { tool, hint, tools: families };
}

/** 原生调用建议的「照抄这一行」文本。 */
function callSnippet(redirect: LookupRedirect): string {
	const args = redirect.hint?.args;
	if (!args || Object.values(args).some((v) => v === undefined)) return `\`${redirect.tool}\` 工具`;
	const body = Object.entries(args)
		.map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`)
		.join(", ");
	return `\`${redirect.tool}({ ${body} })\``;
}

/**
 * 拦截语：给模型看的正文。
 *
 * 三段：**该调什么** / **为什么** / **`.gitignore` 例外**。必须短（每次拦截都是 token），
 * 但 `.gitignore` 那条例外不能省 —— 省了就会静默漏搜。
 */
export function renderLookupRedirect(redirect: LookupRedirect): string {
	const lines = [
		`[lookup gate] 这条 bash 命令是一次纯粹的「${redirect.tool}」探查，已被拦下 —— 请改用 pi 的原生工具。`,
		``,
		`改调用：${callSnippet(redirect)}`,
	];
	if (!redirect.hint?.args) {
		lines.push(`（参数请自行对应到 \`${redirect.tool}\` 工具的 schema）`);
	}
	lines.push(
		``,
		`为什么：原生工具更快、输出自带截断（不会刷屏），也省 token。`,
	);
	if (redirect.tool === "grep" || redirect.tool === "find") {
		lines.push(
			`注意：原生 \`${redirect.tool}\` 尊重 \`.gitignore\`（会跳过 \`node_modules/\`、\`dist/\` 等）；` +
				`确实要搜被忽略的树时，把那个目录**显式**作为 path 传入即可穿透（显式 path 不过滤）。`,
		);
	}
	if (redirect.tool === "glob") {
		lines.push(
			`注意：\`glob\` 的候选集来自 \`git ls-files\`（索引里的文件，已按 .gitignore 过滤，不含 .git/ 内部）；` +
				`它只按**文件名**匹配、不搜内容 —— 搜内容请用 \`grep\`。模式不含 \`/\` 时自动递归（\`*.ts\` 等价于 \`**/*.ts\`）。`,
		);
	}
	if (redirect.tool === "ls") {
		lines.push(`注意：原生 \`ls\` 只给条目名；需要大小/时间等元信息请用 bash 的 \`stat\` / \`du\`（不会被拦）。`);
	}
	lines.push(
		``,
		`（这条闸门可用 \`PI_BASH_LOOKUP_GATE=off\` 关闭；复合探查、变换器、写操作、测试命令都不会被拦。）`,
	);
	return lines.join("\n");
}

/**
 * 会话文件路径是否属于 pi-subagents 的子会话。
 *
 * 形状差异（2026-10-23 实测两条路径一致）：
 *   父会话  `sessions/<proj>/<ts>_<id>.jsonl`
 *   子会话  `sessions/<proj>/<ts>_<id>/<runId>/run-N/session.jsonl`
 * 即带 `run-<N>` 目录段、文件名是 `session.jsonl`。
 */
export function isSubagentSessionFile(sessionFile: unknown): boolean {
	if (typeof sessionFile !== "string" || sessionFile.length === 0) return false;
	// 两段一起判，避免把恰好名字叫 session.jsonl 的父会话误判成子会话。
	return /(^|\/)run-\d+\/session\.jsonl$/.test(sessionFile.replace(/\\/g, "/"));
}

/**
 * 是否跑在 pi-subagents 的子会话里。
 *
 * 两个判据，任一成立即是子会话：
 *
 * 1. **`PI_SUBAGENT_CHILD=1`** —— pi-subagents 的 async runner 在自己的进程上设
 *    （`runs/background/subagent-runner.js`），其后代进程同样继承。
 * 2. **会话文件落在嵌套子目录** —— 前台派发（`async: false`）的子会话跑在**父进程内**，
 *    没有独立 runner，`PI_SUBAGENT_CHILD` 实测为空（2026-10-23 实测确认）。这时
 *    也不能读 `process.env.PI_SESSION_FILE`：扩展与父会话共用同一个 `process.env`，
 *    读到的是**父会话**的值。必须用 `tool_call` 的 `ctx.sessionManager.getSessionFile()`
 *    （它是绑定到子会话的）—— 所以 `bash-command-collapse.ts` 传的是 ctx 的会话文件，
 *    `env` 只用于单元测试与无 ctx 的调用方。
 *
 * 为什么子会话要关掉单一探查闸：这条闸是给**交互会话**定的规则（用户 2026-10-06
 * 要求「该用原生工具时就用」），但子代理的 `tools` 白名单由它自己的 agent 定义
 * （`reviewer` / `researcher` 根本没有 bash）。注意子代理**并非读不到这条规则**：
 * 它们不继承全局 AGENTS.md（`inheritGlobalContext: false`），但白名单里的 `core-rules`
 * 会注入 AGENTS.core.md 的蒸馏版，Tool choice 段在里面（2026-10-24 实测子会话的
 * custom_message 含该段）。实测
 * （2026-10-23 的 super-dingding 兜底画像化会话）：12 个 worker 子代理被这条闸拦了
 * 64 次，每次白烧一个 turn（worker 均 9.6s）。拦下来得到的不是「它改用原生工具」，
 * 而是「它再花一轮说抱歉」。
 */
export function isSubagentSession(
	env: NodeJS.ProcessEnv = process.env,
	sessionFile?: unknown,
): boolean {
	if (env.PI_SUBAGENT_CHILD === "1") return true;
	if (isSubagentSessionFile(sessionFile)) return true;
	// 没传 ctx 的会话文件时（单测 / 无 ctx 调用方）退回 env：async 子进程的 bash
	// 拿到的是注入过的 env，所以 shape 在这里仍然可信。
	return isSubagentSessionFile(env.PI_SESSION_FILE);
}
