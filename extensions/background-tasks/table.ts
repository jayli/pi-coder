/**
 * background-tasks/table.ts — `run_in_background` 结果块末尾那张**任务总览表**的纯逻辑层。
 *
 * 不 import pi / pi-tui：宽度度量（`widthOf`，运行时传 pi-tui 的 `visibleWidth`）与上色
 * （调用方按 `role` 映射到主题槽）都从外面注入，所以 `node --test` 能直接断言列宽计算、
 * 命令截断、行数上限与折叠行。与 `status.ts`（dock 行）、`render.ts`（树形形态）同一套
 * 取舍：纯模块定形态，接线模块上色。
 *
 * ## 为什么要有这张表（用户 2026-10-16 定）
 *
 * 块正文只说「已启动 bg_2（pid …）」，说不出**当前还有几个任务在跑、各自跑了多久**。
 * 起第三个任务时用户得自己回想前两个，或者去调 `/background`。
 *
 * ```
 * • run_in_background
 *   │ 已在后台启动 bg_2（pid 69132）。
 *   │ 命令：sleep 2; echo helloworld
 *   └ ┌──────┬────────────────┬─────────┬──────┐
 *     │ id   │ command        │ status  │ time │
 *     ├──────┼────────────────┼─────────┼──────┤
 *     │ bg_1 │ npm test       │ exit 0  │ 2m3s │
 *     │ bg_2 │ sleep 2; echo… │ running │   8s │
 *     └──────┴────────────────┴─────────┴──────┘
 * ```
 *
 * `└ ` 挂在**表格首行**（顶边框）而不是视觉末行 —— 用户 2026-10-16 选的形态：正文树到
 * 表格为止，表作为悬挂在最后一块的子块；表格自己的底边框收尾，所以整块末尾仍然是一个
 * `└──────┴…`，视觉上并不悬空。这使 `render.ts` 的 `bgResultTreePrefixes` 需要「末行
 * 不闭合」那个开关（正文全用 `│ `）。
 *
 * ## 三个已定的决定（用户 2026-10-16）
 *
 *   1. **快照，不是实时视图**：渲染器只读结果 / 通知 `details` 里那份快照，不读注册表。
 *      历史块内容永不改变 —— 否则每次任务状态变化，屏幕上所有同类块会一起重画（一张张
 *      同样内容的表在跳）。实时进度由 statusline 的 dock 行负责。
 *   2. **`run_in_background` 的结果块与终态通知都带**（用户 2026-10-18 定）：报告一个任务
 *      结束的那一眼同时就看清全部任务；`background_output` / `background_kill` 不贴 ——
 *      它们的正文已经点明了是哪个任务，再贴一张表会把增量读的输出推后。
 *   3. **最多 5 行**（`MAX_TABLE_ROWS`），按启动顺序**最旧在上、最新在下**，超出时丢最旧的
 *      并在底边框之前补一行折叠提示。上限是对「这张表每次都要贴一遍」的预算约束：
 *      5 行 + 表头表尾 + 正文 10 行预览，最长的块约 18 行。
 *      折叠提示**就是一行普通表格行**（用户 2026-10-17 定）：`id` 与 `status` / `time` 三列
 *      填 `-`，文案 `…N bg tasks earlier` 落在 `command` 列里，四根竖线一根不少：
 *
 *      ```
 *      │ bg_7 │ cd /… &&…       │ running │    0s │
 *      │  -   │ …2 bg tasks earlier │    -    │   -   │
 *      ```
 *
 *      早先那版是把四列压成一格、塞进整句中文提示（`… 另有 2 个较早的任务（/background 看全部）`），
 *      竖线因此在一行里断掉；改成独立格后表格结构完整，`/background` 这个出口由表格上方的
 *      `/background` 命令与 dock/README 承担，不再挤在格子里。
 *
 * ## 状态词与时长：与 dock 行同源，不新造词汇
 *
 * 状态词复用 `status.ts` 的 `statusWord`（`running` / `exit 0` / `exit=N` / `killed`），
 * 时长复用 `registry.ts` 的 `formatElapsed`（`12m2s`，无空格）。用户草图里的 `done` **没有
 * 采用**：它把退出码吞掉了，而退出码正是只有这张表能一眼给出的信息；同一块界面里两套状态
 * 词也会让 dock 行与表格对不上。
 *
 * ## 配色（用户 2026-10-17 定，三轮；表头底色 2026-10-22 定）
 *
 * **列标题（id / command / status / time）走 `mdCode`**（行内代码色）；**表头四个格子另加粗 +
 * 刷一层 surface 灰底**（见上一节）；**边框走 bash 工具调用的正文输出色**（`bashOutput` →
 * `toolOutput`，即 role `border`，调用方用 `pickBodySlot` 解析后上色）—— 表格挂在正文树尾，
 * 框线与上面那几行输出同一个色；其余无色的格子（时长 / 命令 / 折叠提示）走 `text` 前景色；
 * 本来就有语义色字体的保留原有槽位 —— id `accent`、状态词按结局 `warning` / `success` / `error`。
 *
 * ## 窄终端：放不下就整张表不画
 *
 * `command` 列拿剩余宽度，低于 `MIN_COMMAND_WIDTH` 时**整张表返回空**（调用方据此只画
 * 正文）—— 画一排 `…` 的半截表比不画更难读，而正文里已经有这次启动的任务 id 与命令。
 *
 * ## 宽度上限 55 列（用户 2026-10-22 定）
 *
 * 原来是「可用多宽就填多宽」，宽终端上一张两三个任务的小表被拉成一百多列、`command`
 * 格空掉一大半。现在表格自身封顶 `MAX_TABLE_WIDTH = 55`（含左右边框），窗口更宽就停在
 * 55；窄到放不下 55 时按可用宽度收。扣留白仍是调用方的事（见下一节）。
 *
 * ## 表头的标题行形态（用户 2026-10-22 定）
 *
 * 表头那四个格子（id / command / status / time）**加粗 + 刷一层灰底**：片段上带 `bold` /
 * `bg` 两个标记，由调用方落成 ANSI。底色取皮肤的 surface 槽（`userMessageBg`），不是
 * `dim` 色阶 —— `dim` 在 1337 上是 `#6d6d6d`，那档灰压在深色的行内代码色上会把对比度
 * 吃光。只染四个格子（连左右各 1 个补位空格），竖线不染 —— 四段分离的色块，不是通栏。
 *
 * ## 右侧留白
 *
 * 调用方传入的 `width` 已经扣掉了 `TABLE_RIGHT_MARGIN`（4 列，用户 2026-10-17 定的）——
 * 表格右边框不顶到行尾。留白为什么不在这里扣：本模块的契约是「给多少宽就填满多少」，
 * 而「这块内容能用多宽」是接线层（`index.ts`）的几何决策，与树缩进同一类。
 */

import { formatElapsed } from "./registry.ts";
import { statusWord } from "./status.ts";

/** 表格最多列几行任务（用户 2026-10-16 定：5）。 */
export const MAX_TABLE_ROWS = 5;

/**
 * 表格的**最大宽度**（用户 2026-10-22 定：55 列，含左右边框）。
 *
 * 这张表原来是「可用多宽就画多宽」—— 宽终端上一张两三个任务的小表被拉成一百多列。
 * 55 列是用户量出来的舒适上限：竖线到竖线一眼扫完，`command` 仍够放一条常见命令。
 * 窗口更宽时表格**停在 55**，右边缘参差；窗口窄时按可用宽度收。可用宽度本身已经扣掉了
 * 正文缩进 / 树符（4 列）与右留白（4 列）—— 整行 `└ ` + 4 列在 `┌` 前，即 80 列终端里
 * 表格只有 72 列可拿，封顶后停在 55（右边留 21 列空白）。
 *
 * 下限不变：连 `MIN_COMMAND_WIDTH` 都保不住时整张表不画。
 */
export const MAX_TABLE_WIDTH = 55;

/** `command` 列最少要几列才值得画表。再窄就只能显示 `…`，等于没有这一列。 */
export const MIN_COMMAND_WIDTH = 10;

/**
 * 表格右侧到终端边界的留白（用户 2026-10-17 定：4 列）。
 *
 * 这张表是**唯一一个会撑满可用宽度的块** —— 正文按字符折行，自然会留出参差的右边缘；
 * 表格的右边框却是笔直一条竖线，顶到行尾会像贴着屏幕边缘，视觉上比正文挤。
 *
 * 留白由**调用方**从可用宽度里扣掉（`width - TABLE_RIGHT_MARGIN`）再传进
 * `renderTaskTable`，不是在本模块里扣：`table.ts` 的约定是「给多少宽就填满多少」，
 * 扣留白属于「这块内容能用多宽」的决策，和 `BODY_INDENT` / 树符缩进同属接线层的几何。
 */
export const TABLE_RIGHT_MARGIN = 4;

/** `id` 列的最小宽度（`bg_1` 是 4 列；再短就认不出任务了）。 */
export const MIN_ID_WIDTH = 4;

/** `status` 列的最小宽度（`running` 七列、`exit 0` / `killed` 六列）。 */
export const MIN_STATUS_WIDTH = 6;

/** `time` 列的最小宽度（`12m2s` 五列；`1h12m` 也是五列）。 */
export const MIN_TIME_WIDTH = 5;

/**
 * 一格能用的语义色槽。
 *
 * - `header` = **列标题**（id / command / status / time），走 `mdCode`（行内代码色，用户 2026-10-17 定：
 *   列名是「字段名」，与正文里反引号包住的标识符同一个观感）；片段还带 `bold` + `bg`
 *   两个标记（用户 2026-10-22 定：表头是标题行，字要加粗、格子要有灰底），由调用方
 *   决定怎么落成 ANSI —— 本模块仍然不碰主题；
 * - `border` 走 bash 输出色（`pickBodySlot`）；
 * - `id` 走 `accent`，`status-*` 按结局 `warning` / `success` / `error`；
 * - `time` / `command` / `hint`（折叠行的占位 `-` 与文案，不是列名）走 `text` 前景色。
 */
export type TaskTableRole =
	| "border"
	| "header"
	| "hint"
	| "id"
	| "command"
	| "status-running"
	| "status-success"
	| "status-error"
	| "time";

/** 一行的片段：先拼片段，再由调用方按 role 上色（避免在纯模块里碰主题）。 */
export interface TaskTableSegment {
	text: string;
	role: TaskTableRole;
	/** 加粗（目前只有表头用，用户 2026-10-22 定）。 */
	bold?: boolean;
	/** 给这一格刷底色（目前只有表头用，用户 2026-10-22 定：皮肤 surface 色）。 */
	bg?: boolean;
}

/** 一行 = 若干片段。边框行是一个整段，任务行是「边框 + 格内容」交替。 */
export type TaskTableRow = TaskTableSegment[];

/** 表格需要的任务最小面（registry 的 `BackgroundTask` 结构兼容）。 */
export interface TaskTableTask {
	id: string;
	command: string;
	status: "running" | "exited" | "killed";
	startedAt: number;
	endedAt: number | undefined;
	exitCode: number | undefined;
	signal: string | undefined;
}

export interface TaskTableOptions {
	/** 表格可用的总宽度（调用方已经扣掉树缩进）。 */
	width: number;
	/** 快照的时刻：时长 = `(endedAt ?? now) - startedAt`。 */
	now: number;
	/** 可见宽度量度（运行时传 pi-tui 的 `visibleWidth`）。 */
	widthOf: (text: string) => number;
	/** 行数上限覆盖（默认 `MAX_TABLE_ROWS`）。 */
	maxRows?: number;
}

/** 表头文案：与 dock 行的英文状态词同语。第一列是 **id** 而不是 name —— 它是路由键。 */
const HEADERS = ["id", "command", "status", "time"] as const;

/**
 * 表格的固定开销：每格占 `│` + 空格 + 内容 + 空格 = `w + 3` 列，4 格之后还有一根收尾 `│`。
 * 即 `总宽 = 内容宽之和 + 4*3 + 1 = 内容宽之和 + 13`。
 */
const FRAME_WIDTH = 13;

/**
 * 折叠行文案（用户 2026-10-17 定）：英文、短，够塞进 `command` 列。
 *
 * 旧文案是整句中文 `… 另有 N 个较早的任务（/background 看全部）`，压平四列后仍有约 46 列；
 * 现在它只占 `command` 那一格，文案得短到窄终端下不至于立刻被裁成 `……`。
 *
 * `background` 缩成 `bg`（用户 2026-10-22 定）：表格封顶 55 列后 `command` 只剩 26 列，
 * `…6 background tasks earlier` 是 27 列，被 `clampText` 裁成 `…6 background tasks earl…`；
 * 缩成 `…6 bg tasks earlier`（19 列）后整句进得去，这一格的省略号只留给真正的长命令。
 */
export function moreTasksHint(hidden: number): string {
	return `…${hidden} bg tasks earlier`;
}

/** 把一行文本硬裁到 `width` 列，末尾留 `…`（U+2026，1 列）。`width <= 0` 时返回空串。 */
export function clampText(text: string, width: number, widthOf: (text: string) => number): string {
	if (width <= 0) return "";
	if (widthOf(text) <= width) return text;
	if (width <= 1) return "…";
	const out: string[] = [];
	let used = 0;
	for (const char of text) {
		const next = widthOf(char);
		// 预留 1 列给 `…`：装不下这一格就停，宁可少一个字也不超宽
		if (used + next > width - 1) break;
		out.push(char);
		used += next;
	}
	// 别让 `…` 跟在空格后面（`npm test …` 比 `npm test…` 难读）；尾部空白由 padText 补。
	return `${out.join("").replace(/\s+$/, "")}…`;
}

/** 用空格把一格补到 `width` 列（宽字符按 `widthOf` 算，不能按 `length` 算）。 */
function padText(text: string, width: number, widthOf: (text: string) => number): string {
	const actual = widthOf(text);
	return actual >= width ? text : text + " ".repeat(width - actual);
}

/** 左对齐一格：先裁再补。 */
function cellText(text: string, width: number, widthOf: (text: string) => number): string {
	return padText(clampText(text, width, widthOf), width, widthOf);
}

/** 居中一格（折叠行的占位 `-` 用）：左侧补 floor(剩余/2)，余数落右边。 */
function cellCentered(text: string, width: number, widthOf: (text: string) => number): string {
	const clipped = clampText(text, width, widthOf);
	const pad = Math.max(0, width - widthOf(clipped));
	const left = Math.floor(pad / 2);
	return " ".repeat(left) + clipped + " ".repeat(pad - left);
}

/**
 * 命令格：先压平空白再裁。
 *
 * `registry.ts` 的 `truncateCommand` 也会压平，但表格不能指望调用方已经那么做 —— 一个换行
 * 落在格里会把那一行拆成两行，整张表的宽度就歪了。
 */
function cellCommand(text: string, width: number, widthOf: (text: string) => number): string {
	return cellText(text.replace(/\s+/g, " ").trim(), width, widthOf);
}

/**
 * 边框行：`┌──┬──┐` 这一整行同属 border 角色，拼成一个片段。
 *
 * 每格要 `width + 2` 列 —— 内容行里那格是 `│ ` + 内容 + ` `，两个空格也占位，边框必须对齐。
 */
function borderLine(left: string, middle: string, right: string, widths: readonly number[]): TaskTableRow {
	const body = widths.map((width) => "─".repeat(width + 2)).join(middle);
	return [{ text: `${left}${body}${right}`, role: "border" }];
}

/**
 * 拼 `│ cell │ cell │`。`widths` 与 `cells` 一一对应 —— 表头、任务行、折叠提示行都是 4 格。
 *
 * **带 `bg` 标记的格子连左右各 1 个补位空格一起成段**（用户 2026-10-22 定：只染四个格子，
 * 每个词连同左右各 1 空格、竖线不染）—— 底色由调用方刷到整个片段的文本上，于是每格是一块
 * 连片色块而不是浮在格里的窄条。总宽度不变（仍是 `width + 2`），只是那两格空格从 border
 * 片段并进了格子片段。
 */
function cellRow(cells: ReadonlyArray<TaskTableSegment>, widths: readonly number[]): TaskTableRow {
	const segments: TaskTableSegment[] = [];
	for (let index = 0; index < widths.length; index += 1) {
		const cell = cells[index]!;
		segments.push({ text: "│", role: "border" });
		if (cell.bg === true) {
			segments.push({ ...cell, text: ` ${cell.text} ` });
		} else {
			segments.push({ text: " ", role: "border" }, cell, { text: " ", role: "border" });
		}
	}
	segments.push({ text: "│", role: "border" });
	return segments;
}

/**
 * 算列宽。返回 `undefined` = 放不下（整张表不画）。
 *
 * `id` / `status` / `time` 按内容取自然宽度（不低于各自的 `MIN_*`），剩下的全给 `command`。
 * 宽度不够时优先保住前三列、牺牲 command；command 跌破 `MIN_COMMAND_WIDTH` 就整张表返回
 * `undefined` —— 那三列被截就认不出任务，command 被截只是少看几个字。
 */
function computeWidths(
	tasks: readonly TaskTableTask[],
	now: number,
	width: number,
	widthOf: (text: string) => number,
): { id: number; command: number; status: number; time: number } | undefined {
	const natural = (values: readonly string[], header: string): number =>
		Math.max(widthOf(header), ...values.map((value) => widthOf(value)));

	const id = Math.max(MIN_ID_WIDTH, natural(tasks.map((task) => task.id), HEADERS[0]));
	const status = Math.max(MIN_STATUS_WIDTH, natural(tasks.map((task) => statusWord(task).word), HEADERS[2]));
	const time = Math.max(
		MIN_TIME_WIDTH,
		natural(tasks.map((task) => formatElapsed((task.endedAt ?? now) - task.startedAt)), HEADERS[3]),
	);
	const command = width - FRAME_WIDTH - id - status - time;
	if (command < MIN_COMMAND_WIDTH) return undefined;
	return { id, command, status, time };
}

/**
 * 渲染总览表。返回**行数组**，调用方按 `role` 上色后挂树前缀。
 *
 * `[]` = 不画（没有任务 / 宽度放不下）。任务列表为空时也不画：`run_in_background` 的正文
 * 已经说了这次启动的 id，空表只剩一个表头，是纯噪音。
 *
 * 行序：**最旧在上、最新在下**（与用户草图的 `bg_1` → `bg_2` 一致）。超过 `maxRows` 时丢
 * 最旧的，并在**表头分隔线之下、任务行之上**补一行折叠提示（用户 2026-10-17 定：被丢掉的
 * 正是这些可见行之前的那几个，放底部会把时间顺序读反，也会把「最新那个」隔在底边框之外）。
 */
export function renderTaskTable(tasks: readonly TaskTableTask[], options: TaskTableOptions): TaskTableRow[] {
	if (tasks.length === 0) return [];
	// 宽度封顶在 `MAX_TABLE_WIDTH`（用户 2026-10-22 定）：宽终端上不再把两三个任务的小表
	// 拉成一百多列。封顶后再走原来的列宽分配 —— 窄终端不受影响（min 取的就是传入值）。
	const width = Math.min(options.width, MAX_TABLE_WIDTH);
	const { now, widthOf } = options;
	const maxRows = Math.max(1, Math.floor(options.maxRows ?? MAX_TABLE_ROWS));
	if (!(width > 0)) return [];

	// 按启动顺序排（registry 的插入顺序即启动顺序，但快照可能被打乱）；同一时刻按 id 兜底
	const ordered = [...tasks].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	const widths = computeWidths(ordered, now, width, widthOf);
	if (widths === undefined) return [];
	const inner = [widths.id, widths.command, widths.status, widths.time] as const;
	const contentWidth = inner.reduce((sum, value) => sum + value, 0);

	const visible = ordered.slice(-maxRows);
	const hidden = ordered.length - visible.length;

	const rows: TaskTableRow[] = [borderLine("┌", "┬", "┐", inner)];

	// 表头是**标题行**（用户 2026-10-22 定）：四个格子各自加粗并刷底色。底色只包住格子本身 ——
	// 竖线仍是 border 片段（`cellRow` 把带 `bg` 的格与它左右那格空格并成一片）。
	rows.push(
		cellRow(
			HEADERS.map((header, index) => ({
				text: cellText(header, inner[index]!, widthOf),
				role: "header" as TaskTableRole,
				bold: true,
				bg: true,
			})),
			inner,
		),
	);

	rows.push(borderLine("├", "┼", "┤", inner));

	// 折叠提示：仍是一条普通表格行 —— 文案进 `command` 格，其余三列填居中的 `-`（用户 2026-10-17 定）。
	// 不压平四列：竖线不能在一行里断掉，否则表格结构就破了。
	//
	// **位置在表头之下、任务行之上**（用户 2026-10-17 定）：行序是「最旧在上、最新在下」，
	// 被丢掉的那几行恰恰在这些可见行**之前**；写在底部等于说它们发生在最新的任务之后。
	// 折叠行就该占在被省略的位置上（`tail`/`less` 的截断惯例），而且底部那行是信息重心
	// （刚启动 / 刚结束的那一个），不该被一个 `-` 行隔在底边框之外。
	if (hidden > 0) {
		const dash = (index: number) => ({ text: cellCentered("-", inner[index]!, widthOf), role: "hint" as TaskTableRole });
		rows.push(
			cellRow(
				[
					dash(0),
					{ text: cellText(moreTasksHint(hidden), inner[1]!, widthOf), role: "hint" },
					dash(2),
					dash(3),
				],
				inner,
			),
		);
	}

	for (const task of visible) {
		const { word, slot } = statusWord(task);
		const elapsed = formatElapsed((task.endedAt ?? now) - task.startedAt);
		rows.push(
			cellRow(
				[
					{ text: cellText(task.id, widths.id, widthOf), role: "id" },
					{ text: cellCommand(task.command, widths.command, widthOf), role: "command" },
					{
						text: cellText(word, widths.status, widthOf),
						role: slot === "warning" ? "status-running" : slot === "success" ? "status-success" : "status-error",
					},
					// time 右对齐：时长是数字，右对齐才便于扫读
					{ text: " ".repeat(Math.max(0, widths.time - widthOf(elapsed))) + elapsed, role: "time" },
				],
				inner,
			),
		);
	}

	rows.push(borderLine("└", "┴", "┘", inner));
	return rows;
}
