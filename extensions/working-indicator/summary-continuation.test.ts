/**
 * Tests for summary-continuation.ts — 延续短语判定 + 融合摘要提示词。
 *
 * Run with:  node --test clients/pi/extensions/working-indicator/summary-continuation.test.ts
 *
 * 正例全部取自本机真实语料（435 个会话 / 1309 条 user 消息里出现过的延续短语），
 * 反例同样取自语料 —— 尤其是 `commit and push`（出现 144 次）：它是**短**消息但不是
 * 延续，按长度阈值判定就会误伤它，所以这里必须有它。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_CONTEXT_CHARS,
	buildContinuationSummaryPrompt,
	isContinuationPhrase,
} from "./summary-continuation.ts";

// ---------------------------------------------------------------------------
// 判定：正例（语料里真实出现过的延续短语）
// ---------------------------------------------------------------------------

const POSITIVES: readonly string[] = [
	// 语料原文
	"继续",
	"同意，继续",
	"确认，继续",
	"做，继续",
	"好的，继续",
	"可以，继续",
	"go ahead",
	// 常见变体：大小写 / 首尾标点 / 空白
	"OK",
	"ok",
	"Ok!",
	"好的。",
	" 继续 ",
	"继续～",
	"go on",
	"Go Ahead",
	"proceed",
	"continue",
	"keep going",
	"嗯",
	"嗯嗯",
	"对",
	"对的",
	"是的",
	"行",
	"没问题",
	"收到",
	"明白",
	"lgtm",
	"sure",
	"yep",
	"就这样",
	"开始吧",
	"下一步",
	// 前缀填充词
	"那就继续",
	"那么继续",
	"就继续",
	"那继续",
	// 多段：ACK + CONTINUE 的任意组合
	"明白，继续",
	"好的，那就继续",
	"收到，go ahead",
	"ok, continue",
	"嗯，继续吧",
	// 多行 / markdown 噪声（flattenPrompt 负责压平）
	"继续\n",
	"> 继续",
	"- 继续",
];

test("延续短语正例全部命中", () => {
	for (const text of POSITIVES) {
		assert.equal(isContinuationPhrase(text), true, `应该判为延续短语：${JSON.stringify(text)}`);
	}
});

// ---------------------------------------------------------------------------
// 判定：反例（短 ≠ 延续；语料里的高频独立指令）
// ---------------------------------------------------------------------------

const NEGATIVES: readonly string[] = [
	// 语料原文：短，但是独立完整的指令
	"commit and push",
	"commit",
	"推送",
	"hi",
	"cd",
	"cd ..",
	"你是什么大模型",
	"AGENTS.md 需要更新吗",
	"这个测试一直失败，帮我看看为什么",
	"升级 pi-web-access",
	"改动 server.js 到 http",
	"live install",
	"reply with exactly: OK",
	"Say only: ONE",
	// 纯确认但没有「要求做事」：多段全是 ACK 不算延续
	"好的，收到",
	"嗯，明白",
	"ok, sure",
	// 词表外的短语（漏判的代价只是退回现状，不能误判）
	"继续优化摘要",
	"继续，然后把测试补上",
	"就这样吧，别改了",
	"ok 那我看看",
	// 空 / 只有标点
	"",
	"   ",
	"。",
	"，，",
	"…",
];

test("独立指令与词表外短语一律不命中（宁漏不误）", () => {
	for (const text of NEGATIVES) {
		assert.equal(isContinuationPhrase(text), false, `不该判为延续短语：${JSON.stringify(text)}`);
	}
});

test("前缀填充词只剥封闭表里的那几个，不做通用前缀剥离", () => {
	// `就是` 剥掉 `就` 会剩下 `是`（在 ACK 表里）—— 那正是通用剥离会造成的意外命中。
	assert.equal(isContinuationPhrase("就是"), false);
	assert.equal(isContinuationPhrase("就这样做吧，别的不改"), false);
	// 填充词后面必须还有内容：光一个 `那就` 不是延续。
	assert.equal(isContinuationPhrase("那就"), false);
	assert.equal(isContinuationPhrase("那"), false);
});

test("多词英文短语不被空格打散", () => {
	assert.equal(isContinuationPhrase("go ahead"), true);
	assert.equal(isContinuationPhrase("keep going"), true);
	assert.equal(isContinuationPhrase("do it"), true);
	// 打散后的碎片查不到 → 不命中（这正是「不按空格切段」要防的）
	assert.equal(isContinuationPhrase("ahead go"), false);
});

// ---------------------------------------------------------------------------
// 融合提示词
// ---------------------------------------------------------------------------

test("提示词带上上一任务与新输入，并保留单行/列宽/同语言那套格式约束", () => {
	const prompt = buildContinuationSummaryPrompt("继续", "优化 spinner 行尾的提示词摘要", 34);

	assert.ok(prompt.includes("34 display columns"), "目标列数要写进去");
	assert.ok(prompt.includes("CJK/full-width character counts as 2 columns"), "列宽口径要写进去");
	assert.ok(prompt.includes("优化 spinner 行尾的提示词摘要"), "上一任务要在提示词里");
	assert.ok(prompt.includes("继续"), "新输入要在提示词里");
	assert.ok(prompt.includes("single line"), "仍要求单行");
	assert.ok(prompt.includes("no markdown"), "仍禁止 markdown");
	// 融合语义：明确说这是跟进、且不要只复述上一任务。
	assert.ok(prompt.includes("brief follow-up"), "要告诉模型这是上一任务的跟进");
	assert.ok(prompt.includes("Do not just restate the previous task"), "要禁止只复述上一任务");
	// 语言跟随上一任务（短语是 `ok` 而任务是中文时，摘要该是中文）。
	assert.ok(prompt.includes("same language as the previous task"), "语言应跟随上一任务");
});

test("上一任务超长时按码点截断并补省略号", () => {
	const long = "很".repeat(MAX_CONTEXT_CHARS + 50);
	const prompt = buildContinuationSummaryPrompt("ok", long, 30);

	assert.ok(prompt.includes("…"), "截断要补省略号");
	// 提示词里那一行 = 截断后的上下文（MAX_CONTEXT_CHARS 个字 + 一个 …）。
	const contextLine = prompt
		.split("\n")
		.find((line) => line.startsWith("很".repeat(10)));
	assert.ok(contextLine, "应该找得到上下文那一行");
	assert.equal([...(contextLine as string)].length, MAX_CONTEXT_CHARS + 1, "按码点截，不切半个代理对");
});

test("代理对不被切成半个（emoji 上下文）", () => {
	const long = "🚀".repeat(MAX_CONTEXT_CHARS + 10);
	const prompt = buildContinuationSummaryPrompt("继续", long, 30);
	const contextLine = prompt.split("\n").find((line) => line.startsWith("🚀")) as string;
	assert.equal([...contextLine].length, MAX_CONTEXT_CHARS + 1);
	assert.ok(!contextLine.includes("\uFFFD"), "不该出现替换字符");
});
