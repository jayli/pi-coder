/**
 * Tests for placeholder.ts — 输入框占位符的**纯排版逻辑**。
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/placeholder.test.ts
 *
 * 宽度量测 / 截断 / 着色 / 光标标记全部由调用方注入（真实现是 pi-tui 的
 * `visibleWidth` / `truncateToWidth` / `theme.fg("dim")` / `renderFakeCursor`），
 * 所以这里能直接断言「首字素被光标包住、其余被着色、行尾补满宽」这条排布顺序，
 * 而不需要真的起一个 TUI。真 tui 的端到端在 `render.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	PLACEHOLDER_INDENT,
	PLACEHOLDER_TEXT,
	buildPlaceholderLine,
	isPlaceholderVisible,
	resolvePlaceholder,
	splitFirstGrapheme,
	type PlaceholderChrome,
	type PlaceholderMetrics,
} from "./placeholder.ts";

/**
 * ASCII 专用度量：占位符是纯 ASCII，纯逻辑测试不需要真终端宽度表。
 * 按 `visibleWidth` 的口径把 ANSI 转义与 APC 标记算作零宽（假着色 / 假光标标记都用这两类形式）。
 */
const ZERO_WIDTH = /\x1b\[[0-9;]*m|\x1b_pi:[^\x07]*\x07/g;
const ASCII_METRICS: PlaceholderMetrics = {
	widthOf: (text) => text.replace(ZERO_WIDTH, "").length,
	truncate: (text, width) => text.slice(0, Math.max(0, width)),
};

/** 恒等 chrome：不着色、无光标标记、不改画光标格。 */
const PLAIN_CHROME: PlaceholderChrome = {
	style: (text) => text,
	cursorMarker: "",
	renderFakeCursor: (text) => text,
};

/** 与真实现同形的着色：`dim` 就是一层 ANSI 前景色。 */
const ANSI_STYLE = (text: string): string => `\x1b[2m${text}\x1b[0m`;
/** 反显光标格（真实现用 APC 包裹，这里用 ANSI 反显，宽度同样是 0）。 */
const ANSI_CURSOR = (text: string): string => `\x1b[7m${text}\x1b[27m`;

test("严格空串才显示占位符：空格 / 换行都算有内容", () => {
	assert.equal(isPlaceholderVisible(""), true);
	assert.equal(isPlaceholderVisible("a"), false);
	assert.equal(isPlaceholderVisible(" "), false);
	assert.equal(isPlaceholderVisible("\n"), false);
	assert.equal(isPlaceholderVisible("!"), false);
});

test("首字素切分：ASCII / 代理对 / 组合字符各算一个", () => {
	assert.deepEqual(splitFirstGrapheme("Type"), { head: "T", rest: "ype" });
	assert.deepEqual(splitFirstGrapheme("😀ab"), { head: "😀", rest: "ab" });
	// e + U+0301（组合重音）= 一个字素，不能把重音单独留在 rest 里
	assert.deepEqual(splitFirstGrapheme("e\u0301x"), { head: "e\u0301", rest: "x" });
	assert.deepEqual(splitFirstGrapheme(""), { head: "", rest: "" });
});

test("整行形状：行首缩进两个空格 + 完整文案 + 补满宽度", () => {
	const line = buildPlaceholderLine(PLACEHOLDER_TEXT, 80, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(line, `${PLACEHOLDER_INDENT}${PLACEHOLDER_TEXT}${" ".repeat(80 - PLACEHOLDER_INDENT.length - PLACEHOLDER_TEXT.length)}`);
	assert.equal(ASCII_METRICS.widthOf(line), 80);
	assert.equal(PLACEHOLDER_INDENT, "  ", "用户 2026-10-19 定：行首两个空格");
});

test("窄终端：按可见宽度截断（缩进也算在内），不加省略号（与 pi-tui 的 Input 同口径）", () => {
	const line = buildPlaceholderLine(PLACEHOLDER_TEXT, 10, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(line, "  Type you");
	assert.equal(line.includes("…"), false);
	assert.equal(ASCII_METRICS.widthOf(line), 10);
});

test("着色只包住文字，补满宽度的空格在着色之外", () => {
	const chrome: PlaceholderChrome = { ...PLAIN_CHROME, style: ANSI_STYLE };
	const line = buildPlaceholderLine(PLACEHOLDER_TEXT, 40, ASCII_METRICS, chrome);

	// 首个空格是光标格，**不**着色；其后内容整段包一层 dim
	assert.equal(
		line.startsWith(` ${ANSI_STYLE(" Type your message or @file")}`),
		true,
	);
	assert.equal(line.endsWith(" ".repeat(40 - PLACEHOLDER_INDENT.length - PLACEHOLDER_TEXT.length)), true, "补齐的空格不进样式");
	assert.equal(ASCII_METRICS.widthOf(line), 40, "着色后可见宽度仍是满宽");
});

test("光标格不染色：反显块必须回到底色（用户 2026-10-19 定）", () => {
	const line = buildPlaceholderLine(PLACEHOLDER_TEXT, 40, ASCII_METRICS, {
		...PLAIN_CHROME,
		style: ANSI_STYLE,
		renderFakeCursor: ANSI_CURSOR,
	});
	// 正确：反显直接包裸空格，dim 从它后面才开始
	assert.equal(
		line.startsWith(`${ANSI_CURSOR(" ")}${ANSI_STYLE(" Type your message or @file")}`),
		true,
	);
	// 反过来（旧写法）：反显包住已染色的格子 —— 灰会变成底色，光标就变灰了
	assert.equal(line.includes(ANSI_CURSOR(ANSI_STYLE(" "))), false);
});

test("光标标记打在文字最前面，未聚焦时为空串", () => {
	const marker = "\x1b_pi:c\x07";
	const focused = buildPlaceholderLine(PLACEHOLDER_TEXT, 40, ASCII_METRICS, {
		...PLAIN_CHROME,
		cursorMarker: marker,
	});
	assert.equal(focused.startsWith(marker + PLACEHOLDER_INDENT + PLACEHOLDER_TEXT), true);
	assert.equal(ASCII_METRICS.widthOf(focused), 40, "零宽标记不占列");

	const blurred = buildPlaceholderLine(PLACEHOLDER_TEXT, 40, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(blurred.startsWith(PLACEHOLDER_INDENT + PLACEHOLDER_TEXT), true);
});

test("反显光标只包第一个字素，且它不在 dim 里（真实现是 pi-tui 的 renderFakeCursor）", () => {
	const line = buildPlaceholderLine(PLACEHOLDER_TEXT, 40, ASCII_METRICS, {
		...PLAIN_CHROME,
		style: ANSI_STYLE,
		renderFakeCursor: ANSI_CURSOR,
	});
	// 缩进的首个空格就是光标格：反显块落在插入点（正文第 0 列），且用默认前景色
	assert.equal(
		line.startsWith(`${ANSI_CURSOR(" ")}${ANSI_STYLE(" Type your message or @file")}`),
		true,
	);
});

test("环境变量开关：默认文案 / 自定义文案 / off 关闭", () => {
	assert.deepEqual(resolvePlaceholder(undefined), { enabled: true, label: PLACEHOLDER_TEXT });
	assert.deepEqual(resolvePlaceholder(""), { enabled: true, label: PLACEHOLDER_TEXT });
	// 大小写 / 空白的 off 都算关闭
	assert.deepEqual(resolvePlaceholder("off"), { enabled: false, label: PLACEHOLDER_TEXT });
	assert.deepEqual(resolvePlaceholder(" OFF "), { enabled: false, label: PLACEHOLDER_TEXT });
	assert.deepEqual(resolvePlaceholder("写点什么…"), { enabled: true, label: "写点什么…" });
});

test("宽度为 0 / 负值时夹到 1 列：光标始终有一格可画", () => {
	for (const width of [0, -5]) {
		const line = buildPlaceholderLine(PLACEHOLDER_TEXT, width, ASCII_METRICS, PLAIN_CHROME);
		assert.equal(line, " ", `width=${width}`);
	}
});

test("宽字符首字素被截断掉时退回一个空格，不画空反显格", () => {
	// 宽度 1、首字素是 2 列的 CJK：truncate 返回空串，光标格仍要有内容
	const metrics: PlaceholderMetrics = {
		widthOf: (text) => [...text].reduce((sum, ch) => sum + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0),
		truncate: () => "",
	};
	const line = buildPlaceholderLine("你好", 1, metrics, {
		...PLAIN_CHROME,
		renderFakeCursor: ANSI_CURSOR,
	});
	assert.equal(line, ANSI_CURSOR(" "));
	assert.equal(line.includes(ANSI_STYLE("")), false);
});
