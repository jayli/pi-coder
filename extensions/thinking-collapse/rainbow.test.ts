/**
 * rainbow.ts 的单测：单位切分、色相步进、code span 跳过、着色后的可见宽度。
 *
 *   node --test clients/pi/extensions/thinking-collapse/rainbow.test.ts
 *
 * 被测模块不 import pi / pi-tui（颜色转义与环境色都是注入的 `RainbowPaint`），所以这里喂
 * 假实现：`fg(index)` 发一个可读的标记转义 `\x01<i>`，`ambient` 发 `\x02`。
 * 断言直接比对标记串 —— 颜色值本身由 `rainbow.ts` 的 okhsl 参数与 pi-tui 保证，不是这里的重点；
 * 这里要钉的是**哪些字归一个单位、序号怎么走、哪些字不着色、宽度有没有变**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_RAINBOW_CONFIG,
	HUE_STEP_DEG,
	OKHSL_TUNING,
	type RainbowPaint,
	type RainbowUnit,
	agentDir,
	loadRainbowConfig,
	paintRainbow,
	rainbowConfigPath,
	saveRainbowConfig,
	splitRainbowUnits,
} from "./rainbow.ts";
import { findCodeSpans } from "./window.ts";

/** 假 paint：`fg(i)` 是可读标记，`ambient` 是一个固定标记。 */
const FAKE: RainbowPaint = {
	fg: (index: number) => `\x01${index}\x02`,
	ambient: "\x03",
};

function paint(line: string, from = 0, to = line.length, dropped: readonly number[] = []): string {
	return paintRainbow(line, splitRainbowUnits(line), from, to, FAKE, findCodeSpans(line), dropped);
}

const texts = (units: readonly RainbowUnit[]): string[] => units.map((u) => u.text);

describe("splitRainbowUnits", () => {
	it("keeps an english word plus its trailing space as one unit", () => {
		assert.deepEqual(texts(splitRainbowUnits("hello world")), ["hello ", "world"]);
	});

	it("gives each CJK character its own unit", () => {
		// 中文没有空白：整句一个色就等于没有彩虹，所以每个字一个单位（用户 2026-10-10 定的口径）
		assert.deepEqual(texts(splitRainbowUnits("中文三个字")), ["中", "文", "三", "个", "字"]);
		assert.deepEqual(texts(splitRainbowUnits("日本語")), ["日", "本", "語"]);
	});

	it("breaks a mixed CJK/ascii run into word and per-character units", () => {
		// 空白挂回**前一个**单位，所以 `个 file` 里的空格归 `个`，`file` 自己一格色相
		assert.deepEqual(texts(splitRainbowUnits("看这个 file")), ["看", "这", "个 ", "file"]);
		assert.deepEqual(texts(splitRainbowUnits("file 里")), ["file ", "里"]);
	});

	it("merges a punctuation-only unit into the previous one", () => {
		// `段，` 的逗号不该单独吃一格色相（否则一半的色相都花在标点上）；合并只会吸进
		// **紧邻的前一个**单位，所以中文里是吸进最后一个字（`语, ` 跟的就是 `语`）。
		assert.deepEqual(texts(splitRainbowUnits("段，下一段")), ["段，", "下", "一", "段"]);
		assert.deepEqual(texts(splitRainbowUnits("英语, next")), ["英", "语, ", "next"]);
	});

	it("keeps an ascii word's own punctuation inside the word", () => {
		assert.deepEqual(texts(splitRainbowUnits("a.b c;d")), ["a.b ", "c;d"]);
	});

	it("treats full-width latin letters and digits as word characters, not punctuation", () => {
		assert.deepEqual(texts(splitRainbowUnits("ＡＢ １２")), ["ＡＢ ", "１２"]);
	});

	it("covers the whole string with contiguous, non-overlapping units", () => {
		for (const line of [
			"hello world",
			"中文三个字",
			"看这个 file 里的 code",
			"first `code span` tail",
			"  leading and trailing  ",
			"",
		]) {
			const units = splitRainbowUnits(line);
			let cursor = 0;
			for (const unit of units) {
				assert.equal(unit.start, cursor, `单位不连续：${JSON.stringify(line)}`);
				assert.equal(unit.text, line.slice(unit.start, unit.end));
				cursor = unit.end;
			}
			assert.equal(cursor, line.length, `没盖满整行：${JSON.stringify(line)}`);
		}
	});
});

describe("paintRainbow", () => {
	it("colors each unit and returns to the ambient color once at the end", () => {
		// 连续单位之间直接换色（SGR 38 覆盖上一个），只在末尾交还环境色一次：
		// pi 每个文本 token 只套一次 thinkingText，末尾不收尾会让后续内容沿用最后一个彩虹色。
		assert.equal(paint("ab cd"), "\x010\x02ab \x011\x02cd\x03");
	});

	it("uses the unit's absolute index, so a clipped window keeps the same colors", () => {
		const line = "one two three four";
		const whole = paint(line);
		// 窗口从第 2 个单位开始：那一段的颜色必须与整行着色时**逐字节相同**
		const from = line.indexOf("three");
		const windowed = paint(line, from, line.length);
		assert.ok(whole.includes(windowed), `窗口着色不是整行的后缀：${JSON.stringify(windowed)}`);
		assert.ok(windowed.startsWith("\x012\x02three"), JSON.stringify(windowed));
	});

	it("leaves code spans uncolored so mdCode keeps its own color", () => {
		const line = "before `code here` after";
		const out = paint(line);
		// 单位表：`before ` / `` `code `` / `here` ` / `after` —— 中间两个与 code span 相交，不着色。
		// `after` 拿的是序号 3（序号按绝对位置发，不受前面跳过的影响）。
		// 进 code span 前先把颜色交还环境色，出来再重新上色。
		assert.equal(out, "\x010\x02before \x03`code here` \x013\x02after\x03");
	});

	it("restores the ambient color before an uncolored run and again at the end", () => {
		// 窗口尾部停在 code span 上时，必须已经交还环境色（否则这段残余会沿用彩虹色）
		const line = "aa `bb";
		const out = paint(line, 0, 5); // 只到 `` `bb `` 中间
		assert.ok(out.endsWith("\x03"), `尾部应收在环境色上：${JSON.stringify(out)}`);
	});

	it("omits dropped characters but keeps the same unit indices", () => {
		const line = "aa `bb";
		// 窗口层把落单的反引号（下标 3）删掉；着色层要在同样的坐标下跳过它
		const out = paint(line, 0, line.length, [3]);
		assert.ok(!out.includes("`"), JSON.stringify(out));
		assert.equal(out, "\x010\x02aa \x011\x02bb\x03");
	});
	it("does not emit an empty color run when the window boundary splits a unit mid-word", () => {
		const line = "hello world";
		const out = paint(line, 8, line.length); // 从 "rld" 开始
		assert.equal(out, "\x011\x02rld\x03");
	});

	it("returns nothing for an empty window", () => {
		assert.equal(paint("hello", 3, 3), "");
		assert.equal(paint(""), "");
	});
});

describe("color tuning constants", () => {
	it("steps the hue so a cycle covers the full wheel", () => {
		assert.equal(360 % HUE_STEP_DEG, 0, "色相步长必须整除 360，否则循环边界会跳色");
	});

	it("uses a darker palette on light backgrounds", () => {
		assert.ok(OKHSL_TUNING.light.lightness < OKHSL_TUNING.dark.lightness);
	});
});

// =============================================================================
// 配置 IO
// =============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

describe("rainbow config", () => {
	it("defaults to enabled", () => {
		assert.equal(DEFAULT_RAINBOW_CONFIG.enabled, true);
	});

	it("falls back to the default config for missing / broken / wrong-shaped files", () => {
		const dir = tempDir("pi-rainbow-");
		assert.deepEqual(loadRainbowConfig(path.join(dir, "nope.json")), DEFAULT_RAINBOW_CONFIG);
		for (const [name, content] of [
			["bad.json", "{ not json"],
			["array.json", "[]"],
			["null.json", "null"],
			["str.json", '"hello"'],
			["wrong-type.json", '{"enabled":"yes"}'],
		] as const) {
			const file = path.join(dir, name);
			fs.writeFileSync(file, content);
			assert.deepEqual(loadRainbowConfig(file), DEFAULT_RAINBOW_CONFIG, `${name} 应退回默认值`);
		}
	});

	it("round-trips a saved value and creates missing directories", () => {
		const file = path.join(tempDir("pi-rainbow-"), "nested", "deeper", "rainbow.json");
		assert.deepEqual(saveRainbowConfig(file, { enabled: false }), { enabled: false });
		assert.deepEqual(loadRainbowConfig(file), { enabled: false });
		assert.deepEqual(saveRainbowConfig(file, { enabled: true }), { enabled: true });
		assert.deepEqual(loadRainbowConfig(file), { enabled: true });
	});

	it("honors PI_RAINBOW_CONFIG and PI_CODING_AGENT_DIR", () => {
		assert.equal(rainbowConfigPath({ PI_RAINBOW_CONFIG: "/tmp/explicit.json" }), "/tmp/explicit.json");
		assert.equal(rainbowConfigPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/rainbow.json");
		assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent");
		assert.ok(rainbowConfigPath({}).endsWith(".pi/agent/rainbow.json"));
	});

	it("expands a leading ~ in the overrides", () => {
		assert.equal(rainbowConfigPath({ PI_RAINBOW_CONFIG: "~/x.json" }), path.join(os.homedir(), "x.json"));
	});
});
