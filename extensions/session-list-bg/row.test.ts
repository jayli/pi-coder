/**
 * Tests for row.ts — 纯逻辑：把一条已着色的选中行换成另一种底色。
 *
 * Run with:  node --test clients/pi/extensions/session-list-bg/row.test.ts
 *
 * 这些用例的字节形状都来自 pi 真组件的输出（`dist/modes/interactive/components/session-selector.js`
 * 的 `SessionList.render` + pi-tui `utils.js` 的 `finalizeTruncatedResult`）：
 * 选中行 = `theme.bg("selectedBg", 整行)`，中间夹着 pi 截断时插的裸 `\x1b[0m`。
 * 这里手工构造等价形状，不需要真 TUI。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	CURRENT_SESSION_SLOT,
	DEFAULT_BG_SLOT,
	DEFAULT_TITLE_SLOT,
	LIST_HEADER_LINE_COUNT,
	SELECTED_ROW_SLOT,
	repaintListRows,
	repaintSelectedRow,
	repaintSelectedRows,
	repaintUnselectedRow,
	resolveRowPaintOptions,
	resolveSessionListBgEnabled,
	resolveSessionListBgSlot,
	resolveSessionListTitleSlot,
	type RowColorSource,
} from "./row.ts";

const OLD = "\u001b[48;2;81;81;81m"; // selectedBg（pi-coder-1337）
const NEW = "\u001b[48;2;36;36;36m"; // userMessageBg（pi-coder-1337）
const BG_RESET = "\u001b[49m";
const FULL_RESET = "\u001b[0m";
const ACCENT = "\u001b[38;2;140;218;255m";
const DIM = "\u001b[38;2;109;109;109m";
/** 命名会话那一行正文的颜色（pi 的 `messageColor = "warning"`）。 */
const WARNING = "\u001b[38;2;255;184;108m";
/** 滚动提示行（`fg("muted", …)`）。 */
const MUTED = "\u001b[38;2;153;153;153m";
const FG_RESET = "\u001b[39m";

/** 去掉所有零宽序列，只留可见字符。 */
const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");
const visibleWidth = (line: string): number => [...plain(line)].length;

/**
 * 按终端的真实语义走一遍这一行，返回**落在底色之外**的可见字符数。
 *
 * 这就是这次 bug 的判据：`\x1b[0m` 会清掉底色，之后每个可见字符都在默认背景上。
 */
function charsOutsideBg(line: string, bg: string): number {
	let outside = 0;
	let inBg = false;
	for (const token of line.match(/\u001b\[[0-9;]*m|[^\u001b]/g) ?? []) {
		if (token === bg) {
			inBg = true;
			continue;
		}
		if (token === FULL_RESET || token === BG_RESET) {
			inBg = false;
			continue;
		}
		if (token.startsWith("\u001b")) continue;
		if (!inBg) outside += 1;
	}
	return outside;
}

/** pi 真输出里一条「被缩略」的选中行（width=60，标题折过，行尾有消息数与时间）。 */
const TRUNCATED_SELECTED =
	OLD +
	`${ACCENT}› ${FG_RESET}${DIM}${FG_RESET}` +
	"修复一下 resume 列表里选中行的背景色问题，这一行" +
	`${FULL_RESET}…${FULL_RESET}` +
	"   " +
	`${DIM}42 now${FG_RESET}` +
	BG_RESET;

/** 没被缩略的选中行（走的是 `text.length <= maxWidth` 快捷返回，行里没有裸 `\x1b[0m`）。 */
const PLAIN_SELECTED =
	OLD +
	`${ACCENT}› ${FG_RESET}${DIM}${FG_RESET}` +
	"短会话名字" +
	" ".repeat(40) +
	`${DIM}3 now${FG_RESET}` +
	BG_RESET;

/** 未选中行：没有 `selectedBg` 前缀。 */
const UNSELECTED = `  ${DIM}${FG_RESET}第二个会话${" ".repeat(40)}${DIM}3 10m${FG_RESET}`;

const BOLD_ON = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";

/**
 * pi 真输出里一条「被缩略 **且带粗体**」的选中行 —— `FORCE_COLOR=3` 下从真的
 * `SessionSelectorComponent.render(width=60)` 抄下来的字节，只有标题文字换成了短样本。
 *
 * 形状要点（改断言时对着它看）：`\x1b[1m` 包住正文；缩略时 pi 在粗体区间**正中**插一个裸
 * `\x1b[0m`（`…` 丢底色、也丢色的位置）；`\x1b[22m` 在正文之后才关；行尾
 * `${DIM}11 5h${FG_RESET}` 在粗体区间**之外**，那是要被保住的"消息数 + 时间"。
 */
const TRUNCATED_SELECTED_BOLD =
	OLD +
	`${ACCENT}› ${FG_RESET}${DIM}${FG_RESET}` +
	`${BOLD_ON}写一个很长的文件，20行，内容随机    然后修改这个20` +
	`${FULL_RESET}…${FULL_RESET}${BOLD_OFF}` +
	"  " +
	`${DIM}11 5h${FG_RESET}` +
	BG_RESET;

/** 行里还有没有粗体开门序列。 */
const hasBold = (line: string): boolean => line.includes(BOLD_ON);

/** 按终端语义走一遍，返回每个可见字符以及它当时的 (前景色在不在 accent 里)。 */
function scanAccent(line: string, accent: string): Array<{ char: string; accent: boolean }> {
	const marks: Array<{ char: string; accent: boolean }> = [];
	let on = false;
	for (const token of line.match(/\u001b\[[0-9;]*m|[^\u001b]+/g) ?? []) {
		if (token.startsWith("\u001b")) {
			if (token === accent) on = true;
			else if (token === FG_RESET || token === FULL_RESET) on = false;
			continue;
		}
		for (const char of token) marks.push({ char, accent: on });
	}
	return marks;
}

/** 正文区间在可见字符坐标里的范围：`› ` 光标之后、行尾「N 时间」之前。 */
function bodyRange(marks: Array<{ char: string }>): { start: number; end: number; text: string } {
	const text = marks.map((mark) => mark.char).join("");
	const start = text.startsWith("› ") ? 2 : 0;
	const tail = /\s+\d+ \S+\s*$/.exec(text);
	const end = tail ? (tail.index ?? text.length) : text.length;
	return { start, end, text: text.slice(start, end) };
}

const OPTIONS = { from: OLD, to: NEW };

test("根因对照：pi 原始选中行在 `…` 之后有可见字符落在底色之外", () => {
	// 先证明这个装置抓得住 bug —— 否则下面的「通过」没有意义。
	assert.equal(plain(TRUNCATED_SELECTED).includes("…"), true);
	assert.equal(charsOutsideBg(TRUNCATED_SELECTED, OLD) > 0, true, "原始行在 `\\x1b[0m` 之后丢了底色");
});

test("截断的选中行：换成新底色后，每一个可见字符都在底色里", () => {
	const out = repaintSelectedRow(TRUNCATED_SELECTED, OPTIONS);
	assert.equal(charsOutsideBg(out, NEW), 0, "`…` 与它右边都补回了底色");
	assert.equal(out.startsWith(NEW), true, "整行以新底色开头");
	assert.equal(out.endsWith(BG_RESET), true, "行尾收一个关背景");
	assert.equal(out.includes(OLD), false, "旧底色彻底消失");
});

test("重绘不动可见字符：宽度与文本逐字节不变", () => {
	const out = repaintSelectedRow(TRUNCATED_SELECTED, OPTIONS);
	assert.equal(plain(out), plain(TRUNCATED_SELECTED));
	// CJK + 全角标点不重算宽度，只增删 SGR ⇒ 用可见字符数作等价判据。
	assert.equal([...plain(out)].length, [...plain(TRUNCATED_SELECTED)].length);
});

test("没被缩略的选中行同样换成新底色（行里没有裸复位）", () => {
	const out = repaintSelectedRow(PLAIN_SELECTED, OPTIONS);
	assert.equal(out.startsWith(NEW), true);
	assert.equal(charsOutsideBg(out, NEW), 0);
	assert.equal(plain(out), plain(PLAIN_SELECTED));
});

test("非选中行原样返回同一个字符串（差分渲染不该看到新对象）", () => {
	assert.equal(repaintSelectedRow(UNSELECTED, OPTIONS), UNSELECTED);
});

test("行里的 `\\x1b[49m`（只关背景）后面也补回底色", () => {
	const line = `${OLD}a${BG_RESET}b${BG_RESET}`;
	const out = repaintSelectedRow(line, OPTIONS);
	assert.equal(charsOutsideBg(out, NEW), 0);
	assert.equal(plain(out), "ab", "可见字符不变");
	// 关背景本身保留（可能来自嵌套的 `theme.bg`），但每个后面都立刻补回行底色；
	// 只有行尾那一个才是真正的收尾。
	assert.equal(out.split(BG_RESET).length - 1, 2, "中间一个 + 行尾一个");
	assert.equal(out.includes(`${BG_RESET}${NEW}b`), true, "中间的关背景后面紧跟着新底色");
	assert.equal(out.endsWith(BG_RESET), true, "行尾以关背景收尾");
});

test("皮肤缺槽 / 空行：原样返回", () => {
	assert.equal(repaintSelectedRow(TRUNCATED_SELECTED, { from: "", to: NEW }), TRUNCATED_SELECTED, "拿不到旧底色");
	assert.equal(repaintSelectedRow(TRUNCATED_SELECTED, { from: OLD, to: "" }), TRUNCATED_SELECTED, "拿不到新底色");
	assert.equal(repaintSelectedRow(OLD, OPTIONS), OLD, "只有底色、没有内容时不重绘");
	assert.equal(repaintSelectedRow(PLAIN_SELECTED, { from: OLD, to: OLD }), PLAIN_SELECTED, "同色且行里没东西可补 → 原样");
});

/**
 * 皮肤把 `selectedBg` 配成与 `userMessageBg` **同色**之后（用户 2026-10-28 定的皮肤改法），
 * `from === to`。这时颜色已经对了，但 pi 截断时插的裸 `\x1b[0m` 照样会把底色清掉 ——
 * 补色必须照样跑，否者修 bug 的那一半会静默失效。
 */
test("新旧同色时仍然补底色（皮肤里两槽以后同值，不该把修 bug 的那半弄丢）", () => {
	const out = repaintSelectedRow(TRUNCATED_SELECTED, { from: OLD, to: OLD });
	assert.notEqual(out, TRUNCATED_SELECTED, "同色也要重绘");
	assert.equal(charsOutsideBg(out, OLD), 0, "`…` 之后补回了底色");
	assert.equal(plain(out), plain(TRUNCATED_SELECTED), "可见字符不变");
	assert.equal(out.startsWith(OLD), true);
	assert.equal(out.endsWith(BG_RESET), true);
});

test("repaintSelectedRows：没有一行需要改时返回原数组引用", () => {
	const lines = [UNSELECTED, UNSELECTED];
	assert.equal(repaintSelectedRows(lines, OPTIONS), lines);
});

test("repaintSelectedRows：逐行处理，非选中行逐字节不变", () => {
	const lines = [TRUNCATED_SELECTED, UNSELECTED, PLAIN_SELECTED];
	const out = repaintSelectedRows(lines, OPTIONS);
	assert.notEqual(out, lines, "确实改了，返回新数组");
	assert.equal(out.length, lines.length, "行数不变");
	assert.equal(out[1], UNSELECTED, "未选中行逐字节不变");
	for (const line of out) {
		if (!line.includes(NEW)) continue;
		assert.equal(charsOutsideBg(line, NEW), 0);
	}
	assert.equal(out.filter((line) => line.includes(NEW)).length, 2, "两条选中行都换了底色");
});

test("取色：从皮肤读出新旧底色；缺槽时返回 undefined 而不是抛", () => {
	const ok: RowColorSource = {
		getBgAnsi: (slot: string) => {
			if (slot === SELECTED_ROW_SLOT) return OLD;
			if (slot === DEFAULT_BG_SLOT) return NEW;
			throw new Error(`Unknown theme background color: ${slot}`);
		},
	};
	assert.deepEqual(resolveRowPaintOptions(ok), { from: OLD, to: NEW });

	const noNew: RowColorSource = {
		getBgAnsi: (slot: string) => {
			if (slot === SELECTED_ROW_SLOT) return OLD;
			throw new Error("no");
		},
	};
	assert.equal(resolveRowPaintOptions(noNew), undefined, "目标槽缺失");

	const noOld: RowColorSource = {
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveRowPaintOptions(noOld), undefined, "旧槽缺失");
	assert.equal(resolveRowPaintOptions(undefined), undefined, "没有皮肤");
});

test("取色：显式换到别的槽位（如 searchMatchBg）照样走同一条路径", () => {
	const source: RowColorSource = {
		getBgAnsi: (slot: string) => {
			if (slot === SELECTED_ROW_SLOT) return OLD;
			if (slot === "searchMatchBg") return "\u001b[48;2;61;61;61m";
			throw new Error("no");
		},
	};
	const options = resolveRowPaintOptions(source, "searchMatchBg");
	assert.ok(options);
	assert.equal(options.to, "\u001b[48;2;61;61;61m");
	const out = repaintSelectedRow(TRUNCATED_SELECTED, options);
	assert.equal(out.startsWith("\u001b[48;2;61;61;61m"), true);
	assert.equal(charsOutsideBg(out, "\u001b[48;2;61;61;61m"), 0);
});

test("开关：PI_SESSION_LIST_BG=off 关闭，其余（含未设）开启", () => {
	assert.equal(resolveSessionListBgEnabled(undefined), true);
	assert.equal(resolveSessionListBgEnabled(""), true);
	assert.equal(resolveSessionListBgEnabled(" OFF "), false);
	assert.equal(resolveSessionListBgEnabled("off"), false);
	assert.equal(resolveSessionListBgEnabled("toolPendingBg"), true);
});

test("槽位名：空 / 未设落到默认 userMessageBg", () => {
	assert.equal(resolveSessionListBgSlot(undefined), "userMessageBg");
	assert.equal(resolveSessionListBgSlot("   "), "userMessageBg");
	assert.equal(resolveSessionListBgSlot(" customMessageBg "), "customMessageBg");
});

test("正文颜色槽：空 / 未设 → accent；off / none / - → 空串（只去粗体）", () => {
	assert.equal(DEFAULT_TITLE_SLOT, "accent");
	assert.equal(resolveSessionListTitleSlot(undefined), "accent");
	assert.equal(resolveSessionListTitleSlot("  "), "accent");
	assert.equal(resolveSessionListTitleSlot("mdLink"), "mdLink");
	for (const off of ["off", " OFF ", "none", "-"]) {
		assert.equal(resolveSessionListTitleSlot(off), "", `${off} 应当关掉染色`);
	}
});

/* --------------------------------------------- 正文：去粗体 + accent（用户 2026-10-28 第二轮） */

test("根因对照：pi 原始选中行正文是粗体", () => {
	assert.equal(hasBold(TRUNCATED_SELECTED_BOLD), true, "装置里确实有 `\\x1b[1m`");
	assert.equal(plain(TRUNCATED_SELECTED_BOLD).includes("写一个很长的文件"), true);
});

test("正文不再加粗、改用 accent；行尾的消息数/时间保持 dim", () => {
	const out = repaintSelectedRow(TRUNCATED_SELECTED_BOLD, { from: OLD, to: NEW, accent: ACCENT });
	assert.equal(hasBold(out), false, "粗体彻底消失");

	const marks = scanAccent(out, ACCENT);
	const { start, end, text } = bodyRange(marks);
	const bodyMarks = marks.slice(start, end).filter((mark) => mark.char.trim().length > 0);
	assert.equal(bodyMarks.length > 0, true, "抽得到正文");
	assert.equal(bodyMarks.filter((mark) => !mark.accent).length, 0, "正文每个可见字符都在 accent 里（含 `…`）");
	assert.equal(text.includes("\u2026"), true, "这一行确实被缩略过（才验得到 `…` 之后那段）");

	const tailMarks = marks.slice(end).filter((mark) => mark.char.trim().length > 0);
	assert.equal(tailMarks.length > 0, true, "抽得到行尾段");
	assert.equal(tailMarks.some((mark) => mark.accent), false, "行尾的 `11 5h` 没被染成 accent");
	assert.equal(out.includes(`${DIM}11 5h${FG_RESET}`), true, "行尾仍然是 pi 自己的 dim");

	assert.equal(charsOutsideBg(out, NEW), 0, "底色那半仍然成立");
	assert.equal(plain(out), plain(TRUNCATED_SELECTED_BOLD), "可见字符逐字节不变");
	assert.equal(visibleWidth(out), visibleWidth(TRUNCATED_SELECTED_BOLD), "可见宽度不变（pi-tui 超宽直接抛）");
});

test("强调色在正文之后收掉，不带到行尾", () => {
	const out = repaintSelectedRow(TRUNCATED_SELECTED_BOLD, { from: OLD, to: NEW, accent: ACCENT });
	const afterBody = out.slice(out.indexOf(`${DIM}11 5h`));
	assert.equal(afterBody.includes(ACCENT), false, "行尾段里没有强调色");
});

test("没被缩略的选中行：同样去粗体换色", () => {
	const line =
		OLD +
		`${ACCENT}› ${FG_RESET}${DIM}${FG_RESET}` +
		`${BOLD_ON}短会话名字` +
		" ".repeat(10) +
		`${BOLD_OFF}` +
		`${DIM}3 now${FG_RESET}` +
		BG_RESET;
	const out = repaintSelectedRow(line, { from: OLD, to: NEW, accent: ACCENT });
	assert.equal(hasBold(out), false);
	const marks = scanAccent(out, ACCENT);
	const { start, end } = bodyRange(marks);
	const bodyMarks = marks.slice(start, end).filter((mark) => mark.char.trim().length > 0);
	assert.equal(bodyMarks.length > 0, true);
	assert.equal(bodyMarks.some((mark) => mark.accent), true, "正文里有 accent");
	assert.equal(plain(out), plain(line));
});

/**
 * 皮肤没有 `accent` 槽（或用户显式 `PI_SESSION_LIST_TITLE=off`）时：粗体照样去掉，
 * 但**不**自造颜色 —— 正文回到皮肤默认前景色。
 */
test("没有强调色槽时只去粗体、不染色", () => {
	const out = repaintSelectedRow(TRUNCATED_SELECTED_BOLD, { from: OLD, to: NEW });
	assert.equal(hasBold(out), false, "粗体仍然要去掉");
	assert.equal(plain(out), plain(TRUNCATED_SELECTED_BOLD));
	assert.equal(charsOutsideBg(out, NEW), 0, "底色那半不受影响");
	const marks = scanAccent(out, ACCENT);
	const { start, end } = bodyRange(marks);
	const bodyMarks = marks.slice(start, end).filter((mark) => mark.char.trim().length > 0);
	assert.equal(bodyMarks.length > 0, true);
	assert.equal(bodyMarks.some((mark) => mark.accent), false, "正文没有被染成 accent");
});

/* -------------------------- 第五轮：只有选中行才带 accent（用户 2026-10-28） */

/**
 * pi 给**当前会话**那一行的正文写死 `fg("accent", …)`，与是否选中无关
 * （`isCurrent ? "accent" : hasName ? "warning" : null`）。下面是它在未选中时的真实字节形状：
 * 没有底色前缀、正文被 accent 包着、行尾仍是 `dim`。
 */
const UNSELECTED_CURRENT =
	"  " + `${DIM}${FG_RESET}` + `${ACCENT}当前会话很长的标题` + `${FULL_RESET}…${FULL_RESET}` +
	"  " + `${DIM}42 now${FG_RESET}`;

/**
 * 选中行的形状（`SessionList.render` 的完整一行）：光标 `› ` 是 accent、树前缀与行尾是 dim、
 * 正文被粗体包着，底色在最外层。
 */
const SELECTED_ROW =
	OLD +
	`${ACCENT}› ${FG_RESET}${DIM}${FG_RESET}` +
	`${BOLD_ON}短会话名字` +
	" ".repeat(10) +
	BOLD_OFF +
	`${DIM}3 now${FG_RESET}` +
	BG_RESET;

test("根因对照：pi 的当前会话行在未选中时正文也是 accent", () => {
	// 先证明装置复现了用户看到的现象，否则下面的「洗掉」是空转。
	assert.equal(UNSELECTED_CURRENT.startsWith(OLD), false, "未选中行没有底色前缀");
	assert.equal(UNSELECTED_CURRENT.includes(ACCENT), true, "未选中行的正文确实带着 accent");
});

test("非选中行：accent 洗回终端默认前景色，别的颜色一个不动", () => {
	const out = repaintUnselectedRow(UNSELECTED_CURRENT, ACCENT);
	assert.equal(out.includes(ACCENT), false, "accent 没了");
	assert.equal(out.includes(FG_RESET), true, "换成了默认前景色");
	assert.equal(out.includes(`${DIM}42 now${FG_RESET}`), true, "行尾的 dim 原样保留");
	assert.equal(plain(out), plain(UNSELECTED_CURRENT), "可见字符一个不动");
});

test("非选中行：warning / error / dim 不被洗（那是状态色，不是选中信号）", () => {
	const line = "  " + `${DIM}${FG_RESET}` + `${WARNING}命名会话` + `${FG_RESET}` + `${DIM}3 1h${FG_RESET}`;
	assert.equal(repaintUnselectedRow(line, ACCENT), line, "没有 accent 就原样返回");
});

test("非选中行：accent 缺省 / 空串时原样返回（皮肤没这个槽）", () => {
	assert.equal(repaintUnselectedRow(UNSELECTED_CURRENT, undefined), UNSELECTED_CURRENT);
	assert.equal(repaintUnselectedRow(UNSELECTED_CURRENT, ""), UNSELECTED_CURRENT);
});

/**
 * 列表层：`[搜索框, "", 会话行…, (滚动提示行)]`。搜索框那一行里也有 accent（提示符/补全），
 * 但它在会话行之前，**必须**不被动；空行也是。
 */
const SEARCH_LINE = `${ACCENT}Search: ${FG_RESET}`;
const SCROLL_LINE = `  ${MUTED}(1/12)${FG_RESET}`;
const LIST = [SEARCH_LINE, "", SELECTED_ROW, UNSELECTED_CURRENT, SCROLL_LINE];

const LIST_OPTIONS = { from: OLD, to: NEW, accent: ACCENT, currentSessionAccent: ACCENT };

test("列表层：选中行换色去粗体、非选中行洗 accent、搜索框与滚动提示行不动", () => {
	const out = repaintListRows(LIST, LIST_OPTIONS);
	assert.equal(out[0], SEARCH_LINE, "搜索框那一行逐字节不变");
	assert.equal(out[1], "", "空行不变");
	assert.equal(hasBold(out[2] ?? ""), false, "选中行不再有粗体");
	assert.equal((out[2] ?? "").startsWith(NEW), true, "选中行换成新底色");
	assert.equal((out[3] ?? "").includes(ACCENT), false, "非选中行的 accent 被洗掉");
	assert.equal(out[4], SCROLL_LINE, "滚动提示行（muted）不动");
	assert.deepEqual(out.map(plain), LIST.map(plain), "所有行可见字符逐字节不变");
	assert.deepEqual(
		out.map(visibleWidth),
		LIST.map(visibleWidth),
		"所有行可见宽度不变（pi-tui 超宽直接抛）",
	);
});

test("列表层：没有一行需要改时返回原数组引用（差分渲染）", () => {
	const lines = [SEARCH_LINE, "", SCROLL_LINE];
	assert.equal(repaintListRows(lines, LIST_OPTIONS), lines);
});

/**
 * 找不到那条空行 ⇒ 布局已经变了（pi 的 `SessionList.render` 总是紧跟着 push 一个 `""`）。
 * 此时按 `LIST_HEADER_LINE_COUNT` 跳过开头、宁可少重绘也不能把搜索框当会话行洗一遍。
 */
test("列表层：找不到那条空行时退回固定行数（宁可不动，不把搜索框当会话行）", () => {
	const lines = [SEARCH_LINE, SELECTED_ROW];
	const out = repaintListRows(lines, LIST_OPTIONS);
	assert.equal(out[0], SEARCH_LINE, "搜索框那一行逐字节不变");
	assert.equal(LIST_HEADER_LINE_COUNT, 2);
	// 行数比头的两行还少时没什么可重绘的 —— 这是布局不认识时的保守行为。
	assert.equal(out[1], SELECTED_ROW, "认不出布局就不动");
	assert.equal(repaintListRows(lines, LIST_OPTIONS), lines, "原数组引用也不变");
});

test("取色：洗非选中行用的 accent 与选中行正文槽无关", () => {
	const source: RowColorSource = {
		getBgAnsi: (slot: string) => {
			if (slot === SELECTED_ROW_SLOT) return OLD;
			if (slot === DEFAULT_BG_SLOT) return NEW;
			throw new Error("no");
		},
		getFgAnsi: (slot: string) => {
			if (slot === CURRENT_SESSION_SLOT) return ACCENT;
			throw new Error("no");
		},
	};
	// `PI_SESSION_LIST_TITLE=off`：选中行不染色，但当前会话行的 accent 照样该洗掉。
	const options = resolveRowPaintOptions(source, DEFAULT_BG_SLOT, "");
	assert.ok(options);
	assert.equal(options.accent, undefined, "选中行不染色");
	assert.equal(options.currentSessionAccent, ACCENT, "洗色用的 accent 仍然拿到");
	assert.equal(CURRENT_SESSION_SLOT, "accent", "pi 写死的槽名");
	assert.equal((repaintListRows(LIST, options)[3] ?? "").includes(ACCENT), false);
});

test("取色：皮肤没有 accent 槽时不洗（不猜颜色）", () => {
	const source: RowColorSource = {
		getBgAnsi: (slot: string) => {
			if (slot === SELECTED_ROW_SLOT) return OLD;
			if (slot === DEFAULT_BG_SLOT) return NEW;
			throw new Error("no");
		},
		getFgAnsi: () => {
			throw new Error("no");
		},
	};
	const options = resolveRowPaintOptions(source);
	assert.ok(options);
	assert.equal(options.currentSessionAccent, undefined);
	assert.equal(repaintListRows(LIST, options)[3], UNSELECTED_CURRENT, "没拿到就不动");
});
