/**
 * Tests for animation.ts — logo 入场动画的时间轴与起始色相槽的挑选。
 *
 * Run with:  node --test clients/pi/extensions/startup-logo/animation.test.ts
 *
 * 被测模块不 import pi / pi-tui，断言直接对数字与纯函数。颜色怎么算、ANSI 怎么拼在
 * `index.ts`，那里的正确性由「落定帧逐字节等于静态 logo」这条不变量兜住（`index.test.ts`），
 * 所以本文件不去断言具体色值，只钉**时序**：谁先亮、谁最后落定、相位单调、总时长恰好 1 秒。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MARK_ANIM_CELL_FADE_MS,
	MARK_ANIM_COLUMN_STEP_MS,
	MARK_ANIM_LEAD_IN_MS,
	MARK_ANIM_MIN_HUE_DISTANCE,
	MARK_ANIM_ROW_STEP_MS,
	MARK_ANIM_START_TOKENS,
	MARK_ANIM_TICK_MS,
	MARK_ANIM_TOTAL_MS,
	animationProgressMs,
	cellDelayMs,
	cellPhase,
	cellProgress,
	easePhase,
	hexToChroma,
	hexToHue,
	hueDistance,
	isInLeadIn,
	isMarkAnimationOver,
	lastCellDelayMs,
	markAnimationEndMs,
	pickStartToken,
	sideFadeAmount,
} from "./animation.ts";
import { MARK_COLS, MARK_ROWS } from "./logo.ts";

/** 格子表的全部坐标。 */
function allCells(): Array<{ row: number; col: number }> {
	const cells: Array<{ row: number; col: number }> = [];
	for (let row = 0; row < MARK_ROWS; row++) {
		for (let col = 0; col < MARK_COLS; col++) cells.push({ row, col });
	}
	return cells;
}

/** 逐格延迟（毫秒）。 */
const delayOf = (row: number, col: number): number => cellDelayMs(row, col);

describe("时长账：常数之间是推导关系，不是三个独立的魔数", () => {
	it("动画本身 = 最晚出生 + 单格渐显 = 恰好的 1000ms", () => {
		assert.equal(
			(MARK_COLS - 1) * MARK_ANIM_COLUMN_STEP_MS + (MARK_ROWS - 1) * MARK_ANIM_ROW_STEP_MS + MARK_ANIM_CELL_FADE_MS,
			MARK_ANIM_TOTAL_MS,
		);
	});

	it("结束时刻 = 静默期 + 动画本身（1500ms），不是另一个拍脑袋的数", () => {
		assert.equal(markAnimationEndMs(), MARK_ANIM_LEAD_IN_MS + MARK_ANIM_TOTAL_MS);
		assert.equal(markAnimationEndMs(), 1500);
	});

	it("静默期是 500ms（用户要求「启动后 500ms 再开始」）", () => {
		assert.equal(MARK_ANIM_LEAD_IN_MS, 500);
	});

	it("节拍整除两段时间（收尾那一帧不会越过后再空转一次）", () => {
		assert.equal(MARK_ANIM_TOTAL_MS % MARK_ANIM_TICK_MS, 0);
		assert.equal(markAnimationEndMs() % MARK_ANIM_TICK_MS, 0);
	});

	it("行步长是列步长的一半（波前每下两行才左退一列 → 约 45°）", () => {
		assert.equal(MARK_ANIM_ROW_STEP_MS * 2, MARK_ANIM_COLUMN_STEP_MS);
	});

	it("单格渐显比相邻两列的步进慢（相邻格子的亮起看得见先后、又不至于各扫各的）", () => {
		assert.ok(MARK_ANIM_CELL_FADE_MS > MARK_ANIM_COLUMN_STEP_MS);
		assert.ok(MARK_ANIM_CELL_FADE_MS > MARK_ANIM_ROW_STEP_MS);
	});
});

describe("延迟表：右→左 + 上→下", () => {
	it("右上角第一、左下角最后，最晚延迟 = lastCellDelayMs()", () => {
		assert.equal(delayOf(0, MARK_COLS - 1), 0, "最右一列最先亮");
		assert.equal(delayOf(MARK_ROWS - 1, 0), lastCellDelayMs(), "左下角最后亮");
		assert.equal(lastCellDelayMs(), 720);
	});

	it("同一行内：越靠左越晚（右→左）", () => {
		for (let row = 0; row < MARK_ROWS; row++) {
			for (let col = MARK_COLS - 1; col > 0; col--) {
				assert.ok(delayOf(row, col - 1) > delayOf(row, col), `(${row},${col - 1}) 应晚于 (${row},${col})`);
			}
		}
	});

	it("同一列内：越靠下越晚（上→下，波前向左下倾）", () => {
		for (let col = 0; col < MARK_COLS; col++) {
			for (let row = MARK_ROWS - 1; row > 0; row--) {
				assert.ok(delayOf(row, col) > delayOf(row - 1, col), `(${row},${col}) 应晚于 (${row - 1},${col})`);
			}
		}
	});

	it("延迟是「对角线索引」的函数：16 格压成 10 条斜线，同线同刻点亮", () => {
		// 这是对角波的**特征**而不是缺陷：列步长是行步长的两倍，所以延迟只取决于 2×(3-col)+row。
		// 同一条线上一起亮正是「斜扫」的观感来源；旧的写法（断言 16 格互不相同）等于在要求按行扫。
		const byDiagonal = new Map<number, number[]>();
		for (const { row, col } of allCells()) {
			const diagonal = 2 * (MARK_COLS - 1 - col) + row;
			byDiagonal.set(diagonal, [...(byDiagonal.get(diagonal) ?? []), cellDelayMs(row, col)]);
		}
		assert.equal(byDiagonal.size, 10, "4×4 的对角线波只有 10 个不同的点亮时刻");
		for (const [diagonal, delays] of byDiagonal) {
			assert.equal(new Set(delays).size, 1, `对角线 ${diagonal} 上的格子应该同刻点亮：${delays}`);
		}
		// 相邻两条斜线之间的间隔恰好是一个行步长，没有空档也没有重叠
		const sorted = [...byDiagonal.values()].map((delays) => delays[0]!).sort((a, b) => a - b);
		assert.deepEqual(sorted, [0, 80, 160, 240, 320, 400, 480, 560, 640, 720]);
	});

	it("对角波看两角：右上角最早、左下角最晚，而右下角早于左上角", () => {
		assert.equal(cellDelayMs(0, MARK_COLS - 1), 0, "右上角是波头");
		assert.equal(cellDelayMs(MARK_ROWS - 1, 0), lastCellDelayMs(), "左下角是波尾");
		assert.ok(cellDelayMs(MARK_ROWS - 1, MARK_COLS - 1) < cellDelayMs(0, 0), "右下角应该早于左上角（波前向右上倾）");
		// 等刻线是「row 每 +1 就向左退半列」那种斜线（行步长是列步长的一半）：
		// (0,0) 与 (2,1) 就是同一条线，两者都是 480ms。
		assert.equal(cellDelayMs(0, 0), cellDelayMs(2, 1), "波前是斜的：(0,0) 与 (2,1) 同刻");
	});

	it("越界坐标按行列钳制，不抛", () => {
		assert.equal(cellDelayMs(-5, 99), cellDelayMs(0, MARK_COLS - 1), "行钳到 0、列钳到最后一列 → 波头");
		assert.equal(cellDelayMs(99, -5), lastCellDelayMs(), "行钳到末行、列钳到 0 → 波尾");
		assert.equal(cellDelayMs(1.7, 2.2), cellDelayMs(1, 2));
	});
});

describe("相位：静默期 + 1 秒", () => {
	it("**整个静默期内**每一格相位都是 0（先静 500ms 再动，不许提前亮）", () => {
		for (let t = 0; t < MARK_ANIM_LEAD_IN_MS; t += 10) {
			for (const { row, col } of allCells()) {
				assert.equal(cellPhase(row, col, t), 0, `(${row},${col}) 在静默期的 ${t}ms 就亮了`);
				assert.equal(cellProgress(row, col, t), 0);
			}
		}
	});

	it("静默期结束的那一刻仍是全 0（边界不提前一帧）", () => {
		for (const { row, col } of allCells()) {
			assert.equal(cellPhase(row, col, MARK_ANIM_LEAD_IN_MS), 0, `(${row},${col}) 在 500ms 整就亮了`);
		}
	});

	it("elapsed <= 0 时每一格相位都是 0（没有「先整块亮着」的鬼影）", () => {
		for (const { row, col } of allCells()) {
			assert.equal(cellPhase(row, col, 0), 0, `(${row},${col}) 在 0ms 不该有颜色`);
			assert.equal(cellPhase(row, col, -500), 0);
		}
	});

	it("animationProgressMs 把静默期减掉并夹到 >= 0；NaN 当 0", () => {
		assert.equal(animationProgressMs(0), 0);
		assert.equal(animationProgressMs(MARK_ANIM_LEAD_IN_MS - 1), 0);
		assert.equal(animationProgressMs(MARK_ANIM_LEAD_IN_MS), 0, "静默期最后一刻进度仍是 0");
		assert.equal(animationProgressMs(MARK_ANIM_LEAD_IN_MS + 100), 100);
		assert.equal(animationProgressMs(Number.NaN), 0);
	});

	it("isInLeadIn：静默期内为真，之后为假", () => {
		assert.equal(isInLeadIn(0), true);
		assert.equal(isInLeadIn(MARK_ANIM_LEAD_IN_MS - 1), true);
		assert.equal(isInLeadIn(MARK_ANIM_LEAD_IN_MS), false);
	});

	it("恰好 1500ms 时每一格相位都是 1（落定帧就是静态 logo）", () => {
		for (const { row, col } of allCells()) {
			assert.equal(cellProgress(row, col, markAnimationEndMs()), 1, `(${row},${col}) 应该已经落定`);
			assert.equal(cellPhase(row, col, markAnimationEndMs()), 1);
			assert.equal(cellPhase(row, col, 5_000), 1);
		}
	});

	it("单格的渐显窗口正好是 CELL_FADE_MS（出生那一刻为 0、到点为 1）", () => {
		const cell = { row: 2, col: 1 };
		const delay = MARK_ANIM_LEAD_IN_MS + delayOf(cell.row, cell.col);
		assert.equal(cellProgress(cell.row, cell.col, delay), 0);
		assert.equal(cellProgress(cell.row, cell.col, delay + MARK_ANIM_CELL_FADE_MS), 1);
		assert.ok(cellProgress(cell.row, cell.col, delay + MARK_ANIM_CELL_FADE_MS - 1) < 1, "差 1ms 时还没到点");
	});

	it("每一格的相位随时间单调不减（缓动不能出现忽暗忽亮）", () => {
		for (const { row, col } of allCells()) {
			let previous = -1;
			for (let t = 0; t <= markAnimationEndMs(); t += 10) {
				const phase = cellPhase(row, col, t);
				assert.ok(phase >= previous, `(${row},${col}) 在 ${t}ms 相位回落了：${previous} → ${phase}`);
				previous = phase;
			}
		}
	});

	it("缓动两端导数为 0：中点附近的变化量大于两端", () => {
		const step = 0.05;
		const near0 = easePhase(step) - easePhase(0);
		const middle = easePhase(0.5 + step) - easePhase(0.5);
		const near1 = easePhase(1) - easePhase(1 - step);
		assert.ok(middle > near0, "中点应该走得比起点快");
		assert.ok(middle > near1, "中点应该走得比终点快");
	});

	it("easePhase 夹到 [0,1]，NaN 当 0（坏时间戳不许抛穿渲染路径）", () => {
		assert.equal(easePhase(-3), 0);
		assert.equal(easePhase(9), 1);
		assert.equal(easePhase(Number.NaN), 0);
	});
});

describe("动画结束判定与右侧文字", () => {
	it("1499ms 还没结束、1500ms 结束（定时器就该在这里停）", () => {
		assert.equal(isMarkAnimationOver(markAnimationEndMs() - 1), false);
		assert.equal(isMarkAnimationOver(markAnimationEndMs()), true);
		assert.equal(isMarkAnimationOver(markAnimationEndMs() * 10), true);
	});

	it("右侧文字：静默期内全淡，第 r 行在静默期后 r×行步长 起淡、+CELL_FADE_MS 淡完", () => {
		for (let row = 0; row < MARK_ROWS; row++) {
			const start = MARK_ANIM_LEAD_IN_MS + row * MARK_ANIM_ROW_STEP_MS;
			assert.equal(sideFadeAmount(row, 0), 1, "0ms 时两行文字都还看不见");
			for (let t = 0; t < start; t += 10) {
				assert.equal(sideFadeAmount(row, t), 1, `第 ${row} 行在 ${t}ms 就开始变亮了（起淡点是 ${start}ms）`);
			}
			assert.equal(sideFadeAmount(row, start + MARK_ANIM_CELL_FADE_MS), 0, "到点就恢复正常颜色");
			assert.ok(sideFadeAmount(row, start + MARK_ANIM_CELL_FADE_MS / 2) < sideFadeAmount(row, start - 1), "淡入过程单调下降");
		}
		assert.equal(sideFadeAmount(9, markAnimationEndMs()), 0, "越界行钳到末行");
	});

	it("文字淡完不晚于印记落定（不许出现「logo 已经好了、字还在淡」）", () => {
		for (let row = 0; row < MARK_ROWS; row++) {
			const done = MARK_ANIM_LEAD_IN_MS + row * MARK_ANIM_ROW_STEP_MS + MARK_ANIM_CELL_FADE_MS;
			assert.ok(done <= markAnimationEndMs(), `第 ${row} 行文字到 ${done}ms 才淡完`);
		}
	});
});

describe("色相工具", () => {
	it("hexToHue 认 3 位 / 6 位 / 带不带 #，不认别的", () => {
		assert.equal(hexToHue("#8cdaff"), hexToHue("8cdaff"));
		assert.equal(Math.round(hexToHue("#8cdaff")!), 230);
		assert.ok(Math.abs(hexToHue("#fff")! - hexToHue("#ffffff")!) < 1e-9, "3 位与 6 位同一颜色解出同一色相");
		assert.equal(hexToHue("rebeccapurple"), undefined);
		assert.equal(hexToHue("#gggggg"), undefined);
		assert.equal(hexToHue(""), undefined);
	});

	it("灰阶的色相角是数值噪声，必须靠 hexToChroma 判定「有没有色相」", () => {
		// 实测：白 / 各种灰都落在 89.88°、黑落在 0° —— 这就是不能在色相上判「灰」的原因
		assert.ok(hexToChroma("#ffffff")! < 0.02, "白色是灰");
		assert.ok(hexToChroma("#6d6d6d")! < 0.02, "#6d6d6d 是灰");
		assert.ok(hexToChroma("#696969")! < 0.02, "#696969 是灰（thinkingXhigh 就是它）");
		assert.ok(hexToChroma("#000000")! < 0.02, "黑色是灰");
		for (const hex of ["#8cdaff", "#ff5e5e", "#E6B450", "#B7BDF8", "#A6E3A1"]) {
			assert.ok(hexToChroma(hex)! > 0.03, `${hex} 是有色的`);
		}
		assert.equal(hexToChroma("nope"), undefined);
	});

	it("hueDistance 走最短弧，且有界（0~180）", () => {
		assert.equal(hueDistance(10, 20), 10);
		assert.equal(hueDistance(350, 10), 20);
		assert.equal(hueDistance(0, 180), 180);
		assert.equal(hueDistance(180, 0), 180);
		assert.equal(hueDistance(-10, 10), 20);
	});

	it("与 pi-tui 的 OKLCH 色相口径一致（本机三套皮肤全部色槽逐槽对照，偏差 < 1°）", () => {
		// 本机实测值（`pi-tui` 的 colorToOklch 对同一批 hex 的结果），不是拍脑袋的期望值。
		const samples: Array<[string, number]> = [
			["#8cdaff", 229.7],
			["#ff5e5e", 23.8],
			["#fdb082", 52],
			["#8bc391", 147.3],
			["#e27878", 21],
			["#a6e22e", 127],
			["#E6B450", 82],
			["#FF8F40", 52],
			["#B7BDF8", 279.9],
			["#CBA6F7", 305],
			["#89DCEB", 210],
		];
		for (const [hex, expected] of samples) {
			const actual = hexToHue(hex)!;
			assert.ok(hueDistance(actual, expected) < 1.5, `${hex}: 得到 ${actual.toFixed(1)}°，期望约 ${expected}°`);
		}
	});
});

describe("pickStartToken：借一个色相带得动的主题色槽", () => {
	it("取距离最接近目标（70°）的那个，不是最远的那个", () => {
		const token = pickStartToken("#8cdaff", [
			{ token: "syntaxComment", hex: "#6d6d6d" }, // 灰，且不在白名单
			{ token: "mdHeading", hex: "#ff8942" }, // 179°，太远（中段会穿过绿）
			{ token: "toolDiffAdded", hex: "#8bc391" }, // 82°，贴近目标
			{ token: "syntaxKeyword", hex: "#ff5e5e" }, // 154°
		]);
		assert.equal(token, "toolDiffAdded");
	});

	it("为什么不能取最远：最远的那个会让色相弧中段穿过绿", () => {
		// 实测（真色算出来的）：从 mdHeading(#ff8942, 179° 远) 到 accent(#8cdaff) 的 OKLCH
		// 弧，中段约 #507351 —— 饱和度还在，但是一把绿。toolDiffAdded(82°) 的中段是青绿
		// (#81d3f1 附近)，落在本套皮肤本来就有的过渡带里。这条用例钉的是“选的是目标不是极值”。
		const farthest = pickStartToken("#8cdaff", [{ token: "mdHeading", hex: "#ff8942" }], 60, 180);
		assert.equal(farthest, "mdHeading", "把目标改成 180°，同一批候选就会选最远的那个");
		const targeted = pickStartToken("#8cdaff", [{ token: "mdHeading", hex: "#ff8942" }], 60, 70);
		assert.equal(targeted, "mdHeading", "只有一个候选时，够远就选（不再纠结目标）");
	});

	it("不在白名单里的槽一律不选，哪怕它离目标更近", () => {
		const token = pickStartToken("#8cdaff", [
			{ token: "selectedBg", hex: "#161D2B" },
			{ token: "thinkingXhigh", hex: "#696969" },
			{ token: "toolDiffAdded", hex: "#8bc391" },
		]);
		assert.equal(token, "toolDiffAdded");
		assert.equal(
			pickStartToken("#8cdaff", [
				{ token: "selectedBg", hex: "#161D2B" },
				{ token: "muted", hex: "#6B7385" },
			]),
			undefined,
			"只剩背景 / 灰槽时宁可退回纯亮度渐变，也不要挑一个看不见色相的颜色",
		);
	});

	it("距离并列时按白名单顺序打破", () => {
		const token = pickStartToken("#8cdaff", [
			{ token: "toolTitle", hex: "#fdb082" },
			{ token: "syntaxKeyword", hex: "#fdb082" },
		]);
		assert.equal(token, "syntaxKeyword", "syntaxKeyword 在名单更靠前");
	});

	it("都不够远（单色主题 / 只有同色相的槽）返回 undefined —— 调用方退回纯亮度渐变", () => {
		assert.equal(pickStartToken("#8cdaff", [{ token: "syntaxFunction", hex: "#8cdaff" }]), undefined);
		assert.equal(
			pickStartToken("#8cdaff", [{ token: "syntaxType", hex: "#7fc9ee" }], MARK_ANIM_MIN_HUE_DISTANCE),
			undefined,
			"同色系的槽不该被当成起点（那只是亮度差）",
		);
		assert.equal(pickStartToken("#8cdaff", []), undefined);
		assert.equal(pickStartToken("not-a-color", [{ token: "syntaxKeyword", hex: "#ff5e5e" }]), undefined);
	});

	it("候选里的非法色值跳过，不影响其它候选", () => {
		const token = pickStartToken("#8cdaff", [
			{ token: "syntaxKeyword", hex: "" },
			{ token: "toolDiffAdded", hex: "#8bc391" },
		]);
		assert.equal(token, "toolDiffAdded");
	});

	it("白名单自身没有重复项，也不收背景 / 灰 / 状态类槽", () => {
		assert.equal(new Set(MARK_ANIM_START_TOKENS).size, MARK_ANIM_START_TOKENS.length);
		for (const banned of ["selectedBg", "toolSuccessBg", "muted", "dim", "syntaxComment", "thinkingXhigh", "scrollbarThumb"]) {
			assert.equal(MARK_ANIM_START_TOKENS.includes(banned), false, `${banned} 不该出现在起点白名单里`);
		}
	});
});

describe("本机三套皮肤的实际挑选结果（换肤时这条会立刻暴露观感退化）", () => {
	// 色值抄自 ~/.pi/agent/themes/*.json 的解析结果（vars 已展开）。这些是**快照**：
	// 皮肤改了值，这里该跟着改 —— 断言的是「挑出来的槽是谁」，不是色值本身。
	// 每套的 tokens 列的是该皮肤白名单里**够得上距离**的那些（其余槽距离不够，列不列都不影响结果）。
	const themes: Array<{ name: string; accent: string; tokens: Array<{ token: string; hex: string }>; expected: string }> = [
		{
			name: "pi-coder-1337",
			accent: "#8cdaff",
			expected: "toolDiffAdded",
			tokens: [
				{ token: "syntaxKeyword", hex: "#ff5e5e" },
				{ token: "syntaxType", hex: "#8cdaff" },
				{ token: "syntaxFunction", hex: "#8cdaff" },
				{ token: "syntaxNumber", hex: "#fdb082" },
				{ token: "syntaxString", hex: "#fbe3bf" },
				{ token: "toolDiffAdded", hex: "#8bc391" },
				{ token: "toolDiffRemoved", hex: "#e27878" },
				{ token: "warning", hex: "#fdb082" },
				{ token: "mdHeading", hex: "#ff8942" },
				{ token: "mdLink", hex: "#6699cc" },
			],
		},
		{
			name: "pi-coder-ayu",
			accent: "#E6B450",
			expected: "syntaxString",
			tokens: [
				{ token: "syntaxKeyword", hex: "#FF8F40" },
				{ token: "syntaxType", hex: "#59C2FF" },
				{ token: "syntaxFunction", hex: "#FFB454" },
				{ token: "syntaxNumber", hex: "#D2A6FF" },
				{ token: "toolDiffAdded", hex: "#AAD94C" },
				{ token: "syntaxString", hex: "#67a567" }, // 距 accent 62°，最接近 70° 目标（offset 8°）
				{ token: "toolDiffRemoved", hex: "#D95757" }, // 距 59°，offset 11° —— 第二近，钉住「不是取最远」
				{ token: "mdLink", hex: "#59C2FF" },
			],
		},
		{
			name: "pi-coder-catppuccin",
			accent: "#B7BDF8",
			expected: "syntaxFunction",
			tokens: [
				{ token: "syntaxKeyword", hex: "#CBA6F7" },
				{ token: "syntaxType", hex: "#F9E2AF" },
				{ token: "syntaxFunction", hex: "#89DCEB" },
				{ token: "syntaxNumber", hex: "#FAB387" },
				{ token: "toolDiffAdded", hex: "#A6E3A1" },
				{ token: "mdLink", hex: "#89B4FA" },
			],
		},
	];

	for (const theme of themes) {
		it(`${theme.name} → ${theme.expected}（最接近 70° 目标、且真的够远）`, () => {
			const picked = pickStartToken(theme.accent, theme.tokens);
			assert.equal(picked, theme.expected);
			const pickedHex = theme.tokens.find((t) => t.token === picked)!.hex;
			const distance = hueDistance(hexToHue(pickedHex)!, hexToHue(theme.accent)!);
			assert.ok(distance >= MARK_ANIM_MIN_HUE_DISTANCE, `起点色相只差 ${distance.toFixed(0)}°，等于没有色相渐变`);
		});
	}
});
