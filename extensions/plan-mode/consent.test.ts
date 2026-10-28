/**
 * Tests for consent.ts — 两个弹框的正文包装（线框 + 配色）。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/consent.test.ts
 *
 * 这里断言的是**结构**（哪段走了哪个色槽、框封没封边、宽度对不对），不是观感：
 * `painted` 主题把每段包成 `slot(text)`，于是能看出正文是 `text(...)`、边框是 `dim(...)`。
 * 真弹出时的呈现由 pi 的 ExtensionSelectorComponent 决定（已用真主题 + 真组件验证）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BODY_SLOT, buildApprovalTitle, buildConsentTitle, paintBody } from "./consent.ts";
import { bodyTextWidth, type FrameDeps } from "./frame.ts";

const plain = { fg: (_color: string, text: string) => text };
const painted = { fg: (color: string, text: string) => `${color}(${text})` };

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");
}

/** 与 pi-tui `visibleWidth` 同口径：ANSI 不计，CJK / 全角算 2 列。 */
function measure(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) {
		const code = char.codePointAt(0)!;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/** 按可见宽度硬断（生产注入 pi-tui 的 wrapTextWithAnsi）。 */
function wrap(text: string, width: number): string[] {
	if (text === "") return [""];
	const rows: string[] = [];
	let current = "";
	let used = 0;
	for (const char of text) {
		const charWidth = measure(char);
		if (used + charWidth > width && used > 0) {
			rows.push(current);
			current = char;
			used = charWidth;
			continue;
		}
		current += char;
		used += charWidth;
	}
	if (current !== "") rows.push(current);
	return rows.length > 0 ? rows : [""];
}

const frame = (columns = 40): FrameDeps => ({ columns, wrap, measure });

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
	const parts = {
		title: "Plan mode:",
		reason: "跨三端配置",
		planLine: "Enter plan mode (read-only): explore read-only and propose a plan; work starts only after you approve",
		implLine: "Implement directly: skip planning and act on your instruction now",
	};

	it("首行标题不上色（归组件的 accent），正文装进线框", () => {
		const title = buildConsentTitle(painted, parts, frame());
		assert.ok(title.startsWith("Plan mode:\n\n"), "标题行必须原样在最前");
		assert.ok(!title.startsWith("accent("), "标题本身不该被本模块上色");
		const lines = title.split("\n");
		assert.match(lines[2]!, /^dim\(┌─+┐\)$/, "标题空一行之后就是框的上边");
		assert.match(lines[lines.length - 1]!, /^dim\(└─+┘\)$/);
	});

	it("理由与两条路线说明在同一个框里，中间空一行", () => {
		const lines = buildConsentTitle(plain, parts, frame()).split("\n");
		assert.equal(lines[2], "┌" + "─".repeat(bodyTextWidth(40) + 2) + "┐");
		const body = lines.slice(3, -1);
		const blank = body.findIndex((line) => /^│ +│$/.test(line));
		assert.ok(blank > 0, "理由与路线说明之间要有一行留白");
		assert.match(body[blank - 1]!, /Its reason: 跨三端配置/);
		assert.match(body[blank + 1]!, /Enter plan mode/);
	});

	it("没有理由时框里只剩路线说明（不留空段）", () => {
		const title = buildConsentTitle(plain, { ...parts, reason: undefined }, frame());
		assert.ok(!title.includes("Its reason"));
		const body = title.split("\n").slice(3, -1);
		assert.ok(!body.some((line) => /^│ +│$/.test(line)), "不保留理由那一行的空白");
		assert.match(body.join("\n").replace(/\s+/g, ""), /Enterplanmode.*Implementdirectly/, "两条路线都在，且紧挨着");
	});

	it("空字符串理由等同没有理由", () => {
		const base = { title: parts.title, planLine: parts.planLine, implLine: parts.implLine };
		assert.equal(
			buildConsentTitle(plain, { ...base, reason: "" }, frame()),
			buildConsentTitle(plain, base, frame()),
		);
	});

	it("纯文本主题下只有边框与正文，没有多余空行", () => {
		const title = buildConsentTitle(plain, parts, frame(40));
		const lines = title.split("\n");
		assert.equal(lines[0], parts.title);
		assert.equal(lines[1], "", "标题与框之间空一行");
		assert.match(lines[2]!, /^┌─+┐$/);
		assert.equal(lines[lines.length - 1]!.startsWith("└"), true);
	});

	it("框撑满终端宽度：每一行可见宽度都等于列数", () => {
		const lines = buildConsentTitle(plain, { ...parts, reason: "长".repeat(120) }, frame(60)).split("\n");
		for (const line of lines.slice(2)) assert.equal(measure(line), 60, `宽度不一致：${line}`);
	});
});

describe("审批弹框的 title", () => {
	it("问题行留 accent，计划正文装进线框", () => {
		const title = buildApprovalTitle(painted, "# 方案\n\n改 `adapter/index.js`", frame());
		assert.ok(title.startsWith("Approve this plan?\n\n"));
		assert.ok(!title.startsWith("accent("), "标题行不该被本模块上色（组件会给它 accent）");
		const lines = title.split("\n");
		assert.match(lines[2]!, /^dim\(┌─+┐\)$/);
		assert.match(lines[lines.length - 1]!, /^dim\(└─+┘\)$/);
	});

	it("计划里的空行封边而不是断开框", () => {
		const lines = buildApprovalTitle(plain, "A\n\nC", frame(40)).split("\n");
		assert.equal(lines.length, 2 + 1 + 3 + 1, "标题 + 空行 + 上边 + 3 行正文 + 下边");
		assert.match(lines[4]!, /^│ +│$/);
		for (const line of lines.slice(2)) assert.equal(measure(line), 40);
	});

	it("长计划折行后每一片都封边，行数与内宽口径一致", () => {
		const plan = "x".repeat(300);
		const lines = buildApprovalTitle(plain, plan, frame(40)).split("\n");
		assert.equal(lines.length, 2 + 1 + Math.ceil(300 / bodyTextWidth(40)) + 1);
		for (const line of lines.slice(2)) assert.equal(measure(line), 40);
	});

	it("空计划不画框（只留问题行）", () => {
		assert.equal(buildApprovalTitle(plain, "", frame()), "Approve this plan?\n\n");
	});
});
