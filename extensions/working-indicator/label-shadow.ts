/**
 * label-shadow.ts — spinner 标签（`Working` / `Thinking` / `Editing` / …）上那道「掠过的影子」。
 *
 * 用户 2026-10-28 要的效果：**两秒一次，一道有渐变的黑影从左到右快速划过整个单词**，像有个
 * 东西飞过去遮住了光，单词中间被压暗一下又立刻亮回来。本模块只算「哪一列被压多暗」，不改
 * 任何颜色 —— 真上色靠注入的 `ShadowPaint`（`index.ts` 用主题色混向黑），所以这里**不 import
 * pi / pi-tui**，`node --test` 能直接跑（用例见 `label-shadow.test.ts`）。
 *
 * ## 时间轴（`shadowSchedule`）
 *
 * 一趟扫过是一道**恒定速度**（默认 20 列/秒）的黑影从标签左侧外飞进来、穿过整行、再从右侧
 * 飞出去；两秒（`periodMs`）一趟。速度是列/秒而不是「每周期固定时长」（用户定的：不管单词
 * 多长，划过的速度一样）。
 *
 * **位置只由时间决定，与标签宽度无关**（`shadowColumnAt`）—— 这是「扫到一半状态切换、黑影接着
 * 原位置继续扫」的实现基础（用户 2026-10-28 定）：`Working` 扫到第三列时切成 `Tools Calling`，
 * 同一时刻的黑影中心还是第三列，于是看着就是同一条影子在一个更长的词上继续往右走。
 *
 * 于是「一轮扫到哪里结束」是**速度与周期的乘积**算的，不是标签宽度：默认 20 列/秒 × 2s = 40 列。
 *   - 短标签（`Working` 7 列）：影子 0.65s 就飞出去了，剩下 1.35s 无影子 —— 这就是「两秒一趟」
 *     的观感（用户要的就是这个：划过之后静止等下一趟）。
 *   - 中长标签（`Subagent watchdog reviewing` 27 列）：1.65s 飞出去，仍有 0.35s 静止。
 *   - 已经飞到标签**右侧之外**时 `center = null`，并且下一帧直接排到周期末尾。这正是用户要的
 *     「状态切换到更短的词、影子已经在它后面了，就等两秒到了再从头扫」—— 不发生「影子跳回
 *     句首」的瞬移。
 *   - 超长标签（长于 40 列，目前不存在）：一趟扫不完，周期到点时影子回左边缘重来。
 *
 * 时钟按 **1 列** 推进（`nextChangeMs` = 走到下一列的时间），调用方拿它排一个一次性定时器；
 * 无影子的那段就只排一个「下趟开始」的长定时器，不空转。
 *
 * ## 影子的形状（`shadowStrengthAt`）
 *
 * 升余弦：中心处 1，两边各 `bandColumns / 2` 处平滑降到 0（不是硬边的一格黑 —— 硬边看着像
 * 选中了一个字符，不像光被挡住）。强度再乘 `maxStrength`（默认 0.72，即最深处压到原色的
 * 28%）并按 1/`SHADOW_LEVELS` 量化：同强度的相邻字符合成一段，一帧只多出几个 ANSI 前缀。
 *
 * ## 为什么按字符中心算距离
 *
 * 标签目前全是 ASCII（列宽 = 1），但宽度是**注入**的（`widthOf`，真实现是 pi-tui 的
 * `visibleWidth`）。用字符自己的可见中心 `col + width / 2` 去比距离，宽字符（CJK）也是「整格
 * 一起变暗」，不会出现半个字被压暗、半个字还亮着。
 */

/** 一个字符（码点）在标签里的位置：`col` 是可见列起点，`width` 占几列。 */
export interface LabelChar {
	text: string;
	col: number;
	width: number;
}

/** 影子的时间轴与形状参数。 */
export interface ShadowTiming {
	/** 两次扫过的间隔（毫秒，含静止段）。 */
	periodMs: number;
	/** 影子飞行的速度（可见列 / 秒）—— 与标签长度无关。 */
	columnsPerSecond: number;
	/** 影子带的总宽度（可见列）：中心最深，两侧渐隐到 0。 */
	bandColumns: number;
	/** 最深处的压暗强度（0..1，混向黑的比例）。 */
	maxStrength: number;
}

/** 默认值：两秒一趟、20 列/秒、6 列宽的软边带、最深处压到原色的 28%。 */
export const DEFAULT_SHADOW_TIMING: ShadowTiming = {
	periodMs: 2000,
	columnsPerSecond: 20,
	bandColumns: 6,
	maxStrength: 0.72,
};

/** 强度量化档数：8 档在终端里已经看不出台阶，又能把一帧的 ANSI 段数压到个位数。 */
export const SHADOW_LEVELS = 8;

/**
 * `shadowSchedule` 的结果。
 *
 * `center === null` 表示这一刻在静止段（画面上没有影子，标签就是静态的纯色）。
 */
export interface ShadowSchedule {
	/** 影子中心的可见列（负数 / 超出标签宽度 = 正从外面飞进来 / 飞出去）。 */
	center: number | null;
	/** 多少毫秒后渲染结果会变（下一列，或静止段的开始 / 结束）。 */
	nextChangeMs: number;
}

/** 标签里的一段同强度文字（相邻同强度的字符已经合并）。 */
export interface ShadowSegment {
	text: string;
	/** 已经量化过的压暗强度；`> 0` 才需要上色。 */
	strength: number;
}

/** 上色接口：`index.ts` 用主题色实现，单测里给假实现。 */
export interface ShadowPaint {
	/** 常态：整段按标签本色上色（**必须**与没有动画时的渲染逐字节相同）。 */
	plain(text: string): string;
	/** 压暗：`strength` 是量化后的档位（> 0）。 */
	shaded(text: string, strength: number): string;
}

/** 非有限 / 越界的参数一律夹回可用范围（环境变量解析出来的数可能是 NaN）。 */
export function normalizeTiming(timing: Partial<ShadowTiming> = {}): ShadowTiming {
	const number = (value: number | undefined, fallback: number, min: number, max: number): number => {
		if (value === undefined || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, value));
	};
	return {
		periodMs: number(timing.periodMs, DEFAULT_SHADOW_TIMING.periodMs, 200, 60_000),
		columnsPerSecond: number(timing.columnsPerSecond, DEFAULT_SHADOW_TIMING.columnsPerSecond, 1, 2_000),
		bandColumns: number(timing.bandColumns, DEFAULT_SHADOW_TIMING.bandColumns, 1, 400),
		maxStrength: number(timing.maxStrength, DEFAULT_SHADOW_TIMING.maxStrength, 0, 1),
	};
}

/** 默认宽度：一个码点一列（标签都是 ASCII；真实现由调用方注入 `visibleWidth`）。 */
function defaultWidthOf(_text: string): number {
	return 1;
}

/** 把标签拆成「每个码点占哪几列」。宽度是注入的，所以宽字符也能整格处理。 */
export function layoutLabelChars(label: string, widthOf: (text: string) => number = defaultWidthOf): LabelChar[] {
	const chars: LabelChar[] = [];
	let col = 0;
	for (const text of label) {
		const width = Math.max(0, widthOf(text));
		chars.push({ text, col, width });
		col += width;
	}
	return chars;
}

/** 标签的可见总宽度（= 最后一个字符的右边界）。 */
export function labelWidth(label: string, widthOf: (text: string) => number = defaultWidthOf): number {
	let col = 0;
	for (const text of label) col += Math.max(0, widthOf(text));
	return col;
}

/**
 * 某一时刻影子的中心列（可见列，可能是负数 = 还在标签左边外面）。
 *
 * **这是本文件唯一的「时间 → 位置」映射，而且它不知道标签有多宽** —— 这一条是「扫到一半切状态、
 * 影子接着原位置扫」的实现基础（用户 2026-10-28 定）。只要 `elapsedMs` 不变，`Working` 与
 * `Tools Calling` 拿到的中心是同一个值，切状态只会换「哪些列被照亮」，不会把影子拽回句首。
 *
 * 公式：起点是「带子刚好贴在标签左边缘」（中心 `-半宽 + 0.5`，`+0.5` 让中心对得上首字符的
 * 可见中心），之后按 `columnsPerSecond` 匀速右移。`elapsedMs` 先取模到 `[0, periodMs)`，所以
 * 每个周期都从左边重新开始（两秒一趟）。
 */
export function shadowColumnAt(elapsedMs: number, timing: Partial<ShadowTiming> = {}): number {
	const t = normalizeTiming(timing);
	const elapsed = wrapElapsed(elapsedMs, t.periodMs);
	return -t.bandColumns / 2 + 0.5 + (elapsed / 1000) * t.columnsPerSecond;
}

/** 把毫秒取模到 `[0, periodMs)`；非有限值当 0（坏时间戳不许抛穿渲染路径）。 */
function wrapElapsed(elapsedMs: number, periodMs: number): number {
	if (!Number.isFinite(elapsedMs)) return 0;
	return ((elapsedMs % periodMs) + periodMs) % periodMs;
}

/** 时钟走一列（= 一行像素级的下一帧）要多少毫秒。 */
function columnStepMs(timing: ShadowTiming): number {
	return 1000 / timing.columnsPerSecond;
}

/**
 * 某一时刻影子的位置 + 下一帧的延时。
 *
 * `elapsedMs` 是「回合开始到现在」（负数 / 非有限值按 0 处理并经取模落回周期内）；`labelCols`
 * 是当前标签的可见宽度。**注意：`labelCols` 只影响「看不看得见」，不影响位置** —— 位置来自
 * `shadowColumnAt(elapsed)`，与标签宽度无关。这就是「扫到一半切状态、影子接着原位置扫」的
 * 实现基础（用户 2026-10-28 定）。
 *
 * 两种结果：
 *   - 带子还在标签身上（或刚碰到左边缘）：`center` 是具体列，`nextChangeMs` = 走到下一列的时间。
 *   - 带子整块已经飞到标签**右边之外**：`center = null`，`nextChangeMs` = 本周期还剩多久。
 *     这一帧不画影子，并且一直不画到周期到点 —— 正是用户要的「换了个短点的词、影子已经跑到
 *     新词后面了，就等两秒间隔到了再从头扫」。
 *
 * 标签比「一个周期里影子能走的路程」还长时（默认 2s × 20 列/秒 = 40 列，实际标签最宽的
 * `Subagent watchdog reviewing` 才 27 列），一趟扫不完：周期到点时影子直接回到左边重来。
 * 这是刻意接受的（恒速与「两秒一趟」只能二选一），不为此把速度变成跟标签宽度相关的量。
 */
export function shadowSchedule(
	elapsedMs: number,
	labelCols: number,
	timing: Partial<ShadowTiming> = {},
): ShadowSchedule {
	const t = normalizeTiming(timing);
	const elapsed = wrapElapsed(elapsedMs, t.periodMs);
	const center = shadowColumnAt(elapsed, t);
	// 带子的**尾边**（中心 − 半宽）过了标签右边界 ⇒ 这一趟对它已经没影子了。
	if (center - t.bandColumns / 2 >= Math.max(0, Math.floor(labelCols))) {
		return { center: null, nextChangeMs: Math.max(1, t.periodMs - elapsed) };
	}
	const stepMs = columnStepMs(t);
	return { center, nextChangeMs: Math.max(1, Math.ceil(stepMs - (elapsed % stepMs))) };
}

/** 某一列离影子中心 `column` 的压暗强度：中心 1，边缘 0（升余弦，软边）。 */
export function shadowStrengthAt(column: number, center: number, bandColumns: number): number {
	const half = Math.max(0.5, bandColumns / 2);
	const distance = Math.abs(column - center);
	if (distance >= half) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * distance) / half));
}

/** 量化到 `SHADOW_LEVELS` 档；`maxStrength` 在这里一次乘掉。 */
function quantizeStrength(raw: number, maxStrength: number): number {
	const clamped = Math.min(1, Math.max(0, raw)) * Math.min(1, Math.max(0, maxStrength));
	return Math.round(clamped * SHADOW_LEVELS) / SHADOW_LEVELS;
}

/**
 * 把标签切成「同强度连续段」。`center === null`（影子已飞过这个词）返回 `null`，调用方直接走
 * `paint.plain(label)` —— 静止时的输出必须与没有这道动画时逐字节相同。
 *
 * 带子完全落在标签外面（扫描的头尾两帧）时强度全是 0，同样返回 `null`：否则会把
 * 7 个字符拆成 7 对转义，渲染结果一样却多了一行 ANSI，也会让「文字没变」的去重失效。
 */
export function shadowSegments(
	label: string,
	schedule: ShadowSchedule,
	timing: Partial<ShadowTiming> = {},
	widthOf: (text: string) => number = defaultWidthOf,
): ShadowSegment[] | null {
	if (schedule.center === null) return null;
	const t = normalizeTiming(timing);
	const segments: ShadowSegment[] = [];
	for (const char of layoutLabelChars(label, widthOf)) {
		const strength = quantizeStrength(
			shadowStrengthAt(char.col + char.width / 2, schedule.center, t.bandColumns),
			t.maxStrength,
		);
		const last = segments[segments.length - 1];
		if (last !== undefined && last.strength === strength) last.text += char.text;
		else segments.push({ text: char.text, strength });
	}
	return segments.every((segment) => segment.strength === 0) ? null : segments;
}

/**
 * 拼出最终要交给 `setWorkingMessage` 的标签字符串。
 *
 * 不变量：`segments === null` 时**恰好**调用一次 `paint.plain(label)` —— 影子不在词上的那段
 * （短词的大部分时间）输出与改动前逐字节相同，`refresh()` 的字符串去重照旧生效（不打无用重绘）。
 */
export function paintLabel(label: string, segments: ShadowSegment[] | null, paint: ShadowPaint): string {
	if (segments === null) return paint.plain(label);
	let out = "";
	for (const segment of segments) {
		out += segment.strength > 0 ? paint.shaded(segment.text, segment.strength) : paint.plain(segment.text);
	}
	return out;
}
