/**
 * explored-group / phrases —— 把一次工具调用压成 `Explored` 分组里的一行短语。
 *
 * 纯函数，零 pi 依赖。形态目标（用户 2026-10-06 定，第三轮修订后）：
 *
 *     • Explored
 *       └ Search "bashOutput" in clients/pi
 *         Read …/extensions/background-tasks/render.ts 100-169
 *         Read …/ttt/CLAUDE.md, …/ttt/package.json
 *
 * （`└ ` 整块只出现一次，挂在第一行；其余成员行四格缩进 —— 画法在 `render.ts`。）
 *
 * ## 短语表
 *
 * 覆盖率是在本机 19847 条真实 bash 调用上量过的（去掉不可折叠的之后统计），
 * 只保留出现最多的那几种形态 —— 罕见的留给 `Explore <verb> <args 摘要>` 兜底。
 *
 * | 命令 | 行 |
 * |---|---|
 * | `grep/rg [-rn] PATTERN [FILE/DIR]` | `Search "PATTERN" [in PATH]` |
 * | `ls/fd/tree [PATH]` | `List PATH` |
 * | `find DIR -name GLOB` | `Find GLOB in DIR` |
 * | `git status\|log\|diff\|…` | `Git status` 等 |
 * | `sed -n 'A,Bp' FILE` | `Read FILE A-B` |
 * | `cat/head/tail/jq/wc/diff FILE` | `Read FILE` / `Tail FILE` |
 * | `stat FILE` | `Stat FILE` |
 * | `which a b` | `Which a b` |
 *
 * ## 路径缩略（用户的口径：缩到两层目录）
 *
 * `/Users/bachi/jaylli/ttt/a/b/CLAUDE.md` → `…/ttt/a/b/CLAUDE.md` 里那个 `…` 前缀
 * **不是**这里拍的 —— 规则是「最多保留两层目录 + 文件名」，更长才前缀 `…`：
 *
 *     ~/.pi/agent/extensions/a/b/index.ts   →  …/a/b/index.ts      （6 层，缩）
 *     clients/pi/extensions/read.ts         →  …/pi/extensions/read.ts（3 层目录，缩）
 *     clients/pi/read.ts                    →  clients/pi/read.ts   （2 层，原样）
 *     src/index.ts                          →  src/index.ts         （1 层，原样）
 *     package.json                          →  package.json         （无目录，原样）
 *
 * 起点选择：**cwd 之下的用相对路径**（最短也最有意义），home 之下的用 `~`，
 * 其余用绝对路径再缩。顺序不能反 —— `/Users/bachi/jaylli/litellm-any/...` 同时满足
 * 「在 home 下」与「在 cwd 下」，要的是后者（相对更短）。
 */

import { classifyToolCall, segmentVerb, splitShellSegments, stripRedirects } from "./classify.ts";

/** 缩略后保留的目录层数（用户 2026-10-06 定：两层）。改这一个常量即可。 */
export const PATH_TAIL_DIRS = 2;
/** 缩略前缀（U+2026 + 斜杠），与 bash 侧折叠用的 `…` 同一字形。 */
const ELLIPSIS_PREFIX = "…/";

/** 去掉一层引号（单/双），返回内容。 */
function unquote(value: string): string {
	return value.replace(/^(['"])(.*)\1$/s, "$2");
}

/** 是否像一个路径（含 `/`，或像 `foo.ts` / `.gitignore` / `Makefile` 之外的文件名）。 */
function looksLikePath(token: string): boolean {
	return token.includes("/") || /\.[A-Za-z0-9]+$/.test(token);
}

/** 去掉 `VAR=value` 形式的环境前缀（`P=/path cmd` 里的 `P=` 部分）。 */
function stripEnvPrefix(token: string): string | null {
	const match = token.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s);
	return match ? match[1]! : null;
}

/**
 * 路径缩略：**最多保留 `PATH_TAIL_DIRS` 层目录 + 最后一段**（文件或目录名），更长才前缀 `…/`。
 *
 * 起点优先级：cwd 相对 → home 相对（`~`）→ 绝对路径。反转顺序会让
 * `/Users/bachi/jaylli/litellm-any/x.ts` 变成 `~/jaylli/litellm-any/x.ts`（更长也更绕）。
 */
export function shortenPath(input: string, cwd: string | undefined): string {
	let value = unquote(input.trim());
	if (!value) return value;
	if (value === "~") return value;

	const home = process.env.HOME;
	if (cwd && (value === cwd || value.startsWith(`${cwd}/`))) {
		value = value === cwd ? "." : value.slice(cwd.length + 1);
	} else if (home && (value === home || value.startsWith(`${home}/`))) {
		value = value === home ? "~" : `~/${value.slice(home.length + 1)}`;
	}

	// `~` / `…` 也算一段普通名字参与层数计算（`~/a/b/c.ts` = 3 目录 + 文件名）。
	const parts = value.split("/").filter(Boolean);
	if (parts.length <= PATH_TAIL_DIRS + 1) return value;
	return `${ELLIPSIS_PREFIX}${parts.slice(-(PATH_TAIL_DIRS + 1)).join("/")}`;
}

/**
 * 从一段命令的位置参数里挑出「像路径的那个」，用于短语里的路径。
 *
 * 三个踩过的坑，都在 19847 条语料上核过：
 *   ① `grep -rn PATTERN a.ts | grep -v node_modules` —— 第二个 grep 的位置参数是
 *      `node_modules`，不是路径。所以带 `-v`（反转）的段不给路径。
 *   ② `tail -60 _vimrc` 的 `-60` 是行数不是文件名；`2>/dev/null` 里的 `2` 也不是
 *（后者的重定向已在 `stripRedirects` 里剥掉）。按「带点 / 带斜杠」判定 + 排除纯数字。
 *   ③ 兜底很重要：`cat f` / `grep -n x f` 里的 `f` 没有点也没斜杠，**仍要当路径**，
 *      否则这些命令一条短语都生不出来。
 */
function pickPathToken(args: string[]): string | undefined {
	const positionals = args
		.filter((token) => !token.startsWith("-"))
		.map(unquote)
		.filter((token) => token && token !== ";" && !/^\d+$/.test(token));
	// 优先「带斜杠」的（最像路径），其次「像文件名」的，最后取第一个位置参数兜底
	return positionals.find((token) => token.includes("/"))
		?? positionals.find((token) => looksLikePath(token))
		?? positionals[0];
}

/** 取第一个位置参数（`grep` 的 PATTERN、`find` 的 DIR…）。 */
function firstPositional(args: string[]): string | undefined {
	return args
		.filter((token) => !token.startsWith("-"))
		.map(unquote)
		.find((token) => token.length > 0);
}

/** 截断过长的单个 token（正则模式常常很长），中段省略。 */
function clip(text: string, max = 48): string {
	if (text.length <= max) return text;
	const head = Math.ceil((max - 1) / 2);
	return `${text.slice(0, head)}…${text.slice(-(max - 1 - head))}`;
}

/** 递归与否：`-r` / `-R` / `--recursive` 或组合短旗标里带 r（`-rn`）。 */
function isRecursive(args: string[]): boolean {
	return args.some((token) => /^--recursive$/.test(token) || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(token));
}

/** 生成一段命令的短语；返回 `null` 表示这一段不值得单独成行（如纯 `cd`）。 */
function phraseForSegment(segment: string, cwd: string | undefined): string | null {
	const { verb, args } = segmentVerb(stripRedirects(segment));
	if (!verb) return null;

	if (verb === "grep" || verb === "egrep" || verb === "fgrep" || verb === "rg" || verb === "ag" || verb === "ack") {
		if (args.includes("-v")) return null; // 过滤段，不是检索段
		const pattern = firstPositional(args);
		if (!pattern) return null;
		// 路径 = 除 pattern 之外的第一个位置参数
		const rest = args.slice(args.indexOf(args.find((t) => unquote(t) === pattern) ?? pattern) + 1);
		const rawPath = pickPathToken(rest);
		const scope = rawPath
			? shortenPath(rawPath, cwd)
			: isRecursive(args) ? "." : undefined;
		return scope ? `Search "${clip(pattern)}" in ${scope}` : `Search "${clip(pattern)}"`;
	}

	if (verb === "ls" || verb === "tree" || verb === "eza" || verb === "fd" || verb === "du") {
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote).filter((t) => !/^\d+$/.test(t));
		const target = positionals[positionals.length - 1];
		const verbWord = verb === "du" ? "Size" : "List";
		return `${verbWord} ${target ? shortenPath(target, cwd) : "."}`;
	}

	if (verb === "find") {
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		const glob = positionals.find((t) => t.includes("*") || t.includes("?"));
		const dir = positionals.find((t) => !t.includes("*") && !t.includes("?"));
		return glob
			? `Find ${clip(glob)}${dir ? ` in ${shortenPath(dir, cwd)}` : ""}`
			: `Find${dir ? ` in ${shortenPath(dir, cwd)}` : " files"}`;
	}

	if (verb === "git") {
		const sub = args.find((t) => !t.startsWith("-"));
		return sub ? `Git ${sub}` : "Git";
	}

	if (verb === "sed") {
		const positionals = args.filter((t) => !t.startsWith("-")).map(unquote);
		const range = positionals.find((t) => /^\d+,\d+p$/.test(t));
		const file = pickPathToken(positionals.filter((t) => t !== range));
		const where = file ? shortenPath(file, cwd) : undefined;
		const span = range ? ` ${range.slice(0, -1).replace(",", "-")}` : "";
		return where ? `Read ${where}${span}` : null;
	}

	if (verb === "head" || verb === "tail") {
		const file = pickPathToken(args.filter((t) => !/^-\d+$/.test(t)));
		if (!file) return null;
		return `${verb === "tail" ? "Tail" : "Read"} ${shortenPath(file, cwd)}`;
	}

	if (verb === "stat") {
		const file = pickPathToken(args);
		return file ? `Stat ${shortenPath(file, cwd)}` : null;
	}

	if (verb === "which" || verb === "type") {
		const names = args.filter((t) => !t.startsWith("-")).map(unquote).slice(0, 3);
		return names.length ? `Which ${names.join(" ")}` : null;
	}

	if (verb === "cat" || verb === "bat" || verb === "less" || verb === "more" || verb === "nl" || verb === "tac" ||
		verb === "cut" || verb === "wc" || verb === "diff" || verb === "comm" || verb === "jq" || verb === "yq" ||
		verb === "file" || verb === "sort" || verb === "uniq" || verb === "awk" || verb === "gawk" ||
		verb === "xxd" || verb === "od" || verb === "strings" || verb === "md5" || verb === "shasum") {
		const file = pickPathToken(args);
		if (!file) return null;
		const path = shortenPath(file, cwd);
		// `diff a b` 两个文件都给（比较的双方都在）
		if (verb === "diff") {
			const both = args.filter((t) => !t.startsWith("-")).map(unquote).filter((t) => looksLikePath(t)).slice(0, 2);
			if (both.length === 2) return `Diff ${shortenPath(both[0]!, cwd)} ${shortenPath(both[1]!, cwd)}`;
		}
		return `Read ${path}`;
	}

	return null;
}

/**
 * 一次工具调用 → 一行短语。返回 `null` 表示这一刻还产生不了短语
 * （比如 bash 命令只有 `cd`），调用方应跳过该行。
 *
 * `read` 的多个文件由**上层**（`render.ts`）合并到一行，所以这里只回单个路径。
 */
export function phraseForToolCall(
	toolName: string,
	args: unknown,
	cwd: string | undefined,
): string | null {
	if (toolName === "grep") {
		const pattern = (args as { pattern?: string })?.pattern;
		const path = (args as { path?: string })?.path;
		if (!pattern) return null;
		return path ? `Search "${clip(pattern)}" in ${shortenPath(path, cwd)}` : `Search "${clip(pattern)}"`;
	}
	if (toolName === "find") {
		const pattern = (args as { pattern?: string })?.pattern;
		const path = (args as { path?: string })?.path;
		if (!pattern) {
			return path ? `Find in ${shortenPath(path, cwd)}` : "Find files";
		}
		return `Find ${clip(pattern)}${path ? ` in ${shortenPath(path, cwd)}` : ""}`;
	}
	if (toolName === "ls") {
		const path = (args as { path?: string })?.path;
		return `List ${path ? shortenPath(path, cwd) : "."}`;
	}
	if (toolName === "read") {
		const path = (args as { path?: string })?.path;
		if (!path) return null;
		return `Read ${shortenPath(path, cwd)}${readSpanSuffix(args)}`;
	}
	if (toolName === "bash") {
		const command = (args as { command?: string })?.command ?? "";
		const verdict = classifyToolCall("bash", args);
		if (!verdict.kind) return null;
		const lines: string[] = [];
		for (const segment of splitShellSegments(command)) {
			const phrase = phraseForSegment(segment, cwd);
			if (phrase && !lines.includes(phrase)) lines.push(phrase);
		}
		return lines.length ? lines[0]! : null;
	}
	return null;
}

/** 供测试与调试：一次性拿到一条 bash 命令的**全部**短语（多段命令会多于一条）。 */
export function phrasesForBash(command: string, cwd: string | undefined): string[] {
	const lines: string[] = [];
	for (const segment of splitShellSegments(command)) {
		const phrase = phraseForSegment(segment, cwd);
		if (phrase && !lines.includes(phrase)) lines.push(phrase);
	}
	return lines;
}

/**
 * `read` 的行号后缀 —— **与 pi 内置标题同口径**（`formatReadLineRange`：
 * `startLine = offset ?? 1`，`endLine = limit !== undefined ? startLine + limit - 1 : ""`）。
 *
 * 三种给法都必须看得见，缺一不可（真实语料里都存在，全库 440 个会话统计：
 * `offset+limit` 1176 次、**只给 `offset` 40 次**、**只给 `limit` 90 次**、都不给 1287 次）：
 *
 * | 调用 | 后缀 |
 * |---|---|
 * | `{offset: 100, limit: 70}` | ` 100-169` |
 * | `{offset: 100}` | ` 100` |
 * | `{limit: 45}` | ` 1-45` |
 * | `{}` | 空 |
 *
 * 旧实现用 `offset && limit` 做条件，于是只给一个参数时**整段区间静默消失** ——
 * 「读的是哪一段」是这一行最要紧的事实之一，而 pi 原生会显示 `:100` / `:1-45`，
 * 折叠后反而把它丢了（用户 2026-10-06 报「行号信息似乎丢失了」）。
 *
 * `read` 的 span 在合并行里同样保留（同一文件读不同段是不同的事实）。
 */
export function readSpanSuffix(args: unknown): string {
	const offset = (args as { offset?: number })?.offset;
	const limit = (args as { limit?: number })?.limit;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	// `limit` 没给时只知道起点（与 pi 一致：`endLine` 留空，不猜长度）
	return limit === undefined ? ` ${start}` : ` ${start}-${start + limit - 1}`;
}
