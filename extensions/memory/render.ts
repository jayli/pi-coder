/**
 * memory/render.ts — 四个记忆工具调用块的**展示形态**纯逻辑层。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入、折行由 index.ts 那侧做
 * （那边才拿得到真 theme 与 `wrapTextWithAnsi`），所以 `node --test` 能直接断言结局分类、
 * 标题装饰、树前缀、预览截断这些**决定**。与 `background-tasks/render.ts`、
 * `plan-mode/render.ts` 同一套取舍：纯模块定形态，接线模块上色折行。
 *
 * ## 形态（用户 2026-09-30 定：与 bash / plan / 后台任务块同族）
 *
 * `memory_write` / `memory_read` / `memory_forget` / `memory_search` 原先走 pi 的默认工具壳：
 * 整块套 `toolSuccessBg` 底色、`Box(1, 1)` 的 paddingY 给上下各一行空行、标题只有加粗
 * 工具名、结果全文平铺（且被 pi 默认裁到 10 行）。现在统一改成树形观感：
 *
 * ```
 * • memory_write
 *   │ Updated memory "checkmark-means-task-finished-not-call-succeeded"
 *   └ (feedback). Index: 4 memories.
 * ```
 *
 * **工具块只有圆点、不打任何标记**（`checkmark-means-task-finished-not-call-succeeded`
 * 那条记忆定的界面语言）：点的颜色就是结局灯 —— 绿 = 成功、灰 = 执行中 / 没办成、
 * 红 = 真错误。`✔` / `✘` 都不画：对号在这套语言里断言「任务跑完了」，而记忆工具是
 * 一次同步读写、没有「还在跑」的后续；叉号也是同一件事说两遍（圆点已经表达结局，
 * 且「名字不合法 / 记忆不存在」是模型自己下一步就能纠正的普通分支，正文里已写了原因）。
 *
 * 几何与 plan / 后台任务块是**同一张表**：标题行从状态圆点起**顶格**（圆点是这一块的状态灯，
 * 贴着左边界块与块才分得开），正文树前面挂 **2 列**缩进（`BODY_INDENT`），于是 `•` 在列 0、
 * `│` / `└` 在列 2、正文在列 4 —— `│` 正好落在 `memory_write` 首字母 `m` 正下方。
 * 结构符 `│` / `└` 走 `muted` 槽且**自成一段 SGR**（不让后面正文的颜色透上来），正文走
 * `text` 槽（与 `exit_plan_mode` 下方正文同色）。
 *
 * ## 预览截断（保留 pi 默认壳原有的行为）
 *
 * pi 的默认结果壳把正文裁到 10 行并给一条 `... (N more lines, ctrl+o to expand)` 提示；
 * 换成 self 壳后这条裁剪会消失，所以本模块自己补回来（`PREVIEW_MAX_LINES` +
 * `previewMoreLinesHint`），否则 `memory_read` 读一条长正文、或 `memory_read` 不带 name
 * 列出几十条记忆时会平铺满屏。展开态（ctrl+o，`expanded`）不裁，与 bash / 后台任务块一致。
 * 截断按**折行之后**的视觉行数算（与树前缀同口径）。
 *
 * ## `memory_read` 读一条：折叠态只到 `description`（用户 2026-10-17 定）
 *
 * 读一条记忆的结果文本是「`name` / `type` / `modified` / `description` 四行 + 空行 + 正文」，
 * 4 行元信息本身在窄终端上还要折行，于是 10 行预算里正文只剩三五行 —— 屏幕上既看不到
 * 多少正文，又挤掉了本该紧凑的块。所以折叠态改成**只画元信息头**（到 `description` 为止），
 * 正文整段收起，末尾照旧挂一条 `… (N more lines, ctrl+o to expand)` 说明还有多少行。
 * 展开态（ctrl+o）仍画全部：那里是唯一能看到正文的地方，一个字不裁。
 *
 * 只对「读一条」生效（`details.action === "read"`）。`memory_read` 不带 name 时的列表、
 * `memory_search` 的多条命中块也各含空行，按第一条空行切头会把后面的命中整片藏起来，
 * 所以它们维持老的 10 行平铺截断。
 *
 * ## 元信息头的字段名走语法关键字色（用户 2026-10-17 定）
 *
 * `name:` / `type:` / `modified:` / `description:` 这四个**字段名**用 `syntaxKeyword` 槽
 * 渲染，冒号后的值仍是正文的 `text` 槽 —— 与 bash 命令行里选项的着色、`/theme` 预览里的
 * 关键字同一支笔。判定在 `memoryMetaKeyLength`：只对头部的**源行首行**上色，因此折行出来
 * 的续行不会被误认，正文里恰好以 `name:` 开头的行（比如讲 frontmatter 的记忆）也不受影响。
 */

/** 树前缀：`│ ` = 还有下文，`└ ` = 末行。各自 2 列（box-drawing 字符 + 空格）。 */
export const TREE_PIPE = "│ ";
export const TREE_LAST = "└ ";

/**
 * 正文树的前导缩进与树形 gutter 的几何（与 plan-mode / background-tasks 同值）：
 * `•` 在列 0、`│` / `└` 在列 2、正文在列 4。
 */
export const BODY_INDENT = "  ";
export const GUTTER_WIDTH = 2;

/**
 * 非展开态下正文最多渲染的**视觉行**数（与 pi 默认壳的 `FALLBACK_PREVIEW_LINES` 同值，
 * 保持从默认壳换到 self 壳后截断行为不回归）。展开态（ctrl+o）不受此限。
 */
export const PREVIEW_MAX_LINES = 10;

/**
 * 一次工具调用的**展示结局**。
 *
 * `pending` 是「结果还没到」（执行中），不由 `classifyMemoryToolOutcome` 产生 ——
 * 那个函数只在有结果时被调用。
 */
export type MemoryToolOutcome = "pending" | "success" | "declined" | "error";

/** 标题行的点能用的语义槽（三套本机皮肤与 pi 内置 dark/light 都有）。 */
export type MemoryToolSlot = "dim" | "success" | "error";

/**
 * 工具自己回的 `details.action` 里，哪些算「没办成但不是错」。
 *
 * 四个工具的每种非成功返回都带一个明确的 action：`rejected`（名字非法 / 类型非法 /
 * 缺 description 或 content）、`blocked`（本项目关了记忆）、`not_found`（读 / 删的名字
 * 不存在）。它们在 pi 眼里都是**正常返回**（`isError` 为 false），所以分类必须读 details，
 * 不能只看 isError —— 与 plan / 后台任务块同一个理由。
 */
const DECLINED_ACTIONS = new Set(["rejected", "blocked", "not_found"]);

/**
 * 把一次工具结果分类成展示结局。
 *
 * 判定顺序：**isError 优先**（真错误压过 details 里的任何字段），然后 details.action
 * 落在 `DECLINED_ACTIONS` 里算 `declined`，其余一律 `success`。
 *
 * 为什么「其余」都算成功而不是「认不出就算没成」（与 background-tasks 的 `details.ok`
 * 严格判定相反）：记忆工具的成功 action 有六种（`created` / `updated` / `list` / `read` /
 * `deleted` / `search`），逐个列白名单会在将来加一种 action 时静默变灰；而失败形态只有
 * 上面那三种、且都是扩展自己写死的字面量，列黑名单不会漏。details 缺失（历史会话里的
 * 旧形状）按成功画绿点：那一次调用确实把记忆读 / 写成了，只是没带 action 字段。
 */
export function classifyMemoryToolOutcome(isError: boolean, details: unknown): MemoryToolOutcome {
	if (isError) return "error";
	if (details !== null && typeof details === "object") {
		const record = details as { action?: unknown };
		if (typeof record.action === "string" && DECLINED_ACTIONS.has(record.action)) return "declined";
	}
	return "success";
}

/** 工具块标题行该画什么：只有点的色槽（工具块**不打任何标记**）。 */
export interface MemoryToolTitleParts {
	dotSlot: MemoryToolSlot;
}

/**
 * 标题装饰：只有圆点，**不打任何标记**（用户 2026-09-30 定，与后台任务块同一套语言）。
 *
 * 点的颜色就是结局灯：绿 = 成功（`success`）、灰 = 执行中 / 没办成（`dim`）、
 * 红 = 真错误（`error`）。
 *
 * 代价（已接受，与 background-tasks 同）：declined 与 pending 的圆点同为 `dim`，两者在
 * 标题行上不可区分 —— 但 pending 没有正文（结果未到），declined 有（`Invalid memory
 * name "../evil": …`），所以屏幕上仍分得开。也因为标题行三态同文，断言配色必须用
 * **着色主题**（plain 主题分不出来），见 `render.test.ts`。
 */
export function memoryToolTitleParts(outcome: MemoryToolOutcome): MemoryToolTitleParts {
	switch (outcome) {
		case "error":
			return { dotSlot: "error" };
		case "declined":
		case "pending":
			return { dotSlot: "dim" };
		default:
			return { dotSlot: "success" };
	}
}

/**
 * 每行的树前缀：末行 `└ `，其余 `│ `。
 *
 * 0 行返回空数组（调用方据此不画正文），1 行返回 `["└ "]`（只有一行时它就是末行）。
 * 传入的行数是**折行 + 预览截断之后**的视觉行数 —— 折行碎片与截断提示行各算独立行，
 * 否则一个折成三行的长句会在第一片就画上 `└`，看起来像树提前结束了。
 */
export function memoryResultTreePrefixes(lineCount: number): string[] {
	if (lineCount <= 0) return [];
	const prefixes: string[] = [];
	for (let index = 0; index < lineCount; index += 1) {
		prefixes.push(index === lineCount - 1 ? TREE_LAST : TREE_PIPE);
	}
	return prefixes;
}

/**
 * `memory_read` 读一条记忆时，结果文本的元信息头占几行源行（`name` / `type` / `modified` /
 * `description`），即**第一个空行之前**的那几行。
 *
 * 返回 0 表示「没有可分离的头」，调用方按老的平铺截断处理：没有空行（`not_found` 之类
 * 的单句结果）、头前面就是空行、或结果只有头没有正文（那时没有可收起的东西）。
 * 注意这里数的是**源行**，折行后的视觉行数由 `memoryPreviewRows` 接。
 */
/**
 * `memory_read` 元信息头的字段名（顺序即结果文本里的顺序）。
 *
 * 白名单而不是「任意 `xxx:` 前缀」：头是 `index.ts` 自己拼的、键集固定，限制成这四个可以
 * 避免将来别的形态（检索命中块、正文）里同形的行被顺手着色。
 */
export const MEMORY_META_KEYS = ["name", "type", "modified", "description"] as const;

const MEMORY_META_PREFIX = new RegExp(`^(${MEMORY_META_KEYS.join("|")}):`);

/**
 * 一行元信息源行的**字段名段长度**（`name:` → 5，即 key + 冒号），0 表示这行不是字段行。
 *
 * 返回的是**字符**数而非可见宽度：调用方只拿它切字符串（`slice`），切点之后上色交给主题；
 * key 全是 ASCII，所以在这个键集上两者恰好相同。冒号后的空白不计进来 —— 让值的着色从
 * 第一个非空白字符起，空格本来也没有字形。
 */
export function memoryMetaKeyLength(line: string): number {
	const match = MEMORY_META_PREFIX.exec(line);
	return match ? match[0].length : 0;
}

export function memoryReadHeaderLineCount(lines: readonly string[]): number {
	const blank = lines.findIndex((line) => line.trim() === "");
	if (blank <= 0) return 0;
	return blank;
}

/**
 * 折叠态的可见行预算（**视觉行**）：`headRows` 是被收起正文之前的头行数（0 表示不分离头）。
 *
 * - 头分离成立（`0 < headRows < totalRows`）→ 只留头，正文整段算作被裁；头自己就超过
 *   上限（`description` 特别长）时仍按上限裁头。
 * - 其余情况 → 老的平铺截断：最多 `maxRows` 行。
 *
 * 展开态不调用本函数（那里一行都不裁）。
 */
export function memoryPreviewRows(
	totalRows: number,
	headRows: number,
	maxRows: number = PREVIEW_MAX_LINES,
): { visibleRows: number; hiddenRows: number } {
	if (totalRows <= 0) return { visibleRows: 0, hiddenRows: 0 };
	const budget = headRows > 0 && headRows < totalRows ? Math.min(headRows, maxRows) : maxRows;
	if (totalRows <= budget) return { visibleRows: totalRows, hiddenRows: 0 };
	return { visibleRows: budget, hiddenRows: totalRows - budget };
}

/**
 * 预览被裁时的提示行文案（不含树前缀与缩进，由调用方挂）。`hidden` 是被裁掉的视觉行数。
 *
 * 措辞与 pi 默认壳的 `... (N more lines, ctrl+o to expand)` 同族（`…` 用 U+2026，与
 * bash-command-collapse / background-tasks 的截断提示一致）；`ctrl+o` 是 `app.tools.expand`
 * 的默认绑定（本机 keybindings.json 未改绑它）。
 */
export function previewMoreLinesHint(hidden: number): string {
	return `… (${hidden} more line${hidden === 1 ? "" : "s"}, ctrl+o to expand)`;
}
