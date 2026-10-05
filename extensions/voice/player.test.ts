/**
 * voice/player 的测试：注入假 spawn 驱动完整状态机（真发声留给装机后的手工验证）。
 *
 *   node --test clients/pi/extensions/voice/player.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Speaker, listVoices, type SpeakerProcess, type SpeakerSpawn } from "./player.ts";

/** 假子进程：记录 kill，手动触发 exit / error。 */
class FakeChild implements SpeakerProcess {
	readonly pid = 1234;
	readonly killed: string[] = [];
	private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	kill(signal?: NodeJS.Signals): boolean {
		this.killed.push(signal ?? "SIGTERM");
		return true;
	}

	on(event: string, listener: (...args: unknown[]) => void): this {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
		return this;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}
}

interface Recorder {
	spawn: SpeakerSpawn;
	calls: Array<{ command: string; args: string[] }>;
	children: FakeChild[];
}

function recorder(): Recorder {
	const calls: Array<{ command: string; args: string[] }> = [];
	const children: FakeChild[] = [];
	return {
		calls,
		children,
		spawn: (command, args) => {
			const child = new FakeChild();
			calls.push({ command, args });
			children.push(child);
			return child;
		},
	};
}

// =============================================================================
// 参数拼装
// =============================================================================

test("speak: 无配置时只发正文（`--` 保护后的位置参数）", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn, sayBin: "say" });
	speaker.speak("结论是什么。");

	assert.equal(rec.calls.length, 1);
	assert.equal(rec.calls[0].command, "say");
	assert.deepEqual(rec.calls[0].args, ["--", "结论是什么。"]);
});

test("speak: 音色与语速按 -v / -r 拼装，且在 `--` 之前", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });
	speaker.speak("念这句。", { voice: "Tingting", rate: 220 });

	assert.deepEqual(rec.calls[0].args, ["-v", "Tingting", "-r", "220", "--", "念这句。"]);
});

test("speak: 语速非法（0 / NaN / 负数）时不传 -r", () => {
	for (const rate of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
		const rec = recorder();
		const speaker = new Speaker({ spawn: rec.spawn });
		speaker.speak("正文。", { voice: "Tingting", rate });
		assert.deepEqual(rec.calls[0].args, ["-v", "Tingting", "--", "正文。"], `rate=${rate} 不该传 -r`);
	}
});

test("speak: 以 - 开头的正文不会被当成选项（`--` 隔开）", () => {
	const rec = recorder();
	new Speaker({ spawn: rec.spawn }).speak("- 第一条改动。");
	assert.deepEqual(rec.calls[0].args, ["--", "- 第一条改动。"]);
});

test("speak: 空文本 / 纯空白不启动进程", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });
	speaker.speak("");
	speaker.speak("   \n ");
	assert.equal(rec.calls.length, 0);
	assert.equal(speaker.speaking, false);
});

// =============================================================================
// 单槽与打断
// =============================================================================

test("speak: 新的一句顶掉旧的（旧进程收到 SIGTERM）", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });

	speaker.speak("第一句。");
	assert.equal(speaker.speaking, true);
	speaker.speak("第二句。");

	assert.equal(rec.calls.length, 2);
	assert.deepEqual(rec.children[0].killed, ["SIGTERM"], "旧的一句必须被打断");
	assert.deepEqual(rec.children[1].killed, [], "新的一句不能被误杀");
});

test("interrupt: 打断当前句；无播放时是 no-op", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });

	speaker.interrupt();
	assert.equal(rec.calls.length, 0, "没在播放时不该启动任何进程");

	speaker.speak("念着这句。");
	speaker.interrupt();
	assert.deepEqual(rec.children[0].killed, ["SIGTERM"]);
	assert.equal(speaker.speaking, false);
});

test("stop: 与 interrupt 等价且幂等", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });
	speaker.speak("念着这句。");
	speaker.stop();
	speaker.stop();
	assert.deepEqual(rec.children[0].killed, ["SIGTERM"], "重复 stop 不该重复 kill");
});

test("被顶掉的旧进程退出时，不能把新一句的状态清成 idle", () => {
	const rec = recorder();
	const states: boolean[] = [];
	const speaker = new Speaker({ spawn: rec.spawn, onStateChange: (s) => states.push(s) });

	speaker.speak("第一句。");
	speaker.speak("第二句。");
	// 旧进程此刻才真正退出（SIGTERM 后的异步 exit）
	rec.children[0].emit("exit", 0, "SIGTERM");

	assert.equal(speaker.speaking, true, "第二句还在念");
	assert.deepEqual(states, [true, false, true], "状态序列：起→被顶掉→再起；旧退出不再改状态");

	rec.children[1].emit("exit", 0, null);
	assert.equal(speaker.speaking, false);
	assert.deepEqual(states, [true, false, true, false]);
});

test("同一句重复 speak 同一文本也会重念（不去重）", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });
	speaker.speak("一样的话。");
	speaker.speak("一样的话。");
	assert.equal(rec.calls.length, 2);
});

// =============================================================================
// 错误路径
// =============================================================================

test("spawn 抛异常：报错且不进入 speaking 状态", () => {
	const errors: string[] = [];
	const speaker = new Speaker({
		spawn: () => {
			throw new Error("ENOENT: say not found");
		},
		onError: (message) => errors.push(message),
	});

	speaker.speak("念这句。");
	assert.equal(speaker.speaking, false);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /ENOENT/);
});

test("子进程 error 事件：报错并复位状态", () => {
	const rec = recorder();
	const errors: string[] = [];
	const speaker = new Speaker({ spawn: rec.spawn, onError: (m) => errors.push(m) });

	speaker.speak("念这句。");
	rec.children[0].emit("error", new Error("spawn failed"));

	assert.equal(speaker.speaking, false);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /spawn failed/);
});

test("非零退出码也算结束（say 报错时不要再挂着 speaking）", () => {
	const rec = recorder();
	const speaker = new Speaker({ spawn: rec.spawn });
	speaker.speak("念这句。");
	rec.children[0].emit("exit", 1, null);
	assert.equal(speaker.speaking, false);
});

// =============================================================================
// 音色列表
// =============================================================================

test("listVoices: 注入 exec 时透传 say -v '?'", () => {
	let captured: { command: string; args: string[] } | undefined;
	const output = listVoices({
		sayBin: "/usr/bin/say",
		exec: (command, args) => {
			captured = { command, args };
			return "Tingting   zh_CN   # 你好。\n";
		},
	});
	assert.deepEqual(captured, { command: "/usr/bin/say", args: ["-v", "?"] });
	assert.match(output, /Tingting/);
});

test("listVoices: 执行失败时返回空串（不抛）", () => {
	const output = listVoices({
		exec: () => {
			throw new Error("boom");
		},
	});
	assert.equal(output, "");
});
