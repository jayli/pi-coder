/**
 * title-row.ts — `Edit` / `Write` 标题行（`• Edit <path> (+3 -5)`）的纯排版逻辑。
 * 工具名由调用方传入（`titleRow(theme, "Edit", …)`），本模块不认工具、只看宽度。
 *
 * 从 `tool-diff.ts` 抽出来的理由有两个：
 *
 *   1. **可单测**。这段是纯字符串排版（预算分配 + 按宽度截断），却埋在 1300 多行、到处
 *      import pi 的 `tool-diff.ts` 里，`node --test` 根本 import 不进来。抽出后本模块
 *      **不 import pi / pi-tui**：宽度函数 `widthOf`、截断函数 `truncateToWidth`、home
 *      目录、缩进、状态圆点全部从外部注入（与 `working-summary.ts` 同一套做法），测试里
 *      喂一个 ASCII=1 / CJK=2 的假量宽函数就能跑满每个分支。
 *   2. **「尾部标记变化把路径挤得左右挪」的现场就在这里**。路径预算按「可用宽度 − 行首 −
 *      工具名 − 尾部」算；行首（状态圆点 + 缩进）与尾部（`+N -M` / 闪烁 `●`）任何一处宽度
 *      变化都会让截断窗口平移。所以行首按**实际字符串**量宽、尾部为 0 时整个省略；而闪灭
 *      两态必须等宽（`loadingSuffix` 灭态是 1 格空格而不是空串），否则路径每 500ms 左右挪一次。
 *
 * 模块放在 `extensions/tool-diff/` 这个**同名目录**下（`tool-diff.ts` 与 `tool-diff/` 可以
 * 并存）：目录里没有 `index.ts`，而 pi 的加载器只认 `extensions/<name>.ts` 与
 * `extensions/<name>/index.ts`（loader.js 的 `discoverExtensionsInDir` → `resolveExtensionEntries`
 * 找不到入口就整目录跳过），所以它不会被当成扩展加载。
 */

/** 从头部截断时用的省略号。1 列宽。 */
export const ELLIPSIS = "…";
/** 标题行行首的状态圆点。1 列宽（`visibleWidth("•") === 1`，已核对）。 */
export const DOT_MARKER = "•";
/** 载入中的闪烁标记。1 列宽（`visibleWidth("●") === 1`，已核对，与 working-indicator 同源）。 */
export const BLINK_MARKER = "●";
/**
 * 路径还没到时的占位符（用户 2026-10-28 定）：`• Write files ●`。
 * 用 `text` 那个前景槽（与真路径同一槽），所以读起来就是「文件名位置」本身，不是灰掉的附注。
 */
export const PLACEHOLDER_PATH = "files";

/** 路径为空就换成占位符 —— 唯一一处判定，两个工具共用。 */
export function pathPlaceholder(path: string): string {
	return path === "" ? PLACEHOLDER_PATH : path;
}

/**
 * 载入中的闪烁标记（亮 / 灭两态，**恒 1 列**）。
 *
 * 灭态返回的是 1 格空格而不是空串：标题行的路径预算 = 可用宽度 − 行首 − 工具名 − 尾部，
 * 尾部宽度只要每 500ms 抖一下，超长路径的截断窗口就会跟着左右挪，看上去是「标记在闪、
 * 文件名也在闪」。色槽用 `dim`（与 working-indicator 的 bash `●` 同一个槽）。
 */
export function loadingSuffix(theme: TitleTheme, on: boolean): string {
	return theme.fg("dim", on ? BLINK_MARKER : " ");
}

/** 渲染需要的主题子集（`Theme.fg` 的方法声明是**双变**的，真实 `Theme` 可直接赋值）。 */
export interface TitleTheme {
	fg(color: string, text: string): string;
}

/** 标题行尾部 `(+N -M)` 的行数统计。 */
export interface TitleStats {
	added: number;
	removed: number;
}

/**
 * 排版依赖（全部注入，本模块因此不 import pi / pi-tui）。
 *
 * `widthOf` / `truncateToWidth` 运行时传 pi-tui 的 `visibleWidth` / `truncateToWidth`
 * （与渲染器同一套实现，量出来的宽度与 pi 实际折行严格一致）；`home` 传 `os.homedir()`；
 * `indent` 传调用方的标题缩进。
 */
export interface TitleRowDeps {
	/** 可见宽度（忽略 ANSI 转义、CJK 记 2 列） */
	widthOf(text: string): number;
	/** 按可见宽度从**尾部**截断（ANSI 安全），超出部分换成一个省略号 */
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	/** home 目录（`""` = 不做 `~` 缩写） */
	home?: string;
	/** 标题缩进，默认 1 个空格 */
	indent?: string;
}

/**
 * 工具块的结局灯三态（用户 2026-10-28 定）：
 *
 *   pending —— 结果还没到（参数还在流、工具在执行、历史里没有结果的行）→ `dim` 灰
 *   success —— 结果到了且不是错误 → `toolDiffAdded` 绿
 *   error   —— 结果到了且 `isError` → `toolDiffRemoved` 红
 *
 * 槽位刻意不用 `success` / `error` 那两个语义槽，而是 diff 的绿 / 红：bash / read / glob /
 * mcp / Explored 那几块的 `stateBarAnsi` 用的是同一组色，整条工具家族的圆点才同色
 * （`success` 槽在本仓皮肤里偏青，摆在同一列里会像另一种灯）。
 */
export type ToolDotState = "pending" | "success" | "error";

const DOT_SLOTS: Record<ToolDotState, string> = {
	pending: "dim",
	success: "toolDiffAdded",
	error: "toolDiffRemoved",
};

/**
 * 已着色的状态圆点（不带尾随空格 —— 圆点与工具名之间那一格由 `TitleRow` 统一补，
 * 这样预算只算一处）。空串表示这一行不画点，工具名顶到行首。
 */
export function statusDot(theme: TitleTheme, state: ToolDotState): string {
	return theme.fg(DOT_SLOTS[state], DOT_MARKER);
}

/**
 * 行数的显示形态：万位以上缩略成 `k`（`10043` → `10k`、`11133` → `11.1k`）。
 *
 * 尾部 `(+N -M)` 是这一行里**不能被截掉**的部分，但两个五位数并排能吃掉 13 列以上，
 * 窄终端里那几列本该留给路径。缩到 `k` 之后最多 5-6 列，路径的可用宽度也稳定了
 * （写入量越大越极端，这里只影响显示，不影响任何统计口径）。
 * 万位以下原样显示 —— `+1043` 比 `+1.0k` 精确，也不长。
 */
export function formatCount(count: number): string {
	if (!Number.isFinite(count) || count < 10_000) return String(count);
	const thousands = count / 1000;
	if (thousands < 100) {
		const rounded = Math.round(thousands * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
	}
	return `${Math.round(thousands)}k`;
}

/**
 * 标题行尾部的 `(+3 -5)`：新增绿、删除红（沿用 diff 的 `toolDiffAdded` / `toolDiffRemoved`，
 * 跟卡片里的 +/- 行同色），括号保持 dim。为 0 的一侧省略，两侧都为 0（无改动 / 算不出来）
 * 返回空串 —— 空括号比没有括号更难看。
 */
export function statsSuffix(theme: TitleTheme, stats: TitleStats | undefined): string {
	if (stats === undefined) return "";
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("toolDiffAdded", `+${formatCount(stats.added)}`));
	if (stats.removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${formatCount(stats.removed)}`));
	if (parts.length === 0) return "";
	return `${theme.fg("dim", "(")}${parts.join(" ")}${theme.fg("dim", ")")}`;
}

/** 把 home 目录前缀缩写成 `~`，跟内置工具标题的惯例一致 */
export function shortenPath(path: string, home: string): string {
	if (home === "" || !path.startsWith(home)) return path;
	const rest = path.slice(home.length);
	// 只在边界处缩写：`~` 本身或 `~/...`，避免把 `/Users/bachir/...` 误缩成 `~r/...`
	if (rest === "" || rest.startsWith("/")) return `~${rest}`;
	return path;
}

/**
 * 从**头部**截断到指定列宽：保留尾部，前面用一个 `…` 顶替被丢掉的字符。
 * 按**码点**走（不是 UTF-16 单元），所以代理对不会被切成半个；宽度用 `widthOf`
 * 逐字符量，CJK / emoji 占 2 列也算得对。
 */
export function truncateStartToWidth(
	text: string,
	maxWidth: number,
	widthOf: (text: string) => number,
	ellipsis = ELLIPSIS,
): string {
	if (maxWidth <= 0) return "";
	if (widthOf(text) <= maxWidth) return text;
	const budget = maxWidth - widthOf(ellipsis);
	if (budget <= 0) return ellipsis;
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		const charWidth = widthOf(chars[i] ?? "");
		if (used + charWidth > budget) break;
		used += charWidth;
		start = i;
	}
	return ellipsis + chars.slice(start).join("");
}

/**
 * 标题行组件。用 `Text` 的话长路径会被折成两三行（工具名 / 路径 / 计数各一行），
 * 所以自己按宽度排版成**恒一行**。
 *
 * 排版：`<缩进><圆点> <工具名> <路径><尾部>`。优先级是工具名和尾部（`(+N -M)`）
 * **永远完整**，路径吃剩下的宽度、超宽时从头部截断。尾部是这一行的信息量所在，被截掉
 * 就失去意义了；只有窄到连一个字符的路径都放不下时，才退回整行尾部截断（至少保住工具名）。
 */
export class TitleRow {
	// 字段显式声明 + 构造里赋值，**不用参数属性**（`constructor(private readonly x)`）：
	// Node 的类型剥离不支持它（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`），而本模块要能被
	// `node --test` 直接 import。
	private readonly deps: TitleRowDeps;
	private readonly theme: TitleTheme;
	/** 已着色的状态圆点（空串 = 不画点，工具名顶到行首） */
	private readonly dot: string;
	/** 已着色的工具名 */
	private readonly tool: string;
	/** 纯文本路径（未着色）—— 先按宽度截断再上色，否则 ANSI 串会被截断逻辑当成可见字符 */
	private readonly path: string;
	/** 已着色的尾部 */
	private readonly suffix: string;

	constructor(
		deps: TitleRowDeps,
		theme: TitleTheme,
		dot: string,
		tool: string,
		path: string,
		suffix: string,
	) {
		this.deps = deps;
		this.theme = theme;
		this.dot = dot;
		this.tool = tool;
		this.path = path;
		this.suffix = suffix;
	}

	render(width: number): string[] {
		const { widthOf } = this.deps;
		const indent = this.deps.indent ?? " ";
		// 行首 = 缩进 [+ 圆点 + 一格间隔]。圆点不是装饰而是这一行的状态灯，宽度按真实字符串量，
		// 可用宽度相应扣掉，否则整行会超宽（pi 的主屏渲染器遇到超宽行直接抛错）。
		const lead = this.dot === "" ? indent : `${indent}${this.dot} `;
		const available = Math.max(1, width - widthOf(lead));
		const path = this.path === "" ? "" : shortenPath(this.path, this.deps.home ?? "");
		const toolWidth = widthOf(this.tool);
		// 尾部与路径各占一个分隔空格
		const suffixWidth = this.suffix === "" ? 0 : 1 + widthOf(this.suffix);
		const pathBudget = available - toolWidth - suffixWidth - (path === "" ? 0 : 1);

		if (path === "" || pathBudget < 1) {
			const fallback = [this.tool, path === "" ? "" : this.theme.fg("text", path), this.suffix]
				.filter((part) => part !== "")
				.join(" ");
			return [lead + this.deps.truncateToWidth(fallback, available, ELLIPSIS)];
		}

		const shown = this.theme.fg("text", truncateStartToWidth(path, pathBudget, widthOf));
		const tail = this.suffix === "" ? "" : ` ${this.suffix}`;
		return [lead + `${this.tool} ${shown}${tail}`];
	}

	invalidate(): void {}
}
