/**
 * Tests for title-row.ts — `Edit` / `Write` 标题行的纯排版（预算分配、按宽度截断、状态圆点、行数缩略）。
 *
 * Run with:  node --test clients/pi/extensions/tool-diff/title-row.test.ts
 *
 * 被测模块不 import pi / pi-tui（宽度与截断函数都是注入的），所以这里喂假实现：
 * ASCII = 1 列、CJK = 2 列；`•`（U+2022）、`⋮`、`…` 都是 1 列 —— 与 pi-tui 的 `visibleWidth`
 * 已核对一致。主题的 `fg` 换成恒等函数，断言里直接看纯文本。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BLINK_MARKER,
	DOT_MARKER,
	ELLIPSIS,
	PLACEHOLDER_PATH,
	TitleRow,
	formatCount,
	loadingSuffix,
	pathPlaceholder,
	shortenPath,
	statsSuffix,
	statusDot,
	truncateStartToWidth,
	type TitleRowDeps,
	type TitleTheme,
} from "./title-row.ts";

/** 恒等主题：不着色，断言直接比对纯文本。 */
const plainTheme: TitleTheme = { fg: (_color, text) => text };

/** 假宽度函数：CJK 常见全角区间按 2 列，其余按 1 列。 */
function widthOf(text: string): number {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
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

/** 假截断函数（生产环境传 pi-tui 的 truncateToWidth）：从尾部硬切，够用。 */
function truncateToWidth(text: string, width: number, ellipsis = ELLIPSIS): string {
	if (widthOf(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const w = widthOf(ch);
		if (used + w > width - widthOf(ellipsis)) break;
		out += ch;
		used += w;
	}
	return out + ellipsis;
}

function deps(home = "/Users/me"): TitleRowDeps {
	return { widthOf, truncateToWidth, home, indent: " " };
}

/** 一条必须从头部截断才能放进 90 列的深层路径。 */
const LONG_PATH =
	"/Users/me/work/project/packages/renderer/src/components/inner/deep/deeper/deepest/final/renderer-impl.ts";

function titleLine(path: string, suffix: string, width: number, rowDeps: TitleRowDeps = deps()): string {
	return new TitleRow(rowDeps, plainTheme, DOT_MARKER, "Write", path, suffix).render(width)[0] ?? "";
}

describe("statusDot: 行首结局灯的色槽", () => {
	/** 记录 fg 调用的主题 */
	function recorder(): { theme: TitleTheme; calls: Array<[string, string]> } {
		const calls: Array<[string, string]> = [];
		return {
			calls,
			theme: {
				fg: (color, text) => {
					calls.push([color, text]);
					return text;
				},
			},
		};
	}

	it("paints pending dim and success / error with the diff green / red", () => {
		for (const [state, slot] of [
			["pending", "dim"],
			["success", "toolDiffAdded"],
			["error", "toolDiffRemoved"],
		] as const) {
			const { theme, calls } = recorder();
			assert.equal(statusDot(theme, state), DOT_MARKER);
			assert.deepEqual(calls, [[slot, DOT_MARKER]]);
		}
	});

	it("is one column wide and carries no trailing blank (the gap belongs to TitleRow)", () => {
		assert.equal(widthOf(statusDot(plainTheme, "pending")), 1);
		assert.equal(statusDot(plainTheme, "pending"), DOT_MARKER);
	});
});

describe("pathPlaceholder: 路径未到时的占位符（用户 2026-10-28 定）", () => {
	it("substitutes `files` only when the path is still empty", () => {
		assert.equal(pathPlaceholder(""), PLACEHOLDER_PATH);
		assert.equal(PLACEHOLDER_PATH, "files");
	});

	it("passes a real path through untouched", () => {
		assert.equal(pathPlaceholder("src/index.ts"), "src/index.ts");
	});

	it("keeps the title line shaped `• Write files ●` while loading", () => {
		const line = new TitleRow(deps(), plainTheme, DOT_MARKER, "Write", pathPlaceholder(""), loadingSuffix(plainTheme, true)).render(60)[0] ?? "";
		assert.equal(line, ` ${DOT_MARKER} Write ${PLACEHOLDER_PATH} ${BLINK_MARKER}`);
	});
});

describe("loadingSuffix: 载入中的闪烁标记", () => {
	/** 记录 fg 调用的主题 */
	function recorder(): { theme: TitleTheme; calls: Array<[string, string]> } {
		const calls: Array<[string, string]> = [];
		return {
			calls,
			theme: {
				fg: (color, text) => {
					calls.push([color, text]);
					return text;
				},
			},
		};
	}

	it("is `●` in the dim slot when lit, a single blank when dark", () => {
		const on = recorder();
		assert.equal(loadingSuffix(on.theme, true), BLINK_MARKER);
		assert.deepEqual(on.calls, [["dim", BLINK_MARKER]]);

		const off = recorder();
		assert.equal(loadingSuffix(off.theme, false), " ");
		assert.deepEqual(off.calls, [["dim", " "]]);
	});

	it("**keeps both phases one column** (otherwise the path window jitters every 500ms)", () => {
		assert.equal(widthOf(loadingSuffix(plainTheme, true)), 1);
		assert.equal(widthOf(loadingSuffix(plainTheme, false)), 1);
		assert.notEqual(loadingSuffix(plainTheme, false), "", "灭态不能是空串（那样尾部宽度会掉 2 列）");
	});
});

describe("TitleRow: 行首圆点", () => {
	it("puts the dot in column 1 and the tool name from column 3", () => {
		const line = titleLine("/Users/me/x.ts", "", 60);
		assert.equal(line, ` ${DOT_MARKER} Write ~/x.ts`);
		assert.equal(line.indexOf(DOT_MARKER), 1);
		assert.equal(line.indexOf("Write"), 3);
	});

	it("omits the dot (and its gap) when handed an empty dot string", () => {
		const line = new TitleRow(deps(), plainTheme, "", "Write", "/Users/me/x.ts", "").render(60)[0] ?? "";
		assert.equal(line, " Write ~/x.ts");
	});
});

describe("TitleRow: 长路径截断时行首不被挤得抖动（回归）", () => {
	it("keeps the dot and the suffix intact while truncating the head of the path", () => {
		const line = titleLine(LONG_PATH, statsSuffix(plainTheme, { added: 3, removed: 5 }), 90);
		assert.ok(line.startsWith(` ${DOT_MARKER} Write `), line);
		assert.ok(line.endsWith("(+3 -5)"), line);
		assert.ok(line.includes(ELLIPSIS), line);
		assert.equal(widthOf(line) <= 90, true, line);
	});

	it("keeps the line within the given width across a sweep of terminal widths", () => {
		for (let width = 24; width <= 100; width += 1) {
			const line = titleLine(LONG_PATH, statsSuffix(plainTheme, { added: 123456, removed: 9999 }), width);
			assert.ok(widthOf(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
	});

	it("keeps the tail (file name) visible while dropping the head of a long path", () => {
		const line = titleLine(LONG_PATH, "", 90);
		assert.ok(line.includes(ELLIPSIS), line);
		assert.ok(line.includes("/final/renderer-impl.ts"), line);
		assert.ok(!line.includes("/Users/me/work"), line);
	});
});

describe("TitleRow: 工具名与尾部永远完整", () => {
	it("keeps a wide stats suffix intact and truncates the path instead", () => {
		const line = titleLine(LONG_PATH, statsSuffix(plainTheme, { added: 123456, removed: 9999 }), 90);
		assert.ok(line.endsWith("(+123k -9999)"), line);
		assert.ok(line.includes(ELLIPSIS), line);
		assert.ok(widthOf(line) <= 90, line);
	});

	it("falls back to whole-line truncation when the path budget runs out", () => {
		const line = titleLine(LONG_PATH, statsSuffix(plainTheme, { added: 3, removed: 0 }), 10);
		assert.equal(widthOf(line) <= 10, true, line);
		assert.ok(line.startsWith(` ${DOT_MARKER} `), line);
		assert.ok(line.includes("Write"), line);
	});

	it("renders the streaming-start form (no path yet) without a dangling separator", () => {
		assert.equal(titleLine("", "", 60), ` ${DOT_MARKER} Write`);
	});
});

describe("TitleRow: 路径与缩进", () => {
	it("shortens the home prefix and honours a custom indent", () => {
		const line = titleLine("/Users/me/work/project/src/index.ts", "", 60, {
			...deps(),
			indent: "   ",
		});
		assert.equal(line, `   ${DOT_MARKER} Write ~/work/project/src/index.ts`);
	});

	it("colors the path with the text token, after truncation (ANSI never reaches the measurer)", () => {
		const calls: Array<[string, string]> = [];
		const recordingTheme: TitleTheme = {
			fg: (color, text) => {
				calls.push([color, text]);
				return text;
			},
		};
		new TitleRow(deps(), recordingTheme, "", "Write", LONG_PATH, "").render(90);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.[0], "text");
		assert.ok(calls[0]?.[1].startsWith(ELLIPSIS), calls[0]?.[1]);
	});
});

describe("formatCount", () => {
	it("keeps counts below 10k exact", () => {
		assert.equal(formatCount(0), "0");
		assert.equal(formatCount(1), "1");
		assert.equal(formatCount(9999), "9999");
	});

	it("abbreviates counts at or above 10k with a k suffix", () => {
		assert.equal(formatCount(10_000), "10k");
		assert.equal(formatCount(10_043), "10k");
		assert.equal(formatCount(11_133), "11.1k");
		assert.equal(formatCount(10_450), "10.5k");
		assert.equal(formatCount(99_999), "100k");
		assert.equal(formatCount(123_456), "123k");
		assert.equal(formatCount(1_234_567), "1235k");
	});
});

describe("statsSuffix", () => {
	/** 记录 fg 调用的主题，用来断言着色 token。 */
	function recorder(): { theme: TitleTheme; calls: Array<[string, string]> } {
		const calls: Array<[string, string]> = [];
		return {
			calls,
			theme: {
				fg: (color, text) => {
					calls.push([color, text]);
					return text;
				},
			},
		};
	}

	it("returns an empty string when there is nothing to report", () => {
		assert.equal(statsSuffix(plainTheme, undefined), "");
		assert.equal(statsSuffix(plainTheme, { added: 0, removed: 0 }), "");
	});

	it("omits the side that is zero", () => {
		assert.equal(statsSuffix(plainTheme, { added: 3, removed: 0 }), "(+3)");
		assert.equal(statsSuffix(plainTheme, { added: 0, removed: 5 }), "(-5)");
	});

	it("shows both sides with the diff color tokens", () => {
		const { theme, calls } = recorder();
		assert.equal(statsSuffix(theme, { added: 3, removed: 5 }), "(+3 -5)");
		assert.deepEqual(calls, [
			["toolDiffAdded", "+3"],
			["toolDiffRemoved", "-5"],
			["dim", "("],
			["dim", ")"],
		]);
	});

	it("abbreviates huge counts (the tail must stay narrow)", () => {
		assert.equal(statsSuffix(plainTheme, { added: 10_043, removed: 11_133 }), "(+10k -11.1k)");
	});
});

describe("shortenPath", () => {
	it("shortens the home prefix at a path boundary only", () => {
		assert.equal(shortenPath("/Users/me/work/index.ts", "/Users/me"), "~/work/index.ts");
		assert.equal(shortenPath("/Users/me", "/Users/me"), "~");
		// `/Users/melo` 不该被缩成 `~lo`
		assert.equal(shortenPath("/Users/melo/index.ts", "/Users/me"), "/Users/melo/index.ts");
	});

	it("leaves the path alone without a home directory or outside of it", () => {
		assert.equal(shortenPath("/tmp/renderer.ts", ""), "/tmp/renderer.ts");
		assert.equal(shortenPath("/tmp/renderer.ts", "/Users/me"), "/tmp/renderer.ts");
	});
});

describe("truncateStartToWidth", () => {
	it("returns the text unchanged when it fits", () => {
		assert.equal(truncateStartToWidth("abcdef", 6, widthOf), "abcdef");
	});

	it("keeps the tail and marks the dropped head with an ellipsis", () => {
		assert.equal(truncateStartToWidth("abcdef", 4, widthOf), "…def");
		assert.equal(truncateStartToWidth("abcdef", 1, widthOf), ELLIPSIS);
	});

	it("returns nothing when there is no room at all", () => {
		assert.equal(truncateStartToWidth("abcdef", 0, widthOf), "");
		assert.equal(truncateStartToWidth("abcdef", -3, widthOf), "");
	});

	it("measures CJK characters as two columns", () => {
		assert.equal(truncateStartToWidth("路径文件名", 5, widthOf), "…件名");
	});
});
