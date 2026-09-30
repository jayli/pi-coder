/**
 * plan-mode 的显示层文案：状态行 + 两个工具调用块的形态。
 *
 * 不 import pi / pi-tui —— 颜色由主题的 `fg(slot, text)` 注入，所以 `node --test`
 * 能直接断言每条文案。
 *
 * ## 为什么复用一个 `setStatus` key
 *
 * 本机 statusline 扩展把其它扩展 `ctx.ui.setStatus()` 的文本拼成第二行（`formatExtensionStatuses`，
 * 最多 5 条、` | ` 分隔），所以这里的键数越少越好。两个态共用 `plan-mode` 一个键：
 * plan 给一份文案，bypass 直接 `undefined` 清掉，第二行不会留下空档。
 *
 * 2026-09-24 删掉 execute 态之后**没有步骤 widget 了** —— 计划是一份 markdown，没有
 * 可逐条打勾的步骤；进度归模型自己（它要建任务清单就自己 `task_set`，那是 simple-task
 * 的 widget 该显示的事）。
 *
 * ## 配色（用户 2026-09-27 定：三态三色，语义槽不写死色值）
 *
 *   dangerous 红色（`error`）   沙箱关闭、任意权限 —— 危险，最醒目
 *   bypass    绿色（`success`）  沙箱删除拦截开启 —— 安全默认（2026-09-27 之前是红色）
 *   plan      橙色（`warning`）  只读、等你拍板 —— 与旧配色一致
 *
 * 三个槽在三套本机皮肤里都存在（error / success / warning 都是语义槽）。
 * 写文档子态的「· 写文档中」仍走 `accent`。
 *
 * ## 工具调用块的展示形态（用户 2026-09-29 定）
 *
 * `enter_plan_mode` / `exit_plan_mode` 原先走 pi 的默认工具壳：整块套 `toolSuccessBg`
 * 底色、`Box(1, 1)` 的 paddingY 加上下各一行空行、标题只有加粗工具名、结果全文平铺。
 * 现在改成本机 bash 块同族的树形观感：
 *
 * ```
 * • enter_plan_mode ✔
 *   │ 已进入 plan mode（只读）。原因：跨 gateway/config.yaml 与 pi、
 *   └ opencode、codex 三端配置的行为改动。
 * ```
 *
 * 三件事由本模块定，上色与折行由 index.ts 的渲染器做（那边才拿得到真 theme）：
 *
 *   1. **四态结局**（`classifyPlanToolOutcome`）—— 「成功进入 / 批准」与「被用户否掉 /
 *      被打回」在 pi 眼里都是正常返回（`isError` 为 false），区分只在工具自己回的
 *      `details` 里（`consented` / `accepted`）。所以分类必须读 details，不能只看 isError。
 *   2. **标题行的点与标记**（`planToolTitleParts`）—— 绿 `•`+`✔`（成功）/ 灰 `•`+`✘`
 *      （没成但不是错）/ 红 `•`+`✘`（真错误）/ 灰 `•` 无标记（执行中）。
 *      用 `success` / `dim` / `error` 三个语义槽，与上面状态行同一套配色哲学。
 *   3. **树前缀**（`planResultTreePrefixes`）—— 除末行外每行 `│ `，**末行 `└ `**。
 *
 * 第 3 条与 bash 块**刻意分叉**：`bash-command-collapse.ts` 的 `└ ` 只出现一次、落在
 * 第一个实质输出行，其下正文用等宽缩进（树在那里「落地」）；这里用户明确要求 `└`
 * 跟到最后一行。两者都是用户定的形状，别互相「统一」掉。
 *
 * 相同的部分照旧沿用 bash 块的约定：结构符 `│` / `└` 走 `muted` 槽且**自成一段 SGR**
 *（不让后面正文的颜色透上来）。
 *
 * 几何（用户 2026-09-29 第二、三轮逐步定下）：标题行从状态圆点起**顶格**（圆点是
 * 这一块的状态灯，贴着左边界块与块才分得开），正文树前面挂 **2 列**缩进，于是
 * `•` 在列 0、`│` / `└` 在列 2、正文在列 4 —— `│` 正好落在 `enter_plan_mode` 的
 * 首字母 `e` 正下方。这与 bash 块是**同一张表**（`bash-command-collapse.ts` 的
 * `• Run …`：圆点列 0、`Run` 与树符列 2、正文列 4），所以两种块相邻时树是对齐的。
 */

import type { PlanPhase } from "./plan.ts";

export const STATUS_KEY = "plan-mode";

export interface PlanTheme {
	fg(color: string, text: string): string;
}

export interface PlanStatusSource {
	phase: PlanPhase;
	/** plan 态：模型已提交、等用户审批。 */
	pending?: string;
	/** plan 态：写文档子态。 */
	docWriting?: boolean;
}

/**
 * statusline 第二行的那段文本。**三个态都有文案** —— 让「当前处于哪个模式」
 * 永远有个固定的显示位（这一格原先归 simple-task 的 `✔ n/N`，它与输入框上方的
 * widget 重复，已让给模式指示）。
 *
 *   ☢ dangerous               pi 原生任意权限（沙箱删除拦截关闭）
 *   ⏵ bypass                  沙箱删除拦截开启（安全默认）
 *   ⏸ plan                    等待模型提交计划
 *   ⏸ plan · 待批准            已提交、等用户审批
 *   ⏸ plan · 写文档中          写文档子态（模型正在把计划落成文件）
 */
export function formatPlanStatus(theme: PlanTheme, source: PlanStatusSource): string {
	if (source.phase === "plan") {
		const label = theme.fg("warning", "⏸");
		if (source.docWriting) {
			return `${label} ${theme.fg("warning", "plan")} ${theme.fg("accent", "· 写文档中")}`;
		}
		if (source.pending) return `${label} ${theme.fg("warning", "plan")} ${theme.fg("muted", "· 待批准")}`;
		return `${label} ${theme.fg("warning", "plan")}`;
	}
	if (source.phase === "dangerous") {
		// 红色（error 槽）：沙箱关闭、删除不再拦截 —— 三套皮肤里 error 都是红色系，
		// 让「任意权限」这个态一眼可见。
		return `${theme.fg("error", "☢")} ${theme.fg("error", "dangerous")}`;
	}
	// bypass：绿色（success 槽）—— 沙箱删除拦截开启，是安全默认态。
	// 2026-09-27 之前这一态用红色（toolDiffRemoved）表示「未开启保护」；三态化之后
	// 红色让给了 dangerous，bypass 改绿：有保护、可以放心用。
	return `${theme.fg("success", "⏵")} ${theme.fg("success", "bypass")}`;
}

// =============================================================================
// 工具调用块
// =============================================================================

/**
 * 一次工具调用的**展示结局**。
 *
 * `pending` 是「结果还没到」（执行中 / 同意弹框还开着），不由 `classifyPlanToolOutcome`
 * 产生 —— 那个函数只在有结果时被调用。
 */
export type PlanToolOutcome = "pending" | "success" | "declined" | "error";

/** 标题行的点与标记能用的语义槽（三套本机皮肤与 pi 内置 dark/light 都有）。 */
export type PlanToolSlot = "dim" | "success" | "error";

/** 树前缀：`│ ` = 还有下文，`└ ` = 末行。各自 2 列（box-drawing 字符 + 空格）。 */
export const TREE_PIPE = "│ ";
export const TREE_LAST = "└ ";

/**
 * 把一次工具结果分类成展示结局。
 *
 * 判定顺序：**isError 优先**（真错误压过 details 里的任何字段），然后看 details 的
 * `consented` / `accepted` 是不是**严格 true**，其余一律 `declined`。
 *
 * 为什么「其余」都算没成而不是「算成功」：这两个工具的每种非成功返回都带着明确的
 * 否定标记（enter 被否 `{consented:false}`、被 brainstorming 闸拦 `{brainstorming:true,
 * consented:false}`、exit 被打回/空计划/不在 plan 态 `{accepted:false}`），而 details
 * 缺失只可能是历史会话里的旧形状或异常路径 —— 那种情况画个灰 `✘` 比画个绿 `✔`
 * 诚实（绿勾会被读成「已生效」，而扩展状态可能根本没变）。
 */
export function classifyPlanToolOutcome(isError: boolean, details: unknown): PlanToolOutcome {
	if (isError) return "error";
	if (details !== null && typeof details === "object") {
		const record = details as { consented?: unknown; accepted?: unknown };
		if (record.consented === true || record.accepted === true) return "success";
	}
	return "declined";
}

/** 标题行该画什么：点的色槽 + 标记字符 + 标记的色槽（无标记时 markSlot 为 undefined）。 */
export interface PlanToolTitleParts {
	dotSlot: PlanToolSlot;
	mark: "" | "✔" | "✘";
	markSlot?: PlanToolSlot;
}

/**
 * 四态的标题装饰。点与标记**同色**（用户 2026-09-29 定：成功时前面的点和后面的 ✔
 * 都是绿的），所以 markSlot 恒等于 dotSlot —— 分成两个字段只是为了让调用方不必自己
 * 再推一遍，也让「哪天想让标记换个色」有唯一的改动点。
 */
export function planToolTitleParts(outcome: PlanToolOutcome): PlanToolTitleParts {
	switch (outcome) {
		case "success":
			return { dotSlot: "success", mark: "✔", markSlot: "success" };
		case "declined":
			return { dotSlot: "dim", mark: "✘", markSlot: "dim" };
		case "error":
			return { dotSlot: "error", mark: "✘", markSlot: "error" };
		default:
			return { dotSlot: "dim", mark: "" };
	}
}

/**
 * 每行的树前缀：末行 `└ `，其余 `│ `。
 *
 * 0 行返回空数组（调用方据此不画正文），1 行返回 `["└ "]`（只有一行时它就是末行）。
 * 传入的行数是**折行之后**的视觉行数 —— 折行碎片也算独立行，否则一个折成三行的长句
 * 会在第一片就画上 `└`，看起来像树提前结束了。
 */
export function planResultTreePrefixes(lineCount: number): string[] {
	if (lineCount <= 0) return [];
	const prefixes: string[] = [];
	for (let index = 0; index < lineCount; index += 1) {
		prefixes.push(index === lineCount - 1 ? TREE_LAST : TREE_PIPE);
	}
	return prefixes;
}
