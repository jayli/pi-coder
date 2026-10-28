/**
 * Tests for render.ts — background-tasks 三个工具块 + 终态通知的展示形态纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/background-tasks/render.test.ts
 *
 * render.ts 不 import pi / pi-tui，所以这里直接断言结局分类、标题装饰、树前缀、预览截断
 * 这些**决定**（上色与折行在 index.ts 那侧，由 index.test.ts 走真加载器覆盖）。与
 * plan-mode/render.test.ts 同形。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BODY_INDENT,
	BODY_TEXT_TOKEN,
	BODY_TEXT_VAR,
	GUTTER_WIDTH,
	PREVIEW_MAX_LINES,
	TREE_LAST,
	TREE_PIPE,
	bgNotificationTitleParts,
	bgResultTreePrefixes,
	bgToolTitleParts,
	classifyBgNotificationOutcome,
	classifyBgToolOutcome,
	classifyBgWaitOutcome,
	fitLogLine,
	previewMoreLinesHint,
} from "./render.ts";

describe("工具块：结局分类（读 details.ok）", () => {
	it("isError 优先于 details 里的任何字段", () => {
		assert.equal(classifyBgToolOutcome(true, { ok: true }), "error");
		assert.equal(classifyBgToolOutcome(true, undefined), "error");
	});

	it("details.ok 严格为 true 才算成功", () => {
		assert.equal(classifyBgToolOutcome(false, { ok: true }), "success");
		assert.equal(classifyBgToolOutcome(false, { ok: true, task: { id: "bg_1" } }), "success");
	});

	it("其余都算 declined：ok:false / 无 details / 非对象 / 字符串 true", () => {
		assert.equal(classifyBgToolOutcome(false, { ok: false }), "declined");
		assert.equal(classifyBgToolOutcome(false, undefined), "declined");
		assert.equal(classifyBgToolOutcome(false, null), "declined");
		assert.equal(classifyBgToolOutcome(false, "not-an-object"), "declined");
		assert.equal(classifyBgToolOutcome(false, { ok: "true" }), "declined", "字符串 true 不算严格 true");
	});
});

describe("终态通知：结局分类（读 details.task）", () => {
	it("exit 0 → success", () => {
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: 0 }), "success");
	});

	it("被 kill / 非 0 退出 → error（与改形前的二值 failed 判定同语义）", () => {
		assert.equal(classifyBgNotificationOutcome({ status: "killed", signal: "SIGTERM" }), "error");
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: 1 }), "error");
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: 137, signal: "SIGKILL" }), "error");
	});

	it("task 缺失 / 形状认不出 → error（画红比画绿诚实）", () => {
		assert.equal(classifyBgNotificationOutcome(undefined), "error");
		assert.equal(classifyBgNotificationOutcome(null), "error");
		assert.equal(classifyBgNotificationOutcome("nope"), "error");
	});

	it("exitCode 非数字（还在跑 / 未知）且非 killed → success（不误报失败）", () => {
		assert.equal(classifyBgNotificationOutcome({ status: "exited" }), "success");
		assert.equal(classifyBgNotificationOutcome({ status: "exited", exitCode: null }), "success");
	});
});

describe("bg_wait：结局分类（details 没有 ok，改看 completions）", () => {
	it("isError 优先：等出错的调用是红点", () => {
		assert.equal(classifyBgWaitOutcome(true, { completions: [{ runId: "bg_1" }] }), "error");
		assert.equal(classifyBgWaitOutcome(true, undefined), "error");
	});

	it("completions 非空 → success（真的等到了结果，绿点）", () => {
		assert.equal(classifyBgWaitOutcome(false, { mode: "management", results: [], completions: [{ runId: "bg_1" }] }), "success");
	});

	it("没等到 / 时间窗到了 / 让路 / 无 details → declined（灰点，不是错）", () => {
		// `bg_wait id="bg_1"` 而 bg_1 不存在时的真实返回：No active run matched …
		assert.equal(classifyBgWaitOutcome(false, { mode: "management", results: [] }), "declined");
		assert.equal(
			classifyBgWaitOutcome(false, { mode: "management", results: [], wait: { reason: "window_elapsed", timedOut: true } }),
			"declined",
		);
		assert.equal(classifyBgWaitOutcome(false, { completions: [] }), "declined", "空数组不算等到结果");
		assert.equal(classifyBgWaitOutcome(false, undefined), "declined");
		assert.equal(classifyBgWaitOutcome(false, "not-an-object"), "declined");
	});

	it("completions 不是数组时不算成功（形状认不出就不画绿点）", () => {
		assert.equal(classifyBgWaitOutcome(false, { completions: "bg_1" }), "declined");
	});
});

describe("工具块标题装饰（只有圆点、无任何标记）", () => {
	it("成功：只有绿点（任务才刚开始，✔ 只属于终态通知）", () => {
		assert.deepEqual(bgToolTitleParts("success"), { dotSlot: "success" });
	});

	it("没成但不是错：只有灰点（✘ 也不要：圆点已表达结局，正文里已写了原因）", () => {
		assert.deepEqual(bgToolTitleParts("declined"), { dotSlot: "dim" });
	});

	it("真错误：只有红点", () => {
		assert.deepEqual(bgToolTitleParts("error"), { dotSlot: "error" });
	});

	it("执行中：灰点", () => {
		assert.deepEqual(bgToolTitleParts("pending"), { dotSlot: "dim" });
	});
});

describe("终态通知标题装饰（只要结束就是 ✔，成败靠圆点颜色）", () => {
	it("成功：绿点 + 行末绿 ✔", () => {
		assert.deepEqual(bgNotificationTitleParts("success"), { dotSlot: "success", mark: "✔", markSlot: "success" });
	});

	it("失败：红点 + 行末**红 ✔**（不是 ✘：✔ 断言的是「结束」而非「成功」）", () => {
		assert.deepEqual(bgNotificationTitleParts("error"), { dotSlot: "error", mark: "✔", markSlot: "error" });
	});

	it("其余态（实际走不到）同样是 ✔，点色与工具块同源", () => {
		assert.deepEqual(bgNotificationTitleParts("declined"), { dotSlot: "dim", mark: "✔", markSlot: "dim" });
		assert.deepEqual(bgNotificationTitleParts("pending"), { dotSlot: "dim", mark: "✔", markSlot: "dim" });
	});

	it("四态都不会出现 ✘", () => {
		for (const outcome of ["success", "declined", "error", "pending"] as const) {
			assert.equal(bgNotificationTitleParts(outcome).mark, "✔", `${outcome} 应为 ✔`);
		}
	});
});

describe("树前缀（└ 跟到最后一行）", () => {
	it("0 行 → 空数组，1 行 → 单个 └", () => {
		assert.deepEqual(bgResultTreePrefixes(0), []);
		assert.deepEqual(bgResultTreePrefixes(1), [TREE_LAST]);
	});

	it("多行：除末行外全是 │，末行是 └", () => {
		assert.deepEqual(bgResultTreePrefixes(2), [TREE_PIPE, TREE_LAST]);
		assert.deepEqual(bgResultTreePrefixes(3), [TREE_PIPE, TREE_PIPE, TREE_LAST]);
		const five = bgResultTreePrefixes(5);
		assert.equal(five.length, 5);
		assert.equal(five[4], TREE_LAST);
		assert.ok(five.slice(0, 4).every((prefix) => prefix === TREE_PIPE));
	});
});

describe("正文颜色（与 bash 工具调用后的输出同色）", () => {
	it("第一优先级是皮肤 `vars.bashOutput`：pi 1.2.0 起自定义色只能写在 vars 里", () => {
		assert.equal(BODY_TEXT_VAR, "bashOutput");
	});

	it("回退是 toolOutput 这个官方槽位（皮肤没定义 bashOutput 时）", () => {
		assert.equal(BODY_TEXT_TOKEN, "toolOutput");
	});
});

describe("几何常量（与 plan 块同一张表）", () => {
	it("正文缩进 2 列、gutter 2 列：• 列 0 / │└ 列 2 / 正文列 4", () => {
		assert.equal(BODY_INDENT, "  ");
		assert.equal(GUTTER_WIDTH, 2);
		assert.equal(BODY_INDENT.length + GUTTER_WIDTH, 4, "正文从列 4 起");
	});

	it("预览上限与 pi 默认壳的 FALLBACK_PREVIEW_LINES 同值（换 self 壳后截断不回归）", () => {
		assert.equal(PREVIEW_MAX_LINES, 10);
	});
});

describe("预览截断提示", () => {
	it("单数 / 复数分别拼 line / lines", () => {
		assert.equal(previewMoreLinesHint(1), "… (1 more line, ctrl+o to expand)");
		assert.equal(previewMoreLinesHint(12), "… (12 more lines, ctrl+o to expand)");
	});
});

/** 纯 ASCII 的宽度就是长度（真宽度 O(1) 的替身，测试不需要 grapheme 那套）。 */
const charWidth = (text: string): number => text.length;

const LONG_LOG_PATH = "/Users/bachi/.pi/agent/bg-tasks/01a18021-01d6-7772-a70f-50049cc64d61/bg_2.log";

describe("日志行永不折行（太长就把前面换成 …）", () => {
	it("不是日志行（没有 Log: / Full log: 前缀）原样返回", () => {
		const line = "offset 0 → 6";
		assert.equal(fitLogLine(line, 10, charWidth), line);
		assert.equal(fitLogLine("Log:/no-space", 10, charWidth), "Log:/no-space");
	});

	it("放得下就一个字都不动（标签后仍是一个空格）", () => {
		const line = `Log: ${LONG_LOG_PATH}`;
		assert.equal(fitLogLine(line, line.length, charWidth), line);
		assert.equal(fitLogLine(line, 500, charWidth), line);
	});

	it("放不下：去掉标签后的空格，前面换成 …，只留能塞下的尾部", () => {
		const line = `Log: ${LONG_LOG_PATH}`;
		const fitted = fitLogLine(line, 74, charWidth);
		assert.equal(fitted.length, 74, `缩略后要正好吃满预算：${JSON.stringify(fitted)}`);
		assert.ok(fitted.startsWith("Log:…"), `缩略形态是 Log:…（无空格）：${JSON.stringify(fitted)}`);
		assert.ok(fitted.endsWith("bg_2.log"), `尾部（文件名）要留下来：${JSON.stringify(fitted)}`);
		assert.ok(LONG_LOG_PATH.endsWith(fitted.slice("Log:…".length)), "留下的必须是原路径的连续尾部");
	});

	it("Full log: 是同一套处理（终态通知正文用这个标签）", () => {
		const fitted = fitLogLine(`Full log: ${LONG_LOG_PATH}`, 40, charWidth);
		assert.equal(fitted.length, 40);
		assert.ok(fitted.startsWith("Full log:…"), JSON.stringify(fitted));
		assert.ok(fitted.endsWith("bg_2.log"));
	});

	it("窄到只放得下省略号时退化成 `Log:…`（绝不超预算）", () => {
		assert.equal(fitLogLine(`Log: ${LONG_LOG_PATH}`, 5, charWidth), "Log:…");
		assert.equal(fitLogLine(`Log: ${LONG_LOG_PATH}`, 4, charWidth), "Log:…", "预算比前缀+…还小时也不折行");
		assert.equal(fitLogLine(`Log: ${LONG_LOG_PATH}`, 0, charWidth), "Log:…");
	});

	it("按注入的宽度函数算，不按字符数（宽字符 / 转义串才算得准）", () => {
		// 每个字符按 2 列算：预算 20 ⇒ `Log:` 4 + `…` + 最多 7 个字符
		const wide = (text: string): number => Array.from(text).length * 2;
		const fitted = fitLogLine(`Log: ${LONG_LOG_PATH}`, 20, wide);
		assert.ok(wide(fitted) <= 20, `宽度不能超预算：${JSON.stringify(fitted)}`);
		assert.ok(fitted.endsWith("g"), "尾部字符还在（宽度算法不同只是留得少一点）");
	});
});
