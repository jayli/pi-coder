/**
 * voice 扩展的装配验证：纯判定在 text.test.ts / player.test.ts，这里验证
 * **配置读写 + 控制器状态机 + 事件接线**，最后一条用假 `say` 脚本走真 spawn
 * （不 mock child_process），确认参数真的按预期发出去。
 *
 *   node --test clients/pi/extensions/voice/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	DEFAULT_CONFIG,
	configPath,
	createController,
	fingerprint,
	isConcludingMessage,
	isEnabled,
	lastAssistantText,
	loadConfig,
	saveConfig,
	type SpeakerLike,
	type Summarizer,
	type VoiceConfig,
} from "./controller.ts";
import { MIN_SPEAKABLE_CHARS } from "./text.ts";
import { readAliyunKey, TTS_MODEL, writeAliyunKey } from "./aliyun.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

const cleanups: Array<() => void> = [];
test.after(() => {
	for (const fn of cleanups) fn();
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// 清理失败不影响测试结论
		}
	});
	return dir;
}

// =============================================================================
// 配置读写
// =============================================================================

test("loadConfig: 文件不存在 → 全默认值", () => {
	const file = path.join(tempDir("pi-voice-"), "nope.json");
	assert.deepEqual(loadConfig(file), DEFAULT_CONFIG);
});

test("loadConfig: JSON 损坏 / 数组 / null 都退回默认值", () => {
	const dir = tempDir("pi-voice-");
	for (const [name, content] of [
		["bad.json", "{ not json"],
		["array.json", "[]"],
		["null.json", "null"],
		["str.json", '"hello"'],
	] as const) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, content);
		assert.deepEqual(loadConfig(file), DEFAULT_CONFIG, `${name} 应退回默认值`);
	}
});

test("loadConfig: 部分字段 + 类型错误的字段逐个退回默认", () => {
	const file = path.join(tempDir("pi-voice-"), "voice.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			voice: "Meijia",
			rate: "fast",
			maxChars: -5,
			speakQuestions: true,
			enabled: "yes",
			summarize: "yes",
			summaryThreshold: 0,
			summaryMaxChars: -1,
			summaryTimeoutMs: "soon",
		}),
	);
	assert.deepEqual(loadConfig(file), {
		enabled: DEFAULT_CONFIG.enabled,
		voice: "Meijia",
		rate: DEFAULT_CONFIG.rate,
		aliyunVoice: DEFAULT_CONFIG.aliyunVoice,
		aliyunInstruction: DEFAULT_CONFIG.aliyunInstruction,
		maxChars: DEFAULT_CONFIG.maxChars,
		speakQuestions: true,
		summarize: DEFAULT_CONFIG.summarize,
		summaryThreshold: DEFAULT_CONFIG.summaryThreshold,
		summaryMaxChars: DEFAULT_CONFIG.summaryMaxChars,
		summaryTimeoutMs: DEFAULT_CONFIG.summaryTimeoutMs,
	});
});

test("loadConfig: aliyunVoice 可配置，空串 / 非字符串退回默认音色", () => {
	const dir = tempDir("pi-voice-");
	const custom = path.join(dir, "custom.json");
	fs.writeFileSync(custom, JSON.stringify({ aliyunVoice: " Serena " }));
	assert.equal(loadConfig(custom).aliyunVoice, "Serena", "值应 trim 后生效");

	for (const value of ["", "   ", 42, null]) {
		const file = path.join(dir, `bad-${JSON.stringify(value)}.json`);
		fs.writeFileSync(file, JSON.stringify({ aliyunVoice: value }));
		assert.equal(loadConfig(file).aliyunVoice, DEFAULT_CONFIG.aliyunVoice, `${JSON.stringify(value)} 应退回默认`);
	}
});

// 2026-10-04 用户要求用重庆话口播：方言靠 `input.instruction` 触发（实测确认）。
test("loadConfig: aliyunInstruction 可配置，空串是合法值（表示不发指令）", () => {
	const dir = tempDir("pi-voice-");
	const custom = path.join(dir, "instr.json");
	fs.writeFileSync(custom, JSON.stringify({ aliyunInstruction: "  请用重庆话口音播报。  " }));
	assert.equal(loadConfig(custom).aliyunInstruction, "请用重庆话口音播报。", "值应 trim 后生效");

	// 空串必须被**接受**（与 aliyunVoice 不同）：它就是「不带 instruction」那个合法状态。
	for (const value of ["", "   "]) {
		const file = path.join(dir, `empty-${value.length}.json`);
		fs.writeFileSync(file, JSON.stringify({ aliyunInstruction: value }));
		assert.equal(loadConfig(file).aliyunInstruction, "", "空串是合法值，不该退回某个非空默认");
	}

	// 非字符串才退回默认。
	for (const value of [42, null, {}]) {
		const file = path.join(dir, `badinstr-${JSON.stringify(value)}.json`);
		fs.writeFileSync(file, JSON.stringify({ aliyunInstruction: value }));
		assert.equal(loadConfig(file).aliyunInstruction, DEFAULT_CONFIG.aliyunInstruction);
	}
});

test("loadConfig: 摘要相关的四个字段各自生效，关掉摘要也能读进来", () => {
	const file = path.join(tempDir("pi-voice-"), "voice.json");
	fs.writeFileSync(file, JSON.stringify({ summarize: false, summaryThreshold: 80, summaryMaxChars: 200, summaryTimeoutMs: 5000 }));
	const config = loadConfig(file);
	assert.equal(config.summarize, false);
	assert.equal(config.summaryThreshold, 80);
	assert.equal(config.summaryMaxChars, 200);
	assert.equal(config.summaryTimeoutMs, 5000);
});

test("saveConfig: 落盘后再读一致，且保留未补丁字段", () => {
	const file = path.join(tempDir("pi-voice-"), "nested", "voice.json");
	saveConfig(file, { voice: "Meijia", rate: 210 });
	const reloaded = loadConfig(file);
	assert.equal(reloaded.voice, "Meijia");
	assert.equal(reloaded.rate, 210);
	assert.equal(reloaded.maxChars, DEFAULT_CONFIG.maxChars);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).voice, "Meijia", "文件内容应是可读 JSON");
});

test("isEnabled: env 覆盖配置，两个方向都生效", () => {
	const on: VoiceConfig = { ...DEFAULT_CONFIG, enabled: true };
	const off: VoiceConfig = { ...DEFAULT_CONFIG, enabled: false };
	assert.equal(isEnabled({ PI_VOICE: "off" }, on), false);
	assert.equal(isEnabled({ PI_VOICE: "0" }, on), false);
	assert.equal(isEnabled({ PI_VOICE: "on" }, off), true);
	assert.equal(isEnabled({ PI_VOICE: "1" }, off), true);
	assert.equal(isEnabled({}, off), false, "无 env 时看配置");
	assert.equal(isEnabled({}, on), true);
});

test("configPath: 默认落在 agent 目录，PI_VOICE_CONFIG / PI_CODING_AGENT_DIR 可覆盖", () => {
	assert.equal(configPath({}), path.join(os.homedir(), ".pi", "agent", "voice.json"));
	assert.equal(configPath({ PI_CODING_AGENT_DIR: "/custom/agent" }), path.join("/custom/agent", "voice.json"));
	assert.equal(configPath({ PI_VOICE_CONFIG: "/x/y.json" }), "/x/y.json");
});

// =============================================================================
// 分支扫描
// =============================================================================

function messageEntry(role: string, content: unknown, stopReason?: string) {
	return { type: "message", id: `${role}-1`, parentId: null, timestamp: "", message: { role, content, stopReason } };
}

test("lastAssistantText: 取最后一条带文本的 assistant（跳过工具调用与 user）", () => {
	const entries = [
		messageEntry("user", "帮我改一下"),
		messageEntry("assistant", [{ type: "toolCall", name: "read" }], "toolUse"),
		messageEntry("user", [{ type: "toolResult", content: "文件内容" }]),
		messageEntry("assistant", [{ type: "text", text: "改好了，重启即可。" }], "stop"),
	];
	assert.deepEqual(lastAssistantText(entries), { text: "改好了，重启即可。", stopReason: "stop" });
});

test("lastAssistantText: 只有 thinking 的回复向后继续找", () => {
	const entries = [
		messageEntry("assistant", [{ type: "text", text: "真正的结论。" }], "stop"),
		messageEntry("assistant", [{ type: "thinking", thinking: "想一下" }], "stop"),
	];
	assert.deepEqual(lastAssistantText(entries), { text: "真正的结论。", stopReason: "stop" });
});

test("lastAssistantText: 非 message 条目与空分支返回 undefined", () => {
	assert.equal(lastAssistantText([]), undefined);
	assert.equal(lastAssistantText([{ type: "model_change" }, { type: "label" }]), undefined);
});

// turn_end 主触发点的门槛：只有「模型这一轮说完、且确实说了话」的那条消息才立即播报。
// 中间轮（toolUse）念出来是「我先看一下文件」这种中间态，截断轮（length）pi 还可能接着
// 做 overflow 恢复 —— 都不是结论。
function eventMessage(role: string, content: unknown[], stopReason?: string) {
	return { role, content, stopReason };
}

test("isConcludingMessage: 无工具调用的 stop 且有文本才算结论", () => {
	assert.equal(isConcludingMessage(eventMessage("assistant", [{ type: "text", text: "改好了。" }], "stop")), true);
	assert.equal(
		isConcludingMessage(eventMessage("assistant", [{ type: "text", text: "中间态。" }], "toolUse")),
		false,
		"toolUse 是中间轮",
	);
	assert.equal(
		isConcludingMessage(
			eventMessage("assistant", [{ type: "text", text: "边说边调工具。" }, { type: "toolCall", name: "read" }], "stop"),
		),
		false,
		"带工具调用的 stop 不是结论",
	);
	assert.equal(
		isConcludingMessage(eventMessage("assistant", [{ type: "thinking", thinking: "只想了一下" }], "stop")),
		false,
		"只有 thinking 的 stop 没有可播文本",
	);
	assert.equal(
		isConcludingMessage(eventMessage("assistant", [{ type: "text", text: "   " }], "stop")),
		false,
		"空白文本不算",
	);
	assert.equal(
		isConcludingMessage(eventMessage("assistant", [{ type: "text", text: "被截断的半句。" }], "length")),
		false,
		"截断轮次交给 settled 兜底",
	);
	assert.equal(isConcludingMessage(eventMessage("user", [{ type: "text", text: "问题？" }], "stop")), false);
	assert.equal(isConcludingMessage(undefined), false);
	assert.equal(isConcludingMessage("nope"), false);
});

test("fingerprint: 内容相同即相同，stopReason 变化会区分", () => {
	const a = { text: "结论。", stopReason: "stop" };
	assert.equal(fingerprint(a), fingerprint({ text: "结论。", stopReason: "stop" }));
	assert.notEqual(fingerprint(a), fingerprint({ text: "结论。", stopReason: "aborted" }));
	assert.notEqual(fingerprint(a), fingerprint({ text: "别的。", stopReason: "stop" }));
});

// =============================================================================
// 控制器状态机
// =============================================================================

class FakeSpeaker implements SpeakerLike {
	readonly spoken: Array<{ text: string; voice?: string; rate?: number }> = [];
	interrupts = 0;
	stops = 0;
	speaking = false;

	speak(text: string, options: { voice?: string; rate?: number }): void {
		this.spoken.push({ text, ...options });
		this.speaking = true;
	}

	interrupt(): void {
		this.interrupts++;
		this.speaking = false;
	}

	stop(): void {
		this.stops++;
		this.speaking = false;
	}
}

function controllerFor(
	entries: unknown[],
	options: {
		config?: Partial<VoiceConfig>;
		env?: NodeJS.ProcessEnv;
		mode?: string;
		summarize?: Summarizer;
	} = {},
) {
	const speaker = new FakeSpeaker();
	const config: VoiceConfig = { ...DEFAULT_CONFIG, ...options.config };
	const controller = createController({
		env: options.env ?? {},
		readConfig: () => config,
		speaker,
		summarize: options.summarize,
		mode: options.mode ?? "tui",
	});
	/** 测试里图省事：等 `onSettled` 跑完（摘要可能要走一次假模型调用）。 */
	const settle = (batch: unknown[] = entries) => controller.onSettled(batch);
	return { speaker, controller, settle, config };
}

test("controller: 正常结论 → 播精简后的文本，音色来自配置", async () => {
	const entries = [
		messageEntry("user", "改完了吗"),
		messageEntry("assistant", [{ type: "text", text: "已经修好了。\n```ts\nconst x = 1;\n```\n重启即可生效。" }], "stop"),
	];
	const { speaker, settle, controller } = controllerFor(entries, { config: { voice: "Meijia", rate: 210 } });
	assert.equal(await settle(), true);
	assert.equal(controller.lastSkipReason, undefined);
	assert.equal(speaker.spoken.length, 1);
	assert.equal(speaker.spoken[0].text, "已经修好了。\n重启即可生效。");
	assert.equal(speaker.spoken[0].voice, "Meijia");
	assert.equal(speaker.spoken[0].rate, 210);
});

test("controller: aborted 轮次不播，并记下原因", async () => {
	const entries = [messageEntry("assistant", [{ type: "text", text: "被打断的半截结论。" }], "aborted")];
	const { speaker, controller, settle } = controllerFor(entries);
	assert.equal(await settle(), false);
	assert.equal(speaker.spoken.length, 0);
	assert.equal(controller.lastSkipReason, "aborted");
});

test("controller: 同一份内容不重复播（settled 重复触发）", async () => {
	const entries = [messageEntry("assistant", [{ type: "text", text: "同一句结论。" }], "stop")];
	const speaker = new FakeSpeaker();
	const controller = createController({ env: {}, readConfig: () => DEFAULT_CONFIG, speaker });

	assert.equal(await controller.onSettled(entries), true);
	assert.equal(await controller.onSettled(entries), false, "第二次同内容应跳过");
	assert.equal(speaker.spoken.length, 1);
	assert.equal(controller.lastSkipReason, "duplicate");
});

test("controller: 内容变了（重新生成）会再播一次", async () => {
	const speaker = new FakeSpeaker();
	const controller = createController({ env: {}, readConfig: () => DEFAULT_CONFIG, speaker });
	await controller.onSettled([messageEntry("assistant", [{ type: "text", text: "第一版结论。" }], "stop")]);
	await controller.onSettled([messageEntry("assistant", [{ type: "text", text: "第二版结论。" }], "stop")]);
	assert.equal(speaker.spoken.length, 2);
});

test("controller: enabled=false / PI_VOICE=off / 非 tui 模式都不播", async () => {
	const entries = [messageEntry("assistant", [{ type: "text", text: "有结论但被关掉了。" }], "stop")];
	assert.equal((await controllerFor(entries, { config: { enabled: false } }).settle()), false);
	assert.equal((await controllerFor(entries, { env: { PI_VOICE: "off" } }).settle()), false);
	assert.equal((await controllerFor(entries, { mode: "print" }).settle()), false);
	assert.equal((await controllerFor(entries, { mode: "rpc" }).settle()), false);
	assert.equal(controllerFor(entries, { mode: "print" }).speaker.spoken.length, 0);
});

test("controller: 问句默认播（用户 2026-10-04 定），speakQuestions=false 才跳过", async () => {
	const entries = [messageEntry("assistant", [{ type: "text", text: "要我继续吗？" }], "stop")];
	// 默认要出声：这正是用户报「没口播」时实际碰到的形态。
	assert.equal((await controllerFor(entries).settle()), true);
	assert.equal((await controllerFor(entries, { config: { speakQuestions: false } }).settle()), false);
});

test("controller: interrupt / shutdown 透传到播放器", () => {
	const speaker = new FakeSpeaker();
	const controller = createController({ env: {}, readConfig: () => DEFAULT_CONFIG, speaker });
	controller.interrupt();
	controller.shutdown();
	assert.equal(speaker.interrupts, 1);
	assert.equal(speaker.stops, 1);
});

test("controller: shutdown 清掉去重指纹（新会话同一句还会念）", async () => {
	const entries = [messageEntry("assistant", [{ type: "text", text: "同一句结论。" }], "stop")];
	const speaker = new FakeSpeaker();
	const controller = createController({ env: {}, readConfig: () => DEFAULT_CONFIG, speaker });
	await controller.onSettled(entries);
	controller.shutdown();
	await controller.onSettled(entries);
	assert.equal(speaker.spoken.length, 2);
});

// =============================================================================
// 口播摘要管线
// =============================================================================

/** 一段超过默认阈值（6 字）的结论，用 `decideSpeak` 也会走摘要分支。 */
const LONG_TEXT = `先看了下目录结构，网关和适配器分成两个进程。改完了转发判断，把漏掉的协议头补上了。重启之后跑了一遍回归，三条用例都过了。还剩一个细节：超时时间暂时没动。`;

function longEntries(text = LONG_TEXT) {
	return [messageEntry("assistant", [{ type: "text", text }], "stop")];
}

test("controller: 长结论 → 调摘要器，念的是摘要而不是原文", async () => {
	const calls: string[] = [];
	const { speaker, settle } = controllerFor(longEntries(), {
		summarize: async (text) => {
			calls.push(text);
			return "网关那条路由修好了，回归都过了。";
		},
	});
	assert.equal(await settle(), true);
	assert.equal(calls.length, 1, "摘要器应该被调一次");
	assert.equal(speaker.spoken.length, 1);
	assert.equal(speaker.spoken[0].text, "网关那条路由修好了，回归都过了。");
});

test("controller: 摘要器拿到的是**本地精简后**的文本（路径与代码已经被剥掉）", async () => {
	let seen = "";
	const text = `${"过程描述。".repeat(12)}\n\`\`\`ts\nconst x = 1;\n\`\`\`\n改动落在 clients/pi/extensions/voice/index.ts 里。`;
	await controllerFor(longEntries(text), {
		summarize: async (value) => {
			seen = value;
			return "好了。";
		},
	}).settle();
	assert.ok(seen.length > 0, "应该收到待摘要的文本");
	assert.ok(!seen.includes("const x"), "代码块不该进提示词");
	assert.ok(!seen.includes("index.ts"), "路径不该进提示词");
});

test("controller: 短结论也走摘要（默认阈值降到可播下限，用户 2026-10-03 定）", async () => {
	// 「只播报摘要」：能被播的文本（decideSpeak 已过滤过短/装饰）一律过一遗口播稿，
	// 默认阈值 6 = MIN_SPEAKABLE_CHARS，即不再区分长短。
	assert.equal(DEFAULT_CONFIG.summaryThreshold, MIN_SPEAKABLE_CHARS);
	let calls = 0;
	const entries = [messageEntry("assistant", [{ type: "text", text: "已经改好，重启即可生效。" }], "stop")];
	const { speaker, settle } = controllerFor(entries, {
		summarize: async () => {
			calls++;
			return "改好了，重启生效。";
		},
	});
	assert.equal(await settle(), true);
	assert.equal(calls, 1, "短结论也要过一遗口播稿");
	assert.equal(speaker.spoken[0].text, "改好了，重启生效。");
});

test("controller: summarize=false 时永远不调摘要器", async () => {
	let calls = 0;
	const { speaker, settle } = controllerFor(longEntries(), {
		config: { summarize: false },
		summarize: async () => {
			calls++;
			return "不用。";
		},
	});
	assert.equal(await settle(), true);
	assert.equal(calls, 0);
	// 关掉摘要后回到「本地精简 + 压到摘要上限」的行为（不是完整的 maxChars 长文）。
	assert.ok(speaker.spoken[0].text.length <= DEFAULT_CONFIG.summaryMaxChars);
});

test("controller: 阈值可配（调高后同一段文本不再调摘要器）", async () => {
	let calls = 0;
	const { settle } = controllerFor(longEntries(), {
		config: { summaryThreshold: 10_000 },
		summarize: async () => {
			calls++;
			return "不该走这里。";
		},
	});
	await settle();
	assert.equal(calls, 0);
});

test("controller: 摘要失败 / 返回空 → 退回本地精简文本，并压到摘要同一上限", async () => {
	for (const impl of [async () => undefined, async (): Promise<string> => { throw new Error("模型挂了"); }]) {
		const { speaker, settle } = controllerFor(longEntries(), { summarize: impl as Summarizer });
		assert.equal(await settle(), true, "失败也要念（fail-open）");
		assert.equal(speaker.spoken.length, 1);
		const spoken = speaker.spoken[0].text;
		assert.ok(spoken.length > 0);
		assert.ok(spoken.length <= DEFAULT_CONFIG.summaryMaxChars, `兜底文本 ${spoken.length} 字，应压到上限内`);
		assert.ok(LONG_TEXT.includes(spoken.replace(/。$/, "")), "兜底应该是原文（精简后）的开头");
	}
});

test("controller: 等摘要期间被打断 → 取消请求，且不出声", async () => {
	let sawSignal: AbortSignal | undefined;
	const { speaker, controller, settle } = controllerFor(longEntries(), {
		summarize: (_text, signal) => {
			sawSignal = signal;
			return new Promise((resolve) => {
				// 永不 resolve：模拟一次卡住的模型调用，靠 abort 收场。
				signal.addEventListener("abort", () => resolve(undefined));
			});
		},
	});
	const settled = settle();
	assert.equal(controller.summarizing, true, "等待摘要期间 summarizing 应为真");
	controller.interrupt();
	assert.equal(await settled, false, "被打断的这轮不该出声");
	assert.equal(controller.lastSkipReason, "interrupted");
	assert.equal(sawSignal?.aborted, true, "应该真的 abort 了在途请求");
	assert.equal(speaker.spoken.length, 0);
	assert.equal(controller.summarizing, false);
});

test("controller: 摘要超时 → abort 并退回兜底文本", async () => {
	const { speaker, settle } = controllerFor(longEntries(), {
		config: { summaryTimeoutMs: 20 },
		summarize: (_text, signal) =>
			new Promise((resolve) => {
				signal.addEventListener("abort", () => resolve(undefined));
			}),
	});
	assert.equal(await settle(), true);
	assert.equal(speaker.spoken.length, 1);
	assert.ok(speaker.spoken[0].text.length <= DEFAULT_CONFIG.summaryMaxChars);
});

/**
 * 2026-10-04 线上事故的回归用例（用户报「对话结束后没有口播了」）。
 *
 * 实测证据：网关日志里有一条 `effort=low` 的 `request start` **没有对应的 `done` 行**，
 * 且之后**没有产生任何合成临时目录** —— 说明摘要请求卡住后，`speaker.speak` 根本没被调用。
 *
 * 根因：旧实现只靠 `controller.abort()` 收场，但 abort 只是「尽力通知下游」，
 * 下游 promise **不保证**因此 settle。一旦它永不 settle，`await` 就挂死，
 * fail-open 的兜底文本永远走不到 —— 契约（「失败 / 超时 → 退回兜底文本」）被静默违反，
 * 整场播报彻底沉默。这条用例把「永挂」这个失败形态钉住。
 */
test("controller: 摘要 promise 永不 settle 且无视 abort → 超时后仍必须退回兜底文本", async () => {
	const { speaker, settle } = controllerFor(longEntries(), {
		config: { summaryTimeoutMs: 20 },
		// 关键：既**不 settle** 也**不理会 abort**（线上网关卡住时就是这个形态）。
		summarize: () => new Promise<string | undefined>(() => {}),
	});
	// 兜住「永挂」这种失败：给一个远宽于超时的上限，超了就把本条判失败，
	// 而不是让整个测试进程挂死。
	const outcome = await Promise.race([
		settle(),
		new Promise((resolve) => setTimeout(() => resolve("HUNG"), 2000)).then(() => "HUNG" as const),
	]);
	assert.equal(outcome, true, "摘要卡死时超时必须收场并播兜底文本，绝不能挂死到无声");
	assert.equal(speaker.spoken.length, 1, "超时后必须真的出声（兜底文本）");
});

// 实测（2026-10-03 本机网关，deepseek-flash-qd）：固定模型 + low 档上首字 0.8~3.2s、
// 整句 1.3~5.4s（10 次 p50 1.8s），所以默认超时从 30s 收紧到 15s（约 3 倍余量）。
test("controller: 摘要默认超时收紧到 15s（固定快模型后不再需要 30s 余量）", () => {
	assert.equal(DEFAULT_CONFIG.summaryTimeoutMs, 15_000);
});

test("controller: 摘要绝不能比原文长 —— 源文比上限短时按源文夹（用户 2026-10-04 硬要求）", async () => {
	// 源文 15 字（低于 100 的上限），模型却回了一大段：必须夹到源文长度以内。
	const source = "已经改好了，重启一下就能生效。";
	const modelText = "这是模型无视字数要求返回的一大段口播稿，比原文长得多，必须被夹住。";
	const { speaker, settle } = controllerFor(longEntries(source), { summarize: async () => modelText });
	await settle();
	const spoken = speaker.spoken[0].text;
	assert.ok(
		spoken.length <= source.length,
		`摘要 ${spoken.length} 字不该超过源文 ${source.length} 字：${spoken}`,
	);
	assert.ok(modelText.startsWith(spoken), `夹取后应仍是模型输出开头的截断：${spoken}`);
});

test("controller: 摘要比 100 字上限长时由调用方夹到上限（不再原样念出去）", async () => {
	const long = `${`甲`.repeat(400)}。`;
	const { speaker, settle } = controllerFor(longEntries(), { summarize: async () => long });
	await settle();
	const spoken = speaker.spoken[0].text;
	// 旧行为是“调用方不夹、洗清是注入方的责任”；用户 2026-10-04 把字数定为硬要求后改成必夹：
	// 注入的假实现不守约、或真模型偶尔超长，都不该真的念出去。
	assert.ok(
		spoken.length <= DEFAULT_CONFIG.summaryMaxChars,
		`实际 ${spoken.length} 字，应 ≤ ${DEFAULT_CONFIG.summaryMaxChars}`,
	);
	assert.ok(spoken.length <= LONG_TEXT.length, "也不该超过原文长度");
});

test("controller: 摘要期间重复 settled 不会发第二次请求", async () => {
	let calls = 0;
	let release: (() => void) | undefined;
	const { settle } = controllerFor(longEntries(), {
		summarize: async () => {
			calls++;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return "摘要。";
		},
	});
	const first = settle();
	const second = await settle();
	assert.equal(second, false, "重复触发应被指纹挡住");
	release?.();
	assert.equal(await first, true);
	assert.equal(calls, 1, "只该调一次摘要器");
});

// =============================================================================
// 扩展接线（用 pi 自己的加载器真加载）
// =============================================================================

async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接 / 不存在
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim
		}
	}
	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

/**
 * 把扩展交给 `complete()` 的选项**真跑一遍 pi 的 anthropic-messages 适配器**，
 * 用一个本地假服务拦截实际发出的 HTTP body。
 *
 * 为什么非要这么做：断言“选项里有 extra_body”是假绿 —— pi 的适配器有自己的字段列表，
 * 不认的键会直接丢掉（实测确认）。只有看到 HTTP body 才能说这个选项真的会落到线上。
 */
async function captureSummaryWireBody(options: Record<string, unknown> | undefined): Promise<{
	body: Record<string, unknown>;
	url: string;
}> {
	const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
	const server = http.createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			captured.push({ url: request.url ?? "", body: JSON.parse(raw) as Record<string, unknown> });
			response.writeHead(200, { "content-type": "text/event-stream" });
			const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
			response.write(
				frame("message_start", {
					type: "message_start",
					message: {
						id: "msg",
						type: "message",
						role: "assistant",
						model: "m",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				}),
			);
			response.write(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
			response.write(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的" } }));
			response.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
			response.write(
				frame("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 1 },
				}),
			);
			response.write(frame("message_stop", { type: "message_stop" }));
			response.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	try {
		assert.ok(piEntry, "需要 pi 的库入口才能拦 HTTP body");
		// pi-ai 是 pi-coding-agent 的兄弟依赖：从 pi 的包根往上一级就是 @earendil-works/。
		// 注意 piEntry 可能是 `dist/bundle/index.js`（installer 装法），所以不能只往上走一级。
		let piAiEntry = "";
		for (let dir = path.dirname(fs.realpathSync(piEntry)); ; dir = path.dirname(dir)) {
			const candidate = path.join(dir, "pi-ai", "dist", "api", "anthropic-messages.js");
			if (fs.existsSync(candidate)) {
				piAiEntry = candidate;
				break;
			}
			if (dir === path.dirname(dir)) break;
		}
		assert.ok(piAiEntry, "应该能找到同级的 pi-ai 包");
		const api = (await import(pathToFileURL(piAiEntry).href)) as {
			stream: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<unknown> };
		};
		const model = {
			id: "deepseek-flash-qd",
			name: "deepseek-flash-qd",
			provider: "litellm-any",
			api: "anthropic-messages",
			baseUrl: `http://127.0.0.1:${port}`,
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
			thinkingLevelMap: { low: "low" },
		};
		await api
			.stream(
				model,
				{
					systemPrompt: "S",
					messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
				},
				{ apiKey: "litellm", ...(options ?? {}) },
			)
			.result();
	} finally {
		server.close();
	}

	assert.ok(captured[0], "适配器应该真的发出了一次请求");
	return captured[0];
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

/** 组件间传递的原始按键结果（pi-tui 的 `TerminalInputHandler` 语义）。 */
interface InputResult {
	consume?: boolean;
	data?: string;
}

type InputHandler = (data: string) => InputResult | undefined;

interface WireHarness {
	extension: LoadedExtension;
	notifies: Array<{ text: string; type?: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	selects: Array<{ title: string; options: string[] }>;
	selectReply: string | undefined;
	ctx: unknown;
	configFile: string;
	sayLog: string;
	fire(name: string, event?: unknown): Promise<void>;
	command(args: string): Promise<void>;
	/** 等假 say 脚本写出它的参数（真 spawn 的 E2E 用）。 */
	waitForSayLog(): Promise<string[]>;
	/** 等假 say 日志里出现某段文本至少 count 次（如 SIGTERM 时写的 KILLED）。 */
	waitForSayLogContaining(text: string, count?: number): Promise<boolean>;
	/**
	 * 按 pi-tui 的真实语义广播一次按键：所有在册监听器依次收到，
	 * 任一返回 `consume` 就短路（`TuiBase.handleTerminalInput`）。
	 */
	feedInput(data: string): InputResult | undefined;
	/** 当前在册的原始输入监听器数量（验证防重入）。 */
	listenerCount(): number;
}

async function loadHarness(options: {
	sayScript?: string;
	/** 假 afplay 脚本（阿里云路径用它走真 spawn）；不传则不设 PI_VOICE_AFPLAY_BIN。 */
	afplayScript?: string;
	/** apikey.json 路径（aliyunKey 所在）；不传则用默认路径，用不到。 */
	keystoreFile?: string;
	/** 阿里云 TTS 端点覆盖（测试指向本地 http 服务）。 */
	ttsEndpoint?: string;
	configFile: string;
	/** 模拟后台子代理进程（扩展在**加载时**读一次这个 env）。 */
	subagentParentSession?: string;
	/** ctx.mode（默认 tui；非 tui 不该装原始输入监听器）。 */
	mode?: string;
	/** 假会话模型：不传则 ctx.model 为 undefined（摘要应走兜底）。 */
	modelId?: string;
	/** 假 `complete()` 返回值；不传则调用会抛（模拟模型不可用）。 */
	modelReply?: string;
	/** 假 `complete()` 的延迟，用来测超时 / 打断。 */
	modelDelayMs?: number;
	/** 假 `getApiKeyAndHeaders` 是否拒绝（模拟认证不可用）。 */
	noAuth?: boolean;
	/** 只对固定摘要模型拒绝认证（验证退回会话模型这条路径）。 */
	noAuthForFixedModel?: boolean;
	/** 模型目录里存在的模型（`ctx.modelRegistry.find`）；缺省时把 `modelId` 当作唯一可解析的模型。 */
	registryModels?: string[];
}): Promise<WireHarness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
		createEventBus: () => unknown;
	};

	const root = tempDir("pi-voice-wire-");
	const agentDirPath = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDirPath, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	const savedConfig = process.env.PI_VOICE_CONFIG;
	const savedSay = process.env.PI_VOICE_SAY_BIN;
	const savedAfplay = process.env.PI_VOICE_AFPLAY_BIN;
	const savedKeystore = process.env.LITELLM_ANY_APIKEY_PATH;
	const savedEndpoint = process.env.PI_VOICE_TTS_ENDPOINT;
	const savedVoice = process.env.PI_VOICE;
	const savedSubagent = process.env.PI_SUBAGENT_PARENT_SESSION;
	process.env.PI_VOICE_CONFIG = options.configFile;
	process.env.PI_VOICE = "on";
	if (options.subagentParentSession) process.env.PI_SUBAGENT_PARENT_SESSION = options.subagentParentSession;
	else delete process.env.PI_SUBAGENT_PARENT_SESSION;
	if (options.sayScript) process.env.PI_VOICE_SAY_BIN = options.sayScript;
	else delete process.env.PI_VOICE_SAY_BIN;
	if (options.afplayScript) process.env.PI_VOICE_AFPLAY_BIN = options.afplayScript;
	else delete process.env.PI_VOICE_AFPLAY_BIN;
	// 隔离：keystore 指到本次测试的临时目录（无论测试用不用阿里云口播）。不隔离的话，
	// 本机真实的 ~/.config/litellm-any/apikey.json 一旦配了 aliyunKey，会被扩展读到，
	// 于是「该走 say」的用例跑去走云端（真网络请求）。
	process.env.LITELLM_ANY_APIKEY_PATH = options.keystoreFile ?? path.join(root, "apikey.json");
	if (options.ttsEndpoint) process.env.PI_VOICE_TTS_ENDPOINT = options.ttsEndpoint;
	else delete process.env.PI_VOICE_TTS_ENDPOINT;

	cleanups.push(() => {
		const restore = (key: string, value: string | undefined) => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore("PI_VOICE_CONFIG", savedConfig);
		restore("PI_VOICE_SAY_BIN", savedSay);
		restore("PI_VOICE_AFPLAY_BIN", savedAfplay);
		restore("LITELLM_ANY_APIKEY_PATH", savedKeystore);
		restore("PI_VOICE_TTS_ENDPOINT", savedEndpoint);
		restore("PI_VOICE", savedVoice);
		restore("PI_SUBAGENT_PARENT_SESSION", savedSubagent);
	});

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDirPath, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 voice 扩展");

	const harness: WireHarness = {
		extension,
		notifies: [],
		statuses: [],
		selects: [],
		selectReply: undefined,
		ctx: undefined,
		configFile: options.configFile,
		sayLog: options.sayScript ? `${options.sayScript}.log` : "",
		fire: async () => {},
		command: async () => {},
		waitForSayLog: async () => [],
		waitForSayLogContaining: async () => false,
		feedInput: () => undefined,
		listenerCount: () => 0,
	};

	const branch: unknown[] = [];
	/** 扩展通过 ctx.ui.onTerminalInput 注册的原始按键监听器（pi-tui 会全部调用）。 */
	const inputHandlers: InputHandler[] = [];
	/** 摘要模型的请求记录（验证真的发了一次、发了什么，以及带了哪些选项）。 */
	const modelCalls: Array<{ id: string; systemPrompt?: string; prompt: string; options: Record<string, unknown> }> = [];
	const model = options.modelId ? { provider: "litellm-any", id: options.modelId } : undefined;
	// 模型目录只列出 `registryModels`（缺省 = 会话模型自己）；`find` 找不到时返回 undefined，
	// 与 pi 的真实行为一致（voice 靠这个回退到会话模型）。
	const registryModels = new Set(options.registryModels ?? (options.modelId ? [options.modelId] : []));
	harness.ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => true,
		signal: undefined,
		model,
		sessionManager: { getBranch: () => branch },
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "litellm-any" && registryModels.has(id) ? { provider, id } : undefined,
			getApiKeyAndHeaders: async (usedModel?: { id?: string }) => {
				if (options.noAuth) return { ok: false, error: "没配 key" };
				if (options.noAuthForFixedModel && usedModel?.id === "deepseek-flash-qd") {
					return { ok: false, error: "固定模型没配 key" };
				}
				return { ok: true, apiKey: "fake" };
			},
			complete: async (
				usedModel: { id?: string },
				context: { systemPrompt?: string; messages: Array<{ content: unknown }> },
				callOptions: Record<string, unknown> = {},
			) => {
				const content = context.messages[0]?.content as Array<{ text?: string }> | undefined;
				modelCalls.push({
					id: usedModel?.id ?? "?",
					systemPrompt: context.systemPrompt,
					prompt: content?.[0]?.text ?? "",
					options: callOptions,
				});				if (options.modelDelayMs) await new Promise((resolve) => setTimeout(resolve, options.modelDelayMs));
				if (options.modelReply === undefined) throw new Error("模型不可用");
				return { content: [{ type: "text", text: options.modelReply }] };
			},
		},
		ui: {
			notify: (text: string, type?: string) => harness.notifies.push({ text, type }),
			setStatus: (key: string, text: string | undefined) => harness.statuses.push({ key, text }),
			select: async (title: string, options: string[]) => {
				harness.selects.push({ title, options });
				return harness.selectReply;
			},
			onTerminalInput: (handler: InputHandler) => {
				inputHandlers.push(handler);
				return () => {
					const index = inputHandlers.indexOf(handler);
					if (index !== -1) inputHandlers.splice(index, 1);
				};
			},
		},
	};

	harness.fire = async (name: string, event: unknown = { type: name }) => {
		for (const handler of extension.handlers.get(name) ?? []) await handler(event, harness.ctx);
	};
	harness.command = async (args: string) => {
		const command = extension.commands.get("voice");
		assert.ok(command, "本扩展必须注册 /voice 命令");
		await command.handler(args, harness.ctx);
	};
	harness.waitForSayLog = async () => {
		for (let i = 0; i < 100; i++) {
			if (fs.existsSync(harness.sayLog)) {
				const content = fs.readFileSync(harness.sayLog, "utf8").trim();
				if (content.length > 0) return content.split("\n");
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return [];
	};
	harness.waitForSayLogContaining = async (text: string, count = 1) => {
		for (let i = 0; i < 100; i++) {
			try {
				const occurrences = fs.readFileSync(harness.sayLog, "utf8").split(text).length - 1;
				if (occurrences >= count) return true;
			} catch {
				// 日志还没建
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return false;
	};
	harness.feedInput = (data: string) => {
		for (const handler of [...inputHandlers]) {
			const result = handler(data);
			if (result?.consume) return result;
		}
		return undefined;
	};
	harness.listenerCount = () => inputHandlers.length;
	// 每个测试自己往分支里塞消息：暴露一个 setter 太啰嗦，直接用数组引用。
	(harness as WireHarness & { branch: unknown[] }).branch = branch;
	(harness as WireHarness & { modelCalls: typeof modelCalls }).modelCalls = modelCalls;
	return harness;
}

/**
 * 写一个「阻塞不退出」的假 `say`：写参数、卡住等 SIGTERM，收到就追加一行 KILLED。
 *
 * 用**追加**而不是覆盖，是因为一个测试里会念多句（三种 ESC 编码各一句），
 * 覆盖式日志会把上一句的 KILLED 一并抹掉，计数就永远追不上。
 */
function writeBlockingSayScript(dir: string): string {
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(
		sayScript,
		`#!/bin/sh\nprintf '%s\\n' "$@" >> "$0.log"\ntrap 'printf KILLED\\n >> "$0.log"; exit 0' TERM\nwhile :; do sleep 0.1; done\n`,
	);
	fs.chmodSync(sayScript, 0o755);
	return sayScript;
}

test("接线：注册了 turn_end / agent_settled / agent_start / input / session_shutdown 与 /voice", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile });

	assert.ok(harness.extension.handlers.get("turn_end")?.length, "必须注册 turn_end（结论一上屏就播报）");
	assert.ok(harness.extension.handlers.get("agent_settled")?.length, "必须注册 agent_settled（兜底）");
	assert.ok(harness.extension.handlers.get("agent_start")?.length, "必须注册 agent_start（打断）");
	assert.ok(harness.extension.handlers.get("input")?.length, "必须注册 input（打断）");
	assert.ok(harness.extension.handlers.get("session_shutdown")?.length, "必须注册 session_shutdown（清理）");
	assert.ok(harness.extension.commands.get("voice"), "必须注册 /voice");
});

test("接线：settled 用 sessionManager 分支里的最后一条 assistant", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));

	// 假 say：把参数写进日志，验证真 spawn 的参数拼装
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("user", "改好了吗"));
	branch.push(messageEntry("assistant", [{ type: "toolCall", name: "read" }], "toolUse"));
	branch.push(messageEntry("assistant", [{ type: "text", text: "已经改好了，重启一下就能用。" }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();

	assert.ok(args.includes("-v"), `应带 -v 参数：${JSON.stringify(args)}`);
	assert.equal(args[args.indexOf("-v") + 1], "Tingting");
	assert.equal(args[args.length - 1], "已经改好了，重启一下就能用。");
	// 状态栏：先亮起，进程退出后清掉（假 say 秒退，所以两个状态都看得到）
	const voiceStatuses = harness.statuses.filter((s) => s.key === "voice").map((s) => s.text);
	assert.equal(voiceStatuses[0], "🔊", "播放开始时应点亮状态栏");
	assert.equal(voiceStatuses.at(-1), undefined, "播放结束后应清掉状态栏");
});

// 用户 2026-10-04 明确要求：结论一输出完就播报，不等 pi-subagents 的 watchdog。
// watchdog 审查挂在 agent_end 处理器里（实测 7~17s），agent_settled 必须等它跑完 ——
// 所以主触发点必须落在更早的 turn_end 上：这里只发 turn_end、不发 settled，看它出不出声。
test("接线：结论的 turn_end 立即发声（不等 agent_settled）", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	const content = [{ type: "text", text: "已经改好了，重启一下就能用。" }];
	branch.push(messageEntry("assistant", content, "stop"));

	// 只发结论那一条 turn_end —— 此刻真实 pi 里 watchdog 还在 agent_end 里跑。
	await harness.fire("turn_end", { type: "turn_end", message: { role: "assistant", content, stopReason: "stop" }, toolResults: [] });
	const args = await harness.waitForSayLog();

	assert.equal(args[args.length - 1], "已经改好了，重启一下就能用。", "turn_end 就该出声，不能等 settled");
});

test("接线：中间轮的 turn_end 不发声", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf 'spoke\\n' > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	const content = [{ type: "text", text: "我先看一下文件。" }, { type: "toolCall", name: "read" }];
	branch.push(messageEntry("assistant", content, "toolUse"));

	await harness.fire("turn_end", { type: "turn_end", message: { role: "assistant", content, stopReason: "toolUse" }, toolResults: [] });
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(fs.existsSync(harness.sayLog), false, "中间轮（toolUse）不该发声");
});

test("接线：turn_end 已发声后 settled 不重念（指纹去重跨两个触发点）", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	const sayScript = path.join(dir, "fake-say.sh");
	// 追加式日志：要数同一句被念了几次。
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" >> "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	const text = "只该念一遍的结论。";
	const content = [{ type: "text", text }];
	branch.push(messageEntry("assistant", content, "stop"));

	await harness.fire("turn_end", { type: "turn_end", message: { role: "assistant", content, stopReason: "stop" }, toolResults: [] });
	assert.equal(await harness.waitForSayLogContaining(text), true, "turn_end 应先出声");
	await harness.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(
		fs.readFileSync(harness.sayLog, "utf8").split(text).length - 1,
		1,
		"同一份内容不该被 turn_end 与 settled 各念一遍",
	);
});

test("接线：aborted 的轮次不启动进程", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf 'spoke\\n' > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: "半截就被打断了。" }], "aborted"));

	await harness.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(fs.existsSync(harness.sayLog), false, "aborted 不该发声");
});

test("接线：子代理进程里不发声（PI_SUBAGENT_PARENT_SESSION 标记）", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf 'spoke\\n' > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	process.env.PI_SUBAGENT_PARENT_SESSION = "parent-session-id";
	try {
		const harness = await loadHarness({ configFile, sayScript, subagentParentSession: "parent-session-id" });
		const branch = (harness as WireHarness & { branch: unknown[] }).branch;
		branch.push(messageEntry("assistant", [{ type: "text", text: "子代理的结论。" }], "stop"));
		await harness.fire("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(fs.existsSync(harness.sayLog), false, "子代理进程不该发声");
	} finally {
		delete process.env.PI_SUBAGENT_PARENT_SESSION;
	}
});

// =============================================================================
// 接线：口播流程的 statusline 指示（`reporting`，用户 2026-10-04）
// =============================================================================

/** 从假 ctx 的 setStatus 记录里取某个 key 的状态序列。 */
function statusSequence(harness: { statuses: Array<{ key: string; text: string | undefined }> }, key: string) {
	return harness.statuses.filter((s) => s.key === key).map((s) => s.text);
}

/** 带假 say 的 payload：把『假 say 不停退出』所需的三件套装好。 */
async function reportingHarness(options: Parameters<typeof loadHarness>[0]) {
	const harness = await loadHarness(options);
	return harness;
}

test("接线：摘要请求一发就点亮 reporting，播放结束才熄灭", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await reportingHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply: "已经改好了。",
		modelDelayMs: 250, // 让摘要请求停 250ms，观察「发起即点亮」
	});
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	const settled = harness.fire("agent_settled");
	// 摘要请求刚发出（模型还没回），指示就应该已经亮了 —— 用户要的时机是「开始发起摘要」。
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), "reporting", "摘要请求在途时就该点亮");

	await settled;
	await harness.waitForSayLog();
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), undefined, "播放结束后应熄灭");
});

test("接线：摘要关掉时，播放期间也亮着 reporting（不靠摘要点亮）", { skip }, async () => {
	// `summarize: false` 时不会发摘要请求，但口播仍然发生 —— 指示必须覆盖这条路径。
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting", summarize: false }));
	const sayScript = path.join(dir, "fake-say.sh");
	// 假 say 停住不退：这样「播放中」那段窗口能被观察到（否则秒退，状态拍不下来）。
	fs.writeFileSync(sayScript, `#!/bin/sh\nsleep 2\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: "已经改好了，重启就能用。" }], "stop"));

	void harness.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), "reporting", "播放中也该点亮");
});

test("接线：打断（新一句 / 按 ESC）会清掉 reporting，不等摘要 settle", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply: "这句不该被念。",
		modelDelayMs: 1000, // 摘要仍在途时打断
	});
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	void harness.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), "reporting", "前提：此刻应该亮着");

	await harness.fire("agent_start"); // 新一轮开始 → controller.interrupt()
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), undefined, "打断后指示应立即清掉");
});

test("接线：session_shutdown 会清掉 reporting", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting", summarize: false }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nsleep 2\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({ configFile, sayScript });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: "已经改好了，重启就能用。" }], "stop"));

	void harness.fire("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), "reporting", "前提：此刻应该亮着");

	await harness.fire("session_shutdown");
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), undefined, "会话结束应清掉指示");
});

test("接线：被打断的摘要晚归时，不能把新一轮的 reporting 误清（竞态）", { skip }, async () => {
	// 真竞态：摘要 A 被新一轮打断后，它的 promise 仍然会 settle（controller 的 abort 只能尽力），
	// 那时 A 的 finally 会跑到；若只用单个 boolean 记账，A 的收尾会把**正在跑的** B 的指示误清。
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	// 假模型不认 abort（真实现也会遇到不 settle / 晚 settle 的下游），延迟 400ms。
	// 时间线：A 在 t=0 发起（t=400 settle）→ t=300 打断 → B 在 t≈310 发起（t≈710 settle）
	// → 在 t≈610 断言。此刻 A 的 finally 已经跑过（400 < 610）、B 仍在途（610 < 710），
	// 所以这个断言真正压到的是「晚归的 A 不能误清 B」那个窗口，而不是空跑。
	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply: "摘要。",
		modelDelayMs: 400,
	});
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	const first = [{ type: "text", text: "第一轮的结论出来了，已经改好并跑过回归。" }];
	branch.push(messageEntry("assistant", first, "stop"));
	await harness.fire("turn_end", {
		type: "turn_end",
		message: { role: "assistant", content: first, stopReason: "stop" },
		toolResults: [],
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), "reporting", "前提：A 在途");

	// 新一轮打断 A，紧接着 B 开始。
	await harness.fire("agent_start");
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), undefined, "打断应清掉");
	const second = [{ type: "text", text: "第二轮的结论也出来了，同样改好了。" }];
	branch.push(messageEntry("assistant", second, "stop"));
	await harness.fire("turn_end", {
		type: "turn_end",
		message: { role: "assistant", content: second, stopReason: "stop" },
		toolResults: [],
	});
	assert.equal(statusSequence(harness, "voice-reporting").at(-1), "reporting", "前提：B 在途");

	// t≈610：A（t=400）已经晚归并跑过 finally，B（t≈710）仍在途 —— 指示必须仍然亮着。
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(
		statusSequence(harness, "voice-reporting").at(-1),
		"reporting",
		"A 的收尾不该把正在跑的 B 的指示误清",
	);
});

test("接线：子代理进程发布 reporting", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\necho x\n`);
	fs.chmodSync(sayScript, 0o755);

	process.env.PI_SUBAGENT_PARENT_SESSION = "parent-session-id";
	try {
		const harness = await loadHarness({ configFile, sayScript, subagentParentSession: "parent-session-id" });
		const branch = (harness as WireHarness & { branch: unknown[] }).branch;
		branch.push(messageEntry("assistant", [{ type: "text", text: "子代理的结论。" }], "stop"));
		await harness.fire("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(
			statusSequence(harness, "voice-reporting").length,
			0,
			"子代理进程不该发布 reporting（它不发声）",
		);
	} finally {
		delete process.env.PI_SUBAGENT_PARENT_SESSION;
	}
});

test("接线：/voice 无参数时给出状态，on/off 会落盘", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile });

	harness.selectReply = undefined;
	await harness.command("");
	assert.ok(harness.selects.length > 0, "应该弹出交互选择");
	assert.match(harness.selects[0].options.join(" "), /语音播报：on/);

	await harness.command("off");
	assert.equal(loadConfig(configFile).enabled, false, "off 应写进配置文件");
	await harness.command("on");
	assert.equal(loadConfig(configFile).enabled, true);
});

test("接线：/voice summary 能开关摘要，并在状态里体现", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile, modelId: "qwen3.8-flash", modelReply: "摘要。" });

	harness.selectReply = undefined;
	await harness.command("");
	assert.match(harness.selects.at(-1)!.options.join(" "), /摘要：结论 \d+ 字起/, "状态里应写明阈值");
	assert.ok(harness.selects.at(-1)!.options.join(" ").includes("deepseek-flash-qd"), "状态里应写明固定摘要模型");

	await harness.command("summary");
	assert.equal(loadConfig(configFile).summarize, false, "summary 子命令应切换并落盘");
	await harness.command("");
	assert.match(harness.selects.at(-1)!.options.join(" "), /摘要：关闭/);

	await harness.command("summary");
	assert.equal(loadConfig(configFile).summarize, true);
});

test("接线：/voice voices 列出中文音色（真的调 say）", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile });
	await harness.command("voices");
	const notify = harness.notifies.at(-1);
	assert.ok(notify, "应该有提示");
	assert.match(notify.text, /中文音色 \d+ 个/);
});

test("接线：/voice stop 不报错", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile });
	await harness.command("stop");
	assert.match(harness.notifies.at(-1)?.text ?? "", /已停止播报/);
});

// =============================================================================
// ESC 打断（用户要求：念的时候按 ESC 停声，这次按键不传给 pi）
// =============================================================================

test("接线：session_start 装原始输入监听器，重复触发不叠加", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile });

	// /reload、/new、/resume 都会重跑 session_start；不防重入就会一次按键停两遍。
	await harness.fire("session_start", { type: "session_start", reason: "startup" });
	assert.equal(harness.listenerCount(), 1);
	await harness.fire("session_start", { type: "session_start", reason: "reload" });
	assert.equal(harness.listenerCount(), 1, "重复 session_start 不该叠加监听器");
	await harness.fire("session_start", { type: "session_start", reason: "new" });
	assert.equal(harness.listenerCount(), 1);

	await harness.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(harness.listenerCount(), 0, "会话结束应退订");
});

test("接线：非 TUI 模式不装监听器（没有原始输入通道）", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile, mode: "print" });
	await harness.fire("session_start", { type: "session_start", reason: "startup" });
	assert.equal(harness.listenerCount(), 0);
});

test("接线：播放中按 ESC 停声并吞掉按键", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));

	const sayScript = writeBlockingSayScript(dir);

	const harness = await loadHarness({ configFile, sayScript });
	await harness.fire("session_start", { type: "session_start", reason: "startup" });

	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: "这一句很长，足够你按 ESC 把它停掉。" }], "stop"));
	await harness.fire("agent_settled");

	const args = await harness.waitForSayLog();
	assert.equal(args[args.length - 1], "这一句很长，足够你按 ESC 把它停掉。", "应该已经在念");
	assert.deepEqual(
		harness.statuses.filter((s) => s.key === "voice").map((s) => s.text),
		["🔊"],
		"念的时候状态栏应亮着",
	);

	const result = harness.feedInput("\x1b");
	assert.deepEqual(result, { consume: true }, "播放中 ESC 必须被吞掉，不能落到 pi 的中断上");
	assert.equal(await harness.waitForSayLogContaining("KILLED"), true, "say 进程应收到 SIGTERM（真 spawn）");
	assert.equal(
		harness.statuses.filter((s) => s.key === "voice").at(-1)?.text,
		undefined,
		"停声后应清掉状态栏",
	);
});

test("接线：没在念时 ESC / 其他键照旧放行", { skip }, async () => {
	const configFile = path.join(tempDir("pi-voice-cfg-"), "voice.json");
	const harness = await loadHarness({ configFile });
	await harness.fire("session_start", { type: "session_start", reason: "startup" });

	// 空闲、没在念：ESC 必须留给 pi 自己的中断（流式输出 / ! bash / 弹窗），
	// 其他按键更不该受影响。
	for (const other of ["\x1b", "\x1b[A", "\x1b[B", "\x1b[Z", "a", "\r", "\x03"]) {
		assert.equal(harness.feedInput(other), undefined, `${JSON.stringify(other)} 不该被 voice 吃掉`);
	}
});

test("接线：ESC 的三种编码都能停声（裸 ESC / Kitty CSI-u / modifyOtherKeys）", { skip }, async () => {
	// 回归：ESC 的编码不止一种（裸 `\x1b`、Kitty CSI-u、xterm modifyOtherKeys），
	// 手写 `data === "\x1b"` 在启用了 Kitty 协议的终端上会完全失效 —— pi 启动时会主动
	// 启用该协议。必须走 pi 自己的 matchesKey（plan-mode 的 shift+tab 踩过同一个坑）。
	// 这里用真加载器 + 真按键广播把三种编码都跑一遍。
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));

	const sayScript = writeBlockingSayScript(dir);

	const harness = await loadHarness({ configFile, sayScript });
	await harness.fire("session_start", { type: "session_start", reason: "startup" });
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;

	const encodings: Array<[string, string]> = [
		["\x1b", "裸 ESC"],
		["\x1b[27u", "Kitty CSI-u"],
		["\x1b[27;1u", "xterm modifyOtherKeys"],
	];
	for (const [index, [encoded, label]] of encodings.entries()) {
		const text = `第 ${index + 1} 句要念的话。`;
		branch.push(messageEntry("assistant", [{ type: "text", text }], "stop"));
		await harness.fire("agent_settled");
		assert.equal(await harness.waitForSayLogContaining(text), true, `${label}：应该已经在念`);

		assert.deepEqual(harness.feedInput(encoded), { consume: true }, `${label} 应被吞掉`);
		assert.equal(
			await harness.waitForSayLogContaining("KILLED", index + 1),
			true,
			`${label} 应停掉 say（第 ${index + 1} 次 SIGTERM）`,
		);
	}
});

// =============================================================================
// 接线：口播摘要走真 `ctx.modelRegistry.complete()`
// =============================================================================

/** 超过默认阈值（6 字）的结论。 */
const WIRE_LONG_TEXT =
	"先看了下目录结构，网关和适配器分成两个进程。改完了转发判断，把漏掉的协议头补上了。重启之后跑了一遍回归，三条用例都过了。还剩一个细节：超时时间暂时没动。";

test("接线：长结论 → 调固定摘要模型，念的是摘要；摘要不上屏", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const summary = "网关路由修好了，回归全过，超时时间还没动。";
	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply: `**${summary}**`,
	});
	const modelCalls = (harness as WireHarness & { modelCalls: Array<{ prompt: string }> }).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();

	assert.equal(modelCalls.length, 1, "长结论应该调一次摘要模型");
	assert.ok(modelCalls[0].prompt.includes(WIRE_LONG_TEXT), "提示词里应带原文");
	assert.equal(args[args.length - 1], summary, "念的应该是清洗后的摘要（** 被剥掉）");
	// 摘要只进 argv：通知 / 状态栏里除了 🔊 状态，不该出现摘要文字。
	const surfaced = [...harness.notifies.map((n) => n.text), ...harness.statuses.map((s) => s.text ?? "")].join("\n");
	assert.ok(!surfaced.includes(summary), `摘要不该上屏：${surfaced}`);
});

test("接线：摘要预算 = min(summaryMaxChars, 原文长度)，模型超长也被夹住", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	// 源文 15 字（低于 100 的上限）：预算应是 min(100, 15) = 15，而不是配置里的 100。
	const source = "已经改好了，重启一下就能生效。";
	const modelReply = "模型回了很长的一段口播稿，明显超过了原文的字数限制，应该被夹住才对。";
	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply,
	});
	const modelCalls = (harness as WireHarness & { modelCalls: Array<{ prompt: string }> }).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: source }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();

	assert.match(modelCalls[0].prompt, /不超过 15 个字/, "预算应是原文长度，不是配置里的 100");
	assert.ok(!modelCalls[0].prompt.includes("100 个字"), "不该把 100 写进提示词");
	const spoken = args[args.length - 1];
	assert.ok(
		spoken.length <= source.length,
		`念出来 ${spoken.length} 字，不该超过原文 ${source.length} 字：${spoken}`,
	);
	assert.notEqual(spoken, modelReply, "模型原文不该原样念出去");
});

test("接线：摘要用固定模型 deepseek-flash-qd，不走会话模型", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	// 会话模型是很重的 qwen3.8-max；"deepseek-flash-qd" 在目录里。
	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-max",
		registryModels: ["qwen3.8-max", "deepseek-flash-qd"],
		modelReply: "这轮把事情办完了。",
	});
	const modelCalls = (harness as WireHarness & { modelCalls: Array<{ id: string }> }).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	await harness.fire("agent_settled");
	await harness.waitForSayLog();

	assert.equal(modelCalls.length, 1);
	assert.equal(modelCalls[0].id, "deepseek-flash-qd", "摘要必须走固定模型而不是会话模型");
});

// 关键坑（实测 2026-10-03）：
//   1. pi 的 anthropic-messages 适配器**不认** `extra_body` 选项 —— 它只按自己的字段列表
//      组装请求体，多出来的键直接丢掉（实测：传 `{extra_body}` 时捕获到的 HTTP body 里
//      根本没有这个字段）。唯一能把自定义字段送上网关的通道是 `onPayload`。
//   2. 就算送到了，请求级 `extra_body` 会**整体覆盖** config 里那条路由的 `extra_body`，
//      所以 `qoder_protocol` 必须一起带上 —— 只传 `reasoning_effort` 会让上游退回 openai
//      路径并报 404（实测网关日志 `effort=-` + `HTTP 404`）。
//
// 断言不看“我们传了什么选项”，而是把扩展给出的选项**真跑一遍 pi 的适配器**、拦截
// 实际发出的 HTTP body —— 否则这条测试可能又是绿的却什么都没落到线上。
test("接线：摘要的 low 推理强度真能落到 HTTP body（走 pi 真适配器）", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-max",
		registryModels: ["qwen3.8-max", "deepseek-flash-qd"],
		modelReply: "办完了。",
	});
	const modelCalls = (
		harness as WireHarness & { modelCalls: Array<{ options: Record<string, unknown> }> }
	).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	await harness.fire("agent_settled");
	await harness.waitForSayLog();

	const wire = await captureSummaryWireBody(modelCalls[0]?.options);
	const extra = wire.body.extra_body as Record<string, unknown> | undefined;
	assert.equal(extra?.reasoning_effort, "low", `实际发出的请求体里应是 low 推理强度：${JSON.stringify(wire.body)}`);
	assert.equal(extra?.qoder_protocol, "agent", "必须一起带上协议开关（extra_body 是整体覆盖）");
});

// 目录里有固定模型但其认证不可用时，不能直接放弃（那会让每个会话都退回原文口吻）：
// 换回会话模型再试一次。
test("接线：固定模型没认证 → 退回会话模型仍做摘要", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-max",
		registryModels: ["qwen3.8-max", "deepseek-flash-qd"],
		noAuthForFixedModel: true,
		modelReply: "换回会话模型也能办。",
	});
	const modelCalls = (harness as WireHarness & { modelCalls: Array<{ id: string }> }).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();

	assert.equal(modelCalls.length, 1, "应该只再试一次（会话模型）");
	assert.equal(modelCalls[0].id, "qwen3.8-max", "退回到会话模型");
	assert.equal(args[args.length - 1], "换回会话模型也能办。");
});

// 目录里找不到固定模型时不能静默变哑：退回会话模型继续摘要。
test("接线：目录里没有 deepseek-flash-qd → 退回会话模型仍做摘要", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-max",
		registryModels: ["qwen3.8-max"],
		modelReply: "退回会话模型也能办。",
	});
	const modelCalls = (harness as WireHarness & { modelCalls: Array<{ id: string }> }).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();

	assert.equal(modelCalls.length, 1, "仍然要发一次摘要请求");
	assert.equal(modelCalls[0].id, "qwen3.8-max", "回退到会话模型");
	assert.equal(args[args.length - 1], "退回会话模型也能办。");
});

test("接线：短结论也调一次模型（只播报摘要）", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-max",
		registryModels: ["qwen3.8-max", "deepseek-flash-qd"],
		modelReply: "已经改好，重启就能生效。",
	});
	const modelCalls = (harness as WireHarness & { modelCalls: unknown[] }).modelCalls;
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: "已经改好，重启即可生效。" }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();

	assert.equal(modelCalls.length, 1, "短结论也要过一遍口播稿");
	assert.equal(args[args.length - 1], "已经改好，重启就能生效。");
});

test("接线：模型不可用 / 没配 key → 退回本地精简文本（fail-open）", { skip }, async () => {
	for (const [name, options] of [
		["模型调用抛异常", { modelId: "qwen3.8-flash", registryModels: ["qwen3.8-flash", "deepseek-flash-qd"] }],
		["认证不可用", { modelId: "qwen3.8-flash", registryModels: ["qwen3.8-flash", "deepseek-flash-qd"], noAuth: true }],
		["没有会话模型", {}],
	] as const) {
		const dir = tempDir("pi-voice-cfg-");
		const configFile = path.join(dir, "voice.json");
		fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
		const sayScript = path.join(dir, "fake-say.sh");
		fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
		fs.chmodSync(sayScript, 0o755);

		const harness = await loadHarness({ configFile, sayScript, ...options });
		const branch = (harness as WireHarness & { branch: unknown[] }).branch;
		branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

		await harness.fire("agent_settled");
		const args = await harness.waitForSayLog();

		const spoken = args[args.length - 1] ?? "";
		assert.ok(spoken.length > 0, `${name}：仍应出声`);
		assert.ok(spoken.length <= DEFAULT_CONFIG.summaryMaxChars, `${name}：兜底文本应压到摘要上限内`);
		assert.ok(WIRE_LONG_TEXT.startsWith(spoken.replace(/。$/, "")), `${name}：兜底应是原文开头`);
	}
});

test("接线：摘要模型失败 → 兜底文本也把 commit 编号 / 凭据摘掉（提示词盖不到的那条路）", { skip }, async () => {
	// 用户 2026-10-04 反馈「提交 / 推送的摘要还是会念编号」：摘要在失败 / 超时时走的是
	// **本地兜底文本**（原文精简），那条路根本不过模型 —— 只有机械过滤能盖到。
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const conclusion = "已提交并推送。\n- commit: `e752224` — `feat(voice): 阿里云口播换模型`，9 个文件（+232/−57）\n- push: `fa90a4d..e752224 main -> main`，两个远端都成功";
	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply: "这条不该被念。",
		modelDelayMs: 0,
		noAuth: true, // 摘要模型拿不到 key → 走兜底文本
	});
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: conclusion }], "stop"));

	await harness.fire("agent_settled");
	const args = await harness.waitForSayLog();
	// 假 say 把每个 argv 单独写一行，而口播文本本身就是多行的（原文按行精简）—— 拼回去。
	const spoken = args.join("\n");
	assert.ok(spoken.length > 0, "摘要不可用也要出声（fail-open）");
	assert.ok(!/[0-9a-f]{7}/.test(spoken), `兜底文本不该含 commit 编号：${spoken}`);
	assert.ok(!/232|57/.test(spoken), `兜底文本不该含增删行数：${spoken}`);
	assert.ok(spoken.includes("已提交并推送"), `动作本身要念：${spoken}`);
});

test("接线：等摘要时用户发了下一句 → 取消请求且不出声", { skip }, async () => {
	const dir = tempDir("pi-voice-cfg-");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, voice: "Tingting" }));
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	const harness = await loadHarness({
		configFile,
		sayScript,
		modelId: "qwen3.8-flash",
		registryModels: ["qwen3.8-flash", "deepseek-flash-qd"],
		modelReply: "这条摘要不该被念。",
		modelDelayMs: 300,
	});
	const branch = (harness as WireHarness & { branch: unknown[] }).branch;
	branch.push(messageEntry("assistant", [{ type: "text", text: WIRE_LONG_TEXT }], "stop"));

	await harness.fire("agent_settled");
	await harness.fire("input", { type: "input", source: "interactive" });
	await new Promise((resolve) => setTimeout(resolve, 500));

	assert.equal(fs.existsSync(harness.sayLog), false, "被打断的那轮不该启动 say");
});

// =============================================================================
// 阿里云口播（可选后端：key 在 apikey.json，没配就走本地 say）
// =============================================================================

/** 等一个文件出现（真 spawn 的 E2E 用；调用方自己控制超时长度）。 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

test("接线：/voice key 写进 apikey.json 的 aliyunKey（保留其它字段），clear 清掉", { skip }, async () => {
	const dir = tempDir("pi-voice-aliyun-");
	const keystore = path.join(dir, "apikey.json");
	fs.writeFileSync(
		keystore,
		JSON.stringify({
			version: 2,
			apiKeys: { DEEPSEEK_API_KEY: "sk-d" },
			authToken: "admin",
			proxy: { HTTP_PROXY: "", HTTPS_PROXY: "" },
		}),
	);
	const configFile = path.join(dir, "voice.json");
	const harness = await loadHarness({ configFile, keystoreFile: keystore });

	await harness.command("key sk-e08b024605b34be5b6ad5826e0cd9c1b");
	assert.match(harness.notifies.at(-1)?.text ?? "", /已写入阿里云 Key（sk-e08…9c1b）/);
	assert.equal(readAliyunKey(keystore), "sk-e08b024605b34be5b6ad5826e0cd9c1b");
	const written = JSON.parse(fs.readFileSync(keystore, "utf8"));
	assert.deepEqual(written.apiKeys, { DEEPSEEK_API_KEY: "sk-d" }, "gateway 的 key 不该被动到");
	assert.equal(written.authToken, "admin");

	await harness.command("key");
	assert.match(harness.notifies.at(-1)?.text ?? "", /已配置（sk-e08…9c1b）/);

	await harness.command("key clear");
	assert.match(harness.notifies.at(-1)?.text ?? "", /已清除 aliyunKey/);
	assert.equal(readAliyunKey(keystore), undefined);
	assert.deepEqual(JSON.parse(fs.readFileSync(keystore, "utf8")).apiKeys, { DEEPSEEK_API_KEY: "sk-d" });
});

test("接线：/voice key 遇到损坏的 keystore 只提示不覆盖", { skip }, async () => {
	const dir = tempDir("pi-voice-aliyun-");
	const keystore = path.join(dir, "apikey.json");
	fs.writeFileSync(keystore, "{ broken");
	const configFile = path.join(dir, "voice.json");
	const harness = await loadHarness({ configFile, keystoreFile: keystore });

	await harness.command("key sk-x");
	assert.match(harness.notifies.at(-1)?.text ?? "", /阿里云 Key 写入失败/);
	assert.match(harness.notifies.at(-1)?.type ?? "", /error/);
	assert.equal(fs.readFileSync(keystore, "utf8"), "{ broken");
});

test("接线：/voice 状态行显示当前引擎（未配 → say；配了 → 阿里云 + aliyunVoice）", { skip }, async () => {
	const dir = tempDir("pi-voice-aliyun-");
	const keystore = path.join(dir, "apikey.json");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, aliyunVoice: "Serena" }));
	const harness = await loadHarness({ configFile, keystoreFile: keystore });

	await harness.command("");
	assert.match(harness.selects.at(-1)!.options.join(" | "), /引擎：系统 say/);

	await harness.command("key sk-abcdef123456");
	await harness.command("");
	const lines = harness.selects.at(-1)!.options.join(" | ");
	assert.match(lines, /引擎：阿里云 qwen-audio-3\.1-tts-flash（音色 Serena）/);
	assert.match(lines, /key sk-abc…3456/);
});

test("接线：配了 aliyunKey → 真合成（本地 http）+ 假 afplay 播放，say 不响", { skip }, async () => {
	const dir = tempDir("pi-voice-aliyun-");
	const keystore = path.join(dir, "apikey.json");
	writeAliyunKey(keystore, "sk-live");
	const configFile = path.join(dir, "voice.json");
	fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULT_CONFIG, summarize: false }));

	const afplayScript = path.join(dir, "fake-afplay.sh");
	fs.writeFileSync(
		afplayScript,
		`#!/bin/sh\nprintf 'FILE=%s\\n' "$1" >> "$0.log"\nif [ -f "$1" ]; then printf 'EXISTS\\n' >> "$0.log"; fi\n`,
	);
	fs.chmodSync(afplayScript, 0o755);
	const sayScript = path.join(dir, "fake-say.sh");
	fs.writeFileSync(sayScript, `#!/bin/sh\nprintf 'spoke\\n' > "$0.log"\n`);
	fs.chmodSync(sayScript, 0o755);

	let port = 0;
	const requests: Array<{ url: string; auth?: string; body: unknown }> = [];
	const server = http.createServer((request, response) => {
		if (request.url === "/audio") {
			response.writeHead(200, { "content-type": "audio/wav" });
			response.end(Buffer.from([82, 73, 70, 70]));
			return;
		}
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(chunk as Buffer));
		request.on("end", () => {
			requests.push({
				url: request.url ?? "",
				auth: request.headers.authorization as string | undefined,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ output: { audio: { url: `http://127.0.0.1:${port}/audio` } } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	port = typeof address === "object" && address ? address.port : 0;

	try {
		const harness = await loadHarness({
			configFile,
			sayScript,
			afplayScript,
			keystoreFile: keystore,
			ttsEndpoint: `http://127.0.0.1:${port}/tts`,
		});
		const branch = (harness as WireHarness & { branch: unknown[] }).branch;
		branch.push(messageEntry("assistant", [{ type: "text", text: "云端念这一句。" }], "stop"));

		await harness.fire("agent_settled");
		assert.equal(await waitForFile(`${afplayScript}.log`), true, "afplay 应该被真的启动");

		const log = fs.readFileSync(`${afplayScript}.log`, "utf8");
		assert.match(log, /^FILE=\/.+\/speech\.wav$/m, `参数应是临时音频文件：${log}`);
		assert.match(log, /^EXISTS$/m, "播放时临时文件必须已经落盘");
		assert.equal(fs.existsSync(harness.sayLog), false, "有 key 时不该用 say");

		assert.equal(requests.length, 1, "应只调一次合成接口");
		assert.equal(requests[0].auth, "Bearer sk-live", "key 应来自 apikey.json 的 aliyunKey");
		assert.deepEqual(requests[0].body, {
			model: TTS_MODEL,
			input: { text: "云端念这一句。", voice: "longanhuan_v3.1", language_type: "Chinese" },
		});
	} finally {
		server.close();
	}
});
