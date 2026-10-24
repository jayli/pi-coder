/**
 * 空输入框的占位符排版（纯逻辑）。
 *
 * 需求（用户 2026-10-19 定）：输入框里一个字都没有时，显示一句灰提示
 * `Type your message or @file`，颜色与回合结束行 `✻ Flickering for 7m 2s · done 11:37 PM`
 * 同档 —— 也就是 `dim` 槽（`working-indicator/turn-marker.ts` 的 `TURN_MARKER_COLOR`）。
 *
 * 刻意不 import pi / pi-tui（与 `bash-prompt.ts`、`thinking-collapse/window.ts` 同一条约定）：
 * 宽度量测、截断、着色、反显光标全靠调用方注入，于是 `node --test` 能直接断言排布顺序，
 * 不需要起一个真 TUI。真 tui 的端到端在 `render.test.ts`。
 *
 * 三个决定（改之前先看）：
 *   - **只有严格空串才显示**：敲一个空格就算「有内容」，占位符立刻消失。不 trim —— 提示是
 *     「这里还没写东西」，不是「这里没写有意义的东西」；
 *   - **形状照抄 pi-tui 的 `Input` 组件**（`components/input.js` 的 placeholder 分支）：光标标记
 *     打在文字最前面、首字素交给 `renderFakeCursor` 反显、其余文字上色、末尾补空格到满宽。
 *     这样硬件光标 / IME 候选窗仍停在正文第 0 列，关掉硬件光标时首字素反显 —— 与 pi 自己的
 *     输入框行为一致，而不是另造一套；
 *   - **截断不加省略号**：`Input` 用 `truncateToWidth(text, width, "")`，终端太窄时宁可切掉
 *     尾巴也不写 `…`（提示文案不该抢视觉重量）。
 *
 * **光标格不染色**（用户 2026-10-19 定：「光标还是原来什么颜色就什么颜色」）。这是与 `Input`
 * 分支唯一的偏离：`Input` 把反显光标套在**原文字色**上，而占位符文字是 `dim` 灰，套上去反显
 * 就把灰当底色画成一个灰块 —— 光标于是变了色。所以首字素（行首缩进的第一格，也就是插入点）
 * 不进 `style`，反显块回到底色 / 默认前景色，与真编辑器里空输入框的光标一模一样；灰色只包住
 * 它后面的文案。
 */

/** 占位符文案（用户 2026-10-19 给的原文，不做 i18n / 不做变量替换）。 */
export const PLACEHOLDER_TEXT = "Type your message or @file";

/**
 * 占位符行首缩进（用户 2026-10-19 定：两个空格）。
 *
 * 它是**占位符行自己的**缩进，不是正文的：真打字开始时缩进就没了，正文仍然从第 0 列起，
 * 硬件光标也一直在第 0 列 —— 所以这里不需要任何坐标换算。反过来，「首字素反显」落在缩进的
 * 第一个空格上（而不是字母 `T` 上），反显块正好就在插入点，和真编辑器里光标所在列一致。
 */
export const PLACEHOLDER_INDENT = "  ";

/**
 * 解 `PI_EDITOR_PLACEHOLDER`：未设 → 默认文案；`off` → 关闭；其余非空值 → 当文案用。
 * 单独抽出来是因为环境变量在模块求值时就固化了，只有纯函数才能单测。
 */
export function resolvePlaceholder(raw: string | undefined): { enabled: boolean; label: string } {
	const value = (raw ?? "").trim();
	if (value.toLowerCase() === "off") return { enabled: false, label: PLACEHOLDER_TEXT };
	return { enabled: true, label: value === "" ? PLACEHOLDER_TEXT : value };
}

/** 占位符行要用的宽度工具，由调用方注入真实现（`pi-tui` 的 `visibleWidth` / `truncateToWidth`）。 */
export interface PlaceholderMetrics {
	widthOf(text: string): number;
	truncate(text: string, width: number): string;
}

/** 着色与光标，由调用方注入（`theme.fg("dim", …)` / `CURSOR_MARKER` / `renderFakeCursor`）。 */
export interface PlaceholderChrome {
	style(text: string): string;
	/** 聚焦时才有的零宽标记；未聚焦传空串。 */
	cursorMarker: string;
	/** 把光标格画成反显（真实现是 `pi-tui` 的 `renderFakeCursor`）。 */
	renderFakeCursor(text: string): string;
}

/** 空输入框才显示占位符。 */
export function isPlaceholderVisible(text: string): boolean {
	return text.length === 0;
}

/**
 * 切成「第一个字素 / 其余」。首字素要单独交给 `renderFakeCursor`，所以不能用 `text[0]` ——
 * emoji 是代理对、`e` + 组合重音是两个码位一个字形，切错会把半个字反显。
 */
export function splitFirstGrapheme(text: string): { head: string; rest: string } {
	const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
	const head = segments[0]?.segment ?? "";
	return { head, rest: text.slice(head.length) };
}

/**
 * 渲染占位符那一行。返回的字符串**已是满宽**（不足补空格），可以直接放进 Editor 的正文行位，
 * 因为 Editor 每行都铺满 contentWidth，少一列会在差分渲染器下留残影。
 *
 * 顺序：`marker + fakeCursor(首字素) + style(其余) + padding`。
 * 首字素是**光标格**，刻意不过 `style` —— 反显它得到的块必须用默认前景色，否则会把 `dim` 灰
 * 当底色画成一个灰块（原因见文件头）。
 */
export function buildPlaceholderLine(
	text: string,
	width: number,
	metrics: PlaceholderMetrics,
	chrome: PlaceholderChrome,
): string {
	// 宽度夹到至少 1 列：终端极窄时光标仍要有一格可画（`Input` 在 availableWidth <= 0 时
	// 直接只画 prompt，我们这里没有 prompt 可退，所以退化成「第一格」）。
	const available = Math.max(1, width);
	// 缩进也算在可用宽度里：窄终端先吃掉缩进，再截文案（与补满宽度的量口径一致）
	const clipped = metrics.truncate(PLACEHOLDER_INDENT + text, available, "");
	const { head, rest } = splitFirstGrapheme(clipped);
	// 截断后一个字符都不剩（宽度 1 且首字素是宽字符时的极端情况）：空串交给 renderFakeCursor
	// 会画出一个没有内容的反显格，干脆退回一个空格 —— 光标总得有个落点。
	const cursorCell = head.length > 0 ? head : " ";
	// 光标格不染色：反显块要跟真编辑器一样用默认前景色，染了 `dim` 就变成灰块
	const painted =
		chrome.cursorMarker + chrome.renderFakeCursor(cursorCell) + chrome.style(rest);
	const padding = " ".repeat(Math.max(0, available - metrics.widthOf(painted)));
	return painted + padding;
}
