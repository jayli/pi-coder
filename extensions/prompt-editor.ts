/**
 * 输入框视觉层微调：① 提示符 "›"（`!` bash 模式换成 "!"）；
 * ② 补全列表与 statusline 之间留一行空行。
 *
 * ① 提示符实现方式：继承 CustomEditor，把真正的编辑区收窄 gutter 列（super.render(width - gutter)），
 * 再把 gutter 补回每一行的左侧：
 *   - 上/下边框：由 renderTopBorder / renderBottomBorder 自己补满，保持边框满宽
 *   - 第一行文本（未滚动时）→ "› "，bash 模式（正文以 `!` 开头）→ "! "
 *   - 普通 `›` 走自己的配色：`accent` 槽 + **加粗**（用户 2026-10-28 定，原先用 `warning`
 *     槽，同日改回 `accent`）；bash 模式的 `!` 仍用边框色（= pi 的 bashMode 色），两边不打架
 *   - 其余文本行 / 自动补全行 → 等宽空格
 * 光标位置由行内的 CURSOR_MARKER 决定，跟着文本一起右移，所以硬件光标 / IME 定位不受影响；
 * 鼠标点击坐标同样左移 gutter 列后再交给父类（bash 模式再多算一列隐藏的 `!`），点击定位保持准确。
 *
 * ② 补全列表与 statusline 的空行：Editor.render() 把补全列表渲染在**编辑器底边框之后**
 * （editor.js：renderBottomBorder 之后才 push autocompleteList.render()），而 statusline 紧跟
 * 在编辑器下方，所以输入 "/xxx" 时补全列表会紧贴 statusline。这里在补全列表真的渲染了的时候
 * 追加一行空白行（只在有补全列表时补，静态布局不变）。判据用公开的 isShowingAutocomplete()
 * （= autocompleteState !== null），而 Editor 里 state 与 autocompleteList 总是一起设置 / 一起清除
 * （clearAutocompleteUi），所以它与“列表真的渲染了”严格同步，不必碰 private 的
 * renderedAutocompleteHeight。空白行按 pi 自己的惯例补满宽度（Editor 每行都 pad 到
 * contentWidth），避免差分渲染器只写变化前缀时留残影。
 * 鼠标不受影响：空白行在补全列表之下（超出 autocompleteStartRow + renderedAutocompleteHeight），
 * 落到 Editor.handleMouse 的“超出可见行”分支；Container 的鼠标分派用 render().length 算子组件
 * 高度，所以高度 +1 后下方组件的坐标仍然对得上。
 *
 * 为什么不开第三个编辑器包装器扩展：`ctx.ui.setEditorComponent()` 是**替换**而非叠加，
 * prompt-editor 的工厂会直接丢掉之前的包装（README 里 folder-history 就是被这个顺序坑过）。
 * 所以这个改动放在已经拥有编辑器子类的本文件里，不新增任何加载顺序约束。
 *
 * Editor 的 theme / scrollOffset / renderedAutocompleteHeight 都是 private，
 * 所以这里只用 protected 的 renderTopBorder/renderBottomBorder 拿到需要的信息。
 *
 * ③ 补全列表左移：Editor 把补全列表渲染在底边框之后，PromptEditor 又给每一行补了 gutter
 * 列，于是命令词落在第 gutter+2 列（"→ " 前缀占 2 列）。这里让底边框之后的补全行少补
 * shift 列空格（默认 shift = 1，即整个列表含选择箭头左移一列）。
 * 渲染器对每条变化行先写 \x1b[2K 整行清除，补全行变短不会留残影；SelectList.handleMouse
 * 只用 event.y 定位，左移不影响鼠标点选。
 *
 * ④ `!` bash 模式（对齐 Claude Code）：输入框第一个字符是 `!` 时，gutter 的 `›` 换成 `!`，
 * 正文里那个 `!` 不再显示 —— 于是正文看起来就是命令本身，而光标/IME/点选都还在它原来那一列。
 * 模式判定、Enter 提交（`text.startsWith("!")`）、↑ 历史、Esc 清空全部沿用 pi 自己的链路
 * （`interactive-mode.js` 的 `onChange` 是 `text.trimStart().startsWith("!")`，边框颜色用的就是它），
 * 这里只把渲染层对齐过去：判定与摘除在 `./prompt-editor/bash-prompt.ts`（纯逻辑，可单测）。
 * 三处细节：
 *   - 正文一个字符都不动（隐藏只是画法），所以 pi 那边的颜色/提交/历史不需要任何配合；
 *   - 隐藏掉一列后，正文整体左移一列 —— 渲染时把首行摘掉一个 `!` 再补一个空格回满宽，
 *     鼠标点选要多算一列，光标如果停在那一列（Ctrl+A / 方向键 / 点 gutter）会被挡回第 1 列：
 *     放进去的话反显光标会落在被摘掉的空列上，而在那儿打字会把 `x!ls` 写进正文，
 *     pi 当场判定「不是 bash 模式了」；
 *   - 退出模式不需要额外代码：正文为空时按回退键删掉 `!`（或 Enter 提交 / Esc 清空），
 *     pi 那边 `isBashMode` 变回 false、边框颜色照旧逻辑回落，这里下一帧就画回 `›`。
 *
 * 可用环境变量：
 *   PI_EDITOR_SLASH_MENU         设为 off 关闭「补全菜单选中行铺底色」（见 ⑥）
 *   PI_EDITOR_PROMPT             提示符字符，默认 "›"（bash 模式的 "!" 不跟着变）
 *   PI_EDITOR_AUTOCOMPLETE_GAP   设为 off 关闭补全列表下方的空白行
 *   PI_EDITOR_AUTOCOMPLETE_SHIFT 补全列表左移列数，0..gutter，默认 1；
 *                                设 0 恢复旧行为，设 2（= gutter）则命令词对齐光标起始列
 *   PI_EDITOR_PLACEHOLDER        占位符文案，默认 "Type your message or @file"；
 *                                设为 off 关闭占位符
 *
 * ⑤ 空输入框占位符（用户 2026-10-19 定）：正文一个字都没有时，在第一行画一句灰提示
 * `Type your message or @file`，色槽 `dim` —— 与回合结束行 `✻ … · done 11:37 PM`
 * 同档（`working-indicator/turn-marker.ts` 的 `TURN_MARKER_COLOR`）。排版逻辑在
 * `./prompt-editor/placeholder.ts`（纯逻辑、注入量宽与着色），这里只负责三件事：
 *   - 取皮肤：`session_start` 时把 `ctx.ui.theme`（读 `globalThis` 的活 Proxy，`/theme`
 *     换肤下一帧即生效）交给编辑器，读取包 try/catch —— 会话被替换/重载后旧 ctx 一点就抛，
 *     而渲染 tick 里的异常没人接得住，会打死整个 pi（`user-message-bar` 2026-09-20 实测）；
 *     读不到就退化成不着色，最坏只是那一帧没有颜色；
 *   - 判据：`getText().length === 0` **并且**这一行就是正文首行（未滚动）。敲一个空格
 *     就算有内容，占位符立刻消失 —— 提示是「还没写东西」，不是「没写有意义的东西」；
 *   - 光标：形状照抄 pi-tui `Input` 组件的 placeholder 分支（`CURSOR_MARKER` +
 *     `renderFakeCursor(首字素)` + 其余上色），所以硬件光标 / IME 候选窗仍停在正文第 0 列，
 *     关掉硬件光标时首字素反显。编辑器的 caret 本来就在第 0 列，这里不需要任何坐标换算。
 *
 * ⑥ 补全菜单选中行的底色（用户 2026-10-28 定）：输入 `/` 弹出的命令列表里，选中的那一行改成
 * **`accent` 前景 + prompt message 的底色（`userMessageBg`）**。pi 自己的 `getSelectListTheme()`
 * 只给了前景（`selectedText: (t) => theme.fg("accent", t)`，整个 bundle 的 select-list 路径上
 * 一次 `theme.bg(…)` 都没有），满屏命令里只有字色差一点、光标停在哪一行很难一眼看出。
 *
 * 改在这一层的理由是 `Editor` 的 `autocompleteList` / `autocompletePrefix` 都是 private 字段；
 * 而 `render()` 本来就在整行改写编辑器输出（gutter / 列表左移 / 下方空行），多一次「认行 →
 * 重绘」不引入任何私有依赖。判据只是选中行的可见前缀 `→ `（`SelectList.renderItem` 里写死的
 * 字面量），**先剥掉行内 SGR 再整行上一次色** —— 否则描述自带的 `dim` 会把后半行洗回默认前景。
 * **整行铺满**（用户 2026-10-28 定：从行首到行尾都要有底色）：行首 gutter 的空白列、
 * 描述之后的补白全部上色，并且**先补到终端宽再上色** —— pi 自己只把补全行铺到
 * `gutter - shift + contentWidth`（默认比终端窄一列），不补齐右边缘会缺一格白底；
 * 补白必须在 SGR **里面**，否则行尾那几格就是白底。
 * 纯逻辑（判行 / 剥色 / 整行重绘与补宽）在 `./prompt-editor/slash-menu.ts`，单测不需要真 TUI。
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BASH_MARKER, dropLeadingBang, resolveBashPrompt } from "./prompt-editor/bash-prompt.ts";
import {
	buildPlaceholderLine,
	isPlaceholderVisible,
	resolvePlaceholder,
} from "./prompt-editor/placeholder.ts";
import {
	buildSuggestionDigest,
	buildSuggestionLine,
	buildSuggestionRequestPrompt,
	cleanSuggestionText,
	isConcludingReply,
	isSuggestionVisible,
	resolveSuggestionEnabled,
	suggestionFillText,
} from "./prompt-editor/suggestion.ts";
import { paintAutocompleteRows, resolveSlashMenuHighlight } from "./prompt-editor/slash-menu.ts";

const PROMPT_CHAR = process.env.PI_EDITOR_PROMPT ?? "›";
/** 提示符字形的色槽（用户 2026-10-28 定：`›` 用 `accent` 色 + 加粗）。 */
const PROMPT_COLOR = "accent";
const AUTOCOMPLETE_GAP = (process.env.PI_EDITOR_AUTOCOMPLETE_GAP ?? "").toLowerCase() !== "off";
/** 补全菜单选中行的底色开关（用户 2026-10-28 定；`PI_EDITOR_SLASH_MENU=off` 关闭）。 */
const AUTOCOMPLETE_SELECTED_BG = resolveSlashMenuHighlight(process.env.PI_EDITOR_SLASH_MENU);
/** 选中行的前景槽：`accent`（用户 2026-10-28 定，回到 pi 自己的选择）。 */
const AUTOCOMPLETE_SELECTED_FG = "accent";
/**
 * 选中行的底色槽（用户 2026-10-28 定：「prompt message 的背景色」）。
 *
 * 主题里没有叫 `prompt message` 的 token；对得上的是 **`userMessageBg`**（“User message
 * background” —— prompt / 用户消息那条消息的底色；`customMessageBg` 是 hook 注入消息的，
 * 本仓几个皮肤里两者本来就同值）。`background-tasks` 的表头也是拿它当「皮肤 surface」用。
 */
const AUTOCOMPLETE_SELECTED_BG_SLOT = "userMessageBg";

/** 占位符开关与文案：`PI_EDITOR_PLACEHOLDER=off` 关掉，其余非空值当文案用。 */
const PLACEHOLDER = resolvePlaceholder(process.env.PI_EDITOR_PLACEHOLDER);

/** 占位符的色槽，与回合结束行同档（用户 2026-10-19 定）。 */
const PLACEHOLDER_COLOR = "dim";

/**
 * 回合结束后的「下一步建议」（用户 2026-10-20 定）：开关、色槽与生成参数。
 *
 * 形状是 Claude Code 的 ghost suggestion：一轮结束、输入框为空时，正文首行显示一句灰色建议，
 * 按 Tab 整句填进输入框（只填入、不发送）。**打字只是把它藏起来，不清掉** —— 光标删空输入框、
 * 那一行重新轮到显示占位符时，露出来的是这句建议（用户 2026-10-21 定）。**Tab 填入也不清掉**
 * （用户 2026-10-22 定）：填入只是取一份副本进正文，把副本删空之后仍然露出同一句。只有这些
 * 事件才真正丢弃它：回车提交、下一轮开始（`agent_start` / `turn_start`）、压缩（`session_compact`）、
 * 换会话（`session_start`：`/clear`、`/new`、`/resume` 都在这条上）。
 *
 * **触发时机**：结论那条 `turn_end`（`isConcludingReply`）后就排一次请求 —— 与 pi-subagents
 * 的 watchdog 审查并行，而不是等 `agent_settled`（那要等所有 `agent_end` 处理器 settle，
 * watchdog 正挂在其中，实测多等 7~17s）。`agent_settled` 降为兜底：`length` 截断、工具
 * `terminate` 收尾这类 `turn_end` 门槛盖不住的结尾形态在那里补一次（`requestedThisRun` 去重）。
 *
 * `PI_EDITOR_SUGGEST=off` 整体关掉；`PI_EDITOR_SUGGEST_MODEL=provider/modelId` 可换生成
 * 用的模型（默认跟随会话模型）。色槽同样是 `dim` —— 与占位符 / 回合结束行同档，用户选的
 * 「只有灰字、不铺底色」。排版在 `./prompt-editor/suggestion.ts`（纯逻辑）；行首那两格缩进
 * 渲染与 Tab 填入共用（`suggestionFillText`），所以按下 Tab 时文字不会左右跳动。
 */
const SUGGESTION_ENABLED = resolveSuggestionEnabled(process.env.PI_EDITOR_SUGGEST);
const SUGGESTION_COLOR = "dim";
const SUGGESTION_MODEL_SPEC = (process.env.PI_EDITOR_SUGGEST_MODEL ?? "").trim();
/**
 * 请求超时。本机这些路由都带着强制 thinking，实测一次「写一句下一步」要几秒到二十秒；
 * 到点 abort —— 建议只是增强，迟到的结果已经没有意义（用户早就开始打字了）。
 */
const SUGGESTION_TIMEOUT_MS = 25_000;
/**
 * 结论那条 `turn_end` 之后等多久才发请求（用户 2026-10-20 定的「再等一小段缓冲」）。
 *
 * 为什么不等 `agent_settled`：pi 的 settled 要等**所有** `agent_end` 处理器 settle 之后才发，
 * 而 pi-subagents 的 watchdog 审查正好挂在 `agent_end` 里（实测 7~17s）—— 挂在 settled 上是
 * 两段串行（watchdog 全程 + 请求全程）。`turn_end` 是能拿到本轮结论的最早时机：那时消息已经
 * 落盘（pi 在 `message_end` 就 append 进 session），watchdog 甚至还没起跑。
 *
 * 但也不是同一时刻就发：结论刚上屏、TUI 还在画最后几帧，先让出一小段把「上屏这件事」办完，
 * 避免请求和渲染抢同一个 tick。这段延迟远小于 watchdog，所以仍然是并行而不是串行。
 * `PI_EDITOR_SUGGEST_DELAY_MS` 可覆盖（测试用）。
 */
export const SUGGESTION_DELAY_MS = (() => {
	const raw = (process.env.PI_EDITOR_SUGGEST_DELAY_MS ?? "").trim();
	if (raw === "") return 300;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value >= 0 ? value : 300;
})();
/** 请求预算。与 working-indicator 的摘要请求同理：thinking 会吃掉大半额度。 */
const SUGGESTION_MAX_TOKENS = 1024;
/** 喂给模型的助手回复 / 用户请求的上限（字符），避免把一整段长回复塞进请求。 */
const SUGGESTION_CONTEXT_CHARS = 1200;

/** 补全列表左移列数覆盖值；未设置时默认左移 1 列。 */
const AUTOCOMPLETE_SHIFT_OVERRIDE = (() => {
	const raw = process.env.PI_EDITOR_AUTOCOMPLETE_SHIFT;
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
})();

class PromptEditor extends CustomEditor {
	private readonly gutter: number;
	/** 最近一次 renderBottomBorder 生成的整行，用来在 render() 里认出下边框 */
	private bottomBorderLine = "";
	/** 上边框带的 "↑ N more" 说明当前视图是滚动过的 */
	private scrolled = false;
	/**
	 * 取当前皮肤的 Theme（`ctx.ui.theme` 那个活 Proxy）。为空表示读不到：会话被替换 / 重载后
	 * 旧 ctx 一点就抛，而渲染 tick 里的异常会打死整个 pi。
	 */
	private themeSource: Theme | undefined;
	/**
	 * 回合结束后的下一步建议（已清洗的单行文本）。`null` 表示没有建议 —— 此时退回占位符。
	 * 生命周期由扩展层驱动：请求在 `turn_end` / `agent_settled`；清空只在回车提交、
	 * 「下一轮开始」（`agent_start` / `turn_start`）、`session_compact`、换会话（`session_start`）。
	 * **打字与 Tab 都不清空**：渲染层已经有「严格空串才画」的判据，藏起来就够了；清掉会让用户
	 * 删空输入框之后只剩占位符（用户 2026-10-21 报的就是这个，2026-10-22 又补了 Tab 这条路径）。
	 */
	private suggestion: string | null = null;
	/**
	 * 用户开始输入（正文从空变成非空）时通知扩展：在等缓冲 / 在飞的建议作废。
	 *
	 * 为什么需要它：请求现在是「`turn_end` + 一小段缓冲」才发的（用户 2026-10-20 定），
	 * 那段窗口里用户就可能已经开始写下一句了 —— 旧实现在发请求前现场看一次输入框，
	 * 现在中间多了一段时间，所以得有个反方向的信号，否则会白花一次请求。
	 */
	private onUserInput: (() => void) | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.gutter = visibleWidth(PROMPT_CHAR) + 1; // 提示符 + 一个空格
	}

	/** 皮肤在渲染时求值，`/theme` 换肤下一帧即跟随；读不到就当这一帧没有颜色。 */
	setThemeSource(theme: Theme | undefined): void {
		this.themeSource = theme;
	}

	/** 换上一条建议（`null` 清空）。只在输入框为空时才会被画出来。 */
	setSuggestion(text: string | null): void {
		this.suggestion = text === "" ? null : text;
	}

	/** 注册「用户开始输入」回调（扩展层用它取消在等缓冲 / 在飞的请求）。 */
	setUserInputHandler(handler: (() => void) | undefined): void {
		this.onUserInput = handler;
	}

	getSuggestion(): string | null {
		return this.suggestion;
	}

	/** 把建议文字着成 `dim`；皮肤缺失 / 槽位不认识时退化成原样文字，绝不抛。 */
	private paintSuggestion(text: string): string {
		const theme = this.themeSource;
		if (theme === undefined) return text;
		try {
			return theme.fg(SUGGESTION_COLOR, text);
		} catch {
			return text;
		}
	}

	/** 把占位符文字着成 `dim`；皮肤缺失 / 槽位不认识时退化成原样文字，绝不抛。 */
	private paintPlaceholder(text: string): string {
		const theme = this.themeSource;
		if (theme === undefined) return text;
		try {
			return theme.fg(PLACEHOLDER_COLOR, text);
		} catch {
			return text;
		}
	}

	/**
	 * 补全菜单选中行：`accent` 前景 + **prompt message 的底色**（`userMessageBg`）。
	 *
	 * 底色不用 `selectedBg`（用户 2026-10-28 定：跟用户消息块用同一个 surface），前景仍用 pi
	 * 自己对选中项的选择 `accent`。`bg("userMessageBg", fg("accent", …))` 的次序与
	 * `theme-command.ts` 的预览行一致（底色在外、前景在内）。
	 *
	 * 三道退化：没有皮肤（旧 ctx 作废 / 非 TUI）→ 原样；`userMessageBg` 这个槽位拿不到
	 * （老皮肤缺该 token，`getBgAnsi` 会抛）→ 退回纯 accent 前景（= pi 自己那层的观感），
	 * 不留一坨前景 + 默认底色的半成品；异常都吞掉 —— 渲染 tick 里抛出去会打死整个 pi。
	 */
	private paintSelectedRow(text: string): string {
		const theme = this.themeSource;
		if (theme === undefined) return text;
		try {
			const highlighted = theme.bg(AUTOCOMPLETE_SELECTED_BG_SLOT, text);
			return theme.fg(AUTOCOMPLETE_SELECTED_FG, highlighted);
		} catch {
			try {
				return theme.fg(AUTOCOMPLETE_SELECTED_FG, text);
			} catch {
				return text;
			}
		}
	}

	private get gutterFill(): string {
		return this.borderColor("─".repeat(this.gutter));
	}

	/**
	 * 提示符字形铺满 gutter 列（`›` / `!` 都是 1 列，但 `PI_EDITOR_PROMPT` 可能是宽字符）。
	 * 只把字形染色、补齐的空格不染 —— 和原来的 `${borderColor("›")} ` 逐字一致。
	 *
	 * `styled` 为真时走 `paintPromptGlyph`（`accent` 槽 + 加粗，用户 2026-10-28 定）；
	 * bash 模式的 `!` 传假，仍沿用边框色 —— 那个颜色是 pi 的 bashMode 色，跟着它才不会
	 * 和输入框颜色打架。
	 */
	private promptCell(char: string, styled = false): string {
		const pad = Math.max(0, this.gutter - visibleWidth(char));
		const painted = styled ? this.paintPromptGlyph(char) : this.borderColor(char);
		return painted + " ".repeat(pad);
	}

	/**
	 * 提示符字形的专属配色：`accent` 槽 + 加粗。
	 *
	 * 皮肤缺失（旧 ctx 作废 / 非 TUI）或槽位不认识时退回边框色 —— 渲染 tick 里抛出去会
	 * 打死整个 pi，所以一层 try/catch 包到底。
	 */
	private paintPromptGlyph(char: string): string {
		const theme = this.themeSource;
		if (theme !== undefined) {
			try {
				return theme.fg(PROMPT_COLOR, theme.bold(char));
			} catch {
				// 老皮肤缺该 token：落到下面的边框色
			}
		}
		return this.borderColor(char);
	}

	/**
	 * 把光标挡在隐藏的 `!` 之外：Claude Code 里光标永远进不到模式标记上。
	 * 放它进去有两个后果 —— 反显光标落在被摘掉的那一空列上（看起来光标消失），
	 * 以及在那儿打字会把 `x!ls` 写进正文，pi 当场判定「不是 bash 模式了」。
	 * 光标列住在 Editor private 的 state 里、没有公开 setter，所以直接调它自己的
	 * setCursorCol(1)（顺带清掉 sticky 列）；pi 以后改名时这里退化成「光标停在 0 列」，
	 * 只影响这个边角行为，不影响渲染。
	 */
	private keepCursorOffBang(): void {
		if (!resolveBashPrompt(this.getText()).hidden) return;
		const cursor = this.getCursor();
		if (cursor.line !== 0 || cursor.col !== 0) return;

		const internals = this as unknown as {
			setCursorCol?: (col: number) => void;
			state?: { cursorCol: number };
		};
		if (typeof internals.setCursorCol === "function") internals.setCursorCol(1);
		else if (internals.state) internals.state.cursorCol = 1;
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		this.scrolled = hiddenLineCount > 0;
		return this.gutterFill + super.renderTopBorder(width, hiddenLineCount);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.bottomBorderLine = this.gutterFill + super.renderBottomBorder(width, hiddenLineCount);
		return this.bottomBorderLine;
	}

	render(width: number): string[] {
		const gutter = this.gutter;
		const contentWidth = Math.max(1, width - gutter);
		const lines = super.render(contentWidth);
		if (lines.length === 0) return lines;

		const text = this.getText();
		// pi 的 bash 模式只由正文文本决定，不额外维护状态：每帧重算，永远不会和边框颜色脱节
		const bash = resolveBashPrompt(text);
		// 占位符只在「一个字都没有」且未滚动时出现；敲一个空格就算有内容
		const placeholder = PLACEHOLDER.enabled && isPlaceholderVisible(text);
		// 建议与占位符共用同一条首行分支，建议优先（它是「下一步做什么」，比「这里可以写字」
		// 有用）：两者都只在严格空输入框 + 未滚动时才出现
		const suggestion = SUGGESTION_ENABLED && isSuggestionVisible(text) ? this.suggestion : null;

		const blank = " ".repeat(gutter);
		// 滚动后第一可见行已经不是逻辑首行，不再显示提示符
		const showPrompt = !this.scrolled;
		// EditorTheme 只暴露 borderColor，所以提示符沿用边框色（bash 模式下就是 bashMode 色）；
		// 普通 `›` 自己有一套配色（accent + 加粗），见 paintPromptGlyph
		const prompt = this.promptCell(bash.active ? BASH_MARKER : PROMPT_CHAR, !bash.active);
		// 要摘 `!` 的那一行正好就是显示提示符的那一行
		const hideBang = bash.hidden && showPrompt;

		// 补全列表左移：默认 1 列（含选择箭头一起左移）。
		const shift = Math.max(0, Math.min(gutter, AUTOCOMPLETE_SHIFT_OVERRIDE ?? 1));
		const autocompleteBlank = " ".repeat(gutter - shift);

		let inAutocomplete = false;
		const mapped = lines.map((line, index) => {
			// 上边框已经在上面补满宽度
			if (index === 0) return line;
			// 下边框已补满宽度；其后的行都是补全列表行
			if (line === this.bottomBorderLine) {
				inAutocomplete = true;
				return line;
			}
			if (inAutocomplete) return autocompleteBlank + line;
			if (index === 1 && showPrompt) {
				if (suggestion !== null) {
					// 建议行首缩进两格（渲染时补，不进正文），同样按 contentWidth 截断并补满宽
					return prompt + buildSuggestionLine(suggestion, contentWidth, METRICS, {
						style: (value) => this.paintSuggestion(value),
						// 与 pi-tui 的 Input 组件同口径：只有聚焦时才发光标标记
						cursorMarker: this.focused ? CURSOR_MARKER : "",
						renderFakeCursor,
					}, SUGGESTION_ELLIPSIS);
				}
				if (placeholder) {
					// 正文整行换成占位符（已按 contentWidth 截断并补满宽），前置的 gutter 提示符照旧
					return prompt + buildPlaceholderLine(PLACEHOLDER.label, contentWidth, METRICS, {
						style: (value) => this.paintPlaceholder(value),
						// 与 pi-tui 的 Input 组件同口径：只有聚焦时才发光标标记
						cursorMarker: this.focused ? CURSOR_MARKER : "",
						renderFakeCursor,
					});
				}
				if (!hideBang) return prompt + line;
				// 摘掉正文那个 `!` 后整行少 1 列，补一个空格回满宽（Editor 每行都铺满 contentWidth，
				// 少一列会在差分渲染器下留残影）
				const dropped = dropLeadingBang(line);
				return prompt + dropped.text + (dropped.dropped ? " " : "");
			}
			return blank + line;
		});

		// 补全菜单选中行铺底色（见文件头 ⑥）。这一趟要在补空白行之前跑：认行只靠可见的 `→ `
		// 前缀，空白行本来就不会命中，早跑晚跑结果一样，但早跑能让「没有改动 → 返回原数组」
		// 这条短路作用在整帧上（下面 push 空行会就地改数组，先算就不会白算一次）。
		// 关闭开关时整帧原样返回（= pi 自带的「只有 accent 前景」）。
		//
		// `padTo: width` 是「从头到尾」的关键：补全行总宽是 `gutter - shift + contentWidth`
		// （默认 shift=1 ⇒ 比终端窄一列），pi 自己补的空白也只到这宽度。先补到 `width` 再上色，
		// 选中条才一路铺到终端右边界；补白在着色区**内**，否则行尾那几格是白底。
		const painted =
			AUTOCOMPLETE_SELECTED_BG && this.isShowingAutocomplete()
				? paintAutocompleteRows(mapped, {
						paint: (text) => this.paintSelectedRow(text),
						padTo: width,
						widthOf: visibleWidth,
					})
				: mapped;

		// 补全列表渲染在编辑器底边框之后，紧接着就是 statusline，视觉上拥挤；
		// 只在补全列表真的存在时补一行空白行，静态布局不变。
		// 按 pi 自己的惯例补满宽度（其余行也都是 gutter + contentWidth = width）。
		if (AUTOCOMPLETE_GAP && this.isShowingAutocomplete()) {
			painted.push(" ".repeat(Math.max(0, width)));
		}

		return painted;
	}

	/**
	 * 按 Tab 接受建议：整句填进输入框，光标落尾，**不发**。这是用户 2026-10-20 定的语义
	 * ——只填入，让你改完再回车；误触不会烧掉一整轮请求。
	 *
	 * **建议本身不销毁**（用户 2026-10-22 报的 bug）：Tab 只是把这句「拿来用一下」，填进正文的
	 * 是它的副本。旧实现这里会 `this.suggestion = null`，于是用户把填进来的字删空之后只剩默认
	 * 占位符 —— 而用户要的是那句下一步建议回来（与 2026-10-21 定的「打字只隐藏、删空重新
	 * 露出」是同一件事）。真正的清除点仍然只有回车提交 / 下一轮开始 / 压缩 / 换会话。
	 *
	 * 填进去的正文带行首那两格缩进（`suggestionFillText`）：建议是画在缩进之后的，只填原文
	 * 会让整句在按下的那一瞬往左跳两列（用户 2026-10-20 报的就是错位）。
	 *
	 * 三道闸都要过：
	 *   - 输入框必须为空（用户已经在写东西时 Tab 该走 pi 自己的补全 / 缩进）；
	 *   - 当前没有补全列表（`isShowingAutocomplete()`）—— 否则抢掉了 pi 的文件补全；
	 *   - `data` 确实是 `tui.input.tab`（走 pi 自己的 keybindings，不硬编码 `\t`：
	 *     终端在 Kitty 键盘协议下发的可能是别的编码）。
	 * 吃掉这个按键（不调 super）—— 否则 pi 的 Editor 还会当文件补全去碰一次。
	 */
	private maybeAcceptSuggestion(data: string): boolean {
		if (this.suggestion === null) return false;
		if (!isSuggestionVisible(this.getText())) return false;
		if (this.isShowingAutocomplete()) return false;
		const keybindings = this.keybindings as { matches?: (data: string, id: string) => boolean };
		if (typeof keybindings.matches !== "function" || !keybindings.matches(data, "tui.input.tab")) {
			return false;
		}
		const text = this.suggestion;
		// setText 会清补全 / 复位历史浏览 / 推 undo 快照，光标落尾（`onChange` 随之把边框颜色
		// 刷回普通态）—— 与手工粘贴一段文字的效果一致。行首两格必须跟着正文进去，否则文字会
		// 从缩进之后跳到第 0 列（用户 2026-10-20 定）。建议**不**在这里清：填入只是取一份副本，
		// 把副本删空之后要能重新露出它（用户 2026-10-22 报的 bug）。
		this.setText(suggestionFillText(text));
		return true;
	}

	/** 这个按键是不是绑在 `id` 上（走 pi 自己的 keybindings，不硬编码字节）。 */
	private matchesKeybinding(data: string, id: string): boolean {
		const keybindings = this.keybindings as { matches?: (data: string, id: string) => boolean };
		return typeof keybindings.matches === "function" && keybindings.matches(data, id);
	}

	handleInput(data: string): void {
		if (this.maybeAcceptSuggestion(data)) return;
		// 提交（Enter）必须先把建议清掉再看按键结果：`submitValue()` 会在 `onSubmit` 之前
		// 把正文清空，而 `agent_start` 要等下一次事件循环 —— 中间那一帧里渲染层看到「空输入框
		// + 旧建议」，会把刚发出去的回合的建议重新画回来（还能被 Tab 接受，等于重复提交）。
		// 提交就是「这一轮结束了」，属于用户 2026-10-21 定的真正清除点。
		const submitting = this.matchesKeybinding(data, "tui.input.submit");
		super.handleInput(data);
		// 任何一条能改光标/正文的路径（方向键、Home/Ctrl+A、↑ 历史、退格、粘贴、undo…）都从这里过
		this.keepCursorOffBang();
		// 两个条件按与关系：`disableSubmit` / `\`+Enter 两条路径下回车不提交、正文也不清，
		// 那时文本非空，下一行不会执行
		if (submitting && this.getText().length === 0) this.suggestion = null;
		// 打字与 Tab 填入都**不**清掉建议：`render()` 只在 `isSuggestionVisible`（严格空串）时
		// 画它，所以藏起来就够。删空输入框要能重新露出同一句（用户 2026-10-21 定：空格再退格
		// 不该让建议消失；2026-10-22 补充：Tab 填入的副本删空也一样）。真正的清除只发生在
		// 提交 / 下一轮开始 / 压缩 / 换会话。
		// 正文不再是空的 → 通知扩展把还没发出的（缓冲期）/ 还在飞的请求也一并作废
		if (!isSuggestionVisible(this.getText())) this.onUserInput?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// bash 模式下正文整体左移了 1 列（隐藏的 `!`），点选要往右多算 1 列才对得上原文。
		// 补全列表的 x 不参与命中（SelectList 只用 y），多这 1 列不影响它。
		const bangHitShift = resolveBashPrompt(this.getText()).hidden ? 1 : 0;
		const result = super.handleMouse({
			...event,
			x: Math.max(0, event.x - this.gutter + bangHitShift),
			width: Math.max(1, event.width - this.gutter),
		});
		this.keepCursorOffBang();
		return result;
	}
}

/** 占位符 / 建议排版要的量宽 / 截断，与 `Editor` 自己用的是同一套 pi-tui 实现。 */
const METRICS = {
	widthOf: visibleWidth,
	truncate: (text: string, max: number, ellipsis = "") => truncateToWidth(text, max, ellipsis),
};

/**
 * 建议超宽时的省略号。占位符刻意不补（文案不该抢视觉重量），建议相反：它是**半句话**，
 * 被切掉尾巴而不标明「还有后半句」会误导（例如「跑一下 node --test …」看起来就像完整指令）。
 */
const SUGGESTION_ELLIPSIS = "…";

export default function (pi: ExtensionAPI) {
	/**
	 * 当前活着的编辑器实例。`setEditorComponent` 每次 `session_start`（含 `/reload`、`/new`、
	 * `/resume`）都会重新造一个，所以这里只保存最新那一个；异步回来的建议先比对实例仍是同一个，
	 * 否则丢弃（否则会写到上一会话已经废弃的编辑器上）。
	 */
	let editor: PromptEditor | null = null;
	/** 在飞的建议请求（新回合 / 新会话 / 关机时 abort）。 */
	let inflight: AbortController | null = null;
	/**
	 * 结论那条 `turn_end` 之后等缓冲的定时器。缓冲期里 `agent_start` / 新会话到了就直接取消，
	 * 一次请求都不发（用户已经开写下一句了）。
	 */
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;
	/** 本回合调过的工具名（只收集名字，不进模型上下文）。 */
	let turnToolNames: string[] = [];
	/** 请求序号：每次触发 / `agent_start` / `session_start` 递增，旧结果按它丢弃。 */
	let requestSeq = 0;
	/**
	 * 本轮是否已经**发过**建议请求。
	 *
	 * `turn_end`（结论）与 `agent_settled`（兜底）两个触发点共用它：正常回合在 `turn_end` 就发了，
	 * 随后的 settled 不该再花一次请求；反过来，`turn_end` 门槛没盖住的结尾形态（`length` 截断、
	 * 工具 `terminate` 收尾）本轮没发过，settled 补一次。
	 *
	 * 不能拿「已有建议」当去重条件：请求可能失败 / 超时 / 回来是空，那种情况 settled 再发一次
	 * 也是一次白花钱。
	 */
	let requestedThisRun = false;

	function cancelSuggestionRequest(): void {
		if (pendingTimer !== null) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
		if (inflight !== null) {
			inflight.abort();
			inflight = null;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		cancelSuggestionRequest();
		editor = null;
		turnToolNames = [];
		requestedThisRun = false;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const next = new PromptEditor(tui, theme, keybindings);
			// `ctx.ui.theme` 是读 `globalThis` 的活 Proxy，换肤下一帧即生效
			next.setThemeSource(liveTheme(ctx));
			// 用户开写 → 本回合还没需要的那句建议就不再需要了（缓冲期 / 在飞都一样）
			next.setUserInputHandler(() => {
				requestSeq += 1;
				cancelSuggestionRequest();
			});
			editor = next;
			return next;
		});
	});

	// 新一回合开跑：建议已经过期（用户已经提交了东西），在飞 / 在等缓冲的那个也作废
	pi.on("agent_start", () => {
		requestSeq += 1;
		cancelSuggestionRequest();
		editor?.setSuggestion(null);
		turnToolNames = [];
		requestedThisRun = false;
	});

	/**
	 * 同一个 run 里又起了一轮（watchdog 认了问题后继续、`/goal` 验证不通过续跑、自动重试……）。
	 * 这时上一条建议是拿**中间结论**猜的，已经过期：清掉它、把去重位放开，让新的结论重新猜。
	 *
	 * 为什么不能只靠 `agent_start`：续跑在同一 run 里发起，不会重发 `agent_start`。
	 * 正常路径（结论后直接结束）不会经过这里，所以建议不会被无端吃掉。
	 */
	pi.on("turn_start", () => {
		requestSeq += 1;
		cancelSuggestionRequest();
		editor?.setSuggestion(null);
		requestedThisRun = false;
	});

	/**
	 * 压缩之后旧建议作废（用户 2026-10-21 定）：摘要换掉之后「接着做什么」的上下文也换了。
	 *
	 * `requestedThisRun` 一起放开：压缩可能发生在同一个 run 里（overflow 恢复会接着重跑那一轮），
	 * 不放开的话压缩后那条结论被去重位挡住、再也不会猜新的建议。
	 */
	pi.on("session_compact", () => {
		requestSeq += 1;
		cancelSuggestionRequest();
		editor?.setSuggestion(null);
		requestedThisRun = false;
	});

	// 只收集名字（`arguments` 可能很大，且含路径 / 命令等敏感文本，没必要留着）
	pi.on("tool_execution_start", async (event) => {
		const name = (event as { toolName?: unknown }).toolName;
		if (typeof name === "string" && name !== "") turnToolNames.push(name);
	});

	pi.on("session_shutdown", () => {
		cancelSuggestionRequest();
		editor = null;
	});

	if (!SUGGESTION_ENABLED) return;

	/**
	 * 要一句「下一步」：三道闸，再过一道缓冲。
	 *
	 * 三道闸：
	 *   - 编辑器已有内容 → 用户已经在写下一句，别抢；
	 *   - 摘要为空 → 这一轮没有可用上下文，不白花一次请求；
	 *   - 解析不出模型（或取不到 key，见请求体）→ 不自愈，别浪费。
	 *
	 * `reply` 是结论消息的可见文本（`turn_end` 那条现成有）；settled 兜底时为 `null`，
	 * 回到分支扫描里取。
	 */
	function scheduleSuggestion(ctx: ExtensionContext, reply: string | null): void {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const target = editor;
		if (target === null) return;
		if (!isSuggestionVisible(target.getText())) return;

		const model = resolveSuggestionModel(ctx);
		if (model === undefined) return;

		const digest = buildSuggestionDigest({
			userPrompt: lastUserPromptText(ctx),
			assistantReply: reply ?? lastAssistantText(ctx),
			toolNames: turnToolNames,
		});
		if (digest === "") return;

		requestedThisRun = true;
		// 缓冲期也算「已请求」：这样同一个 `turn_end` 后紧跟的 settled 不会抢在它前面再发一次。
		// 真的被 `agent_start` / 新会话打断时 `cancelSuggestionRequest()` 会把 `pendingTimer` 清掉，
		// 但 `requestedThisRun` 也在同一个地方重置，不存在残留。
		cancelSuggestionRequest();
		const seq = ++requestSeq;
		pendingTimer = setTimeout(() => {
			pendingTimer = null;
			if (seq !== requestSeq) return;
			void sendSuggestionRequest(ctx, target, model, digest, seq);
		}, SUGGESTION_DELAY_MS);
		pendingTimer.unref?.();
	}

	/** 真正发请求（缓冲期之后）。**不 await**：等待期间不能堵 pi 的事件管线。 */
	async function sendSuggestionRequest(
		ctx: ExtensionContext,
		target: PromptEditor,
		model: NonNullable<ExtensionContext["model"]>,
		digest: string,
		seq: number,
	): Promise<void> {
		const controller = new AbortController();
		inflight = controller;
		const timeout = setTimeout(() => controller.abort(), SUGGESTION_TIMEOUT_MS);
		timeout.unref?.();

		// 目标宽度：与渲染那一行同一份数学（gutter + 边框），估一个居中的值
		const termWidth = terminalWidth();
		const targetWidth = Math.max(20, Math.floor(termWidth * 0.6));
		const requestPrompt = buildSuggestionRequestPrompt(digest, targetWidth);

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			// 取不到 key：不会自愈，直接退出（与 working-indicator 的摘要请求同口径）
			if (!auth.ok || controller.signal.aborted) return;
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: requestPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: controller.signal,
					maxTokens: SUGGESTION_MAX_TOKENS,
					// 和摘要请求一样刻意不传 temperature：0 会让 max 档路由退化成停不下来的长思考
					cacheRetention: "none",
				},
			);
			// 三重护栏：abort 过的、序号换了的（新回合 / 新请求）、编辑器换了的，一律丢弃
			if (controller.signal.aborted || seq !== requestSeq) return;
			if (editor !== target) return;
			if (!isSuggestionVisible(target.getText())) return;
			const suggestion = cleanSuggestionText(textFromAssistant(response));
			if (suggestion === "") return;
			target.setSuggestion(suggestion);
		} catch {
			// 超时 / 中断 / 网络错误 / 模型不可用：什么都不做（建议只是增强）
		} finally {
			clearTimeout(timeout);
			if (inflight === controller) inflight = null;
		}
	}

	/**
	 * 主触发点：结论那条 `turn_end` —— 与 pi-subagents 的 watchdog 审查**并行**（用户 2026-10-20 定）。
	 *
	 * watchdog 挂在 `agent_end` 处理器里（实测 7~17s），而 `agent_settled` 要等它 settle 才发；
	 * 挂在 settled 上是串行两段，用户会先盯十几秒的「Subagent watchdog reviewing」才看到建议。
	 * `turn_end` 是最早能拿到本轮结论的时机（消息在 `message_end` 就落盘），所以这里就排一次
	 * 缓冲的请求（`scheduleSuggestion`）。
	 *
	 * 门槛全在 `isConcludingReply`（中间轮的 turn_end 一轮对话里几十条，不能每条都猜）。
	 */
	pi.on("turn_end", async (event, ctx) => {
		const message = (event as { message?: unknown }).message;
		if (!isConcludingReply(message)) return;
		if (requestedThisRun) return;
		scheduleSuggestion(ctx, textFromContent((message as { content?: unknown }).content));
	});

	/**
	 * 兜底触发点：主触发点门槛没盖住的结尾形态（`length` 截断、工具 `terminate` 收尾）在真正的
	 * settle 时补一次。`requestedThisRun` 保证已发过的回合不会重复花钱。
	 *
	 * `event.aborted === true`（用户按了 ESC）→ 猜下一步没意义。
	 */
	pi.on("agent_settled", async (event, ctx) => {
		if ((event as { aborted?: boolean }).aborted === true) return;
		if (requestedThisRun) return;
		scheduleSuggestion(ctx, null);
	});
}

/** 终端列数；拿不到（非 TTY）或异常窄时退回 80。每次现读，resize 自愈。 */
function terminalWidth(): number {
	const cols = process.stdout.columns;
	return Number.isFinite(cols) && cols >= 20 ? Math.floor(cols) : 80;
}

/** 建议用哪个模型：`PI_EDITOR_SUGGEST_MODEL` 解析得到就用它，否则用当前会话模型。 */
function resolveSuggestionModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> | undefined {
	if (SUGGESTION_MODEL_SPEC !== "") {
		const slash = SUGGESTION_MODEL_SPEC.indexOf("/");
		if (slash > 0) {
			const found = ctx.modelRegistry.find(
				SUGGESTION_MODEL_SPEC.slice(0, slash),
				SUGGESTION_MODEL_SPEC.slice(slash + 1),
			);
			if (found !== undefined) return found;
		}
	}
	return ctx.model;
}

/** 从消息 content 里抽纯文本（string 或 text 块数组；thinking / toolCall 丢掉）。 */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => (block as { type?: unknown })?.type === "text")
		.map((block) => (block as { text?: unknown }).text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

/** 从 assistant 响应里抽文本（只走了 thinking 的空回复会得到空串 → 放弃这次建议）。 */
function textFromAssistant(message: unknown): string {
	return textFromContent((message as { content?: unknown } | undefined)?.content);
}

/** 只留摘要需要的前若干字符，并把换行折成空格（摘要是一段紧凑的上下文）。 */
function clipContext(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= SUGGESTION_CONTEXT_CHARS ? flat : `${flat.slice(0, SUGGESTION_CONTEXT_CHARS)}…`;
}

/** 从 session 分支里倒序取最后一条 user 文本消息（本回合的用户请求）。 */
function lastUserPromptText(ctx: ExtensionContext): string | null {
	try {
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as
				| { type?: string; message?: { role?: string; content?: unknown } }
				| undefined;
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = clipContext(textFromContent(entry.message.content));
			if (text !== "") return text;
		}
	} catch {
		// stale ctx / session manager 不可用：当没有上下文
	}
	return null;
}

/** 从 session 分支里倒序取最后一条 assistant 的可见文本（thinking / 工具调用不算）。 */
function lastAssistantText(ctx: ExtensionContext): string | null {
	try {
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as
				| { type?: string; message?: { role?: string; content?: unknown } }
				| undefined;
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const text = clipContext(textFromContent(entry.message.content));
			if (text !== "") return text;
		}
	} catch {
		// 同上
	}
	return null;
}

/**
 * 读当前皮肤，**永不抛**：会话被替换 / reload 后 pi 会作废旧 ctx，读 `ctx.ui` 抛
 * `This extension ctx is stale …`，而渲染 tick 里的异常没人接得住，会打死整个 pi。
 */
function liveTheme(ctx: ExtensionContext): Theme | undefined {
	try {
		return ctx.ui.theme;
	} catch {
		return undefined;
	}
}
