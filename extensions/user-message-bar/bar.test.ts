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
	formatClock,
	headerBackground,
	installUserMessageBar,
	installUserMessageTimestamp,
	messageClock,
	messageCompactions,
	messageTurn,
	resetUserMessageTurns,
	resolveBarAnsi,
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

/** 真实皮肤的最小替身：抬头三个槽位 + `text`（竖线兜底槽）；`userMessageBg` 给了才铺底色。 */
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

test("buildHeaderLine：引导符 ▏ dim、You 加粗 + syntaxKeyword、时间 dim", () => {
	const line = buildHeaderLine(headerTheme(), "13:33", 46);
	assert.ok(line);
	assert.equal(
		line,
		`${DIM_FG}\u258F\u001b[22;39m${KEYWORD_FG}\u001b[1mYou\u001b[22m\u001b[39m${DIM_FG} 13:33\u001b[22;39m`,
	);
	assert.equal(plain(line), "▏You 13:33", "顶格：引导符后不空，You 与时间之间空一格");
});

test("buildHeaderLine：槽位缺失时按兜底顺序退（syntaxKeyword → accent；dim → muted）", () => {
	const line = buildHeaderLine(headerTheme({ syntaxKeyword: undefined, dim: undefined }), "13:33", 46);
	assert.ok(line);
	assert.equal(line.startsWith(`${DIM_FG}\u258F`), true, "引导符是 dim（dim 缺失时退到 muted）");
	assert.equal(line.includes(`${ACCENT_FG}\u001b[1mYou`), true, "没有 syntaxKeyword 就用 accent");
	assert.equal(line.endsWith(` 13:33\u001b[22;39m`), true, "dim 缺失退到 muted");
});

test("buildHeaderLine：没有皮肤时输出无色的同一行（时间仍然有用）", () => {
	assert.equal(buildHeaderLine(undefined, "13:33", 46), "▏You 13:33");
});

const USER_BG = "\u001b[48;2;36;36;36m"; // #242424 = nightfox 的消息底色
const USER_BG_DARK = "\u001b[48;2;27;27;27m"; // ×0.75 → #1b1b1b

/** 行里所有背景序列（抬头是逐格上底色）。 */
const bgSequences = (line: string): string[] => line.match(/\u001b\[48;[25];[0-9;]+m/g) ?? [];

test("buildHeaderLine：抬头底色渐变 = 文字格数 + 20，碰到右边界就截断", () => {
	const theme = headerTheme({ userMessageBg: USER_BG });
	const line = buildHeaderLine(theme, "13:33", 40);
	assert.ok(line);
	assert.equal(plain(line), "▏You 13:33".padEnd(40), "整行铺满 width");
	assert.equal(line.endsWith("\u001b[49m"), true, "行尾 49m 收掉底色，不溢到下一行");
	assert.equal(line.split("\u001b[49m").length - 1, 1, "只多出这一个关背景");

	const bgs = bgSequences(line);
	// 文字 10 格 + 尾巴 20 格，再往右那一段是背景色
	assert.equal(bgs.length, 31, "10 文字格 + 20 尾巴 + 1 段行尾背景");
	assert.equal(bgs[0], USER_BG_DARK, "左端 = 消息底色 ×0.75");
	assert.notEqual(bgs[9], "\u001b[48;2;0;0;0m", "最后一个字符还没到背景黑（尾巴还没走完）");
	assert.equal(bgs[29], "\u001b[48;2;0;0;0m", "第 30 格（文字 + 20）正好落到背景黑");
	assert.equal(bgs[30], "\u001b[48;2;0;0;0m", "再往右一直是背景色");
	// 同一条直线插值：#1b1b1b → #000000，跨度 30 格
	assert.deepEqual(
		bgs.slice(0, 30).map((bg) => Number(bg.split(";")[2])),
		[27, 26, 25, 24, 23, 22, 21, 20, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 7, 6, 5, 4, 3, 2, 1, 0],
	);

	// 碰到右边界：宽 20 时 10 + 20 已超过行宽，渐变正好铺满整行
	const clamped = bgSequences(buildHeaderLine(theme, "13:33", 20) ?? "");
	assert.equal(clamped.length, 20, "渐变正好铺满整行");
	assert.equal(clamped.at(-1), "\u001b[48;2;0;0;0m");

	// 更窄：文字被截到 8 格，8 + 20 > 8，仍以边界为准；只剩一格时停在起点
	const narrow = bgSequences(buildHeaderLine(theme, "13:33", 8) ?? "");
	assert.equal(narrow.length, 8);
	assert.equal(plain(buildHeaderLine(theme, "13:33", 8) ?? "").length, 8);
	assert.equal(bgSequences(buildHeaderLine(theme, "13:33", 1) ?? "")[0], USER_BG_DARK);
});

test("buildHeaderLine：256 色皮肤下渐变落回 256 色号（不硬塞 48;2）", () => {
	const line = buildHeaderLine(headerTheme({ userMessageBg: "\u001b[48;5;236m" }), "13:33", 12);
	assert.ok(line);
	const bgs = bgSequences(line);
	// 236 = #303030 → ×0.75 = #242424 → 最近的 235（#262626）；终点背景黑 = 16
	assert.equal(bgs[0], "\u001b[48;5;235m");
	assert.equal(bgs.length, 12, "宽 12：文字 10 + 尾巴 20 碰到边界 → 渐变铺满整行");
	assert.equal(bgs.at(-1), "\u001b[48;5;16m", "最后一格落到背景黑");
	assert.equal(bgs.every((bg) => bg.startsWith("\u001b[48;5;")), true, "全程留在 256 色模式");
});

test("buildHeaderLine：底色槽缺失或落在 0..15 系统色时不铺底色（与加底色之前逐字一致）", () => {
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46) ?? ""), "▏You 13:33");
	assert.equal(
		plain(buildHeaderLine(headerTheme({ userMessageBg: "\u001b[48;5;4m" }), "13:33", 46) ?? ""),
		"▏You 13:33",
	);
});

test("buildHeaderLine：换肤后渐变跟着换（缓存按消息底色 ANSI + 格数区分）", () => {
	const first = buildHeaderLine(headerTheme({ userMessageBg: USER_BG }), "13:33", 12);
	const second = buildHeaderLine(headerTheme({ userMessageBg: "\u001b[48;2;8;8;8m" }), "13:33", 12);
	assert.equal(bgSequences(first ?? "")[0], USER_BG_DARK);
	assert.equal(bgSequences(second ?? "")[0], "\u001b[48;2;6;6;6m");
	assert.equal(bgSequences(second ?? "").at(-1), "\u001b[48;2;0;0;0m");
});

test("headerBackground：黑色保持黑色，缺皮肤 / 默认底色（49m）/ 零格一律不给底色", () => {
	const black = headerBackground(headerTheme({ userMessageBg: "\u001b[48;5;16m" }), 3);
	assert.ok(black);
	assert.deepEqual(black.cells, ["\u001b[48;5;16m", "\u001b[48;5;16m", "\u001b[48;5;16m"]);
	assert.equal(black.end, "\u001b[48;5;16m");
	assert.equal(headerBackground(headerTheme({ userMessageBg: "\u001b[49m" }), 3), undefined);
	assert.equal(headerBackground(undefined, 3), undefined);
	assert.equal(headerBackground(headerTheme({ userMessageBg: USER_BG }), 0), undefined);
});

test("buildHeaderLine：按宽度截断，绝不撑宽（pi-tui 超宽会崩）", () => {
	const theme = headerTheme();
	const clipped = (width: number): string => plain(buildHeaderLine(theme, "13:33", width) ?? "");
	assert.equal(clipped(46), "▏You 13:33");
	assert.equal(clipped(10), "▏You 13:33");
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

test("buildHeaderLine：轮次号以 ` #N` 跟在时间后面，放不下就整段丢掉", () => {
	const line = buildHeaderLine(headerTheme(), "13:33", 46, 12);
	assert.ok(line);
	assert.equal(
		line,
		`${DIM_FG}\u258F\u001b[22;39m${KEYWORD_FG}\u001b[1mYou\u001b[22m\u001b[39m${DIM_FG} 13:33 #12\u001b[22;39m`,
	);
	assert.equal(plain(line), "▏You 13:33 #12");
	// 完整 14 列；13 列时轮次号整段丢掉（不截出 `#1` 假号），时间照常
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 14, 12) ?? ""), "▏You 13:33 #12");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 13, 12) ?? ""), "▏You 13:33");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 11, 12) ?? ""), "▏You 13:33");
});

test("buildHeaderLine：压缩次数以 ` · N compactions` 跟在轮次号后（0 也画，整段走 dim）", () => {
	const zero = buildHeaderLine(headerTheme(), "13:33", 46, 5, 0);
	assert.ok(zero);
	assert.equal(plain(zero), "▏You 13:33 #5 · 0 compactions");
	assert.equal(zero.endsWith(`${DIM_FG} 13:33 #5 · 0 compactions\u001b[22;39m`), true, "时间 / 轮次号 / 压缩段同一个 dim 段");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, 5, 1) ?? ""), "▏You 13:33 #5 · 1 compactions");
	// 没有轮次号时也能单独跟时间（例如拿不到轮次的历史消息）
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, undefined, 2) ?? ""), "▏You 13:33 · 2 compactions");
	// 查不到（undefined / 非有限数）= 不画这一段，与改之前逐字一致
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, 5) ?? ""), "▏You 13:33 #5");
	assert.equal(plain(buildHeaderLine(headerTheme(), "13:33", 46, 5, Number.NaN) ?? ""), "▏You 13:33 #5");
});

test("buildHeaderLine：窄终端先丢压缩段、再丢轮次号，绝不截出假值", () => {
	const clipped = (width: number): string => plain(buildHeaderLine(headerTheme(), "13:33", width, 5, 12) ?? "");
	// 完整 30 列（`▏You 13:33 #5 · 12 compactions`）
	assert.equal(clipped(30), "▏You 13:33 #5 · 12 compactions");
	assert.equal(clipped(29), "▏You 13:33 #5", "少一格：压缩段整段丢掉，轮次号与时间照常");
	assert.equal(clipped(14), "▏You 13:33 #5");
	assert.equal(clipped(12), "▏You 13:33", "再窄就丢轮次号");
	assert.equal(clipped(8), "▏You 13:", "最后才截时间");
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
		assert.equal(messageCompactions(mode.chatContainer.children[0] as object), 0, "0 次也要能查出来（抬头要画 · 0 compactions）");
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
	assert.equal(plain(lines[0] ?? ""), "▏You 13:33 #1");
	assert.equal(plain(lines[1] ?? "").startsWith("| "), true, "框内那行照常有竖线 + 缩进");
	assert.equal(lines[1]?.includes(`${ACCENT_FG}|`) ?? false, true, "竖线颜色是 accent");
});

test("抬头里的压缩次数：装上查询函数后 `▏You 13:33 #1 · 2 compactions`，竖线照常", () => {
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
		assert.equal(plain(lines[0] ?? ""), "▏You 13:33 #1 · 2 compactions");
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
	assert.equal(plain(component.render(46)[0] ?? ""), "▏You 13:33 #1", "查询函数还没装上：先不画那一段");

	setCompactionLookup(() => 3);
	try {
		const lines = component.render(46);
		assert.equal(plain(lines[0] ?? ""), "▏You 13:33 #1 · 3 compactions", "下一帧查到了就补上");
		assert.equal(plain(lines[1] ?? "").startsWith("| "), true, "竖线照常");
	} finally {
		setCompactionLookup(undefined);
	}
});
