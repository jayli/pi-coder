/**
 * Tests for consent.ts — 两个弹框的配色包装。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/consent.test.ts
 *
 * 这里断言的是**结构**（哪段走了哪个色槽），不是观感：`painted` 主题把每段包成
 * `slot(text)`，于是能看出正文是 `text(...)` 而标题没有包裹（归组件的 accent）。
 * 真弹出时的呈现由 pi 的 ExtensionSelectorComponent 决定（已用真主题 + 真组件验证：
 * 正文渲染为 `#f8f8f2`、标题与高亮选项仍为 accent）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BODY_SLOT, buildApprovalTitle, buildConsentTitle, paintBody } from "./consent.ts";

const plain = { fg: (_color: string, text: string) => text };
const painted = { fg: (color: string, text: string) => `${color}(${text})` };

describe("paintBody", () => {
	it("每行单独上色（逐行才有色码，整块只加一次开头会被 pi-tui 的行级重置丢掉）", () => {
		assert.equal(paintBody(painted, "第一行\n第二行"), "text(第一行)\ntext(第二行)");
	});

	it("空行跳过：空行只是留白，包上色码没有意义", () => {
		assert.equal(paintBody(painted, "标题\n\n正文"), "text(标题)\n\ntext(正文)");
	});

	it("正文槽是 text（三套本机皮肤里都指向 fg）", () => {
		assert.equal(BODY_SLOT, "text");
	});

	it("纯文本主题下原样返回（测试/headless 里注入的就是这种）", () => {
		assert.equal(paintBody(plain, "第一行\n第二行"), "第一行\n第二行");
	});
});

describe("同意弹框的 title", () => {
	it("首行标题不上色（归组件的 accent），理由与两条路线说明走正文色", () => {
		const title = buildConsentTitle(painted, {
			title: "模型请求进入 plan mode（只读探索）。",
			reason: "跨三端配置",
			planLine: "进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手",
			implLine: "直接实施：跳过规划，现在就按你的指令直接改",
		});
		assert.ok(title.startsWith("模型请求进入 plan mode（只读探索）。\n\n"), "标题行必须原样在最前");
		assert.ok(!title.startsWith("accent("), "标题本身不该被本模块上色");
		assert.match(title, /text\(它的理由：跨三端配置\)/);
		assert.match(title, /text\(进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手\)/);
		assert.match(title, /text\(直接实施：跳过规划，现在就按你的指令直接改\)/);
	});

	it("没有理由时不留空段，标题直接接两条路线说明", () => {
		const title = buildConsentTitle(painted, {
			title: "模型请求进入 plan mode（只读探索）。",
			planLine: "进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手",
			implLine: "直接实施：跳过规划，现在就按你的指令直接改",
		});
		assert.ok(!title.includes("它的理由"), title);
		assert.equal(
			title,
			"模型请求进入 plan mode（只读探索）。\n\n" +
				"text(进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手)\n" +
				"text(直接实施：跳过规划，现在就按你的指令直接改)",
		);
	});

	it("空字符串理由等同没有理由", () => {
		const base = {
			title: "模型请求进入 plan mode（只读探索）。",
			planLine: "P",
			implLine: "I",
		};
		assert.equal(buildConsentTitle(plain, { ...base, reason: "" }), buildConsentTitle(plain, base));
	});

	it("纯文本主题下与原实现逐字一致（不改任何可见文本）", () => {
		const title = buildConsentTitle(plain, {
			title: "模型请求进入 plan mode（只读探索）。",
			reason: "要改多个文件",
			planLine: "进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手",
			implLine: "直接实施：跳过规划，现在就按你的指令直接改",
		});
		assert.equal(
			title,
			"模型请求进入 plan mode（只读探索）。\n\n" +
				"它的理由：要改多个文件\n\n" +
				"进 plan mode（只读探索）：先只读探索、出方案，你批准后才动手\n" +
				"直接实施：跳过规划，现在就按你的指令直接改",
		);
	});
});

describe("审批弹框的 title", () => {
	it("问题行留 accent，计划正文逐行走正文色", () => {
		const title = buildApprovalTitle(painted, "# 方案\n\n改 `adapter/index.js`");
		assert.equal(title, "批准这个计划？\n\ntext(# 方案)\n\ntext(改 `adapter/index.js`)");
		assert.ok(!title.includes("accent("), "标题行不该被本模块上色（组件会给它 accent）");
	});

	it("多行计划每一行都有自己的色码（含 markdown 标题与空行）", () => {
		const title = buildApprovalTitle(painted, "A\nB\n\nC");
		assert.equal(title, "批准这个计划？\n\ntext(A)\ntext(B)\n\ntext(C)");
	});
});
