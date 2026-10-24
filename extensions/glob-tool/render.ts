/**
 * glob-tool / render —— 标题与结果正文的纯格式化。见 `render.test.ts` 与文件头的说明。
 *
 * **本文件不 import pi。** 着色、组件、宽度都在 `index.ts` 里做；这里只回答"哪一段是什么"。
 */

import { DEFAULT_MAX_BYTES, formatBytes } from "./match.ts";

/** 结果正文折叠时最多显示的行数（与内置 `find` / `grep` 的 20 行一致）。 */
export const BODY_PREVIEW_LINES = 20;

export interface GlobTitleArgs {
	pattern?: string;
	path?: string;
}

export interface GlobTitleParts {
	/** 模式串；`null` 表示参数还没到齐（渲染层据此决定不画或画占位）。 */
	pattern: string | null;
	/** 搜索根；`null` 表示没给（语义上等于 cwd）。 */
	where: string | null;
}

/**
 * 拆出标题行要着色的两段。`shortenPath` 由调用方注入（它需要 pi 的 cwd 语义），
 * 本函数只做取值与空串兜底 —— 免得"空 pattern 该不该显示成 `Glob  in .`"这种判断散在渲染层。
 */
export function formatGlobTitle(
	args: GlobTitleArgs,
	shortenPath: (value: string | undefined) => string | null,
): GlobTitleParts {
	const rawPattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
	const pattern = rawPattern === "" ? null : rawPattern;
	const where = rawPattern === "" ? null : shortenPath(args.path);
	return { pattern, where };
}

export interface GlobBodyOptions {
	/** ctrl+o 展开态：不折叠。 */
	expanded: boolean;
	/** 展开键的文本（从 keybindings 读，读不到是 `ctrl+o`）。 */
	expandKey: string;
	/** 命中结果数上限时是那个上限值。 */
	limit?: number;
	/** 字节上限是否命中（命中时用 `maxBytes` 生成措辞）。 */
	truncated?: boolean;
	/** 字节上限的实际值；缺省是 pi 的 50KB。 */
	maxBytes?: number;
}

export interface GlobBodyParts {
	lines: string[];
	moreLines: number;
	/** `... (N more lines, ctrl+o to expand)`；不折叠时为 `null`。 */
	expandHint: string | null;
	/** `[Truncated: …]`；没截断时为 `null`。 */
	warning: string | null;
}

/**
 * 把结果正文切成"要显示的行 + 折叠提示 + 截断警告"。
 *
 * 尾随空行（`formatOutput` 在 notices 之前那一行是正文的最后一行，不含尾随换行）在此统一
 * 丢掉：正文以 `\n` 结尾时 `split` 会多出一个空串，留在 `lines` 里会画出一条空行。
 */
export function formatGlobBody(text: string, options: GlobBodyOptions): GlobBodyParts {
	const all = text === "" ? [] : text.split("\n");
	// 尾部空串（正文以换行结尾时产生）不算一行。
	while (all.length > 0 && all[all.length - 1] === "") all.pop();

	const maxLines = options.expanded ? all.length : BODY_PREVIEW_LINES;
	const lines = all.slice(0, maxLines);
	const moreLines = Math.max(0, all.length - lines.length);
	const expandHint = moreLines > 0 ? `... (${moreLines} more lines, ${options.expandKey} to expand)` : null;

	const warnings: string[] = [];
	if (options.limit !== undefined) warnings.push(`${options.limit} results limit`);
	if (options.truncated === true) warnings.push(`${formatBytes(options.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	const warning = warnings.length > 0 ? `[Truncated: ${warnings.join(", ")}]` : null;

	return { lines, moreLines, expandHint, warning };
}
