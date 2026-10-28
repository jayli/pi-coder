/**
 * Tests for prompt-editor/slash-menu.ts — 补全菜单「选中行」配色（用户 2026-10-28 定）。
 *
 * Run with:  node --test clients/pi/extensions/prompt-editor/slash-menu.test.ts
 *
 * 全部是纯字符串断言，不起 TUI。真编辑器上的端到端在 `render.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	isSelectedAutocompleteRow,
	paintAutocompleteRows,
	paintSelectedRow,
	resolveSlashMenuHighlight,
	SELECTED_PREFIX,
	stripAnsi,
} from "./slash-menu.ts";

/** 假的选中行着色：acc=前景、selBg=底色（跟真主题一样是两条独立 SGR）。 */
const FG = "\x1b[38;2;134;171;220m";
const BG = "\x1b[48;2;60;83;114m";
const paint = (text: string) => `${FG}${BG}${text}\x1b[49m\x1b[39m`;
/** 宽度量测：测试行全是 ASCII，所以字符数 = 列数。 */
const widthOf = (text: string) => text.length;

/** 一条未补白的选中行（`SelectList.renderItem` 去掉行尾 padding 之后的样子）。 */
const SELECTED = "\x1b[38;2;134;171;220m→ help\x1b[39m\x1b[38;2;90;90;90m  Show shortcuts\x1b[39m";

test("选中行：剥掉原 SGR 后整行套上「accent 前景 + selectedBg 底色」", () => {
	const painted = paintSelectedRow(SELECTED, { paint });
	assert.equal(painted, `${FG}${BG}→ help  Show shortcuts\x1b[49m\x1b[39m`);
	// 可见文字一个字符都不能变（宽度不变 = 不会把折行 / 补白挤歪）
	assert.equal(stripAnsi(painted), stripAnsi(SELECTED));
});

test("整行铺满：行首 gutter 空白列与行尾补白全部在着色区之内（用户 2026-10-28 定）", () => {
	// 选中行总是以 `→ ` 开头；带前导空白的是「列表左移之后仍有空白」的形态
	const line = `  ${SELECTED}      `;
	const painted = paintSelectedRow(line, { paint });
	assert.equal(
		painted,
		`${FG}${BG}  → help  Show shortcuts      \x1b[49m\x1b[39m`,
		"连末尾六格补白一起包在 SGR 里",
	);
	assert.equal(stripAnsi(painted), stripAnsi(line));
});

test("`padTo`：先补到目标宽度再上色，补白也带底色（不留在 SGR 外面）", () => {
	const painted = paintSelectedRow(SELECTED, { paint, padTo: 40, widthOf });
	const plain = stripAnsi(painted);
	assert.equal(plain, `→ help  Show shortcuts${" ".repeat(40 - "→ help  Show shortcuts".length)}`);
	assert.equal(plain.length, 40, "补到目标宽度");
	// 关掉底色的 SGR 必须在整行最后一个字符之后，且中途不掉色（只有末尾那一个 `\x1b[49m`）
	assert.equal(painted.startsWith(`${FG}${BG}`), true, "底色从行首就开着");
	assert.equal(painted.endsWith("\x1b[49m\x1b[39m"), true);
	assert.equal(painted.split("\x1b[49m").length, 2, "整行只有末尾一个关底色的 SGR");
});

test("`padTo` 小于当前宽度时不截断（只补不裁）", () => {
	const painted = paintSelectedRow(SELECTED, { paint, padTo: 5, widthOf });
	assert.equal(stripAnsi(painted), stripAnsi(SELECTED));
});

test("未选中行原样返回同一个字符串（不造新对象、也不上底色、也不补宽）", () => {
	const plainRow = "  compact  Compact the conversation";
	const styled = "\x1b[2m  model\x1b[22;39m";
	assert.equal(paintSelectedRow(plainRow, { paint, padTo: 40, widthOf }), plainRow);
	assert.equal(paintSelectedRow(styled, { paint, padTo: 40, widthOf }), styled);
});

test("空行 / 只有空白的行不上色（滚动提示行是 (1/42)，不含 → 前缀，同样不动）", () => {
	assert.equal(paintSelectedRow("", { paint }), "");
	assert.equal(paintSelectedRow("        ", { paint }), "        ");
	const scrollInfo = "\x1b[2m  (3/42)\x1b[22;39m";
	assert.equal(paintSelectedRow(scrollInfo, { paint }), scrollInfo);
});

test("整帧重绘只改选中那一行；没有选中行时返回同一个数组", () => {
	const lines = ["─".repeat(10), "  compact  Compact", SELECTED, "", "  help  Show shortcuts"];
	const out = paintAutocompleteRows(lines, { paint });
	assert.notEqual(out, lines, "有改动 → 新数组");
	assert.equal(out[0], lines[0]);
	assert.equal(out[1], lines[1]);
	assert.ok(out[2]!.includes(BG), "选中行铺了底色");
	assert.equal(out[3], lines[3]);
	assert.equal(out[4], lines[4]);

	const untouched = ["  compact  Compact", "  help  Show shortcuts"];
	assert.equal(
		paintAutocompleteRows(untouched, { paint, padTo: 40, widthOf }),
		untouched,
		"没有改动 → 原数组（不喂新对象给差分渲染器）",
	);
});

test("`→ ` 前缀的判定：前导空白不敏感，描述里的箭头不误伤", () => {
	assert.equal(isSelectedAutocompleteRow(SELECTED), true);
	assert.equal(isSelectedAutocompleteRow(`  ${SELECTED_PREFIX}model`), true);
	assert.equal(isSelectedAutocompleteRow("  compact"), false);
	assert.equal(isSelectedAutocompleteRow("  run → later  desc"), false, "非行首的箭头不算选中");
	assert.equal(isSelectedAutocompleteRow(""), false);
});

test("开关：只有 off 关闭（大小写 / 前后空白都算）", () => {
	assert.equal(resolveSlashMenuHighlight(undefined), true);
	assert.equal(resolveSlashMenuHighlight(""), true);
	assert.equal(resolveSlashMenuHighlight("on"), true);
	assert.equal(resolveSlashMenuHighlight("off"), false);
	assert.equal(resolveSlashMenuHighlight(" OFF "), false);
});
