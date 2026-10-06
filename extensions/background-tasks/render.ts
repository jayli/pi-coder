/**
 * background-tasks/render.ts — 三个工具调用块 + 终态通知的**展示形态**纯逻辑层。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入、折行由 index.ts 那侧做
 * （那边才拿得到真 theme 与 `wrapTextWithAnsi`），所以 `node --test` 能直接断言结局分类、
 * 标题装饰、树前缀、预览截断这些**决定**。与 `status.ts`（dock 行）、`plan-mode/render.ts`
 * 同一套取舍：纯模块定形态，接线模块上色折行。
 *
 * ## 形态（用户 2026-09-30 定：参照 plan 工具调用块）
 *
 * `run_in_background` / `background_output` / `background_kill` 原先走 pi 的默认工具壳：
 * 整块套 `toolSuccessBg` 底色、`Box(1, 1)` 的 paddingY 给上下各一行空行、标题只有加粗
 * 工具名、结果全文平铺（且被 pi 默认裁到 10 行）。终态通知同理套 `customMessageBg` 底色。
 * 现在统一改成本机 bash / plan 块同族的树形观感：
 *
 * ```
 * • run_in_background
 *   │ 已在后台启动 bg_1（pid 12345）。
 *   └ 日志：/…/bg_1.log
 * ```
 *
 * 终态通知（`✓ 后台任务 bg_1 结束` → 圆点顶格、对号移行末）：
 *
 * ```
 * • 后台任务 bg_1 结束 ✔
 *   │ 后台任务 bg_1 已成功结束（exit 0），运行 5s。
 *   └ 完整日志：/…/bg_1.log
 * ```
 *
 * **标记只属于终态通知，且恒为 `✔`**（用户 2026-09-30 分三轮定下）：对号在这套界面语言里的
 * 意思是「任务跑完了」，而 `run_in_background` 成功恰恰意味着任务才刚开始；叉号对工具块
 * 也是多余的 —— 圆点颜色已经是结局灯。所以**工具块只有圆点、无任何标记**；终态通知
 * 保留「圆点 + 行末 `✔`」，且**只要结束就是 `✔`**（失败时圆点变红、正文写失败原因，
 * 而不是把对号换成叉）。详见 `bgToolTitleParts` / `bgNotificationTitleParts`。
 *
 * 三件事由本模块定：
 *
 *   1. **结局分类**（`classifyBgToolOutcome` / `classifyBgNotificationOutcome`）—— 成功 /
 *      没成但不是错 / 真错误 / 执行中。三个工具的正常返回都带 `details.ok`（true=成功，
 *      false=参数错/找不到任务/杀不掉），pi 眼里 `ok:false` 仍是正常返回（`isError` 为 false），
 *      所以分类必须读 details，不能只看 isError。
 *   2. **标题行的点与标记**（`bgToolTitleParts` / `bgNotificationTitleParts`）—— 工具块：
 *      绿 `•`（成功）/ 灰 `•`（没成但不是错、执行中）/ 红 `•`（真错误），均无标记；
 *      终态通知：`•`+行末 `✔`（只要结束就是 ✔；exit 0 绿、killed / 非 0 红，成败靠点色）。
 *      用 `success` / `dim` / `error` 三个语义槽，与 plan 块、dock 行同一套配色哲学。
 *   3. **树前缀**（`bgResultTreePrefixes`）—— 除末行外每行 `│ `，**末行 `└ `**。
 *
 * 几何与 plan 块是**同一张表**：标题行从状态圆点起**顶格**（圆点是这一块的状态灯，贴着
 * 左边界块与块才分得开），正文树前面挂 **2 列**缩进（`BODY_INDENT`），于是 `•` 在列 0、
 * `│` / `└` 在列 2、正文在列 4 —— `│` 正好落在 `run_in_background` 首字母 `r` 正下方。
 * 结构符 `│` / `└` 走 `muted` 槽且**自成一段 SGR**（不让后面正文的颜色透上来），正文走
 * **结果正文色**（`BODY_TEXT_SLOTS[0]` = `bashOutput`，主题没定义时退回 `toolOutput`；
 * 用户 2026-10-06 定：与 bash 工具调用后显示的输出结果同色，而不是 `text` 槽的 fg）。
 *
 * ## 预览截断（保留 pi 默认壳原有的行为）
 *
 * pi 的默认结果壳把正文裁到 `FALLBACK_PREVIEW_LINES`（10）行并给一条
 * `... (N more lines, ctrl+o to expand)` 提示；换成 self 壳后这条裁剪会消失，所以本模块
 * 自己补回来（`PREVIEW_MAX_LINES` + `previewMoreLinesHint`），否则 `background_output`
 * 一次 30000 字符的返回会平铺满屏。展开态（ctrl+o，`expanded`）不裁，与 bash / tool-diff
 * 块一致。截断按**折行之后**的视觉行数算（与树前缀同口径）。
 */

/** 树前缀：`│ ` = 还有下文，`└ ` = 末行。各自 2 列（box-drawing 字符 + 空格）。 */
export const TREE_PIPE = "│ ";
export const TREE_LAST = "└ ";

/**
 * 正文树的前导缩进与树形 gutter 的几何（与 plan-mode/index.ts 同值）：
 * `•` 在列 0、`│` / `└` 在列 2、正文在列 4。
 */
export const BODY_INDENT = "  ";
export const GUTTER_WIDTH = 2;

/**
 * 正文正文用哪个颜色槽：**先 `bashOutput`，主题没定义时退回 `toolOutput`**。
 *
 * 用户 2026-10-06 定：后台任务（工具块与终态通知）的正文要**与 bash 工具调用后显示的
 * 输出结果同色**。那个颜色是扩展 token `bashOutput`（`bash-command-collapse.ts` 在委托
 * 内置 bash 渲染器的同步窗口里把 `toolOutput` 临时指向它）—— 本机两套皮肤下它都比 `text`
 * 暗（pi-coder-1337 `#999999` vs `#f8f8f2`），是「输出」而非「要逐字读的正文」的语义。
 *
 * 回退的意义：pi 官方 schema 里没有 `bashOutput`（与 `toolDiffAddedBg` 那两个同一条路：
 * TypeBox 校验对未知 key 放行、`createTheme()` 把它们收进前景表），内置 dark / light 与
 * pi-coder-catppuccin 都没定义它，此时 pi 的 `theme.fg()`/`getFgAnsi()` 会抛
 * `Unknown theme color: bashOutput`。所以取色 MUST 加 try/catch，落到所有工具输出共用的
 * `toolOutput` —— 那些皮肤下 bash 输出本色也是 `toolOutput`，两边自动同色。
 *
 * 顺序即优先级；`pickBodyColor` 断言第一个能取到 ANSI 的槽。
 */
export const BODY_TEXT_SLOTS = ["bashOutput", "toolOutput"] as const;

/**
 * 非展开态下正文最多渲染的**视觉行**数（与 pi 默认壳的 `FALLBACK_PREVIEW_LINES` 同值，
 * 保持从默认壳换到 self 壳后截断行为不回归）。展开态（ctrl+o）不受此限。
 */
export const PREVIEW_MAX_LINES = 10;

/**
 * 一次工具调用 / 一条终态通知的**展示结局**。
 *
 * `pending` 是「结果还没到」（执行中），不由 `classifyBgToolOutcome` 产生 —— 那个函数
 * 只在有结果时被调用。
 */
export type BgToolOutcome = "pending" | "success" | "declined" | "error";

/** 标题行的点与标记能用的语义槽（三套本机皮肤与 pi 内置 dark/light 都有）。 */
export type BgToolSlot = "dim" | "success" | "error";

/**
 * 把一次工具结果分类成展示结局。
 *
 * 判定顺序：**isError 优先**（真错误压过 details 里的任何字段），然后看 details 的 `ok`
 * 是不是**严格 true**，其余一律 `declined`。
 *
 * 为什么「其余」都算没成而不是「算成功」：三个工具的每种非成功返回都带 `details.ok === false`
 * （空 command / 工作目录不存在 / 找不到任务 / 杀不掉），而 details 缺失只可能是历史会话里的
 * 旧形状或异常路径 —— 那种情况画个灰点比画个绿点诚实（工具块无标记，点色就是全部结局信号，
 * 绿点会被读成「已办成」）。
 */
export function classifyBgToolOutcome(isError: boolean, details: unknown): BgToolOutcome {
	if (isError) return "error";
	if (details !== null && typeof details === "object") {
		const record = details as { ok?: unknown };
		if (record.ok === true) return "success";
	}
	return "declined";
}

/**
 * 终态通知的展示结局（读 `sendMessage` 时写进 `details.task` 的那份任务快照）。
 *
 *   exit 0                    → success（绿 `•`）
 *   被 kill / 非 0 退出      → error（红 `•`）
 *   task 缺失 / 形状认不出   → error（旧形状或异常路径，画红比画绿诚实）
 *
 * 只有两态，**刻意不用四态里的 declined**：改形之前本渲染器就是一个二值判定
 * （`failed = killed || exit !== 0`），本次只换形状不换语义；而且 dock 行（`status.ts`）
 * 同样把 killed 与非 0 退出都归到 `error` 槽，两处一致。被主动 kill 的任务读成红色不算
 * 误报：它确实没把活干完。注意这个分类现在**只决定圆点颜色**（结局灯）—— 行末标记
 * 恒为 `✔`（只要结束就是 ✔，见 `bgNotificationTitleParts`），成败靠点色与正文区分。
 */
export function classifyBgNotificationOutcome(task: unknown): BgToolOutcome {
	if (task === null || typeof task !== "object") return "error";
	const record = task as { status?: unknown; exitCode?: unknown };
	if (record.status === "killed") return "error";
	if (typeof record.exitCode === "number" && record.exitCode !== 0) return "error";
	return "success";
}

/** 工具块标题行该画什么：只有点的色槽（工具块**不打任何标记**）。 */
export interface BgToolTitleParts {
	dotSlot: BgToolSlot;
}

/** 终态通知标题行该画什么：点的色槽 + 行末标记（恒为 `✔`，与点同色）。 */
export interface BgNotificationTitleParts extends BgToolTitleParts {
	mark: "✔";
	markSlot: BgToolSlot;
}

/**
 * **工具调用块**的标题装饰（run_in_background / background_output / background_kill）：
 * 只有圆点，**不打任何标记**（用户 2026-09-30 分两轮定下）。
 *
 * 点的颜色就是结局灯：绿 = 成功（`success`）、灰 = 执行中 / 没办成（`dim`）、
 * 红 = 真错误（`error`）。为什么两个标记都不要：
 *
 *   - **`✔` 不要**：对号在这套界面语言里的意思是「任务跑完了」，而 `run_in_background`
 *     成功恰恰意味着任务**才刚开始**、还在后台跑 —— 给它打对号会被读成「已经结束」，
 *     并与紧接着那条终态通知的 ✔ 撞车。
 *   - **`✘` 也不要**：工具块已经有圆点表达结局，再叠一个叉是同一件事说两遗；而且
 *     `background_kill` 这类调用里，「没办成」（找不到任务 / 已终态）是模型自己下一步
 *     就能纠正的普通分支，不是需要警示的故障 —— 正文里已经写了原因（`没有这个任务：
 *     bg_9（已知：bg_1）`），灰点 + 那句正文就够了。
 *
 * 代价（已接受）：declined 与 pending 的圆点同为 `dim`，两者在标题行上不可区分 ——
 * 但 pending 没有正文（结果未到），declined 有，所以屏幕上仍分得开。
 */
export function bgToolTitleParts(outcome: BgToolOutcome): BgToolTitleParts {
	switch (outcome) {
		case "success":
			return { dotSlot: "success" };
		case "error":
			return { dotSlot: "error" };
		default:
			return { dotSlot: "dim" };
	}
}

/**
 * **终态通知**的标题装饰：圆点 + 行末 `✔`。**只要结束就是 `✔`**（用户 2026-09-30 定）：
 * 这条通知是「任务结束了」的报告，`✔` 断言的是「结束」而非「成功」 —— 所以 exit 0、
 * 被 kill、非 0 退出都打 `✔`，成败由**圆点颜色**（结局灯）与正文（`已成功结束` /
 * `已失败结束（exit=1）`）表达，而不是靠换一个叉号。
 *
 *   exit 0                 → 绿 `•` + 行末绿 `✔`
 *   killed / 非 0 / 认不出 → 红 `•` + 行末红 `✔`（红点 + 红 ✔ + 正文，失败仍一眼可辨）
 *
 * 通知与工具块不同，**保留标记**：它是会话里唯一一条「任务结局」的权威陈述，而且模型
 * 会因为它被叫醒开新一轮。点与标记**同色**（markSlot 恒等于 dotSlot）—— 分成两个字段
 * 只是为了让调用方不必自己再推一遍。
 */
export function bgNotificationTitleParts(outcome: BgToolOutcome): BgNotificationTitleParts {
	const { dotSlot } = bgToolTitleParts(outcome);
	return { dotSlot, mark: "✔", markSlot: dotSlot };
}

/**
 * 每行的树前缀：末行 `└ `，其余 `│ `。
 *
 * 0 行返回空数组（调用方据此不画正文），1 行返回 `["└ "]`（只有一行时它就是末行）。
 * 传入的行数是**折行 + 预览截断之后**的视觉行数 —— 折行碎片与截断提示行各算独立行，
 * 否则一个折成三行的长句会在第一片就画上 `└`，看起来像树提前结束了。
 */
export function bgResultTreePrefixes(lineCount: number): string[] {
	if (lineCount <= 0) return [];
	const prefixes: string[] = [];
	for (let index = 0; index < lineCount; index += 1) {
		prefixes.push(index === lineCount - 1 ? TREE_LAST : TREE_PIPE);
	}
	return prefixes;
}

/**
 * 预览被裁时的提示行文案（不含树前缀与缩进，由调用方挂）。`hidden` 是被裁掉的视觉行数。
 *
 * 措辞与 pi 默认壳的 `... (N more lines, ctrl+o to expand)` 同族（`…` 用 U+2026，与
 * bash-command-collapse 的截断提示一致）；`ctrl+o` 是 `app.tools.expand` 的默认绑定
 * （本机 keybindings.json 未改绑它，与 bash-command-collapse 的 `resolveExpandKey` 默认同值）。
 */
export function previewMoreLinesHint(hidden: number): string {
	return `… (${hidden} more line${hidden === 1 ? "" : "s"}, ctrl+o to expand)`;
}
