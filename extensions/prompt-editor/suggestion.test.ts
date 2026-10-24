/**
 * Tests for suggestion.ts — 回合结束后输入框里的「下一步建议」：纯排版 + 提示词 / 清洗。
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/suggestion.test.ts
 *
 * 宽度量测 / 截断 / 着色 / 光标标记全部由调用方注入，所以这里能直接断言排布顺序
 * （光标格在最左、不染色，dim 只包后面的文字）而不需要起 TUI。真编辑器的端到端
 * （agent_settled → 请求 → 画出来 → Tab 填入）在 `render.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_SUGGESTION_TEXT_CHARS,
	SUGGESTION_INDENT,
	buildSuggestionDigest,
	buildSuggestionLine,
	buildSuggestionRequestPrompt,
	cleanSuggestionText,
	isConcludingReply,
	suggestionFillText,
	isSuggestionVisible,
	resolveSuggestionEnabled,
	type SuggestionChrome,
	type SuggestionMetrics,
} from "./suggestion.ts";

/**
 * ASCII 专用度量：ANSI 转义与 APC 标记算零宽（与 `visibleWidth` 的口径一致）。
 * 截断按「宽度表」逐字素前进，只在末尾补一个 `ellipsis`。
 */
const ZERO_WIDTH = /\x1b\[[0-9;]*m|\x1b_pi:[^\x07]*\x07/g;
const ASCII_METRICS: SuggestionMetrics = {
	widthOf: (text) => text.replace(ZERO_WIDTH, "").length,
	truncate: (text, width, ellipsis) => {
		const plain = text.replace(ZERO_WIDTH, "");
		if (plain.length <= width) return text;
		const head = plain.slice(0, Math.max(0, width - ellipsis.length));
		return `${head}${ellipsis}`;
	},
};

const PLAIN_CHROME: SuggestionChrome = {
	style: (text) => text,
	cursorMarker: "",
	renderFakeCursor: (text) => text,
};

const ANSI_STYLE = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const ANSI_CURSOR = (text: string): string => `\x1b[7m${text}\x1b[27m`;

// ── 可见判据 / 开关 ────────────────────────────────────────────────────────

test("建议只在严格空输入框里可见：空格 / 换行 / 字母都算有内容", () => {
	assert.equal(isSuggestionVisible(""), true);
	assert.equal(isSuggestionVisible(" "), false);
	assert.equal(isSuggestionVisible("a"), false);
	assert.equal(isSuggestionVisible("\n"), false);
});

test("开关只认 off（大小写与空白都容忍）", () => {
	assert.equal(resolveSuggestionEnabled(undefined), true);
	assert.equal(resolveSuggestionEnabled(""), true);
	assert.equal(resolveSuggestionEnabled("off"), false);
	assert.equal(resolveSuggestionEnabled(" OFF "), false);
	assert.equal(resolveSuggestionEnabled("on"), true);
});

// ── 结论判据（决定 turn_end 要不要立刻猜下一步）──────────────

test("结论判据：只有「无工具调用 + stop + 有可见文本」的 assistant 消息才算", () => {
	const text = (value: string) => [{ type: "text", text: value }];
	// 真结论
	assert.equal(isConcludingReply({ role: "assistant", stopReason: "stop", content: text("改完了。") }), true);

	// 中间态：带工具调用
	assert.equal(
		isConcludingReply({
			role: "assistant",
			stopReason: "toolUse",
			content: [...text("我先看一下。"), { type: "toolCall", id: "t1", name: "read", arguments: {} }],
		}),
		false,
	);
	// stopReason 是 stop 但内容里有 toolCall：双保险仍拒掉
	assert.equal(
		isConcludingReply({ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "t1", name: "read" }] }),
		false,
	);

	// 失败 / 中断 / 截断的轮次
	for (const stopReason of ["length", "error", "aborted"]) {
		assert.equal(isConcludingReply({ role: "assistant", stopReason, content: text("xx") }), false, stopReason);
	}

	// 只有 thinking 的 stop：没有可猜的上下文
	assert.equal(
		isConcludingReply({ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "嗯……" }] }),
		false,
	);
	// 空白文本也不算
	assert.equal(isConcludingReply({ role: "assistant", stopReason: "stop", content: text("   ") }), false);

	// 非 assistant / 垃圾输入
	assert.equal(isConcludingReply({ role: "user", stopReason: "stop", content: text("hi") }), false);
	assert.equal(isConcludingReply(null), false);
	assert.equal(isConcludingReply({ role: "assistant", stopReason: "stop", content: "string" }), false);
});

// ── 渲染 ──────────────────────────────────────────────────────────────────

test("整行形状：行首缩进两格，建议第一个字紧随其后，末尾补满宽", () => {
	const line = buildSuggestionLine("跑一下测试", 20, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(line, `  ${"跑一下测试"}${" ".repeat(20 - 2 - 5)}`);
	assert.equal(ASCII_METRICS.widthOf(line), 20, "必须满宽");
	assert.equal(SUGGESTION_INDENT, "  ", "用户 2026-10-20 定：行首两个空格");
});

test("缩进只加在显示侧：渲染行与 Tab 填入都补两格，模型给的原文不带缩进", () => {
	const raw = "Run the tests";
	const line = buildSuggestionLine(raw, 30, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(line.startsWith(`  ${raw}`), true, "行首两格是渲染时补的缩进");
	assert.equal(raw.startsWith(" "), false, "建议本身不带缩进");
});

test("Tab 填入的正文带着行首两格：填入后文字停在建议刚才的位置（用户 2026-10-20 定）", () => {
	const raw = "Run the tests";
	const filled = suggestionFillText(raw);
	assert.equal(filled, `  ${raw}`);

	// 位置对齐的判据：渲染行的可见前缀与填入正文的前缀逐字相同，文字起点列不变
	const line = buildSuggestionLine(raw, 30, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(line.startsWith(filled), true, "建议画在哪一列，Tab 填入后就该停在哪一列");
});

test("没有文案就不填空格（不把两个空格单独填进输入框）", () => {
	assert.equal(suggestionFillText(""), "");
});

test("着色只包缩进之后的文字；第一格缩进（光标格）不染色", () => {
	const line = buildSuggestionLine("Run the tests", 30, ASCII_METRICS, {
		...PLAIN_CHROME,
		style: ANSI_STYLE,
		renderFakeCursor: ANSI_CURSOR,
	});
	// 光标格 = 第一格缩进；第二格缩进与文案一起进 dim（Tab 填入的正是这层 dim 文字，见上一条）
	assert.equal(line.startsWith(`${ANSI_CURSOR(" ")}${ANSI_STYLE(" Run the tests")}`), true);
	assert.equal(line.includes(ANSI_CURSOR(ANSI_STYLE(" "))), false, "光标格绝不能套在 dim 里");
	assert.equal(ASCII_METRICS.widthOf(line), 30, "着色后可见宽度仍是满宽");
	// 补满宽度的空格不进样式
	assert.equal(line.endsWith(" ".repeat(30 - 2 - "Run the tests".length)), true);
});

test("光标标记在最前面，未聚焦时为空串（与 pi-tui 的 Input 同口径）", () => {
	const marker = "\x1b_pi:c\x07";
	const focused = buildSuggestionLine("xyz", 10, ASCII_METRICS, { ...PLAIN_CHROME, cursorMarker: marker });
	assert.equal(focused.startsWith(`${marker}  xyz`), true);
	assert.equal(ASCII_METRICS.widthOf(focused), 10, "零宽标记不占列");
	assert.equal(buildSuggestionLine("xyz", 10, ASCII_METRICS, PLAIN_CHROME).startsWith(marker), false);
});

test("超宽：按可见宽度截断并补省略号，绝不折行（行数恒为 1）", () => {
	const long = "x".repeat(100);
	const line = buildSuggestionLine(long, 20, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(ASCII_METRICS.widthOf(line), 20);
	assert.equal(line.trimEnd(), `  ${"x".repeat(17)}…`, "可用 20 列：缩进 2 + 17 个 x + 省略号");
});

test("窄终端夹到 1 列：只剩光标格，不画裸 dim", () => {
	for (const width of [0, -3, 1]) {
		const line = buildSuggestionLine("Run", width, ASCII_METRICS, {
			...PLAIN_CHROME,
			style: ANSI_STYLE,
			renderFakeCursor: ANSI_CURSOR,
		});
		assert.equal(line, ANSI_CURSOR(" "), `width=${width}`);
		assert.equal(line.includes(ANSI_STYLE("")), false);
	}
});

test("建议里带换行时按单行处理：换行被当作文字的一部分（调用方保证清洗过）", () => {
	// 渲染层不做清洗，只保证不折行 —— 换行本身不该产生第二行
	const line = buildSuggestionLine("a\nb", 10, ASCII_METRICS, PLAIN_CHROME);
	assert.equal(line.includes("\n"), false, "渲染结果必须是一行");
});

// ── 清洗 ──────────────────────────────────────────────────────────────────

test("清洗：只取第一行有效内容，丢掉后面的解说", () => {
	assert.equal(cleanSuggestionText("跑一下测试\n\n这样能确认没有回归。"), "跑一下测试");
	assert.equal(cleanSuggestionText("\n\n跑一下测试"), "跑一下测试");
});

test("清洗：剥标签前缀（中英 + 粗体两种包法）", () => {
	assert.equal(cleanSuggestionText("Next: run the tests"), "run the tests");
	assert.equal(cleanSuggestionText("**Next:** run the tests"), "run the tests");
	assert.equal(cleanSuggestionText("建议：跑一下测试"), "跑一下测试");
	assert.equal(cleanSuggestionText("**建议：**跑一下测试"), "跑一下测试");
	assert.equal(cleanSuggestionText("下一步：跑一下测试"), "跑一下测试");
});

test("清洗：整行只有标签时跳过，取下一行", () => {
	assert.equal(cleanSuggestionText("Next:\nrun the tests"), "run the tests");
	assert.equal(cleanSuggestionText("建议\n跑一下测试"), "跑一下测试");
});

test("清洗：剥列表标记 / 整体引号 / 整体粗体", () => {
	assert.equal(cleanSuggestionText("- run the tests"), "run the tests");
	assert.equal(cleanSuggestionText("1. run the tests"), "run the tests");
	assert.equal(cleanSuggestionText("→ run the tests"), "run the tests");
	assert.equal(cleanSuggestionText('"run the tests"'), "run the tests");
	assert.equal(cleanSuggestionText("「跑一下测试」"), "跑一下测试");
	assert.equal(cleanSuggestionText("**run the tests**"), "run the tests");
	assert.equal(cleanSuggestionText('**"建议：跑一下测试"**'), "跑一下测试");
});

test("清洗：折叠多空格 / 制表符，去首尾空白", () => {
	assert.equal(cleanSuggestionText("  run   the\ttests  "), "run the tests");
});

test("清洗：跳过代码围栏标记行", () => {
	assert.equal(cleanSuggestionText("```\nrun the tests"), "run the tests");
});

test("清洗：空回复 / 只有装饰 → 空串（调用方按「无建议」处理）", () => {
	assert.equal(cleanSuggestionText(""), "");
	assert.equal(cleanSuggestionText("   \n\t\n"), "");
	assert.equal(cleanSuggestionText("Next:"), "");
	assert.equal(cleanSuggestionText("**建议**"), "");
});

test("清洗：超长按码点截断并补省略号（不切半个代理对）", () => {
	const long = "😀".repeat(MAX_SUGGESTION_TEXT_CHARS + 50);
	const cleaned = cleanSuggestionText(long);
	assert.equal([...cleaned].length, MAX_SUGGESTION_TEXT_CHARS + 1, "上限 + 省略号");
	assert.equal(cleaned.endsWith("…"), true);
	// 落单的代理项（�-� 未成对）会把终端渲染成替换字符，必须一个不剩
	assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cleaned), false);
});

// ── 请求提示词 / 摘要 ──────────────────────────────────────────────────────

test("请求提示词：带上目标宽度与摘要原文，声明单行 / 同语言 / 不重复已做过的事", () => {
	const prompt = buildSuggestionRequestPrompt("User asked: fix the test\nAssistant answered: done", 40);
	assert.equal(prompt.includes("40 display columns"), true);
	assert.equal(prompt.includes("User asked: fix the test"), true);
	assert.match(prompt, /same language/i);
	assert.match(prompt, /Do not repeat work/i);
	assert.match(prompt, /One line/i);
});

test("请求提示词：摘要超长时截断（不把整段历史塞进去）", () => {
	const prompt = buildSuggestionRequestPrompt("x".repeat(10_000), 40);
	assert.equal(prompt.length < 4_000, true, "输入被截到 MAX_REQUEST_INPUT_CHARS 附近");
	assert.equal(prompt.endsWith("…"), true);
});

test("摘要：跳过空块，工具名去重，顺序固定为用户 → 助手 → 工具", () => {
	assert.equal(
		buildSuggestionDigest({
			userPrompt: "fix the test",
			assistantReply: "fixed",
			toolNames: ["read", "read", "bash"],
		}),
		"User asked: fix the test\nAssistant answered: fixed\nTools used: read, bash",
	);
	assert.equal(buildSuggestionDigest({ userPrompt: null, assistantReply: null, toolNames: [] }), "");
	assert.equal(
		buildSuggestionDigest({ userPrompt: "q", assistantReply: null, toolNames: [] }),
		"User asked: q",
	);
});
