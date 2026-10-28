/**
 * Tests for working-indicator/label-shadow.ts — 标签上那道「两秒一次、从左掠过」的影子。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/label-shadow.test.ts
 *
 * 纯逻辑，不碰 pi / pi-tui：时间轴（`shadowSchedule`）、形状（`shadowStrengthAt`）、分段与
 * 上色（`shadowSegments` / `paintLabel`）各自独立可测。`widthOf` 在宽字符用例里注入一个
 * 「CJK 算 2 列」的假函数。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_SHADOW_TIMING,
	SHADOW_LEVELS,
	labelWidth,
	layoutLabelChars,
	type LabelChar,
	type ShadowPaint,
	normalizeTiming,
	paintLabel,
	shadowColumnAt,
	shadowSchedule,
	shadowSegments,
	shadowStrengthAt,
} from "./label-shadow.ts";

/** CJK 算 2 列的假宽度（真实现是 pi-tui 的 `visibleWidth`）。 */
function wideWidth(text: string): number {
	return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(text)
		? 2
		: 1;
}

/** 记录每次调用的假上色器（`plain` / `shaded` 都留痕，方便断言「静止时不调 shaded」）。 */
function createPaint(): ShadowPaint & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		plain: (text) => {
			calls.push(`plain:${text}`);
			return `[${text}]`;
		},
		shaded: (text, strength) => {
			calls.push(`shaded:${text}:${strength}`);
			return `<${strength}>${text}</>`;
		},
	};
}

test("时间轴：位置只由时间决定，与标签宽度无关（切状态时接着原位置扫）", () => {
	// 同一时刻、不同标签宽度 ⇒ 影子中心必须一模一样。这一条是「扫到一半切状态、
	// 影子不跳回句首」的实现基础（用户 2026-10-28 定）。
	for (const elapsed of [0, 120, 300, 650, 900, 1500, 1999]) {
		const position = shadowColumnAt(elapsed);
		const short = shadowSchedule(elapsed, 7);
		const long = shadowSchedule(elapsed, 27);
		// 词宽只影响「看不看得见」（null = 影子已经飞过这个词），不影响位置。
		if (short.center !== null) assert.equal(short.center, position, `short elapsed=${elapsed}`);
		if (long.center !== null) assert.equal(long.center, position, `long elapsed=${elapsed}`);
	}
	// 直接看映射本身：同一毫秒、无标签参数，就是一个值。
	assert.equal(shadowColumnAt(0), -2.5, "起点：带子刚好贴在标签左边缘（中心 −半宽 + 0.5）");
	assert.equal(shadowColumnAt(50), -1.5, "50ms 走一列（默认 20 列/秒）");
	assert.equal(shadowColumnAt(2000), shadowColumnAt(0), "两秒回绕到起点");
});

test("时间轴：速度与标签长度无关（每列耗时恒定）", () => {
	// 默认 20 列/秒 ⇒ 每列 50ms；标签多长都是这个速度。
	for (const cols of [7, 27, 60]) {
		assert.ok(shadowSchedule(100, cols).nextChangeMs <= 50, `cols=${cols}`);
	}
	assert.equal(shadowColumnAt(100) - shadowColumnAt(50), 1, "每 50ms 正好一列");
});

test("时间轴：影子飞过短词之后就等周期到底（不提前重画、也不跳回句首）", () => {
	// 默认 20 列/秒：7 列的 `Working` 在 ≈650ms 后带子尾边越过第 7 列。
	const moving = shadowSchedule(600, 7);
	assert.notEqual(moving.center, null, "600ms 时影子还在词上");
	const gone = shadowSchedule(700, 7);
	assert.equal(gone.center, null, "700ms 时已飞出去");
	assert.equal(gone.nextChangeMs, 1300, "下一帧直接排到周期末尾（2000 − 700）");
	assert.equal(gone.nextChangeMs + 700, DEFAULT_SHADOW_TIMING.periodMs, "加起来是一个完整周期");

	// 换成更长的词，同一时刻影子还在词上 —— 这正是「切状态后接着扫」的场景。
	assert.notEqual(shadowSchedule(700, 27).center, null, "27 列的词在 700ms 时仍有影子");
});

test("时间轴：扫到一半切成更短的词（影子已在新词后面）→ 等间隔到点再从头扫", () => {
	// 用户场景：`Subagent watchdog reviewing` 扫到第 20 列时切成 `Working`（7 列）。
	const elapsed = 1000; // 20 列/秒 ⇒ 中心 = −2.5 + 20 = 17.5
	assert.equal(shadowColumnAt(elapsed), 17.5);
	assert.equal(shadowSchedule(elapsed, 20).center, 17.5, "长词上还在扫");
	const short = shadowSchedule(elapsed, 7);
	assert.equal(short.center, null, "短词上影子已经飞出去了 ⇒ 不画");
	assert.equal(short.nextChangeMs, 1000, "等两秒间隔到点（2000 − 1000）");
	// 到点那一刻影子回到左边缘重新开始。
	assert.equal(shadowColumnAt(2000), -2.5);
});

test("时间轴：扫到一半切成更长的词 → 影子在原位置继续往右扫", () => {
	// `Working` 扫到第 3 列时切成 `Tools Calling`（13 列）：中心不变，接着扫。
	const elapsed = 275; // 中心 = −2.5 + 5.5 = 3
	assert.equal(shadowColumnAt(elapsed), 3);
	assert.equal(shadowSchedule(elapsed, 7).center, 3);
	const longer = shadowSchedule(elapsed, 13);
	assert.equal(longer.center, 3, "换到长词上，影子还在第 3 列");
	assert.notEqual(shadowSegments("Tools Calling", longer, undefined, undefined), null, "长词上看得见影子");
	// 接着往右走，不会重置。
	assert.equal(shadowSchedule(elapsed + 50, 13).center, 4);
});

test("时间轴：脏输入（负数 / NaN / Infinity / 超大值）都落回周期内且不抛", () => {
	for (const elapsed of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2000, 99999]) {
		const schedule = shadowSchedule(elapsed, 7);
		assert.ok(Number.isFinite(schedule.nextChangeMs) && schedule.nextChangeMs >= 1, String(elapsed));
	}
	// 取模后与等价的周期内时刻一致。
	assert.deepEqual(shadowSchedule(-1, 7), shadowSchedule(1999, 7));
	assert.deepEqual(shadowSchedule(99999, 7), shadowSchedule(99999 % 2000, 7));
});

test("参数夹取：NaN / 越界一律回到可用范围，越界不保留", () => {
	assert.deepEqual(normalizeTiming(), DEFAULT_SHADOW_TIMING);
	assert.deepEqual(normalizeTiming({ periodMs: Number.NaN, maxStrength: 5, bandColumns: 0 }), {
		...DEFAULT_SHADOW_TIMING,
		maxStrength: 1,
		bandColumns: 1,
	});
	assert.equal(normalizeTiming({ periodMs: 10 }).periodMs, 200, "周期下限 200ms");
});

test("形状：中心最深、两侧升余弦渐隐到 0（不是硬边）", () => {
	assert.equal(shadowStrengthAt(5, 5, 6), 1);
	assert.equal(shadowStrengthAt(8, 5, 6), 0, "3 列外（带半宽）强度 0");
	assert.equal(shadowStrengthAt(2, 5, 6), 0);
	// 单调递减 + 左右对称。
	const left = [shadowStrengthAt(2, 5, 6), shadowStrengthAt(3, 5, 6), shadowStrengthAt(4, 5, 6)];
	assert.ok(left[0] < left[1] && left[1] < left[2], "越靠中心越暗");
	assert.equal(shadowStrengthAt(4, 5, 6), shadowStrengthAt(6, 5, 6), "左右对称");
	assert.ok(shadowStrengthAt(3, 5, 6) > 0 && shadowStrengthAt(3, 5, 6) < 1, "中间档是真渐变");
});

test("分段：待在标签外面的帧整张返回 null（不为全 0 强度拆出一堆转义）", () => {
	const timing = { bandColumns: 6, maxStrength: 1 };
	for (const center of [-10, 20]) {
		assert.equal(shadowSegments("Working", { center, nextChangeMs: 50 }, timing), null, `center ${center}`);
	}
});

test("分段：相邻同强度合并、静止段返回 null", () => {
	const timing = { columnsPerSecond: 20, bandColumns: 6, maxStrength: 1 };
	// 3.5 正好是 `k`（第 4 个字符，占列 3）的可见中心 ⇒ 那一格吃到满强度。
	const segments = shadowSegments("Working", { center: 3.5, nextChangeMs: 50 }, timing);
	assert.ok(segments !== null);
	// 拼回去必须还是原文（一个字都不许丢 / 重复）。
	assert.equal(
		segments.map((segment) => segment.text).join(""),
		"Working",
	);
	// 带子 20 列时靠近中心那三个字符都会量化到满强度 ⇒ 必须合并。
	const wide = { columnsPerSecond: 20, bandColumns: 20, maxStrength: 1 };
	const merged = shadowSegments("Working", { center: 3.5, nextChangeMs: 50 }, wide);
	assert.ok(merged !== null);
	assert.equal(merged.map((segment) => segment.text).join(""), "Working");
	assert.ok(merged.length < 7, `带子比标签宽时必有合并，实得 ${merged.length} 段`);
	// 最强的那段就在中心附近，且比两侧更暗。
	const darkest = Math.max(...segments.map((s) => s.strength));
	assert.equal(darkest, 1);
	assert.equal(
		shadowSegments("Working", { center: null, nextChangeMs: 1000 }, timing),
		null,
		"静止段没有段",
	);
});

test("分段：宽字符整格一起变暗（不会出现半个字暗半个字亮）", () => {
	const chars: LabelChar[] = layoutLabelChars("工作中", wideWidth);
	assert.deepEqual(
		chars.map((char) => [char.text, char.col, char.width]),
		[
			["工", 0, 2],
			["作", 2, 2],
			["中", 4, 2],
		],
	);
	assert.equal(labelWidth("工作中", wideWidth), 6);
	assert.equal(labelWidth("Working"), 7);

	const segments = shadowSegments("工作中", { center: 3, nextChangeMs: 50 }, {
		bandColumns: 2,
		maxStrength: 1,
	}, wideWidth);
	assert.ok(segments !== null);
	assert.equal(segments.map((s) => s.text).join(""), "工作中");
	// 纯窄字符的标签在同样参数下会有更多（更细）的段；宽字符按整格量化。
	assert.ok(segments.length <= 3);
});

test("上色：静止段只调一次 plain，输出与形参逐字相同（去重生效的前提）", () => {
	const paint = createPaint();
	const out = paintLabel("Working", null, paint);
	assert.equal(out, "[Working]");
	assert.deepEqual(paint.calls, ["plain:Working"], "静止时不该有 shaded 调用");
});

test("上色：扫过段的首尾用 plain（强度 0），中间用 shaded，拼回去内容不变", () => {
	const timing = { columnsPerSecond: 20, bandColumns: 6, maxStrength: 0.72 };
	const segments = shadowSegments("Working", { center: 3, nextChangeMs: 50 }, timing);
	const paint = createPaint();
	const out = paintLabel("Working", segments, paint);

	assert.ok(paint.calls.some((call) => call.startsWith("shaded:")), "扫过时有压暗段");
	const visible = out.replace(/<[\d.]+>|<\/>/g, "").replace(/\[|\]/g, "");
	assert.equal(visible, "Working", "上色不改变可见内容");
});

test("上色：maxStrength = 0 时整段都走 plain（等于没动画）", () => {
	// 强度全 0 直接返回 `null`（不拆转义），调用方走的就是「静止」那条路。
	const timing = { maxStrength: 0 };
	assert.equal(shadowSegments("Working", { center: 3.5, nextChangeMs: 50 }, timing), null);
});

test("强度量化：档数不超过 SHADOW_LEVELS，量出来的都是 1/8 的整数倍", () => {
	const timing = { maxStrength: 1, bandColumns: 12 };
	const strengths = new Set<number>();
	for (let center = -6; center <= 18; center += 0.5) {
		for (const segment of shadowSegments("Working", { center, nextChangeMs: 50 }, timing) ?? []) {
			strengths.add(segment.strength);
		}
	}
	assert.ok(strengths.size <= SHADOW_LEVELS + 1, `档数 ${strengths.size} 应不超过 ${SHADOW_LEVELS + 1}`);
	for (const strength of strengths) {
		assert.equal(Math.round(strength * SHADOW_LEVELS), strength * SHADOW_LEVELS, "必须是 1/8 的整数倍");
	}
});
