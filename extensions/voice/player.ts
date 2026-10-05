/**
 * voice/player — 播放器：spawn `say`、打断上一句、幂等清理。
 *
 * 单槽语义：同一时刻最多一句在念，新的一句直接顶掉旧的（不排队）。理由是这是个
 * 「读结论」的旁白，不是音频播放器 —— 排队的代价是模型已经跑完两轮了，耳朵里还在
 * 念第一轮的结论。顶掉即旧进程 SIGTERM（实测 `say` 收 SIGTERM 立刻退出，不留进程）。
 *
 * spawn 可注入（`options.spawn`），测试用假子进程驱动完整状态机，不需要真发声。
 * 这里不 import pi，`node --test` 直接跑。
 */

import { execFileSync, spawn as nodeSpawn } from "node:child_process";

/** 子进程里本模块真正用到的那一小片（测试可以假造）。 */
export interface SpeakerProcess {
	pid?: number;
	kill: (signal?: NodeJS.Signals) => boolean;
	on: (event: string, listener: (...args: unknown[]) => void) => unknown;
	unref?: () => void;
}

export type SpeakerSpawn = (command: string, args: string[], options?: Record<string, unknown>) => SpeakerProcess;

export interface PlayerOptions {
	/** `say` 可执行文件路径；默认 "say"。测试用 PI_VOICE_SAY_BIN 指假脚本。 */
	sayBin?: string;
	/** 注入 spawn 实现（测试用）。 */
	spawn?: SpeakerSpawn;
	/** 播放中途出错（spawn 失败等）的回调；每句话最多调一次。 */
	onError?: (message: string) => void;
	/** 播放状态变化的回调（true = 开始念，false = 念完 / 被打断 / 出错）。 */
	onStateChange?: (speaking: boolean) => void;
}

export interface SpeakOptions {
	/** 音色名，空 / undefined 用系统默认。 */
	voice?: string;
	/** 语速（词/分钟），默认沿用系统设置。 */
	rate?: number;
}

/**
 * 播放器：持有「当前这一句」的单一引用。所有方法都幂等 —— `interrupt()` / `stop()`
 * 在没有播放时是 no-op，重复调用也不会连着发两次 onStateChange。
 */
export class Speaker {
	private readonly sayBin: string;
	private readonly spawnFn: SpeakerSpawn;
	private readonly onError: (message: string) => void;
	private readonly onStateChange: (speaking: boolean) => void;

	private current: SpeakerProcess | undefined;
	/** 每次播放递增；闭包回调靠它判断自己是不是「最新那一句」。 */
	private generation = 0;

	constructor(options: PlayerOptions = {}) {
		const envBin = process.env.PI_VOICE_SAY_BIN;
		this.sayBin = options.sayBin ?? (envBin && envBin.length > 0 ? envBin : "say");
		this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpeakerSpawn);
		this.onError = options.onError ?? (() => {});
		this.onStateChange = options.onStateChange ?? (() => {});
	}

	get speaking(): boolean {
		return this.current !== undefined;
	}

	/**
	 * 念一句话。会先把上一句打断（单槽）。
	 *
	 * `say` 的参数顺序固定为 `-v <voice> -r <rate> -- <text>`：`--` 必须在正文之前，
	 * 否则以 `-` 开头的正文会被当成选项（模型偶尔会输出「- 第一条」这种正文）。
	 */
	speak(text: string, options: SpeakOptions = {}): void {
		if (!text || text.trim().length === 0) return;

		this.interrupt();

		const args: string[] = [];
		if (options.voice) args.push("-v", options.voice);
		if (typeof options.rate === "number" && Number.isFinite(options.rate) && options.rate > 0) {
			args.push("-r", String(Math.round(options.rate)));
		}
		args.push("--", text);

		const generation = ++this.generation;
		let child: SpeakerProcess;
		try {
			child = this.spawnFn(this.sayBin, args, { stdio: "ignore", detached: false });
		} catch (error) {
			this.onError(`无法启动 say：${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		this.current = child;
		this.onStateChange(true);

		const finish = (): void => {
			// 只有「最新那一句」的结束才影响状态：被顶掉的旧进程退出时，新的一句可能正在念。
			if (generation !== this.generation) return;
			this.current = undefined;
			this.onStateChange(false);
		};

		child.on("exit", finish);
		child.on("error", (error: unknown) => {
			this.onError(`say 执行失败：${error instanceof Error ? error.message : String(error)}`);
			finish();
		});
		// 不 unref：pi 退出时会有 session_shutdown 的 stop()，但万一漏了也别把句尾掐掉。
	}

	/** 打断当前这一句（没有在念时是 no-op）。 */
	interrupt(): void {
		const child = this.current;
		if (!child) return;
		this.current = undefined;
		this.generation++;
		try {
			child.kill("SIGTERM");
		} catch {
			// 进程可能已经退出，忽略
		}
		this.onStateChange(false);
	}

	/** 会话结束时的清理，语义同 interrupt（幂等）。 */
	stop(): void {
		this.interrupt();
	}
}

/**
 * 取本机可用音色列表（`say -v '?'`）。同步执行 —— 只在 `/voice` 命令里调用，
 * 不在回合路径上，几十毫秒的代价无所谓。
 */
export interface ListVoicesOptions {
	sayBin?: string;
	/** 注入执行器（测试用）。 */
	exec?: (command: string, args: string[]) => string;
}

export function listVoices(options: ListVoicesOptions = {}): string {
	const sayBin = options.sayBin ?? process.env.PI_VOICE_SAY_BIN ?? "say";
	try {
		if (options.exec) return options.exec(sayBin, ["-v", "?"]);
		return execFileSync(sayBin, ["-v", "?"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
	} catch {
		return "";
	}
}
