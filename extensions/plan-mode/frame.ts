/**
 * plan-mode 两个弹框的**正文线框**：把一段正文（模型给的理由、计划全文）装进一个
 * `┌─┐ / │ │ / └─┘` 的方框里，取代此前整段平铺。
 *
 * ## 为什么是「纯几何 + 依赖注入」
 *
 * 与 `consent.ts` 同一条约定：本模块**不 import pi / pi-tui**，折行（`wrap`）、量宽
 * （`measure`）、上色（`fg`）全由调用方注入，所以 `node --test` 能直接断言行内容与
 * 每一行的可见宽度。生产侧注入的是 pi-tui 的 `wrapTextWithAnsi` / `visibleWidth` 与
 * 真主题 —— 于是框里的折行与 pi 自己的组件逐字节一致（CJK 逐字断、长词硬断）。
 *
 * ## 为什么宽度要由调用方给
 *
 * `ctx.ui.select()` 在 pi 里是 `ExtensionSelectorComponent`：`DynamicBorder` 满宽、
 * `Text` 的 `paddingX = 1`，整块标题区都渲染在**终端宽度**里。所以调用方把
 * `process.stdout.columns` 传进来，框就能正好撑满对话框的内容区（用户 2026-10-27 选的是
 * 撑满，不是按内容自适应）。终端极窄时内宽夹到下限，框会退化成窄条而不是崩溃。
 *
 * ## 行数怎么算
 *
 * `FRAME_INSET` 是框在**一行里**吃掉的列数（左右边框各 1 + 框内左右各 1 列留白），
 * `FRAME_HEIGHT` 是框吃掉的**行数**（上下两条横线）。批准弹框的截断预算必须与这里同一个
 * 口径（见 `plan-text.ts` 的 `dialogPlanBudget`），否则框里的正文会二次折行、右边框被挤
 * 到下一行去。
 *
 * ## 上色
 *
 * 正文逐**视觉行**包 `BODY_SLOT`（`text`，与 `consent.ts` 同一个槽、同一个逐行包的理由：
 * 外层 accent 会给整个 title 上色，内层显式颜色才盖得住，而且 pi-tui 按行重置样式）。
 * 补位空格放在色码**外面** —— 它是几何，不是正文，不该被涂色。边框走 `dim` 槽
 * （用户 2026-10-27 定：与 plan-mode 自己的树前缀 `│` `└` 同一个槽，本地几套皮肤的
 * `dim` 都指向注释色/dimmed，比正文暗一档、不抢正文字）。
 */

import { BODY_SLOT, type BodyTheme } from "./consent.ts";

/** 框线用的语义槽（与 plan-mode 树前缀 `│` `└` 同槽）。 */
export const FRAME_SLOT = "dim";

/** 框在一行里吃掉的列数：左/右边框各 1 + 框内左右各 1 列留白。 */
export const FRAME_INSET = 4;

/** 框吃掉的行数：上边框 + 下边框。 */
export const FRAME_HEIGHT = 2;

/** 框内正文的可用列宽（`columns` 是终端列数 = 对话框 contentWidth）。 */
export function bodyTextWidth(columns: number): number {
	return Math.max(4, columns - FRAME_INSET);
}

/** 折行能力：注入 pi-tui 的 `wrapTextWithAnsi` 就能得到与 pi 组件一致的行数。 */
export type FrameWrapFn = (text: string, width: number) => string[];

/** 可见宽度量度：注入 pi-tui 的 `visibleWidth`（ASCII 1 列、CJK 2 列、ANSI 不计）。 */
export type FrameMeasureFn = (text: string) => number;

/** 画框所需的窄依赖（生产侧由 `index.ts` 注入，测试里给恒等实现）。 */
export interface FrameDeps {
	/** 终端列数（`process.stdout.columns`）：框撑满这一宽度。 */
	columns: number;
	/** 折行（运行时是 pi-tui 的 `wrapTextWithAnsi`）。 */
	wrap: FrameWrapFn;
	/** 可见宽度（运行时是 pi-tui 的 `visibleWidth`）。 */
	measure: FrameMeasureFn;
}

/**
 * 把正文装进线框，返回可直接拼进对话框 title 的多行字符串。
 *
 * - 正文按**行**处理（markdown 的换行结构原样保留：空行也占一行，段落间距是要读的）；
 *   每行再按框内宽度折行，折出来的每一片都是独立的一行、各自封左右边。
 * - 空串返回空串（调用方据此决定要不要画这一段），纯空白的正文也不画框。
 *
 * 形状：
 *
 * ```
 * ┌──────────────────────┐
 * │ 它的理由：……          │
 * │                       │
 * │ 直接实施：……          │
 * └──────────────────────┘
 * ```
 */
export function frameBody(theme: BodyTheme, text: string, deps: FrameDeps): string {
	const sourceLines = text.replace(/\r\n/g, "\n").split("\n");
	if (text.trim() === "") return "";

	const inner = bodyTextWidth(deps.columns);
	const rows: string[] = [];
	for (const line of sourceLines) {
		// wrap("") 返回 [""]，空行因此照样占一行 —— 段落间距不能压掉。
		rows.push(...deps.wrap(line, inner));
	}

	const border = (chars: string): string => theme.fg(FRAME_SLOT, chars);
	const top = border(`┌${"─".repeat(inner + 2)}┐`);
	const bottom = border(`└${"─".repeat(inner + 2)}┘`);
	const rail = border("│");
	const body = rows.map((row) => {
		// 色码只包正文；补位空格在色码外（几何不是内容）。
		const painted = row === "" ? "" : theme.fg(BODY_SLOT, row);
		const padding = Math.max(0, inner - deps.measure(row));
		return `${rail} ${painted}${" ".repeat(padding)} ${rail}`;
	});
	return [top, ...body, bottom].join("\n");
}
