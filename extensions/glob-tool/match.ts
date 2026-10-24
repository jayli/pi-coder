/**
 * glob-tool / match —— 模式归一、隐藏段脱敏与匹配。**纯函数，零 pi 依赖。**
 *
 * ## 为什么匹配不用 `minimatch` / `picomatch`
 *
 * 它们虽然是 pi 的传递依赖（`@earendil-works/pi-coding-agent` 的 `package.json` 里有
 * `minimatch`），但直接在扩展里 `import` 会拿到**另一个模块实例** —— pi 运行时用的是它
 * bundle 里的那份。语义上无差别，代价是多一次模块求值；而 Node 26 的内置
 * `path.matchesGlob` 已经支持 `**` / `{a,b}` / `[a-c]` / `[!a]` / `?`（逐条实测过，见
 * spec §2），够用。少一个依赖，也少一处版本漂移。
 *
 * ## 为什么要 `unhide`（段首点脱敏）
 *
 * `path.matchesGlob` 与 shell glob 一样把「段首的 `.`」当特殊字符（`sep` 用 `/`，下同）：
 *
 *     matchesGlob(".github/workflows/ci.yml", "**" + "/" + "*.yml")  // false
 *     matchesGlob("src/.hid.ts",                "**" + "/" + "*.ts")  // false
 *
 * 对**文件系统走查**这是对的（`ls *` 不列隐藏文件）。但对**仓库清单**是错的：git 认为
 * `.github/workflows/ci.yml` 是项目的一部分，模型问 `**` + "/" + `*.yml` 却看不到 CI 配置 —— 那是
 * 精度坍塌。`path.matchesGlob` 没有关闭这条规则的选项，所以匹配前把两侧的段首都替换成
 * `\x01`：它既不是 `.` 也不是 glob 元字符，于是「点」退化成普通字符。
 *
 * `\x01` 在路径里不可能出现（NUL 与 `/` 非法，`\x01` 虽合法但从不使用），不会碰撞。
 * 注意**只替换段首那一个字符**：`a.b.ts` 里的点不动（`.` 本来就不是元字符）。
 *
 * ## 归一化的三条规则
 *
 * | 输入 | 输出 | 理由 |
 * | --- | --- | --- |
 * | `*.ts` | `**` + `/` + `*.ts` | 用户的心里话是「任意深度的 ts 文件」；`matchesGlob` 的 `*.ts` 只匹配根层 |
 * | `./*.ts` | `*.ts` | 显式 `./` 表示「就要根层」，剥掉前缀后**不加** `**` + `/` |
 * | `src/` | `src/**` | 尾斜杠在 shell 里就是「底下的东西」 |
 *
 * `**` 必须特判：它不含 `/`，若走「不含斜杠就加前缀」会变成 `**` + `/` + `**`（语义等价，
 * 但测试钉逐字相等，而且日志里看着像 bug）。
 *
 * ⚠ 本文件的块注释里**不能出现连续的 `*` + `/`** —— 它会提前闭合注释，而 JS 解析器随后把
 * 注释正文当代码（报 `Expression expected`）。所以上面写 `**` + `/`，不写完整模式。
 */

import path from "node:path";

/** 显式「只搜根层」的前缀；剥掉后不加递归前缀。 */
const ROOT_ONLY_PREFIX = "./";
/** 段首点 → 这个字符（非 `.`、非 glob 元字符、路径里不可能出现）。 */
const DOT_PROXY = "\u0001";

/**
 * 模式归一：反斜杠 → `/`、`./` 前缀表示根层、尾斜杠补 `**`、不含斜杠的隐式递归。
 *
 * 幂等：`normalizePattern(normalizePattern(p)) === normalizePattern(p)`。
 */
export function normalizePattern(pattern: string): string {
	let normalized = pattern.trim().replaceAll("\\", "/");
	if (normalized === "") return normalized;

	// `./` 前缀 = 只搜根层；剥掉后**不加**递归前缀，所以下面的「不含斜杠」分支要跳过。
	const rootOnly = normalized.startsWith(ROOT_ONLY_PREFIX);
	if (rootOnly) normalized = normalized.slice(ROOT_ONLY_PREFIX.length);
	if (normalized.startsWith("./")) normalized = normalized.slice(2);

	if (normalized === "") return "*";

	// 尾斜杠 = 目录下的所有东西。
	if (normalized.endsWith("/")) normalized = `${normalized}**`;

	// `**` 本身已经表示任意深度，不能再加前缀（否则会重复一层）。
	if (normalized === "**") return normalized;

	// 不含 `/` 的模式隐式递归 —— 除非用户显式写了 `./`。
	if (!rootOnly && !normalized.includes("/")) return `**/${normalized}`;

	return normalized;
}

/** 把每个以 `.` 开头的路径段首字符替换成 {@link DOT_PROXY}。 */
export function unhide(value: string): string {
	return value
		.split("/")
		.map((segment) => (segment.startsWith(".") ? DOT_PROXY + segment.slice(1) : segment))
		.join("/");
}

/**
 * 模式里的点脱敏：段首的点、以及**大括号/字符类里可能成为段首的**点。
 *
 * 只代理段首字面 `.` 是不够的 —— `{.env,.env.*}` 的段首是 `{`，`[.]env` 的段首是 `[`，
 * 两个备选里的 `.` 都处在「段首位置」，而候选侧的 `.env` 被代理成了 `\x01env`，于是
 * `glob({pattern: "{.env,.env.*}"})` 在 `.env` 被 tracked 的仓库里报「No files found」。
 *
 * 代理的位置：
 *   - 段首（`^` 相对整个路径或 `/` 之后）；
 *   - `{` 或 `,` 之后（大括号备选的起点）；
 *   - `[` 之后（字符类的第一个字符）—— `[.]env` 与 `.env` 等价。
 *
 * **不**碰的：`*`、`?`、`]`、`}` 之后的点（`*.env`、`?env` 本来就能匹配点开头），
 * 以及段中任意位置的点（`a.b.ts` 里的 `.` 本来就不是元字符）。
 */
export function unhidePattern(pattern: string): string {
	let out = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index]!;
		const atSegmentStart = index === 0 || pattern[index - 1] === "/";
		const afterAlternativeBoundary = pattern[index - 1] === "{" || pattern[index - 1] === "," || pattern[index - 1] === "[";
		if (char === "." && (atSegmentStart || afterAlternativeBoundary)) {
			out += DOT_PROXY;
			continue;
		}
		out += char;
	}
	return out;
}

/**
 * 候选路径是否匹配模式。`normalizedPattern` 必须已经过 {@link normalizePattern}
 * （本函数不做归一，避免每条候选重复归一）。
 */
export function matchesPattern(candidate: string, normalizedPattern: string): boolean {
	if (normalizedPattern === "") return false;
	return path.matchesGlob(unhide(candidate), unhidePattern(normalizedPattern));
}

/** 默认结果数上限（与 pi 内置 `find` 的 `DEFAULT_LIMIT` 同值）。 */
export const DEFAULT_LIMIT = 1000;

/** 一个候选文件名里为什么会被跳过。 */
export interface SkipCounts {
	/** 含换行的路径数：它们会破坏"一行一路径"的契约。 */
	newlines: number;
}

/** `selectPaths` 的入参。`statMtime` / `skipMtime` 由调用方决定是否注入。 */
export interface SelectOptions {
	candidates: readonly string[];
	pattern: string;
	limit?: number;
	sortByMtime?: boolean;
	/**
	 * 取一个候选的 mtime。返回 `undefined` 表示**这个候选不该出现在结果里**（磁盘上没了、
	 * 是目录、或 stat 失败）—— 存在性过滤与 mtime 排序共用这一次 stat。
	 */
	statMtime?: (relativePath: string) => Promise<number | undefined>;
}

export interface SelectResult {
	paths: string[];
	/** 命中结果数上限时是那个上限值（用于生成提示）。 */
	limitReached?: number;
	skippedNewlines: number;
}

/**
 * 归一 `limit`：非有限数、非正整数一律回落 {@link DEFAULT_LIMIT}。
 *
 * 刻意不用 `parseInt` —— `parseInt(1.5)` 会静默变成 1，而 1.5 是"模型写错了"，
 * 不是"模型想要 1"。也不接受 0 与负数：返回空集比返回默认集更容易骗过模型。
 */
function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
	return limit;
}

/**
 * 从候选里挑出匹配模式的**文件**路径，排序后截断。
 *
 * 过滤顺序有意为之：先丢目录（尾斜杠）与含换行的路径，再匹配 —— 匹配是最贵的一步
 * （每条一次 `matchesGlob`），把它放最后能省掉无关候选的开销。
 */
export async function selectPaths(options: SelectOptions): Promise<SelectResult> {
	const limit = clampLimit(options.limit);
	const normalized = normalizePattern(options.pattern);
	const matched: string[] = [];
	let skippedNewlines = 0;
	for (const candidate of options.candidates) {
		// 目录条目（git 对"index 里没有子文件的目录"会返回 `nested/`）。
		if (candidate.endsWith("/")) continue;
		// 换行会破坏"一行一路径"的解析契约 —— 宁可少列一个也不能污染整份结果。
		if (candidate.includes("\n") || candidate.includes("\r")) {
			skippedNewlines++;
			continue;
		}
		if (matchesPattern(candidate, normalized)) matched.push(candidate);
	}

	let ordered: string[];
	if (options.sortByMtime) {
		// 对**切片前**的全量匹配结果取 mtime：先切片再取会让"最新的几个"取决于路径序。
		const statMtime = options.statMtime;
		const withTimes: Array<{ path: string; mtime: number }> = [];
		for (const path of matched) {
			const mtime = statMtime ? await statMtime(path) : undefined;
			if (mtime !== undefined) withTimes.push({ path, mtime });
		}
		withTimes.sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
		ordered = withTimes.map((entry) => entry.path);
	} else {
		// 码位序（不用 `localeCompare`）：同一份候选在任何 locale 下都得到同一份结果。
		ordered = matched.slice().sort();
	}

	// 存在性过滤**独立于排序**：`git ls-files --cached` 会把"已 rm 但没 git add"的文件
	// 照样列出来（实测），而路径序模式下不取 mtime —— 如果过滤只写在 mtime 分支里，
	// 那些文件名就会漏给模型，它去 `read` 一个不存在的文件。
	// 代价：路径序模式下也要为每条匹配取一次 stat（实测 3000 文件 13ms）。
	if (options.statMtime && !options.sortByMtime) {
		const statMtime = options.statMtime;
		const existing: string[] = [];
		for (const path of ordered) {
			if ((await statMtime(path)) !== undefined) existing.push(path);
		}
		ordered = existing;
	}

	const limitReached = ordered.length > limit ? limit : undefined;
	const paths = ordered.slice(0, limit);
	return {
		paths,
		skippedNewlines,
		...(limitReached === undefined ? {} : { limitReached }),
	};
}

/** 格式化时可注入的截断函数（由 `index.ts` 传 pi 的 `truncateHead`）。 */
export type TruncateFn = (text: string) => { content: string; truncated: boolean; maxBytes?: number };

export interface FormatNotices {
	limitReached?: number;
	skippedNewlines: number;
}

export interface FormatResult {
	text: string;
	details: { resultLimitReached?: number; truncated?: boolean };
}

/** pi 的 `DEFAULT_MAX_BYTES`（50KB）。`match.ts` 不 import pi，所以自带一份同值常量。 */
export const DEFAULT_MAX_BYTES = 50 * 1024;

/** 与 pi 内置 `find` 同款的字节数措辞（`formatSize` 的输出形状）。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 拼最终正文与 `details`。**不自己截断** —— 截断交给注入的 `truncate`，这样本模块不必
 * 知道 pi 的 `DEFAULT_MAX_BYTES`。
 *
 * 提示顺序固定：先结果数上限，后字节上限，最后跳过的换行路径 —— 与内置 `find` 的
 * `[Truncated: …]` 顺序一致，两个工具的输出不用模型换一套理解。
 */
export function formatOutput(paths: readonly string[], notices: FormatNotices, truncate?: TruncateFn): FormatResult {
	const joined = paths.join("\n");
	const truncatedResult = truncate ? truncate(joined) : undefined;
	const body = truncatedResult ? truncatedResult.content : joined;

	const details: FormatResult["details"] = {};
	const lines: string[] = [];
	if (notices.limitReached !== undefined) {
		details.resultLimitReached = notices.limitReached;
		lines.push(`[${notices.limitReached} results limit reached. Use limit=${notices.limitReached * 2} for more, or refine pattern]`);
	}
	if (truncatedResult?.truncated) {
		details.truncated = true;
		// `maxBytes` 由注入的 truncate 回传，本模块不硬编码 pi 的常量。
		const label = truncatedResult.maxBytes === undefined ? "byte" : formatBytes(truncatedResult.maxBytes);
		lines.push(label === "byte" ? "[byte limit reached]" : `[${label} limit reached]`);
	}
	if (notices.skippedNewlines > 0) {
		lines.push(`[skipped ${notices.skippedNewlines} paths containing newlines]`);
	}

	const text = lines.length === 0 ? body : `${body}\n\n${lines.join(". ")}`;
	return { text, details };
}
