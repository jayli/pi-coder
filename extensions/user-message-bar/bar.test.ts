/**
 * Tests for bar.ts — 纯逻辑：行首内边距那格换成竖线（那一格跟着消息底色）、正文前空一格、
 * 空出的格从行尾补白等量吃掉；背景槽转前景取色；补丁幂等。
 *
 * Run with:  node --test clients/pi/extensions/user-message-bar/bar.test.ts
 *
 * 这里用**手写的假行**（形状照 `UserMessageComponent.render` 的真实输出抄：行首 `\x1b[48;…m`、
 * 行尾 `\x1b[49m`、恢复会话首行前面还有 `\x1b]133;A\x07`），只用 ANSI 剥离与字符计数做断言，
 * 所以不需要 pi / pi-tui。真实链路（补丁真的打在 pi 渲染用的那个类上）在 `index.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BAR_GLYPH,
	BAR_INDENT,
	addBarToLine,
	buildHeaderLine,
	darkenAnsiBackground,
	darkenAnsiForeground,
	formatClock,
	formatSessionAge,
	HEADER_BG_DARKEN,
	HEADER_THOUGHT_BG_DARKEN,
	installUserMessageBar,
	installUserMessageTimestamp,
	messageClock,
	messageCompactions,
	messageTurn,
	resetUserMessageTurns,
	resolveBarAnsi,
	messageAge,
	setAgeLookup,
	setCompactionLookup,
} from "./bar.ts";

const BG = "\u001b[48;2;27;28;29m";
const BG_RESET = "\u001b[49m";
const FG = "\u001b[38;2;198;200;209m";
const FG_RESET = "\u001b[39m";
const ZONE = "\u001b]133;A\u0007";
const BAR = "\u001b[38;2;45;44;93m\u258f\u001b[39m";

/** 去掉所有零宽序列后的可见文本（这些 fixture 全是等宽字符，长度即列数）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

test("字形与缩进：默认 `▏`（U+258F），正文前空一格", () => {
	assert.equal(BAR_GLYPH, "\u258f");
	assert.equal(BAR_INDENT, 1);
});

test("常规行：行首内边距空格换成竖线，正文前空一格，行尾补白减一格", () => {
	const line = `${BG} ${FG}你好${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${BAR} ${FG}你好${FG_RESET}   ${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH} 你好   `, "竖线后空一格、正文原样、行尾少一格");
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("竖线跟着消息底色：不插任何背景开关序列，竖线直接坐在 Box 的底色里", () => {
	const line = `${BG} ${FG}你好${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// 竖线紧接在底色序列之后就对了：底色块左边缘是连成一片的，不被抠出缺角
	assert.equal(result.startsWith(`${BG}${BAR}`), true, "竖线直接接在底色后面");
	assert.equal(result.includes(BG_RESET + BAR), false, "竖线前不插关背景");
	assert.equal(result.split(BG_RESET).length - 1, 1, "只有行尾那一个 49m（没多插）");
	assert.equal(result.split(BG).length - 1, 1, "只有行首那一个 48m（没多插还原）");
});

test("长行（行尾只剩一格补白，即 Box 的最小情况）也吃得下：竖线 + 空格换掉内边距 + 那一格", () => {
	const line = `${BG} ${FG}正文正好铺到内容宽${FG_RESET} ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH} 正文正好铺到内容宽`, "行尾那一格补白被吃掉");
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("空的内边距行（盒子的上下留白）也吃第一格，正文前空的那格从补白里出", () => {
	const line = `${BG}${" ".repeat(20)}${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH}${" ".repeat(19)}`);
	assert.equal(plain(result).length, 20);
});

test("OSC 133 zone 标记与底色序列都留在竖线前面", () => {
	const line = `${ZONE}${BG} 正文${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR}正文${BG_RESET}`, "zone 标记与底色前缀原样保留");
	assert.equal(plain(result), `${BAR_GLYPH}正文`, "行尾没补白可借 → 这一行不空那格（不撑宽优先）");
});

test("OSC 133 zone 标记不影响行尾补白的识别", () => {
	const line = `${ZONE}${BG} 正文${BG_RESET}   `;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR} 正文${BG_RESET}  `, "竖线后照常空一格，行尾补白减一格");
	assert.equal(plain(result).length, plain(line).length);
});

test("outputPad = 0：竖线自己也从行尾补白里借一格，正文前再空一格", () => {
	const line = `${BG}${FG}正文${FG_RESET}   ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// 行首的底色 + 前景前缀都算零宽前缀：竖线落在它们之后、正文之前
	assert.equal(result, `${BG}${FG}${BAR} 正文${FG_RESET} ${BG_RESET}`);
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("outputPad = 0 且行尾只剩一格补白：保住竖线，少空那一格", () => {
	const line = `${BG}${FG}正文${FG_RESET} ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${FG}${BAR}正文${FG_RESET}${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH}正文`);
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("outputPad = 0 且正文正好铺满一行：宁可这行没有竖线，也不能撑宽", () => {
	const line = `${BG}${FG}正文正好铺满${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line);
});

test("缩进格数可调（indent 参数），且永远不撑宽", () => {
	const line = `${BG} ${FG}正文${FG_RESET}      ${BG_RESET}`;
	assert.equal(plain(addBarToLine(line, BAR, 3)), `${BAR_GLYPH}   正文   `, "空三格：行尾少吃三格");
	assert.equal(plain(addBarToLine(line, BAR, 99)).length, plain(line).length, "要得比补白多 → 最多吃到只剩竖线");
});

test("正文里的空格不算补白（后面还有内容），不吃字符", () => {
	const line = `${BG}${FG}a b${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line, "行首是正文、行尾没补白 → 原样返回");
});

test("空行与纯转义行不抛，原样返回", () => {
	assert.equal(addBarToLine("", BAR), "");
	assert.equal(addBarToLine(BG_RESET, BAR), BG_RESET);
});

test("取色：默认槽位是强调色 accent（前景槽，不做转换）", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			if (name === "accent") return "\u001b[38;2;137;184;194m"; // #89b8c2 = summer-night 的 teal
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			throw new Error(`Unknown theme background color: ${name}`);
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;137;184;194m");
});

test("取色：背景槽 selectedBg 转成前景（38/48 等值）", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			assert.equal(name, "selectedBg");
			return "\u001b[48;2;45;44;93m";
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;45;44;93m");
});

test("取色：256 色皮肤同样只换 38/48 这一个数字", () => {
	const theme = {
		getFgAnsi: () => {
			throw new Error("Unknown theme color");
		},
		getBgAnsi: () => "\u001b[48;5;17m",
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;5;17m");
});

test("取色：显式指定别的槽位名（如 toolDiffAdded）仍然直接取那个前景", () => {
	const theme = {
		getFgAnsi: (name: string) => (name === "toolDiffAdded" ? "\u001b[38;2;137;184;194m" : (() => { throw new Error("no"); })()),
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(theme, "toolDiffAdded"), "\u001b[38;2;137;184;194m");
});

test("取色：首选槽位不存在时按兜底顺序退到 selectedBg → toolDiffAdded，全没有则 undefined", () => {
	const noAccent = {
		getFgAnsi: (name: string) => {
			if (name === "toolDiffAdded") return "\u001b[38;2;1;2;3m";
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(noAccent), "\u001b[38;2;1;2;3m", "accent / selectedBg 都缺失 → toolDiffAdded");

	// 旧皮肤常见：只有 selectedBg、没有 accent —— 应落到 selectedBg 的 38 转换上
	const legacy = {
		getFgAnsi: (name: string) => {
			throw new Error("no");
		},
		getBgAnsi: (name: string) => {
			if (name === "selectedBg") return "\u001b[48;2;45;44;93m";
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(legacy), "\u001b[38;2;45;44;93m", "accent 缺失 → selectedBg");

	const empty = {
		getFgAnsi: () => {
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(empty), undefined);
	assert.equal(resolveBarAnsi(undefined), undefined);
});

test("补丁：只包一层，重复安装只换取色源", () => {
	let renderCalls = 0;
	class Fake {
		render(width: number): string[] {
			renderCalls += 1;
			return [`${BG} body${" ".repeat(Math.max(0, width - 5))}${BG_RESET}`];
		}
	}

	const first = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(first, true);

	const second = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;4;5;6m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(second, false, "第二次不该再包一层");

	const lines = new Fake().render(10);
	assert.equal(renderCalls, 1, "原始 render 只被调用一次");
	assert.equal(lines.length, 1);
	assert.equal(plain(lines[0]), "| body    ", "只加一条竖线（+ 一格缩进），且换成了新的取色源");
	assert.equal(lines[0].includes("\u001b[38;2;4;5;6m"), true, "取色源已更新");
});

test("补丁：取色源拿不到颜色时原样返回（不抛、不加）", () => {
	class Fake {
		render(): string[] {
			return [`${BG} body${BG_RESET}`];
		}
	}
	installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => undefined,
		glyph: "|",
	});
	assert.deepEqual(new Fake().render(), [`${BG} body${BG_RESET}`]);
});

test("补丁：原型没有 render 时什么都不做", () => {
	class Weird {}
	const installed = installUserMessageBar({
		UserMessageComponent: Weird as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
	});
	assert.equal(installed, false);
});

/* ==========================================================================
 * 发送时间抬头（You • 13:33）
 * ========================================================================== */

const KEYWORD_FG = "\u001b[38;2;157;121;214m"; // #9d79d6 = nightfox 的 syntaxKeyword
const ACCENT_FG = "\u001b[38;2;134;171;220m"; // #86abdc = nightfox 的 accent
const DIM_FG = "\u001b[38;2;109;109;109m"; // #6d6d6d = nightfox 的 dim
/** 抬头的第一段底色 = `syntaxKeyword` 再压暗 40%：`#9d79d6` 三通道各 × 0.6 → `#5e4980`。 */
const HEAD_BG_SRC = "\u001b[48;2;157;121;214m";
const HEAD_BG = "\u001b[48;2;94;73;128m";
/**
 * 第二段两个竖线字形的前景：`text` 全暗（压暗 100% → 三通道归零）。
 * 行首那个引导符不压暗（用户 2026-10-23 定），它直接用 `FG`。
 */
const GLYPH_FG = "\u001b[38;2;0;0;0m";
/** 抬头的第二段底色 = `thinkingText`（nightfox 里 = `comment` = `#6d6d6d`）再压暗 30% → `#4c4c4c`。 */
const THOUGHT_BG_SRC = "\u001b[48;2;109;109;109m";
const THOUGHT_BG_SEQ = "\u001b[48;2;76;76;76m";

/** 真实皮肤的最小替身：抬头那几个槽位 + `text`（竖线兜底槽）；`userMessageBg` 给了才铺底色。 */
function headerTheme(overrides: Record<string, string | undefined> = {}): {
	getFgAnsi(name: string): string;
	getBgAnsi(name: string): string;
} {
	const colors: Record<string, string | undefined> = {
		syntaxKeyword: KEYWORD_FG,
		accent: ACCENT_FG,
		dim: DIM_FG,
		muted: DIM_FG,
		text: FG,
		thinkingText: DIM_FG,
		...overrides,
	};
	return {
		getFgAnsi(name: string): string {
			const ansi = colors[name];
			if (ansi === undefined) throw new Error(`Unknown theme color: ${name}`);
			return ansi;
		},
		getBgAnsi(name: string): string {
			const ansi = name === "userMessageBg" ? colors.userMessageBg : undefined;
			if (ansi === undefined) throw new Error(`Unknown theme background color: ${name}`);
			return ansi;
		},
	};
}

/** 本地时间 → 毫秒：断言与运行机器的时区无关。 */
const localTime = (hour: number, minute: number): number => new Date(2026, 9, 19, hour, minute, 7).getTime();

test("formatClock：毫秒 / ISO 串都按本地时间输出 HH:MM，非法值返回 undefined", () => {
	assert.equal(formatClock(localTime(13, 33)), "13:33");
	assert.equal(formatClock(localTime(0, 5)), "00:05");
	assert.equal(formatClock(new Date(localTime(9, 7)).toISOString()), "09:07");
	assert.equal(formatClock(undefined), undefined);
	assert.equal(formatClock(""), undefined);
	assert.equal(formatClock("not a date"), undefined);
	assert.equal(formatClock(Number.NaN), undefined);
});

test("buildHeaderLine：`▏You HH:MM #N ` 铺 mdKeyword（压暗 40%）底，文字走 fg、You 加粗、行首竖线不压暗", () => {
	const line = buildHeaderLine(headerTheme(), "13:33", 46);
	assert.ok(line);
	assert.equal(plain(line), "▏You 13:33 ", "第一段含前面那个引导符与尾随那一格");
	assert.equal(
		line,
		`${FG}${HEAD_BG}\u001b[1m▏You\u001b[22m 13:33 \u001b[49m\u001b[39m`,
		"一整块：行首引导符不压暗（就是 fg），You 与它同在一段加粗里，底是压暗的 mdKeyword",
	);
	assert.equal(line.includes(KEYWORD_FG), false, "引导符不是另一个色系，是 fg 压暗");
	assert.equal(line.includes("\u001b[22;39m"), false, "不再用 dim 的 22/39 收尾（字块自己收底）");
});

const LEAD = "\u001b[38;2;109;109;109m"; // #6d6d6d，nightfox 的 dim

/** 每通道乘 `1 - amount` 再四舍五入：109 × 0.8 = 87.2 → 87。 */
test("darkenAnsiForeground：truecolor 前景按比例压暗（只动这个色值，序列形状不变）", () => {
	assert.equal(darkenAnsiForeground(LEAD, 0.2), "\u001b[38;2;87;87;87m");
	assert.equal(darkenAnsiForeground("\u001b[38;2;200;100;50m", 0.2), "\u001b[38;2;160;80;40m");
	assert.equal(darkenAnsiForeground("\u001b[38;2;255;255;255m", 0.5), "\u001b[38;2;128;128;128m", "四舍五入");
	assert.equal(darkenAnsiForeground("\u001b[38;2;0;0;0m", 0.2), "\u001b[38;2;0;0;0m", "黑已经最暗");
	assert.equal(HEADER_BG_DARKEN, 0.4, "第一段底色的压暗比例是用户定的 40%");
	assert.equal(HEADER_THOUGHT_BG_DARKEN, 0.3, "第二段底色的压暗比例是用户定的 30%");
});

test("darkenAnsiBackground：背景序列同样按比例压暗，仍是 48 形态", () => {
	assert.equal(darkenAnsiBackground(HEAD_BG_SRC, 0.4), HEAD_BG);
	assert.equal(darkenAnsiBackground(THOUGHT_BG_SRC, 0.3), THOUGHT_BG_SEQ);
	assert.equal(darkenAnsiBackground("\u001b[48;2;0;0;0m", 0.3), "\u001b[48;2;0;0;0m", "黑已经最暗");
	// 256 色背景：反算 RGB、压暗、量化回最近的 256 索引
	assert.equal(darkenAnsiBackground("\u001b[48;5;242m", 0.2), "\u001b[48;5;240m");
	// 前景序列不归它管
	assert.equal(darkenAnsiBackground(LEAD, 0.2), LEAD);
	for (const amount of [0, -0.2, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(darkenAnsiBackground(HEAD_BG_SRC, amount), HEAD_BG_SRC, `amount=${amount}`);
	}
	// `amount = 1` 是合法的「全暗」：三通道归零（用户 2026-10-23 用这个把竖线画成黑色）
	assert.equal(darkenAnsiBackground(HEAD_BG_SRC, 1), "\u001b[48;2;0;0;0m");
});

test("darkenAnsiForeground：`dim` 槽位带的属性尾码原样保留（否则压暗会把 faint 抹掉）", () => {
	assert.equal(darkenAnsiForeground(`${LEAD}\u001b[2m`, 0.2), "\u001b[38;2;87;87;87m\u001b[2m");
});

test("darkenAnsiForeground：256 色前景按 xterm 调色板反算再量化回去，不冒 truecolor 序列", () => {
	// 242 = 灰阶 #6c6c6c：压暗 20% ≈ #565656 → 最接近的灰阶是 240（#585858）
	assert.equal(darkenAnsiForeground("\u001b[38;5;242m", 0.2), "\u001b[38;5;240m");
	// 立方体 17（#00005f）压暗后仍是立方体里最近的那个，不变成 truecolor
	const cube = darkenAnsiForeground("\u001b[38;5;17m", 0.2);
	assert.match(cube, /^\u001b\[38;5;\d+m$/, "仍是 256 色形态");
});

test("darkenAnsiForeground：基本 16 色、非前景序列、非法比例都原样返回（不猜）", () => {
	// 基本 16 色的实际色值由终端自己定，按标称值换算会换掉色系
	assert.equal(darkenAnsiForeground("\u001b[38;5;8m", 0.2), "\u001b[38;5;8m");
	assert.equal(darkenAnsiForeground("\u001b[38;5;15m", 0.2), "\u001b[38;5;15m");
	// 背景槽（48）、复位（39）、空串：不是前景色就不碰
	assert.equal(darkenAnsiForeground("\u001b[48;2;109;109;109m", 0.2), "\u001b[48;2;109;109;109m");
	assert.equal(darkenAnsiForeground("\u001b[39m", 0.2), "\u001b[39m");
	assert.equal(darkenAnsiForeground("", 0.2), "");
	// 首尾相接但参数个数不认识的，不猜
	assert.equal(darkenAnsiForeground("\u001b[38;2;1;2m", 0.2), "\u001b[38;2;1;2m");
	// 比例为 0 / 1 / 非数字：不动
	for (const amount of [0, -0.2, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(darkenAnsiForeground(LEAD, amount), LEAD, `amount=${amount}`);
	}
	// `amount = 1` 是合法的「全暗」：三通道归零（左边界仍然不碰：`0` 表示不压暗）
	assert.equal(darkenAnsiForeground(LEAD, 1), "\u001b[38;2;0;0;0m");
	assert.equal(darkenAnsiForeground("\u001b[38;5;242m", 1), "\u001b[38;5;16m", "256 色量化到黑");
});

test("buildHeaderLine：槽位缺失时按兜底顺序退（syntaxKeyword → accent；thinkingText → dim）", () => {
	const line = buildHeaderLine(headerTheme({ syntaxKeyword: undefined, thinkingText: undefined }), "13:33", 46, 5, 2);
	assert.ok(line);
	assert.equal(line.includes("\u001b[48;2;80;103;132m"), true, "第一段底色是 accent 压暗 40%（134/171/220 × 0.6）");
	assert.equal(line.includes(`${FG}\u001b[48;2;80;103;132m`), true, "没有 syntaxKeyword 也不挡前景（文字始终是 fg）");
	// thinkingText 缺失 → 退到 dim（当前景槽取、转 48），**再**压暗 30%：109 × 0.7 → 76
	assert.equal(line.includes(`\u001b[48;2;109;109;109m`), false, "不会把未压暗的 dim 直接当底色");
	assert.equal(line.includes(THOUGHT_BG_SEQ), true, "第二段底色 = dim 再压暗 30%");
});

test("buildHeaderLine：没有皮肤时输出无色的同一行，尾随空格吃掉", () => {
	assert.equal(buildHeaderLine(undefined, "13:33", 46), "▏You 13:33");
	assert.equal(buildHeaderLine(undefined, "13:33", 46, 5, 2), "▏You 13:33 #5 ▏2 compactions▕");
});

const USER_BG = "\u001b[48;2;36;36;36m"; // #242424 = nightfox 的消息底色

/** 行里所有背景序列。 */
const bgSequences = (line: string): string[] => line.match(/\u001b\[48;[25];[0-9;]+m/g) ?? [];

test("buildHeaderLine：底色只铺两段文字（不按消息底色、不铺整行）", () => {
	// 皮肤里有消息底色也一样无关：抬头只用自己那两个槽
	const theme = headerTheme({ userMessageBg: USER_BG });
	const line = buildHeaderLine(theme, "13:33", 80, 5, 2) ?? "";
	assert.deepEqual(bgSequences(line), [HEAD_BG, THOUGHT_BG_SEQ], "只有两块：压暗的 mdKeyword + Think 色");
	assert.equal(plain(line), "▏You 13:33 #5 ▏2 compactions▕", "第二段两头各一个竖线字形（`▏` … `▕`）");

	// 换肤同样与抬头无关：消息底色槽怎么变都不影响这一行
	const other = buildHeaderLine(headerTheme({ userMessageBg: "\u001b[48;2;8;8;8m" }), "13:33", 80, 5, 2);
	assert.equal(other, line);
});

test("buildHeaderLine：按宽度截断，绝不撑宽（pi-tui 超宽会崩）", () => {
	const theme = headerTheme();
	const clipped = (width: number): string => plain(buildHeaderLine(theme, "13:33", width) ?? "");
	// `▏You 13:33 ` 共 11 列（含尾随那格；拿得下才走字块，否则按码点截）
	assert.equal(clipped(46), "▏You 13:33 ");
	assert.equal(clipped(11), "▏You 13:33 ");
	assert.equal(clipped(10), "▏You 13:33", "少一格：裸字时丢掉行尾空格");
	assert.equal(clipped(8), "▏You 13:");
	assert.equal(clipped(6), "▏You 1");
	assert.equal(clipped(5), "▏You ");
	assert.equal(clipped(4), "▏You");
	assert.equal(clipped(2), "▏Y");
	assert.equal(clipped(1), "▏");
	assert.equal(buildHeaderLine(theme, "13:33", 0), undefined);
	assert.equal(buildHeaderLine(theme, "13:33", -3), undefined);
	assert.equal(buildHeaderLine(theme, undefined, 46), undefined);
});

test("buildHeaderLine：轮次号在时间后面，放不下就整段丢掉（连它前面那格）", () => {
	const line = buildHeaderLine(headerTheme(), "13:33", 46, 12);
	assert.ok(line);
	assert.equal(plain(line), "▏You 13:33 #12 ");
	assert.equal(
		line.includes(`${FG}${HEAD_BG}\u001b[1m▏You\u001b[22m 13:33 #12 \u001b[49m\u001b[39m`),
		true,
		"引导符、You、时间、轮次号在同一个底色块里",
	);
	// 完整 15 列；窄了就整段丢号（不截出 `#1` 假号）
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 15, 12) ?? ""), "▏You 13:33 #12 ");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 14, 12) ?? ""), "▏You 13:33 ");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 12, 12) ?? ""), "▏You 13:33 ");
});

test("buildHeaderLine：第二段是 `▏N compactions▕`（两头竖线、前景 text、Think 底色），0 也画", () => {
	const zero = buildHeaderLine(headerTheme(), "13:33", 46, 5, 0);
	assert.ok(zero);
	assert.equal(plain(zero), "▏You 13:33 #5 ▏0 compactions▕", "`0` 左边是引导符，`compactions` 右边是它的镜像");
	// 三个竖线字形各自压暗 30%（全暗 → #000000），字块里其余字符仍是原样的 fg
	assert.equal(
		zero.endsWith(`${FG}${THOUGHT_BG_SEQ}${GLYPH_FG}▏${FG}0 compactions${GLYPH_FG}▕${FG}\u001b[49m\u001b[39m`),
		true,
		"第二段：竖线压暗、文字原色，底是 Think 色",
	);
	// 三档区分：行首引导符 = 正文色原样，第二段两个字形 = 全黑
	assert.equal(zero.startsWith(`${FG}${HEAD_BG}\u001b[1m▏You\u001b[22m`), true, "行首引导符不压暗（就是 fg）");
	assert.equal(zero.includes(`${GLYPH_FG}▏`), true, "第二段开头的引导符全黑");
	assert.equal(zero.includes(`${GLYPH_FG}▕`), true, "末尾的收尾符全黑");
	assert.equal(zero.split(`${GLYPH_FG}▏`).length - 1, 1, "行首那个没有跟着一起压暗");
	assert.equal(zero.includes(`${THOUGHT_BG_SEQ} `), false, "`0` 左边不再是一格空格");
	assert.equal(zero.includes("compactions "), false, "`compactions` 右边也不再是一格空格");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, 5, 1) ?? ""), "▏You 13:33 #5 ▏1 compactions▕");
	// 没有轮次号时也能单独跟时间（例如拿不到轮次的历史消息）
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, undefined, 2) ?? ""), "▏You 13:33 ▏2 compactions▕");
	// 查不到（undefined / 非有限数）= 不画第二段
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, 5) ?? ""), "▏You 13:33 #5 ");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, 5, Number.NaN) ?? ""), "▏You 13:33 #5 ");
});

test("buildHeaderLine：窄终端先丢压缩块、再丢轮次号，绝不截出假值", () => {
	const clipped = (width: number): string => plain(buildHeaderLine(headerTheme(), "13:33", width, 5, 12) ?? "");
	// 完整 30 列（`▏You 13:33 #5 ▏12 compactions `）
	assert.equal(clipped(30), "▏You 13:33 #5 ▏12 compactions▕");
	assert.equal(clipped(29), "▏You 13:33 #5 ", "少一格：压缩块整段丢掉，轮次号与时间照常");
	assert.equal(clipped(14), "▏You 13:33 #5 ");
	assert.equal(clipped(13), "▏You 13:33 ", "再窄就丢轮次号");
	assert.equal(clipped(8), "▏You 13:", "最后才截时间");
});

/* ==========================================================================
 * 抬头右端的会话时长（用户 2026-10-24 定：`+38m`，只上前景 dim、不铺底色、右对齐）
 * ========================================================================== */

/** 左段满配（`#5` + `0 compactions`）的可见文本：29 列。 */
const LEFT_0 = "▏You 13:33 #5 ▏0 compactions▕";

test("formatSessionAge：分钟以下→`+0m`、小时内→`+Nm`、超一小时→`+NhNm`", () => {
	assert.equal(formatSessionAge(0), "+0m");
	assert.equal(formatSessionAge(59_999), "+0m", "不足一分钟不报秒");
	assert.equal(formatSessionAge(60_000), "+1m");
	assert.equal(formatSessionAge(38 * 60_000 + 42_000), "+38m", "秒被丢掉，不是 38m42s");
	assert.equal(formatSessionAge(59 * 60_000), "+59m");
	assert.equal(formatSessionAge(60 * 60_000), "+1h0m", "跨过一小时保留分钟字段，位数不突变");
	assert.equal(formatSessionAge(2 * 3_600_000 + 35 * 60_000), "+2h35m");
	// 负值 / NaN / 未定义都当 0：时钟回拨不该画出 `+-3m`
	assert.equal(formatSessionAge(-1), "+0m");
	assert.equal(formatSessionAge(Number.NaN), "+0m");
	assert.equal(formatSessionAge(undefined), "+0m");
});

test("buildHeaderLine：时长右对齐贴到行尾，只上前景、不铺底色、不带竖线字形", () => {
	const line = buildHeaderLine(headerTheme(), "13:33", 40, 5, 0, 38 * 60_000) ?? "";
	assert.equal(plain(line), `${"▏You 13:33 #5 ▏0 compactions▕".padEnd(35)} +38m`, "左段不动，补齐到 width−5 列再写右段（右段自带前导空格）");
	assert.equal(Array.from(plain(line)).length, 40, "整行恰好 width 列（右对齐不靠终端截断）");
	// 右段只有 dim 前景 + 末尾 `22;39` 复位：无底色（真实皮肤的 `dim` 槽还会自带 SGR 2，
	// 所以复位必须带 `22` 否则行尾后面的东西一直是 faint）
	assert.equal(line.endsWith(`${DIM_FG} +38m\u001b[22;39m`), true, "dim 前导空格 + `+38m`");
	assert.equal(line.endsWith(`\u001b[49m`), false, "右段后面不收底（它没有底）");
});

test("buildHeaderLine：时长宽度不够就整段不画（绝不撑宽、也绝不夺走左段的信息）", () => {
	// 左段 `▏You 13:33 #5 ▏0 compactions▕` = 29 列；右段 ` +38m` = 5 列
	const exact = plain(buildHeaderLine(headerTheme(), "13:33", 34, 5, 0, 38 * 60_000) ?? "");
	assert.equal(exact, `${LEFT_0} +38m`, "恰好放下：中间一列补白都不剩，但两者分得开");
	const tight = plain(buildHeaderLine(headerTheme(), "13:33", 33, 5, 0, 38 * 60_000) ?? "");
	assert.equal(tight.trimEnd(), LEFT_0, "差一列：右段整段丢，压缩块与轮次号一格不少");
	assert.equal(tight.includes("+38m"), false);
	// 窄终端也不会因为右段而丢左段：布局选择仍然只看左边两块
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 14, 5, 0, 38 * 60_000) ?? "").trimEnd(), "▏You 13:33 #5");
});

test("buildHeaderLine：没有 dim 槽位 / 没有 age / 没有皮肤时右段都不画，且不抛", () => {
	// 拿不到 `dim`：不画（拿 `text` 顶上会让它和字块里的正文同色，抢戏）
	const noDim = buildHeaderLine(headerTheme({ dim: undefined }), "13:33", 40, 5, 0, 38 * 60_000) ?? "";
	assert.equal(noDim.includes("+38m"), false);
	// age 缺失：与旧行为逐字节一致（没有右段、也没有行尾补白）
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 40, 5, 0) ?? ""), "▏You 13:33 #5 ▏0 compactions▕");
	// 没有皮肤：左段仍是元色的纯文本，右段不画（没有 dim 就没有色）
	assert.equal(plain(buildHeaderLine(undefined, "13:33", 40, 5, 0, 38 * 60_000) ?? ""), "▏You 13:33 #5 ▏0 compactions▕");
});

test("messageAge：第一次问就定死，同一个消息对象之后永远返回同一个值", () => {
	class Component extends FakeUserMessage {
		override render(width: number): string[] {
			const pad = Math.max(0, width - this.text.length - 2);
			return [`${ZONE}${BG} ${FG}${this.text}${FG_RESET}${" ".repeat(pad)}${BG_RESET}`];
		}
	}
	class Mode extends FakeInteractiveMode {
		override addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
			this.chatContainer.addChild(new Component(message.content ?? ""));
		}
	}

	try {
		setAgeLookup(undefined);
		installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: Component });

		let now = 42 * 60_000;
		setAgeLookup(() => now);

		const mode = new Mode();
		const first = { role: "user", content: "a", timestamp: localTime(13, 33) };
		mode.addMessageToChat(first);
		const component = mode.chatContainer.children[0] as Component;

		assert.equal(messageAge(component), 42 * 60_000);
		now = 99 * 60_000;
		assert.equal(messageAge(component), 42 * 60_000, "**冻结**：时钟走了也不重算（否则会改掉视口之上的历史行）");

		// 不同消息各自独立冻结
		mode.addMessageToChat({ role: "user", content: "b", timestamp: localTime(13, 34) });
		assert.equal(
			messageAge(mode.chatContainer.children[1] as object),
			99 * 60_000,
			"另一条消息按它自己第一次问到的值",
		);

		setAgeLookup(() => {
			throw new Error("stale session");
		});
		mode.addMessageToChat({ role: "user", content: "c", timestamp: localTime(13, 35) });
		assert.equal(messageAge(mode.chatContainer.children[2] as object), undefined, "异常不带进渲染 tick");

		setAgeLookup(() => Number.NaN);
		mode.addMessageToChat({ role: "user", content: "d", timestamp: localTime(13, 36) });
		assert.equal(messageAge(mode.chatContainer.children[3] as object), undefined, "非数当不知道");

		setAgeLookup(undefined);
		mode.addMessageToChat({ role: "user", content: "e", timestamp: localTime(13, 37) });
		assert.equal(messageAge(mode.chatContainer.children[4] as object), undefined, "没装查询函数时也不画");
	} finally {
		setAgeLookup(undefined);
	}
});

/** 假 `UserMessageComponent`：只有 render（真组件的形状与本测试无关）。 */
class FakeUserMessage {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		const pad = Math.max(0, width - this.text.length - 2);
		return [`${BG} ${FG}${this.text}${FG_RESET}${" ".repeat(pad)}${BG_RESET}`];
	}
}

/** 假 `InteractiveMode`：一个能 addChild 的容器 + 默认的 addMessageToChat。 */
class FakeInteractiveMode {
	chatContainer: { children: unknown[]; addChild(child: unknown): void } = {
		children: [],
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
		if (message.role === "user") this.chatContainer.addChild(new FakeUserMessage(message.content ?? ""));
	}
}

test("打时间戳：本次新增的用户消息组件带上 HH:MM，其他角色 / 没有时间戳的不动", () => {
	class Mode extends FakeInteractiveMode {}
	assert.equal(
		installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: FakeUserMessage }),
		true,
	);

	const mode = new Mode();
	mode.addMessageToChat({ role: "user", content: "hi", timestamp: localTime(13, 33) });
	assert.equal(messageClock(mode.chatContainer.children[0] as object), "13:33");

	mode.addMessageToChat({ role: "assistant", content: "yo", timestamp: localTime(13, 34) });
	assert.equal(messageClock(mode.chatContainer.children[0] as object), "13:33", "已有组件的戳不被覆盖");

	mode.addMessageToChat({ role: "user", content: "没有时间戳" });
	assert.equal(messageClock(mode.chatContainer.children[1] as object), undefined, "没有 timestamp 就不打戳");
});

test("打时间戳：重复安装不再包一层；装在已有补丁外层也能盖到自己 new 组件的消息", () => {
	// 模拟 skill-invocation-reorder：自己 new UserMessageComponent，不调用原函数
	class SkillReorderFirst extends FakeInteractiveMode {
		override addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
			this.chatContainer.addChild(new FakeUserMessage(message.content ?? ""));
		}
	}

	assert.equal(
		installUserMessageTimestamp({ InteractiveMode: SkillReorderFirst, UserMessageComponent: FakeUserMessage }),
		true,
	);
	assert.equal(
		installUserMessageTimestamp({ InteractiveMode: SkillReorderFirst, UserMessageComponent: FakeUserMessage }),
		false,
		"第二次不该再包一层",
	);

	const mode = new SkillReorderFirst();
	mode.addMessageToChat({ role: "user", content: "/skill:commit 提交", timestamp: localTime(8, 5) });
	assert.equal(messageClock(mode.chatContainer.children[0] as object), "08:05");
});

test("轮次号：每条用户消息 +1，重放沿用原号，重置后从 #1 重新数", () => {
	class Mode extends FakeInteractiveMode {}
	installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: FakeUserMessage });
	resetUserMessageTurns();

	const mode = new Mode();
	const first = { role: "user", content: "a", timestamp: localTime(10, 0) };
	const second = { role: "user", content: "b", timestamp: localTime(10, 1) };
	mode.addMessageToChat(first);
	mode.addMessageToChat(second);
	mode.addMessageToChat({ role: "assistant", content: "x" });
	assert.equal(messageTurn(mode.chatContainer.children[0] as object), 1);
	assert.equal(messageTurn(mode.chatContainer.children[1] as object), 2);

	// 重放 first（模拟重建历史）：号回拨到 1，其后的新消息接 2
	mode.addMessageToChat(first);
	assert.equal(messageTurn(mode.chatContainer.children[2] as object), 1, "重放沿用原编号");
	mode.addMessageToChat({ role: "user", content: "c", timestamp: localTime(10, 2) });
	assert.equal(messageTurn(mode.chatContainer.children[3] as object), 2);

	resetUserMessageTurns();
	mode.addMessageToChat({ role: "user", content: "d", timestamp: localTime(10, 3) });
	assert.equal(messageTurn(mode.chatContainer.children[4] as object), 1, "重置后从 #1 重新数");
});

test("打压缩次数：按消息查「发出时压缩过几次」，没装查询函数就不打", () => {
	class Mode extends FakeInteractiveMode {}
	installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: FakeUserMessage });

	const mode = new Mode();
	const first = { role: "user", content: "a", timestamp: localTime(10, 0) };
	const second = { role: "user", content: "b", timestamp: localTime(10, 1) };
	const counts = new Map<object, number>([
		[first, 0],
		[second, 1],
	]);
	setCompactionLookup((message) => counts.get(message));
	try {
		mode.addMessageToChat(first);
		mode.addMessageToChat(second);
		assert.equal(messageCompactions(mode.chatContainer.children[0] as object), 0, "0 次也要能查出来（抬头要画第二段 0 compactions）");
		assert.equal(messageCompactions(mode.chatContainer.children[1] as object), 1);
	} finally {
		setCompactionLookup(undefined);
	}
	// 查过的值缓存在消息对象上：查询函数摸掉了也还能用（会话替换窗口 / shutdown 后重画）
	assert.equal(messageCompactions(mode.chatContainer.children[0] as object), 0, "已查过的消息用缓存");

	mode.addMessageToChat({ role: "user", content: "c", timestamp: localTime(10, 2) });
	assert.equal(messageCompactions(mode.chatContainer.children[2] as object), undefined, "没装查询函数就不打（抬头少画这一段）");
});

test("打压缩次数：查询函数抛异常（旧会话作废）时当作不知道，不把异常带进渲染", () => {
	class Mode extends FakeInteractiveMode {}
	installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: FakeUserMessage });
	setCompactionLookup(() => {
		throw new Error("stale session");
	});
	try {
		const mode = new Mode();
		mode.addMessageToChat({ role: "user", content: "a", timestamp: localTime(10, 0) });
		assert.equal(messageCompactions(mode.chatContainer.children[0] as object), undefined);
	} finally {
		setCompactionLookup(undefined);
	}
});

test("抬头 + 竖线：header 在最上面，OSC 133 起点留在第一行最前，框内照常加竖线", () => {
	class Component extends FakeUserMessage {
		override render(width: number): string[] {
			const pad = Math.max(0, width - this.text.length - 2);
			return [`${ZONE}${BG} ${FG}${this.text}${FG_RESET}${" ".repeat(pad)}${BG_RESET}`];
		}
	}
	class Mode extends FakeInteractiveMode {
		override addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
			this.chatContainer.addChild(new Component(message.content ?? ""));
		}
	}

	installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: Component });
	installUserMessageBar({ UserMessageComponent: Component, theme: () => headerTheme(), glyph: "|" });
	resetUserMessageTurns();
	setCompactionLookup(undefined);

	const mode = new Mode();
	mode.addMessageToChat({ role: "user", content: "正文", timestamp: localTime(13, 33) });
	const lines = (mode.chatContainer.children[0] as Component).render(20);

	assert.equal(lines.length, 2, "抬头 + 框内那一行");
	assert.equal(lines[0]?.startsWith(ZONE), true, "zone 起点挪到抬头行最前");
	assert.equal(plain(lines[0] ?? "").trimEnd(), "▏You 13:33 #1");
	assert.ok(lines[0]?.includes(HEAD_BG), true, "抬头第一段铺了压暗 40% 的 mdKeyword 底");
	assert.equal(plain(lines[1] ?? "").startsWith("| "), true, "框内那行照常有竖线 + 缩进");
	assert.equal(lines[1]?.includes(`${ACCENT_FG}|`) ?? false, true, "竖线颜色是 accent");
});

test("抬头里的压缩次数：装上查询函数后 `▏You 13:33 #1 ▏2 compactions▕`，竖线照常", () => {
	class Component extends FakeUserMessage {
		override render(width: number): string[] {
			const pad = Math.max(0, width - this.text.length - 2);
			return [`${ZONE}${BG} ${FG}${this.text}${FG_RESET}${" ".repeat(pad)}${BG_RESET}`];
		}
	}
	class Mode extends FakeInteractiveMode {
		override addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
			this.chatContainer.addChild(new Component(message.content ?? ""));
		}
	}

	installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: Component });
	installUserMessageBar({ UserMessageComponent: Component, theme: () => headerTheme(), glyph: "|" });
	resetUserMessageTurns();
	setCompactionLookup(() => 2);
	try {
		const mode = new Mode();
		mode.addMessageToChat({ role: "user", content: "正文", timestamp: localTime(13, 33) });
		const lines = (mode.chatContainer.children[0] as Component).render(46);
		assert.equal(plain(lines[0] ?? "").trimEnd(), "▏You 13:33 #1 ▏2 compactions▕");
		assert.ok(lines[0]?.includes(THOUGHT_BG_SEQ), true, "第二段铺压暗 30% 的 Think 底色");
		assert.equal(plain(lines[1] ?? "").startsWith("| "), true, "竖线不受影响");
	} finally {
		setCompactionLookup(undefined);
	}
});

/**
 * 会话替换（`/resume` / `/new` / `/fork`）走 `rebindCurrentSession({ renderBeforeBind: true })`：
 * pi **先重画历史、再发 `session_start`**，所以历史组件是在查询函数装上前创建的。压缩次数必须
 * 在渲染时现查而不是打戳时快照，否则这整屏历史永远没有这一段（2026-10-19 实测读 pi 源码发现）。
 */
test("压缩次数在渲染时现查：先建组件、后装查询函数，下一帧也能补上", () => {
	class Component extends FakeUserMessage {
		override render(width: number): string[] {
			const pad = Math.max(0, width - this.text.length - 2);
			return [`${ZONE}${BG} ${FG}${this.text}${FG_RESET}${" ".repeat(pad)}${BG_RESET}`];
		}
	}
	class Mode extends FakeInteractiveMode {
		override addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
			this.chatContainer.addChild(new Component(message.content ?? ""));
		}
	}

	installUserMessageTimestamp({ InteractiveMode: Mode, UserMessageComponent: Component });
	installUserMessageBar({ UserMessageComponent: Component, theme: () => headerTheme(), glyph: "|" });
	resetUserMessageTurns();
	setCompactionLookup(undefined);

	const mode = new Mode();
	mode.addMessageToChat({ role: "user", content: "正文", timestamp: localTime(13, 33) });
	const component = mode.chatContainer.children[0] as Component;
	assert.equal(plain(component.render(46)[0] ?? "").trimEnd(), "▏You 13:33 #1", "查询函数还没装上：先不画那一段");

	setCompactionLookup(() => 3);
	try {
		const lines = component.render(46);
		assert.equal(plain(lines[0] ?? "").trimEnd(), "▏You 13:33 #1 ▏3 compactions▕", "下一帧查到了就补上");
		assert.equal(plain(lines[1] ?? "").startsWith("| "), true, "竖线照常");
	} finally {
		setCompactionLookup(undefined);
	}
});
