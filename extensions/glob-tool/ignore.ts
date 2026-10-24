/**
 * glob-tool / ignore —— `.gitignore` **子集**匹配器。**纯函数，零 pi 依赖。**
 *
 * ## 它在架构里的位置：只为走查档服务
 *
 * 有 git 可用时（`git ls-files` 那条路）**根本不需要这个文件** —— git 自己就实现了完整的
 * `.gitignore` 语义（嵌套、`!` 否定、`.git/info/exclude`、全局 `core.excludesFile`）。
 * 所以这个匹配器只在 **档 3（没有仓库的目录走查）** 时被用来剪枝。
 *
 * 这条背景决定了它的正确性标准：**保守方向是"宁可多列，不可误剪"**。多列一个文件只是噪声；
 * 少列一个文件会让模型以为它不存在 —— 那是静默的错误，且模型无法察觉。所以：
 *
 * - 不认识的语法 → **跳过这条规则**（不剪枝），而不是猜；
 * - 编译失败的模式 → 同上；
 * - 只实现 gitignore 里最常见的那几种形态，复杂形态一律放行。
 *
 * ## 实现的子集
 *
 * | 形态 | 语义 |
 * | --- | --- |
 * | `# …` / 空行 | 注释，跳过 |
 * | `!pattern` | 否定：后出现者胜 |
 * | `pat/` | 只匹配目录 |
 * | `/pat` | 锚定到搜索根（不加"任意层"前缀） |
 * | 含 `/` | 锚定到搜索根 |
 * | 不含 `/` | 匹配任意层（加 `**` + `/` 前缀） |
 * | `*` `?` `**` `[a-c]` `{a,b}` | 交给 `matchesPattern`（即 `path.matchesGlob`） |
 *
 * **不实现**（刻意，见上面的保守方向）：`\` 转义、`**` 在中间段的多义展开、
 * 字符类里的 `[!]` 与 POSIX 类、以及 `.gitignore` 的"父目录被忽略则子路径无从否定"那条细节。
 */

import { matchesPattern, normalizePattern } from "./match.ts";

/** 一条编译好的规则。 */
interface IgnoreRule {
	/** 归一后的模式（已含锚定前缀）。 */
	pattern: string;
	/** `!` 前缀：命中时表示"不忽略"。 */
	negate: boolean;
	/** 尾斜杠：只对目录生效。 */
	dirOnly: boolean;
}

/**
 * 编译一条 `.gitignore` 行为规则；返回 `null` 表示这条规则不可用（该放行）。
 *
 * 判据与 git 的规则一致的部分：前导 `/` 与"模式里含 `/`"都表示锚定到搜索根。差别在于
 * git 的 `**` 有段级多义（中间层 `**` 匹配零层或多层），`path.matchesGlob` 也已经支持这一点
 * （实测：中间层的 `**` 同时匹配零层与多层），所以这里不需要额外处理。
 */
function compileRule(rawLine: string): IgnoreRule | null {
	const line = rawLine.trim();
	if (line === "" || line.startsWith("#")) return null;

	let body = line;
	let negate = false;
	if (body.startsWith("!")) {
		negate = true;
		body = body.slice(1);
	} else if (body.startsWith("\\!") || body.startsWith("\\#")) {
		// 转义的 `!` / `#` 是字面量 —— 转义本身未实现，稳妥起见放行整条规则。
		return null;
	}
	if (body === "") return null;

	let dirOnly = false;
	if (body.endsWith("/")) {
		dirOnly = true;
		body = body.slice(0, -1);
	}
	if (body === "") return null;

	// 锚定判定要在剥掉前导 `/` **之前**做。
	const anchored = body.startsWith("/") || body.includes("/");
	const bare = body.replace(/^\/+/, "");
	if (bare === "") return null;

	// 不含斜杠（且未锚定）→ 匹配任意层：`normalizePattern` 会对不含 `/` 的模式做隐式递归。
	// 锚定的必须**跳过** `normalizePattern` 的递归分支：`normalizePattern("dist")` 会变成
	// `**` + `/` + `dist`（匹配任意层），而 `.gitignore` 里的 `/dist` 只匹配根层。所以锚定
	// 时直接拿剥掉前导 `/` 的原串，只补尾斜杠那一类归一（这里 `dirOnly` 已单独处理）。
	const pattern = anchored ? bare : normalizePattern(bare);
	return { pattern, negate, dirOnly };
}

/**
 * 用一组 `.gitignore` 行造一个匹配器。
 *
 * 返回的函数：`(relPath, isDir) => boolean`，`true` 表示**应当忽略（可剪枝）**。
 * 规则按出现顺序累加，**最后一条命中者胜**（git 语义）。
 */
export function createIgnoreMatcher(lines: readonly string[]): (relPath: string, isDir: boolean) => boolean {
	const decide = createIgnoreDecider(lines);
	return (relPath: string, isDir: boolean): boolean => decide(relPath, isDir) === true;
}

/**
 * 三态版本：`true` = 忽略，`false` = **被否定规则明确保留**，`undefined` = 本组规则没有意见。
 *
 * 为什么要三态：走查档需要把多个目录层的 `.gitignore` 叠起来判。合成一个布尔时，
 * "本层没命中" 与 "本层命中且是否定" 都表现为 `false`，于是调用方只能二选一 ——
 * 要么早早在否定处停下（漏掉更深的忽略规则），要么继续问父级（父级的 `*.log` 会把子级
 * `!keep.log` 又剪掉）。git 的语义是后者要保留，所以否定必须能"定案"。
 */
/** 三态判定器：`true` = 忽略，`false` = 明确保留，`undefined` = 这组规则没有意见。 */
export type IgnoreDecider = (relPath: string, isDir: boolean) => boolean | undefined;

export function createIgnoreDecider(lines: readonly string[]): IgnoreDecider {
	const rules: IgnoreRule[] = [];
	for (const line of lines) {
		const rule = compileRule(line);
		if (rule) rules.push(rule);
	}

	return (relPath: string, isDir: boolean): boolean | undefined => {
		const candidate = relPath.replace(/^\.\/+/, "").replace(/\/+$/, "");
		if (candidate === "") return undefined;
		// 本组规则内部仍然是"后出现者胜"，但只有真的命中过才有意见。
		let decision: boolean | undefined;
		for (const rule of rules) {
			if (rule.dirOnly && !isDir) continue;
			if (matchesPattern(candidate, rule.pattern)) decision = !rule.negate;
		}
		return decision;
	};
}