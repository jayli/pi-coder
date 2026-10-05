/**
 * animation-frames.ts — 把「纯时间轴」翻译成**真正要渲染的 ANSI 段**：色相插值 + 两种降级形态。
 *
 * 依赖是**注入**的（`ColorOps`）：颜色计算来自 `@earendil-works/pi-tui`，但这里不 import 它，
 * 只拿一个结构化最小接口 —— 与本仓「纯逻辑模块零 pi 依赖、`node --test` 直接跑」的约定一致
 * （`animation.test.ts` 同款）。`index.ts` 用真 pi-tui 的函数组装一份传进来，单测传假的。
 *
 * ## 一条贯穿全文件的不变量：落定帧必须「渲染路径等价」于静态 logo
 *
 * 动画结束后 `index.ts` 根本不调这里（settled 短路，走 `theme.fg("accent", …)`），所以渐变
 * 本身不需要在原子上无损 —— 但为了让「动画中途被打断 / 降级路径」不会留下一个比静态 logo
 * 更差的画面，终点做了硬保证：
 *
 *     colorForPhase(start, accent, 1) === accent            （同一个对象）
 *     paint(text, accent, mode) === theme.getFgAnsi("accent") + text + reset
 *
 * 后一条在 `index.test.ts` 里拿**真主题**逐字节比对（pi-tui 的 `foregroundAnsi` 与 `Theme.fg`
 * 走的是同一个 `mode`，所以两条转义应当完全相同）。
 *
 * ## 两种降级形态（都不是错误路径，是刻意的观感退让）
 *
 * 1. **拿不到某个色的具体值**（主题 token 被设成空串、终端没报颜色）：该截退回 `theme.fg(token,…)`
 *    的原样输出；印记这一格退回 `theme.fg("accent", …)` 的开关两态，即逐格亮起、没有渐变。
 * 2. **选不出起点色相**（单色皮肤、候选槽都解析不出颜色）：起点 = accent 自己，于是
 *    `colorForPhase` 全程返回 accent —— 退化成「印迹逐格亮起」，仍不是死画面。
 *
 * 「完全不动画」是另一回事：`PI_LOGO_ANIMATION=off`，由 `index.ts` 判定。
 */

import { pickStartToken, type HueToken } from "./animation.ts";

/** 只用于类型标注：`import type` 在运行期被抹掉，所以本模块依然零运行时依赖。 */
import type { Color, TerminalColorMode } from "@earendil-works/pi-tui";

/** 注入的颜色运算（真实现来自 pi-tui，单测给假的）。 */
export interface ColorOps {
	toOkhsl(color: Color): { h: number; s: number; l: number };
	fromOkhsl(h: number, s: number, l: number): Color;
	/** **在 OKLCH 里**插值（即 `mixColors(a, b, t, "oklch")`）。见 `colorForPhase` 里的实测账。 */
	mixOklch(from: Color, to: Color, amount: number): Color;
	toRgb(color: Color): { r: number; g: number; b: number };
	/** 与 `Theme.fg()` 内部用的同一条转义（`mode` 相同即逐字节相同）。 */
	fgAnsi(color: Color, mode: TerminalColorMode): string;
}

/** 暗色皮肤的起点亮度：几乎融进深色背景。 */
export const START_LIGHTNESS_DARK = 0.06;

/** 亮色皮肤的起点亮度：几乎融进白底。 */
export const START_LIGHTNESS_LIGHT = 0.97;

/** `theme.colors` 那一层：键 → 颜色（只依赖这一层形状，所以是结构化接口）。 */
export type ColorBag = Record<string, Color | undefined>;

/** 夹到 [0, 1]；非有限数按 `fallback` 处理（坏时间戳不许抛穿渲染路径）。 */
const clamp01 = (value: number, fallback: number): number =>
	Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/**
 * 从主题色槽里挑一个色相带得动的当起点；挑不出返回 undefined（调用方退回纯亮度渐变）。
 */
export function pickStartColor(colors: ColorBag, accent: Color, ops: ColorOps): Color | undefined {
	try {
		const candidates: HueToken[] = [];
		for (const [token, value] of Object.entries(colors)) {
			const hex = rgbToHex(value, ops);
			if (hex !== undefined) candidates.push({ token, hex });
		}
		const token = pickStartToken(rgbToHex(accent, ops) ?? "", candidates);
		return token === undefined ? undefined : colors[token];
	} catch {
		return undefined;
	}
}

/**
 * 起始色：把挑中的槽往背景方向压到 `START_LIGHTNESS_*` —— 暗色皮肤压到近乎融进背景、
 * 亮色皮肤抬到近乎融进白底，于是「出生」那一刻波形是**从背景里长出来**的。
 *
 * 只在 OKHSL 里改亮度、色相原样不动（`h` 直接抄起点槽自己的），所以这是同一族颜色的一档
 * 深浅，不会跨色相偏到别的颜色上去；`s` 也原样带过去。
 */
export function startColorForAppearance(start: Color, appearance: "dark" | "light", ops: ColorOps): Color {
	try {
		const channels = ops.toOkhsl(start);
		const lightness = appearance === "light" ? START_LIGHTNESS_LIGHT : START_LIGHTNESS_DARK;
		return ops.fromOkhsl(channels.h, channels.s, lightness);
	} catch {
		return start;
	}
}

/**
 * 某一相位下的具体颜色：`phase = 0` 是起点色（压暗后的异色），`phase = 1` **就是** `accent`。
 *
 * 在 **OKLCH** 里插值，不是在 sRGB 里 —— 这一条是实测定的，不是口味：
 *
 * 起点是「橙压到近乎黑」（`#180600`），终点是 accent（青 `#8cdaff`）。sRGB 线性混合在两
 * 个远色相的暗色之间会**穿过灰**：相位 0.15 处实测得到 `rgb(41,38,38)`，色相 9°、饱和度
 * **0.05** —— 就是一段灰色，根本看不出色相在动；相位 0.3 又跳到 236°。OKLCH 插值同一组
 * 端点给出的是一条真正的色相弧：51° → 77° → 105° → 131° → 158° → 185° → 212° → 230°，
 * 饱和度始终在 0.4 以上。同一次实测的两组数据都在 `animation-frames.test.ts` 里钉着。
 *
 * 插值空间改了也不影响那条字节级不变量：pi-tui 的 `mixColors` 在 `amount >= 1` 时直接返回
 * 第二个参数（实测 `mixColors(a, b, 1, "oklch") === b`），所以下面仍然写了显式的 `>= 1`
 * 短路，不把正确性寄托在依赖内部实现上。
 */
export function colorForPhase(start: Color, accent: Color, phase: number, ops: ColorOps): Color {
	const amount = clamp01(phase, 1);
	if (amount >= 1) return accent;
	return ops.mixOklch(start, accent, amount);
}

/** `theme.fg` / `theme.bold` 的最小接口（`index.ts` 的 theme 结构兼容）。 */
export interface FadeTheme {
	fg(token: string, text: string): string;
	bold(text: string): string;
}

/** `createFadeTheme` 的参数：具名传，因为 `colors` / `fadeTo` 都是颜色、位置传极易搞反（实测就写反过）。 */
export interface FadeOptions {
	/** 主题色槽（`theme.colors`）。 */
	colors: ColorBag;
	/** 完全看不见时被拉向的颜色（背景色）。 */
	fadeTo: Color;
	/** 0 = 正常，1 = 完全看不见。 */
	amount: number;
	ops: ColorOps;
}

/**
 * 淡化代理：`amount = 1` 表示完全看不见（颜色被拉到背景色），`amount = 0` 表示正常。
 *
 * 拦的是**上色**而不是文字：文字（模型 id、路径）原样输出，只有颜色衰减 —— 所以布局、宽度、
 * 截断口径全部与静态路径一致，动画不会把行撑宽或让侧栏错列。`bold` 不动（粗体是属性不是颜色）。
 *
 * `amount = 0` 时直接转发 `theme.fg(token, …)`，于是「没在淡化」的那一帧与静态路径逐字节相同。
 * 任何异常都退回未上色的原文（渲染路径不许抛给宿主）。
 */
export function createFadeTheme(
	theme: { fg(token: string, text: string): string; bold(text: string): string },
	{ colors, fadeTo, amount, ops }: FadeOptions,
): FadeTheme {
	const clamped = clamp01(amount, 0);
	return {
		bold: (text) => safe(() => theme.bold(text), text),
		fg: (token, text) =>
			safe(() => {
				const color = colors[token];
				if (clamped <= 0 || color === undefined) return theme.fg(token, text);
				const target = clamped >= 1 ? fadeTo : colorForPhase(color, fadeTo, clamped, ops);
				return `${ops.fgAnsi(target, modeOf(theme))}${text}\x1b[39m`;
			}, text),
	};
}

/**
 * 颜色模式：`theme.getColorMode()` 能拿就拿，否则 truecolor。
 *
 * 必须与 `theme.fg` 用同一条，否则落定帧的转义与静态 logo 不一致（256 色终端上是真的会不同）。
 */
export function modeOf(theme: { getColorMode?: () => TerminalColorMode }): TerminalColorMode {
	try {
		if (typeof theme.getColorMode === "function") return theme.getColorMode();
	} catch {
		// 旧 ctx / 假主题：退回 truecolor（最坏情况是终端自己降级，不抛）
	}
	return "truecolor";
}

/** `theme.colors` 里的值 → `#rrggbb`；不是可解析的颜色就返回 undefined。 */
export function rgbToHex(value: Color | undefined, ops: ColorOps): string | undefined {
	try {
		if (value === undefined || value === null) return undefined;
		const rgb = ops.toRgb(value);
		const channel = (n: number): string =>
			Math.min(255, Math.max(0, Math.round(n)))
				.toString(16)
				.padStart(2, "0");
		return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
	} catch {
		return undefined;
	}
}

/** 渲染路径上的任何异常都不许漏给宿主：出错就退回原样文本（本仓的扩展纪律）。 */
function safe(run: () => string, fallback: string): string {
	try {
		return run();
	} catch {
		return fallback;
	}
}
