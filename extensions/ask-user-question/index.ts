/**
 * ask-user-question — 给 pi 一个 Claude Code `AskUserQuestion` 式的提问工具。
 *
 * 模型在需求不明确时不再自己猜，而是调 `ask_user_question`：终端里弹出一份
 * 最多 4 题的问卷（每题 2-4 个带说明的选项），用户 ↑↓ 选、Space 勾多选、
 * 落到自动追加的 "Type something." 行可以自己打字，Esc 整份放弃；答案以
 * 结构化文本回到模型上下文。
 *
 * 参考 `npm:@juicesharp/rpiv-ask-user-question` 的**契约**（参数形状、保留
 * label、取消语义、非交互宿主把工具从 active 列表摘掉、RPC 宿主回退到
 * select/input 对话框），但自己写实现并砍掉它的 preview 侧栏、逐题/全局
 * note、i18n、overlay 折叠与 ~560ms 的懒加载渲染图 —— 本扩展用
 * `ctx.ui.custom()` 的普通对象组件（examples/extensions/question.ts 同款），
 * 零 npm 依赖、七个文件、可单测的逻辑全在纯模块里。
 *
 * 模块划分（`types/validate/answers/dialog/model` 刻意不 import pi / pi-tui，
 * 所以 `node --test clients/pi/extensions/ask-user-question/*.test.ts` 能直接跑；
 * `schema.ts` 要 typebox、`view.ts` 要 pi-tui，只在 pi 运行时加载）：
 *
 *   types.ts    常量 + 数据模型（单一事实来源）
 *   schema.ts   TypeBox 参数 schema（数量约束在 schema，长度上限在运行时截断）
 *   validate.ts 行终止符归一 / 单行化 / 截断 + 数量与保留 label 校验
 *   answers.ts  结果 → 给模型的 tool result 封装（含取消与错误路径）
 *   dialog.ts   非 TUI 宿主的顺序 select/input 回退
 *   model.ts    问卷状态机（纯 reducer：tab / 光标 / 勾选 / 提交 / 取消）
 *   view.ts     TUI 外壳（按键解码 + 渲染），index.ts 注册工具/命令/reconcile
 *
 * 放在 `~/.pi/agent/extensions/ask-user-question/`（pi 自动发现子目录里的
 * index.ts），支持 `/reload` 热重载。`PI_ASK_USER_QUESTION=off` 整体不装。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatAnswerScalar, buildResponse, errorResult } from "./answers.ts";
import { hasDialogUI, runDialogQuestionnaire } from "./dialog.ts";
import { normalizeParams, validateQuestionnaire } from "./validate.ts";
import { createQuestionnaireView } from "./view.ts";
import { AskParamsSchema } from "./schema.ts";
import {
	CUSTOM_ANSWER_LABEL,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type AskParams,
	type AskResult,
} from "./types.ts";

/** 工具名（也是 reconcile 与 /ask 共用的唯一标识）。 */
export const TOOL_NAME = "ask_user_question";

/**
 * 问卷阻塞期间 spinner 冻结在这一帧。选盲文全集字符：与默认动画帧
 * （⠋⠙…）同族，看起来是「spinner 停住了」而不是换了个东西。
 */
const FROZEN_SPINNER_FRAME = "⠿";

/**
 * 两条宿主能力错误的正文都是**写给模型**的：必须说清"用户根本没看到问题"，
 * 否则模型会把静默失败读成用户拒绝回答，然后自顾自继续猜。
 */
const ERROR_NO_UI =
	"Error: UI not available (running in non-interactive mode) — the user never saw the questions. Ask them as plain chat text instead, without using this tool.";
const ERROR_NO_DIALOG_UI =
	"Error: this client can render neither the questionnaire nor select/input dialogs — the user never saw the questions. Do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const DESCRIPTION = `Ask the user one or more structured questions and wait for the answers. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Every question gets an automatically appended "${CUSTOM_ANSWER_LABEL}" row, so the user can always answer in their own words. Esc abandons the whole questionnaire and you receive "${"User declined to answer the questions"}" — that is a decline to answer, not an answer.
- Each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options, each with a concise label (1-5 words) and a description of what the choice means or costs.
- Set multiSelect: true when the choices are not mutually exclusive.
- If you recommend an option, put it first and append "(Recommended)" to its label.
- Do NOT author "${CUSTOM_ANSWER_LABEL}" or "Other" option labels — reserved labels are rejected at runtime.
- Group every clarifying question into ONE invocation (up to ${MAX_QUESTIONS}) instead of asking one at a time.`;

const PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;

/**
 * 只写「怎么用」，不写「多主动」：提问阈值（什么算值得打断用户）由 AGENTS.md 的 `## Authorization`
 * 一节定义，本文件不再声明。2026-09-18 之前这里有一条「you cannot proceed」——它比本文件 DESCRIPTION
 * 里的「Clarify ambiguous instructions」更窄，同文件两处矛盾，而窄的那条实际生效。
 */
const PROMPT_GUIDELINES: string[] = [
	`Every ask_user_question option needs a concise label (1-5 words) plus a description of what the choice means or costs. Do NOT author "${CUSTOM_ANSWER_LABEL}" or "Other" labels — a free-text row is appended automatically and reserved labels are rejected.`,
	"Set multiSelect: true in ask_user_question when the choices are not mutually exclusive; put a recommended option first with \"(Recommended)\" appended to its label.",
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

/**
 * 真正跑一次问卷。TUI 走 custom 组件；其余模式（RPC / ACP 宿主）走 select/input
 * 顺序对话框；两者都不可用时返回 no_dialog_ui。
 *
 * `ctx.ui.custom()` 解析成 `undefined` 只可能是"宿主渲染不了自定义 UI"
 * （TUI 问卷一定会 resolve 一个 AskResult，取消也算），所以那不是用户拒绝，
 * 继续尝试对话框回退。
 *
 * TUI 路径在等待期间**冻结 working spinner 动画**：此刻在等用户作答而不是
 * 模型干活，动画继续转会让人以为还在推理。pi-tui Loader 对单帧 indicator
 * 不动画（`restartAnimation` 遇 `frames.length <= 1` 直接返回），且自定义帧
 * 是 verbatim 渲染（不走 spinnerColorFn），所以颜色自己带上 accent（与默认
 * spinner 同色）。提交/取消后无参 `setWorkingIndicator()` 恢复默认十帧动画。
 * 冻结不怕被每秒刷新的 working 文案顶掉：`setWorkingMessage` 只改文本不重建
 * indicator；即使重建，interactive-mode 也会带上存好的 workingIndicatorOptions。
 * try/finally 保证作答、取消、宿主回退每条路径都恢复；问卷开着时组件持有
 * 输入焦点、用户无法开启新回合，所以冻结帧不会泄漏到下一回合。
 * 本机的 `working-indicator/` 扩展**会**用 `setWorkingIndicator` 装自定义帧
 * （spinner 幻彩：十帧盲文轮换主题色，见那份 README），但它的帧表只在
 * `agent_start` / 主题指纹变化 / `ask_user_question` 的 `tool_execution_end`
 * 这三个时机装 —— 也就是问卷一结束就补装回去，所以这里的无参恢复（回到 pi
 * 默认十帧）只会短暂盖住它，不需要两边共享任何状态。
 */
async function runQuestionnaire(ctx: ExtensionContext, params: AskParams) {
	if (ctx.mode !== "tui") {
		if (hasDialogUI(ctx.ui)) return buildResponse(await runDialogQuestionnaire(ctx.ui, params), params);
		return errorResult(ERROR_NO_DIALOG_UI, "no_dialog_ui");
	}

	ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", FROZEN_SPINNER_FRAME)] });
	try {
		const result = await ctx.ui.custom<AskResult | undefined>((tui, theme, _keybindings, done) =>
			createQuestionnaireView(tui, theme, params, done),
		);
		if (result === undefined) {
			if (hasDialogUI(ctx.ui)) return buildResponse(await runDialogQuestionnaire(ctx.ui, params), params);
			return errorResult(ERROR_NO_DIALOG_UI, "no_dialog_ui");
		}
		return buildResponse(result, params);
	} finally {
		ctx.ui.setWorkingIndicator();
	}
}

/**
 * 非交互运行（`pi -p` / JSON 模式）里把工具从 active 列表摘掉，模型根本看不到它，
 * 好过每次调用都失败；恢复交互（同一进程里换会话等）再加回来。幂等：状态已正确
 * 就不碰 active 列表（也不碰别的扩展注册的工具）。
 */
function reconcileTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const present = active.includes(TOOL_NAME);
	if (!ctx.hasUI && present) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	} else if (ctx.hasUI && !present) {
		pi.setActiveTools([...active, TOOL_NAME]);
	}
}

/** /ask 的演示问卷：一题中文单选（验 CJK 折行）+ 一题英文多选（验勾选与提交页）。 */
function demoParams(): AskParams {
	return {
		questions: [
			{
				question: "这份问卷的交互形态，你更希望是哪一种？",
				header: "交互形态",
				options: [
					{ label: "覆盖编辑器区 (Recommended)", description: "ctx.ui.custom() 非 overlay：问卷接管输入框位置，实现最简、渲染最稳" },
					{ label: "浮层 overlay", description: "浮在对话上方，答题时仍能看见 transcript，但要处理折叠/焦点" },
					{ label: "顺序对话框", description: "逐题走宿主原生 select/input，没有总览页，RPC 宿主就是这条路径" },
				],
			},
			{
				question: "Which extra affordances should the questionnaire support?",
				header: "Features",
				multiSelect: true,
				options: [
					{ label: "Option previews", description: "Markdown preview pane rendered beside the option list" },
					{ label: "Per-question notes", description: "Attach a free-text note to any single answer" },
					{ label: "Collapse overlay", description: "Hide the dialog with a key so you can scroll the transcript" },
				],
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_ASK_USER_QUESTION === "off") return;

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskParamsSchema,
		// 阻塞式 UI：不能与别的工具调用并行执行，否则同一回合里两个弹窗抢输入焦点。
		executionMode: "sequential",
		// `renderShell: "self"`：让 pi 不再给整块套 `contentBox`（`Box(1, 1, bgFn)`），于是
		//   ① **没有底色**（pending 的 `toolPendingBg` / 成功的 `toolSuccessBg` / 失败的
		//      `toolErrorBg` 都不画 —— selfRenderContainer 是纯 Container，bgFn 套不上去，
		//      扩展自己也不画），
		//   ② **没有上下边界空行**（都是那个 Box 的 paddingY 画的）。
		// 与 simple-task / bash / read 块同一套观感（用户 2026-09-26 定）。
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 归一化跑在校验之前：保留 label 与重复 label 的比较必须用用户真正看到的文本。
			const typed = normalizeParams(params as unknown as AskParams);
			if (!ctx.hasUI) return errorResult(ERROR_NO_UI, "no_ui");
			const validation = validateQuestionnaire(typed);
			if (!validation.ok) return errorResult(validation.message, validation.error);
			return runQuestionnaire(ctx, typed);
		},

		// 两个 renderer 返回的 Text 都带 `paddingX = 1`：补回默认壳 `Box(1, 1)` 原本提供的
		// 那一列左边距（每行前置一个空格、不顶格）；`paddingY = 0` 保持上下不留空行。
		renderCall(args, theme) {
			const questions = (args as Partial<AskParams>)?.questions;
			const qs = Array.isArray(questions) ? questions : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", qs.length === 1 ? (qs[0]?.question ?? "") : `${qs.length} questions`);
			for (const q of qs) {
				const options = Array.isArray(q?.options) ? q.options : [];
				const labels = options.map((o, i) => `${i + 1}. ${o?.label ?? ""}`);
				labels.push(`${labels.length + 1}. ${CUSTOM_ANSWER_LABEL}`);
				const head = qs.length === 1 ? "" : `[${q?.header ?? ""}] `;
				const multi = q?.multiSelect ? " (multi)" : "";
				text += `\n${theme.fg("dim", `  ${head}${labels.join(" · ")}${multi}`)}`;
			}
			return new Text(text, 1, 0);
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as AskResult | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 1, 0);
			}
			if (details.error) return new Text(theme.fg("error", `✗ ${details.error}`), 1, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 1, 0);

			const questions = (context.args as Partial<AskParams>)?.questions;
			const qs = Array.isArray(questions) ? questions : [];
			const lines = details.answers.map((a) => {
				const header = qs[a.questionIndex]?.header || `Q${a.questionIndex + 1}`;
				const answer = a.kind === "custom" ? `✎ ${a.answer ?? ""}` : formatAnswerScalar(a);
				return `${theme.fg("success", "✓")} ${theme.fg("muted", `${header}: `)}${theme.fg("text", answer)}`;
			});
			return new Text(lines.join("\n") || theme.fg("dim", "(no answers)"), 1, 0);
		},
	});

	pi.on("before_agent_start", (_event, ctx) => reconcileTool(pi, ctx));

	// 不花 token 也能验 UI：/ask 弹一份演示问卷（中文单选 + 英文多选），
	// 走的是与工具完全相同的 runQuestionnaire 路径。
	pi.registerCommand("ask", {
		description: "Preview the ask_user_question dialog with a demo questionnaire",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("ask: no UI available in this mode", "warning");
				return;
			}
			const result = await runQuestionnaire(ctx, demoParams());
			const text = result.content[0]?.text ?? "";
			ctx.ui.notify(text.length > 240 ? `${text.slice(0, 240)}…` : text, "info");
		},
	});
}
