/**
 * voice/aliyun — 阿里云（DashScope 百炼）口播：TTS 客户端 + 播放器 + 与系统 say 的分流。
 *
 * 设计说明就在本文件（voice 扩展是 bounded 改动，没有单独的设计文档）。
 *
 * ## 为什么是 DashScope 的 qwen-audio-3.1-tts-flash
 *
 * 这个能力是从用户早年的小客户端 `~/jaylli/chat-client` 的语音播报搬过来的（那边用的端点是
 * `services/aigc/multimodal-generation/generation` + `qwen3-tts-flash` + 音色 `Cherry`）。
 * 现在换到新一档模型：`POST …/api/v1/services/audio/tts/SpeechSynthesizer`
 * + `Authorization: Bearer sk-…` + `{model:"qwen-audio-3.1-tts-flash", input:{text, voice, language_type}}`，
 * 响应里的 `output.audio.url` 仍是**预签名**的 OSS 链接（24h 有效、匿名可下载），所以这里
 * 依然是两步：先合成拿 URL，再把音频抓下来（响应形状没变，下载那条链路因此没动）。
 *
 * **端点与模型是绑死的**（2026-10-04 实测）：`qwen-audio-*` 系模型只认新端点，发到旧端点一律
 * `InvalidParameter url error`；反过来 `qwen3-tts-flash`（旧模型）也不认 `longanhuan_v3.1`
 * 音色。所以 `TTS_ENDPOINT` 与 `TTS_MODEL` 是一对，换一个必须同时换另一个。
 *
 * ## 为什么必须落临时文件
 *
 * macOS 自带的 `afplay` 只接受**文件路径**（实测 `afplay -- x` 直接报 `unknown argument: --`，
 * 连 `--` 都不认，所以参数不能加分隔符 —— 好在这里传的是我们自己生成的绝对路径），它也不能
 * 像 `say` 那样直接吃文本、更不能从 stdin 读。于是：下载到 `os.tmpdir()` 下一个一次性目录
 * → `afplay <file>` → 播完删目录。
 *
 * ## 与 say 的关系：分流，不是替换
 *
 * `createSpeakerRouter` 每次播报**现读** `~/.config/litellm-any/apikey.json` 的 `aliyunKey`
 * （`/voice key` 写完立即生效，不用重启）：
 *   - 有 key → 走云端（音色取 `voice.json` 的 `aliyunVoice`，默认 longanhuan_v3.1）；
 *   - 没 key → 原样走 `say`（与加这个功能之前完全一致：不联网、不落文件）；
 *   - 有 key 但云端失败（断网 / 额度 / 鉴权）→ 提示一次，把**同一段文本**交给 `say` 兜底。
 *     fail-open 是本扩展一贯的原则：语音只是旁白，不该因为一次网络抖动直接变哑。
 *
 * 单槽语义**跨两个引擎**维护：每次 speak 先把两边都停掉（否则云端那句还在念、本地这句
 * 已经开始，两只耳朵同时响）；`speaking` 是两边取或，所以 ESC 在「合成中」也能停声。
 *
 * 不 import pi / pi-tui（本仓约定），`node --test` 可直接驱动：fetch / spawn / 二进制路径
 * / keystore 路径全部可注入，`aliyun.test.ts` 既跑假 fetch，也用假 `afplay` 脚本走真 spawn。
 */

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ALIYUN_VOICE, type SpeakerLike } from "./controller.ts";
import type { SpeakerProcess, SpeakerSpawn, SpeakOptions } from "./player.ts";
import { truncateAtSentence } from "./text.ts";

/**
 * 阿里云百炼（DashScope）非实时语音合成端点。
 *
 * 与 `TTS_MODEL` **绑定**：`qwen-audio-*` 系模型只认这条路径，旧模型 `qwen3-tts-flash` 只认
 * `services/aigc/multimodal-generation/generation`（2026-10-04 实测，发错端点一律
 * `InvalidParameter url error`）。百炼另推荐北京地域专属域名
 * `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
 * （同路径、性能更好，需真实 Workspace ID），暂未迁移。
 */
export const TTS_ENDPOINT =
	"https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";

/**
 * 合成用的模型；音色属于模型，所以它与 `TTS_ENDPOINT` 是一对。
 *
 * `longanhuan_v3.1`（龙安欢，欢脱元气女声）是 `qwen-audio-3.1-tts-flash` 的音色；旧模型
 * `qwen3-tts-flash` 会以 `Invalid voice specified` 直接拒掉它，而这个模型也不认旧的
 * `Cherry`（`Engine error [411]`）—— 所以模型与默认音色必须一起改。
 */
export const TTS_MODEL = "qwen-audio-3.1-tts-flash";

/**
 * 发给云端的文本上限（防御性）。
 *
 * 正常路径根本碰不到：口播文本先过 `decideSpeak`（`maxChars` 默认 500），再被摘要器压到
 * `summaryMaxChars`（默认 100，且不超过原文长度）。但用户可以把这两个上限调大，而 TTS 接口对超长文本的行为
 * 各家文档写得含糊（qwen-audio-3.1-tts-flash 的「最大输入长度」是 —），所以自己封一道顶：超了就
 * 按句子边界截断，而不是把整篇丢过去赌它不报错。
 */
export const ALIYUN_TEXT_LIMIT = 1000;

/** 合成 + 下载的整体上限：卡住不返回时按失败处理（走 say 兜底），而不是永远占着「正在念」。 */
export const ALIYUN_TIMEOUT_MS = 20_000;

/** keystore 默认路径（与 start-script/ecosystem.config.js / adapter/admin/keystore.js 一致）。 */
export const DEFAULT_KEYSTORE_PATH = path.join(os.homedir(), ".config", "litellm-any", "apikey.json");

/**
 * keystore 路径：默认 `~/.config/litellm-any/apikey.json`。
 *
 * 复用 `LITELLM_ANY_APIKEY_PATH`（ecosystem.config.js 已经用它做覆盖，测试也用它），
 * 不再另造一个变量名。
 */
export function keystorePath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.LITELLM_ANY_APIKEY_PATH;
	if (override && override.length > 0) {
		return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
	}
	return DEFAULT_KEYSTORE_PATH;
}

/**
 * 读 `aliyunKey`。**任何问题都当作「没配」**（文件不存在、JSON 坏了、字段不是字符串）：
 * 这决定了要不要走网络，读不到就该退回本地 say，而不是让播报崩掉。
 */
export function readAliyunKey(file: string = keystorePath()): string | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = (raw as Record<string, unknown>).aliyunKey;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 读整个 keystore 对象（写回时要保留别的字段，所以不能只读一个 key）。 */
function readKeystoreObject(file: string): Record<string, unknown> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, apiKeys: {} };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${file} 不是合法 JSON，拒绝覆盖（请先修好它）`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${file} 不是 JSON 对象，拒绝覆盖`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * 写 / 清 `aliyunKey`（`/voice key` 用）。
 *
 * 只动这一个字段：整个文件读进来 → 改 key → 原样写回（temp + rename + 0600，照
 * `adapter/admin/keystore.js` 的写法），所以 gateway 的 apiKeys / proxy / 端口都不会被动到。
 * 文件不存在时按 v2 最小骨架新建；**文件损坏时抛错而不是覆盖**（损坏的文件里可能有别的东西，
 * 让用户先处理）。传空 / undefined 表示清除该字段，回到本地 say。
 */
export function writeAliyunKey(file: string, key: string | undefined): void {
	const raw = readKeystoreObject(file);
	const trimmed = (key ?? "").trim();
	if (trimmed.length > 0) raw.aliyunKey = trimmed;
	else delete raw.aliyunKey;

	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// 权限收紧失败不影响可用性（文件已经写好了）
	}
}

/** 给 `/voice key` 的状态行用：`sk-e08b…9c1b`。 */
export function maskKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed.length <= 8) return "****";
	const head = trimmed.slice(0, Math.min(6, trimmed.length - 4));
	return `${head}…${trimmed.slice(-4)}`;
}

// =============================================================================
// TTS 客户端
// =============================================================================

/** 本模块用到的 fetch 那一小片（测试可以假造，不必构造真 Response）。 */
export interface FetchResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchInitLike {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface SynthesizeOptions {
	text: string;
	apiKey: string;
	voice?: string;
	/**
	 * 指令控制（`input.instruction`）：用自然语言控制方言 / 情感 / 角色。
	 *
	 * 2026-10-04 实测确认：`qwen-audio-3.1-tts-flash` 的系统音色可输入任意指令，
	 * 例如「请用重庆话口音播报。」会真的得到重庆口音的音频（同一文本下音频字节数与
	 * 哈希都不同）。空 / 未传就不带这个字段，行为与加这个功能之前完全一致。
	 */
	instruction?: string;
	signal?: AbortSignal;
	endpoint?: string;
	fetchImpl?: FetchLike;
}

/** 云端错误里能拿到的诊断信息（`code` / `message`），拿不到就给空串。 */
function describePayload(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const { code, message } = payload as { code?: unknown; message?: unknown };
	const parts = [code, message].filter((part): part is string => typeof part === "string" && part.length > 0);
	return parts.length > 0 ? `：${parts.join(" ")}` : "";
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

/**
 * 合成一段语音，返回音频 URL。
 *
 * 端点可用 `PI_VOICE_TTS_ENDPOINT` 覆盖（测试里指向本地 http 服务，也方便换百炼的新端点）。
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<{ url: string }> {
	const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
	const endpoint = options.endpoint ?? process.env.PI_VOICE_TTS_ENDPOINT ?? TTS_ENDPOINT;
	const voice = options.voice && options.voice.trim().length > 0 ? options.voice.trim() : DEFAULT_ALIYUN_VOICE;
	const instruction = options.instruction?.trim() ?? "";
	const text =
		options.text.length > ALIYUN_TEXT_LIMIT ? truncateAtSentence(options.text, ALIYUN_TEXT_LIMIT) : options.text;

	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: TTS_MODEL,
			input: {
				text,
				voice,
				language_type: "Chinese",
				// 空指令不带这个字段：保持与没有这个功能时逐字节一致的请求体。
				...(instruction.length > 0 ? { instruction } : {}),
			},
		}),
		signal: options.signal,
	});

	const bodyText = await response.text().catch(() => "");
	let payload: unknown;
	try {
		payload = JSON.parse(bodyText);
	} catch {
		payload = undefined;
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}${describePayload(payload)}`);
	}
	const url = (payload as { output?: { audio?: { url?: unknown } } } | undefined)?.output?.audio?.url;
	if (typeof url !== "string" || url.length === 0) {
		throw new Error(`响应里没有 output.audio.url${describePayload(payload)}`);
	}
	return { url };
}

/** 下载好的一段音频：文件路径 + 它所在的一次性目录（清理时连目录一起删）。 */
export interface AudioClip {
	file: string;
	dir: string;
}

/** 预签名 OSS URL 上的扩展名（afplay 按内容识别，这只是为了人看日志）。 */
function extensionFor(url: string): string {
	let pathname = url;
	try {
		pathname = new URL(url).pathname;
	} catch {
		// 不是合法 URL：按原串猜
	}
	const match = pathname.match(/\.(wav|mp3|m4a|ogg|opus|aac|flac)$/i);
	return match ? match[0] : ".wav";
}

/**
 * 把合成结果抓到本地临时文件 —— `afplay` 只能放文件（见文件头）。
 *
 * 每次都新建一次性目录，调用方播完删掉整个目录（`dir` 是这里 mkdtemp 建的，删除是安全的）。
 */
export async function downloadAudio(options: {
	url: string;
	signal?: AbortSignal;
	fetchImpl?: FetchLike;
}): Promise<AudioClip> {
	const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
	const response = await fetchImpl(options.url, { signal: options.signal });
	if (!response.ok) throw new Error(`下载合成音频失败：HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-"));
	const file = path.join(dir, `speech${extensionFor(options.url)}`);
	fs.writeFileSync(file, bytes, { mode: 0o600 });
	return { file, dir };
}

function removeQuietly(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// 清理失败不该影响播报结论（临时目录迟早会被系统回收）
	}
}

// =============================================================================
// 阿里云播放器
// =============================================================================

export interface AliyunSpeakerOptions {
	/** 每次播报现读 key（`/voice key` 写完立即生效）；返回 undefined 表示没配。 */
	readKey: () => string | undefined;
	/** 每次播报现读音色（`voice.json` 的 `aliyunVoice`）。 */
	readVoice?: () => string | undefined;
	/** 每次播报现读指令控制（`voice.json` 的 `aliyunInstruction`，如方言）；空则不传。 */
	readInstruction?: () => string | undefined;
	spawn?: SpeakerSpawn;
	fetchImpl?: FetchLike;
	/** 播放器可执行文件；默认 "afplay"（macOS 自带），PI_VOICE_AFPLAY_BIN 可覆盖。 */
	afplayBin?: string;
	onError?: (message: string) => void;
	onStateChange?: (speaking: boolean) => void;
}

/**
 * 阿里云口播播放器：与 `Speak`（player.ts）同样的 `speak / interrupt / stop / speaking` 契约。
 *
 * `speak` 只是**启动**（同步返回，不阻塞回合）：合成 + 下载 + 播放全在后台，期间
 * `speaking` 为真 —— 这样 ESC 打断、`interrupt()` 都能中止在途的请求与播放。
 */
export class AliyunSpeaker {
	private readonly readKey: () => string | undefined;
	private readonly readVoice: () => string | undefined;
	private readonly readInstruction: () => string | undefined;
	private readonly spawnFn: SpeakerSpawn;
	private readonly fetchImpl: FetchLike | undefined;
	private readonly afplayBin: string;
	private readonly onError: (message: string) => void;
	private readonly onStateChange: (speaking: boolean) => void;

	/** 当前这一句（在途请求 / 正在播放的进程）；单槽。 */
	private current: { controller: AbortController; child?: SpeakerProcess } | undefined;
	/** 每次播报递增；异步任务收尾时靠它判断自己是不是「最新那一句」。 */
	private generation = 0;

	constructor(options: AliyunSpeakerOptions) {
		const envBin = process.env.PI_VOICE_AFPLAY_BIN;
		this.readKey = options.readKey;
		this.readVoice = options.readVoice ?? (() => undefined);
		this.readInstruction = options.readInstruction ?? (() => undefined);
		this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpeakerSpawn);
		this.fetchImpl = options.fetchImpl;
		this.afplayBin = options.afplayBin ?? (envBin && envBin.length > 0 ? envBin : "afplay");
		this.onError = options.onError ?? (() => {});
		this.onStateChange = options.onStateChange ?? (() => {});
	}

	get speaking(): boolean {
		return this.current !== undefined;
	}

	/** 这一句还是不是「最新那一句」（身份 + 代数双检：顶掉、打断、新会话都算过期）。 */
	private isCurrent(controller: AbortController, generation: number): boolean {
		return this.generation === generation && this.current?.controller === controller;
	}

	speak(text: string, _options: SpeakOptions = {}): void {
		if (!text || text.trim().length === 0) return;

		const apiKey = this.readKey();
		if (!apiKey) {
			// router 已经查过一次 key；这里再查一次是防「直接 new AliyunSpeaker 用」的误用。
			this.onError("没有配置 aliyunKey，无法走阿里云口播");
			return;
		}

		this.interrupt();
		const controller = new AbortController();
		const generation = ++this.generation;
		this.current = { controller };
		this.onStateChange(true);
		void this.run(
			text,
			apiKey,
			this.readVoice() ?? DEFAULT_ALIYUN_VOICE,
			this.readInstruction(),
			controller,
			generation,
		);
	}

	private async run(
		text: string,
		apiKey: string,
		voice: string,
		instruction: string | undefined,
		controller: AbortController,
		generation: number,
	): Promise<void> {
		let clip: AudioClip | undefined;
		let failure: string | undefined;
		// 超时也走 abort，但它不是「用户不想听了」—— 靠 isCurrent 区分（打断会把 current 清掉、
		// 代数 +1，而超时不会），所以超时按失败处理 → 退回 say。
		const timer = setTimeout(() => controller.abort(), ALIYUN_TIMEOUT_MS);
		timer.unref?.();

		try {
			const { url } = await synthesizeSpeech({
				text,
				apiKey,
				voice,
				instruction,
				signal: controller.signal,
				fetchImpl: this.fetchImpl,
			});
			if (!this.isCurrent(controller, generation)) return;
			clip = await downloadAudio({ url, signal: controller.signal, fetchImpl: this.fetchImpl });
			if (!this.isCurrent(controller, generation)) return;
			await this.playClip(clip.file, controller);
		} catch (error) {
			if (!this.isCurrent(controller, generation)) return;
			failure = errorMessage(error);
		} finally {
			clearTimeout(timer);
			if (clip) removeQuietly(clip.dir);
			if (this.isCurrent(controller, generation)) {
				this.current = undefined;
				this.onStateChange(false);
			}
		}

		// 失败提示放在状态清理**之后**：router 的回调可能紧接着让 say 开口，
		// 那时这一句已经不「当前」了，不会再把状态栏抹掉。
		if (failure) this.onError(`阿里云口播失败：${failure}`);
	}

	private playClip(file: string, controller: AbortController): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let child: SpeakerProcess;
			try {
				// 不加 `--`：afplay 不认这个分隔符（实测 `unknown argument: --`）。file 是我们
				// 在临时目录里自己生成的名字，不以 `-` 开头，本来也不需要分隔。
				child = this.spawnFn(this.afplayBin, [file], { stdio: "ignore", detached: false });
			} catch (error) {
				reject(error);
				return;
			}
			// 记下进程：interrupt() 靠它 SIGTERM 掉正在放的那句。
			if (this.current?.controller === controller) this.current.child = child;
			child.on("exit", () => resolve());
			child.on("error", (error: unknown) => reject(error));
		});
	}

	/** 打断当前这一句（在途请求会被 abort、正在放的文件会被 SIGTERM）；没在播时是 no-op。 */
	interrupt(): void {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		this.generation++;
		try {
			current.controller.abort();
		} catch {
			// 已经 abort 过：忽略
		}
		try {
			current.child?.kill("SIGTERM");
		} catch {
			// 进程可能已经退出：忽略
		}
		this.onStateChange(false);
	}

	/** 会话结束时的清理，语义同 interrupt（幂等）。 */
	stop(): void {
		this.interrupt();
	}
}

// =============================================================================
// 分流：有 key 走阿里云，没 key 走 say，云端失败退回 say
// =============================================================================

export interface SpeakerRouterOptions {
	/** 本地播放器（player.ts 的 `Speaker`）。 */
	say: SpeakerLike;
	/** 每次播报现读 aliyunKey。 */
	readKey: () => string | undefined;
	/** 每次播报现读阿里云音色。 */
	readVoice?: () => string | undefined;
	/** 每次播报现读指令控制（方言 / 情感 / 角色）；空则不传。 */
	readInstruction?: () => string | undefined;
	onError?: (message: string) => void;
	onStateChange?: (speaking: boolean) => void;
	spawn?: SpeakerSpawn;
	fetchImpl?: FetchLike;
	afplayBin?: string;
}

/**
 * 把「阿里云 / 本地 say」合成一个 `SpeakerLike`：controller 只看见一个播放器。
 *
 * 分流在**每次 speak** 时决定（key 是现读的），所以 `/voice key` 之后不需要重启或 reload。
 * 云端失败时把同一段文本交给 `say` —— 但如果这一句已经被下一句顶掉 / 用户按了 ESC / 会话
 * 结束了，`pending` 已经被清掉，就不会再补一声（在被打断之后突然出声比沉默更糟）。
 */
export function createSpeakerRouter(options: SpeakerRouterOptions): SpeakerLike {
	const onError = options.onError ?? (() => {});
	/** 云端失败时用来兜底的那一句；被顶掉 / 打断就清空。 */
	let pending: { text: string; speakOptions: SpeakOptions } | undefined;

	const aliyun = new AliyunSpeaker({
		readKey: options.readKey,
		readVoice: options.readVoice,
		readInstruction: options.readInstruction,
		spawn: options.spawn,
		fetchImpl: options.fetchImpl,
		afplayBin: options.afplayBin,
		onStateChange: options.onStateChange,
		onError: (message) => {
			const fallback = pending;
			pending = undefined;
			if (!fallback) return; // 已经过期（被打断 / 顶掉）：只当没发生过
			onError(`${message}（退回系统 say）`);
			options.say.speak(fallback.text, fallback.speakOptions);
		},
	});

	return {
		speak(text: string, speakOptions: SpeakOptions = {}): void {
			if (!text || text.trim().length === 0) return;
			const apiKey = options.readKey();
			// 单槽跨两个引擎：先把两边都停掉，否则云端那句还在念、这一句已经开始。
			aliyun.interrupt();
			options.say.interrupt();
			pending = undefined;

			if (!apiKey) {
				options.say.speak(text, speakOptions);
				return;
			}
			pending = { text, speakOptions };
			aliyun.speak(text, speakOptions);
		},
		interrupt(): void {
			pending = undefined;
			aliyun.interrupt();
			options.say.interrupt();
		},
		stop(): void {
			pending = undefined;
			aliyun.stop();
			options.say.stop();
		},
		get speaking(): boolean {
			return aliyun.speaking || options.say.speaking;
		},
	};
}
