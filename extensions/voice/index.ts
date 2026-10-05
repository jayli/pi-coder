/**
 * voice — 把本轮的最终结论用语音读出来（macOS `say`，TUI 专用）。
 *
 * 设计说明就在本文件（本扩展是 bounded 改动，没有单独的 design 文档）：下面是触发点、
 * 去重、子代理退让、打断、配置五节的取舍；精简规则与其依据在 `text.ts` 头部，
 * 与 pi 无关的那半边（配置 / 结论选取 / 播不播的状态机）在 `controller.ts`。
 *
 * ## 触发点
 *
 * **主触发点：`turn_end` 里「结论那一条」**（`isConcludingMessage`：无工具调用的 `stop`
 * 且有文本）—— 结论一上屏就出声，**不等 pi-subagents 的 watchdog**（用户 2026-10-04 明确
 * 要求）。watchdog 审查挂在 `agent_end` 处理器里（实测 7~17s），而 pi 要等所有 `agent_end`
 * 处理器 settle 才发 `agent_settled` —— 只挂 settled 的话，开口会晚十几秒。`turn_end` 时
 * 这条消息已经落盘（pi 在 `message_end` 就 append 进 session），所以下面的分支扫描照常。
 *
 * `agent_settled`（pi 的「这轮真的结束了」事件，自动重试、自动压缩、排队续跑全部跑完之后
 * 才发）保留为**兜底**：主触发点门槛漏掉的少数结尾形态（`length` 截断后没有续跑、工具
 * `terminate` 收尾）在 settle 时补一次。指纹去重跨两个触发点，正常路径不会被念两遍。
 * 代价要说清楚：同一个 run 里要是发生续跑（steering / follow-up / 压缩续跑），前一条结论
 * 会先念、续跑的结论再顶掉它（播放器单槽）—— 这是「立即播报」换来的。
 *
 * 为什么不是 `agent_end`：watchdog 就挂在它的处理器里，同批 handler 按注册顺序依次 await，
 * 谁先谁后取决于扩展加载顺序，不能依赖。也用不了 `turn_start` / `message_update`：那还没说完。
 *
 * **为什么不缓存状态**：触发时从 `ctx.sessionManager.getBranch()` 里现取最后一条带文本的
 * assistant 消息（照 `recap/index.ts` 的 getLastExchange 同款做法）。缓存要在
 * message_end / message_update 里维护，且压缩后分支会变，重建成本远高于每次倒序扫一遍。
 *
 * ## 去重
 *
 * settled 理论上每轮只发一次，但保险起见按「文本 + stopReason」指纹去重：同一份内容
 * 不会念两遍（主触发点与兜底触发点共用这份指纹），而模型重新生成出**不同**文本时
 * （真发生过的自动重试场景）会照常念。
 *
 * ## 子代理
 *
 * 后台子代理是独立的 pi 进程（`PI_SUBAGENT_PARENT_SESSION` 环境变量标记），前台子代理
 * 跑在父进程里但**不加载环境扩展**（pi-subagents 的 `ambientExtensions` 只在 host === "runner"
 * 时为真）—— 所以正常情况下本扩展不会在子会话里触发。进程级的 env 检查是第二道保险。
 *
 * ## 打断
 *
 * 单槽播放（见 player.ts）：新一轮开始（`agent_start`）、用户敲了新消息（`input`）、
 * 会话结束（`session_shutdown`）三处立刻打断当前这句，第四处是**按 ESC** —— 用户
 * 2026-10-03 明确要求「念的时候按 ESC 停声」，且这一下按键要吞掉、不传给 pi 的中断，
 * 所以走 `ctx.ui.onTerminalInput`（唯一能在按键到达编辑器之前拦下的通道；
 * `registerShortcut("escape")` 会被 pi 的保留键表直接拒掉）。只在 `speaker.speaking`
 * 为真时消费，其余情况一律放行（见 `attachInputListener`）。
 * 播放不阻塞回合 —— `speak` 只 spawn。
 *
 * ## statusline 指示（`reporting`，用户 2026-10-04 加）
 *
 * 口播流程进行中时，在 statusline 主行末段（`thinking` / `bash` 那个位置）显示 `reporting`：
 * **「对话结束开始发起摘要请求」点亮 → 「口播结束」熄灭**。两个阶段取或：摘要在途
 * （`latestSummary > 0`）或正在发声（`speaker.speaking`）—— 只算前者会漏掉「摘要关掉 /
 * 摘要失败退兜底文本」那条路径，只算后者会漏掉摘要那段（正是沉默最久、最需要解释的窗口）。
 *
 * 实现分两半：本文件只**发布**（`setStatus(REPORTING_STATUS_KEY, …)`，常量在 `status.ts`），
 * 渲染在 `statusline/line.ts` 的 `formatStateSegment`（它排在那里**最高优先**：摘要跑在
 * 结论那一条 `turn_end` 之后、`agent_settled` 之前，那段时间 `streaming` 仍为真、还可能带着
 * 末轮工具，排后面就会被 `thinking` / 工具名盖掉 —— 实测确认摘要确实跑在回合 settle 之前）。
 * 不走 `setWorkingMessage`：那是 spinner 那一行，由 `working-indicator` 驱动，两个扩展写同一处
 * 会互相顶掉。小喇叭 `🔊` 仍走它自己的 `voice` 键（用户要求这条逻辑不变）。
 *
 * 两个容易写错的地方：
 *   - **摘要用代数记账而不是 boolean**：被新一轮打断的摘要会**晚归**（`controller.interrupt()`
 *     只能 abort，下游不保证立即 settle），用 boolean 的话晚归的 A 会把正在跑的 B 的指示误清
 *     —— 有回归用例钉住（真驱动扩展、算好 A/B 重叠时间线）。
 *   - **打断路径必须直接清标志**，不能指望摘要在途那次的 `finally`：abort 后下游可能很久
 *     不 settle，那段窗口里 `reporting` 会一直挂着。`interruptSpeech()` 就是干这个的
 *     （四处打断全走它）。
 *
 * ## 配置
 *
 * `~/.pi/agent/voice.json`（`PI_VOICE_CONFIG` 可改路径）：
 *
 *   { "enabled": true, "voice": "Tingting", "rate": 200, "maxChars": 500, "speakQuestions": true,
 *     "summarize": true, "summaryThreshold": 6, "summaryMaxChars": 100, "summaryTimeoutMs": 15000,
 *     "aliyunVoice": "longanhuan_v3.1" }
 *
 * `PI_VOICE=off` 整体关闭（env 优先于配置）。配置在**每次播报时**现读，改完立刻生效，
 * 不需要 /reload。`voice` / `rate` 只作用于系统 say；`aliyunVoice` 只作用于阿里云口播
 * （见下节）。
 *
 * ## 阿里云口播（可选，配了 key 才走网络）
 *
 * 除了系统 `say`，本扩展还支持阿里云（DashScope 百炼）的 `qwen-audio-3.1-tts-flash`。key **单独**
 * 放在 `~/.config/litellm-any/apikey.json` 的 `aliyunKey` 字段（不是 pi 的 voice.json，也
 * 与网关的其它 key 无关），用 `/voice key sk-xxx` 设置 / 更新、`/voice key clear` 清除、
 * `/voice key` 看状态（掩码显示）。**没配 key 就完全走原来的 say（不联网）**；配了 key 但
 * 云端失败（断网 / 额度 / 鉴权）会提示一次并用 say 念同一段文本兜底（fail-open）。
 * key 每次播报现读，所以改完立即生效，不用重启。
 *
 * 引擎级细节（端点、两步合成、afplay、临时文件、分流与跨引擎单槽语义）都在 `aliyun.ts`
 * 头部。这里只记一件容易踩的事：keystore 是网关与本扩展**共享**的文件，
 * `adapter/admin/keystore.js` 的 normalize 里特意保留了 `aliyunKey` —— 否则从 admin UI
 * （:996）保存任何配置都会把它静默清掉。
 *
 * ## 口播摘要（默认每一轮都念摘要）
 *
 * 本地精简（`text.ts` 的 `toSpeakable`）能剥掉代码 / 路径 / 表格，但**剥不掉内容本身**：
 * 一段 800 字的结论精简完还有 600 字，念完要两分钟。所以精简后达到 `summaryThreshold`
 * 的文本，再调一次模型把它改写成 1~3 句口播稿（提示词与清洗在 `text.ts` 的
 * `buildSummaryPrompt` / `cleanSummaryText`）。
 *
 * **阈值默认值 = 可播最低字数（6）**，即用户 2026-10-03 要求的「只播报摘要」：凡是通过
 * `decideSpeak` 的文本一律过一遍口播稿，不再区分长短 —— 否则短句会绕过人设直接念原文，
 * 同一个会话里两种口吻（有时是秘书，有时是模型原话）。把 `summaryThreshold` 调高就退回
 * 「短结论念原文」的旧行为。
 *
 * 口吻（2026-10-04 修订）：**中文机器人秘书助手**，简洁专业地汇报，**不使用任何称呼 /
 * 昵称**（此前用「伙计」称呼用户，听感不自然，已去掉），最多两三句、必须准确（不美化、
 * 不编造）；**在不影响准确性的前提下允许一点点感性的、亲切的表达**，有明确下一步时可以
 * 给一句建议。
 *
 * **字数上有两条硬要求（用户 2026-10-04）**：① 上限 **100 字**（`summaryMaxChars` 可调）；
 * ② **摘要绝不能比原文长，只能更短** —— 所以真实预算是 `min(100, 原文长度)`。这个预算在
 * 两处用同一个算式：`createSummarizer` 把它写进提示词（告诉模型多少字），`resolveSpeech`
 * 对模型返回的结果再夹一刀（不守约的模型在那里被兜住；假摘要器返回超长的回归用例验证的
 * 就是这道夹取）。
 *
 * 模型用**固定的快模型**（`DEFAULT_SUMMARY_MODEL` = `deepseek-flash-qd`，low 推理档），
 * 不用会话模型：摘要只在结论说完后开口，快慢直接决定沉默多久，而会话模型可能是
 * qwen3.8-max 这类重模型（实测同一段结论 14.2~16.4s vs 固定模型的 1.3~5.4s）。
 * 目录里找不到固定模型时退回会话模型（仍然带 low 与同一套提示词）—— 摘要只是增强，
 * 不该因为目录里少一个模型就直接变哑。一次独立的 `ctx.modelRegistry.complete()`
 * （recap / verify-loop / working-indicator 已验证的调用式）：无工具、不进上下文、
 * 不落 session、**不上屏** —— 摘要只进 `say` 的 argv。
 *
 * **请求级 `extra_body` 是整体覆盖**（实测 2026-10-03）：要传 `reasoning_effort` 就必须
 * 把 `qoder_protocol` 一起带上，否则 config 里那条路由的 `extra_body` 被整个换掉、
 * 上游退回 openai 路径并 404。细节与证据在 `SUMMARY_EXTRA_BODY` 的注释。
 *
 * 三条与 recap 同源的纪律：
 *   - **不阻塞回合**：两个触发点（`turn_end` 主触发 / `agent_settled` 兜底）都不 await
 *     `onSettled`（fire-and-forget，照 recap 的 `void … .catch(() => {})`）；等待期间
 *     摘要器由 `retry` 之外的事件取消。
 *   - **可取消**：`controller.interrupt()` 会 abort 在途请求（`agent_start` / 交互式
 *     `input` / ESC / `session_shutdown` 四处都会走到），所以用户问下一句的时候，
 *     上一轮的摘要既不会出声也不会白花钱。
 *   - **fail-open**：取不到模型 / 认证失败 / 超时 / 报错 / 返回空 —— 一律退回本地精简文本
 *     （压到 `summaryMaxChars`）。摘要只是增强，不该因为自己坏了让语音变哑。
 *
 * 超时（`summaryTimeoutMs`，默认 15s）也是实测定的：固定模型 + low 档上首字 0.8~3.2s、
 * 整句 1.3~5.4s（p50 1.8s），15s 是最大观察值的约 3 倍；超时不是无声，而是立即退到
 * 兜底文本 —— 比沉默安全。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

import {
	buildSummaryPrompt,
	cleanSummaryText,
	DEFAULT_SUMMARY_MODEL,
	PREFERRED_VOICES,
	parseVoiceList,
	SUMMARY_SYSTEM_PROMPT,
	toSpeakable,
} from "./text.ts";
import {
	createController,
	configPath,
	isConcludingMessage,
	isEnabled,
	loadConfig,
	saveConfig,
	type Summarizer,
} from "./controller.ts";
import { REPORTING_LABEL, REPORTING_STATUS_KEY } from "./status.ts";
import { createSpeakerRouter, keystorePath, maskKey, readAliyunKey, TTS_MODEL, writeAliyunKey } from "./aliyun.ts";
import { Speaker, listVoices } from "./player.ts";

/**
 * 这一下按键是不是「停声用的 ESC」。
 *
 * 必须走 pi 自己的 `matchesKey`，不能手写 `data === "\x1b"`：ESC 有裸 `\x1b`、
 * Kitty 键盘协议的 CSI-u、xterm modifyOtherKeys 三种编码，pi 启动时会主动启用
 * Kitty 协议（`terminal.js` 发 `\x1b[>{flags}u\x1b[?u\x1b[c`），一旦启用真实终端发的
 * 就不再是裸 `\x1b`（plan-mode 的 shift+tab 踩过同一个坑，注释与回归用例都在那边）。
 */
export function isSpeechInterruptKey(data: string): boolean {
	return matchesKey(data, "escape");
}

/** 摘要模型的最大输出 token（口播稿很短；给足余量但不要让它展开长思考）。 */
const SUMMARY_MAX_TOKENS = 512;

/**
 * 摘要请求的推理强度（用户 2026-10-03 定：速度为先）。
 *
 * 为什么只能走 `onPayload`（两层都是实测确认的，`index.test.ts` 里的“真能落到 HTTP
 * body”用例拿真适配器拦 HTTP 请求体验的就是这个）：
 *
 *   1. **pi 的 anthropic-messages 适配器不认 `extra_body` 选项**：它按自己的字段列表
 *      组装请求体，不认识的键直接丢掉 —— 实测传 `{ extra_body: … }` 时，真适配器发出的
 *      body 里根本没这个字段。`onPayload` 是官方给的“最后一步改 body”的钩子。
 *   2. **请求级 `extra_body` 会整体替换 config 里那条路由的 `extra_body`**，所以
 *      `qoder_protocol` 必须一起带上 —— 只传 `reasoning_effort` 时上游退回 openai 路径
 *      并报 404（实测网关日志 `effort=-` + `HTTP 404`；带上后为 `effort=low protocol=agent`、200）。
 *
 * 不走 `effort`/`thinkingEnabled` 那套 typed 选项：本机 provider 声明了
 * `forceAdaptiveThinking`，那条路只把 `output_config.effort` 写进 body，而网关侧
 * `drop_params` + 配置里的 `extra_body.reasoning_effort` 会让它落不到 agent 模板的
 * `parameters` 上（实测：body 里 `output_config.effort=low`，网关日志仍 `effort=max`）。
 */
const SUMMARY_EXTRA_BODY = { reasoning_effort: "low", qoder_protocol: "agent" };

/**
 * 口播摘要器：拿**固定的快模型**跑一次独立的 `complete()`。
 *
 * 模型选择（用户 2026-10-03 定）：先在模型目录里找 `DEFAULT_SUMMARY_MODEL`
 * （`litellm-any/deepseek-flash-qd`），找不到或**认证不可用**时退回**当前会话模型**
 * —— 摘要只是增强，目录里少了这个模型、或者它恰好没配 key，不该让口播直接变哑或
 * 退回原文口吻（fail-open 的同一原则）。两条都不可用才返回 `undefined`。
 *
 * 用**局部传进来的 ctx** 而不是捕获的 `statusCtx`：每次事件（`turn_end` / `agent_settled`）
 * 都会给新 ctx，用它就不存在「定时器活过会话、访问 stale ctx」那个 recap 踩过的坑。
 *
 * 任何一个环节失败（没有模型 / 认证不可用 / 调用抛异常 / 返回空）都返回 `undefined`，
 * 由 controller 决定退回本地精简文本 —— 这里不抛异常（契约见 `Summarizer`）。
 */
export function createSummarizer(
	getCtx: () => ExtensionContext | undefined,
	maxChars: () => number,
): Summarizer {
	return async (text: string, signal: AbortSignal): Promise<string | undefined> => {
		const ctx = getCtx();
		if (!ctx) return undefined;

		// 告诉模型的字数上限：配置值，但**不超过这段原文本身的长度** —— 摘要只能更短
		// （用户 2026-10-04 的硬要求）。这里只是“把真实预算告诉模型”，硬夹取在
		// `controller.ts` 的 `resolveSpeech`（不守约的模型在那里被兜住）。
		const limit = Math.min(maxChars(), text.length);

		try {
			// `ctx.model` 也放在 try 里：会话被替换后 stale ctx 连属性访问都可能抛
			// （recap 文件头记过这个坑），而契约是「任何问题都返回 undefined」。
			const preferred = ctx.modelRegistry.find("litellm-any", DEFAULT_SUMMARY_MODEL);
			const sessionModel = ctx.model;
			// 候选按顺序试：固定模型在前，会话模型殿后；两者相同时只试一次。
			const candidates = [preferred, sessionModel].filter(
				(model, index, list): model is NonNullable<ExtensionContext["model"]> =>
					model !== undefined && model !== list[index - 1],
			);

			for (const model of candidates) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || signal.aborted) continue;

				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: SUMMARY_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: buildSummaryPrompt(text, limit) }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						signal,
						maxTokens: SUMMARY_MAX_TOKENS,
						// 刻意**不**传 temperature：0 会让这些 max 档路由退化成停不下来的长思考
						// （同一个坑 working-indicator 的摘要请求已踩过，注释在那边）。
						cacheRetention: "none",
						// 唯一能真的落到线上的通道（见 SUMMARY_EXTRA_BODY 注释）。
						onPayload: (payload: unknown) => ({
							...(payload as Record<string, unknown>),
							extra_body: { ...SUMMARY_EXTRA_BODY },
						}),
					},
				);
				if (signal.aborted) return undefined;

				const summary = cleanSummaryText(textFromAssistant(response), limit);
				if (summary.length > 0) return summary;
				// 只走了 thinking / 回了一堆装饰：换下一个候选再试（若有）。
			}
			return undefined;
		} catch {
			return undefined;
		}
	};
}

/** 从 `complete()` 的响应里抽文本（recap / working-indicator 同款）。 */
function textFromAssistant(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			const block = part as { type?: unknown; text?: unknown };
			return block?.type === "text" && typeof block.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

// =============================================================================
// 扩展入口
// =============================================================================

export default function voiceExtension(pi: ExtensionAPI): void {
	// 第二道保险：后台子代理进程不该发声（前台子代理不加载环境扩展，这里是兜底）。
	const inSubagentProcess = Boolean((process.env.PI_SUBAGENT_PARENT_SESSION ?? "").length);

	let statusCtx: ExtensionContext | undefined;
	/** 当前会话的原始输入监听器退订函数（重入防护：每次 session_start 先退旧的）。 */
	let inputUnsubscribe: (() => void) | undefined;
	/**
	 * 「摘要请求在途」的**代数**（另半个 reporting 条件是 `speaker.speaking`）。
	 *
	 * 为什么不是 boolean：被新一轮打断的摘要**晚归**是真实存在的（`controller.interrupt()`
	 * 只能 abort，下游不保证立即 settle —— qoder 卡住时实测就是不 settle）。若只用一个
	 * boolean 记账，晚归的 A 在自己的 `finally` 里会把**正在跑的 B** 的指示误清 —— 有回归
	 * 用例钉住（真驱动扩展，A/B 重叠时间线算好）。每次请求递增取号，只有持有**最新号**的
	 * 那次收尾才能把标志降下来，与 `player.ts` 的 `generation` 同一套做法。
	 *
	 * 两个阶段都属于 `reporting`（用户 2026-10-04 定：「对话结束开始发起摘要请求」点亮，
	 * 「口播结束」熄灭）：只算 speak 会漏掉摘要那段（正是沉默最久、最需要解释的那段），
	 * 只算摘要则会漏掉「摘要关掉 / 摘要失败退兜底文本」那条路径。
	 */
	let summaryGeneration = 0;
	/** 最新那次摘要请求的号；0 表示没有在途的。 */
	let latestSummary = 0;
	/** 上一次发布的 reporting 状态（去重：`setStatus` 每次都触发全屏重绘）。 */
	let reportingPublished: boolean | undefined;
	/** 播放状态 → 状态栏（两个引擎共用一份：云端刚结束就把 say 的状态抹掉是错的）。 */
	const onStateChange = (speaking: boolean): void => {
		try {
			statusCtx?.ui.setStatus("voice", speaking ? "🔊" : undefined);
		} catch {
			// 旧 ctx：忽略
		}
		// 播放开始 / 结束也会改变 reporting（摘要可能早就结束了，如摘要被关掉时）。
		syncReporting();
	};
	/**
	 * 把「口播流程进行中」发布到 statusline（主行末段，与 thinking / bash 同一个位置）。
	 *
	 * 发布的是**事实**（摘要请求在途或正在发声），不是推断；两个触发源取或，
	 * 所以任何一条路径结束都不会误清另一条还在跑的。状态真变了才发（去重）。
	 */
	function syncReporting(): void {
		const active = latestSummary > 0 || speaker.speaking;
		if (active === reportingPublished) return;
		reportingPublished = active;
		try {
			statusCtx?.ui.setStatus(REPORTING_STATUS_KEY, active ? REPORTING_LABEL : undefined);
		} catch {
			// 旧 ctx：忽略
		}
	}
	/** 出问题时报一次，别把 stderr 刷屏。 */
	const onError = (message: string): void => {
		try {
			statusCtx?.ui.notify(`voice: ${message}`, "warning");
		} catch {
			// 旧 ctx：忽略
		}
	};

	// 有 aliyunKey 走云端、没有走本地 say、云端失败退回 say —— 分流在每次播报时现读 key。
	const speaker = createSpeakerRouter({
		say: new Speaker({ onError, onStateChange }),
		readKey: () => readAliyunKey(keystorePath()),
		readVoice: () => loadConfig(configPath()).aliyunVoice,
		readInstruction: () => loadConfig(configPath()).aliyunInstruction,
		onError,
		onStateChange,
	});

	const summarize = createSummarizer(
		() => statusCtx,
		() => loadConfig(configPath()).summaryMaxChars,
	);

	const controller = createController({
		speaker,
		readConfig: () => loadConfig(configPath()),
		// 摘要器每次播报时现场取 ctx / 字数上限（配置每次播报现读，改完立即生效）。
		// **外面这层只负责 reporting 指示**：请求发出的那一刻点亮（用户要的时机是「开始
		// 发起摘要请求」），无论成败 / 超时 / 被打断都在 finally 里收场 —— 所以指示不会
		// 卡住，摘要是 fail-open 的、这里也不能例外。
		summarize: async (text, signal) => {
			const generation = ++summaryGeneration;
			latestSummary = generation;
			syncReporting();
			try {
				return await summarize(text, signal);
			} finally {
				// 只有最新那次收尾才能降下标志：晚归的旧请求不能碰新一轮的指示。
				if (latestSummary === generation) {
					latestSummary = 0;
					syncReporting();
				}
			}
		},
		onSkip: () => {},
	});

	/**
	 * 主触发点：结论那一条 `turn_end` —— 结论一上屏就播，不等 watchdog（见文件头）。
	 *
	 * 门槛全在 `isConcludingMessage`（中间轮的 turn_end 一轮对话里几十条，不能都念）。
	 * 与 settled 那条一样**不 await**：长结论的摘要是模型调用，await 会把后面的 turn_end
	 * handler（pi-subagents 的 delta 缓冲）堵住。
	 */
	pi.on("turn_end", async (event, ctx) => {
		if (inSubagentProcess) return;
		if (!isConcludingMessage(event.message)) return;
		statusCtx = ctx;
		const entries = (ctx.sessionManager?.getBranch?.() ?? []) as unknown[];
		void controller.onSettled(entries).catch(() => {});
	});

	/**
	 * 兜底触发点：主触发点门槛没覆盖的结尾形态（`length` 截断、工具 `terminate` 收尾）
	 * 在真正的 settle 时补一次。指纹去重保证已被 turn_end 念过的内容不会重复。
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		if (inSubagentProcess) return;
		statusCtx = ctx;
		const entries = (ctx.sessionManager?.getBranch?.() ?? []) as unknown[];
		// **不 await**：长结论的摘要是一次模型调用（最长 `summaryTimeoutMs`），
		// await 会把 pi 的 settled 处理堵在后面（recap 同款 fire-and-forget）。
		void controller.onSettled(entries).catch(() => {});
	});

	/**
	 * 四处打断（`agent_start` / 交互式 `input` / ESC / `session_shutdown`）都必须走这里，
	 * 而不是直接调 `controller.interrupt()`。
	 *
	 * 为什么不用 onStateChange 兜：打断时如果摘要还在途，`controller.interrupt()` 只是 abort
	 * 掉它，而 summarizer 的 `finally` 要等下游 promise settle 才跑 —— 被 abort 的下游**不保证**
	 * 立即 settle（qoder 卡住时实测就是不 settle），那段窗口里 `reporting` 会一直挂着。
	 * 所以打断时直接清掉「摘要在途」这个标志（另半边 `speaker.speaking` 由 interrupt 同步收尾）。
	 */
	const interruptSpeech = (): void => {
		controller.interrupt();
		latestSummary = 0;
		syncReporting();
	};

	pi.on("agent_start", async () => interruptSpeech());

	/**
	 * 装「按 ESC 停声」的原始输入监听器。
	 *
	 * 为什么不用 `pi.registerShortcut("escape", …)`：ESC 在 pi 的
	 * `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 里（`app.interrupt`），
	 * 扩展注册会被直接拒绝并打一条 warning，走不通。`ctx.ui.onTerminalInput`
	 * 是唯一能在按键到达编辑器**之前**拦下它的通道（plan-mode 的 shift+tab 同款）。
	 *
	 * 只吞播放中的那一下 ESC：只在 `speaker.speaking` 为真时返回 `{consume:true}`，
	 * 其余情况一律返回 undefined 放行，ESC 的中断语义（流式输出 / `!` bash / 弹窗）不变。
	 *
	 * 必须防重入：`/reload`、`/new`、`/resume` 都会重跑 `session_start`，不先退旧的就会叠加，
	 * 一次按键停两遍（plan-mode 同款注释与回归用例）。pi 换会话时会清掉监听器，但 `
	 * `/reload` 不保证清干净，所以自己先退一次。
	 */
	function attachInputListener(ctx: ExtensionContext): void {
		inputUnsubscribe?.();
		inputUnsubscribe = undefined;
		if (ctx.mode !== "tui" || inSubagentProcess) return;
		try {
			inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (!isSpeechInterruptKey(data) || !speaker.speaking) return undefined;
				interruptSpeech();
				return { consume: true };
			});
		} catch {
			// 宿主没有原始输入通道：ESC 停声不可用，/voice stop 仍在
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		statusCtx = ctx;
		attachInputListener(ctx);
	});

	pi.on("input", async (event) => {
		// 只认交互输入：rpc / extension 来源的投递（后台任务通知之类）不该打断正在念的结论。
		if (event.source === "interactive") interruptSpeech();
	});
	pi.on("session_shutdown", async () => {
		// 先清指示再 shutdown：`statusCtx` 马上要置 undefined，之后再想清就清不掉了。
		latestSummary = 0;
		reportingPublished = false;
		try {
			statusCtx?.ui.setStatus(REPORTING_STATUS_KEY, undefined);
		} catch {
			// 旧 ctx：忽略
		}
		controller.shutdown();
		inputUnsubscribe?.();
		inputUnsubscribe = undefined;
		statusCtx = undefined;
	});

	pi.registerCommand("voice", {
		description: "语音播报：状态 / 开关 / 试听 / 音色列表 / 阿里云 Key",
		async handler(args, ctx) {
			const file = configPath();
			const config = loadConfig(file);
			const sub = args.trim().split(/\s+/)[0] ?? "";

			if (sub === "") {
				const state = isEnabled(process.env, config) ? "on" : "off";
				const aliyunKey = readAliyunKey(keystorePath());
				const lines = [
					`语音播报：${state}`,
					aliyunKey
						? `引擎：阿里云 ${TTS_MODEL}（音色 ${config.aliyunVoice}${
								config.aliyunInstruction ? ` · 指令「${config.aliyunInstruction}」` : ""
							}）· key ${maskKey(aliyunKey)}`
						: `引擎：系统 say（音色 ${config.voice || "默认"}${config.rate ? ` · 语速 ${config.rate}` : ""}）· 未配 aliyunKey`,
					`上限：${config.maxChars} 字 · ${config.speakQuestions ? "播" : "不播"}问句 · 配置文件：${file}`,
					config.summarize
						? `摘要：结论 ${config.summaryThreshold} 字起做口播稿（上限 ${config.summaryMaxChars} 字，模型 ${DEFAULT_SUMMARY_MODEL} / low 推理）`
						: "摘要：关闭（直接念本地精简结果）",
				];
				if (!ctx.hasUI) {
					ctx.ui.notify(lines.join(" | "), "info");
					return;
				}
				const choice = await ctx.ui.select("Voice", [...lines, "开/关播报", "试听一句", "列中文音色"]);
				if (!choice || lines.includes(choice)) return;
				if (choice === "开/关播报") {
					const next = saveConfig(file, { enabled: !isEnabled(process.env, config) });
					ctx.ui.notify(`语音播报：${next.enabled ? "on" : "off"}`, "info");
					return;
				}
				if (choice === "试听一句") {
					speaker.speak("这是一句试听，语音播报已经可以用了。", { voice: config.voice, rate: config.rate });
					return;
				}
				if (choice === "列中文音色") {
					const voices = parseVoiceList(listVoices());
					const zh = voices.filter((v) => v.locale.startsWith("zh"));
					const preferred = PREFERRED_VOICES.filter((name) => voices.some((v) => v.name === name));
					const summary = [
						`中文音色 ${zh.length} 个（共 ${voices.length}）`,
						`推荐：${preferred.join(" / ") || "Tingting"}`,
						`其他：${zh.map((v) => v.name).join(" / ")}`,
						`改音色：编辑 ${file} 的 voice 字段`,
					];
					ctx.ui.notify(summary.join("\n"), "info");
					return;
				}
			}

			if (sub === "key") {
				const keystore = keystorePath();
				const value = args.trim().slice("key".length).trim();
				if (value === "") {
					const current = readAliyunKey(keystore);
					ctx.ui.notify(
						current
							? `阿里云口播：已配置（${maskKey(current)}）→ ${TTS_MODEL}，音色 ${config.aliyunVoice}\n文件：${keystore}\n清除：/voice key clear`
							: `阿里云口播：未配置 → 走系统 say（不联网）\n文件：${keystore}\n设置：/voice key sk-xxxxxxxx`,
						"info",
					);
					return;
				}
				try {
					writeAliyunKey(keystore, value === "clear" ? undefined : value);
				} catch (error) {
					ctx.ui.notify(
						`阿里云 Key 写入失败：${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(
					value === "clear"
						? "已清除 aliyunKey —— 口播回到系统 say"
						: `已写入阿里云 Key（${maskKey(value)}）—— 口播走 ${TTS_MODEL}（${config.aliyunVoice}）`,
					"info",
				);
				return;
			}

			if (sub === "on" || sub === "off") {
				const next = saveConfig(file, { enabled: sub === "on" });
				ctx.ui.notify(`语音播报：${next.enabled ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "summary") {
				const next = saveConfig(file, { summarize: !config.summarize });
				ctx.ui.notify(`口播摘要：${next.summarize ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "test") {
				const text = args.trim().slice("test".length).trim();
				speaker.speak(text || toSpeakable("这是一句试听，语音播报已经可以用了。"), {
					voice: config.voice,
					rate: config.rate,
				});
				return;
			}

			if (sub === "voices") {
				const voices = parseVoiceList(listVoices());
				const zh = voices.filter((v) => v.locale.startsWith("zh"));
				ctx.ui.notify(
					`中文音色 ${zh.length} 个 / 共 ${voices.length} 个：\n${zh.map((v) => `${v.name} (${v.locale})`).join("\n")}`,
					"info",
				);
				return;
			}

			if (sub === "stop") {
				speaker.stop();
				ctx.ui.notify("已停止播报", "info");
				return;
			}

			ctx.ui.notify(`用法：/voice [on|off|summary|key <sk-xxx|clear>|test <文字>|voices|stop]，配置文件 ${file}`, "info");
		},
	});
}
