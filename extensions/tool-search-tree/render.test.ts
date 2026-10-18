/**
 * Tests for render.ts — 内置 tool_search 工具块的展示形态纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/tool-search-tree/render.test.ts
 *
 * render.ts 不 import pi / pi-tui，所以这里直接断言标题装配、结局分类、树前缀、预览截断
 * 这些**决定**（接线与折行在 index.ts 那侧，由 index.test.ts 走真加载器覆盖）。
 * 与 memory/render.test.ts 同形。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BODY_INDENT,
	DEFAULT_TOOL_SEARCH_LIMIT,
	GUTTER_WIDTH,
	PREVIEW_MAX_LINES,
	TREE_LAST,
	TREE_PIPE,
	classifyToolSearchOutcome,
	previewMoreLinesHint,
	toolSearchLimitSuffix,
	toolSearchQueryText,
	toolSearchResultToolLineLength,
	toolSearchResultTreePrefixes,
	toolSearchTitleLine,
	toolSearchTitleParts,
	TOOL_SEARCH_NAME,
} from "./render.ts";

/** 测试替身主题：原样透传文本，断言看纯文本结构（着色由 index.test.ts 走真主题覆盖）。 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** 记录每次 `fg(slot, text)` 的调用 —— 上色顺序与槽位在这层断言，真色值交给 index.test.ts。 */
function recordingTheme() {
	const calls: Array<{ slot: string; text: string }> = [];
	return {
		calls,
		theme: {
			fg: (slot: string, text: string) => {
				calls.push({ slot, text });
				return text;
			},
			bold: (text: string) => text,
		},
	};
}

/** 一行的可见宽度（粗略 wcwidth：CJK / 全角记 2 列）—— 与 render.ts 内部同一套口径。 */
function visibleWidth(line: string): string["length"] {
	let width = 0;
	for (const ch of Array.from(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			code >= 0x1100 &&
			(code <= 0x115f ||
				code === 0x2329 ||
				code === 0x232a ||
				(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff00 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x20000 && code <= 0x3fffd));
		width += wide ? 2 : 1;
	}
	return width;
}

describe("标题行装配（toolSearchTitleLine）", () => {
	it("基本形状：`• tool_search <query>`，圆点在列 0", () => {
		const line = toolSearchTitleLine({ query: "memory 渲染" }, 100, "•", plainTheme);
		assert.ok(line.startsWith("• "), `应以圆点开头：${line}`);
		assert.ok(line.includes("tool_search"), `应含工具名：${line}`);
		assert.ok(line.includes("memory 渲染"), `应含 query：${line}`);
	});

	it("limit ≠ 默认 8 时追加 ` · limit=N`；缺省或等于 8 时不出现", () => {
		assert.ok(toolSearchTitleLine({ query: "x", limit: 9 }, 100, "•", plainTheme).includes("· limit=9"));
		assert.ok(!toolSearchTitleLine({ query: "x" }, 100, "•", plainTheme).includes("limit"));
		assert.ok(!toolSearchTitleLine({ query: "x", limit: 8 }, 100, "•", plainTheme).includes("limit"));
	});

	it("query 缺失 / 非字符串 / 空白 → 占位符 …（参数还没流完）", () => {
		assert.ok(toolSearchTitleLine(undefined, 100, "•", plainTheme).includes("…"));
		assert.ok(toolSearchTitleLine({}, 100, "•", plainTheme).includes("…"));
		assert.ok(toolSearchTitleLine({ query: "   " }, 100, "•", plainTheme).includes("…"));
		assert.ok(toolSearchTitleLine({ query: 42 }, 100, "•", plainTheme).includes("…"));
	});

	it("query 内部空白折叠为单空格", () => {
		const line = toolSearchTitleLine({ query: "a\n  b\tc" }, 100, "•", plainTheme);
		assert.ok(line.includes("a b c"), `空白应折叠：${line}`);
		assert.ok(!/[\n\t]/.test(line), "不得残留换行 / 制表符");
	});

	it("query 过长时截断为单行并补 …（宽 30）", () => {
		const query = "x".repeat(100);
		const line = toolSearchTitleLine({ query }, 30, "•", plainTheme);
		assert.equal(Array.from(line.split("\n")).length, 1, "标题必须单行");
		assert.ok(visibleWidth(line) <= 30, `可见宽度 ${visibleWidth(line)} 超过 30：${line}`);
		assert.ok(line.endsWith("…"), `截断应以 … 收尾：${line}`);
	});

	it("CJK query 按宽字符计宽截断（宽 30，不会超出）", () => {
		const query = "查".repeat(40);
		const line = toolSearchTitleLine({ query }, 30, "•", plainTheme);
		assert.ok(visibleWidth(line) <= 30, `可见宽度 ${visibleWidth(line)} 超过 30：${line}`);
	});

	it("query 里的 ANSI 转义被剥掉（不得污染标题）", () => {
		const line = toolSearchTitleLine({ query: "\u001b[31mred\u001b[39m query" }, 100, "•", plainTheme);
		assert.ok(!line.includes("\u001b"), `不得残留转义序列：${JSON.stringify(line)}`);
		assert.ok(line.includes("red query"), `正文应保留：${line}`);
	});

	it("宽度极小时不抛异常：query 收缩为占位符（固定前缀 · 圆点与工具名不可截）", () => {
		const line = toolSearchTitleLine({ query: "a long query string" }, 5, "•", plainTheme);
		assert.ok(line.endsWith("…"), `query 应回缩到 …：${line}`);
		// 真实宽度档位上不超宽（固定前缀 14 列 + 最小正文预算）
		for (const width of [30, 40, 80, 100]) {
			const wide = toolSearchTitleLine({ query: "a long query string" }, width, "•", plainTheme);
			assert.ok(visibleWidth(wide) <= width, `width=${width} 超宽：${visibleWidth(wide)}`);
		}
	});
});

describe("正文工具条目的着色前缀（toolSearchResultToolLineLength）", () => {
	it("命中内置 execute 的 `- <name>: <描述>` 行：前缀含 `- ` 与冒号", () => {
		assert.equal(
			toolSearchResultToolLineLength("- memory_read: Read one memory's full body by name."),
			"- ".length + "memory_read".length + 1,
		);
		assert.equal(toolSearchResultToolLineLength("- mcp__dingtalk_contact__search_user_by_mobile: 通过手机号搜索"), 47);
	});

	it("工具名里的 `-` `.` `/` `__` 都能识别（MCP / 带连字符与点的工具名）", () => {
		for (const name of ["fetch-content.v2", "repo-bot/search_knowledge", "web_search"]) {
			assert.equal(toolSearchResultToolLineLength(`- ${name}: 描述`), 2 + name.length + 1, `应识别：${name}`);
		}
	});

	it("非工具条目行一律 0：标题句 / 空行 / 缩进行 / 无冒号", () => {
		assert.equal(toolSearchResultToolLineLength("Loaded 2 tools. They are available from your next call:"), 0);
		assert.equal(toolSearchResultToolLineLength(""), 0);
		assert.equal(toolSearchResultToolLineLength("  - memory_read: 缩进两格"), 0, "只认行首的 `- `");
		assert.equal(toolSearchResultToolLineLength("- memory_read 没冒号"), 0);
		assert.equal(toolSearchResultToolLineLength("- : 空名字"), 0, "名字不得为空");
		assert.equal(toolSearchResultToolLineLength("- memory read: 名字带空格"), 0, "名字不含空白（否则会吃掉描述）");
	});

	it("描述里再出现 `- x:` 不会被误着色（只有行首那一段是前缀）", () => {
		const line = "- tool_a: 描述里提到 - tool_b: 是举例";
		assert.equal(toolSearchResultToolLineLength(line), 2 + "tool_a".length + 1);
	});
});

describe("标题里的工具名着色（用户 2026-10-18 定：toolTitle）", () => {
	it("工具名走 toolTitle，且是第一个着色段（与 memory 标题同形）", () => {
		const { calls, theme } = recordingTheme();
		const line = toolSearchTitleLine({ query: "q" }, 100, "•", theme);
		assert.deepEqual(calls[0], { slot: "toolTitle", text: TOOL_SEARCH_NAME }, `第一个着色段：${JSON.stringify(calls)}`);
		assert.ok(line.includes(TOOL_SEARCH_NAME), `工具名仍在标题里：${line}`);
	});

	it("query 文本走 text 槽（工具名已着色，query 不再重复上色）", () => {
		const { calls, theme } = recordingTheme();
		toolSearchTitleLine({ query: "memory 渲染" }, 100, "•", theme);
		assert.deepEqual(
			calls.map((call) => call.slot),
			["toolTitle", "text"],
			`槽位顺序：${JSON.stringify(calls)}`,
		);
		assert.equal(calls[1]!.text, "memory 渲染");
	});

	it("折行预算按纯文本工具名算（SGR 不得被当成可见列）", () => {
		const width = 34;
		const colored = toolSearchTitleLine({ query: "a".repeat(100) }, width, "•", {
			fg: (slot: string, text: string) => (slot === "toolTitle" ? `\u001b[38;2;1;2;3m${text}\u001b[39m` : text),
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		});
		const plainLine = toolSearchTitleLine({ query: "a".repeat(100) }, width, "•", plainTheme);
		const strip = (text: string) => text.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");
		assert.equal(strip(colored), plainLine, "上色不得改变可见文本的长度 / 内容");
	});
});

describe("query / limit 的拆分（toolSearchQueryText / toolSearchLimitSuffix）", () => {
	it("query：折叠空白 + 剥 ANSI + 空占位", () => {
		assert.equal(toolSearchQueryText({ query: "  a\tb  " }), "a b");
		assert.equal(toolSearchQueryText({ query: "\u001b[31mx\u001b[39m" }), "x");
		assert.equal(toolSearchQueryText({}), "…");
		assert.equal(toolSearchQueryText(undefined), "…");
	});

	it("limit：仅非默认正整数有尾缀", () => {
		assert.equal(toolSearchLimitSuffix({ limit: 3 }), " · limit=3");
		assert.equal(toolSearchLimitSuffix({}), "");
		assert.equal(toolSearchLimitSuffix({ limit: 8 }), "");
		assert.equal(toolSearchLimitSuffix({ limit: 0 }), "");
		assert.equal(toolSearchLimitSuffix({ limit: -1 }), "");
		assert.equal(toolSearchLimitSuffix({ limit: 1.5 }), "");
		assert.equal(toolSearchLimitSuffix({ limit: "9" }), "");
	});
});

describe("结局分类（工具块只有圆点、无任何标记）", () => {
	it("isError → error；否则 success（tool_search 没有 declined 形态）", () => {
		assert.equal(classifyToolSearchOutcome(true), "error");
		assert.equal(classifyToolSearchOutcome(false), "success");
	});

	it("pending / success / error 的点槽：灰 / 绿 / 红", () => {
		assert.deepEqual(toolSearchTitleParts("pending"), { dotSlot: "dim" });
		assert.deepEqual(toolSearchTitleParts("success"), { dotSlot: "success" });
		assert.deepEqual(toolSearchTitleParts("error"), { dotSlot: "error" });
	});

	it("标题 parts 里没有标记字段（✔ / ✘ 都不属于工具块）", () => {
		for (const outcome of ["pending", "success", "error"] as const) {
			const parts = toolSearchTitleParts(outcome) as Record<string, unknown>;
			assert.deepEqual(Object.keys(parts), ["dotSlot"], `${outcome}：只有 dotSlot 一个字段`);
		}
	});
});

describe("树前缀", () => {
	it("0 行 → 空数组；1 行 → 只有 └；多行 → 除末行外 │", () => {
		assert.deepEqual(toolSearchResultTreePrefixes(0), []);
		assert.deepEqual(toolSearchResultTreePrefixes(1), [TREE_LAST]);
		assert.deepEqual(toolSearchResultTreePrefixes(3), [TREE_PIPE, TREE_PIPE, TREE_LAST]);
	});

	it("└ 只在末行出现一次", () => {
		const prefixes = toolSearchResultTreePrefixes(5);
		assert.equal(prefixes.filter((p) => p === TREE_LAST).length, 1);
		assert.equal(prefixes[4], TREE_LAST);
	});
});

describe("几何常量（与 memory / plan / 后台任务块同一张表）", () => {
	it("• 列 0、│/└ 列 2、正文列 4（正文对齐工具名首字母 t）", () => {
		assert.equal(BODY_INDENT, "  ", "正文树前导缩进 2 列");
		assert.equal(GUTTER_WIDTH, 2, "树形 gutter 2 列（box-drawing 字符 + 空格）");
		assert.equal(TREE_PIPE, "│ ");
		assert.equal(TREE_LAST, "└ ");
	});

	it("预览上限与 pi 默认壳的 FALLBACK_PREVIEW_LINES 同值", () => {
		assert.equal(PREVIEW_MAX_LINES, 10);
	});

	it("默认 limit 与内置 DEFAULT_TOOL_SEARCH_LIMIT 同值（8）", () => {
		assert.equal(DEFAULT_TOOL_SEARCH_LIMIT, 8);
	});
});

describe("预览截断提示", () => {
	it("与 pi 默认壳同族：… (N more lines, ctrl+o to expand)", () => {
		assert.equal(previewMoreLinesHint(1), "… (1 more line, ctrl+o to expand)");
		assert.equal(previewMoreLinesHint(4), "… (4 more lines, ctrl+o to expand)");
	});
});
