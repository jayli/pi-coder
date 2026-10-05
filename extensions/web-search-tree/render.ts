/**
 * web-search-tree — 纯逻辑：把 pi-web-access 的 `pi_web_search` 渲染器产出的**行数组**重排成
 * 与 `bash-command-collapse.ts` / `codemode-tree/` 同一套的树。
 *
 * 本模块不 import pi、不碰 pi-tui，所以 `node --test` 能直跑（与 `codemode-tree/render.ts`、
 * `fenceless-code-block/render.ts` 同一条路子）。着色只用注入进来的 `theme.fg`。
 *
 * ## 目标形状（用户 2026-10-02 定）
 *
 * ```
 * • search 3 queries
 *   │ "wechat-local-mcp 微信 重新签名 codesign 本地数据库 密钥 原理"
 *   │ "macOS WeChat local database decrypt re-sign app get-task-allow
 *   │  extract SQLCipher key from memory"
 *   │ "PyWxDump macOS 微信 数据库 密钥 获取 需要 重新签名 原因"
 *   │ 3/3 queries, 18 sources
 *   │ Providers used: Query 1: exa; Query 2: exa; Query 3: exa
 *   │
 *   └ ... (4 more lines, 6 total, ctrl+o to expand)
 * ```
 *
 * ## 与 bash / codemode 块的**一处刻意不同**：`└ ` 挂在最后一行
 *
 * bash / codemode 的规则是「`└ ` 挂在第一个实质内容行上，树在那里落地」。本工具不适用这条，
 * 因为搜索块的**末行**（`... (N more lines, M total, ctrl+o to expand)`）是**唯一**通向完整结果
 * 的入口 —— 结果正文里那些 sources / 摘要全在 ctrl+o 后面。把 `└ ` 挂在第一行、让提示行跟在
 * 后面缩进，观感上像「树已经结束，下面这些是尾巴」；而用户给的样例里 `└ ` 就在提示行上。
 *
 * 所以本工具的规则是**末行挂 `└ `、上面每一行挂 `│ `** —— 树一直延伸到「还有内容可以展开」
 * 那句话，与 `background-tasks` 的正文树（除末行外 `│`、末行 `└`）同构。折叠态下末行必然是
 * ctrl+o 提示，展开态下末行是最后一条正文，两种情况都成立。
 *
 * ## 本扩展真正改掉的东西（实测对照，2026-10-02）
 *
 * ```
 * 包原版（有底色、上下各一空行、无树）：        接管后：
 *   空行                                          ── self 壳：无空行
 *   search 3 queries                            • search 3 queries
 *     "…第一条长查询…"                            │   "…第一条长查询…"
 *     "…第二条被折行…"                            │   "…第二条被折行…"
 * from memory                                    │ key from memory
 *                                                  │
 *  ... (12 more lines, 16 total, ctrl+o …)        └ ... (12 more lines, 16 total, ctrl+o …)
 *   空行
 * ```
 *
 * 四件事：① 无底色、无上下空行；② 圆点结局灯（绿 / 红）；③ 树形结构符；
 * ④ **折行的续行也挂在 `│ ` 后面**（包原版在渲染层不挂前缀，续行会掉到列 0，
 * 对照输出里 `from memory` 那一行就是）。
 *
 * **查询值截断不是本扩展修的东西**：包原版在 `renderCall`（三维查询名）与折叠态预览里都**不截**
 * 查询值；那两处 `slice(0, 37)` / `slice(0, 52)` 分别在**流式中的 `currentQuery` 行**与
 * **展开态的 curated 清单**里。我一开始把前者当成了「查询名被截到 40 列」，是错的 ——
 * 改完对照实验才看清。所以 README 里不要写「本扩展修了截断」。

/** 圆点那一列：`• ` = 1 个字符 + 1 个空格 = 2 列。 */
export const MARGIN_WIDTH = 2;
/** 结构符占的列数：`│ ` / `└ ` = 1 个 box-drawing 字符 + 1 个空格 = 2 列。 */
export const GUTTER_WIDTH = 2;
/** 子内容要扣掉的列数：左边距 + 结构符（结构符落在列 2、正文落在列 4）。 */
export const CONTENT_OFFSET = MARGIN_WIDTH + GUTTER_WIDTH;

/** 结构符前面的留白（左边距）：两格。`│` / `└` 因此落在列 2。 */
export const GUTTER_LEAD = " ".repeat(MARGIN_WIDTH);
/** `│ ` / `└ ` 之后的正文列：4 格（与 bash / codemode 块同一列）。 */
export const BODY_INDENT = " ".repeat(CONTENT_OFFSET);
/** 「还没出结果」时命令续行的缩进：两格（与 `search` 的 `s` 同列）。 */
export const LOOSE_INDENT = " ".repeat(MARGIN_WIDTH);

/** 子组件（包自带渲染器渲染出来的那一坨）该按多宽渲染。 */
export function contentWidth(totalWidth: number): number {
	return Math.max(1, totalWidth - CONTENT_OFFSET);
}

/** 去掉 SGR 转义序列 —— 行里可能只有颜色序列。 */
function stripSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 这一行（带样式）是不是空的。 */
export function isBlankLine(line: string): boolean {
	return stripSgr(line).trim() === "";
}

/**
 * 圆点该用哪个颜色槽 —— 三态，与 `codemode-tree` / bash 侧同一份语义：
 *
 *   - 执行中（`isPartial`）→ `dim`（灰）—— 与 bash / read 的一致（codemode 那边用 `text` 白，
 *     是用户 2026-10-01 单独特批的；搜索块没批那一格，走 bash 的常规口径）
 *   - 执行完且成功 → `toolDiffAdded`（diff 新增行的绿，**与 bash 成功圆点同色**）
 *   - 执行完且失败 → `toolDiffRemoved`（diff 删除行的红）
 *
 * 判定读 `context.isError`（pi 调 resultRenderer 时不带 `isError` 字段，只在 `getRenderContext`
 * 里给 —— 读 `result.isError` 会永远拿到 undefined，bash 侧踩过这个坑）。
 */
export function stateDotSlot(isPartial: boolean, isError: boolean): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
	if (isPartial) return "dim";
	return isError ? "toolDiffRemoved" : "toolDiffAdded";
}

/**
 * 这一块是不是失败的 —— 三个信号取**或**，因为包自带渲染器在不同失败路径上留的痕迹不同：
 *
 *   ① `context.isError`：pi 的权威信号（工具抛异常 / 返回 `isError: true`）；
 *   ② 正文里的 `Error:` / `Error：` 行：`pi_web_search` 有若干路径是**正常返回**一个
 *      `{ content: [{ text: "Error: …" }], details: { error } }` 的对象（不是 throw），
 *      pi 不会把它标成 isError；
 *   ③ `details.error` 非空：同上的结构化痕迹，`renderResult` 的第一个分支就是它。
 *
 * 只用 ① 会让 ②③ 那些路径显示绿点（用户 2026-10-02 明确要求「不成功就是红色」），只用 ②
 * 又会漏掉抛异常的路径。三条取或之后，`Error:` 开头的正文行还会被 `colorizeErrorLines`
 * 染红，与红点互相印证。
 */
export function isFailureResult(isError: boolean, lines: string[], details: unknown): boolean {
	if (isError) return true;
	const d = details as { error?: unknown } | undefined;
	if (d && typeof d.error === "string" && d.error.trim() !== "") return true;
	return lines.some((line) => /^\s*Error[:：]/.test(stripSgr(line)));
}

/**
 * 正文里的 `Error:` 行染红（`toolDiffRemoved`）。包自带渲染器已经在一些分支里上过 `error` 色，
 * 这里只补它没管的那些（`Error: …` 纯文本行），已经带色的行会被 `stripSgr` 判出来后重新上色 ——
 * 两类红色（`error` / `toolDiffRemoved`）在同一个块里并存会看着发花，统一成本扩展的失败红。
 */
export function colorizeErrorLines(
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	return lines.map((line) => (/^\s*Error[:：]/.test(stripSgr(line)) ? theme.fg("toolDiffRemoved", stripSgr(line)) : line));
}

/**
 * 命令侧：给每一行挂上树形前缀 —— 首行 `• `（圆点由调用方上好色），其余行按 `connected`
 * 选 `│ `（结果已到，树接上了）或两格缩进（还在跑，与 bash 的「执行中」形态一致）。
 *
 * 空行保持空行：给空行补空格会把「这一行是空的」这个信息擦掉，外层判空还得先剔 ANSI 再 trim。
 */
export function withCallGutter(lines: string[], dotAnsi: string, pipe: string, connected: boolean): string[] {
	const continuation = connected ? `${GUTTER_LEAD}${pipe}` : LOOSE_INDENT;
	return lines.map((line, index) => {
		if (index === 0) return `${dotAnsi} ${line}`;
		return line === "" ? "" : `${continuation}${line}`;
	});
}

/**
 * 结果侧：末行 `└ `、其余非空行 `│ `（见文件头「`└ ` 挂在最后一行」）。
 *
 * 三个不能想当然的点：
 *
 *   ① **只由本函数决定 `└ `，整块渲染一次**：调用方必须把所有 child 的行拼成一个数组再传进来
 *      （包自带渲染器把状态行、提示行分成两个 child），逐 child 各画一棵树会长出两个拐角符。
 *   ② **末行是空行时往前找**：展开态的正文可能以空行收尾（包渲染器的 `lines.push("")`），
 *      把 `└ ` 挂到一个空行上等于白挂 —— 找不到任何非空行就整个返回空数组。
 *   ③ **`└ ` 之上的空行挂 `│ `、之下的空行原样**：与 bash 的 `prefixTreeLines` 同一条规则
 *      （那边的原话是「栅栏以上的空行也带 `│ `」）。用户样例里 `Providers used: …` 与
 *      `└ ... (4 more lines…)` 之间正好有一行**只有 `│`** —— 那就是这里画出来的：它本来是
 *      个空行，补上前缀之后就成了那根竖线。空行不加前缀会看着像树断了；`└ ` 之后的空行
 *      再画竖线又像树还没完（bash 侧的同一取舍，用户 2026-09-21 在那边报过一次）。
 */
export function shapeResultLines(
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
): string[] {
	if (lines.length === 0) return [];

	// 从后往前找最后一个非空行 —— 它就是 `└ ` 的落点。
	let last = lines.length - 1;
	while (last >= 0 && isBlankLine(lines[last]!)) last--;
	if (last < 0) return [];

	const pipe = `${GUTTER_LEAD}${theme.fg("muted", "│ ")}`;
	const corner = `${GUTTER_LEAD}${theme.fg("muted", "└ ")}`;

	return lines.map((line, index) => {
		if (index === last) return `${corner}${line}`;
		// `└ ` 之上（还没有落地）→ 空行也补竖线；之下已经没有内容了，原样返回。
		if (index > last) return line;
		if (isBlankLine(line)) return pipe;
		return `${pipe}${line}`;
	});
}

/**
 * 失败块里把包自带的 `success` 绿换成失败红。
 *
 * 包的状态行（`3/3 queries, 18 sources`）是**无条件**用 `theme.fg("success", …)` 画的 —— 它不知道
 * 自己这次是失败的。于是失败块里会出现「红圆点 + 绿状态行」的自相矛盾（实测：抛异常那条路径下
 * 状态行是绿色的 `undefined/undefined queries, 0 sources`，红点就在它上面一行）。用户 2026-10-02
 * 的口径是「不成功就是红色」，所以失败时把这一段的 `success` 前景换成本扩展的失败红。
 *
 * 换的是**整个色段**：`theme.fg("success", x)` 出来的是 `ESC[…m x ESC[39m` —— 开头的设置色要换，
 * 收尾的复位 `ESC[39m` 与其它色段共用（换多了会把后面的 `muted` / `accent` 一起截断）。
 * 所以只在**该色段内部**替换：找到 `success` 序列后，把它到下一个 `ESC[39m` 之间的**开码**换掉。
 * 实测形状：`ESC[38;2;181;189;104m 文本 ESC[39m` —— 一段里只有一个开码，直接换即可。
 *
 * `theme.getFgAnsi` 拿到的就是 pi 自己会发的序列（truecolor / 256 色两种模式都对得上）；
 * 两个色相同时（皮肤把 `success` 与 `toolDiffRemoved` 设成同一值）直接原样返回，不做无谓改写
 * —— 与 `read-path-collapse.ts` 的 `recolorToolPath` 同一套做法。
 */
export function recolorSuccessToFailure(
	lines: string[],
	theme: { getFgAnsi?: (color: string) => string | undefined; fg: (color: string, text: string) => string },
): string[] {
	const success = theme.getFgAnsi?.("success");
	const failure = theme.getFgAnsi?.("toolDiffRemoved");
	if (!success || !failure || success === failure) return lines;
	// 结尾的复位序列与其它色段共用，不能跟着换 —— 只换色段**开头**的那个设置码。
	const reset = "\u001b[39m";
	return lines.map((line) => {
		if (!line.includes(success)) return line;
		let out = "";
		let index = 0;
		while (true) {
			const at = line.indexOf(success, index);
			if (at === -1) {
				out += line.slice(index);
				break;
			}
			const end = line.indexOf(reset, at);
			if (end === -1) {
				// 没有复位：整段到行尾都是这个色，安全地全换。
				out += line.slice(index, at) + failure + line.slice(at + success.length);
				break;
			}
			out += line.slice(index, at) + failure + line.slice(at + success.length, end);
			index = end;
		}
		return out;
	});
}

/**
 * 去掉**尾部**的空行。包自带渲染器在展开态用 `lines.push("")` 收尾（摘要段、curated 段的尾部），
 * 那些空行正是用户 2026-10-02 要除掉的「下面一行空行」。折叠态不受影响 —— 那块以提示行结尾，
 * 提示行非空，尾部 trim 碰不到它。
 *
 * **上面的空行不删**：包渲染器把 `"\n... more lines"` 拆成一个空行 + 提示行，用户样例里
 * `Providers used: …` 与 `└ ...` 之间那根 `│` 就是这个空行挂上前缀变来的（见 `shapeResultLines`）。
 * 删掉它就不是用户要的形状了。
 */
export function trimTrailingBlanks(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && isBlankLine(lines[end - 1]!)) end--;
	return end === lines.length ? lines : lines.slice(0, end);
}
