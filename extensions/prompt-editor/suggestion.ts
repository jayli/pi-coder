/**
 * 回合结束后输入框里的「下一步建议」（Claude Code ghost suggestion 的同构物）+ 生成它的
 * 模型请求（提示词组装 / 回复清洗）。
 *
 * ## 需求（用户 2026-10-20 定）
 *
 * 一轮对话结束后，**空输入框**里显示一句灰色的下一步建议；按 Tab 整句填进输入框（只填入、
 * 不发送）；一旦开始打字就消失（只消失，见下一段）。形态选单条、样式选只有灰字（dim，不铺底色）、
 * 文案跟随会话模型生成。
 *
 * **删除与隐藏是两件事**（用户 2026-10-21 补齐）：可见判据（`isSuggestionVisible`）只管
 * 「这一帧画不画」，打字只让建议**隐藏**、不清掉；只要还没进入下一轮（也没压缩 / 没换会话），
 * 光标把输入框删空、这一行重新轮到显示占位符时，画的就是这句建议。所以建议的清除点只有
 * `prompt-editor.ts` 里的「Tab 接受 / 回车提交 / 下一轮开始 / `session_compact` / `session_start`」。
 *
 * ## 为什么和 `placeholder.ts` 是两个模块
 *
 * 两者共用同一条首行渲染分支（`prompt-editor.ts` 的 `render()`），但判据与排布都不同：
 *
 *   - 占位符是**静态**的「这里可以写字」，行首缩进两格、首字素是光标格（反显落在插入点）；
 *   - 建议是**动态**的「接着可以做这事」，行首缩进**两格**（用户 2026-10-20 定，与占位符同宽），
 *     首字素就是光标格 —— 与占位符「反显格 + 其后上色」同一套排布。
 *
 * 合成一个模块只会让两套判据互相污染（建议有优先级、要能整体清空、要在 Tab 之后立刻消失），
 * 所以渲染分两份、调用方一个 `if`。
 *
 * >> 注意 `isSuggestionVisible` 只回答「这一帧画不画」，**不是**「建议还在不在」：打字后退格
 * >> 回空输入框要能重新露出同一句（用户 2026-10-21 报的就是这个），所以调用方不能拿它当
 * >> 清除条件 —— 隐藏归渲染层，删除归事件层。
 *
 * ## 缩进同时属于渲染与填入（用户 2026-10-20 定）
 *
 * 建议画在行首那两格缩进之后；**按 Tab 填入的正文也带这两格**（`suggestionFillText`），于是文字
 * 停在原地、不会因为接受而往左跳两列。缩进只活在显示侧（模型回复 / 清洗结果都不带它），两处
 * 共用 `SUGGESTION_INDENT` 一个常量，分别写死就会再度错位。
 *
 * ## 光标格的处理（沿用 2026-10-19 定下的规矩）
 *
 * 建议的首字素就是光标格（硬件光标住在正文第 0 列，也就是建议的第一个字上），且它同样
 * **不染色**：`Input` 组件把反显套在已着色的文字上，灰会被当底色画成一个灰块，光标于是变成
 * 灰色。这里反显块用默认前景色，dim 只包后面的文字 —— 与真编辑器里空输入框的光标一模一样。
 *
 * ## 本文件不 import pi / pi-tui
 *
 * 宽度量测、截断、着色、反显全部由调用方注入（真实现是 `visibleWidth` / `truncateToWidth` /
 * `theme.fg("dim")` / `renderFakeCursor`），于是 `node --test` 直接断言排布顺序与清洗矩阵，
 * 不需要起 TUI。真编辑器的端到端在 `render.test.ts`。
 */

/** 建议行的光标格：没有字可画时（极窄终端 / 空建议）才用空格占位。 */
export const SUGGESTION_CURSOR_CELL = " ";

/**
 * 建议行首缩进（用户 2026-10-20 定：两个空格，与占位符同宽；一格看着太挤，又加了一格）。
 *
 * 渲染与 Tab 填入**共用**这一份：建议画在缩进之后，按 Tab 填入的正文也带同样的缩进，
 * 文字就不会在按下的那一刻往左跳两列（用户 2026-10-20 报的就是这个）。所以它不只是排版量 ——
 * `buildSuggestionLine` 与 `suggestionFillText` 必须用同一个值，两处分别写死就会再度错位。
 */
export const SUGGESTION_INDENT = "  ";

/** 清洗后建议文案的字符数上限（按码点计）。渲染层另有可见宽度截断，这里只防模型跑飞。 */
export const MAX_SUGGESTION_TEXT_CHARS = 240;

/**
 * 喂给模型的对话摘要上限（字符）。只要「刚才在干什么」这层语义，更长部分对「下一步」没有
 * 增量信息，请求体越大越慢。
 */
export const MAX_REQUEST_INPUT_CHARS = 3000;

/** 宽度工具，由调用方注入真实现（`pi-tui` 的 `visibleWidth` / `truncateToWidth`）。 */
export interface SuggestionMetrics {
	widthOf(text: string): number;
	/** `ellipsis` 由调用方给（真实现传 `"…"`），与 `truncateToWidth(text, width, ellipsis)` 同义。 */
	truncate(text: string, width: number, ellipsis: string): string;
}

/** 着色与光标，由调用方注入（`theme.fg("dim", …)` / `CURSOR_MARKER` / `renderFakeCursor`）。 */
export interface SuggestionChrome {
	style(text: string): string;
	/** 聚焦时才有的零宽标记；未聚焦传空串。 */
	cursorMarker: string;
	/** 把光标格画成反显（真实现是 `pi-tui` 的 `renderFakeCursor`）。 */
	renderFakeCursor(text: string): string;
}

/** 建议开关：`PI_EDITOR_SUGGEST=off` 关掉（默认开）。 */
export function resolveSuggestionEnabled(raw: string | undefined): boolean {
	return (raw ?? "").trim().toLowerCase() !== "off";
}

/**
 * 建议的可见判据：**输入框必须严格为空**。敲一个空格就算有内容 —— 建议是「还没开始写，
 * 接着可以做什么」，不是「这里没写有意义的东西」。
 */
export function isSuggestionVisible(text: string): boolean {
	return text.length === 0;
}

/**
 * 这条 assistant 消息算不算「本轮的结论」—— 决定要不要**立刻**猜下一步（用户 2026-10-20 定：
 * 不等 pi-subagents 的 watchdog 审完）。
 *
 * 为什么需要它：`turn_end` 每条消息都发（一轮里几十条），只有「模型这一轮真的说完了」那一条
 * 才是猜下一步的时机。pi 的 stopReason 已经把姿态说清楚了：
 *   - `stop`：这一轮说完了（有没有工具调用另看内容）；
 *   - `toolUse`：还要接着调工具，是中间态；
 *   - `length`：输出被 token 上限截断，pi 可能接着做恢复（不是结论）；
 *   - `error` / `aborted`：失败轮次。
 * 另加两条内容检查：至少一个非空 text 块（只有 thinking 的 stop 没有可猜的上下文），且不能有
 * toolCall 块（双保险：正常 provider 会把带工具调用的消息标成 `toolUse`）。
 *
 * 与 `voice/controller.ts` 的 `isConcludingMessage` 同义 —— 故意重复而不是跨扩展 import：
 * 两个扩展能各自单独安装 / 卸载，谁都不该依赖另一个的文件存在。
 */
export function isConcludingReply(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: unknown; stopReason?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || candidate.stopReason !== "stop") return false;
	if (!Array.isArray(candidate.content)) return false;

	let hasText = false;
	for (const block of candidate.content) {
		const part = block as { type?: unknown; text?: unknown };
		if (part?.type === "toolCall") return false;
		if (part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
			hasText = true;
		}
	}
	return hasText;
}

/**
 * 切成「第一个字素 / 其余」。首字素要单独交给 `renderFakeCursor`，所以不能用 `text[0]` ——
 * emoji 是代理对、`e` + 组合重音是两个码位一个字形，切错会把半个字反显。
 * （与 `placeholder.ts` 里同名的工具重复，是故意的：两个模块互不依赖，各自单独可测。）
 */
function splitFirstGrapheme(text: string): { head: string; rest: string } {
	const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
	const head = segments[0]?.segment ?? "";
	return { head, rest: text.slice(head.length) };
}

/**
 * Tab 接受时要填进输入框的正文：模型给的建议原文 + 行首那两格缩进。
 *
 * 为什么填入也要带缩进（用户 2026-10-20 报的错）：建议是画在 `SUGGESTION_INDENT` 之后的，
 * 只填原文会让整句话在按下 Tab 的那一刻往左跳两列 —— 眼睛正盯着它，于是看起来像输入框抖了一下。
 * 缩进进正文还有个副作用是好的：填完直接回车发出去的指令也带着它。
 * 空文案返回空串（不能单独填两个空格进去）。
 */
export function suggestionFillText(text: string): string {
	return text === "" ? "" : SUGGESTION_INDENT + text;
}

/**
 * 渲染建议那一行。返回的字符串**已是满宽**（不足补空格），可以直接放进 Editor 的正文行位：
 * Editor 每行都铺满 contentWidth，少一列会在差分渲染器下留残影。
 *
 * 排布与 `buildPlaceholderLine` 同形（`marker + fakeCursor(首字素) + style(其余) + padding`），
 * 连缩进宽度也一样：行首补**两格**（`SUGGESTION_INDENT`），首字素于是是第一格缩进空格、它就是
 * 光标格 —— 硬件光标 / IME 候选窗仍在正文第 0 列（插入点），关掉硬件光标时缩进第一格反显。
 * 这与 pi-tui `Input` 的 placeholder 分支一致，只不过没有提示符前缀。
 * 缩进也算进可用宽度：窄终端先吃掉缩进，再截文案（与补满宽度的量口径一致）。
 *
 * 首字素刻意不过 `style`：反显块必须用默认前景色，否则会把 `dim` 灰当底色画成一个灰块
 * （2026-10-19 定下的规矩）。超宽按可见宽度截断并补 `ellipsis`：建议是一句话，宁可切掉尾巴
 * 也不折行（折行会把下边框往下推，输入框高度随建议长度跳动）。
 */
export function buildSuggestionLine(
	text: string,
	width: number,
	metrics: SuggestionMetrics,
	chrome: SuggestionChrome,
	ellipsis = "…",
): string {
	const available = Math.max(1, width);
	// 宽度只够一格时先保光标（反显块是插入点，比半个省略号更有用）
	if (available < 2) return chrome.renderFakeCursor(SUGGESTION_CURSOR_CELL);
	// 渲染层假设文案已单行（`cleanSuggestionText` 保证），但换行一旦漏进来会把这一行拆成两行、
	// 把输入框下边框顶下去，所以这里再折一次谷。
	const flat = text.replace(/\r\n|[\n\r\u0085\u2028\u2029]/g, " ");
	// 行首那两格缩进进截断输入，于是它们也跟着限宽一起被吃掉（窄终端先丢缩进再丢文案）
	const clipped = metrics.truncate(SUGGESTION_INDENT + flat, available, ellipsis);
	const { head, rest } = splitFirstGrapheme(clipped);
	// 截断后一个字符都不剩（极窄终端 + 宽字符首字素）：光标总得有个落点
	const cursorCell = head.length > 0 ? head : SUGGESTION_CURSOR_CELL;
	const painted = chrome.cursorMarker + chrome.renderFakeCursor(cursorCell) + chrome.style(rest);
	const padding = " ".repeat(Math.max(0, available - metrics.widthOf(painted)));
	return painted + padding;
}

// ── 模型请求 ────────────────────────────────────────────────────────────────

/** 按码点截断（不切半个代理对）：超长时末尾补 `…` 表示「被截了」。 */
function clipToPoints(text: string, maxPoints: number): string {
	const points = [...text];
	if (points.length <= maxPoints) return text;
	return `${points.slice(0, maxPoints).join("")}…`;
}

/**
 * 请求提示词。输入是调用方拼好的 conversation digest（用户最后一条请求 + 助手最后一轮可见
 * 回复 + 本轮调用过的工具名，见 `prompt-editor.ts` 的 `buildDigest`）。
 *
 * 四条约束都对应一条真实失败形态：
 *   1. **一行、不加引号 / markdown / 标签**：终端里那格只有一行，装饰会原样显示；
 *   2. **同语言**：中文会话给英文建议会很别扭；
 *   3. **是「下一步的指令」而不是「总结」**：让模型写「跑一下测试」而不是「你刚改完三个文件」；
 *   4. **不重复已经做过的事**：否则建议会是「读一下 X」——那一步刚做完。
 */
export function buildSuggestionRequestPrompt(digest: string, targetWidth: number): string {
	const input = clipToPoints(digest, MAX_REQUEST_INPUT_CHARS);
	return [
		"You predict the user's next message in a terminal coding agent.",
		"The user just finished a turn with the assistant. Write the single most likely next instruction the user would type.",
		"",
		"Rules:",
		`- One line, at most about ${targetWidth} display columns wide. A CJK/full-width character counts as 2 columns, an ASCII character as 1. Stay clearly under the limit rather than at it.`,
		"- Write it as an instruction addressed to the assistant (imperative), the way the user would type it.",
		'- No line breaks, no quotes, no markdown, no label like "Next:" or "建议：", no explanation — only that line.',
		"- Do not repeat work that was already done in this turn. Prefer the obvious follow-up step (verify, fix the remaining failure, continue the plan, or answer the open question).",
		"- Write in the same language as the user's latest message.",
		"",
		"Conversation:",
		input,
	].join("\n");
}

/** 「建议」这类标签词本身（模型时不时自己加一个）。 */
const LABEL_TEXT = "(?:next(?: step| message| prompt)?|suggestion|next:?|建议(?:下一步)?|下一步(?:建议|指令)?|接下来|后续)";

/** 标签前缀：`Next:` / `建议：`，容忍两种粗体包裹。 */
const LABEL_PREFIX_RE = new RegExp(
	`^(?:\\*\\*|__)?${LABEL_TEXT}(?:\\*\\*|__)?\\s*[:：]\\s*(?:\\*\\*|__)?\\s*`,
	"i",
);

/** 整行只有标签本身（`Next` / `**建议**`）：不是建议内容，该行跳过。 */
const LABEL_ONLY_RE = new RegExp(`^(?:\\*\\*|__)?${LABEL_TEXT}(?:\\*\\*|__)?\\s*[:：]?$`, "i");

/** 成对包裹的引号 / 书名号（ASCII 直引号与中文成对符号）。 */
const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
	["《", "》"],
	["`", "`"],
];

/** 行首的列表 / 编号 / 箭头标记。 */
const LEADING_MARKER_RE = /^\s*(?:[-*+•·]\s+|\d+[.)]\s+|(?:=>|->|→)\s*)/;

/** 剥一层装饰：列表标记 → 标签前缀 → 整体包裹的引号 → 整体包裹的 `**`/`__`。 */
function stripDecoration(text: string): string {
	let out = text.replace(LEADING_MARKER_RE, "").replace(LABEL_PREFIX_RE, "").trim();
	for (const [open, close] of WRAPPING_QUOTES) {
		if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
			const inner = out.slice(open.length, out.length - close.length).trim();
			if (inner !== "") {
				out = inner;
				break;
			}
		}
	}
	return out.replace(/^(\*\*|__)(.+)\1$/, "$2").trim();
}

/**
 * 清洗模型回复。返回空串表示这次请求没有可用结果 —— 调用方按「不显示建议」处理，不重试、
 * 不报错（建议只是增强）。
 *
 * 规则：
 *   - **只取第一行有效内容**（模型偶尔先写一行标签 / 围栏标记，再写正文）；
 *   - 逐行折叠空白、去掉首尾空白；
 *   - 剥列表标记 / 标签前缀 / 整体引号 / 整体粗体，最多迭代四轮（`**"建议：xx"**` 这种叠着的）；
 *   - 去不掉多行的部分一律丢弃（建议必须是单行）。
 */
export function cleanSuggestionText(raw: string): string {
	for (const line of raw.split(/\r\n|[\n\r\u0085\u000b\u000c\u2028\u2029]/)) {
		let text = line.replace(/\s+/g, " ").trim();
		if (text === "") continue;
		if (/^```/.test(text)) continue;
		for (let round = 0; round < 4; round++) {
			const next = stripDecoration(text);
			if (next === text) break;
			text = next;
		}
		if (text === "" || LABEL_ONLY_RE.test(text)) continue;
		return clipToPoints(text, MAX_SUGGESTION_TEXT_CHARS);
	}
	return "";
}

/**
 * 组装喂给模型的对话摘要。空块自动跳过，整体超长由 `buildSuggestionRequestPrompt` 再截一道。
 *
 * 三段都是可选的（有些回合没有工具调用，有些回合助手只回了一句话），全空时返回空串 ——
 * 调用方据此跳过请求。
 */
export function buildSuggestionDigest(parts: {
	userPrompt: string | null;
	assistantReply: string | null;
	toolNames: readonly string[];
}): string {
	const lines: string[] = [];
	const user = (parts.userPrompt ?? "").trim();
	if (user !== "") lines.push(`User asked: ${user}`);
	const reply = (parts.assistantReply ?? "").trim();
	if (reply !== "") lines.push(`Assistant answered: ${reply}`);
	const tools = [...new Set(parts.toolNames.filter((name) => name !== ""))];
	if (tools.length > 0) lines.push(`Tools used: ${tools.join(", ")}`);
	return lines.join("\n");
}
