/**
 * plan-mode 两个弹框的**配色包装**：正文走 `text` 槽（= 皮肤的主前景色），
 * 标题与选项行仍归 pi 的 accent 上色。
 *
 * ## 问题
 *
 * 两个弹框都通过 `ctx.ui.select(title, options)`（pi 的 `ExtensionSelectorComponent`）弹。
 * 那个组件把**整个 title 字符串**包成一段 `theme.fg("accent", title)` —— 它没有 message
 * 参数，所以正文（模型给的理由、计划全文）只能塞进 title，于是整段正文都被涂成 accent
 * （本机三套皮肤里是浅蓝）。用户 2026-09-30 定：正文要用 fg，只有标题和高亮选项留 accent。
 *
 * ## 为什么是「逐行包 text 槽」而不是换色
 *
 * `fg()` 只在它自己那段外面加上 SGR 颜色码，**不会**清掉外层已开的颜色：内层显式颜色
 * 覆盖外层。所以在 title 里给正文每行套一层 `fg("text", line)`，外层那层 accent 就管不着
 * 它（实测：正文是 `#f8f8f2`，标题行仍是 `#8cdaff`，选项行各自的包裹也不受影响）。
 * 折行也安全 —— pi-tui 的 `Text` 按段内字节切行并逐行重置样式，段中换行不会让颜色漏到下一行。
 *
 * 为什么**逐行**包而不是整块一次包：整块只加一次开头色码，段内换行后 pi-tui 的 SGR 重置
 * 会把颜色丢掉，第二行起就退回外层 accent。逐行包让每行自己带色码，折行到哪都还是正文色。
 *
 * 代价：多出来的 `\x1b[39m` + 外层收尾的 `\x1b[39m` 在行尾重复一次 —— 只是重复的重置码，
 * 显示上无影响。
 *
 * 本模块不 import pi：主题的 `fg(slot, text)` 由调用方注入，所以 `node --test` 直接断言。
 */

/** 上色能力：只要 `fg`（pi 的 Theme 满足）。 */
export interface BodyTheme {
	fg(color: string, text: string): string;
}

/** 正文用的语义槽。本机三套皮肤都把它指向 `fg`（`text` 槽就是「主前景色」）。 */
export const BODY_SLOT = "text";

/**
 * 把正文的每一行单独上色（空行跳过 —— 空行只是一行留白，包上色码没有意义）。
 *
 * 传入的正文可以自带换行（计划全文、模型理由），逐行处理后仍是同样的换行结构。
 */
export function paintBody(theme: BodyTheme, text: string): string {
	return text
		.split("\n")
		.map((line) => (line === "" ? line : theme.fg(BODY_SLOT, line)))
		.join("\n");
}

/**
 * 同意弹框的 title：首行标题不涂（归组件的 accent），理由与两条路线说明走正文色。
 *
 * 形状与用户 2026-09-30 看到的一致：
 *
 * ```
 * 模型请求进入 plan mode（只读探索）。      ← accent（保留）
 *
 * 它的理由：……                              ← 正文色
 *
 * 进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手   ← 正文色
 * 直接实施：跳过规划，现在就按你的指令直接改                      ← 正文色
 * ```
 */
export function buildConsentTitle(
	theme: BodyTheme,
	parts: { title: string; reason?: string; planLine: string; implLine: string },
): string {
	const body = parts.reason !== undefined && parts.reason !== "" ? `它的理由：${parts.reason}` : "";
	return (
		parts.title +
		(body ? `\n\n${paintBody(theme, body)}` : "") +
		`\n\n${paintBody(theme, `${parts.planLine}\n${parts.implLine}`)}`
	);
}

/** 审批弹框的 title：`批准这个计划？` 留 accent，计划正文走正文色。 */
export function buildApprovalTitle(theme: BodyTheme, plan: string): string {
	return `批准这个计划？\n\n${paintBody(theme, plan)}`;
}
