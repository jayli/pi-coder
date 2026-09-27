/**
 * Tests for line.ts — the statusline main line and the extension-status line.
 *
 * Run with:  node --test clients/pi/extensions/statusline/line.test.ts
 *
 * line.ts never imports pi / pi-tui, so plain fakes reach every branch: `plain` drops
 * colours (assert exact visible text), `painted` wraps each run as `color(text)` (assert
 * which theme colour slot every part uses).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type StatuslineGitSource,
	type StatuslineSource,
	type StatuslineState,
	type StatuslineTheme,
	BRANCH_ICON,
	MODEL_ICON,
	composeFooterLines,
	ELLIPSIS,
	STATUS_PRIORITY,
	formatExtensionStatuses,
	formatMainLine,
} from "./line.ts";
// 跨目录相对 import：模式指示的 status key 住在 plan-mode 那边，这里只用它锁住
// `STATUS_PRIORITY` 没写错字（两份字面量一旦漂移，排序会静默失效、没有任何报错）。
// 与 `recap` → `simple-task/gap.ts` 同一套取舍：同仓库、同目录树、一起安装。
import { STATUS_KEY as PLAN_MODE_STATUS_KEY } from "../plan-mode/render.ts";
// 后台任务 dock 的保留键住在 background-tasks 那边：这里 import 它而不是重写字面量，
// 两份字面量一旦漂移，下面的用例就会静默测不到真正的 dock 行。
import { STATUS_KEY as BACKGROUND_DOCK_STATUS_KEY } from "../background-tasks/status.ts";

const plain: StatuslineTheme = { fg: (_color, text) => text };
const painted: StatuslineTheme = { fg: (color, text) => `${color}(${text})` };

const FLASH = { id: "qwen3.8-flash" };
const DOC = "\u{1f17c} qwen3.8-flash/xhigh | Ctx 0.0%";

function sourceOf(
	percent: number | null = 0,
	model: { id?: string } | null = FLASH,
	level = "xhigh",
): StatuslineSource {
	const resolved = model === null ? undefined : model;
	return {
		model: resolved,
		thinkingLevel: level,
		getContextUsage: () => (percent === null ? undefined : { percent }),
	};
}

function gitOf(
	branch: string | null,
	statuses: ReadonlyMap<string, string> = new Map(),
): StatuslineGitSource {
	return { getGitBranch: () => branch, getExtensionStatuses: () => statuses };
}

function stateOf(overrides: Partial<StatuslineState> = {}): StatuslineState {
	return { streaming: false, activeTools: new Map(), diffStat: undefined, ...overrides };
}

describe("BRANCH_ICON", () => {
	it("pins the exact code point of the branch glyph", () => {
		// 近形字符很容易贴错（同区块的 ᗋ /  / ᗍ /  长得几乎一样），所以用转义把码位钉死，不依赖裸字形。
		assert.equal(BRANCH_ICON, "\u15cc");
		assert.equal(BRANCH_ICON.codePointAt(0), 0x15cc);
		assert.equal([...BRANCH_ICON].length, 1);
	});
});

describe("MODEL_ICON", () => {
	it("pins the exact code point of the model glyph", () => {
		// 同上：Ⓜ(U+24C2) / 🅜(U+1F15C) 与 🅼(U+1F17C) 近形，用转义钉死码位。
		assert.equal(MODEL_ICON, "\u{1f17c}");
		assert.equal(MODEL_ICON.codePointAt(0), 0x1f17c);
		assert.equal([...MODEL_ICON].length, 1);
	});

	it("is not an RGI emoji, which is what keeps it 1 column wide", () => {
		// pi-tui 的 graphemeWidth 先跑这条正则：命中 → 2 列；不命中 → 落到 eastAsianWidth，
		// U+1F17C 是 Ambiguous → 1 列。Ghostty 默认 unicode 宽度法同样按 1 列摆字，
		// 两边口径一致，`truncateToWidth` 的截断数学才成立。回归：换回 ⚡️ 这类 RGI emoji
		// 会让整行宽 1 列，而这条断言会先失败。
		const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;
		assert.equal(rgiEmojiRegex.test(MODEL_ICON), false);
		// VS16 不改变结论（也不该加：Apple Color Emoji 里没有这个码位，加了只白占一个不可见码位）。
		assert.equal(rgiEmojiRegex.test(`${MODEL_ICON}\uFE0F`), false);
	});
});

describe("formatMainLine", () => {
	it("renders the documented line inside a repo", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(0), gitOf("main"), stateOf({ diffStat: { added: 0, deleted: 0 } })),
			`${DOC} | \u15cc main | (+0,-0)`,
		);
	});

	it("shows real diff counts", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(), gitOf("main"), stateOf({ diffStat: { added: 12, deleted: 3 } })),
			`${DOC} | \u15cc main | (+12,-3)`,
		);
	});

	it("shows zeros before the first git read lands", () => {
		assert.equal(formatMainLine(plain, sourceOf(), gitOf("main"), stateOf()), `${DOC} | \u15cc main | (+0,-0)`);
	});

	it("replaces both git segments outside a repo", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(), gitOf(null), stateOf({ diffStat: { added: 9, deleted: 9 } })),
			`${DOC} | \u15cc no git | (no git)`,
		);
	});

	it("renders a detached head", () => {
		assert.ok(formatMainLine(plain, sourceOf(), gitOf("detached"), stateOf()).includes("\u15cc detached"));
	});

	it("appends thinking while streaming and the tool name instead once a tool runs", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(), gitOf("main"), stateOf({ streaming: true })),
			`${DOC} | \u15cc main | (+0,-0) | thinking`,
		);
		assert.equal(
			formatMainLine(
				plain,
				sourceOf(),
				gitOf("main"),
				stateOf({ streaming: true, activeTools: new Map([["bash", 1]]) }),
			),
			`${DOC} | \u15cc main | (+0,-0) | bash`,
		);
	});

	it("annotates repeated and additional concurrent tools", () => {
		const twice = formatMainLine(plain, sourceOf(), gitOf("main"), stateOf({ activeTools: new Map([["read", 2]]) }));
		const several = formatMainLine(
			plain,
			sourceOf(),
			gitOf("main"),
			stateOf({ activeTools: new Map([["read", 1], ["bash", 1]]) }),
		);
		assert.ok(twice.endsWith("| read×2"), twice);
		assert.ok(several.endsWith("| read+1"), several);
	});

	it("questions the context when usage is unknown", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(null, { id: "mystery" }), gitOf("main"), stateOf()),
			"\u{1f17c} mystery/xhigh | Ctx ? | \u15cc main | (+0,-0)",
		);
	});

	it("survives a missing model", () => {
		assert.equal(
			formatMainLine(plain, sourceOf(null, null), gitOf(null), stateOf()),
			"\u{1f17c} no-model/xhigh | Ctx ? | \u15cc no git | (no git)",
		);
	});

	it("appends the current thinking level to the model id", () => {
		for (const level of ["off", "low", "high", "max"]) {
			assert.ok(
				formatMainLine(plain, sourceOf(0, FLASH, level), gitOf("main"), stateOf()).startsWith(
					`\u{1f17c} qwen3.8-flash/${level} | `,
				),
				level,
			);
		}
	});

	it("drops the level suffix when it is empty or the getter throws", () => {
		assert.ok(
			formatMainLine(plain, sourceOf(0, FLASH, ""), gitOf("main"), stateOf()).startsWith(
				"\u{1f17c} qwen3.8-flash | ",
			),
		);
		const throwing: StatuslineSource = {
			model: FLASH,
			get thinkingLevel(): never {
				throw new Error("stale context");
			},
			getContextUsage: () => ({ percent: 0 }),
		};
		assert.ok(
			formatMainLine(plain, throwing, gitOf("main"), stateOf()).startsWith("\u{1f17c} qwen3.8-flash | "),
		);
	});

	it("treats throwing context getters as unknown", () => {
		const stale: StatuslineSource = {
			get model(): never {
				throw new Error("stale context");
			},
			get thinkingLevel(): never {
				throw new Error("stale context");
			},
			getContextUsage(): never {
				throw new Error("stale context");
			},
		};
		assert.equal(formatMainLine(plain, stale, gitOf("main"), stateOf()), "\u{1f17c} no-model | Ctx ? | \u15cc main | (+0,-0)");
	});

	it("paints labels and separators dim, model / branch / percent by role", () => {
		assert.equal(
			formatMainLine(painted, sourceOf(0), gitOf("main"), stateOf({ diffStat: { added: 1, deleted: 2 } })),
			"dim(\u{1f17c}) accent(qwen3.8-flash)dim(/)syntaxFunction(xhigh)dim( | )dim(Ctx) success(0.0%)dim( | )" +
				"dim(\u15cc) accent(main)dim( | )dim(()success(+1)dim(,)error(-2)dim())",
		);
	});

	it("shifts the context colour at 70% and 90%", () => {
		const colored = (percent: number | null) => formatMainLine(painted, sourceOf(percent), gitOf("main"), stateOf());
		assert.ok(colored(69.9).includes("success(69.9%)"));
		assert.ok(colored(70).includes("warning(70.0%)"));
		assert.ok(colored(95.4).includes("error(95.4%)"));
		assert.ok(colored(null).includes("dim(?)"));
	});

	it("paints the state segment warning and nothing when idle", () => {
		assert.ok(
			formatMainLine(painted, sourceOf(), gitOf("main"), stateOf({ streaming: true })).endsWith("dim( | )warning(thinking)"),
		);
		assert.ok(
			formatMainLine(
				painted,
				sourceOf(),
				gitOf("main"),
				stateOf({ activeTools: new Map([["bash", 1]]) }),
			).endsWith("dim( | )warning(bash)"),
		);
		assert.equal(formatMainLine(painted, sourceOf(), gitOf("main"), stateOf()).includes("thinking"), false);
	});
});

describe("STATUS_PRIORITY", () => {
	it("pins the exact status keys it reorders", () => {
		assert.deepEqual([...STATUS_PRIORITY], ["plan-mode"]);
	});

	it("matches the plan-mode extension's own status key", () => {
		// 漂移会让「模式指示排行首」静默失效（排序不命中就当成普通 key）。
		assert.equal(PLAN_MODE_STATUS_KEY, STATUS_PRIORITY[0]);
	});
});

describe("formatExtensionStatuses", () => {
	it("joins statuses set by other extensions", () => {
		const statuses = new Map([
			["cwd", " 📁 /Users/bachi/jaylli/litellm-any"],
			["rewind", "◆ 3 checkpoints"],
		]);
		assert.equal(
			formatExtensionStatuses(plain, gitOf("main", statuses)),
			"📁 /Users/bachi/jaylli/litellm-any | ◆ 3 checkpoints",
		);
	});

	it("keeps pre-coloured status text verbatim and mutes plain text", () => {
		const esc = String.fromCharCode(27);
		const coloured = `${esc}[2m` + "◆ " + "checkpoints" + `${esc}[0m`;
		const statuses = new Map([
			["rewind", coloured],
			["cwd", " 📁 /tmp/repo"],
		]);
		const rendered = formatExtensionStatuses(painted, gitOf("main", statuses));
		assert.ok(rendered.startsWith(coloured + "dim( | )"), rendered);
		assert.ok(rendered.endsWith("muted(📁 /tmp/repo)"), rendered);
	});

	it("skips blank values and its own statusline key", () => {
		const statuses = new Map([
			["statusline", "stale"],
			["retry", "   "],
			["cwd", " 📁 /tmp/repo"],
		]);
		assert.equal(formatExtensionStatuses(plain, gitOf("main", statuses)), "📁 /tmp/repo");
		assert.equal(formatExtensionStatuses(plain, gitOf("main", new Map())), "");
	});

	it("caps the status line at five entries", () => {
		const statuses = new Map(
			Array.from({ length: 7 }, (_, i): [string, string] => [`k${i}`, `v${i}`]),
		);
		const rendered = formatExtensionStatuses(plain, gitOf("main", statuses));
		assert.equal(rendered.split(" | ").length, 5);
		assert.ok(rendered.endsWith("v4") && !rendered.includes("v5"), rendered);
	});

	it("puts the mode indicator first, regardless of registration order", () => {
		// 注册顺序是 cwd → rewind → plan-mode（加载目录字母序），但模式指示要靠前：
		// 它跟着会变长的路径 / 计数，而第二行超长只截断不折行，放尾部会被挤掉。
		const statuses = new Map([
			["cwd", " 📁 /Users/bachi/jaylli/litellm-any"],
			["rewind", "◆ 3 checkpoints"],
			["plan-mode", "⏵ bypass"],
		]);
		assert.equal(
			formatExtensionStatuses(plain, gitOf("main", statuses)),
			"⏵ bypass | 📁 /Users/bachi/jaylli/litellm-any | ◆ 3 checkpoints",
		);
	});

	it("keeps the mode indicator first even when it was registered last", () => {
		const statuses = new Map([
			["cwd", " 📁 /tmp/repo"],
			["plan-mode", "⏸ plan"],
		]);
		assert.equal(formatExtensionStatuses(plain, gitOf("main", statuses)), "⏸ plan | 📁 /tmp/repo");
	});

	it("priority ordering keeps non-priority keys in registration order", () => {
		const statuses = new Map([
			["zebra", "Z"],
			["plan-mode", "⏵ bypass"],
			["alpha", "A"],
		]);
		assert.equal(formatExtensionStatuses(plain, gitOf("main", statuses)), "⏵ bypass | Z | A");
	});

	it("a long cwd no longer pushes the mode indicator out of the five-item budget", () => {
		// 回归：老实现里 plan-mode 排第三，一旦前面两项再加上别人就容易被截掉。
		const statuses = new Map([
			["cwd", " 📁 /very/long/path/that/goes/on"] as [string, string],
			["rewind", "◆ 3 checkpoints"] as [string, string],
			["a", "A"] as [string, string],
			["b", "B"] as [string, string],
			["c", "C"] as [string, string],
			["plan-mode", "⏸ plan"] as [string, string],
		]);
		const rendered = formatExtensionStatuses(plain, gitOf("main", statuses));
		assert.ok(rendered.startsWith("⏸ plan | "), rendered);
		assert.equal(rendered.split(" | ").length, 5, "仍然限 5 条");
	});
});

describe("composeFooterLines", () => {
	function recorder() {
		const calls: Array<{ text: string; width: number; ellipsis: string }> = [];
		const truncate = (text: string, max: number, ellipsis: string) => {
			calls.push({ text, width: max, ellipsis });
			return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}${ellipsis}` : text;
		};
		return { calls, truncate };
	}

	it("indents every line by exactly one space and never wraps", () => {
		const { truncate } = recorder();
		const statuses = new Map([["cwd", " 📁 /tmp/repo"]]);
		const lines = composeFooterLines(
			plain,
			sourceOf(),
			gitOf("main", statuses),
			stateOf(),
			200,
			truncate,
		);
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.ok(line.startsWith(" "), JSON.stringify(line));
			assert.ok(!line.startsWith("  "), JSON.stringify(line));
			assert.equal(line.includes("\n"), false);
		}
		assert.ok(lines[0]?.includes(`${DOC} | \u15cc main | (+0,-0)`), lines[0]);
		assert.equal(lines[1], " 📁 /tmp/repo");
	});

	it("emits a single line when no other extension set a status", () => {
		const lines = composeFooterLines(plain, sourceOf(), gitOf("main"), stateOf(), 200, (t) => t);
		assert.equal(lines.length, 1);
	});

	it("truncates an over-long line and leaves a short one intact", () => {
		const { calls, truncate } = recorder();
		const lines = composeFooterLines(
			plain,
			sourceOf(),
			gitOf("main", new Map([["cwd", " 📁 /tmp/repo"]])),
			stateOf(),
			20,
			truncate,
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.width, 20);
		assert.equal(calls[0]?.ellipsis, ELLIPSIS);
		assert.equal([...(lines[0] ?? "")].length, 20, lines[0]);
		assert.ok(lines[0]?.endsWith(ELLIPSIS), lines[0]);
		assert.equal(lines[0]?.includes("\n"), false);
		assert.equal(lines[1], " 📁 /tmp/repo");
	});

	it("renders nothing for a non-positive width", () => {
		assert.deepEqual(composeFooterLines(plain, sourceOf(), gitOf("main"), stateOf(), 0, (t) => t), []);
	});
});

describe("composeFooterLines — background-task dock row", () => {
	const DOCK = "⚙ bg_1 running 12s · npm run test --silent";

	function lines(statuses: Map<string, string>, width = 200) {
		return composeFooterLines(plain, sourceOf(), gitOf("main", statuses), stateOf(), width, (t) => t);
	}

	it("renders the dock as its own last row, out of the joined status line", () => {
		const rendered = lines(
			new Map([
				["cwd", " 📁 /tmp/repo"],
				[BACKGROUND_DOCK_STATUS_KEY, DOCK],
			]),
		);
		assert.equal(rendered.length, 3);
		assert.equal(rendered[1], " 📁 /tmp/repo", "第二行只剩 cwd，dock 不在里面");
		assert.equal(rendered[2], ` ${DOCK}`, "dock 是最后一行，同样缩进一格");
	});

	it("does not consume the five-item status budget", () => {
		const statuses = new Map<string, string>([
			[BACKGROUND_DOCK_STATUS_KEY, DOCK],
		]);
		for (let i = 0; i < 6; i++) statuses.set(`k${i}`, `v${i}`);
		const rendered = lines(statuses);
		const joined = rendered[1]!;
		assert.equal(joined.split(" | ").length, 5, joined);
		assert.ok(joined.endsWith("v4") && !joined.includes("v5"), joined);
		assert.equal(rendered[2], ` ${DOCK}`);
	});

	it("keeps pre-coloured dock text verbatim (the publisher paints its own segments)", () => {
		const esc = String.fromCharCode(27);
		const coloured = `${esc}[31m⚙ bg_1 exit=1${esc}[0m`;
		const rendered = composeFooterLines(
			painted,
			sourceOf(),
			gitOf("main", new Map([[BACKGROUND_DOCK_STATUS_KEY, coloured]])),
			stateOf(),
			200,
			(t) => t,
		);
		assert.equal(rendered.length, 2, "没有其它 status 时只有主行 + dock 行");
		assert.equal(rendered[1], ` ${coloured}`, "不能再包一层 muted");
	});

	it("skips a blank dock value and emits no row for it", () => {
		const rendered = lines(
			new Map([
				["cwd", " 📁 /tmp/repo"],
				[BACKGROUND_DOCK_STATUS_KEY, "   "],
			]),
		);
		assert.equal(rendered.length, 2);
		assert.equal(rendered[1], " 📁 /tmp/repo");
	});

	it("leaves the footer exactly as before when no background task exists", () => {
		const rendered = lines(new Map([["cwd", " 📁 /tmp/repo"]]));
		assert.deepEqual(rendered, [` ${DOC} | ᗌ main | (+0,-0)`, " 📁 /tmp/repo"]);
	});

	it("truncates only the dock row's tail, never its id / status / elapsed", () => {
		// 真截断（与 index.ts 注入的 pi-tui `truncateToWidth` 同口径：按可见列数）。
		const truncate = (text: string, max: number, ellipsis: string) =>
			[...text].length > max ? `${[...text].slice(0, max - 1).join("")}${ellipsis}` : text;
		const rendered = composeFooterLines(
			plain,
			sourceOf(),
			gitOf("main", new Map([[BACKGROUND_DOCK_STATUS_KEY, DOCK]])),
			stateOf(),
			30,
			truncate,
		);
		assert.equal(rendered.length, 2);
		const dock = rendered[1]!;
		assert.equal([...dock].length, 30, dock);
		assert.ok(dock.endsWith(ELLIPSIS), dock);
		assert.ok(dock.includes("bg_1 running 12s"), "头部三段永远看得见");
	});

	it("pins the reserved key to the publisher's literal", () => {
		assert.equal(BACKGROUND_DOCK_STATUS_KEY, "background-tasks");
		assert.notEqual(BACKGROUND_DOCK_STATUS_KEY, PLAN_MODE_STATUS_KEY);
	});
});
