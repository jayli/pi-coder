import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MARK_BLANK,
	MARK_CELL,
	MARK_COLS,
	MARK_GLYPH_WIDTH,
	MARK_INDENT,
	MARK_ROWS,
	MARK_WIDTH,
	attachSideText,
	composeHeaderLines,
	formatTitleLine,
	markCellFilled,
	markLines,
	poweredByLines,
	shortenPath,
} from "./logo.ts";

/** 去掉 ANSI，只看几何。 */
const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

/** 恒等主题：剥掉 ANSI 后就是纯文本。 */
const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("印记是 4×4 格子，本体宽 12、左侧留白一格所以整行 13", () => {
	assert.equal(MARK_CELL, "███");
	assert.equal(MARK_BLANK, "   ");
	assert.equal(MARK_INDENT, " ");
	assert.equal(MARK_ROWS, 4);
	assert.equal(MARK_COLS, 4);
	assert.equal(MARK_GLYPH_WIDTH, 12);
	assert.equal(MARK_WIDTH, MARK_INDENT.length + MARK_GLYPH_WIDTH);
	assert.equal(MARK_WIDTH, 13);
});

test("markLines 的四行形状（含补回来的那一格）与左侧留白", () => {
	assert.deepEqual(markLines(), [
		" █████████   ", // 上横：三格实心
		" ███   ███   ", // 左竖 + 右腿上身
		" ██████   ███", // 左竖 + 内衬 + 右腿（上游落定帧漏掉的 (5,5)）
		" ███      ███", // 左竖 + 右腿脚
	]);
	for (const line of markLines()) {
		assert.ok(line.startsWith(MARK_INDENT), "每行都要顶一个空格，不能贴左边缘");
		assert.equal(line.length, MARK_WIDTH, "每行可见宽度必须一致，否则侧栏歪");
	}
});

test("markCellFilled 与格子表一致，越界当空格", () => {
	markLines().forEach((line, row) => {
		for (let col = 0; col < MARK_COLS; col++) {
			assert.equal(
				markCellFilled(row, col),
				line.slice(MARK_INDENT.length + col * 3, MARK_INDENT.length + col * 3 + 3) === MARK_CELL,
				`(${row},${col}) 取色与整行渲染不一致`,
			);
		}
	});
	assert.equal(markCellFilled(9, 9), false);
	assert.equal(markCellFilled(-1, 0), false);
});

test("右腿不是悬空的一只脚（回归：上游 phase 6 少了 (2,3) 那格）", () => {
	// 最后一行最右格实心 → 它上一行最右格也必须实心，否则腿断了
	assert.equal(markCellFilled(MARK_ROWS - 1, MARK_COLS - 1), true);
	assert.equal(markCellFilled(MARK_ROWS - 2, MARK_COLS - 1), true);
});

test("attachSideText：两条侧栏落在第 1、2 行，其余行原样等宽", () => {
	const out = attachSideText(markLines().map((l) => `[${l}]`), ["V", "C"]);
	assert.equal(out.length, MARK_ROWS);
	assert.equal(out[1], `[${markLines()[1]}]  V`);
	assert.equal(out[2], `[${markLines()[2]}]  C`);
	assert.equal(out[0], `[${markLines()[0]}]`);
	assert.equal(out[3], `[${markLines()[3]}]`);
});

test("attachSideText：ANSI 不参与列计算", () => {
	const colored = markLines().map((l) => `\x1b[38;2;121;214;193m${l}\x1b[39m`);
	const out = attachSideText(colored, ["A", "B"]);
	// 挂侧栏的行：剥掉 ANSI 后，侧栏前正好是整行宽度 + 2 空格
	for (const [i, text] of [
		[1, "A"],
		[2, "B"],
	] as const) {
		const stripped = plain(out[i]!);
		assert.equal(stripped, `${markLines()[i]}  ${text}`);
		assert.equal(stripped.indexOf(text), MARK_WIDTH + 2);
	}
	// 没挂侧栏的行仍是完整等宽
	assert.equal(plain(out[0]!), " █████████   ");
	assert.equal(plain(out[0]!).length, MARK_WIDTH);
});

test("attachSideText：侧栏为空 / 比行数多 / 行数为 0 都不炸", () => {
	const lines = markLines();
	assert.deepEqual(attachSideText(lines, []), [...lines]);
	assert.equal(attachSideText(lines, ["a", "b", "c", "d", "e"]).length, MARK_ROWS);
	assert.deepEqual(attachSideText([], ["a"]), []);
	// 空字符串那条不占位：只有一行被贴字，其余保持等宽
	const blanked = attachSideText(lines, ["", "only"]);
	assert.equal(blanked.filter((l) => l.endsWith("only")).length, 1);
	assert.equal(blanked.filter((l) => l.endsWith("only") && l !== blanked[blanked.findIndex((x) => x.endsWith("only"))]).length, 0);
});

test("每行可见宽度恒等于 MARK_WIDTH（挂不挂侧栏的行都等宽，侧栏列才不会歪）", () => {
	for (const line of markLines()) assert.equal(plain(line).length, MARK_WIDTH);
	for (const line of markLines((f) => (f ? `\x1b[31m${MARK_CELL}\x1b[39m` : MARK_BLANK))) {
		assert.equal(plain(line).length, MARK_WIDTH);
	}
});

test("composeHeaderLines：印记下方留一个空行，提示行与说明段之间不留空行（两段都缩进一格）", () => {
	// 印记段是「大 logo」，它下面那条空行必须保留（用户 2026-10-05 定）；要去掉的只是
	// 提示行与说明段之间那一条 —— 两处空行不是同一条规则。
	assert.deepEqual(composeHeaderLines({ logo: ["a", "b"], hints: "h", onboarding: ["o"] }), ["a", "b", "", " h", " o"]);
	assert.deepEqual(composeHeaderLines({ logo: ["a"], hints: "h" }), ["a", "", " h"]);
	assert.deepEqual(composeHeaderLines({ logo: ["a"], onboarding: ["o"] }), ["a", "", " o"]);
	// 没有印记段就没有那条空行（窄终端回退时印记段仍在，这条钉的是「不凭空留行」）
	assert.deepEqual(composeHeaderLines({ logo: [], hints: "h", onboarding: ["o"] }), [" h", " o"]);
	assert.deepEqual(composeHeaderLines({ logo: [] }), []);
	assert.deepEqual(composeHeaderLines({ logo: [], onboarding: ["o"] }), [" o"]);
	// 一句话说清：整份 header 里恰好一个空行，且紧跟在印记段最后一行之后
	const all = composeHeaderLines({ logo: markLines(), hints: "h", onboarding: ["o"] });
	assert.equal(all.filter((line) => line === "").length, 1, "空行只该有印记下方那一个");
	assert.equal(all[MARK_ROWS], "", "空行紧跟在印记最后一行之后");
	for (const line of all) {
		if (line === "") continue; // 空行本身就是空的，不适用「不顶格」
		assert.ok(line.startsWith(MARK_INDENT), `除了那条空行，每一行都不能顶格：${JSON.stringify(line)}`);
	}
});

test("poweredByLines：宽终端画三行 `@bachi/` + Pi-Coder 字形，窄终端退回整句", () => {
	// 三行字形的原始字节。原稿第 3 行是 14 列，这里补一个行尾空格让三行等宽 ——
	// 与印记行的 `MARK_BLANK` 同一个约定，行尾空白在终端里不可见。
	const ART = ["┏┓•  ┏┓   ┓    ", "┃┃┓━━┃ ┏┓┏┫┏┓┏┓", "┣┛┗  ┗┛┗┛┗┻┗ ┛ "];
	const PREFIX = "This pi harness is powered by latest @bachi/";
	const wide = poweredByLines(identityTheme, 200).map(plain);
	// 中间行是「整句 + 字形」，接缝处不补空格：`@bachi/` 的斜杠直接顶住字形的第一列
	assert.deepEqual(wide, [
		" ".repeat(PREFIX.length) + ART[0],
		PREFIX + ART[1],
		" ".repeat(PREFIX.length) + ART[2],
	]);
	for (const line of wide) assert.equal(line.length, PREFIX.length + 15, "三行必须等宽，否则字形会歪");
	// 窄终端：整块（含 `composeHeaderLines` 补的那一格缩进）装不下就退回整句
	assert.deepEqual(poweredByLines(identityTheme, 59).map(plain), [`${PREFIX}pi-coder.`]);
	assert.deepEqual(poweredByLines(identityTheme, 60).map(plain), wide);
});

test("poweredByLines：句子走 dim，字形走 accent", () => {
	const marked = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => text };
	const lead = " ".repeat("This pi harness is powered by latest @bachi/".length);
	const lines = poweredByLines(marked, 200);
	assert.equal(lines[1], `<dim>This pi harness is powered by latest @bachi/</><accent>┃┃┓━━┃ ┏┓┏┫┏┓┏┓</>`);
	assert.equal(lines[0], `${lead}<accent>┏┓•  ┏┓   ┓    </>`, "首行的引导空格不上色（不可见，且省几个转义）");
	assert.deepEqual(poweredByLines(marked, 59), [`<dim>This pi harness is powered by latest @bachi/pi-coder.</>`]);
});

test("formatTitleLine：版本号后面跟模型与推理档位", () => {
	assert.equal(
		formatTitleLine(identityTheme, "0.99.2", "deepseek-flash-qd", "max"),
		"pi v0.99.2 (deepseek-flash-qd with max effort)",
	);
	// 档位读不到（非推理模型 / stale ctx）时只剩模型
	assert.equal(formatTitleLine(identityTheme, "0.99.2", "deepseek-flash-qd", undefined), "pi v0.99.2 (deepseek-flash-qd)");
	// 模型读不到时整个括号都不出现
	assert.equal(formatTitleLine(identityTheme, "0.99.2", undefined, "max"), "pi v0.99.2");
	assert.equal(formatTitleLine(identityTheme, "0.99.2", undefined, undefined), "pi v0.99.2");
});

test("formatTitleLine：painted 主题下模型 / 档位各走自己的色槽（与 statusline 的模型段同色）", () => {
	const slots: string[] = [];
	const painted = {
		fg: (color: string, text: string) => {
			slots.push(color);
			return `\u001b[38;5;1m${text}\u001b[39m`;
		},
		bold: (text: string) => text,
	};
	const line = formatTitleLine(painted, "0.99.2", "qwen3.8-max", "xhigh");
	assert.ok(slots.includes("accent"), "模型 id 用 accent");
	assert.ok(slots.includes("syntaxFunction"), "档位用 syntaxFunction");
	// 剥掉 ANSI 后坐标不变：每一截都仍按顺序拼在一起
	assert.equal(
		plain(line),
		"pi v0.99.2 (qwen3.8-max with xhigh effort)",
	);
});

test("shortenPath：家目录内缩写，外面原样", () => {
	assert.equal(shortenPath("/Users/bachi", "/Users/bachi"), "~");
	assert.equal(shortenPath("/Users/bachi/jaylli/litellm-any", "/Users/bachi"), "~/jaylli/litellm-any");
	assert.equal(shortenPath("/tmp/x", "/Users/bachi"), "/tmp/x");
	// 同前缀但不同目录（/Users/bachix）不能被当成子路径缩写
	assert.equal(shortenPath("/Users/bachix", "/Users/bachi"), "/Users/bachix");
	assert.equal(shortenPath("/srv/app", undefined), "/srv/app");
});
