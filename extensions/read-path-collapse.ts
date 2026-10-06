/**
 * read-path-collapse — read 工具调用标题行的路径压缩：**永远一行**，超宽时用 `…` 前缀
 * 表示被省略的前缀，把**文件名尾部**显示完整。
 *
 * 要解决的问题：pi 内置 read 的标题行是 `read <路径>:<行号>`，路径由 pi-tui 的
 * `Text`（`wrapTextWithAnsi`）折行 —— 那是**贪心词折行**，装不进当前行剩余空间的词会被
 * **整块挑到下一行**再去断。长路径是一整个「词」（中间没有空格），于是实测 79 列终端上
 *
 *     read
 *     ~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:62-116
 *
 * 会渲成 `read` 单独一行（首行只有 4 列、行尾白白空着七十多列）+ 路径从中间断成两截。
 * 和 `bash-command-collapse.ts` 里 `$ cp <78 列路径>` 那个「提前折行」是同一个根因，
 * 只是 bash 那边选择 break-all 硬折行（命令正文要尽量完整可见），这里选择**压缩到一行**：
 * 路径的信息量集中在**尾部**（文件名 + 最后几级目录），前面的 `~/.pi/agent/npm/...`
 * 那串前缀谁都知道，宁可省掉前缀也不要占两行。
 *
 * ## 结果形态
 *
 *     Read …@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:62-116
 *
 * - `Read ` 前缀（`toolTitle` 色 + 粗体）与 `:62-116` 行号区间（`warning` 色）原样保留；
 * - 路径用 `text` 色（与 `tool-diff.ts` 的 `Edit <path>` 同一约定），**不是 pi 内置的
 *   `accent`**：pi 的 `renderToolPath()` 给路径上的是 `accent`，而标题行是「动词 + 路径」
 *   并排 —— 只要皮肤的 `accent` 与 `toolTitle` 取同一个调色板色（pi-coder-catppuccin 的 mauve），
 *   两段就完全同色、看不出层次。所以**装得下的短路径也换色**（见 `recolorToolPath`）；
 * - 路径从**尾部**往前装：一级一级目录往左加，装到恰好放不下为止，前面补一个 `…`；
 * - 装得下时（短路径）**结构完全不动 pi 的原始渲染**（只把路径颜色从 `accent` 换成 `text`），包括
 *   OSC 8 可点击超链接；
 * - 极窄终端下连最后一级目录都装不下时，按 grapheme 从右往左硬截（emoji / 组合字符
 *   不会被切成两半，CJK 按 2 列计）。
 *
 * ## 工具名首字母大写（`Read`）
 *
 * pi 内置 read 渲染器写的是小写 `read`，本扩展显示成 `Read` —— 与 `tool-diff.ts` 的
 * `Edit` / `Write` 同一约定（仿 Claude Code 的工具标题观感），**只改显示形态**：注册名、
 * 路由、session 记录里的原文都不动。三种动词形态（`read <路径>:<行号>` /
 * `read docs <标签>` / `read resource <标签>`）与压缩后自绘的标题都覆盖；`[skill] <目录名>`
 * 形态里没有这个词，原样保留。替换只发生在**动词段**内、且只动**第一行**
 * （`capitalizeReadVerb` / `capitalizeReadTitle`），读一个名字里带 `read` 的文件、或折到行首的
 * `read ` 片段都不会被误改。`PI_READ_COLLAPSE=off` 只关长路径压缩，工具名照样大写。
 *
 * ## 整块的壳：`renderShell: "self"` + 自绘左边距 + 状态圆点（用户 2026-09-21 定）
 *
 * read 块与 `bash-command-collapse.ts` 的 bash 块**同一套观感**（那边是本节的原型）：
 *
 *   - `renderShell: "self"` —— 让 pi 不再给整块套 `contentBox`，于是
 *     ① **没有底色**（pending 的 `toolPendingBg` / 成功的 `toolSuccessBg` / 失败的
 *     `toolErrorBg` 三种底都不画；是"不去画"而不是"画上再擦"，与 bash 侧同一手法），
 *     ② **没有上下两条边界空行**（默认壳是 `Box(1, 1)`，上/下各一行空行就是它画的）。
 *     只有 read 这样改，其他工具照旧走 pi 的默认壳（有底色、有边界空行）。
 *   - 左边距整体 **1 → 2 列**：首行是状态圆点 `•` + 一个空格，其余行两格空格（`withHeadBar`）。
 *     于是圆点在列 0、`Read` 的 `R` 在列 2、结果正文也在列 2 —— 比改动前各多让出一列。
 *   - 圆点颜色按状态走：**读的时候（pending / partial）`dim` 灰、成功 `toolDiffAdded` 绿、
 *     失败 `toolDiffRemoved` 红**（与 bash 侧 `stateBarAnsi` 同一份语义）。
 *
 * 实现方式：`renderCall` / `renderResult` 各自把 pi 的渲染结果包进壳里 —— 一个**不带 bgFn** 的
 * `Box(0, 0)`，左边缘由孩子自己画（`withHeadBar`）。三个不能想当然的点：
 *   ① **左边距挂在标题那个组件的第一行上**（首行圆点 `• `、其余行两格空格），结果正文往下
 *      继续用两格缩进 —— 与 bash 的「命令 + 结果」是同一棵树的结构。
 *   ② 宽度：`Box` 的 `paddingX` 是 0，孩子拿到整宽 —— 所以壳内部按
 *      `width - MARGIN_WIDTH - RIGHT_PAD` 渲染（左边距 + 末尾那列留白），否则挂上前缀必超宽。
 *   ③ **「读的时候」判的是 `context.isPartial === true`**（`tool_execution_start` 之后、结果
 *      回来之前 pi 给的就是 partial），`isError` 必须从 `context` 读 —— pi 调 resultRenderer 时
 *      传的是 `{ content, details }`，**没有 `isError` 字段**（bash 侧踩过同一个坑）。
 *
 * ## 只在需要压缩时才接管渲染（不重写整个 renderCall）
 *
 * 做法是**后处理** pi 渲好的组件：先委托内置 `readRenderers.renderCall` 拿到那个 `Text`，
 * 在 `render(width)` 里渲染它；**≤ 1 行就原样返回**（pi 的配色、`~` 缩写、OSC 8 超链接、
 * `[skill]` / `read docs` / `read resource` 紧凑形态、`(ctrl+o to expand)` 提示全部保留），
 * **> 1 行才自己重建一行压缩标题**。这样短路径（绝大多数 read）走的还是 pi 的原生渲染，
 * 本扩展不引入任何行为差异；只有真正超宽的那部分才换成压缩形态。
 *
 * 两个必须注意的坑：
 *   1. **`lastComponent` 必须传内层 `Text`，不能传我们自己的 wrapper** —— 内置 read.js 是
 *      `context.lastComponent ?? new Text("", 0, 0)` 然后 `setText()`；pi 会把上一次
 *      renderCall 的返回值（我们的 wrapper）当 lastComponent 传回来，wrapper 没有 setText，
 *      于是 renderCall 抛异常，而 `updateDisplay()` 的 try/catch 会**静默退回**
 *      `createCallFallback()` —— 标题只剩一个光秃秃的 `read`，路径全丢。所以内层组件存在
 *      `context.state.innerText` 里跨次复用（与 `bash-command-collapse.ts` 的
 *      `state.innerComponent` 同一套做法）。
 *   2. **OSC 8 超链接的开关不能读我们自己那份 pi-tui 的 `getCapabilities()`** —— 扩展
 *      import 到的 pi-tui 是 loader alias 指向的 npm/dist 副本，pi 运行时（bundle）调的
 *      `setCapabilityOverrides(settings)` 只改 bundle 那份的缓存，副本按环境变量自己检测，
 *      两边可能不一致（终端不支持 OSC 8 时副本却判 true → 链接文本被吞）。所以改成
 *      **从 pi 渲出来的标题里探测**：pi 的标题串里出现 `\x1b]8;;` 就说明它启用了超链接，
 *      我们再用 pi-tui 的 `hyperlink()`（纯字符串拼接函数，不查能力）复刻同一个 URL。
 *
 * ## 紧凑形态（`[skill]` / `read docs` / `read resource`）
 *
 * pi 对 SKILL.md、pi 自己的 README/docs/examples、AGENTS.md/CLAUDE.md 这几类文件不显示
 * 完整路径，而是显示 `[skill] <目录名>` / `read docs <相对标签>` / `read resource <相对路径>`
 * （`getCompactReadClassification`，模块私有）。这些标签通常很短，但 `read resource` 的
 * 标签是**相对 cwd 的路径**，一样可能超宽。所以压缩分支把这三种形态一并复刻
 * （`getReadmePath()` 是包根导出的，docs 判定与 pi 同源），压缩的只是标签本身，前缀与
 * `(ctrl+o to expand)` 提示保留。
 *
 * 提示行里的键名**绝不能 import pi 的 `keyHint` / `keyText`**：实测 `keyHint` 抛
 * `Theme not initialized`（读的是 npm/dist 副本自己的 theme 单例，pi 只初始化了 bundle 那份）、
 * `keyText` 返回空串（副本的 keybindings 表是空的），而 renderCall 抛异常会被 pi 静默 catch
 * 退回 fallback。所以从 `~/.pi/agent/keybindings.json` 读 `app.tools.expand`，读不到用默认
 * `ctrl+o`（与 `bash-command-collapse.ts` 的 `expandKeyText()` 同一套做法）。
 * 终端窄到给标签留不出 `MIN_LABEL_WIDTH` 列时，先丢掉提示行再算一遍预算 —— 提示是说明性的，
 * 文件名更重要。
 *
 * ## 展开态（ctrl+o）
 *
 * `context.expanded` 为 true 时 pi 不做紧凑形态判定（一律走完整路径），本扩展同样只在
 * 超宽时压缩，规则完全一致 —— 折叠态与展开态的折行规则必须一致，否则展开态又会提前折行。
 * 注意展开态**不影响文件内容**的显示（那是 renderResult 的事，本扩展不碰 renderResult）。
 *
 * 纯显示层：发给模型的 tool call 参数、session 记录里的原文、read 的执行逻辑完全不变
 * （`execute` / `parameters` / `description` / `promptSnippet` / `promptGuidelines` /
 * `constrainedSampling` 全部由 `{ ...base }` 从 `createReadToolDefinition()` 原样继承）。
 *
 * 用法：
 *   PI_READ_COLLAPSE=off    启动时就关闭长路径压缩（回到 pi 的贪心折行，长路径占两行）
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, getReadmePath } from "@earendil-works/pi-coding-agent";
import { Box, hyperlink, Text, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureRegistered, isLeader, markReadyIfSettled, setLeaderInvalidate, shouldHideWhilePending } from "./explored-group/registry.ts";
import { EMPTY_COMPONENT, createGroupTree } from "./explored-group/render.ts";

/** 省略前缀的标记。1 列宽，`visibleWidth` 量出来就是 1。 */
const ELLIPSIS = "…";
/** 紧凑形态下给标签留的最少列数，低于它就丢掉 `(ctrl+o to expand)` 提示再算一遍预算。 */
const MIN_LABEL_WIDTH = 12;
/** pi 判定为「紧凑形态」的资源文件名（照抄 read.js 的 COMPACT_RESOURCE_FILE_NAMES）。 */
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/** grapheme 分段器（pi-tui 没导出它自己的实例，本地建一个；Node 内置 Intl.Segmenter）。 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，否则 `~/.pi/agent`）。 */
function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	return envDir ? (envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir) : join(homedir(), ".pi", "agent");
}

/**
 * `app.tools.expand` 的键名文本（默认 `ctrl+o`）。
 *
 * 不能用 pi 导出的 `keyText` / `keyHint`，理由见文件头「紧凑形态」一节。
 */
function expandKeyText(): string {
	try {
		const parsed = JSON.parse(readFileSync(join(resolveAgentDir(), "keybindings.json"), "utf8"));
		const bound = parsed?.["app.tools.expand"];
		const keys = Array.isArray(bound) ? bound : [bound];
		const text = keys.filter((k: unknown): k is string => typeof k === "string" && k.trim() !== "").join("/");
		if (text) return text;
	} catch {
		// 没配置文件 / 解析失败 / 没绑这个键，都用默认值
	}
	return "ctrl+o";
}

/** pi 的 `str()`：string 原样，null/undefined → ""，其它类型 → null（= invalid arg）。 */
function strArg(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

/** pi 的 `shortenPath()`：`$HOME` 前缀换成 `~`（注意 pi 用的是裸 startsWith，不要求分隔符）。 */
function shortenPath(path: string): string {
	const home = homedir();
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

/**
 * 复刻 `resolveToCwd()` 里我们用得上的那部分：剥 `@` 前缀、展开 `~`、相对 cwd 解析。
 * pi 还会归一 Unicode 空格（macOS 截图文件名那些窄不换行空格），这里跳过 ——
 * 它只影响文件名里带特殊空格的路径，且我们只用它来算 OSC 8 的 URL 与紧凑形态判定。
 */
function resolveAgainstCwd(rawPath: string, cwd: string): string {
	let normalized = rawPath;
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
	return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized);
}

/**
 * pi 的 `resolvePath(input, baseDir)`（`utils/paths.js`）—— **参数序与 node 的 `resolve` 相反**。
 *
 * 本文件把 node 的 `resolve` 别名成了 `resolvePath`（为了照抄 pi 的源码形状），于是
 * `resolvePath(filePath, cwd)` 看着像 pi 的那一行，实际是 node 的「base 在前」语义：
 * `filePath` 是绝对路径时 node 直接返回 `cwd`，文件本身被丢掉。后果是
 * `relative(cwd, cwd)` = `""` → `inside` 判定通过 → 标签退化成 `"."`，cwd **之外**的资源文件
 * （`~/.pi/agent/AGENTS.md`）在超宽压缩分支里被渲成 `Read resource .:67-80`（实测复现）。
 * cwd 之内的文件碰巧正确，所以这个坑只在读全局 AGENTS.md 时露出来。
 *
 * 复刻 pi 的函数就复刻它的签名，别复刻它的名字。
 */
function resolveLikePi(input: string, baseDir: string): string {
	return isAbsolute(input) ? resolvePath(input) : resolvePath(baseDir, input);
}

/** pi 的 `getCwdRelativePath()`：cwd 内返回相对路径，否则 undefined。 */
function cwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolved = resolveLikePi(filePath, resolvedCwd);
	const rel = relative(resolvedCwd, resolved);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	return inside ? rel || "." : undefined;
}

/** pi 的 `formatPathRelativeToCwdOrAbsolute()`：cwd 内给相对路径，否则绝对路径，一律 posix 分隔符。 */
function pathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolveLikePi(filePath, cwd);
	return (cwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

/** pi 的 `getPiDocsClassification()`：pi 包内的 README.md / docs/** / examples/**。 */
function piDocsLabel(absolutePath: string): string | undefined {
	try {
		const packageRoot = dirname(getReadmePath());
		const rel = relative(resolvePath(packageRoot), resolvePath(absolutePath));
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
		const label = rel.split(sep).join("/");
		if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) return label;
	} catch {
		// getReadmePath() 抛了就放弃 docs 判定（回落到完整路径形态）
	}
	return undefined;
}

interface CompactClassification {
	kind: "skill" | "docs" | "resource";
	label: string;
}

/** 复刻 pi 的 `getCompactReadClassification()`（模块私有，只能照抄）。 */
function getCompactClassification(args: any, cwd: string): CompactClassification | undefined {
	const rawPath = strArg(args?.path);
	if (!rawPath) return undefined;
	const absolutePath = resolveAgainstCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	const docsLabel = piDocsLabel(absolutePath);
	if (docsLabel) return { kind: "docs", label: docsLabel };
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) return { kind: "resource", label: pathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	return undefined;
}

/** pi 的 `formatReadLineRange()`：`:62-116`（warning 色），offset/limit 都没给就返回 ""。 */
function formatReadLineRange(args: any, theme: any): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

/**
 * 按 grapheme 从**右**往左取，取到装满预算为止。
 * 用于极窄终端下连最后一级目录都装不下的兜底 —— 按列硬切会把 emoji / 组合字符切成两半，
 * 宽字符（CJK 等，2 列）装不进剩下的 1 列时就在它前面停（留 1 列空白），一个 grapheme 不可分。
 */
function tailGraphemes(text: string, budget: number): string {
	if (budget <= 0) return "";
	let out = "";
	let used = 0;
	for (const { segment } of [...graphemeSegmenter.segment(text)].reverse()) {
		const w = visibleWidth(segment);
		if (used + w > budget) break;
		out = segment + out;
		used += w;
	}
	return out;
}

/**
 * 路径压缩：装得下就原样返回；装不下就从**尾部**往前一级一级加目录，前面补 `…`。
 *
 * 刻意保留尽量多的尾部层级而不是只留文件名：同样的列预算，
 * `…core/extensions/loader.js` 比 `…loader.js` 更能说明读的是哪个文件（同名文件很常见）。
 */
function compressTail(text: string, budget: number): string {
	const width = Math.max(1, Math.floor(budget));
	if (visibleWidth(text) <= width) return text;
	const ellipsisWidth = visibleWidth(ELLIPSIS);
	// macOS / Linux 是 `/`；Windows 的 `~C:\...` 也照办（pi 的 shortenPath 不改分隔符）
	const separator = text.includes("/") ? "/" : "\\";
	const segments = text.split(separator);
	let tail = "";
	for (let i = segments.length - 1; i >= 0; i--) {
		const candidate = tail ? `${segments[i]}${separator}${tail}` : segments[i];
		if (visibleWidth(candidate) + ellipsisWidth > width) break;
		tail = candidate;
	}
	if (!tail) {
		// 连最后一级目录都装不下：按 grapheme 从右往左硬截
		return ELLIPSIS + tailGraphemes(segments[segments.length - 1] ?? "", width - ellipsisWidth);
	}
	return ELLIPSIS + tail;
}

/**
 * 探测 pi 有没有启用 OSC 8 超链接：看它渲出来的标题串里有没有 `\x1b]8;;`。
 * 理由见文件头 —— 不能读副本自己的 `getCapabilities()`。
 * `inner.text` 是 `Text` 的私有字段（TS 层面 private，运行时可读）；拿不到就退回渲染行。
 */
function piTitleUsesHyperlink(inner: any, lines: string[]): boolean {
	const raw = typeof inner?.text === "string" ? inner.text : lines.join("\n");
	return raw.includes("\x1b]8;;");
}

/**
 * 前景色重置序列 —— `theme.fg()` 的每个色段都以它收尾，所以行内第一个它标着**动词段的结束**。
 */
const FG_RESET = "\x1b[39m";

/** SGR 序列（`theme.fg()` / `theme.bold()` 发出的那些），只用于量可见文本。 */
const SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

/**
 * 把标题行里的动词 `read` 换成大写的 `Read`（详见文件头「工具名首字母大写」一节）。
 *
 * 只在**动词段**（行首到第一个 `\x1b[39m`，与 `recolorToolPath` 同一套定位）里动手，并在
 * 剥掉 SGR 后要求这段可见文本恰好是 `read` 或以 `read ` 开头：
 *   - `read <路径>` / `read docs <标签>` / `read resource <标签>` 命中；
 *   - `[skill] <目录名>` 的动词段是 `[skill]`，不含这个词，原样返回；
 *   - 颜色被关掉（没有 ANSI）时动词段退化成整行，同一条件仍能把 `readme.md` 这类
 *     以 `read` 开头却没有空格的续行排除在外；命中时行内第一个 `read` 必然是动词本身。
 */
function capitalizeReadVerb(line: string): string {
	const verbEnd = line.indexOf(FG_RESET);
	const head = verbEnd === -1 ? line : line.slice(0, verbEnd);
	const visible = head.replace(SGR_SEQUENCE, "");
	if (visible !== "read" && !visible.startsWith("read ")) return line;
	const at = head.indexOf("read");
	return head.slice(0, at) + "Read" + line.slice(at + "read".length);
}

/**
 * 标题行数组的入口：**只动第一行**。动词只可能出现在第一行；续行全是路径 / 标签，
 * 那里以 `read ` 开头的片段（带空格的目录名 / 文件名被折到行首）不能被误改成大写。
 */
function capitalizeReadTitle(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const [first, ...rest] = lines;
	return [capitalizeReadVerb(first), ...rest];
}

/**
 * 把 pi 渲染出来的标题行里的**路径**颜色从 `accent` 换成 `text`。
 *
 * 为什么是**替换 SGR** 而不是自己重建整行：这一支（装得下的短路径）刻意保留 pi 的原生
 * 渲染 —— 折行、OSC 8 超链接、`[skill]` / `read docs` / `read resource` 紧凑形态、
 * `(ctrl+o to expand)` 提示全都由 pi 自己决定，本扩展只改一个颜色。pi 的 read 标题里
 * `accent` 只用在路径上（`renderToolPath()`）或紧凑形态的标签上（`formatCompactReadCall`
 * 的 docs / resource 分支），`skill` 形态的标签走 `customMessageText`，不受影响。
 *
 * **只换动词之后那一段**：动词（`read`）是整行的第一个色段，第一个 `\x1b[39m` 就是它的
 * 结尾；后面的 `accent` 才是路径。这一步不是耍小聪明 —— 皮肤把 `accent` 与 `toolTitle` 设成
 * 同一个调色板色时（上游 catppuccin 的 mauve 就是）整行直接替换会把动词一起换成 `text`，
 * 两段仍旧同色，正好就是本扩展要消掉的那个症状。
 *
 * 两个色相同时（皮肤把 `accent` 和 `text` 设成同一个色）直接原样返回，不做无谓改写 ——
 * `getFgAnsi` 拿到的就是 pi 自己会发的那个序列（truecolor / 256 色两种模式都对得上）。
 */
function recolorToolPath(line: string, theme: any): string {
	const accent = theme.getFgAnsi("accent");
	const text = theme.getFgAnsi("text");
	if (!accent || accent === text) return line;
	const verbEnd = line.indexOf(FG_RESET);
	if (verbEnd === -1) return line.split(accent).join(text);
	const cut = verbEnd + FG_RESET.length;
	return line.slice(0, cut) + line.slice(cut).split(accent).join(text);
}

/** 压缩后的完整路径形态：`read …<尾部路径>:<行号>`。 */
function compressedPathTitle(args: any, theme: any, cwd: string, budget: number, hyperlinksEnabled: boolean): string {
	const prefix = `${theme.fg("toolTitle", theme.bold("Read"))} `;
	const range = formatReadLineRange(args, theme);
	const rawPath = strArg(args?.path);
	// 与 pi 的 renderToolPath 对齐：null → `[invalid arg]`，空串 → `...`（toolOutput 色）
	if (rawPath === null) return `${prefix}${theme.fg("error", "[invalid arg]")}${range}`;
	if (!rawPath) return `${prefix}${theme.fg("toolOutput", "...")}${range}`;
	const styled = theme.fg("text", compressTail(shortenPath(rawPath), budget - visibleWidth(prefix) - visibleWidth(range)));
	const display = hyperlinksEnabled ? hyperlink(styled, pathToFileURL(resolveAgainstCwd(rawPath, cwd)).href) : styled;
	return prefix + display + range;
}

/** 压缩后的紧凑形态：`[skill] …<标签>` / `read docs …<标签>` / `read resource …<标签>`。 */
function compressedCompactTitle(
	classification: CompactClassification,
	args: any,
	theme: any,
	budget: number,
	hyperlinksEnabled: boolean,
	cwd: string,
): string {
	const range = formatReadLineRange(args, theme);
	const hint = theme.fg("dim", ` (${expandKeyText()} to expand)`);
	const isSkill = classification.kind === "skill";
	const prefix = isSkill
		? theme.fg("customMessageLabel", "\x1b[1m[skill]\x1b[22m ")
		: `${theme.fg("toolTitle", theme.bold(`Read ${classification.kind}`))} `;
	// 先带提示算预算；窄到给标签留不出 MIN_LABEL_WIDTH 列就丢掉提示再算一遍
	let suffix = hint;
	let labelBudget = budget - visibleWidth(prefix) - visibleWidth(range) - visibleWidth(hint);
	if (labelBudget < MIN_LABEL_WIDTH) {
		suffix = "";
		labelBudget = budget - visibleWidth(prefix) - visibleWidth(range);
	}
	const styled = theme.fg(isSkill ? "customMessageText" : "text", compressTail(classification.label, labelBudget));
	// docs / resource 的标签是包内路径，同样给超链接（skill 的标签是目录名，不是路径，不给）
	const display =
		hyperlinksEnabled && !isSkill
			? hyperlink(styled, pathToFileURL(resolveAgainstCwd(classification.label, cwd)).href)
			: styled;
	return prefix + display + range + suffix;
}

/**
 * 左边距总列数：**圆点 / 空格那一列 + 一格间距**（用户 2026-09-21 定：正文整体右移一格）。
 *
 * 首行是 `•` + 空格，其余行是两个空格；正文（标题与结果）都跟在它后面。与
 * `bash-command-collapse.ts` 的 `INDENT_WIDTH`（gutter 之外多让出的那一列）是同一个观感：
 * 两块左边缘对齐。**改这里必须同时改 bash 那边**，否则两个工具的块会错开一列。
 */
const MARGIN_WIDTH = 2;
/**
 * 正文右侧留白列数 —— 与 bash 块同一条约定：正文不顶着终端右边缘，末尾留 1 列。
 * 所以孩子的正文预算是 `width - MARGIN_WIDTH - RIGHT_PAD`，挂上左边距后仍差 1 列到底。
 */
const RIGHT_PAD = 1;
/** 非首行的左边距（全空格）。 */
const MARGIN_BLANK = " ".repeat(MARGIN_WIDTH);

/**
 * 状态圆点 `•`（U+2022，1 列宽）+ 前景复位。
 *
 * 三个槽 pi 的 theme schema 都必需（`dim` / `toolDiffAdded` / `toolDiffRemoved`），取的是
 * **前景** ANSI；末尾那个 `\x1b[39m` 保证颜色不会洇到后面的 `Read` 上 —— 与
 * `bash-command-collapse.ts` 的 `stateBarAnsi` 完全同源（字形也一样是 `•`）。
 *
 * 「读的时候」= pending：`tool_execution_start` 之后、结果还没回来（pi 给的 partial 状态）。
 */
function stateBarAnsi(theme: any, isPartial: boolean, isError: boolean): string {
	const slot: ThemeColor = isPartial ? "dim" : isError ? "toolDiffRemoved" : "toolDiffAdded";
	return `${theme.getFgAnsi(slot)}\u2022\u001b[39m`;
}

/**
 * 给**首行**挂 `• `、其余行补两格空格 —— 与 `bash-command-collapse.ts` 的 `withHeadBar`
 * 同一套（那边画在命令的首行上，这里画在 `Read <路径>` 那一行上）。
 */
function withHeadBar(lines: string[], bar: string): string[] {
	return lines.map((line, index) => (index === 0 ? `${bar} ${line}` : MARGIN_BLANK + line));
}

/**
 * 结果正文的每一行补两格左边距 —— 与标题行同一个左边距，于是 `Read <路径>` 里的路径列与
 * 结果正文的列对齐。
 *
 * **前导空行一并剥掉**（`stripLeadingBlanks`）：pi 的 read 结果正文是
 * `new Text("\n" + …)` 那段，那个 `\n` 会在标题与正文之间画出一整行空行。bash 侧同一个
 * 前导空行是刻意剥掉的（那边不做就会变成三条空行），这里保持一致 —— 整块是「标题 + 紧贴的
 * 正文」，没有上下边界空行，中间也不掺空行（用户 2026-09-21 定的观感）。
 */
function withBodyIndent(lines: string[]): string[] {
	const out = lines.slice();
	while (out.length > 0 && out[0]!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") out.shift();
	return out.map((line) => (line === "" ? line : MARGIN_BLANK + line));
}

/**
 * 把那块（标题 / 结果）包进**不带底色**的 `Box(0, 0)`。
 *
 * `Box` 只负责「整宽铺满 + 左右两列的右边界留白」，底色与上下空行都不给 —— 这就是用户要的
 * 「read 块没有底色、没有上下边界空行」（见文件头「整块的壳」）。孩子自己画左边缘（2 列），
 * 所以调用方传进来的 `render` 必须按 `width - 2` 渲染。
 */
function shellFor(render: (width: number) => string[]) {
	const box = new Box(0, 0);
	box.addChild({
		render(width: number): string[] {
			return render(Math.max(1, width - MARGIN_WIDTH - RIGHT_PAD));
		},
		invalidate() {},
	});
	return box;
}

/**
 * 包一层组件：pi 渲出来 ≤ 1 行就原样返回，> 1 行才换成压缩标题。
 * 压缩结果按宽度缓存 —— `render(width)` 每帧都调，终端 resize 时自动重算。
 */
function createCollapsedCallComponent(
	inner: any,
	options: {
		args: any;
		theme: any;
		cwd: string;
		expanded: boolean;
		isEnabled: () => boolean;
		/** 命令还在跑（`tool_execution_start` 之后、结果回来之前）→ 圆点用 `dim`。 */
		isPartial: boolean;
		/** 这块结果是错的（`context.isError`）→ 圆点用 `toolDiffRemoved`。 */
		isError: boolean;
	},
) {
	// 缓存只存**未上左边距/未上色**的正文行，左边距（含颜色）每次 render 现拼 ——
	// 缓存键里再带一个状态会容易忘记失效，而拼两格前缀的开销可以忽略。
	const cache = new Map<number, string[]>();
	// 左边距那两列由盒子的孩子自己画（`Box(0, 0)` 不扣），所以这里的 width 已经是
	// 「扣掉左边距 + 一列右边界」之后的正文预算（见 `shellFor`）。
	return {
		render(width: number): string[] {
			const lines: string[] = inner.render(width);
			const body = (out: string[]) => withHeadBar(out, stateBarAnsi(options.theme, options.isPartial, options.isError));
			// 关闭开关 → 回到 pi 的原生渲染（含路径颜色，见 `PI_READ_COLLAPSE=off`）；工具名照旧大写
			if (!options.isEnabled()) return body(capitalizeReadTitle(lines));
			// 没超宽（短路径，绝大多数 read）→ 只把路径的颜色换成 `text`，其余原样交给 pi
			if (lines.length <= 1) return body(capitalizeReadTitle(lines.map((line) => recolorToolPath(line, options.theme))));
			const fixedWidth = visibleWidth(`${options.theme.fg("toolTitle", options.theme.bold("Read"))} `) + visibleWidth(ELLIPSIS);
			if (width - fixedWidth < 1) return body(capitalizeReadTitle(lines));
			const hit = cache.get(width);
			if (hit) return body(hit);
			const hyperlinksEnabled = piTitleUsesHyperlink(inner, lines);
			const classification = options.expanded ? undefined : getCompactClassification(options.args, options.cwd);
			const line = classification
				? compressedCompactTitle(classification, options.args, options.theme, width, hyperlinksEnabled, options.cwd)
				: compressedPathTitle(options.args, options.theme, options.cwd, width, hyperlinksEnabled);
			// 极窄终端兜底：固定部分（前缀 + 行号区间，或紧凑形态的提示行）本身就比整行还宽时，
			// 压缩后的标题仍然会超宽 —— 那时 pi 自己的折行渲染同样难看，没有更好的选择，直接交回去。
			if (visibleWidth(line) > width) return body(capitalizeReadTitle(lines));
			// 缓存的是**未挂左边距**的正文行，左边距（含状态色）在 `body` 里现拼
			cache.set(width, [line]);
			return body([line]);
		},
		invalidate() {
			cache.clear();
			inner.invalidate?.();
		},
	};
}

export default function (pi: ExtensionAPI) {
	const enabled = process.env.PI_READ_COLLAPSE?.trim().toLowerCase() !== "off";

	// cwd 只是兜底：内置 execute 用的是 ctx.cwd（每次调用的当前 session cwd），
	// renderCall 也用 context.cwd，不读这里这个值。
	const base = createReadToolDefinition(process.cwd());

	pi.registerTool({
		// 用展开而不是逐字段抄：`description` / `parameters` / `promptSnippet` /
		// `promptGuidelines` / `constrainedSampling` / `execute` 全部原样继承
		// （prompt 元数据不会自动继承，必须显式带上）。
		...base,
		// `renderShell: "self"`：让 pi 不再套 `contentBox` —— 于是 read 块**没有底色**、
		// 也没有默认壳那两条上下边界空行（见文件头「整块的壳」）。自己的左边距自己画
		// （`withHeadBar`），与 bash 块同一套观感。**只影响 read**：其他工具仍走 pi 的默认壳。
		renderShell: "self",
		renderCall(args, theme, context) {
			// 参数还在流（pi 构造时把 path 播种为 `{}` 或 `""`）：**一行都不画**。
			// 不遮的话这一帧会走下面的内置渲染，先冒出 `• Read ...`（灰 `...`），
			// args 齐了再跳成 `• Explored / └ Read …` —— 用户 2026-10-06 报的正是这个闪烁。
			// `SKILL.md`（确实不可折叠）不受影响：它不 pending，走下面内置渲染拿到 `[skill]` 形态。
			if (shouldHideWhilePending("read", args, context.isPartial === true)) return EMPTY_COMPONENT;
			// 渲染时开闸兜底（主信号是 `message_end` / `tool_execution_end`，见 `markReadyIfSettled`）。
			markReadyIfSettled(context.toolCallId, context.argsComplete === true, context.isPartial === true);
			// 「只读探查」分组（explored-group）：read 是可折叠成员（永远），连续 read 会被
			// 合并到一行 `└ Read a, b`。组长画树，其余成员投 0 行 —— 与 bash 侧同一手法，
			// 判定/断组规则见 `explored-group/`。
			const group = ensureRegistered(context.toolCallId, "read", args);
			if (group) {
				if (!isLeader(context.toolCallId)) return EMPTY_COMPONENT;
				setLeaderInvalidate(context.toolCallId, () => context.invalidate());
				return createGroupTree({
					groupId: context.toolCallId,
					theme,
					cwd: context.cwd,
					expanded: context.expanded === true,
				});
			}
			const state = context.state;
			// 关键：传给内置实现的 lastComponent 必须是**内层** Text 而不是我们的 wrapper，
			// 否则内置 `setText()` 抛异常、pi 静默退回只剩 `read` 的 fallback（见文件头）。
			const inner = base.renderCall?.(args, theme, { ...context, lastComponent: state.innerText }) ?? new Text("", 0, 0);
			state.innerText = inner;
			return shellFor(
				(logicalWidth) =>
					createCollapsedCallComponent(inner, {
						args,
						theme,
						cwd: context.cwd,
						expanded: context.expanded,
						isEnabled: () => enabled,
						// 「读的时候」= partial（`tool_execution_start` 之后、结果回来之前）
						isPartial: context.isPartial === true,
						isError: context.isError === true,
					}).render(logicalWidth),
			);
		},
		// 结果侧同样进这个壳：``\n` + 正文` 的每一行补两格缩进，于是它与标题行的左边距一致；
		// 底色 / 上下边界空行同样没有。`context.lastComponent` 也要传**内层** Text（同一处坑）。
		renderResult(result, options, theme, context) {
			// 折叠态下**整组（含组长）都不画输出**，与 bash 侧同一条规则（见那边的注释）。
			// 展开态放行，让各成员各自展开内容。
			if (!context.expanded && ensureRegistered(context.toolCallId, "read", context.args)) {
				return EMPTY_COMPONENT;
			}
			const state = context.state;
			const inner =
				base.renderResult?.(result, options, theme, { ...context, lastComponent: state.innerResultText }) ??
				new Text("", 0, 0);
			state.innerResultText = inner;
			return shellFor((logicalWidth) => withBodyIndent(inner.render(logicalWidth)));
		},
	});
}
