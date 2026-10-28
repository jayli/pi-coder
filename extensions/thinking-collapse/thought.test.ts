/**
 * thought.ts 的单测：时长三档、token 估算、段键归一、摘要行 + 窄宽兜底、`/think-tail` 配置 IO。
 *
 *   node --test clients/pi/extensions/thinking-collapse/thought.test.ts
 *
 * 被测模块不 import pi / pi-tui（宽度函数 `widthOf` 是注入的），所以这里喂一个假实现：
 * ASCII = 1 列、CJK 全角 = 2 列、`…` 也是 1 列 —— 与 pi-tui 的 `visibleWidth` 已核对一致
 * （`window.test.ts` 用的是同一份口径）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
	DEFAULT_THINK_TAIL_CONFIG,
	THOUGHT_LABEL,
	buildThoughtSummary,
	estimateThoughtTokens,
	formatThoughtDuration,
	formatThoughtSummary,
	loadThinkTailConfig,
	normalizeThoughtText,
	saveThinkTailConfig,
	thinkTailConfigPath,
	thoughtRunKey,
} from "./thought.ts";

/** 假宽度函数：CJK 常见全角区间按 2 列，其余按 1 列（与 window.test.ts 同一份）。 */
function widthOf(text: string): number {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

const cleanups: Array<() => void> = [];
process.on("exit", () => {
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

describe("formatThoughtDuration", () => {
	it("uses plain seconds below a minute", () => {
		assert.equal(formatThoughtDuration(0), "0s");
		assert.equal(formatThoughtDuration(999), "0s");
		assert.equal(formatThoughtDuration(1_000), "1s");
		assert.equal(formatThoughtDuration(22_700), "22s");
		assert.equal(formatThoughtDuration(59_999), "59s");
	});

	it("switches to minutes at 60s, keeping the seconds segment", () => {
		assert.equal(formatThoughtDuration(60_000), "1m 0s");
		assert.equal(formatThoughtDuration(123_000), "2m 3s");
		assert.equal(formatThoughtDuration(3_599_000), "59m 59s");
	});

	it("keeps minutes when hours appear", () => {
		assert.equal(formatThoughtDuration(3_600_000), "1h 0m 0s");
		assert.equal(formatThoughtDuration(4_472_000), "1h 14m 32s");
	});

	it("never prints a negative or non-finite duration", () => {
		// 时钟倒挂 / 缺失时宁可显示 0s，也不要把 `-3s` / `NaNs` 印出来
		assert.equal(formatThoughtDuration(-5_000), "0s");
		assert.equal(formatThoughtDuration(Number.NaN), "0s");
		assert.equal(formatThoughtDuration(Number.POSITIVE_INFINITY), "0s");
	});
});

describe("estimateThoughtTokens", () => {
	it("returns 0 for an empty string", () => {
		assert.equal(estimateThoughtTokens(""), 0);
	});

	it("counts ASCII at a quarter token per character, rounded up", () => {
		assert.equal(estimateThoughtTokens("a"), 1);
		assert.equal(estimateThoughtTokens("abcd"), 1);
		assert.equal(estimateThoughtTokens("abcde"), 2);
	});

	it("counts CJK characters as one token each", () => {
		assert.equal(estimateThoughtTokens("中文"), 2);
		assert.equal(estimateThoughtTokens("中文三个字"), 5);
	});

	it("mixes the two rates", () => {
		// 两个字 = 2 token，`abcd` = 1 token ⇒ 向上取整 3
		assert.equal(estimateThoughtTokens("中文abcd"), 3);
	});

	it("counts an emoji / astral character once, not twice", () => {
		// 代理对在 UTF-16 里是 2 个单元，按码点遍历只算 1 个字符
		assert.equal(estimateThoughtTokens("😀😀😀😀"), 1);
	});

	it("grows monotonically with content (the rolling line never shrinks the number)", () => {
		let previous = 0;
		let text = "";
		for (const chunk of ["思考", "一段", " more", " words", "。", " 尾巴"]) {
			text += chunk;
			const next = estimateThoughtTokens(text);
			assert.ok(next >= previous, `${JSON.stringify(text)} 的估算变小了：${previous} → ${next}`);
			previous = next;
		}
	});

	it("is additive over concatenation (live vs restored sessions agree)", () => {
		// 这正是「整段现算」与「逐 delta 累加」等价的前提：恢复会话没有 delta，只能整段算
		const whole = estimateThoughtTokens("中文abcd中文");
		const parts = estimateThoughtTokens("中文") + estimateThoughtTokens("abcd") + estimateThoughtTokens("中文");
		assert.ok(Math.abs(whole - parts) <= 2, `整段 ${whole} 与分段 ${parts} 差得太多`);
	});
});

describe("normalizeThoughtText / thoughtRunKey", () => {
	it("joins blocks the way pi joins thinking content", () => {
		// pi 是「每块 trim() 后 '\n\n' 连接」；归一结果必须逐字等于那种拼法
		assert.equal(normalizeThoughtText("a\n\nb"), "a\n\nb");
		assert.equal(normalizeThoughtText("  a  \n\n\n\n  b  "), "a\n\nb");
		assert.equal(normalizeThoughtText("a\r\nb"), "a\n\nb");
		assert.equal(normalizeThoughtText("\n\n"), "");
	});

	it("gives the same key to the same content spelled with different whitespace", () => {
		const a = thoughtRunKey("第一段\n\n第二段");
		const b = thoughtRunKey("  第一段  \n\n\n 第二段\n");
		assert.equal(a, b, "空白差异不该换键（渲染器与流式事件来源不同）");
	});

	it("gives different keys to different content", () => {
		assert.notEqual(thoughtRunKey("甲"), thoughtRunKey("乙"));
		assert.notEqual(thoughtRunKey("ab"), thoughtRunKey("ba"));
	});

	it("keeps the length in the key so a hash collision cannot alias two runs", () => {
		const key = thoughtRunKey("hello");
		assert.ok(key.startsWith("5:"), `键应以长度开头：${key}`);
	});
});

describe("formatThoughtSummary", () => {
	it("renders the agreed shape", () => {
		assert.equal(formatThoughtSummary(23_000, 234), `${THOUGHT_LABEL} 23s (234 tokens)`);
		assert.equal(formatThoughtSummary(0, 0), `${THOUGHT_LABEL} 0s (0 tokens)`);
	});

	it("never prints a negative token count", () => {
		assert.equal(formatThoughtSummary(1_000, -7), `${THOUGHT_LABEL} 1s (0 tokens)`);
	});
});

describe("buildThoughtSummary", () => {
	it("fits on one line when the terminal is wide enough", () => {
		const out = buildThoughtSummary("中文思考", 23_000, 80, widthOf);
		assert.equal(out, `${THOUGHT_LABEL} 23s (4 tokens)`);
		assert.equal(out.includes("\n"), false, "摘要必须恰好一行");
	});

	it("truncates from the tail with an ellipsis when the terminal is narrow", () => {
		const out = buildThoughtSummary("x", 3_600_000, 20, widthOf);
		assert.ok(widthOf(out) <= 20, `超宽了：${widthOf(out)} / ${out}`);
		assert.ok(out.endsWith("…"), `应以省略号收尾：${JSON.stringify(out)}`);
		assert.ok(out.startsWith(THOUGHT_LABEL), `头部信息优先保留：${JSON.stringify(out)}`);
	});

	it("falls back to a sane width when availableWidth is missing or silly", () => {
		assert.equal(buildThoughtSummary("x", 1_000, 0, widthOf), `${THOUGHT_LABEL} 1s (1 tokens)`);
		assert.equal(buildThoughtSummary("x", 1_000, Number.NaN, widthOf), `${THOUGHT_LABEL} 1s (1 tokens)`);
	});

	it("carries no ANSI escapes (pi's thinking style supplies the italics)", () => {
		assert.equal(buildThoughtSummary("中文", 1_000, 80, widthOf).includes("\u001b"), false);
	});
});

describe("think-tail config", () => {
	it("defaults to hiding the tail", () => {
		// 默认 off（用户 2026-10-26 定）= 不留残影，定型后只显示一行摘要
		assert.equal(DEFAULT_THINK_TAIL_CONFIG.enabled, false);
	});

	it("falls back to the default for missing / broken / wrong-shaped files", () => {
		const dir = tempDir("pi-think-tail-");
		assert.deepEqual(loadThinkTailConfig(path.join(dir, "nope.json")), DEFAULT_THINK_TAIL_CONFIG);
		for (const [name, content] of [
			["bad.json", "{ not json"],
			["array.json", "[]"],
			["null.json", "null"],
			["str.json", '"hello"'],
			["wrong-type.json", '{"enabled":"yes"}'],
		] as const) {
			const file = path.join(dir, name);
			fs.writeFileSync(file, content);
			assert.deepEqual(loadThinkTailConfig(file), DEFAULT_THINK_TAIL_CONFIG, `${name} 应退回默认值`);
		}
	});

	it("round-trips a saved value and creates missing directories", () => {
		const file = path.join(tempDir("pi-think-tail-"), "nested", "deeper", "think-tail.json");
		assert.deepEqual(saveThinkTailConfig(file, { enabled: false }), { enabled: false });
		assert.deepEqual(loadThinkTailConfig(file), { enabled: false });
		assert.deepEqual(saveThinkTailConfig(file, { enabled: true }), { enabled: true });
		assert.deepEqual(loadThinkTailConfig(file), { enabled: true });
		// 原子写不该留下临时文件
		assert.deepEqual(fs.readdirSync(path.dirname(file)), ["think-tail.json"]);
	});

	it("honors PI_THINK_TAIL_CONFIG and PI_CODING_AGENT_DIR", () => {
		assert.equal(thinkTailConfigPath({ PI_THINK_TAIL_CONFIG: "/tmp/explicit.json" }), "/tmp/explicit.json");
		assert.equal(thinkTailConfigPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/think-tail.json");
		assert.ok(thinkTailConfigPath({}).endsWith(".pi/agent/think-tail.json"));
	});

	it("expands a leading ~ in the override", () => {
		assert.equal(thinkTailConfigPath({ PI_THINK_TAIL_CONFIG: "~/x.json" }), path.join(os.homedir(), "x.json"));
	});
});
