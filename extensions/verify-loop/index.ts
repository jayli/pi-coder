/**
 * verify-loop — 验证闭环 + 评估器，补 issue #12 里权重最高的一格空白。
 *
 * ## 要解决的问题
 *
 * 改动完成度**全靠模型自报**：模型改完文件说「已完成、测试通过」，pi 就结束这一轮，
 * 中间没有任何东西核对那句话。`~/.agents/skills/superpowers/verification-before-completion/`
 * 整篇在用文字要求模型别这么干（"NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION
 * EVIDENCE"），但文字是提示词 —— 模型可以忽略，而且随对话变长衰减（这正是 `core-rules/`
 * 存在的原因）。本扩展把这条纪律从提示词变成代码里的闸。
 *
 * ## CC 原型（官方文档核实：hooks / hooks-guide / goal）
 *
 * **Stop hook（闸）自动触发**：每次 "Claude finishes responding" 都 fire；hook 返回
 * `{"decision":"block","reason":...}` 阻止结束，`reason` 作为下一轮指令注入。防循环两件：
 * 输入带 `stop_hook_active`，且**连续 block 8 次强制放行**（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`）。
 * hook 三类型：`command`（确定性脚本）/ `prompt`（单轮模型判定，返回 `{ok, reason}`）/
 * `agent`（实验性，带工具子代理）。abort 不触发 Stop；API 错误走 `StopFailure`，也不触发。
 *
 * **`/goal`（评估器）手动设定、之后每轮自动评估**：`/goal <条件>` 设定并立即起一轮；
 * 此后每次回合结束把「条件 + 到目前为止的对话」发给**小快模型**（默认 Haiku，
 * **无工具权限**，"It doesn't run commands or read files independently"）。三裁决：
 * 未达成（继续干，reason 当指导）/ 达成（清除并记录）/ 不可能（清除并记录失败）。
 * 防呆：连续几轮无工具调用 = 无进展 → 停循环、警告、**goal 保留**；后台子代理在跑 →
 * 本轮跳过评估；resume 恢复 goal 但重置轮数计时；`/clear` 新会话清除；条件上限 4000 字符。
 *
 * ## pi 落点（源码核实，pi 0.87.1）
 *
 * | CC | pi |
 * |---|---|
 * | `Stop` 事件 | `agent_before_settle`（docs/extensions.md："the final actionable boundary: it can append entries and request one continuation"；`agent-session.js:1142`） |
 * | `decision:"block"` + `reason` | 返回 `{entries:[{type:"custom_message", display:true, …}], continue:true}`（`extensions/runner.js:662` `emitBoundary` → `_commitBoundaryDrafts` → `appendCustomMessageEntry`） |
 * | reason 进模型上下文 | custom_message 以 `role:"custom"` → `convertToLlm` 转 `role:"user"`（`messages.js:89`） |
 * | reason 用户可见（"Stop hook feedback"） | 同一条目 `display:true` + `registerMessageRenderer`（`interactive-mode.js:3046` 只对 display 为真的 custom 消息建组件） |
 * | `stop_hook_active` + 8 次上限 | 数投影里已注入的同类消息条数（见下「为什么不用内存计数器」） |
 * | abort / StopFailure 分流 | `event.outcome !== "completed"` 一律跳过（`agent-session.js:333` 按 stopReason 置值） |
 * | 后台任务未结束跳过评估 | 复用 `recap/subagents.ts` 的 `hasActiveSubagentWork(pi.events)`（pi-subagents 进程内 RPC） |
 * | 小快模型评估器 | 一次独立 `ctx.modelRegistry.complete()`，不带工具（recap / working-indicator 已验证的模式） |
 * | 对话序列化 | `serializeConversation(convertToLlm(投影消息))`，两者均从 pi 包根导出 |
 * | goal 跨 resume 保留 | `pi.appendEntry` + `session_start` 从 `getBranch()` 重建（simple-task / plan-mode 同款） |
 * | `◎ /goal active` 指示 | `ctx.ui.setStatus("verify-goal", …)` |
 *
 * ## 为什么计数器从投影里数，而不是内存态
 *
 * `agent_start` 在**每次边界续跑时都会再 fire 一次**（`runAgentLoopContinue` 里
 * `emit({type:"agent_start"})`），所以任何挂在 agent_start 上的复位都会在续跑链里把计数
 * 清零、上限失效。从投影里数注入消息则天然分支正确（rewind 后被丢弃的分支不在投影里）、
 * resume 后仍正确、且不需要任何可变状态。我们注入的是 `role:"custom"`（不是 user），
 * 所以它不会把 run 窗口切断 —— 整条续跑链共用一个窗口，正是 CC「同一 turn 内连续 block」
 * 的语义。
 *
 * ## 与 CC 的唯一有意偏离
 *
 * CC 的 hook 基础设施**默认不装任何 hook**（用户在 settings.json 里配置启用）。
 * 我们没有 hooks 配置系统这一层，所以闸**默认 block 开启**，触发条件收得极窄
 * （见 gate.ts），并提供 `PI_VERIFY_LOOP=off|notify|block` 一键切换。
 * 理由：触发条件是确定性的，误报代价有上限（默认最多 2 轮续跑）。
 *
 * ## 开关
 *
 *   PI_VERIFY_LOOP=off|notify|block   闸的力度，默认 block
 *   PI_VERIFY_LOOP_CAP=<n>            闸的连续拦截上限，默认 2（CC 通用上限是 8）
 *   PI_VERIFY_PATTERN=strict|<regexp>  验证命令识别式；缺省 = 任何 bash 调用都算（见 gate.ts
 *                                      「为什么 verification 是『跑过命令』」）；strict = 只认测试/构建/lint 形状
 *   PI_VERIFY_DOC_EXT=.md,.txt        改这些扩展名不算 mutation（空串 = 不排除）
 *   PI_GOAL_CAP=<n>                   /goal 的续跑上限，默认 8（CC 的数字）
 *   PI_VERIFY_EVALUATOR_MODEL=p/m     评估器模型，缺省找 litellm-any/qwen3.8-flash，再退回当前会话模型
 *   PI_GOAL_CONTEXT_CHARS=<n>         给评估器的对话字符上限，默认 120000
 *   PI_GOAL_TIMEOUT_MS=<n>            评估调用超时，默认 45000
 *
 * ## 已知边界（写清楚，别当 bug 修）
 *
 * - **bash 里的写操作不算 mutation**（`sed -i` / 重定向 / 脚本改文件）。词法判定不做
 *   数据流分析，与 destructive-guard 的口径同级。
 * - **评估器 fail-open**：调用失败 / 超时 / 解析不出裁决 → 放行回合并 notify。
 *   CC 的 hook 失败同样不拦回合；评估器是增强，不该因为自己坏了把 pi 弄停摆。
 * - **评估调用要付 thinking**：本网关路由的 `thinking: {type: enabled}` 是
 *   `gateway/config.yaml` 钉死的，客户端关不掉（models.json 里 qwen3.8-flash 的
 *   `thinkingLevelMap.off` 就是 null），实测一次 3-20s。/goal 是每会话主动选择，成本可见。
 * - 闸只看**本次 run**（最后一条 user 消息之后）：上一轮跑过的测试不能为本轮的改动作证
 *   （verification-before-completion 的铁律是 FRESH evidence）。
 */

import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { hasActiveSubagentWork } from "../recap/subagents.ts";
import {
	buildEvaluatorPrompt,
	DEFAULT_CONTEXT_CHARS,
	EVALUATOR_SYSTEM_PROMPT,
	parseVerdict,
} from "./evaluator.ts";
import {
	DEFAULT_DOC_EXTENSIONS,
	DEFAULT_VERIFY_PATTERN,
	decideGate,
	renderGateMessage,
	STRICT_VERIFY_PATTERN,
	VERIFY_LOOP_CUSTOM_TYPE,
	type GateConfig,
	type GateMessage,
	type InjectKind,
} from "./gate.ts";
import {
	applyVerdict,
	clearGoal,
	CLEAR_ALIASES,
	countContinuations,
	decideGoalGate,
	DEFAULT_GOAL_CAP,
	emptyGoal,
	GOAL_ENTRY_TYPE,
	hasGoal,
	renderCapMessage,
	renderHaltMessage,
	renderNotMetMessage,
	renderStatus,
	renderTerminalMessage,
	reconstructGoal,
	setGoal,
	toEntryData,
	type GoalState,
} from "./goal.ts";

/** 评估调用超时（本网关路由带强制 thinking，实测 3-20s，比 recap 的 30s 再宽一点）。 */
const DEFAULT_GOAL_TIMEOUT_MS = 45_000;

/** 缺省评估器模型：本机最便宜的一档（qoder 网关的 Qwen3.8-Flash）。 */
const DEFAULT_EVALUATOR_SPEC = "litellm-any/qwen3.8-flash";

const STATUS_KEY = "verify-goal";

/** 注入消息正文的几何：缩进 2 列 + 树符 2 列，正文从列 4 起（与 bash / background-task 块同一套）。 */
const BODY_INDENT = "  ";
const GUTTER_WIDTH = 2;
const TREE_PIPE = "\u2502 "; // │
const TREE_LAST = "\u2514 "; // └

// =============================================================================
// 配置解析（纯函数，可单测）
// =============================================================================

function parseMode(raw: string | undefined): GateConfig["mode"] {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "off") return "off";
	if (value === "notify") return "notify";
	return "block";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const value = Number.parseInt((raw ?? "").trim(), 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseDocExtensions(raw: string | undefined): string[] {
	if (raw === undefined) return [...DEFAULT_DOC_EXTENSIONS];
	const list = raw
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item !== "");
	return list.map((item) => (item.startsWith(".") ? item : `.${item}`));
}

function parseVerifyPattern(raw: string | undefined): RegExp | undefined {
	const text = (raw ?? "").trim();
	if (text === "") return DEFAULT_VERIFY_PATTERN;
	if (text.toLowerCase() === "strict") return STRICT_VERIFY_PATTERN;
	try {
		return new RegExp(text, "i");
	} catch {
		return DEFAULT_VERIFY_PATTERN;
	}
}

/** 从环境读闸配置。导出供测试。 */
export function resolveGateConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
	return {
		mode: parseMode(env.PI_VERIFY_LOOP),
		verifyPattern: parseVerifyPattern(env.PI_VERIFY_PATTERN),
		docExtensions: parseDocExtensions(env.PI_VERIFY_DOC_EXT),
		blockCap: parsePositiveInt(env.PI_VERIFY_LOOP_CAP, 2),
	};
}

/** 从环境读 goal 配置。导出供测试。 */
export function resolveGoalConfig(env: NodeJS.ProcessEnv = process.env): { cap: number; contextChars: number; timeoutMs: number; modelSpec: string } {
	return {
		cap: parsePositiveInt(env.PI_GOAL_CAP, DEFAULT_GOAL_CAP),
		contextChars: parsePositiveInt(env.PI_GOAL_CONTEXT_CHARS, DEFAULT_CONTEXT_CHARS),
		timeoutMs: parsePositiveInt(env.PI_GOAL_TIMEOUT_MS, DEFAULT_GOAL_TIMEOUT_MS),
		modelSpec: (env.PI_VERIFY_EVALUATOR_MODEL ?? "").trim(),
	};
}

/** 评估器用哪个模型：env 指定 → 缺省 flash → 当前会话模型。 */
export function resolveEvaluatorModel(
	ctx: ExtensionContext,
	modelSpec: string,
): NonNullable<ExtensionContext["model"]> | undefined {
	for (const spec of [modelSpec, DEFAULT_EVALUATOR_SPEC]) {
		const slash = spec.indexOf("/");
		if (slash <= 0) continue;
		const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (found !== undefined) return found;
	}
	return ctx.model;
}

/** 注入条目的 details 形状（渲染器与计数器都读它）。 */
export interface VerifyLoopDetails {
	kind: InjectKind;
	at: number;
}

// =============================================================================
// 扩展主体
// =============================================================================

export default function verifyLoop(pi: ExtensionAPI): void {
	const gateConfig = resolveGateConfig();
	const goalConfig = resolveGoalConfig();

	let goal: GoalState = emptyGoal();

	function persist(): void {
		pi.appendEntry(GOAL_ENTRY_TYPE, toEntryData(goal));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, hasGoal(goal) ? "◎ /goal active" : undefined);
		} catch {
			// ctx 在会话替换后会失效（docs/extensions.md）：拿不到就算了，不影响判定。
		}
	}

	// ── 会话生命周期 ──────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		try {
			goal = reconstructGoal(ctx.sessionManager.getBranch() as unknown[]);
		} catch {
			goal = emptyGoal();
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		goal = emptyGoal();
	});

	// ── 注入消息的渲染（CC 的 "Stop hook feedback" 行）──────────────────────
	//
	// 形态与 bash / plan / background-task 块同族（用户 2026-10-18 定）：
	//
	//   • ⚠ verify-loop:
	//     │ 你声称完成，但本次 run 的文件改动（…）之后没有跑过任何命令…
	//     └ 这是第 1/2 次拦截；达到上限后不再拦截。
	//
	// **不套 Box**：原来的 `Box(outputPad, 1, bg customMessageBg)` 给了整块底色 + 上下各
	// 一行空行，跟其它块摆在一起时明显是另一种块。现在返回一个自带 `render(width)` 的对象
	// （`CustomMessageComponent` 接受任何组件形状），底色与那两条空行一起消失 —— 上方仍剩
	// 一行，那是组件构造时写死的 `Spacer(1)`，与 self 壳工具块同一条。
	//
	// 圆点与标签**同槽**：拦截（gate）/ 停与上限 → `warning`（用户要的「还是原有的警告颜色」），
	// 达成 → `success`，不可能 → `error`，未达成 → `accent`；标签加粗。正文不染色，
	// 结构符 `│` / `└` 走 `dim`。折行在挂树符**之前**做（正文宽度 = 总宽 - 缩进 - 树符），
	// 所以树是连续的：除末行外全 `│ `，末行 `└ `。

	/** 注入消息的标题：圆点与标签共用同一个语义色槽。 */
	function messageTitle(kind: InjectKind, theme: Theme): string {
		const label = (
			{
				gate: ["warning", "⚠ verify-loop:"],
				"goal-met": ["success", "◎ goal met:"],
				"goal-impossible": ["error", "◎ goal impossible:"],
				"goal-halted": ["warning", "◎ goal halted:"],
				"goal-cap": ["warning", "◎ goal halted:"],
				"goal-not-met": ["accent", "◎ goal not met:"],
			} as const
		)[kind] ?? (["warning", "⚠ verify-loop:"] as const);
		const [slot, text] = label;
		return `${theme.fg(slot, "\u2022")} ${theme.fg(slot, theme.bold(text))}`;
	}

	pi.registerMessageRenderer<VerifyLoopDetails>(VERIFY_LOOP_CUSTOM_TYPE, (message, _options, theme) => {
		const kind = (message.details?.kind ?? "gate") as InjectKind;
		const title = messageTitle(kind, theme);
		const body = typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("\n");
		// 消息是静态的，按宽度缓存排版（与工具块同一套做法）
		const cache = new Map<number, string[]>();
		return {
			render(width: number): string[] {
				const hit = cache.get(width);
				if (hit !== undefined) return hit;
				const total = Math.max(1, width || 80);
				// 标题顶格（不挂缩进），折行预算就是整个宽度
				const lines = wrapTextWithAnsi(title, total);
				const bodyWidth = Math.max(1, total - BODY_INDENT.length - GUTTER_WIDTH);
				const rows: string[] = [];
				for (const line of body.split("\n")) rows.push(...wrapTextWithAnsi(line, bodyWidth));
				for (let index = 0; index < rows.length; index += 1) {
					lines.push(BODY_INDENT + theme.fg("dim", index === rows.length - 1 ? TREE_LAST : TREE_PIPE) + rows[index]!);
				}
				cache.set(width, lines);
				return lines;
			},
			invalidate() {
				cache.clear();
			},
		};
	});

	// ── /goal 命令 ─────────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set a completion condition; an independent model evaluates it at the end of every turn (/goal shows status, /goal clear clears it)",
		handler: async (args, ctx) => {
			const text = args.trim();

			if (text === "") {
				const messages = ctx.sessionManager.buildContextEntries() as unknown as readonly GateMessage[];
				ctx.ui.notify(renderStatus(goal, Date.now(), goalConfig, countContinuations(messages)), "info");
				return;
			}

			if (CLEAR_ALIASES.has(text.toLowerCase())) {
				if (goal.condition === "") {
					ctx.ui.notify("No /goal is set", "info");
					return;
				}
				const cleared = goal.condition;
				goal = clearGoal();
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`Goal cleared: ${cleared}`, "info");
				return;
			}

			goal = setGoal(text, Date.now());
			persist();
			updateStatus(ctx);

			// CC："Setting a goal starts a turn immediately, with the condition itself
			// as the directive. You don't need to send a separate prompt."
			pi.sendUserMessage(buildGoalDirective(goal.condition), {
				deliverAs: ctx.isIdle() ? undefined : "followUp",
			});
		},
	});

	// ── 边界：先闸后 goal ──────────────────────────────────────────────────

	pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx) => {
		// CC：abort 不触发 Stop，API 错误走 StopFailure —— 两者都不 gate。
		if (event.outcome !== "completed") return undefined;

		const messages = event.context.contextMessages as unknown as readonly GateMessage[];

		// 1) 确定性闸（CC 的 command 型 Stop hook）
		const decision = decideGate(messages, gateConfig);
		if (decision.action === "block") {
			const text = renderGateMessage(decision);
			if (gateConfig.mode === "notify") {
				if (ctx.hasUI) ctx.ui.notify(`[verify-loop] ${text.split("\n")[0]}`, "warning");
				return undefined;
			}
			return {
				entries: [...event.entries, customDraft("gate", text)],
				continue: true,
			};
		}

		// 2) goal 评估（CC 的 prompt 型 Stop hook / /goal）
		if (!hasGoal(goal)) return undefined;

		const gate = decideGoalGate(goal, messages, goalConfig);
		if (gate.action === "none") return undefined;

		if (gate.action === "cap") {
			return { entries: [...event.entries, customDraft("goal-cap", renderCapMessage(goal, goalConfig))] };
		}
		if (gate.action === "halt") {
			return { entries: [...event.entries, customDraft("goal-halted", renderHaltMessage(goal, gate.streak))] };
		}

		// CC："If a subagent or a background shell command is still running when a turn
		// ends, Claude Code skips the evaluation for that turn."
		if (await subagentsBusy()) return undefined;

		const verdict = await evaluate(ctx, messages, goal.condition);
		if (verdict === undefined) {
			// fail-open：评估器坏了不拦回合（CC 的 hook 失败同样不拦）。
			if (ctx.hasUI) ctx.ui.notify("[verify-loop] /goal evaluation failed; letting this turn through", "warning");
			return undefined;
		}

		goal = applyVerdict(goal, verdict.verdict, verdict.reason);
		persist();
		updateStatus(ctx);

		if (verdict.verdict === "not_met") {
			return {
				entries: [
					...event.entries,
					customDraft("goal-not-met", renderNotMetMessage(goal, verdict.reason, goalConfig, gate.continuations)),
				],
				continue: true,
			};
		}
		const kind: InjectKind = verdict.verdict === "met" ? "goal-met" : "goal-impossible";
		return { entries: [...event.entries, customDraft(kind, renderTerminalMessage(goal, verdict.verdict, verdict.reason))] };
	});

	// ── 内部 ───────────────────────────────────────────────────────────────

	function customDraft(kind: InjectKind, text: string) {
		return {
			type: "custom_message" as const,
			customType: VERIFY_LOOP_CUSTOM_TYPE,
			content: text,
			display: true,
			details: { kind, at: Date.now() } satisfies VerifyLoopDetails,
		};
	}

	async function subagentsBusy(): Promise<boolean> {
		try {
			return await hasActiveSubagentWork(pi.events);
		} catch {
			return false;
		}
	}

	async function evaluate(
		ctx: ExtensionContext,
		messages: readonly GateMessage[],
		condition: string,
	): Promise<{ verdict: "met" | "not_met" | "impossible"; reason: string } | undefined> {
		const model = resolveEvaluatorModel(ctx, goalConfig.modelSpec);
		if (model === undefined) return undefined;

		let conversation: string;
		try {
			conversation = serializeConversation(convertToLlm(messages as never));
		} catch {
			return undefined;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), goalConfig.timeoutMs);
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: EVALUATOR_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: buildEvaluatorPrompt(condition, conversation, goalConfig.contextChars) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: controller.signal,
					maxTokens: 512,
					temperature: 0,
					cacheRetention: "none",
				},
			);
			const text = response.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("")
				.trim();
			if (text === "") return undefined;
			return parseVerdict(text);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}
}

/** /goal 设定后立刻起一轮的指令（CC：条件本身就是 directive）。 */
export function buildGoalDirective(condition: string): string {
	return (
		`/goal 已设定完成条件，请朝它工作，直到条件达成：\n\n${condition}\n\n` +
		`每轮结束后会有一个独立评估器只读对话内容判定条件是否达成 —— 它自己不能跑命令，` +
		`所以**证据必须出现在你的输出里**（跑命令并贴出输出、展示文件内容）。` +
		`条件达成前不要停下来等我确认。`
	);
}
