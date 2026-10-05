/**
 * voice/controller — 与 pi **完全无关**的那一半：配置读写、本轮结论的选取、播/不播的
 * 状态机。刻意不 import pi / pi-tui（本仓约定，见 clients/pi/README.md）：`node --test`
 * 可以直接驱动它，而真按键编码（`matchesKey`）留在 `index.ts` 那一侧测。
 *
 * 触发点、去重、子代理退让、打断、配置四节的取舍在 `index.ts` 头部；精简规则在 `text.ts`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	DEFAULT_MAX_CHARS,
	DEFAULT_SUMMARY_MAX_CHARS,
	MIN_SPEAKABLE_CHARS,
	decideSpeak,
	truncateWithin,
} from "./text.ts";

const CONFIG_FILENAME = "voice.json";

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 调用摘要模型的时间上限（`voice.json` 的 `summaryTimeoutMs` 可改）。
 *
 * 15s 是**实测**定的（2026-10-03 本机网关，固定模型 `deepseek-flash-qd` + low 档，
 * 同一段 130 字结论采样 10 次）：首字 0.8~3.2s、整句 1.3~5.4s，p50 1.8s —— 取最大
 * 观察值的约 3 倍余量。固定模型后不会再碰到 30s 那种量级：之前的 30s 是为了不漏掉
 * 会话里的重模型（qwen3.8-max 实测 14.2~16.4s），现在这个前提没有了。
 *
 * 超时后不是无声，而是立即退到兜底文本（本地精简结果，压到 `summaryMaxChars`）
 * ——这是相对沉默更安全的失败形态。
 */
export const DEFAULT_SUMMARY_TIMEOUT_MS = 15_000;

/**
 * 阿里云口播（`qwen-audio-3.1-tts-flash`）的默认音色。
 *
 * `longanhuan_v3.1`（龙安欢）是用户 2026-10-04 选定的 —— 此前的 `Cherry` 属于旧模型
 * `qwen3-tts-flash`，两者不通用（见 `aliyun.ts` 的 `TTS_MODEL`）。
 */
export const DEFAULT_ALIYUN_VOICE = "longanhuan_v3.1";

/**
 * 达到这个字数（本地精简后）才去调模型做口播摘要（`voice.json` 的 `summaryThreshold` 可改）。
 *
 * 默认值 = `MIN_SPEAKABLE_CHARS`（6），即**不区分长短**：用户 2026-10-03 要求「只播报
 * 摘要」，凡是通过 `decideSpeak` 的文本（已过滤过短 / 装饰性 / 问句）一律过一遍口播稿
 * ——否则「搞定了，重启即可生效。」这种短句会绕过人设直接念原文，同一个会话里两种口吻
 * （有时是秘书，有时是模型原话）反而不统一。代价是每轮多一次 1~5s 的请求。
 * 调高这个值就退回「短结论直接念原文」的旧行为（省一次请求与延迟）。
 */
export const DEFAULT_SUMMARY_THRESHOLD = MIN_SPEAKABLE_CHARS;

export interface VoiceConfig {
	enabled: boolean;
	voice: string;
	rate: number | undefined;
	/** 阿里云口播的音色（`qwen-audio-3.1-tts-flash` 的音色名，如 longanhuan_v3.1）；只在配了 aliyunKey 时生效。 */
	aliyunVoice: string;
	/**
	 * 阿里云口播的指令控制（`input.instruction`）：用自然语言控制方言 / 情感 / 角色，
	 * 如 `请用重庆话口音播报。`；空串则不带这个字段（行为与没有这个功能时一致）。
	 * 只在配了 aliyunKey 时生效，且只对支持指令的模型 / 音色有效。
	 */
	aliyunInstruction: string;
	maxChars: number;
	speakQuestions: boolean;
	/** 是否对长结论做口播摘要（关掉就回到「念本地精简结果」的老行为）。 */
	summarize: boolean;
	/** 超过这个字数（本地精简后）才调摘要模型。 */
	summaryThreshold: number;
	/** 摘要的字数上限。 */
	summaryMaxChars: number;
	/** 摘要调用的超时（毫秒），超时就走兜底文本。 */
	summaryTimeoutMs: number;
}

export const DEFAULT_CONFIG: VoiceConfig = {
	enabled: true,
	voice: "Tingting",
	rate: undefined,
	aliyunVoice: DEFAULT_ALIYUN_VOICE,
	aliyunInstruction: "",
	maxChars: DEFAULT_MAX_CHARS,
	speakQuestions: true,
	summarize: true,
	summaryThreshold: DEFAULT_SUMMARY_THRESHOLD,
	summaryMaxChars: DEFAULT_SUMMARY_MAX_CHARS,
	summaryTimeoutMs: DEFAULT_SUMMARY_TIMEOUT_MS,
};

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，与 memory/store.ts 同款）。 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	if (envDir && envDir.length > 0) {
		return path.join(envDir.startsWith("~") ? os.homedir() : "", envDir.replace(/^~/, ""));
	}
	return path.join(os.homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_VOICE_CONFIG;
	if (override && override.length > 0) {
		return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
	}
	return path.join(agentDir(env), CONFIG_FILENAME);
}

/**
 * 从文件读配置。**任何问题都退回默认值**：文件不存在、JSON 坏了、字段类型不对都一样 ——
 * 一个读不到的配置不该让播报崩掉，也不该让 pi 启动阶段报错。
 */
export function loadConfig(configFile: string): VoiceConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CONFIG };

	const obj = raw as Record<string, unknown>;
	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled;
	const voice = typeof obj.voice === "string" ? obj.voice : DEFAULT_CONFIG.voice;
	const rate =
		typeof obj.rate === "number" && Number.isFinite(obj.rate) && obj.rate > 0 ? obj.rate : DEFAULT_CONFIG.rate;
	const aliyunVoice =
		typeof obj.aliyunVoice === "string" && obj.aliyunVoice.trim().length > 0
			? obj.aliyunVoice.trim()
			: DEFAULT_CONFIG.aliyunVoice;
	// 空串是**合法值**（表示「不发指令」），所以这里不能用「非空才接受」的写法。
	const aliyunInstruction =
		typeof obj.aliyunInstruction === "string" ? obj.aliyunInstruction.trim() : DEFAULT_CONFIG.aliyunInstruction;
	const maxChars =
		typeof obj.maxChars === "number" && Number.isFinite(obj.maxChars) && obj.maxChars > 0
			? Math.floor(obj.maxChars)
			: DEFAULT_CONFIG.maxChars;
	const speakQuestions =
		typeof obj.speakQuestions === "boolean" ? obj.speakQuestions : DEFAULT_CONFIG.speakQuestions;
	const summarize = typeof obj.summarize === "boolean" ? obj.summarize : DEFAULT_CONFIG.summarize;
	const summaryThreshold = isPositiveNumber(obj.summaryThreshold)
		? Math.floor(obj.summaryThreshold)
		: DEFAULT_CONFIG.summaryThreshold;
	const summaryMaxChars = isPositiveNumber(obj.summaryMaxChars)
		? Math.floor(obj.summaryMaxChars)
		: DEFAULT_CONFIG.summaryMaxChars;
	const summaryTimeoutMs = isPositiveNumber(obj.summaryTimeoutMs)
		? Math.floor(obj.summaryTimeoutMs)
		: DEFAULT_CONFIG.summaryTimeoutMs;

	return {
		enabled,
		voice,
		rate,
		aliyunVoice,
		aliyunInstruction,
		maxChars,
		speakQuestions,
		summarize,
		summaryThreshold,
		summaryMaxChars,
		summaryTimeoutMs,
	};
}

/** 写配置（`/voice` 命令用）。目录不存在时创建。 */
export function saveConfig(configFile: string, patch: Partial<VoiceConfig>): VoiceConfig {
	const next = { ...loadConfig(configFile), ...patch };
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}

/** 整体开关：env `PI_VOICE=off` 优先于配置。 */
export function isEnabled(env: NodeJS.ProcessEnv, config: VoiceConfig): boolean {
	const envValue = (env.PI_VOICE ?? "").trim().toLowerCase();
	if (envValue === "0" || envValue === "false" || envValue === "off" || envValue === "no") return false;
	if (envValue === "1" || envValue === "true" || envValue === "on" || envValue === "yes") return true;
	return config.enabled;
}

// =============================================================================
// 从分支里取「本轮的最终 assistant 文本」
// =============================================================================

interface CandidateMessage {
	text: string;
	stopReason: string | undefined;
}

/** 从消息内容里抽纯文本块（与 recap 同款）。 */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => (block as { text?: unknown }).text)
		.filter((value): value is string => typeof value === "string")
		.join("\n")
		.trim();
}

/**
 * 倒序找最后一条带文本的 assistant 消息。
 *
 * 一定要带 stopReason 一起返回：`aborted` / `error` 的轮次要被过滤掉（用户刚按了 ESC
 * 或者上游报错，那时候念出来的不是结论）。
 */
export function lastAssistantText(entries: unknown[]): CandidateMessage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown; stopReason?: string } };
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant") continue;
		const text = textFromContent(message.content);
		if (!text) continue;
		return { text, stopReason: message.stopReason };
	}
	return undefined;
}

/** 指纹：内容 + 停止原因（同内容不去重、重新生成出不同内容时会再念）。 */
export function fingerprint(candidate: CandidateMessage): string {
	return `${candidate.stopReason ?? ""}\u0000${candidate.text}`;
}

/**
 * 这条 assistant 消息是不是「本轮结论」—— 决定 voice 能不能**立即**播报（主触发点）。
 *
 * 为什么需要它：`turn_end` 每条消息都发（一轮对话几十条），而我们只想要「模型这一轮真的
 * 说完了」那一条。pi 的 stopReason 已经把姿态说清楚了：
 *   - `stop`：这一轮说完了（有没有工具调用另看内容）；
 *   - `toolUse`：还要接着调工具，是中间态（「我先看一下文件。」这类）；
 *   - `length`：输出被 token 上限截断，pi 可能接着做 overflow 恢复（不是结论）；
 *   - `error` / `aborted`：失败轮次（`decideSpeak` 本来就不播）。
 * 另加两条内容检查：
 *   - 必须至少有一个非空 text 块 —— 只有 thinking 的 stop 消息没有可播内容；若不拦，
 *     倒序分支扫描会往下抓到**上一轮**的中间文本（真的会念错）；
 *   - 不能有 toolCall 块 —— 双保险（正常 provider 会把带工具调用的消息标成 `toolUse`，
 *     但判定意图写在内容上也更清楚）。
 */
export function isConcludingMessage(message: unknown): boolean {
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

/** 说话人的最小接口（测试注入）。 */
export interface SpeakerLike {
	speak(text: string, options: { voice?: string; rate?: number }): void;
	interrupt(): void;
	stop(): void;
	readonly speaking: boolean;
}

/**
 * 口播摘要的注入点（`index.ts` 接真模型，测试接假实现）。
 *
 * 契约三条：
 *   - 返回**已经清洗过**的摘要文本，失败 / 超时 / 模型返回空一律返回 `undefined`（不要抛）；
 *   - `signal` 被 abort 后要尽早退出，且退出的那次**不得**再让调用方出声
 *     （调用方在 await 之后还会重申一次 `signal.aborted`，这里是第一道）；
 *   - 不得抛异常 —— 调用方虽然也兜了 try/catch，但 fail-open 是注入方的责任。
 */
export type Summarizer = (text: string, signal: AbortSignal) => Promise<string | undefined>;

/** 事件接线与状态机，与 pi 的 API 解耦，`node --test` 可直接驱动。 */
export interface VoiceController {
	/**
	 * 判定 + 播报。调用点由 `index.ts` 决定：`turn_end` 的「结论那一条」是主触发
	 * （立即播，不等 watchdog），`agent_settled` 是兜底（门槛漏掉的结尾形态）。
	 * 返回是否在 **await 完成时**已经出声（测试用）。
	 *
	 * 需要摘要的长结论会先 await 一次模型调用再出声，所以这个 Promise 的 resolve 时间
	 * 是「念完了还是决定不念」，不是「已念完」。调用方（`index.ts` 的事件处理器）**不应** await。
	 */
	onSettled(entries: unknown[]): Promise<boolean>;
	/** 新一轮开始 / 用户输入 / 按 ESC：打断（同时取消在途的摘要）。 */
	interrupt(): void;
	/** 会话结束：停表清理。 */
	shutdown(): void;
	/** 供测试观察最后一次跳过原因。 */
	lastSkipReason: string | undefined;
	/** 供测试 / `/voice` 观察是否正在生成摘要。 */
	readonly summarizing: boolean;
}

export interface ControllerOptions {
	env?: NodeJS.ProcessEnv;
	readConfig?: () => VoiceConfig;
	speaker: SpeakerLike;
	/** 口播摘要（不提供则永远直接用本地精简文本）。 */
	summarize?: Summarizer;
	/** 播报前的通知（未配置时静默）。 */
	onSkip?: (reason: string) => void;
	/** 只在这些模式下播（默认 tui）。 */
	mode?: string;
}

export function createController(options: ControllerOptions): VoiceController {
	const env = options.env ?? process.env;
	const readConfig = options.readConfig ?? (() => loadConfig(configPath(env)));
	const mode = options.mode ?? "tui";

	let lastFingerprint: string | undefined;
	/** 在途的摘要请求（单槽：新的 settled 顶掉旧的，打断也走这里）。 */
	let pending: AbortController | undefined;

	/**
	 * 决定这一轮念什么。两条路：
	 *   - 短于阈值（或关掉摘要、没有注入摘要器）→ 本地精简文本，立即念；
	 *   - 达到阈值 → 调摘要模型，成功念摘要。**失败 / 超时 / 空则退回本地精简文本，
	 *     并压到摘要同一字数上限** —— 与摘要保持同一量级，不会因为一次网络抖动
	 *     突然念出一大段。
	 * 两条路都不上屏：摘要只进 `say` 的 argv（不写 widget、不 appendEntry、不 notify）。
	 *
	 * **字数上限是 `min(summaryMaxChars, 原文长度)`**（用户 2026-10-04 的硬要求：摘要只能
	 * 比原文短，绝不能更长）。兜底文本本来就不可能比原文长（它就是原文的截断），但摘要是
	 * 模型生成的，所以在**这里**再夹一刀 —— 提示词里的上限是“请模型遵守”，这一步是“不守
	 * 也得守”（测试里假摘要器故意返回超长文本，验证的就是这道夹取）。
	 */
	async function resolveSpeech(
		speakable: string,
		config: VoiceConfig,
	): Promise<{ text: string; summarized: boolean }> {
		const limit = Math.min(config.summaryMaxChars, speakable.length);
		const fallback = truncateWithin(speakable, limit);
		const wantsSummary = config.summarize && options.summarize !== undefined;
		// 默认阈值 = 可播最低字数，所以正常路径下这个条件恒假；用户把阈值调高后才生效。
		if (!wantsSummary || speakable.length < config.summaryThreshold) {
			return { text: fallback, summarized: false };
		}

		// 单槽：上一句还在生成就先取消 —— 与播放器的单槽语义一致（耳朵里只该有一个结论）。
		pending?.abort();
		const controller = new AbortController();
		pending = controller;
		// 超时也走 abort，但它**不是**「这一轮已经过期」：区分开，否则超时会静默不发声，
		// 而契约是「失败 / 超时 → 退回兜底文本」。
		let timedOut = false;
		// 硬超时（线上事故后加的保险，见下方注释）：它不只 abort，还**自己把 await 收场**。
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				controller.abort();
				resolve(undefined);
			}, config.summaryTimeoutMs);
			timeoutHandle.unref?.();
		});

		try {
			// **必须 race 而不是单纯 await**（2026-10-04 线上事故的根因）：
			// `abort()` 只是尽力通知下游，下游 promise **不保证**因此 settle。qoder 网关卡住时
			// 实测就是「不 settle 也不理 abort」，于是 `await` 永远挂住，fail-open 的兜底文本
			// 永远走不到 —— 契约被静默违反，整场播报彻底沉默（网关日志里那条 `effort=low`
			// 的 `request start` 没有对应的 `done`，而且之后没有任何合成临时目录）。
			// race 让超时**无论下游行为如何**都能收场，兜底文本就一定能发出去。
			const summary = await Promise.race([
				options.summarize?.(speakable, controller.signal) ?? Promise.resolve(undefined),
				timeout,
			]);
			// 被新一轮 / 打断 / 会话结束取消：这一轮的结论已经不需要了，直接静默退场。
			// 超时（timedOut）不算取消，它要退兜底文本。
			if (controller.signal.aborted && !timedOut) return { text: "", summarized: false };
			if (summary) {
				// 硬夹一刀：摘要绝不能比原文长（也绝不超 `summaryMaxChars`）。
				const capped = truncateWithin(summary, limit);
				if (capped.length > 0) return { text: capped, summarized: true };
			}
			return { text: fallback, summarized: false };
		} catch {
			return { text: fallback, summarized: false };
		} finally {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (pending === controller) pending = undefined;
		}
	}

	const controller: VoiceController = {
		lastSkipReason: undefined,
		get summarizing(): boolean {
			return pending !== undefined;
		},
		async onSettled(entries: unknown[]): Promise<boolean> {
			const config = readConfig();
			if (mode !== "tui" || !isEnabled(env, config)) {
				controller.lastSkipReason = "disabled";
				return false;
			}

			const candidate = lastAssistantText(entries);
			if (!candidate) {
				controller.lastSkipReason = "empty";
				return false;
			}

			const key = fingerprint(candidate);
			if (key === lastFingerprint) {
				controller.lastSkipReason = "duplicate";
				return false;
			}

			const decision = decideSpeak({
				text: candidate.text,
				stopReason: candidate.stopReason,
				speakQuestions: config.speakQuestions,
				maxChars: config.maxChars,
			});
			if (!decision.speak) {
				controller.lastSkipReason = decision.reason;
				options.onSkip?.(decision.reason);
				// 记指纹：同一份内容不该被反复判定（skip 的理由也一样）。
				lastFingerprint = key;
				return false;
			}

			// 指纹在**调模型之前**就记下：摘要可能很慢，而这段时间里 settled 若重复
			// 触发（自动重试 / 压缩重试）不该再发一次请求、更不该念第二遍。
			lastFingerprint = key;
			const speech = await resolveSpeech(decision.text, config);
			if (speech.text.length === 0) {
				// 摘要期间被打断 / 新会话开始了：不发声（指纹已记，重复的 settled 也不会重跑）。
				controller.lastSkipReason = "interrupted";
				return false;
			}

			controller.lastSkipReason = undefined;
			options.speaker.speak(speech.text, { voice: config.voice, rate: config.rate });
			return true;
		},
		interrupt(): void {
			// 先取消在途摘要再停声：只停声的话，摘要回来还会把刚被用户打断的那句念出去。
			pending?.abort();
			pending = undefined;
			options.speaker.interrupt();
		},
		shutdown(): void {
			pending?.abort();
			pending = undefined;
			lastFingerprint = undefined;
			options.speaker.stop();
		},
	};
	return controller;
}
