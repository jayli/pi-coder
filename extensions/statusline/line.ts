/**
 * line.ts — statusline 主行 / 状态行的纯格式化
 *
 * 这个模块**不 import pi / pi-tui**（只用结构化最小接口描述需要的字段），所以
 * `node --test` 能直接拿假对象跑满每个分支；pi 的真实 `Theme` / `ExtensionContext` /
 * `ReadonlyFooterDataProvider` 结构兼容，index.ts 里原样传进来即可。
 */

// 跨目录相对 import：后台任务 dock 的保留 status key 住在 background-tasks 那边。
// 与 line.test.ts 里 plan-mode 的 `STATUS_KEY` 同一套取舍：两份字面量一旦漂移，
// dock 行会静默退回拼接的第二行，没有任何报错 —— import 常量就永不发生。
import { STATUS_KEY as BACKGROUND_DOCK_STATUS_KEY } from "../background-tasks/status.ts";
// 口播流程的保留 status key 住在 voice 那边：主行末段的 `reporting`（用户 2026-10-04 加）
// 由 voice 发布、这里渲染；同一个键也要从第二行的扩展 status 列表里跳过。
import { REPORTING_LABEL, REPORTING_STATUS_KEY } from "../voice/status.ts";

/** pi 的 Theme.fg 子集（方法声明双变，真实 Theme 可直接赋值）。 */
export interface StatuslineTheme {
	fg(color: string, text: string): string;
}

/** ctx 里渲染主行需要的部分（`thinkingLevel` 在 pi 的 ctx 上是 live getter，可选且可能抛）。 */
export interface StatuslineSource {
	model: { id?: string } | undefined;
	thinkingLevel?: string;
	getContextUsage(): { percent: number | null | undefined } | undefined;
}

/** footerData 里需要的部分。 */
export interface StatuslineGitSource {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
}

export interface DiffStat {
	added: number;
	deleted: number;
}

export interface StatuslineState {
	streaming: boolean;
	/** 渲染路径只读，只有 index.ts 的事件回调会改。 */
	activeTools: Map<string, number>;
	/** undefined = 还没读到 / 不在 git 仓库。 */
	diffStat: DiffStat | undefined;
}

export const SEPARATOR = " | ";
export const ELLIPSIS = "…";
/**
 * 模型段前缀图标（取代早期的 `Model:` 文字标签，省 4 列；再早一版是 `⚡️`）。
 * `🅼` = U+1F17C NEGATIVE SQUARED LATIN CAPITAL LETTER M。源码里写转义、测试按码位钉死，
 * 防止以后被换成近形字符（`Ⓜ`(U+24C2) / `🅜`(U+1F15C) 长得几乎一样）。
 *
 * 与 `⚡️` 的两点差别，都是量出来的：
 * - **宽度 1 列，不是 2**：它不是 RGI emoji（`/^\p{RGI_Emoji}$/v` 不匹配，带不带 VS16 都一样），
 *   pi-tui `graphemeWidth` 于是走 `eastAsianWidth` → Ambiguous → 1；Ghostty 默认的
 *   `grapheme-width-method = unicode` 也按 1 列摆字，两边口径一致，`truncateToWidth` 的截断
 *   数学不受影响（整行比 `⚡️` 时代少 1 列）。也因此**不需要 VS16**：Apple Color Emoji 里
 *   查无 U+1F17C，加不加都是文本呈现，加了只会白占一个不可见码位。
 * **上色**：走 `dim`，与 `SEPARATOR`（` | `）同一个色槽 —— 图标是结构装饰，不该和模型 id
 * （`accent`）抢视觉重量。这一点与 `⚡️` 时代相反：那时包 `theme.fg` 只多出一对没有视觉效果的
 * ANSI 码（emoji 自带颜色，字形不吃前景色），所以刻意不包；U+1F17C 没有彩色字形（Apple Color
 * Emoji 里查无此码位），终端按普通文本渲染，`theme.fg` 对它**是**生效的。`BRANCH_ICON` 同此处理。
 *
 * 字形可得性（2026-09-28 用 fontTools 扫过 166 个 JetBrains / Maple 字体文件）：U+1F17C 在
 * Ghostty 字体栈的两个字体里**都没有**（`JetBrainsMonoNL Nerd Font Mono` / `Maple Mono SC NF`），
 * 靠系统回退渲染 —— macOS 侧有 `Lyth Mono Term`（advance = 0.604em，与 `M` 同宽，等宽对齐）、
 * `LXGW WenKai`、`YuGothic` 覆盖它，所以不会掉成缺字方块。与 `BRANCH_ICON` 同一套取舍。
 */
export const MODEL_ICON = "\u{1f17c}";
/**
 * 分支段前缀图标：`ᗌ`（U+15CC，CANADIAN SYLLABICS CARRIER RE —— 字形恰好是一个分叉的样子）。
 * 它取代了私有区的 Powerline / Nerd Font 字形 U+E0A0 —— 那个码位在字体缺字形时只是一个看不见的
 * 方块（更早还依次用过 `⎇`(U+2387) 与 `⑂`(U+2442, OCR FORK)）。源码里仍写转义、测试仍按码位
 * 钉死，防止以后被换成近形字符（同区块的 `ᗋ`(U+15CB) / `ᗍ`(U+15CD) / `ᗎ`(U+15CE) 长得几乎一样）。
 * 宽度按 pi-tui `visibleWidth` 是 1 列、East Asian Width = Neutral（不是 Ambiguous），
 * 所以 `truncateToWidth` 的截断预算不用动，也不存在 CJK 宽度下按 2 列渲染的错位。
 * 字形可得性（2026-09-20 用 fontTools 扫过本机全部字体）：U+15CC 在 Ghostty 字体栈的三个字体里
 * **都没有**（`Lyth Mono Term` / `JetBrainsMonoNL Nerd Font Mono` / `Maple Mono SC NF`），靠系统
 * 回退渲染 —— macOS 侧有 `Euphemia UCAS`（advance ≈ 0.98 格）与 `Noto Sans CanAborig` 覆盖它，
 * 所以不会掉成缺字方块；终端按固定格宽摆字，0.98 的字面宽度不影响对齐。哪天在没有这类回退字体的
 * 环境里显示成方块，回到 U+2442（Lyth Mono Term 有）或 U+E0A0（Nerd Font 有）。
 */
export const BRANCH_ICON = "\u15cc";
/** 行首缩进：整行不顶格。 */
export const LEADING_INDENT = " ";
/** 本扩展自己的 setStatus key（清残留用，渲染时也跳过）。 */
export const STATUSLINE_KEY = "statusline";
/**
 * 强制排在最前面的 status key，按这个数组的顺序排；不在表里的按注册顺序跟在后面。
 *
 * 为什么不是纯注册顺序：**模式指示必须在行首**。它跟着路径、checkpoint 计数这些
 * 会变长的段，而第二行是「超长只截断、不折行」—— 放尾部时一条长路径就能把它挤到看不见。
 * 注册顺序取决于 pi 加载扩展的顺序（目录字母序），写在那里的话改个文件名就会变，太脆。
 */
export const STATUS_PRIORITY = ["plan-mode"] as const;
const MAX_STATUS_ITEMS = 5;

/** 主行：`🅼 x/xhigh | Ctx 0.0% | \u15cc branch | (+a,-b)[ | 状态]`，各段已着色。 */
export function formatMainLine(
	theme: StatuslineTheme,
	source: StatuslineSource,
	git: StatuslineGitSource,
	state: StatuslineState,
): string {
	const branch = git.getGitBranch();
	const segments = [
		formatModelSegment(theme, source),
		formatContextSegment(theme, source),
		formatBranchSegment(theme, branch),
		formatDiffSegment(theme, branch, state.diffStat),
		formatStateSegment(theme, git, state),
	].filter((segment): segment is string => Boolean(segment));
	return segments.join(dim(theme, SEPARATOR));
}

/**
 * footer 的完整输出：一个主行（+ 可选状态行 + 可选后台任务 dock 行），行首恒缩进一格，
 * 超长只截断省略、绝不折行。`truncate` 由 index.ts 注入 pi-tui 的 `truncateToWidth`
 * （ANSI / 宽字符安全），这样这条关键约定也能在单测里直接断言。
 *
 * dock 行（background-tasks 的保留键）从拼接的第二行里**抽出来**单独渲染成最后一行：
 * 它既不占 5 条 status 的预算，也不会与长 cwd 同行被截断 —— 用户要的就是「最底部
 * 永远看得见的后台任务状态」。
 */
export function composeFooterLines(
	theme: StatuslineTheme,
	source: StatuslineSource,
	git: StatuslineGitSource,
	state: StatuslineState,
	width: number,
	truncate: (text: string, width: number, ellipsis: string) => string,
): string[] {
	if (width <= 0) return [];
	const lines = [`${LEADING_INDENT}${formatMainLine(theme, source, git, state)}`];
	const dock = git.getExtensionStatuses().get(BACKGROUND_DOCK_STATUS_KEY);
	const statuses = formatExtensionStatuses(theme, git);
	if (statuses) lines.push(`${LEADING_INDENT}${statuses}`);
	// dock 文案由 background-tasks 侧逐段着过色（恒带 ANSI），原样渲染；
	// 终端宽度收口在下面的 truncate，所以 id / 状态 / 时长永不被截，只截行尾的命令。
	// 值可能含**一个换行**（结轮提示的第二行，见 background-tasks/status.ts 文件头）：
	// 按行拆成多个 footer 行，每行照样缩进一格、照样各自参与截断。
	// 不做 `trim()`：第二行的缩进（`└` 悬在任务 id 下方）就靠前导空格表达，
	// trim 会把它吃掉，而行内缩进是发布侧的事。只跳过纯空行。
	// 发布侧从不给自己加前导空格，所以缩进仍恒为 `LEADING_INDENT` 那一格。
	if (dock && dock.trim().length > 0) {
		for (const row of dock.split(/\r?\n/)) {
			if (row.trim().length > 0) lines.push(`${LEADING_INDENT}${row}`);
		}
	}
	return lines.map((line) => truncate(line, width, ELLIPSIS));
}

/**
 * 第二行：其它扩展 `ctx.ui.setStatus()` 的文本（模式指示 / cwd / rewind checkpoint …）。
 * 自带 ANSI 的原样渲染（那些扩展已经自己配过色），没色的统一给 muted。
 *
 * 顺序：先按 `STATUS_PRIORITY`（模式指示排行首），其余按注册顺序。
 *
 * 两个保留键在这里被**跳过**：后台任务 dock 由 `composeFooterLines` 单独渲染成最后一行
 * （所以既不占下面的 5 条预算，也不与长 cwd 同行被截断），口播的 `reporting` 则由主行
 * 末段渲染（`formatStateSegment`）—— 不跳过它们就会同一件事显示两遍。
 */
export function formatExtensionStatuses(theme: StatuslineTheme, git: StatuslineGitSource): string {
	const entries = [...git.getExtensionStatuses().entries()].filter(
		([key, value]) =>
			key !== STATUSLINE_KEY &&
			key !== BACKGROUND_DOCK_STATUS_KEY &&
			key !== REPORTING_STATUS_KEY &&
			value.trim().length > 0,
	);

	const rank = (key: string): number => {
		const index = (STATUS_PRIORITY as readonly string[]).indexOf(key);
		return index === -1 ? STATUS_PRIORITY.length : index;
	};
	// 稳定排序：同 rank 的保持 Map 的插入序（`Array.prototype.sort` 在现代 V8 上稳定）
	const ordered = entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.index - b.index)
		.map((wrapped) => wrapped.entry);

	const visible = ordered
		.slice(0, MAX_STATUS_ITEMS)
		.map(([, value]) => (hasAnsi(value) ? value : theme.fg("muted", value.trim())));
	return visible.join(dim(theme, SEPARATOR));
}

/** 模型图标 + id + 推理强度：`🅼 qwen3.8-flash/xhigh`（图标 dim，id 用 accent，斜杠 dim，level 用 syntaxFunction）；level 读不到（stale ctx）时只报 id。 */
function formatModelSegment(theme: StatuslineTheme, source: StatuslineSource): string {
	const id = readModel(source)?.id ?? "no-model";
	const level = readThinkingLevel(source);
	const suffix = level ? `${dim(theme, "/")}${theme.fg("syntaxFunction", level)}` : "";
	return `${dim(theme, MODEL_ICON)} ${theme.fg("accent", id)}${suffix}`;
}

function formatContextSegment(theme: StatuslineTheme, source: StatuslineSource): string {
	const percent = readContextUsage(source)?.percent ?? null;
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	return `${dim(theme, "Ctx")} ${theme.fg(contextColor(percent), percentText)}`;
}

function formatBranchSegment(theme: StatuslineTheme, branch: string | null): string {
	if (!branch) return dim(theme, `${BRANCH_ICON} no git`);
	return `${dim(theme, BRANCH_ICON)} ${theme.fg("accent", branch)}`;
}

function formatDiffSegment(
	theme: StatuslineTheme,
	branch: string | null,
	diffStat: DiffStat | undefined,
): string {
	if (!branch) return dim(theme, "(no git)");
	return `${dim(theme, "(")}${theme.fg("success", `+${diffStat?.added ?? 0}`)}${dim(theme, ",")}${theme.fg("error", `-${diffStat?.deleted ?? 0}`)}${dim(theme, ")")}`;
}

/**
 * 末段状态（主行最后一段）：下面四档按优先级从高到低，只显示第一个命中的。
 *
 *   1. **口播流程中 → `reporting`**（voice 扩展发的保留 status）—— 用户 2026-10-04 要求
 *      显示在「thinking 和 bash 等字样显示的位置」。它**排在最前**：摘要阶段 `streaming`
 *      仍为真（回合还没 settle），排后面就会被 `thinking` 盖掉，而那正是最需要解释的
 *      「沉默几秒」窗口。
 *   2. 有工具在跑 → 工具名（并发带计数）
 *   3. 流式中 → `thinking`
 *   4. 空闲 → 整段不出现
 *
 * 四种文案都是小写状态词，同一档视觉重量，用同一个色槽（warning）。
 */
function formatStateSegment(
	theme: StatuslineTheme,
	git: StatuslineGitSource,
	state: StatuslineState,
): string | undefined {
	// 空串也当「没发布」：`formatExtensionStatuses` 对空值的判定是同一个口径。
	const reporting = git.getExtensionStatuses().get(REPORTING_STATUS_KEY);
	if (reporting && reporting.trim().length > 0) return theme.fg("warning", REPORTING_LABEL);
	const active = [...state.activeTools.entries()];
	if (active.length > 0) {
		const [name, count] = active[0] ?? ["tool", 1];
		const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
		return theme.fg("warning", `${name}${suffix}`);
	}
	return state.streaming ? theme.fg("warning", "thinking") : undefined;
}

function contextColor(percent: number | null): string {
	if (percent === null) return "dim";
	if (percent >= 90) return "error";
	if (percent >= 70) return "warning";
	return "success";
}

/** ctx 的 getter 在会话被换掉后可能抛（stale ctx），状态栏不值得为此挂掉渲染。 */
function readContextUsage(
	source: StatuslineSource,
): { percent: number | null | undefined } | undefined {
	try {
		return source.getContextUsage();
	} catch {
		return undefined;
	}
}

/** thinkingLevel 在 stale ctx 上同样可能抛，一律兜底成「无 level」。 */
function readThinkingLevel(source: StatuslineSource): string | undefined {
	try {
		const level = source.thinkingLevel;
		return typeof level === "string" && level.length > 0 ? level : undefined;
	} catch {
		return undefined;
	}
}

/** ctx.model 在 stale ctx 上也可能抛，一律走这里取。 */
function readModel(
	source: StatuslineSource,
): { id?: string; contextWindow?: number } | undefined {
	try {
		return source.model;
	} catch {
		return undefined;
	}
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

function hasAnsi(value: string): boolean {
	return ANSI_PATTERN.test(value);
}

function dim(theme: StatuslineTheme, text: string): string {
	return theme.fg("dim", text);
}
