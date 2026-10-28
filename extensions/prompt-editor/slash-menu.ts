/**
 * 补全菜单（输入 `/` 弹出的命令列表）里**选中行**的配色（用户 2026-10-28 定）。
 *
 * 现象：列表里选中的那一行只是把字换成 `accent` 色，**不铺任何底色** —— 一整屏命令里
 * 只有字色差一点，混在一堆灰描述里很难一眼定位光标停在哪一行。期望：选中行 = `accent`
 * 前景 + prompt message 的底色（`userMessageBg`，与用户消息块同一个 surface）。
 *
 * 为什么只能在这层改：pi 的 `getSelectListTheme()` 把选中行写成
 * `selectedText: (t) => theme.fg("accent", t)` —— **只有前景**，同一份代码里 `theme.bg(…)`
 * 一次都没用（整个 bundle 的 select-list 路径上 `selectedBg` 只出现在主题元数据与系统主题
 * 求解里）。所以这是上游漏掉的一个槽位，不是皮肤配错了：换任何皮肤都只换字色。
 *
 * 为什么不去替换 `SelectList` / `Editor`：编辑器里 `autocompleteList` / `autocompletePrefix`
 * 都是 private 字段，pi 一次改名就静默失效；而 prompt-editor 本来就继承 `CustomEditor` 并
 * 整行改写渲染结果（gutter / 列表左移 / 下方空行都是这么来的），在**输出层**做零私有依赖。
 * 判据只用一个公开可见的事实：选中行的可见文字以 `→ ` 开头
 * （`pi-tui` 的 `SelectList.renderItem` 里写死的字面量 `→ ` / `  `）。
 *
 * **整行铺满**（用户 2026-10-28 定：从行首到行尾都要有底色）：行首 gutter 的空白列、
 * 描述之后的补白全部上色，`padTo` 再把它一路补到编辑器右边界，屏幕上才是一条完整的选中条
 * （宽度度量由调用方注入，它才有终端列数）。
 *
 * **次序不能反：先剥掉行里已有的 SGR，再整体上一次色。** ANSI 是状态机 ——
 * 在 `fg(accent)` 已经开着的行里追加 `bg(...)`，尾部的 `\x1b[49m` 只还原底色、不动前景，
 * 看着"能用"，但描述里自带的 `dim`（`\x1b[2m … \x1b[22;39m`）会把那一段之后的前景洗回
 * 默认色，于是半行 accent、半行白字。剥干净再染一遍是唯一稳定的做法；代价是描述丢掉自己的
 * `muted` 灰 —— 用户要的正是整行同一种前景色（`accent`）。
 *
 * 纯字符串处理：不 import pi / pi-tui，也不量宽度（真实现由调用方注入）。重绘只换 SGR
 * 与追加空格，不动任何原有可见字符，所以已有内容的列位不变 —— 这一点是它比「重新拼一遍行」
 * 更安全的原因：CJK / emoji / 折行统统不需要重新计算。
 */

/** 选中行的可见前缀（`pi-tui` `SelectList.renderItem` 里的字面量，跟着上游即可）。 */
export const SELECTED_PREFIX = "→ ";

/**
 * 行内一切零宽序列：CSI（含 SGR、光标反显）、APC 的 `CURSOR_MARKER`、OSC。
 * 与 `prompt-editor/render.test.ts` 的 `plainLines` 同一套口径。
 */
const ZERO_WIDTH = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** 解 `PI_EDITOR_SLASH_MENU`：`off` 关闭，其余（含未设）开启。 */
export function resolveSlashMenuHighlight(raw: string | undefined): boolean {
	return (raw ?? "").trim().toLowerCase() !== "off";
}

/**
 * 重绘一侧的参数。宽度量测由调用方注入（与 `prompt-editor/placeholder.ts` 同一条约定），
 * 于是这个模块依然不 import pi / pi-tui。
 */
export interface RowPaintOptions {
	/** 拿整行可见文字（已剥 SGR、已补齐）换一条上完色的行。 */
	paint(text: string): string;
	/**
	 * 目标可见宽度。给了就把行**补到这么宽再上色** —— 补白必须落在着色区**里面**，
	 * 否则行尾那几格就是白底（用户 2026-10-28 定：整行从头到尾都要有底色）。
	 * 不给就按原宽度重绘。
	 */
	padTo?: number;
	/** 量宽（`pi-tui` 的 `visibleWidth`）；`padTo` 未给时用不上。 */
	widthOf?(text: string): number;
}

/** 去掉零宽序列，只留可见文字（用来判断这一行是谁、以及重绘前清场）。 */
export function stripAnsi(text: string): string {
	return text.includes("\x1b") ? text.replace(ZERO_WIDTH, "") : text;
}

/**
 * 这一行是不是补全列表的选中行。
 *
 * 只看可见文字：选中行是 `→ ` + 命令名 + 描述，未选中行是两格空格 + 命令名。
 * 命令名来自注册的命令 / 技能 / 模板（字母数字与 `:_-`），不可能以 `→` 开头，
 * 所以这里不会和「描述里恰好有箭头」的情形混淆。
 */
export function isSelectedAutocompleteRow(line: string): boolean {
	return stripAnsi(line).trimStart().startsWith(SELECTED_PREFIX);
}

/**
 * 把**整行**重绘成一种颜色（用户 2026-10-28 定：从行首到行尾都要有底色）。
 *
 * 行首 gutter 的空白列、描述之后的补白全部铺满，`padTo` 再把它一路补到编辑器右边界，
 * 屏幕上才是一条完整的选中条。剥掉行内已有 SGR → 补白 → 整行交给 `paint` 一次画完；
 * 可见字符一个不变（只换 SGR，补白是新增的尾巴），所以不影响已有内容的列位。
 *
 * 不是选中行时**原样返回同一个字符串**（调用方据此判断有没有改动）。
 */
export function paintSelectedRow(line: string, options: RowPaintOptions): string {
	const plain = stripAnsi(line);
	if (!isSelectedAutocompleteRow(plain)) return line;
	const padWidth = options.padTo;
	const widthOf = options.widthOf;
	if (padWidth === undefined || widthOf === undefined) return options.paint(plain);
	const pad = padWidth - widthOf(plain);
	return options.paint(pad > 0 ? plain + " ".repeat(pad) : plain);
}

/**
 * 对编辑器渲染出来的所有行做一次「选中行重绘」。只有真的改动了某一行才返回新数组，
 * 否则返回原数组（避免每帧都造新对象喂给差分渲染器）。
 */
export function paintAutocompleteRows(lines: string[], options: RowPaintOptions): string[] {
	let changed = false;
	const out = lines.map((line) => {
		const next = paintSelectedRow(line, options);
		if (next !== line) changed = true;
		return next;
	});
	return changed ? out : lines;
}
