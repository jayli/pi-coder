/**
 * Tests for animation-frames.ts — 色相插值、落定等价、两种降级形态。
 *
 * Run with:  node --test clients/pi/extensions/startup-logo/animation-frames.test.ts
 *
 * 被测模块不 import pi / pi-tui（颜色运算注入），所以这里自己写一份**能算真颜色**的假 ops：
 * 用本机验证过的 OKLab 公式与 sRGB 线性插值，断言直接对着数值。真 pi-tui 的端到端等价
 * （落定帧 == `theme.getFgAnsi("accent")`）在 `index.test.ts` 里用真主题跑。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Color, TerminalColorMode } from "@earendil-works/pi-tui";

import {
	START_LIGHTNESS_DARK,
	START_LIGHTNESS_LIGHT,
	colorForPhase,
	createFadeTheme,
	modeOf,
	pickStartColor,
	rgbToHex,
	startColorForAppearance,
	type ColorOps,
} from "./animation-frames.ts";

type Rgb = { kind: "rgb"; r: number; g: number; b: number };

const rgb = (r: number, g: number, b: number): Color => ({ kind: "rgb", r, g, b }) as Rgb;

/** 假 ops：与 pi-tui 同口径的最小实现（sRGB 线性插值 + OKLab→OKHSL 近似）。 */
const ops: ColorOps = {
	toRgb: (color) => color as unknown as { r: number; g: number; b: number },
	mixOklch: (from, to, amount) => {
		const a = ops.toOkhsl(from);
		const b = ops.toOkhsl(to);
		// 色相走最短弧（与 pi-tui 的 OKLCH 插值同口径）；色相相同的两端退化成线性权重
		let delta = ((b.h - a.h + 540) % 360) - 180;
		return ops.fromOkhsl((a.h + delta * amount + 360) % 360, a.s + (b.s - a.s) * amount, a.l + (b.l - a.l) * amount);
	},
	toOkhsl: (color) => {
		// 归一化到 h∈[0,360)、s∈[0,1]、l∈[0,1] —— 与 pi-tui 的 OKHSL 同口径（`fromOkhsl` 吃 0~1
		// 的 l、吐 0~255 的 rgb，两者必须是一对，否则往返就错）。
		const { r, g, b } = color as unknown as { r: number; g: number; b: number };
		const rn = r / 255;
		const gn = g / 255;
		const bn = b / 255;
		const max = Math.max(rn, gn, bn);
		const min = Math.min(rn, gn, bn);
		const l = (max + min) / 2;
		const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
		let h = 0;
		if (max !== min) {
			const d = max - min;
			if (max === rn) h = 60 * (((gn - bn) / d) % 6);
			else if (max === gn) h = 60 * ((bn - rn) / d + 2);
			else h = 60 * ((rn - gn) / d + 4);
		}
		return { h: (h + 360) % 360, s, l };
	},
	fromOkhsl: (h, s, l) => {
		// 反解成 HSL → RGB（够用来断言「色相没变、亮度按参数走」）
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
		const m = l - c / 2;
		const [r1, g1, b1] =
			h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
		return rgb((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
	},
	fgAnsi: (color, mode) => {
		const { r, g, b } = color as unknown as { r: number; g: number; b: number };
		const rr = Math.round(r);
		const gg = Math.round(g);
		const bb = Math.round(b);
		return mode === "truecolor" ? `\u001b[38;2;${rr};${gg};${bb}m` : `\u001b[38;5;${16 + 36 * (rr >> 5) + 6 * (gg >> 5) + (bb >> 5)}m`;
	},
};

const ACCENT = rgb(140, 218, 255);
const START = rgb(50, 0, 3);

describe("colorForPhase：相位 0/1 是两端，端点逐字节可控", () => {
	it("相位 1 返回的就是 accent 对象本身（不是「算出来等于」）", () => {
		assert.equal(colorForPhase(START, ACCENT, 1, ops), ACCENT);
		assert.equal(colorForPhase(START, ACCENT, 1.7, ops), ACCENT, "越界也落定");
		assert.equal(colorForPhase(START, ACCENT, Number.NaN, ops), ACCENT, "坏相位宁可落定，也不要整块消失");
	});

	it("相位 0 返回起点色（插值量为 0；HSL 往返会有浮点尾巴，所以比的是最终 RGB）", () => {
		const at0 = colorForPhase(rgb(50, 0, 3), ACCENT, 0, ops) as unknown as { r: number; g: number; b: number };
		for (const [channel, expected] of [["r", 50], ["g", 0], ["b", 3]] as const) {
			assert.ok(Math.abs(at0[channel] - expected) < 0.001, `相位 0 的 ${channel} 应回到 ${expected}，得到 ${at0[channel]}`);
		}
		const atNegative = colorForPhase(rgb(50, 0, 3), ACCENT, -3, ops) as unknown as { r: number };
		assert.ok(Math.abs(atNegative.r - 50) < 0.001, "负相位应夹到 0（回到起点色，而不是外插）");
	});

	it("在 OKLCH 里插值，不是 sRGB（否则会穿过灰）", () => {
		// 实测：橙压暗的起点 → 青 accent，sRGB 线性混合在相位 0.15 处得到 rgb(41,38,38)（饱和度 0.05，
		// 就是一段灰）；OKLCH 插值同一行程的饱和度始终 > 0.4。这里用假 ops 钉住「调的是哪个方法」。
		let usedOklch = false;
		const probing: ColorOps = {
			...ops,
			mixOklch: (from, to, amount) => {
				usedOklch = true;
				return ops.mixOklch(from, to, amount);
			},
		};
		colorForPhase(rgb(24, 6, 0), ACCENT, 0.3, probing);
		assert.equal(usedOklch, true, "必须走 OKLCH 插值");
	});

	it("中间相位色相真的在推进，且不穿过灰（亮度单调上升、饱和度不塌）", () => {
		// 色相弧上的 R 通道**本来就不单调**（橙→黄→绿→青，R 先升后降），所以不能拿单通道当断言 ——
		// 这正是 sRGB 插值时代那条断言错的地方。这里换成三个真正的不变量：
		//   ① 色相沿最短弧单调推进；② 亮度单调上升（一路上在变亮）；③ 饱和度不塌到灰。
		const start = rgb(24, 6, 0); // 橙压到近乎黑（实测起点）
		const hueOf = (phase: number): number => {
			const shaped = ops.toOkhsl(colorForPhase(start, ACCENT, phase, ops));
			return shaped.h;
		};
		const hueAt = [0, 0.2, 0.4, 0.6, 0.8, 1].map(hueOf);
		// 最短弧方向上总变位：把每步的有符号差加起来，应等于首尾差
		let traveled = 0;
		for (let i = 1; i < hueAt.length; i++) {
			let step = hueAt[i]! - hueAt[i - 1]!;
			if (step > 180) step -= 360;
			if (step < -180) step += 360;
			traveled += step;
		}
		let total = hueAt[hueAt.length - 1]! - hueAt[0]!;
		if (total < -180) total += 360;
		if (total > 180) total -= 360;
		assert.ok(Math.abs(traveled - total) < 1e-6, `色相没有沿一条弧走完：分段和 ${traveled.toFixed(1)}° vs 首尾差 ${total.toFixed(1)}°`);
		assert.ok(Math.abs(total) > 90, `全程色相只走了 ${total.toFixed(0)}°，等于没有色相渐变`);

		let previousLightness = -1;
		for (let phase = 0; phase <= 1.0001; phase += 0.05) {
			const shaped = ops.toOkhsl(colorForPhase(start, ACCENT, phase, ops));
			assert.ok(shaped.l >= previousLightness - 1e-9, `相位 ${phase.toFixed(2)} 处亮度回落了`);
			if (phase > 0 && phase < 1) assert.ok(shaped.s > 0.2, `相位 ${phase.toFixed(2)} 处饱和度只剩 ${shaped.s.toFixed(2)}，穿灰了`);
			previousLightness = shaped.l;
		}
	});
});

describe("startColorForAppearance：改亮度不改色相", () => {
	const start = rgb(255, 94, 94); // 红，h≈0

	it("暗色皮肤压到 START_LIGHTNESS_DARK 附近，亮色皮肤抬到 START_LIGHTNESS_LIGHT 附近", () => {
		const dark = ops.toOkhsl(startColorForAppearance(start, "dark", ops));
		const light = ops.toOkhsl(startColorForAppearance(start, "light", ops));
		assert.ok(Math.abs(dark.l - START_LIGHTNESS_DARK) < 0.05, `暗色起点亮度 ${dark.l.toFixed(2)} 离 ${START_LIGHTNESS_DARK} 太远`);
		assert.ok(Math.abs(light.l - START_LIGHTNESS_LIGHT) < 0.05, `亮色起点亮度 ${light.l.toFixed(2)} 离 ${START_LIGHTNESS_LIGHT} 太远`);
	});

	it("色相原样带过去（起点是同一个颜色的深浅，不是另一个色相）", () => {
		for (const appearance of ["dark", "light"] as const) {
			const shaped = ops.toOkhsl(startColorForAppearance(start, appearance, ops));
			const original = ops.toOkhsl(start);
			assert.ok(Math.abs(shaped.h - original.h) < 1e-6, `${appearance}: 色相从 ${original.h} 变成了 ${shaped.h}`);
		}
	});

	it("ops 抛错时原样返回起点色（不许把渲染路径弄挂）", () => {
		const broken: ColorOps = { ...ops, toOkhsl: () => { throw new Error("boom"); } };
		assert.equal(startColorForAppearance(start, "dark", broken), start);
	});
});

describe("pickStartColor：从主题色槽里借起点", () => {
	const colors = {
		accent: ACCENT,
		syntaxKeyword: rgb(255, 94, 94),
		syntaxType: ACCENT,
		selectedBg: rgb(22, 29, 43),
	};

	it("挑出白名单里离 accent 最远的那个", () => {
		assert.equal(pickStartColor(colors, ACCENT, ops), colors.syntaxKeyword);
	});

	it("单色皮肤（只有 accent 自己）返回 undefined —— 调用方退回纯亮度渐变", () => {
		assert.equal(pickStartColor({ accent: ACCENT, syntaxType: ACCENT }, ACCENT, ops), undefined);
	});

	it("坏数据（色值解析不了 / ops 抛错）不抛，返回 undefined", () => {
		assert.equal(pickStartColor({ accent: ACCENT, syntaxKeyword: undefined }, ACCENT, ops), undefined);
		const broken: ColorOps = { ...ops, toRgb: () => { throw new Error("boom"); } };
		assert.equal(pickStartColor(colors, ACCENT, broken), undefined);
	});

	it("背景槽再近也不会被选中（白名单的意义）", () => {
		const picked = pickStartColor({ accent: ACCENT, selectedBg: rgb(22, 29, 43) }, ACCENT, ops);
		assert.equal(picked, undefined, "一个没有可见色相、且不在白名单里的槽不该被当成起点");
	});
});

describe("createFadeTheme：只淡颜色，不动文字与布局", () => {
	const theme = {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
		bold: (text: string) => `*${text}*`,
	};

	it("amount = 0 时逐字节转发给 theme.fg（静态路径一字不改）", () => {
		const fade = createFadeTheme(theme, { colors: { accent: ACCENT }, fadeTo: ACCENT, amount: 0, ops });
		assert.equal(fade.fg("accent", "pi"), theme.fg("accent", "pi"));
		assert.equal(fade.fg("muted", "~/x"), theme.fg("muted", "~/x"));
	});

	it("淡化时文字原样、只换成混色后的前景码（宽度不受影响）", () => {
		const fade = createFadeTheme(theme, { colors: { accent: ACCENT }, fadeTo: rgb(0, 0, 0), amount: 0.5, ops });
		const out = fade.fg("accent", "pi v1.0.2");
		assert.ok(out.includes("pi v1.0.2"), "文字必须原样在里面");
		assert.ok(!out.includes("<accent>"), "不该再走原来的 token 上色");
		assert.equal(out.replace(/\u001b\[[0-9;]*m/g, ""), "pi v1.0.2", "剥掉 ANSI 后就是原文字");
	});

	it("淡化量 1 时整段变成背景色（不是「看不见」的空串，宽度不能变）", () => {
		const fade = createFadeTheme(theme, { colors: { accent: ACCENT }, fadeTo: rgb(25, 25, 25), amount: 1, ops });
		const out = fade.fg("accent", "pi");
		assert.equal(out.replace(/\u001b\[[0-9;]*m/g, ""), "pi");
		assert.equal(out, `${ops.fgAnsi(rgb(25, 25, 25), "truecolor")}pi\u001b[39m`);
	});

	it("token 不在 theme.colors 里就转发（宁可原样，也不要什么都看不见）", () => {
		const fade = createFadeTheme(theme, { colors: {}, fadeTo: ACCENT, amount: 0.5, ops });
		assert.equal(fade.fg("accent", "pi"), theme.fg("accent", "pi"));
	});

	it("bold 不受淡化影响（粗体是属性不是颜色）", () => {
		const fade = createFadeTheme(theme, { colors: { accent: ACCENT }, fadeTo: ACCENT, amount: 1, ops });
		assert.equal(fade.bold("pi"), theme.bold("pi"));
	});

	it("ops 抛错时退回未上色的原文（渲染路径不许抛）", () => {
		// 真正可达的抛错路径：token 不在 colors 里 → 转发给 theme.fg，而 theme.fg 抛。
		const brokenTheme = { fg: () => { throw new Error("boom"); }, bold: (t: string) => t };
		const fade = createFadeTheme(brokenTheme, { colors: {}, fadeTo: ACCENT, amount: 0.3, ops });
		assert.equal(fade.fg("accent", "pi"), "pi");
	});

	it("取色 / 拼转义抛错时也退回原文（不是「什么都看不见」）", () => {
		const brokenOps: ColorOps = { ...ops, fgAnsi: () => { throw new Error("boom"); } };
		const fade = createFadeTheme(theme, { colors: { accent: ACCENT }, fadeTo: ACCENT, amount: 0.5, ops: brokenOps });
		assert.equal(fade.fg("accent", "pi"), "pi");
	});
});

describe("模式与色值转换", () => {
	it("modeOf 拿到就用 theme 的，拿不到退回 truecolor", () => {
		assert.equal(modeOf({ getColorMode: () => "256color" as TerminalColorMode }), "256color");
		assert.equal(modeOf({ getColorMode: () => { throw new Error("boom"); } }), "truecolor");
		assert.equal(modeOf({}), "truecolor");
	});

	it("rgbToHex 补零到两位、夹到 0~255", () => {
		assert.equal(rgbToHex(rgb(0, 5, 255), ops), "#0005ff");
		assert.equal(rgbToHex(rgb(300, -20, 16), ops), "#ff0010");
		assert.equal(rgbToHex(undefined, ops), undefined);
	});
});
