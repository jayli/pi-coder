/**
 * plan-mode 的显示层文案：状态行。
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
