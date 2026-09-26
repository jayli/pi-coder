/**
 * tool-diff — edit / write 工具的 Claude Code 风格 diff 渲染：
 * 整行底色（含行号槽，见 `layoutRows`）+ 行号槽 + 行内高亮 + 语法高亮。
 *
 * 为什么必须用扩展、主题方案做不到：
 *   pi 的 diff 配色只有三个**前景色** token（`toolDiffAdded` / `toolDiffRemoved` /
 *   `toolDiffContext`，见 theme.d.ts 的 ThemeColor），而 `Theme.bg()` 只认 7 个 ThemeBg
 *   （selectedBg / searchMatchBg / userMessageBg / customMessageBg / toolPendingBg /
 *   toolSuccessBg / toolErrorBg），**里面没有任何 diff 相关的底色**。所以主题最多只能把
 *   +/- 行染成不同前景色，做不出 CC 那种"整行绿底 / 整行红底 + 行内更亮底色"的效果。
 *   扩展自己拼 ANSI 才能逐行上底色。底色本身仍然**取自皮肤**：皮肤 `colors` 里的自定义
 *   key（`toolDiffAddedBg` / `toolDiffRemovedBg`）pi 照样解析进 Theme，扩展按 key 读出来
 *   再把前景色 SGR 换成底色 SGR —— 换皮肤时底色跟着换，见 `DIFF_ADDED_BG_TOKEN`。
 *
 * 为什么必须 `renderShell: "self"`：
 *   默认 shell 会把整个工具输出包进一个 Box 并**整块**染色 —— tool-execution.js 的
 *   `updateDisplay()` 里 bgFn 按状态选 `toolPendingBg` / `toolErrorBg` / `toolSuccessBg`。
 *   于是逐行的红底会落在一个绿盒子里面，观感错乱。设成 `"self"` 后走
 *   `selfRenderContainer`（tool-execution.js:180 分支），它是个纯 Container、
 *   `renderContainer instanceof Box` 为 false 所以 bgFn 不会被套用，框体完全自绘。
 *   self 模式下 renderCall 与 renderResult 两个组件都装进同一个 selfRenderContainer
 *   （updateDisplay() 里），所以标题行不会丢。
 *
 * 执行逻辑一律委托内置实现，只换渲染：
 *   `createEditToolDefinition(cwd)` / `createWriteToolDefinition(cwd)` 都是包根导出的。
 *   **必须用 `…Definition` 这一族，不能用 `createEditTool` / `createWriteTool`**：后者是
 *   `wrapToolDefinition(createXToolDefinition(…))`，而 `wrapToolDefinition` 只保留 8 个字段
 *   （name / label / description / parameters / constrainedSampling / prepareArguments /
 *   executionMode / execute），`promptSnippet` 与 `promptGuidelines` 被静默剥掉 —— 于是
 *   system prompt 的 `<tools>` 段里 edit / write 两行整体消失（`visibleTools` 按
 *   `!!toolSnippets[name]` 过滤），`<rules>` 段里那 5 条 guidance（edit 4 条 + write 1 条）
 *   也全部缺席。pi 官方示例 examples/extensions/built-in-tool-renderer.ts 用的正是
 *   `createEditTool()`，**它自己就带这个 bug**，别照着抄。渲染器继承是**按 slot**
 *   合并的（renderers/index.js `withBuiltInRenderers`：
 *   `renderCall: definition.renderCall ?? builtIn.renderCall`）。两个工具都**自己写
 *   renderCall**、只留一行标题：内置 edit 的 renderCall 会渲染一份基于 args 的 diff 预览
 *   （`getEditCallRenderComponent`），内置 write 的会把整个 `content` 带语法高亮地铺出来，
 *   执行完后 renderResult 又画一张卡片 —— 同一份改动会显示两遍。
 *   （早期版本刻意省略 edit 的 renderCall 以继承那份流式预览，正是因为重复才改掉的。）
 *   注册时用 `{ ...originalTool }` 展开而不是逐字段抄：定义体上除了 `execute` /
 *   `parameters` / `description` 还带着 `promptSnippet` / `promptGuidelines`（就是上面那段
 *   警告的主角）、`prepareArguments`（edit 有、write 没有）、`executionMode` /
 *   `constrainedSampling` 等字段 —— 手抄字段名最容易漏掉这些，`executionMode` 一旦丢掉
 *   就可能让 edit 并发执行、造成文件竞态，而提示词元数据丢掉是**静默**的（工具照样能调、
 *   不报任何错，只是模型看不到那几行）。展开还能顺带保住 pi 未来新增的字段。
 *   `renderShell: "self"` 与 `renderCall` / `renderResult` 写在展开**之后**，所以覆盖掉
 *   定义体自带的内置渲染器。
 *
 * 标题行的流式形态（与底部 spinner 分工）：
 *   流式中是 `Edit <path> ●` / `Write <path> ●` —— 闪烁的 `●` 表示「正在接收字节流」。
 *   工具名首字母大写（`Edit` / `Write`）而不是 pi 内置的小写 `edit` / `write`：本扩展仿的是
 *   Claude Code 的观感，那边的工具标题就是大写的；注册名不受影响，只是显示形态。
 *   token 数不在标题行滚动显示：底部 spinner 已经在数当前段的产出量
 *   （working-indicator/ 的 `↓ N tokens`），标题行再数一遍是重复信息。
 *   参数完成后 `●` 消失，恢复完整形态 `<path> (+N -M)`（新增绿 / 删除红，为 0 的一侧省略）。
 *   行数统计**只在标题行出现一次**：结果卡片里原本那行 `Added N lines, removed M lines`
 *   已经删掉，同一份改动不再报两遍。闪烁的驱动与三处停表见 `startBlink`。
 *   结果已到但 `argsComplete` 恒为 false 的行（中断的行、恢复历史会话渲染出来的行）
 *   靠 `isPartial` 识别，既不闪也不画标记 —— 否则整个历史区每行都会挂一个静态的 `●`；
 *   那种行照样算 `+N -M`（参数在会话日志里是完整的），否则历史区就彻底没有行数信息了。
 *
 * 标题行的路径**从头部**截断（`title-row.ts` 的 `truncateStartToWidth`）：
 *   超宽时保留路径尾部、把前面缩成一个 `…`（`Edit …ions/rewind/checkpoints.ts (+3 -5)`），
 *   而不是把行尾连同 `(+N -M)` 一起截掉 —— 文件名和改动量才是这一行要传达的信息，
 *   前面的目录基本是 cwd 的重复。尾部（`+N -M` / `●`）因此永远完整可见：可用宽度先扣掉
 *   工具名和尾部，剩下的才留给路径。
 *
 *   尾部宽度必须**每帧一样**，否则路径会跟着抖：闪烁标记灭态用等宽空格占位（不能返回空串，
 *   否则预算每 500ms 跳 2 列、超长路径的截断窗口跟着左右挪，看上去是「标记在闪、文件名
 *   也在闪」，实测过）；`+N -M` 里的五位数缩成 `k`（`(+10043 -11133)` → `(+10k -11.1k)`），
 *   免得两个大数把路径挤没。排版本身在 `tool-diff/title-row.ts`（纯逻辑、不 import pi，
 *   `node --test` 可直跑），本文件只负责把 pi-tui 的量度函数与主题接上去。
 *
 * `+N -M` 的来源（renderCall 阶段，工具还没执行，拿不到结果里的 patch）：
 *   edit 逐条 `edits` 算 `generateUnifiedPatch(oldText, newText)` 再求和 —— 各处改动互不重叠，
 *   求和就等于整文件 patch 的 +/- 行数；write 用执行前抓到的旧内容对新内容算同一套。
 *   结果缓存在行级 `state.stats`（`null` = 算过但算不出来），免得每次重绘都重跑一遍 diff。
 *   pi 另有 `computeEditsDiff(path, edits, cwd)` 能给权威数字，但它是 async 的，而 renderCall
 *   是同步渲染入口等不了 —— 所以走同步的逐条求和。
 *
 * 零新增 npm 依赖（与仓库里其它 pi 扩展一致，单文件手动 cp 安装）：
 *   - edit 的 diff 数据直接用 pi 给的 `EditToolDetails.patch`（标准 unified patch），
 *     不用 structuredPatch。
 *   - write 工具的 `TDetails` 是 `undefined`（`createWriteToolDefinition` 的签名），
 *     拿不到 diff。所以在 renderCall 阶段读旧内容（以 path 为键、逐帧重试，见 `WriteState`），
 *     再用包根导出的 `generateUnifiedPatch(path, old, new)` 算**真** diff ——
 *     覆盖已有文件时不会把整个文件都算成"新增"。
 *   - 语法高亮用 pi 自己的 `highlightCode` / `getLanguageFromPath`，不引 @shikijs/cli。
 *     实测 `highlightCode(code, lang)` 返回的行数与输入行数一致，且每行用 `\x1b[39m`
 *     收尾（不是 `\x1b[0m`），这对叠加底色很关键。
 *   - 行内 diff 自己实现 LCS，不引 diff 包。
 *
 * 两处容易踩的坑（都已在代码里处理）：
 *   1. **字符下标 ≠ 终端列宽**：行内高亮的 ranges 是 `computeWordRanges` 算出的 UTF-16 字符偏移，
 *      所以 `injectBg` 里推进的计数器必须按字符数走；而行宽 / 换行 / 补空格必须用
 *      `visibleWidth()` 按终端列宽算（CJK 占 2 列）。两个度量在不同地方用，混了就错位。
 *   2. **`\x1b[0m` 会连底色一起清掉**：语法高亮串里若出现全量重置，底色就断了。
 *      `injectBg` 在每次遇到 `\x1b[0m` 后重新注入当前底色。同理，前景色收尾一律用
 *      `\x1b[39m`（只重置前景）而不是 `\x1b[0m`，否则整行底色会被自己的槽位清掉。
 *
 * 已知取舍（刻意的，别"顺手优化"）：
 *   - 256color 模式下 `getBgAnsi` / `getFgAnsi` 返回 `48;5;N` / `38;5;N`，拿不到 RGB。
 *     第一版就此放弃了行内底色（"宁可少一层强调，也不猜错颜色"），但那个取舍的代价是：
 *     在非 truecolor 终端里整个特性静默消失，用户看不到任何提示。现在改走
 *     `deriveWordBg` 的 256 色分支 —— 按 xterm 调色板还原出 RGB（cube + 灰阶爬梯），
 *     混合后再量化回最近的调色板条目，所以 256 色下也有行内底色，只是精度差一点。
 *   - 一行被折行时**跳过行内高亮**：ranges 是对未折行全文的字符偏移，续行对不上。
 *   - 行内高亮在同一块内按相似度配对（公共前后缀最长的那对先配，每行最多配一次），
 *     且改动占比 > 0.4 就放弃（沿用 CC Fallback.tsx 的阈值）—— 大面积改写时整行底色
 *     比行内高亮更清楚。
 *   - LCS 是 O(n·m)，长行超过阈值直接放弃行内高亮。
 */

import type { EditToolDetails, ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createWriteToolDefinition,
	generateUnifiedPatch,
	getLanguageFromPath,
	highlightCode,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
// 标题行的排版（预算分配 / 截断 / 闪烁占位 / 行数缩略）在伴生目录 `tool-diff/` 里，
// 那是个**无 `index.ts` 的纯模块目录**（pi 只加载 `extensions/<name>.ts` 与
// `extensions/<name>/index.ts`，所以它不会被当成扩展）。
import { TitleRow, blinkSuffix, shortenPath, statsSuffix, type TitleRowDeps } from "./tool-diff/title-row.ts";

/** 折叠态最多渲染的 diff 行数 */
const PREVIEW_MAX_LINES = 60;
/**
 * 每处改动前后保留的上下文行数。
 *
 * pi 生成的 unified patch 固定带 4 行上下文（`generateUnifiedPatch(path, old, new,
 * contextLines = 4)`，edit 的 `EditToolDetails.patch` 也是同一个默认值算出来的），
 * 4 行在窄终端里太占地方，这里统一收窄到 2 行 —— 见 `collapseContextRuns`。
 */
const CONTEXT_LINES = 2;
/** ctrl+e 展开后最多渲染的 diff 行数 */
const EXPANDED_MAX_LINES = 150;
/** 超过这个字符量就不做语法高亮（highlightCode 有成本） */
const MAX_HIGHLIGHT_CHARS = 32_000;
/** 一行最多折成几行，超出用 `›` 截断标记 */
const MAX_WRAP_ROWS = 3;
/** 改动占比超过这个值就放弃行内高亮（CC Fallback.tsx 的阈值） */
const WORD_HIGHLIGHT_CHANGE_RATIO = 0.4;
/** 行内 LCS 的**字符数**乘积上限，超出就放弃（O(n·m) 成本，500×500 字符 ≈ 1MB DP 表） */
const WORD_DIFF_CHAR_PRODUCT_LIMIT = 250_000;
/**
 * 行内底色 = 整行底色朝该侧前景色混合的比例。
 *
 * 混合目标就是同色系的前景色，比例越大行内底色越贴近文字色：0.45 时
 * pi-coder-summer-night 的亮绿 `#42774c` / 亮红 `#96424a` 上语法高亮前景只剩 ≈2-3:1
 * 对比度（注释等深色 token 跌到 ≈1.1:1），字符几乎看不清。
 * 0.30 时行内底色明显亮于整行底色（pi-coder-summer-night：`#052a02` → `#306137`、
 * `#400404` → `#7d3036`，ΔE76 ≈ 22-23），正文对比度 ≈4.1-4.3:1，
 * 高亮片段一眼可辨；代价是注释等深色 token 跌到 ≈1.5-1.9:1，偏淡。
 */
const WORD_BG_BLEND = 0.30;

/**
 * diff 底色 token 名 —— 从**皮肤文件**取，不在扩展里硬编码任何色值。
 *
 * pi 的主题 schema 没有 diff 底色 token（`Theme.bg()` 只认 7 个 ThemeBg），但 `colors`
 * 里的**自定义 key** pi 照样会解析：`createTheme()` 把解析完（含 `vars` 引用）的颜色按
 * key 分流，不在那 7 个 ThemeBg 名单里的一律进 `fgColors` 表，`getFgAnsi()` 按 key 查表
 * 返回。所以皮肤里写 `"toolDiffAddedBg": "myAddedBg"`（`myAddedBg` 是皮肤 `vars` 里自定的
 * 变量）就能读到，换皮肤底色跟着换 ——
 * 扩展和皮肤解耦，色值只存在于皮肤文件里。
 *
 * 返回的是**前景色** SGR（`\x1b[38;…m`），而底色只差前缀（`\x1b[48;…m`）：pi 的 `fgAnsi`
 * 与 `bgAnsi`（theme.js）除了 38 / 48 这一个数字完全相同，truecolor / 256color 的换算也是
 * 同一套（`hexToRgb` / `hexTo256`），所以换前缀就是合法的底色，不用自己算色彩模式。
 *
 * 皮肤没定义这两个 token 时（pi 内置的 dark / light，或别人的皮肤）`getFgAnsi` 会抛
 * `Unknown theme color`，兜底用同一个皮肤的 `toolSuccessBg` / `toolErrorBg` ——
 * 仍然取自皮肤，仍然不硬编码色值。
 */
const DIFF_ADDED_BG_TOKEN = "toolDiffAddedBg";
const DIFF_REMOVED_BG_TOKEN = "toolDiffRemovedBg";
/** write 读旧内容时的文件大小上限，超出就不算 diff */
const OLD_CONTENT_MAX_BYTES = 200_000;
/**
 * 标题行 `+N -M` 的 diff 成本上限（新旧两侧字符数之和），超出就不显示统计。
 * 和 `MAX_HIGHLIGHT_CHARS` 同一个理由：renderCall 在渲染路径上，jsdiff 的行级 diff
 * 在超大文本上不便宜，宁可少一个尾注也不要卡住重绘。
 */
const STATS_MAX_CHARS = 200_000;

/** 流式加载中标记的闪烁间隔（ms）：亮 / 灭各占一个间隔，所以周期是它的两倍 */
const BLINK_INTERVAL_MS = 500;
/** 闪烁 tick 上限（≈5 分钟）：没有别的信号能停表时的兜底，见 `startBlink` */
const BLINK_MAX_TICKS = 600;

/**
 * 标题行与单行提示（Editing… / Applied / Error / no changes）的前导缩进。
 * 工具行原本顶格，跟上方 assistant 文本齐平看不出层次；缩一格后标题 / 提示 / 卡片
 * 形成层级，也和 pi 内置 Box 内容的 paddingX=1 观感一致。
 */
const INDENT = " ";

/**
 * diff 行与 hunk 分隔行（`┄`）的前导缩进 —— 对齐 codex 的 diff 观感。
 * codex 的行号列不顶格，整块 diff 相对工具标题往里缩；这里只缩 1 列，和标题 /
 * 提示行的 INDENT 一致 —— 试过 4 列（codex 原样），但窄终端里代码区会被吃掉太多列，
 * 折行明显变多，1 列是层次感与可用宽度的折中。
 * 上下边框（`╌`）**不**跟着缩进 —— 见 `dashedRule`。
 */
const DIFF_INDENT = " ";

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";
const FULL_RESET = "\x1b[0m";

type DiffLineType = "add" | "del" | "ctx" | "sep";

interface DiffLine {
	type: DiffLineType;
	oldNum: number | null;
	newNum: number | null;
	content: string;
}

interface ParsedDiff {
	lines: DiffLine[];
	added: number;
	removed: number;
}

/** 一个 SGR 束，按当前主题算一次 */
interface Sgr {
	BG_ADD: string;
	BG_DEL: string;
	BG_ADD_WORD: string;
	BG_DEL_WORD: string;
	FG_ADD: string;
	FG_DEL: string;
	FG_CTX: string;
	FG_NUM: string;
	FG_RULE: string;
}

/** 宽度无关的预处理结果，避免每次改宽度都重跑 highlightCode */
interface PreparedRow {
	kind: "line" | "sep";
	type: DiffLineType;
	sign: string;
	numText: string;
	contentHL: string;
	ranges: readonly [number, number][] | undefined;
}

/**
 * 行号槽（缩进 + 行号 + 空格 + 符号 + 空格）的总列宽。
 * 顺序按 codex：行号在第一列，符号列紧跟其后，最后才是代码区 ——
 * 早期实现是符号在前、行号在后（`+ 340`），与 codex（`95 +`）不一致。
 * 符号与正文之间只留 1 个空格（codex 原样是 2 个，这里按用户要求收窄到 1）。
 * 折行续行要按这个宽度补空白，才能让代码区左右对齐。
 */
function gutterWidthOf(numWidth: number): number {
	return DIFF_INDENT.length + numWidth + 3;
}

/** 空白行号槽：折行续行用（不显示行号和 +- 号，只保留底色） */
function blankGutter(numWidth: number): string {
	return DIFF_INDENT + " ".repeat(numWidth + 3);
}

interface WordRanges {
	old: Array<[number, number]>;
	new: Array<[number, number]>;
}

/**
 * 行级共享状态里的闪烁字段（edit / write 共用）。
 * pi 的 `context.state` 每个工具行一份（tool-execution.js 的 `rendererState`），
 * renderCall / renderResult 共用同一个对象 —— 所以定时器句柄挂在这里，
 * 另一个 slot 才清得掉它。
 */
interface BlinkFields {
	blinkOn?: boolean;
	blinkTicks?: number;
	blinkTimer?: ReturnType<typeof setInterval> | null;
}

/** 标题行尾部 `(+N -M)` 的行数统计 */
interface DiffStats {
	added: number;
	removed: number;
}

/**
 * 行级共享状态：闪烁字段 + 标题行统计缓存（edit / write 共用）。
 *
 * `stats` 三态：`undefined` = 还没算过，`null` = 算过但算不出来（超大文本 / diff 报错），
 * 否则 = 结果。`null` 也要存下来，不然算不出来的那些行每帧都会重跑一遍 diff。
 */
interface RowState extends BlinkFields {
	stats?: DiffStats | null;
}

/** write 的渲染器共享状态：存执行前读到的旧内容（`path` 同时充当「这个路径已经抓过」的标记） */
interface WriteState extends RowState {
	oldContent?: string;
	path?: string;
}

// ---------------------------------------------------------------------------
// unified patch 解析
// ---------------------------------------------------------------------------

/**
 * 解析标准 unified patch。`---` / `+++` 只在第一个 hunk 之前才是文件头，
 * 之后所有行都按内容行处理 —— 内容行本身可能以 `-` / `+` 开头（比如 `--verbose`），
 * 全局按前缀判会把它们误当头部丢掉。
 */
function parsePatch(patch: string): ParsedDiff {
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;

	for (const rawWithCr of patch.split("\n")) {
		// CRLF 源文件会给每行留一个尾随 \r，渲染时会让光标跳回第 0 列、覆盖已画好的行号槽
		const raw = rawWithCr.endsWith("\r") ? rawWithCr.slice(0, -1) : rawWithCr;

		if (raw.startsWith("@@")) {
			const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (match === null) continue;
			if (inHunk) lines.push({ type: "sep", oldNum: null, newNum: null, content: "" });
			inHunk = true;
			oldLine = Number(match[1]);
			newLine = Number(match[2]);
			continue;
		}

		if (!inHunk) {
			// 第一个 @@ 之前的都是头部（diff --git / index / --- / +++）
			continue;
		}
		if (raw.startsWith("\\ No newline")) continue;

		const marker = raw[0];
		const text = raw.slice(1);
		if (marker === "+") {
			lines.push({ type: "add", oldNum: null, newNum: newLine, content: text });
			newLine += 1;
			added += 1;
		} else if (marker === "-") {
			lines.push({ type: "del", oldNum: oldLine, newNum: null, content: text });
			oldLine += 1;
			removed += 1;
		} else if (marker === " ") {
			lines.push({ type: "ctx", oldNum: oldLine, newNum: newLine, content: text });
			oldLine += 1;
			newLine += 1;
		}
	}

	return { lines: collapseContextRuns(lines), added, removed };
}

/**
 * 把连续的上下文行收窄到改动两侧各 `CONTEXT_LINES` 行。
 *
 * 为什么在解析之后收窄、而不是让 patch 少生成几行：edit 的 patch 是 pi 给的
 * `EditToolDetails.patch`（上下文行数由 pi 内部固定成 4），扩展改不了它的生成参数。
 * write 的 patch 虽然是本文件自己调 `generateUnifiedPatch` 算的、可以直接传
 * `CONTEXT_LINES`，但 jsdiff 会按新的上下文值**重新切 hunk**（空档 > 2×context 才断开），
 * 于是同样的空档在 edit 里是一条 `┄`、在 write 里变成两条 —— 所以两个工具都走这一条
 * 收窄路径，观感才一致。
 *
 * 规则（与 unified diff 的语义对齐）：
 *   - hunk 开头的上下文：只留紧贴第一处改动的**后** CONTEXT_LINES 行（前面的直接丢，
 *     行号槽已经说明了文件里从哪一行开始）；
 *   - hunk 结尾的上下文：只留紧贴上一处改动的**前** CONTEXT_LINES 行；
 *   - 两处改动之间的空档：长度 ≤ 2×CONTEXT_LINES 就整段保留（本来挨着的两处改动不该
 *     被拆成两个 hunk），超过才前后各留 CONTEXT_LINES 行、中间插一条 `sep`（与跨 hunk
 *     的分隔符同一个视觉）。
 *
 * 只影响显示：`added` / `removed` 仍按完整 patch 统计（在 parsePatch 里已经算好）。
 */
function collapseContextRuns(lines: readonly DiffLine[]): DiffLine[] {
	const out: DiffLine[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		if (line.type !== "ctx") {
			out.push(line);
			i += 1;
			continue;
		}
		// 一整段连续的 ctx 行
		let end = i;
		while (end < lines.length && lines[end]?.type === "ctx") end += 1;
		const run = lines.slice(i, end);
		// 前后邻居是不是 hunk 边界（`sep`）或 patch 的首尾
		const atHunkStart = i === 0 || lines[i - 1]?.type === "sep";
		const atHunkEnd = end === lines.length || lines[end]?.type === "sep";

		if (atHunkStart && atHunkEnd) {
			// 整个 hunk 只有上下文（现实中不会出现，兜底一下）
			out.push(...run.slice(0, CONTEXT_LINES));
		} else if (atHunkStart) {
			out.push(...run.slice(Math.max(0, run.length - CONTEXT_LINES)));
		} else if (atHunkEnd) {
			out.push(...run.slice(0, CONTEXT_LINES));
		} else if (run.length > CONTEXT_LINES * 2) {
			out.push(...run.slice(0, CONTEXT_LINES));
			out.push({ type: "sep", oldNum: null, newNum: null, content: "" });
			out.push(...run.slice(run.length - CONTEXT_LINES));
		} else {
			out.push(...run);
		}
		i = end;
	}
	return out;
}

function maxLineNumber(lines: readonly DiffLine[]): number {
	let max = 0;
	for (const line of lines) {
		// 两个号都要看：unified 里 ctx/add 渲染 newNum、del 渲染 oldNum，
		// 只按其中一个算会让纯新增尾块的行号槽溢出一列
		const value = Math.max(line.oldNum ?? 0, line.newNum ?? 0);
		if (value > max) max = value;
	}
	return max;
}

// ---------------------------------------------------------------------------
// 行内 diff（自己的 LCS，无依赖）
// ---------------------------------------------------------------------------

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const [start, end] of ranges) {
		const last = out[out.length - 1];
		if (last !== undefined && last[1] >= start) last[1] = end;
		else out.push([start, end]);
	}
	return out;
}

/**
 * 行内 LCS。返回的是**原文里的字符偏移区间**（UTF-16 下标），
 * 所以消费方（injectBg）也必须按字符下标推进，不能用终端列宽。
 *
 * 按**字符**而不是按词做 LCS。按词做 diff 会把 `computeTimeout` →
 * `computeTimeoutFromProfile` 当成两个不同的 token（整词替换，14+25 个字符全算变更，
 * 改动占比 0.47）而在这 0.4 的闸门处整对丢掉 —— 而这恰恰是代码里最常见的改动：
 * 标识符加长 / 换名 / 追加参数。字符级 LCS 只标出真正新增的 `FromProfile`（11 个字符，
 * 占比 0.13），高亮落点更准；实测会话日志里 339 个 1 删 1 增块中有 131 个（38.6%）
 * 是被整词粒度误杀的。
 *
 * 两道降本措施（O(n·m) 的 DP 表在长行上很贵 —— 本仓库 README 里那种上千字符的表格行就是）：
 *   1. 先掐掉公共前后缀，只在**两侧真正不同的那一段**上跑 LCS。长行通常只改中间一小段，
 *      掐完往往只剩几个字符；
 *   2. 掐完还是太大（`WORD_DIFF_CHAR_PRODUCT_LIMIT`）就直接放弃行内高亮，只留整行底色。
 * DP 表用扁平 `Int32Array`（不建 `number[][]`：后者是 n+1 个 JS 数组，开销大得多）。
 */
function computeWordRanges(oldText: string, newText: string): WordRanges | undefined {
	if (oldText === newText) return undefined;

	// 公共前后缀：两侧逐字符相同的开头 / 结尾，本来就不是改动
	let prefix = 0;
	const maxPrefix = Math.min(oldText.length, newText.length);
	while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;
	let oldEnd = oldText.length;
	let newEnd = newText.length;
	while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}

	const oldMid = oldText.slice(prefix, oldEnd);
	const newMid = newText.slice(prefix, newEnd);
	const n = oldMid.length;
	const m = newMid.length;
	if (n * m > WORD_DIFF_CHAR_PRODUCT_LIMIT) return undefined;

	const width = m + 1;
	const dp = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i -= 1) {
		const row = i * width;
		const below = row + width;
		const oldChar = oldMid[i];
		for (let j = m - 1; j >= 0; j -= 1) {
			dp[row + j] =
				oldChar === newMid[j] ? dp[below + j + 1] + 1 : Math.max(dp[below + j], dp[row + j + 1]);
		}
	}

	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oi = 0;
	let nj = 0;
	let changed = 0;

	while (oi < n && nj < m) {
		if (oldMid[oi] === newMid[nj]) {
			oi += 1;
			nj += 1;
		} else if (dp[(oi + 1) * width + nj] >= dp[oi * width + nj + 1]) {
			oldRanges.push([prefix + oi, prefix + oi + 1]);
			changed += 1;
			oi += 1;
		} else {
			newRanges.push([prefix + nj, prefix + nj + 1]);
			changed += 1;
			nj += 1;
		}
	}
	while (oi < n) {
		oldRanges.push([prefix + oi, prefix + oi + 1]);
		changed += 1;
		oi += 1;
	}
	while (nj < m) {
		newRanges.push([prefix + nj, prefix + nj + 1]);
		changed += 1;
		nj += 1;
	}

	// 占比按**整行**算（分母不是掐完的中间段）：两侧相同的部分不算改动，但分母用整行长度，
	// 「长行里改一小段」与「短行里改一小段」才是同一个口径（也就是 CC 的 changed/total）。
	const changeRatio = changed / (oldText.length + newText.length);
	if (changeRatio > WORD_HIGHLIGHT_CHANGE_RATIO) return undefined;
	return { old: mergeRanges(oldRanges), new: mergeRanges(newRanges) };
}

/**
 * 两行的相似度代理：公共前后缀的字符数之和。O(长度)，用来在块内选配对，不跑 LCS。
 * 代码行的改动绝大多数是「中间一小段不同」或者「尾部追加」，前后缀都能很好地反映相似度；
 * 而完全无关的两行在这个指标上会很低。
 */
function commonAffixLength(a: string, b: string): number {
	const maxPrefix = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1;
	let suffix = 0;
	while (suffix < maxPrefix - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
	return prefix + suffix;
}

/**
 * 把一个「N 删 + M 增」块内的行两两配对，每行最多配一次。
 *
 * 早期只在严格 1 删 1 增时配对（`visible[i + 2]` 还是 add 就整块放弃），理由是
 * 「一个 `-` 后面跟多条 `+` 属于块替换，做行内高亮会误导」。代价是：多行改写完全
 * 拿不到行内高亮 —— 会话日志里约 670 个相邻 -/+ 块只有一半是 1:1，另一种形状
 * （1 删 + N 增 / N 删 + M 增）的约 330 个块、2500 行改动全部只有整行底色。
 *
 * 配对规则**不是** CC 那样的「按位置逐行配」（`wordDiff` 用的是 min 长度逐位置），
 * 而是块内按相似度贪心：把 D×A 个候选对按
 * `commonAffixLength` 从高到低排，依次取走两端都没配过的对。理由是位置配会在块内
 * 行数不等时配错人 —— 例如
 *
 *     -const value = 1;
 *     +const extra = 'x';   ← 新插进来的一行
 *     +const value = 2;
 *
 * 位置配会把 `value = 1` 配给 `extra = 'x'`（实测这个对的改动占比 0.35，刚好越过 0.4
 * 闸门，于是画出两段毫无意义的红/绿碎片），而相似度配会把它配给 `value = 2`，
 * 高亮落在那一个数字上。同分时保持原顺序（`sort` 稳定），所以 D=A、各行都改动时
 * 退化成等价于位置配。真正对不上的行会在 `computeWordRanges` 的 0.4 闸门处被丢掉，
 * 退化成整行底色，不会画出误导性的高亮。
 *
 * 返回的 map 按 **del 行和 add 行两个下标都建键**，各自指向自己一侧的区间。
 * 早期只按 del 的下标建键，而 prepareRows 对 add 行查的是 add 自己的下标，
 * 于是新增侧的行内高亮永远 miss（删除侧正常）—— 两侧观感不对称。
 */
function pairWordRanges(visible: readonly DiffLine[]): Map<number, readonly [number, number][]> {
	const out = new Map<number, readonly [number, number][]>();
	let i = 0;
	while (i < visible.length) {
		if (visible[i]?.type !== "del") {
			i += 1;
			continue;
		}
		// [i, delEnd) 是连续的删除行，[delEnd, addEnd) 是紧跟其后的连续新增行
		let delEnd = i;
		while (visible[delEnd]?.type === "del") delEnd += 1;
		let addEnd = delEnd;
		while (visible[addEnd]?.type === "add") addEnd += 1;

		const candidates: Array<{ del: number; add: number; score: number }> = [];
		for (let d = i; d < delEnd; d += 1) {
			const del = visible[d];
			if (del === undefined) continue;
			for (let a = delEnd; a < addEnd; a += 1) {
				const add = visible[a];
				if (add === undefined) continue;
				candidates.push({ del: d, add: a, score: commonAffixLength(del.content, add.content) });
			}
		}
		// Array.prototype.sort 稳定，同分即保持位置顺序（等价于 CC 的位置配）
		candidates.sort((left, right) => right.score - left.score);

		const pairedDel = new Set<number>();
		const pairedAdd = new Set<number>();
		for (const candidate of candidates) {
			if (pairedDel.has(candidate.del) || pairedAdd.has(candidate.add)) continue;
			const del = visible[candidate.del];
			const add = visible[candidate.add];
			if (del === undefined || add === undefined) continue;
			pairedDel.add(candidate.del);
			pairedAdd.add(candidate.add);
			const ranges = computeWordRanges(del.content, add.content);
			if (ranges === undefined) continue;
			out.set(candidate.del, ranges.old);
			out.set(candidate.add, ranges.new);
		}
		i = addEnd > delEnd ? addEnd : delEnd;
	}
	return out;
}

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/**
 * xterm 256 色调色板 → RGB。`Theme` 在 256color 模式下只留索引（`38;5;N`），
 * 混合前必须先把索引还原成 RGB：16-231 是 6×6×6 立方（每级 0 / 95 / 135 / 175 / 215 / 255），
 * 232-255 是 24 级灰阶（8 + 10·n）。0-15 是终端自己的系统色，各终端不一样，这里按
 * xterm 默认值取，但**量化时不用**它们（见 `nearestXterm256`）。
 */
const XTERM_256_RGB: readonly Rgb[] = (() => {
	const system: Rgb[] = [
		[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
		[0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
		[128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
		[0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
	];
	const levels = [0, 95, 135, 175, 215, 255];
	const cube: Rgb[] = [];
	for (let r = 0; r < 6; r += 1) {
		for (let g = 0; g < 6; g += 1) {
			for (let b = 0; b < 6; b += 1) cube.push([levels[r] ?? 0, levels[g] ?? 0, levels[b] ?? 0]);
		}
	}
	const ramp: Rgb[] = [];
	for (let n = 0; n < 24; n += 1) {
		const v = 8 + n * 10;
		ramp.push([v, v, v]);
	}
	return [...system, ...cube, ...ramp];
})();

/** 两个 RGB 的加权平方距离（绿通道权重最高，人眼对绿最敏感；与 pi 的 `rgbTo256` 同口径） */
function rgbDistance(a: Rgb, b: Rgb): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/**
 * 就近取一个 256 色索引，规则与 pi 的 `rgbTo256` 一致：先在 6×6×6 立方里取最近的一格，
 * 再和 24 级灰阶爬梯比，**但只有颜色接近中性（三通道极差 < 10）时才允许倒向灰阶**。
 * 那条饱和度守卫不能省：行内底色是带色调的（红=删 / 绿=增），而未加权的最邻近搜索会把
 * `#287126`（混合后的绿行底色）量化成灰阶 239（`#4e4e4e`）—— 灰条落在绿行上，语义就丢了。
 *
 * 0-15 的 16 个系统色不参与匹配：它们由终端主题决定，同一个索引在不同终端里差别很大。
 */
function nearestXterm256(rgb: Rgb): number {
	const levels = [0, 95, 135, 175, 215, 255];
	const closest = (value: number): number => {
		let index = 0;
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < levels.length; i += 1) {
			const distance = Math.abs(value - (levels[i] ?? 0));
			if (distance < best) {
				best = distance;
				index = i;
			}
		}
		return index;
	};

	const rIndex = closest(rgb[0]);
	const gIndex = closest(rgb[1]);
	const bIndex = closest(rgb[2]);
	const cubeIndex = 16 + 36 * rIndex + 6 * gIndex + bIndex;
	const cube: Rgb = [levels[rIndex] ?? 0, levels[gIndex] ?? 0, levels[bIndex] ?? 0];
	const cubeDistance = rgbDistance(rgb, cube);

	const grayValue = Math.round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]);
	let grayIndex = 0;
	let grayDistance = Number.POSITIVE_INFINITY;
	for (let n = 0; n < 24; n += 1) {
		const value = 8 + n * 10;
		const distance = Math.abs(grayValue - value);
		if (distance < grayDistance) {
			grayDistance = distance;
			grayIndex = n;
		}
	}
	const gray = 8 + grayIndex * 10;
	const spread = Math.max(...rgb) - Math.min(...rgb);
	if (spread < 10 && rgbDistance(rgb, [gray, gray, gray]) < cubeDistance) return 232 + grayIndex;
	return cubeIndex;
}

/** `\x1b[38;2;…m` / `\x1b[48;2;…m`（truecolor）或 `\x1b[38|48;5;Nm`（256 色索引）→ RGB */
function parseRgb(ansi: string): Rgb | undefined {
	const truecolor = ansi.match(/\x1b\[[34]8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/);
	if (truecolor !== null) return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	const indexed = ansi.match(/\x1b\[[34]8;5;(\d{1,3})m/);
	if (indexed !== null) return XTERM_256_RGB[Number(indexed[1])];
	return undefined;
}

/**
 * 从皮肤读一个 diff 底色 token，并转成底色 SGR（`38;…` → `48;…`，见上面的注释）。
 * 皮肤没定义时（`getFgAnsi` 抛 `Unknown theme color`）回退到 `fallback` 那个 ThemeBg。
 * 颜色值是空串时 pi 返回 `\x1b[39m`（前景重置），换不了前缀，同样走兜底。
 */
function diffBgFromTheme(theme: Theme, token: string, fallback: "toolSuccessBg" | "toolErrorBg"): string {
	let ansi: string;
	try {
		ansi = theme.getFgAnsi(token as ThemeColor);
	} catch {
		return theme.getBgAnsi(fallback);
	}
	if (!ansi.startsWith("\x1b[38;")) return theme.getBgAnsi(fallback);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

/**
 * 行内底色 = 整行底色朝该侧前景色混合。这样底色跟皮肤走，不硬编码。
 *
 * 输入是 256 色索引（`48;5;N`）时就**回去也是索引** —— 只支持 256 色的终端里发 truecolor SGR
 * 多半会被当成未知颜色丢掉，那样还不如不发。量化回索引走 `nearestXterm256`，粒度粗一些，
 * 但混合的方向不变（混合后的颜色一定比整行底色更靠近前景色，量化误差不足以推翻它）。
 */
function deriveWordBg(baseBgAnsi: string, fgAnsi: string): string {
	const base = parseRgb(baseBgAnsi);
	const fg = parseRgb(fgAnsi);
	if (base === undefined || fg === undefined) return baseBgAnsi;
	const r = Math.round(base[0] + (fg[0] - base[0]) * WORD_BG_BLEND);
	const g = Math.round(base[1] + (fg[1] - base[1]) * WORD_BG_BLEND);
	const b = Math.round(base[2] + (fg[2] - base[2]) * WORD_BG_BLEND);
	if (baseBgAnsi.startsWith("\x1b[48;5;")) return `\x1b[48;5;${nearestXterm256([r, g, b])}m`;
	return `\x1b[48;2;${r};${g};${b}m`;
}

function buildSgr(theme: Theme): Sgr {
	// 整行底色从皮肤取：优先皮肤自定义的 toolDiffAddedBg / toolDiffRemovedBg，
	// 皮肤没定义就退回同一个皮肤的 toolSuccessBg / toolErrorBg —— 两条路都不硬编码色值。
	const BG_ADD = diffBgFromTheme(theme, DIFF_ADDED_BG_TOKEN, "toolSuccessBg");
	const BG_DEL = diffBgFromTheme(theme, DIFF_REMOVED_BG_TOKEN, "toolErrorBg");
	const FG_ADD = theme.getFgAnsi("toolDiffAdded");
	const FG_DEL = theme.getFgAnsi("toolDiffRemoved");
	return {
		BG_ADD,
		BG_DEL,
		BG_ADD_WORD: deriveWordBg(BG_ADD, FG_ADD),
		BG_DEL_WORD: deriveWordBg(BG_DEL, FG_DEL),
		FG_ADD,
		FG_DEL,
		FG_CTX: theme.getFgAnsi("toolDiffContext"),
		FG_NUM: theme.getFgAnsi("dim"),
		FG_RULE: theme.getFgAnsi("dim"),
	};
}

/**
 * 给一行（可能已带语法高亮 ANSI）叠底色，并在指定字符区间换成行内底色。
 *
 * 计数器按**字符下标**推进（与 `computeWordRanges` 的偏移同一坐标系），不是终端列宽。
 * 遇到 `\x1b[0m` 必须重新注入底色 —— 全量重置会把背景一起清掉。
 */
function injectBg(
	line: string,
	baseBg: string,
	ranges: readonly [number, number][] | undefined,
	wordBg: string,
): string {
	let out = baseBg;
	let charIndex = 0;
	let inWord = false;
	let rangeIndex = 0;
	let i = 0;

	while (i < line.length) {
		if (line[i] === "\x1b") {
			const end = line.indexOf("m", i);
			if (end !== -1) {
				const sequence = line.slice(i, end + 1);
				out += sequence;
				if (sequence === FULL_RESET) out += inWord ? wordBg : baseBg;
				i = end + 1;
				continue;
			}
		}

		let range = ranges?.[rangeIndex];
		while (range !== undefined && charIndex >= range[1]) {
			rangeIndex += 1;
			range = ranges?.[rangeIndex];
		}
		const want = range !== undefined && charIndex >= range[0] && charIndex < range[1];
		if (want !== inWord) {
			inWord = want;
			out += inWord ? wordBg : baseBg;
		}

		out += line[i] ?? "";
		charIndex += 1;
		i += 1;
	}

	return out + BG_RESET;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function highlightLines(source: readonly string[], language: string | undefined): string[] {
	if (language === undefined || source.length === 0) return [...source];
	const joined = source.join("\n");
	if (joined.length > MAX_HIGHLIGHT_CHARS) return [...source];
	try {
		const highlighted = highlightCode(joined, language);
		// 行数对不上就不能按索引映射，退回原文
		return highlighted.length === source.length ? highlighted : [...source];
	} catch {
		return [...source];
	}
}

/**
 * 宽度无关的预处理：语法高亮 + 行内配对 + 行号槽文本。
 * 高亮分两侧算（老侧 = ctx+del，新侧 = ctx+add），与 CC / 参考实现一致。
 */
function prepareRows(
	s: Sgr,
	visible: readonly DiffLine[],
	language: string | undefined,
	gutterWidth: number,
): PreparedRow[] {
	const oldSource: string[] = [];
	const newSource: string[] = [];
	for (const line of visible) {
		if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
	}
	const oldHL = highlightLines(oldSource, language);
	const newHL = highlightLines(newSource, language);
	const wordMap = pairWordRanges(visible);

	const rows: PreparedRow[] = [];
	let oi = 0;
	let ni = 0;
	for (let i = 0; i < visible.length; i += 1) {
		const line = visible[i];
		if (line === undefined) continue;

		if (line.type === "sep") {
			rows.push({ kind: "sep", type: "sep", sign: "", numText: "", contentHL: "", ranges: undefined });
			continue;
		}

		let contentHL: string;
		let ranges: readonly [number, number][] | undefined;
		if (line.type === "del") {
			contentHL = oldHL[oi] ?? line.content;
			oi += 1;
			ranges = wordMap.get(i);
		} else if (line.type === "add") {
			contentHL = newHL[ni] ?? line.content;
			ni += 1;
			ranges = wordMap.get(i);
		} else {
			// ctx 两侧都有，取新侧；两个游标都要推进
			contentHL = newHL[ni] ?? line.content;
			oi += 1;
			ni += 1;
		}

		const num = line.type === "del" ? line.oldNum : line.newNum;
		const numText =
			num === null ? " ".repeat(gutterWidth) : " ".repeat(Math.max(0, gutterWidth - String(num).length)) + String(num);
		const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";

		rows.push({ kind: "line", type: line.type, sign, numText, contentHL, ranges });
	}
	return rows;
}

/** 按宽度排版：补底色到满宽、必要时折行 */
function layoutRows(s: Sgr, rows: readonly PreparedRow[], width: number, gutterWidth: number): string[] {
	// 槽位 = 缩进(DIFF_INDENT) + 行号(gutterWidth) + 空格(1) + 符号(1) + 空格(1)
	const prefixWidth = gutterWidthOf(gutterWidth);
	const contentWidth = Math.max(1, width - prefixWidth);
	const out: string[] = [];

	for (const row of rows) {
		if (row.kind === "sep") {
			out.push(`${DIFF_INDENT}${s.FG_RULE}${"┄".repeat(Math.max(0, width - DIFF_INDENT.length))}${FG_RESET}`);
			continue;
		}

		const bg = row.type === "add" ? s.BG_ADD : row.type === "del" ? s.BG_DEL : "";
		const wordBg = row.type === "add" ? s.BG_ADD_WORD : row.type === "del" ? s.BG_DEL_WORD : "";
		const signFg = row.type === "add" ? s.FG_ADD : row.type === "del" ? s.FG_DEL : s.FG_CTX;
		// 行号在前、符号在后，符号与正文之间一个空格（`95 - code` / `94   code`）。
		// 行号跟符号同色（ctx 行没有符号，保持原来的 dim）。
		const numFg = row.type === "ctx" ? s.FG_NUM : signFg;
		const gutterText = `${DIFF_INDENT}${numFg}${row.numText}${FG_RESET} ${signFg}${row.sign}${FG_RESET} `;
		// 底色从**整行最左侧**开始下（含 DIFF_INDENT 那 1 列），槽位内部一律只用 FG_RESET
		// （只重置前景）收尾，所以行号 / 符号的收尾不会把底色清掉 —— 缩进 + 行号槽 + 代码区
		// 连成一条完整的底色带，而不是只有代码区有底色。
		const gutter = bg === "" ? gutterText : bg + gutterText;
		const blank = bg === "" ? blankGutter(gutterWidth) : bg + blankGutter(gutterWidth);

		const wrapped = wrapTextWithAnsi(row.contentHL, contentWidth);
		const limited = wrapped.length > MAX_WRAP_ROWS ? wrapped.slice(0, MAX_WRAP_ROWS) : wrapped;
		for (let r = 0; r < limited.length; r += 1) {
			const rowText = limited[r] ?? "";
			// 折行时跳过行内高亮：ranges 是对未折行全文的字符偏移，续行对不上
			const effectiveRanges = wrapped.length === 1 ? row.ranges : undefined;
			const hasMarker = wrapped.length > MAX_WRAP_ROWS && r === limited.length - 1;
			// 截断标记要占 1 列，而折出来的最后一行本身已经正好是 contentWidth 宽，
			// 所以光减少 padding 不够 —— 必须把这行裁掉 1 列，否则整行会超宽 1 列
			// （CJK 宽字符尤其明显：每个字占 2 列，误差不会被“刚好差一个空格”掩盖）。
			const usable = hasMarker ? Math.max(1, contentWidth - 1) : contentWidth;
			const clipped = visibleWidth(rowText) > usable ? truncateToWidth(rowText, usable, "") : rowText;
			const padWidth = Math.max(0, usable - visibleWidth(clipped));
			// 标记放在底色内部，让色调铺满整行宽度而不是提前 1 列结束
			const marker = hasMarker ? `${s.FG_CTX}›${FG_RESET}` : "";
			const bodyText = clipped + " ".repeat(padWidth) + marker;
			const body = bg === "" ? bodyText : injectBg(bodyText, bg, effectiveRanges, wordBg);
			// 折行续行不带行号和 +- 号（codex 同款）：槽位整段留空，只靠底色表明归属，
			// 重复打同一个行号会让人误以为是多条独立改动。槽位留空但底色照旧铺满，
			// 否则折行部分会比首行短一截。
			out.push((r === 0 ? gutter : blank) + body);
		}
	}
	return out;
}

/**
 * 上下虚线框：**顶格**、铺满整行宽度 —— 它是卡片的边框而不是 diff 内容，所以不跟
 * diff 行的缩进走（缩进后框会比内容窄一列，看上去像框没合拢）。宽度直接取 width，
 * 不减缩进。
 */
function dashedRule(s: Sgr, width: number): string {
	return `${s.FG_RULE}${"╌".repeat(Math.max(0, width))}${FG_RESET}`;
}

/**
 * 结果卡片组件。`render(width)` 每帧都会调，所以按宽度缓存排版结果；
 * 语法高亮在构造时就算好了（宽度无关），不会每帧重跑。
 */
class DiffCard {
	private readonly cache = new Map<number, string[]>();

	constructor(private readonly layout: (width: number) => string[]) {}

	render(width: number): string[] {
		const hit = this.cache.get(width);
		if (hit !== undefined) return hit;
		const lines = this.layout(width);
		this.cache.set(width, lines);
		return lines;
	}

	invalidate(): void {
		this.cache.clear();
	}
}

function buildDiffCard(
	theme: Theme,
	diff: ParsedDiff,
	language: string | undefined,
	expanded: boolean,
): DiffCard {
	const s = buildSgr(theme);
	const maxLines = expanded ? EXPANDED_MAX_LINES : PREVIEW_MAX_LINES;
	const visible = diff.lines.slice(0, maxLines);
	const hidden = diff.lines.length - visible.length;
	const gutterWidth = Math.max(2, String(maxLineNumber(visible)).length);
	const rows = prepareRows(s, visible, language, gutterWidth);

	return new DiffCard((width: number) => {
		// 行数统计已经搬到标题行的 `(+N -M)`，卡片直接从上下虚线框开始，
		// 不再多一行 `Added N lines, removed M lines` 把同一份改动报两遍。
		if (rows.length === 0) return [];
		const out: string[] = [dashedRule(s, width)];
		out.push(...layoutRows(s, rows, width, gutterWidth));
		out.push(dashedRule(s, width));
		if (hidden > 0) {
			// 提示行没有底色可以靠 padding 占位，文本长了就会直接超宽，所以按宽度截断
			out.push(
				DIFF_INDENT +
					truncateToWidth(
						theme.fg(
							"muted",
							`… ${hidden} more diff ${hidden === 1 ? "line" : "lines"}${expanded ? "" : " (ctrl+e to expand)"}`,
						),
						Math.max(1, width - DIFF_INDENT.length),
						"…",
					),
			);
		}
		return out;
	});
}


/**
 * 两段文本之间的 +/- 行数。用与结果卡片同一套 `generateUnifiedPatch` + `parsePatch`，
 * 所以标题行的数字和卡片里画出来的行数是同一个口径。
 * 算不出来（超大文本 / 报错）返回 undefined，标题行就不带尾注。
 */
function diffStatsOf(oldText: string, newText: string): DiffStats | undefined {
	if (oldText === newText) return { added: 0, removed: 0 };
	if (oldText.length + newText.length > STATS_MAX_CHARS) return undefined;
	try {
		// path 只进 patch 头部，parsePatch 会跳过头部，所以传空串就够
		const parsed = parsePatch(generateUnifiedPatch("", oldText, newText));
		return { added: parsed.added, removed: parsed.removed };
	} catch {
		return undefined;
	}
}

/**
 * edit 的行数统计：逐条 edits 算 oldText → newText 再求和。
 * 各处改动落在文件里互不重叠的区域，所以求和等于整文件 patch 的 +/- 行数
 * （相邻改动被 jsdiff 合成一个 hunk 也只影响上下文，不影响 +/- 计数）。
 */
function editStats(args: unknown): DiffStats | undefined {
	const edits = (args as { edits?: unknown } | undefined)?.edits;
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	let added = 0;
	let removed = 0;
	for (const edit of edits) {
		const entry = edit as { oldText?: unknown; newText?: unknown } | undefined;
		if (entry === undefined || entry === null) continue;
		const stats = diffStatsOf(
			typeof entry.oldText === "string" ? entry.oldText : "",
			typeof entry.newText === "string" ? entry.newText : "",
		);
		if (stats === undefined) return undefined;
		added += stats.added;
		removed += stats.removed;
	}
	return { added, removed };
}

/** 统计只算一次，之后每帧复用（renderCall 会被反复调用：重绘、改宽度、展开折叠） */
function cachedStats(state: RowState | undefined, compute: () => DiffStats | undefined): DiffStats | undefined {
	if (state === undefined) return compute();
	if (state.stats === undefined) state.stats = compute() ?? null;
	return state.stats ?? undefined;
}


/**
 * 流式期间让标题尾部的 `●` 闪烁，返回当前相位（true = 亮）。
 *
 * 为什么用定时器而不是「跟着 delta 闪」：pi 的 tool-execution.js 里
 * `context.invalidate()` = `ToolExecutionComponent.invalidate()`（→ `updateDisplay()`
 * 重新调用 renderCall）+ `ui.requestRender()`，所以翻相位 + invalidate 就能自己驱动
 * 重绘 —— 节拍固定，不受 delta 到达节奏影响（delta 停一会儿也不会僵在某一相位上）。
 *
 * 停表有三处（前两处是正常路径，第三处是兜底）：
 *   1. renderCall 的 `argsComplete` 分支（参数流结束）；
 *   2. `renderResult`（结果已到）。它也覆盖中断 / 报错的行 —— interactive-mode.js 在
 *      `stopReason=aborted|error` 时对所有 pending 行调 `updateResult`，而不是
 *      `setArgsComplete`，所以那种行永远走不到 1；
 *   3. tick 上限。兜的是「行既没有结果、也永远等不到 argsComplete」：例如会话在工具
 *      调用中途被杀掉后恢复，那一行的 stopReason 不是 aborted/error、也没有 toolResult。
 *      （有结果的历史行不走这条：renderCall 的 `isPartial` 分支当场就把表停了。）
 *      正常单轮 write/edit 的参数流远不到这个上限。
 *
 * `unref()` 让定时器不阻止进程退出。
 */
function startBlink(state: BlinkFields, invalidate: () => void): boolean {
	if (state.blinkTimer === undefined || state.blinkTimer === null) {
		state.blinkOn = true;
		state.blinkTicks = 0;
		state.blinkTimer = setInterval(() => {
			state.blinkTicks = (state.blinkTicks ?? 0) + 1;
			if ((state.blinkTicks ?? 0) > BLINK_MAX_TICKS) {
				stopBlink(state);
				invalidate();
				return;
			}
			state.blinkOn = !(state.blinkOn ?? false);
			invalidate();
		}, BLINK_INTERVAL_MS);
		state.blinkTimer.unref?.();
	}
	return state.blinkOn !== false;
}

/** 停掉闪烁定时器并回到灭态。幂等 —— 没起过定时器时调用也安全。 */
function stopBlink(state: BlinkFields | undefined): void {
	if (state === undefined) return;
	if (state.blinkTimer !== undefined && state.blinkTimer !== null) clearInterval(state.blinkTimer);
	state.blinkTimer = null;
	state.blinkOn = false;
}


/**
 * 标题行。path 传空串就整段省略（流式开头路径还没解析出来时的形态是 `Edit ●`），
 * suffix 传空串就省略。suffix 必须是**已着色**的串 —— 闪烁标记要单独上色，而
 * `theme.fg("dim", 已着色串)` 的外层 reset 会把内层 ANSI 一起吃掉。
 * path 相反，传**纯文本**：`TitleRow.render` 要先按宽度从头部截断再上色。
 *
 * 排版依赖显式接上 pi-tui 的量度/截断函数（纯模块那头不知道 pi 的存在），
 * home 取一次就存着（进程内不会变）。
 */
const TITLE_ROW_DEPS: TitleRowDeps = {
	widthOf: visibleWidth,
	truncateToWidth,
	home: homedir(),
	indent: INDENT,
};

function titleRow(theme: Theme, tool: string, path: string, suffix: string): TitleRow {
	return new TitleRow(TITLE_ROW_DEPS, theme, theme.fg("toolTitle", theme.bold(tool)), path, suffix);
}

/** 单行提示（Editing… / Error / Applied / Written / no changes）。
 *  和结果卡片占同一个视觉位置，所以也带同样的缩进 —— 否则同一个工具在不同结果下
 *  一会儿缩进一会儿顶格，观感不一致。 */
function noteLine(theme: Theme, color: "dim" | "error" | "success" | "muted", text: string): Text {
	return new Text(INDENT + theme.fg(color, text), 0, 0);
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
	const first = result.content[0];
	return first !== undefined && first.type === "text" ? first.text ?? "" : "";
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const cwd = process.cwd();

	// --- edit：renderCall 只留一行标题，不显示内置那份 diff 预览 ---
	const originalEdit = createEditToolDefinition(cwd);
	pi.registerTool({
		...originalEdit,
		renderShell: "self",
		renderCall(args, theme, context) {
			const path = String(args?.path ?? "");
			const state = context.state as RowState | undefined;
			// 加载中显示工具名 + 路径 + 闪烁的 `●`（表示「正在接收字节流」）；token 数不在这里
			// 滚动 —— 底部 spinner 已经在数当前段的产出量（working-indicator/），重复。
			// `+N -M` 只在参数收完后显示 —— 流式途中 edits 数组可能还没解析出来，算出来的
			// 行数会一路跳。
			// path 有就显示、没就省略：实测 `parseStreamingJson` 对未闭合的字符串会返回
			// **部分值**（`{"path": "/a/b/ser` → `"/a/b/ser"`），所以流式开头会短暂看到逐字符
			// 增长的半截路径；但 path 是 schema 的第一个字段、字符串很短，几个 token 就闭合了，
			// 之后路径稳定而 content 还要流很久 —— 所以尽早显示比完全不显示更有用。
			// `isPartial` 只在 `updateResult` 之后才变 false（tool-execution.js），正好区分
			// 「真的在流式」和「结果已到但 argsComplete 永远不会变 true」的行 —— 后者是
			// 中断的行和恢复历史会话渲染出来的行（renderSessionItems 从不调 setArgsComplete）。
			// 那种行不闪也不画标记（否则历史区每行都会挂一个静态的 `●`），但照样算 `+N -M`：
			// 会话日志里的参数是完整的，历史区不能没有行数信息。
			if (!context.argsComplete && context.isPartial) {
				// state 拿不到时不闪，但仍然画出标记（宁可静态一点也不丢提示）
				const on = state === undefined ? true : startBlink(state, context.invalidate);
				return titleRow(theme, "Edit", path, blinkSuffix(theme, on));
			}
			// 参数流结束（或结果已到）：停表，恢复完整形态（路径 + `+N -M`）
			stopBlink(state);
			return titleRow(theme, "Edit", path, statsSuffix(theme, cachedStats(state, () => editStats(args))));
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			// 结果已到就停表（中断 / 报错的行也走这里）；partial 结果不算 —— 那时参数可能还在流。
			if (!isPartial) stopBlink(context.state as RowState | undefined);
			if (isPartial) return noteLine(theme, "dim", "Editing…");

			if (context.isError) {
				return noteLine(theme, "error", firstText(result).split("\n")[0] || "Edit failed");
			}

			const details = result.details as EditToolDetails | undefined;
			const patch = details?.patch ?? details?.diff ?? "";
			if (patch === "") return noteLine(theme, "success", "Applied");

			const diff = parsePatch(patch);
			if (diff.lines.length === 0) return noteLine(theme, "success", "Applied");

			const path = String((context.args as { path?: unknown } | undefined)?.path ?? "");
			return buildDiffCard(theme, diff, getLanguageFromPath(path), expanded);
		},
	});

	// --- write：自带 renderCall（要在执行前读旧内容），renderResult 画真 diff ---
	const originalWrite = createWriteToolDefinition(cwd);
	pi.registerTool({
		...originalWrite,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as WriteState | undefined;
			const path = String(args?.path ?? "");
			// 在执行开始前抓旧内容，并且**路径每变一次就重抓一次**：流式途中 path 是逐字符
			// 增长的（`parseStreamingJson` 对未闭合的字符串返回部分值），半截路径要么 stat 失败
			// （看上去像新建文件，于是覆盖已有文件被整份算成新增），要么恰好命中另一个文件。
			// 以 path 为键重抓，最后一帧（`argsComplete`，早于 `tool_execution_start`）拿到的一定
			// 是完整路径，所以最终值总是对的。一旦 executionStarted 就已经写完，再读拿到的是
			// 新内容，diff 会全空 —— 那个窗口一关就彻底停手。
			if (state !== undefined && path !== "" && !context.executionStarted && state.path !== path) {
				state.path = path;
				try {
					const absolute = resolvePath(context.cwd, path);
					const size = statSync(absolute).size;
					state.oldContent = size <= OLD_CONTENT_MAX_BYTES ? readFileSync(absolute, "utf-8") : "";
				} catch {
					// 文件不存在（新建）或读不了 → 按空内容处理，全部算新增
					state.oldContent = "";
				}
			}

			// 旧内容抓取必须在下面的显示分支之前：它依赖的是「执行还没开始」，
			// 而不是「参数已完整」—— 拖到 argsComplete 才读就可能赶不上写入前的窗口。
			// 加载中显示工具名 + 路径 + 闪烁的 `●`（与 edit 一致的形态）；token 数交给底部
			// spinner 滚动，标题行不再重复。`isPartial` 的语义与 edit 那边相同。
			if (!context.argsComplete && context.isPartial) {
				const on = state === undefined ? true : startBlink(state, context.invalidate);
				return titleRow(theme, "Write", path, blinkSuffix(theme, on));
			}
			// 参数流结束（或结果已到）：停表，恢复完整形态（路径 + `+N -M`）。
			// 统计用的是执行前抓到的旧内容 vs 参数里的新内容 —— 与 renderResult 画卡片时
			// 同一对输入，所以标题的数字和卡片里的行数不会打架。
			stopBlink(state);
			const content = String(args?.content ?? "");
			const stats = cachedStats(state, () => diffStatsOf(state?.oldContent ?? "", content));
			return titleRow(theme, "Write", path, statsSuffix(theme, stats));
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			// 结果已到就停表（中断 / 报错的行也走这里）；partial 结果不算 —— 那时参数可能还在流。
			if (!isPartial) stopBlink(context.state as WriteState | undefined);
			if (isPartial) return noteLine(theme, "dim", "Writing…");

			const text = firstText(result);
			if (context.isError || text.startsWith("Error")) {
				return noteLine(theme, "error", text.split("\n")[0] || "Write failed");
			}

			const state = context.state as WriteState | undefined;
			const path = String((context.args as { path?: unknown } | undefined)?.path ?? "");
			const content = String((context.args as { content?: unknown } | undefined)?.content ?? "");
			if (path === "" || content === "") return noteLine(theme, "success", "Written");

			const oldContent = state?.oldContent ?? "";
			if (oldContent === content) return noteLine(theme, "muted", "no changes");

			let patch: string;
			try {
				patch = generateUnifiedPatch(path, oldContent, content);
			} catch {
				return noteLine(theme, "success", "Written");
			}

			const diff = parsePatch(patch);
			if (diff.lines.length === 0) return noteLine(theme, "success", "Written");
			return buildDiffCard(theme, diff, getLanguageFromPath(path), expanded);
		},
	});
}
