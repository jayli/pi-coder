/**
 * voice/aliyun 的用例：keystore 读写、掩码、TTS 请求形状、下载落盘、播放器状态机，
 * 以及「有 key 走云端 / 没 key 走 say / 云端失败退回 say」的分流。
 *
 * 全部用注入驱动：fetch / spawn 都是假的，只有临时目录与文件是真写的（keystore 要真落盘
 * 才能验证「保留其它字段」）。最后一条用假 `afplay` 脚本走**真 spawn**，确认参数拼装。
 *
 *   node --test clients/pi/extensions/voice/aliyun.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	ALIYUN_TEXT_LIMIT,
	AliyunSpeaker,
	createSpeakerRouter,
	DEFAULT_KEYSTORE_PATH,
	downloadAudio,
	keystorePath,
	maskKey,
	readAliyunKey,
	synthesizeSpeech,
	TTS_ENDPOINT,
	TTS_MODEL,
	writeAliyunKey,
	type FetchInitLike,
	type FetchResponseLike,
	type SpeakerRouterOptions,
} from "./aliyun.ts";
import type { SpeakerLike } from "./controller.ts";
import type { SpeakerProcess, SpeakOptions } from "./player.ts";

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

async function waitFor(predicate: () => boolean, what = "条件", timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等待${what}超时`);
}

function jsonResponse(payload: unknown, status = 200): FetchResponseLike {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(payload),
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

function bytesResponse(bytes: Uint8Array, status = 200): FetchResponseLike {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => "",
		arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
	};
}

interface FetchCall {
	url: string;
	init?: FetchInitLike;
}

/** 记录调用并按 url 分发的假 fetch（合成端点 / 音频下载两端都走它）。 */
function makeFetch(handler: (url: string) => FetchResponseLike): { calls: FetchCall[]; fetchImpl: (url: string, init?: FetchInitLike) => Promise<FetchResponseLike> } {
	const calls: FetchCall[] = [];
	return {
		calls,
		fetchImpl: async (url: string, init?: FetchInitLike) => {
			calls.push({ url, init });
			return handler(url);
		},
	};
}

interface FakeChild extends SpeakerProcess {
	killed: Array<NodeJS.Signals | undefined>;
	emit(event: string, ...args: unknown[]): void;
}

function makeChild(): FakeChild {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const child: FakeChild = {
		pid: 4242,
		killed: [],
		kill(signal?: NodeJS.Signals) {
			child.killed.push(signal);
			queueMicrotask(() => child.emit("exit", 0, null));
			return true;
		},
		on(event: string, listener: (...args: unknown[]) => void) {
			const list = listeners.get(event) ?? [];
			list.push(listener);
			listeners.set(event, list);
			return child;
		},
		emit(event: string, ...args: unknown[]) {
			for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
		},
	};
	return child;
}

function makeSpawn(): { calls: Array<{ command: string; args: string[] }>; children: FakeChild[]; spawnFn: (command: string, args: string[]) => SpeakerProcess } {
	const calls: Array<{ command: string; args: string[] }> = [];
	const children: FakeChild[] = [];
	return {
		calls,
		children,
		spawnFn: (command: string, args: string[]) => {
			const child = makeChild();
			calls.push({ command, args });
			children.push(child);
			return child;
		},
	};
}

/** 记录调用的假 say（router 的本地那一半）。 */
function makeSay(): SpeakerLike & { calls: Array<{ text: string; options: SpeakOptions }>; interrupts: number; stops: number; finish(): void } {
	const state = {
		calls: [] as Array<{ text: string; options: SpeakOptions }>,
		interrupts: 0,
		stops: 0,
		speaking: false,
		speak(text: string, options: SpeakOptions = {}) {
			state.calls.push({ text, options });
			state.speaking = true;
		},
		interrupt() {
			state.interrupts++;
			state.speaking = false;
		},
		stop() {
			state.stops++;
			state.speaking = false;
		},
		finish() {
			state.speaking = false;
		},
	};
	return state;
}

// =============================================================================
// keystore 路径 / 读 / 写
// =============================================================================

test("keystorePath: 默认在 litellm-any 的配置目录，LITELLM_ANY_APIKEY_PATH 可覆盖", () => {
	assert.equal(keystorePath({}), DEFAULT_KEYSTORE_PATH);
	assert.equal(keystorePath({ LITELLM_ANY_APIKEY_PATH: "/x/y.json" }), "/x/y.json");
	assert.equal(
		keystorePath({ LITELLM_ANY_APIKEY_PATH: "~/custom/apikey.json" }),
		path.join(os.homedir(), "custom/apikey.json"),
	);
});

test("readAliyunKey: 文件不存在 / JSON 坏 / 非对象 / 非字符串 / 空值都当作没配", () => {
	const dir = tempDir("pi-voice-keystore-");
	const cases: Array<[string, string]> = [
		["bad.json", "{ not json"],
		["array.json", "[]"],
		["null.json", "null"],
		["number.json", JSON.stringify({ aliyunKey: 42 })],
		["empty.json", JSON.stringify({ aliyunKey: "" })],
		["spaces.json", JSON.stringify({ aliyunKey: "   " })],
		["missing-field.json", JSON.stringify({ version: 2, apiKeys: {} })],
	];
	for (const [name, content] of cases) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, content);
		assert.equal(readAliyunKey(file), undefined, `${name} 应视为未配置`);
	}
	assert.equal(readAliyunKey(path.join(dir, "nope.json")), undefined);
});

test("readAliyunKey: 读到值并 trim", () => {
	const file = path.join(tempDir("pi-voice-keystore-"), "apikey.json");
	fs.writeFileSync(file, JSON.stringify({ version: 2, apiKeys: { DEEPSEEK_API_KEY: "sk-d" }, aliyunKey: " sk-a \n" }));
	assert.equal(readAliyunKey(file), "sk-a");
});

test("writeAliyunKey: 只动 aliyunKey，其它字段原样保留，文件 0600", () => {
	const file = path.join(tempDir("pi-voice-keystore-"), "apikey.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			version: 2,
			apiKeys: { DEEPSEEK_API_KEY: "sk-d", QODER_PAT: "pat" },
			authToken: "admin",
			loginPassword: "",
			adapterPort: 997,
			proxy: { HTTP_PROXY: "http://127.0.0.1:1087", HTTPS_PROXY: "http://127.0.0.1:1087" },
		}),
	);
	fs.chmodSync(file, 0o644);

	writeAliyunKey(file, "sk-alyun");
	const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(parsed.aliyunKey, "sk-alyun");
	assert.deepEqual(parsed.apiKeys, { DEEPSEEK_API_KEY: "sk-d", QODER_PAT: "pat" });
	assert.equal(parsed.adapterPort, 997);
	assert.equal(parsed.proxy.HTTP_PROXY, "http://127.0.0.1:1087");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600, "密钥文件应收紧到 0600");
	assert.equal(fs.existsSync(`${file}.tmp`), false, "临时文件应被 rename 掉");
	assert.equal(readAliyunKey(file), "sk-alyun");

	writeAliyunKey(file, undefined);
	const cleared = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal("aliyunKey" in cleared, false, "清除应删掉字段，而不是留一个空值");
	assert.deepEqual(cleared.apiKeys, { DEEPSEEK_API_KEY: "sk-d", QODER_PAT: "pat" });
	assert.equal(readAliyunKey(file), undefined);
});

test("writeAliyunKey: 文件不存在时按 v2 最小骨架新建", () => {
	const file = path.join(tempDir("pi-voice-keystore-"), "nested", "apikey.json");
	writeAliyunKey(file, "sk-new");
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2, apiKeys: {}, aliyunKey: "sk-new" });
	assert.equal(readAliyunKey(file), "sk-new");
});

test("writeAliyunKey: keystore 损坏时抛错且不覆盖原文件", () => {
	const file = path.join(tempDir("pi-voice-keystore-"), "apikey.json");
	fs.writeFileSync(file, "{ broken");
	assert.throws(() => writeAliyunKey(file, "sk-x"), /不是合法 JSON/);
	assert.equal(fs.readFileSync(file, "utf8"), "{ broken", "损坏的文件不该被覆盖");
});

test("maskKey: 只露头尾，短值全遮", () => {
	assert.equal(maskKey("sk-e08b024605b34be5b6ad5826e0cd9c1b"), "sk-e08…9c1b");
	assert.equal(maskKey("short"), "****");
	assert.equal(maskKey("  1234567890  "), "123456…7890");
});

// =============================================================================
// TTS 客户端
// =============================================================================

test("synthesizeSpeech: 请求形状（端点 / Bearer / model / voice / language_type）", async () => {
	const fake = makeFetch(() => jsonResponse({ output: { audio: { url: "https://oss.example/a.wav?sig=1" } } }));
	const result = await synthesizeSpeech({
		text: "这是一句口播。",
		apiKey: "sk-test",
		voice: "Serena",
		fetchImpl: fake.fetchImpl,
	});

	assert.equal(result.url, "https://oss.example/a.wav?sig=1");
	assert.equal(fake.calls.length, 1);
	const [call] = fake.calls;
	assert.equal(call.url, TTS_ENDPOINT, "默认打百炼的 SpeechSynthesizer 端点");
	assert.equal(call.init?.method, "POST");
	assert.equal(call.init?.headers?.Authorization, "Bearer sk-test");
	assert.equal(call.init?.headers?.["Content-Type"], "application/json");
	assert.deepEqual(JSON.parse(call.init?.body ?? "{}"), {
		model: TTS_MODEL,
		input: { text: "这是一句口播。", voice: "Serena", language_type: "Chinese" },
	});
});

test("synthesizeSpeech: 音色缺省用 longanhuan_v3.1，端点可被参数覆盖", async () => {
	const fake = makeFetch(() => jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }));
	await synthesizeSpeech({ text: "x", apiKey: "sk", endpoint: "http://127.0.0.1:1/local", fetchImpl: fake.fetchImpl });
	assert.equal(fake.calls[0].url, "http://127.0.0.1:1/local");
	assert.equal(JSON.parse(fake.calls[0].init?.body ?? "{}").input.voice, "longanhuan_v3.1");
});

// 2026-10-04：用户要求用重庆话播报。方言靠 `input.instruction` 触发（已实测确认），
// 这里钉住接线：有指令才带字段、空指令退回到与旧版逐字节相同的请求体。
test("synthesizeSpeech: instruction 有值才带上（方言 / 情感控制）", async () => {
	const fake = makeFetch(() => jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }));
	await synthesizeSpeech({
		text: "这是一句口播。",
		apiKey: "sk",
		voice: "longanhuan_v3.1",
		instruction: "请用重庆话口音播报。",
		fetchImpl: fake.fetchImpl,
	});
	const input = JSON.parse(fake.calls[0].init?.body ?? "{}").input;
	assert.equal(input.instruction, "请用重庆话口音播报。");
	assert.equal(input.language_type, "Chinese", "指令与 language_type 不冲突，两个都该在");
});

test("synthesizeSpeech: instruction 为空 / 空白时不带这个字段（与旧请求体完全一致）", async () => {
	for (const instruction of [undefined, "", "   "]) {
		const fake = makeFetch(() => jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }));
		await synthesizeSpeech({ text: "x", apiKey: "sk", voice: "Serena", instruction, fetchImpl: fake.fetchImpl });
		assert.deepEqual(JSON.parse(fake.calls[0].init?.body ?? "{}"), {
			model: TTS_MODEL,
			input: { text: "x", voice: "Serena", language_type: "Chinese" },
		});
	}
});

test("synthesizeSpeech: 超长文本先按句子截到上限（防御性）", async () => {
	const fake = makeFetch(() => jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }));
	const text = `${"这是一句很长的话。".repeat(200)}`;
	await synthesizeSpeech({ text, apiKey: "sk", fetchImpl: fake.fetchImpl });
	const sent = JSON.parse(fake.calls[0].init?.body ?? "{}").input.text as string;
	assert.ok(sent.length <= ALIYUN_TEXT_LIMIT, `发给云端的文本应被截断：${sent.length}`);
	assert.ok(text.startsWith(sent), "截断应保留前缀");
});

test("synthesizeSpeech: 非 2xx / 没有 audio.url 都抛错，并把 code/message 带出来", async () => {
	const bad = makeFetch(() => jsonResponse({ code: "InvalidApiKey", message: "Invalid API-key provided." }, 401));
	await assert.rejects(
		() => synthesizeSpeech({ text: "x", apiKey: "sk", fetchImpl: bad.fetchImpl }),
		/HTTP 401：InvalidApiKey Invalid API-key provided\./,
	);

	const empty = makeFetch(() => jsonResponse({ output: { audio: {} } }));
	await assert.rejects(
		() => synthesizeSpeech({ text: "x", apiKey: "sk", fetchImpl: empty.fetchImpl }),
		/没有 output\.audio\.url/,
	);
});

test("downloadAudio: 把音频写进一次性临时目录，目录里就是响应字节", async () => {
	const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
	const fake = makeFetch(() => bytesResponse(bytes));
	const clip = await downloadAudio({ url: "https://oss.example/a.wav?sig=1", fetchImpl: fake.fetchImpl });
	cleanups.push(() => fs.rmSync(clip.dir, { recursive: true, force: true }));

	assert.ok(clip.file.startsWith(clip.dir), "文件应在一次性目录里");
	assert.equal(path.extname(clip.file), ".wav", "扩展名跟 URL 走（afplay 其实按内容识别）");
	assert.deepEqual(new Uint8Array(fs.readFileSync(clip.file)), bytes);

	const bad = makeFetch(() => jsonResponse({}, 403));
	await assert.rejects(() => downloadAudio({ url: "https://oss.example/b.wav", fetchImpl: bad.fetchImpl }), /HTTP 403/);
});

// =============================================================================
// 阿里云播放器（状态机 / 打断 / 失败）
// =============================================================================

test("AliyunSpeaker: 合成 → 下载 → afplay，播完清状态并删临时文件", async () => {
	const spawn = makeSpawn();
	const clipFiles: string[] = [];
	const fetchState = makeFetch((url) => {
		if (url.startsWith("https://oss.example/")) return bytesResponse(new Uint8Array([1, 2, 3]));
		return jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } });
	});
	const states: boolean[] = [];
	const errors: string[] = [];
	let fileAtSpawn: string | undefined;

	const speaker = new AliyunSpeaker({
		readKey: () => "sk-test",
		readVoice: () => "Serena",
		fetchImpl: fetchState.fetchImpl,
		spawn: (command, args) => {
			const child = makeChild();
			spawn.calls.push({ command, args });
			spawn.children.push(child);
			fileAtSpawn = args[0];
			clipFiles.push(args[0]);
			return child;
		},
		onStateChange: (speaking) => states.push(speaking),
		onError: (message) => errors.push(message),
	});

	speaker.speak("念这一句。", { voice: "Tingting", rate: 200 });
	assert.equal(speaker.speaking, true, "合成期间就该算「在念」（ESC 才能停下它）");

	await waitFor(() => spawn.calls.length === 1, "afplay 启动");
	assert.equal(spawn.calls[0].command, "afplay");
	assert.deepEqual(spawn.calls[0].args.length, 1, "参数只有文件路径（afplay 不认 `--`）");
	assert.equal(path.isAbsolute(spawn.calls[0].args[0]), true);
	assert.equal(fs.existsSync(spawn.calls[0].args[0]), true, "播放时临时文件必须已经落盘");
	assert.equal(fileAtSpawn, clipFiles[0]);

	// 第二段请求是音频下载（第一段是合成）
	assert.equal(fetchState.calls.length, 2);
	assert.equal(fetchState.calls[1].url, "https://oss.example/a.wav");
	// 音色取自 readVoice（不是 say 的 voice/rate）
	assert.equal(JSON.parse(fetchState.calls[0].init?.body ?? "{}").input.voice, "Serena");

	spawn.children[0].emit("exit", 0, null);
	await waitFor(() => !speaker.speaking, "播放结束");
	assert.deepEqual(states, [true, false]);
	assert.deepEqual(errors, []);
	await waitFor(() => !fs.existsSync(spawn.calls[0].args[0]), "临时文件被删掉");
});

test("AliyunSpeaker: interrupt 会 abort 在途请求 + kill 播放进程，且不再报错", async () => {
	const spawn = makeSpawn();
	const errors: string[] = [];
	const states: boolean[] = [];
	let seenSignal: AbortSignal | undefined;

	const speaker = new AliyunSpeaker({
		readKey: () => "sk-test",
		// 合成永不返回，直到被 abort —— 模拟「云端卡住」时用户按 ESC
		fetchImpl: (url, init) => {
			seenSignal = init?.signal;
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
		spawn: spawn.spawnFn,
		onStateChange: (speaking) => states.push(speaking),
		onError: (message) => errors.push(message),
	});

	speaker.speak("卡住的一句。");
	await waitFor(() => speaker.speaking);
	speaker.interrupt();

	assert.equal(seenSignal?.aborted, true, "在途请求应被 abort");
	assert.equal(speaker.speaking, false);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(errors, [], "被打断不算失败，不该提示 / 不该触发兜底");
	assert.deepEqual(states, [true, false]);
});

test("AliyunSpeaker: 播放中 interrupt 会 SIGTERM 掉 afplay", async () => {
	const spawn = makeSpawn();
	const children: FakeChild[] = [];
	const speaker = new AliyunSpeaker({
		readKey: () => "sk-test",
		fetchImpl: makeFetch((url) =>
			url.startsWith("https://oss.example/") ? bytesResponse(new Uint8Array([1])) : jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }),
		).fetchImpl,
		spawn: (command, args) => {
			const child = makeChild();
			spawn.calls.push({ command, args });
			children.push(child);
			return child;
		},
	});

	speaker.speak("正在念的一句。");
	await waitFor(() => children.length === 1, "afplay 启动");
	speaker.interrupt();
	assert.deepEqual(children[0].killed, ["SIGTERM"]);
});

test("AliyunSpeaker: 云端失败只报一次错，不启动 afplay", async () => {
	const spawn = makeSpawn();
	const errors: string[] = [];
	const states: boolean[] = [];
	const speaker = new AliyunSpeaker({
		readKey: () => "sk-test",
		fetchImpl: makeFetch(() => jsonResponse({ code: "Throttling", message: "quota" }, 429)).fetchImpl,
		spawn: spawn.spawnFn,
		onStateChange: (speaking) => states.push(speaking),
		onError: (message) => errors.push(message),
	});

	speaker.speak("念不出来的一句。");
	await waitFor(() => errors.length > 0, "错误回调");
	assert.equal(spawn.calls.length, 0, "失败不该启动播放器");
	assert.match(errors[0], /^阿里云口播失败：HTTP 429：Throttling quota$/);
	assert.equal(speaker.speaking, false);
	assert.deepEqual(states, [true, false]);
});

test("AliyunSpeaker: 没配 key 时直接报错，不发请求", async () => {
	const errors: string[] = [];
	let fetched = 0;
	const speaker = new AliyunSpeaker({
		readKey: () => undefined,
		fetchImpl: async () => {
			fetched++;
			return jsonResponse({});
		},
		onError: (message) => errors.push(message),
	});
	speaker.speak("不会出去的一句。");
	assert.equal(fetched, 0);
	assert.equal(errors.length, 1);
	assert.equal(speaker.speaking, false);
});

// =============================================================================
// 分流：有 key 走云端 / 没 key 走 say / 云端失败退回 say
// =============================================================================

function makeRouter(overrides: Partial<SpeakerRouterOptions> & { say?: ReturnType<typeof makeSay> } = {}) {
	const say = overrides.say ?? makeSay();
	const spawn = makeSpawn();
	const errors: string[] = [];
	const states: boolean[] = [];
	const fetchState = makeFetch((url) =>
		url.startsWith("https://oss.example/") ? bytesResponse(new Uint8Array([1])) : jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }),
	);
	let key: string | undefined = "sk-test";
	const speaker = createSpeakerRouter({
		say,
		readKey: () => key,
		readVoice: () => "Cherry",
		spawn: spawn.spawnFn,
		fetchImpl: fetchState.fetchImpl,
		onError: (message) => errors.push(message),
		onStateChange: (speaking) => states.push(speaking),
		...overrides,
	});
	return {
		speaker,
		say,
		spawn,
		errors,
		states,
		fetchCalls: fetchState.calls,
		setKey: (value: string | undefined) => {
			key = value;
		},
	};
}

test("router: 配了 key → 走阿里云，say 一句都不发", async () => {
	const router = makeRouter();
	router.speaker.speak("云端念这一句。", { voice: "Tingting", rate: 200 });
	await waitFor(() => router.spawn.calls.length === 1, "afplay 启动");

	assert.equal(router.say.calls.length, 0, "有 key 时不该同时用 say");
	assert.equal(router.fetchCalls.length, 2, "合成 + 下载各一次");
	assert.equal(router.speaker.speaking, true);
	router.spawn.children[0].emit("exit", 0, null);
	await waitFor(() => !router.speaker.speaking);
});

test("router: 没配 key → 完全走原来的 say，不联网", async () => {
	const router = makeRouter();
	router.setKey(undefined);
	router.speaker.speak("本地念这一句。", { voice: "Tingting", rate: 200 });

	assert.equal(router.fetchCalls.length, 0, "没 key 不该有任何网络请求");
	assert.equal(router.spawn.calls.length, 0);
	assert.deepEqual(router.say.calls, [{ text: "本地念这一句。", options: { voice: "Tingting", rate: 200 } }]);
	assert.equal(router.speaker.speaking, true);
});

test("router: key 每次 speak 现读 —— /voice key 之后不用重启", async () => {
	const router = makeRouter();
	router.setKey(undefined);
	router.speaker.speak("先用 say。");
	assert.equal(router.say.calls.length, 1);

	router.setKey("sk-new");
	router.speaker.speak("再走云端。");
	await waitFor(() => router.spawn.calls.length === 1, "afplay 启动");
	assert.equal(router.say.calls.length, 1, "第二次不该再走 say");
});

test("router: 云端失败 → 提示一次并用 say 念同一段文本", async () => {
	const router = makeRouter({
		fetchImpl: async () => jsonResponse({ code: "InvalidApiKey", message: "bad key" }, 401),
	});
	router.speaker.speak("兜底念这一句。", { voice: "Meijia" });

	await waitFor(() => router.say.calls.length === 1, "say 兜底");
	assert.deepEqual(router.say.calls, [{ text: "兜底念这一句。", options: { voice: "Meijia" } }]);
	assert.equal(router.errors.length, 1);
	assert.match(router.errors[0], /阿里云口播失败：HTTP 401：InvalidApiKey bad key（退回系统 say）/);
	assert.equal(router.spawn.calls.length, 0, "合成都没成功，不该启动 afplay");
});

test("router: 云端失败发生在被打断之后 → 不再补一声 say", async () => {
	let rejectRequest: ((error: Error) => void) | undefined;
	const router = makeRouter({
		fetchImpl: (_url, init) =>
			new Promise((_resolve, reject) => {
				rejectRequest = reject;
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			}),
	});

	router.speaker.speak("会被打断的一句。");
	await waitFor(() => router.speaker.speaking);
	router.speaker.interrupt();
	rejectRequest?.(new Error("云端随后才失败"));

	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(router.say.calls.length, 0, "打断之后突然出声比沉默更糟");
	assert.deepEqual(router.errors, []);
});

test("router: interrupt / stop 打到两个引擎，speaking 是两边取或", async () => {
	const router = makeRouter();
	router.speaker.speak("本地的一句。");
	router.setKey(undefined);
	router.speaker.stop();
	assert.equal(router.say.stops, 1);

	router.speaker.interrupt();
	assert.equal(router.say.interrupts >= 1, true);
	assert.equal(router.speaker.speaking, false);
});

// =============================================================================
// 真 spawn：假 afplay 脚本（确认参数真的按预期发出去）
// =============================================================================

test("AliyunSpeaker: 假 afplay 脚本走真 spawn（参数 + 文件存在）", async () => {
	const dir = tempDir("pi-voice-afplay-");
	const script = path.join(dir, "fake-afplay.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nprintf 'FILE=%s\\n' "$1" >> "$0.log"\nif [ -f "$1" ]; then printf 'EXISTS\\n' >> "$0.log"; fi\n`,
	);
	fs.chmodSync(script, 0o755);

	const speaker = new AliyunSpeaker({
		readKey: () => "sk-test",
		afplayBin: script,
		fetchImpl: makeFetch((url) =>
			url.startsWith("https://oss.example/")
				? bytesResponse(new Uint8Array([82, 73, 70, 70]))
				: jsonResponse({ output: { audio: { url: "https://oss.example/a.wav" } } }),
		).fetchImpl,
	});

	speaker.speak("真 spawn 的一句。");
	await waitFor(() => !speaker.speaking, "播放结束", 5000);

	const log = fs.readFileSync(`${script}.log`, "utf8");
	assert.match(log, /^FILE=\/.+\/speech\.wav$/m, `afplay 应只收到一个绝对路径参数：${log}`);
	assert.match(log, /^EXISTS$/m, "播放时临时文件必须存在");
});
