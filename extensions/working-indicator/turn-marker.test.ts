/**
 * Tests for turn-marker.ts — 回合结束符的词表 / 取词 / 时间与整行格式化（纯逻辑，无 pi 依赖）。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/turn-marker.test.ts
 *
 * 这里钉的是**用户给定的形状**（词表十个词、`✻` `for` `· done` 的措辞、12 小时制时钟），
 * 改动它们就是改需求，先看 turn-marker.ts 文件头。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	TURN_MARKER_GLYPH,
	TURN_MARKER_VERBS,
	TURN_MARKER_WIDGET_KEY,
	formatEndClock,
	formatTurnMarker,
	pickTurnVerb,
} from "./turn-marker.ts";

test("词表就是用户给的那十个词，顺序与写法都不变", () => {
	assert.deepEqual(
		[...TURN_MARKER_VERBS],
		[
			"Churned",
			"Spun",
			"Thrashed",
			"Grinding",
			"Chugging",
			"Ping-ponging",
			"Looping",
			"Fizzling",
			"Flickering",
			"Stalled",
		],
	);
});

test("取词覆盖全表：random=0 取第一个、→1 取最后一个、中间按等宽映射", () => {
	assert.equal(pickTurnVerb(() => 0), "Churned");
	assert.equal(pickTurnVerb(() => 0.999_999), "Stalled");
	// 10 个词的等宽区间（floor(random × 10)）：0.5 → 下标 5、0.25 → 下标 2。
	assert.equal(pickTurnVerb(() => 0.5), "Ping-ponging");
	assert.equal(pickTurnVerb(() => 0.25), "Thrashed");
	assert.equal(pickTurnVerb(() => 0.45), "Chugging");
});

test("注入的 random 越界也不越界取词：1.0 夹到最后一个、负数夹到第一个", () => {
	assert.equal(pickTurnVerb(() => 1), "Stalled");
	assert.equal(pickTurnVerb(() => -0.5), "Churned");
});

test("结束时刻：23:52 → 11:52 PM，分钟补零，正午 / 午夜按惯例", () => {
	assert.equal(formatEndClock(new Date(2026, 9, 7, 23, 52)), "11:52 PM");
	assert.equal(formatEndClock(new Date(2026, 9, 7, 9, 5)), "9:05 AM");
	assert.equal(formatEndClock(new Date(2026, 9, 7, 0, 0)), "12:00 AM");
	assert.equal(formatEndClock(new Date(2026, 9, 7, 12, 0)), "12:00 PM");
	assert.equal(formatEndClock(new Date(2026, 9, 7, 13, 0)), "1:00 PM");
});

test("整行形状：✻ <词> for <时长> · done <时刻>；三段原样拼进去、不改写", () => {
	assert.equal(formatTurnMarker("Churned", "3m 37s", "11:52 PM"), "✻ Churned for 3m 37s · done 11:52 PM");
	// 秒档（<60s 的 formatDuration 形状）与 1h 档同样只做拼接。
	assert.equal(formatTurnMarker("Stalled", "42s", "9:05 AM"), "✻ Stalled for 42s · done 9:05 AM");
	assert.equal(formatTurnMarker("Ping-ponging", "1h 2m 3s", "12:00 AM"), "✻ Ping-ponging for 1h 2m 3s · done 12:00 AM");
});

test("widget key 与行首字形是固定契约（recap / simple-task 同区，改名会让旧 widget 残留）", () => {
	assert.equal(TURN_MARKER_WIDGET_KEY, "turn-end");
	assert.equal(TURN_MARKER_GLYPH, "✻");
});
