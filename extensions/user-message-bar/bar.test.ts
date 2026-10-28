/**
 * Tests for bar.ts — 纯逻辑：只有正文首行用 `› `，续行补两格缩进；空出的格从行尾补白
 * 等量吃掉；muted 取色与背景槽转前景；补丁幂等。
 *
 * Run with:  node --test clients/pi/extensions/user-message-bar/bar.test.ts
 *
 * 这里用**手写的假行**（形状照 `UserMessageComponent.render` 的真实输出抄：行首 `\x1b[48;…m`、
 * 行尾 `\x1b[49m`、恢复会话首行前面还有 `\x1b]133;A\x07`），只用 ANSI 剥离与字符计数做断言，
 * 所以不需要 pi / pi-tui。真实链路（补丁真的打在 pi 渲染用的那个类上）在 `index.test.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	BAR_GLYPH,
	BAR_INDENT,
	addBarToLine,
	addBodyIndentToLine,
	addMessageBoxGap,
	decorateUserMessageLines,
	installUserMessageBar,
	installUserMessageGap,
	resolveBarAnsi,
	startupLogoOwnsHeader,
} from "./bar.ts";

const BG = "\u001b[48;2;27;28;29m";
const BG_RESET = "\u001b[49m";
const FG = "\u001b[38;2;198;200;209m";
const FG_RESET = "\u001b[39m";
const ZONE = "\u001b]133;A\u0007";
const BAR = "\u001b[38;2;129;133;150m\u203a\u001b[39m";

/** 去掉所有零宽序列后的可见文本（这些 fixture 全是等宽字符，长度即列数）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

test("字形与缩进：默认 `›`（U+203A），正文前空一格", () => {
	assert.equal(BAR_GLYPH, "\u203a");
	assert.equal(BAR_INDENT, 1);
});

test("首行：行首内边距空格换成标记，正文前空一格，行尾补白减一格", () => {
	const line = `${BG} ${FG}你好${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${BAR} ${FG}你好${FG_RESET}   ${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH} 你好   `, "标记后空一格、正文原样、行尾少一格");
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("标记跟着消息底色：不插任何背景开关序列，标记直接坐在 Box 的底色里", () => {
	const line = `${BG} ${FG}你好${FG_RESET}    ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// 标记紧接在底色序列之后就对了：底色块左边缘是连成一片的，不被抠出缺角
	assert.equal(result.startsWith(`${BG}${BAR}`), true, "标记直接接在底色后面");
	assert.equal(result.includes(BG_RESET + BAR), false, "标记前不插关背景");
	assert.equal(result.split(BG_RESET).length - 1, 1, "只有行尾那一个 49m（没多插）");
	assert.equal(result.split(BG).length - 1, 1, "只有行首那一个 48m（没多插还原）");
});

test("长行（行尾只剩一格补白，即 Box 的最小情况）也吃得下：标记 + 空格换掉内边距 + 那一格", () => {
	const line = `${BG} ${FG}正文正好铺到内容宽${FG_RESET} ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH} 正文正好铺到内容宽`, "行尾那一格补白被吃掉");
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("空的内边距行（盒子的上下留白）也吃第一格，正文前空的那格从补白里出", () => {
	const line = `${BG}${" ".repeat(20)}${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(plain(result), `${BAR_GLYPH}${" ".repeat(19)}`);
	assert.equal(plain(result).length, 20);
});

test("OSC 133 zone 标记与底色序列都留在首行标记前面", () => {
	const line = `${ZONE}${BG} 正文${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR}正文${BG_RESET}`, "zone 标记与底色前缀原样保留");
	assert.equal(plain(result), `${BAR_GLYPH}正文`, "行尾没补白可借 → 这一行不空那格（不撑宽优先）");
});

test("OSC 133 zone 标记不影响行尾补白的识别", () => {
	const line = `${ZONE}${BG} 正文${BG_RESET}   `;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${ZONE}${BG}${BAR} 正文${BG_RESET}  `, "标记后照常空一格，行尾补白减一格");
	assert.equal(plain(result).length, plain(line).length);
});

test("outputPad = 0：标记自己也从行尾补白里借一格，正文前再空一格", () => {
	const line = `${BG}${FG}正文${FG_RESET}   ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	// 行首的底色 + 前景前缀都算零宽前缀：标记落在它们之后、正文之前
	assert.equal(result, `${BG}${FG}${BAR} 正文${FG_RESET} ${BG_RESET}`);
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("outputPad = 0 且行尾只剩一格补白：保住标记，少空那一格", () => {
	const line = `${BG}${FG}正文${FG_RESET} ${BG_RESET}`;
	const result = addBarToLine(line, BAR);

	assert.equal(result, `${BG}${FG}${BAR}正文${FG_RESET}${BG_RESET}`);
	assert.equal(plain(result), `${BAR_GLYPH}正文`);
	assert.equal(plain(result).length, plain(line).length, "行宽不变");
});

test("outputPad = 0 且正文正好铺满一行：宁可这行没有标记，也不能撑宽", () => {
	const line = `${BG}${FG}正文正好铺满${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line);
});

test("缩进格数可调（indent 参数），且永远不撑宽", () => {
	const line = `${BG} ${FG}正文${FG_RESET}      ${BG_RESET}`;
	assert.equal(plain(addBarToLine(line, BAR, 3)), `${BAR_GLYPH}   正文   `, "空三格：行尾少吃三格");
	assert.equal(plain(addBarToLine(line, BAR, 99)).length, plain(line).length, "要得比补白多 → 最多吃到只剩标记");
});

test("正文里的空格不算补白（后面还有内容），不吃字符", () => {
	const line = `${BG}${FG}a b${FG_RESET}${BG_RESET}`;
	assert.equal(addBarToLine(line, BAR), line, "行首是正文、行尾没补白 → 原样返回");
});

test("空行与纯转义行不抛，原样返回", () => {
	assert.equal(addBarToLine("", BAR), "");
	assert.equal(addBarToLine(BG_RESET, BAR), BG_RESET);
});

test("续行缩进：普通行补一格，outputPad = 0 补两格，行宽不变", () => {
	const line = `${BG} ${FG}续行${FG_RESET}    ${BG_RESET}`;
	const noPad = `${BG}${FG}续行${FG_RESET}     ${BG_RESET}`;
	assert.equal(plain(addBodyIndentToLine(line)), `  续行   `);
	assert.equal(plain(addBodyIndentToLine(noPad)), `  续行   `);
	assert.equal(plain(addBodyIndentToLine(line)).length, plain(line).length);
	assert.equal(plain(addBodyIndentToLine(noPad)).length, plain(noPad).length);
});

test("整块装饰：只给第一条正文画标记，续行对齐，上下留白与正文内空行不画字形", () => {
	const lines = [
		`${BG}${" ".repeat(12)}${BG_RESET}`,
		`${ZONE}${BG} ${FG}第一行${FG_RESET}    ${BG_RESET}`,
		`${BG}${" ".repeat(12)}${BG_RESET}`,
		`${BG} ${FG}第二行${FG_RESET}    ${BG_RESET}`,
		`${BG}${" ".repeat(12)}${BG_RESET}`,
	];
	const result = decorateUserMessageLines(lines, BAR);

	assert.equal(result[0], lines[0], "顶部留白原样");
	assert.equal(plain(result[1] ?? ""), `${BAR_GLYPH} 第一行   `, "第一条正文带标记");
	assert.equal(result[2], lines[2], "正文内空行原样");
	assert.equal(plain(result[3] ?? ""), `  第二行   `, "续行用两格空格对齐正文");
	assert.equal(result[4], lines[4], "底部留白原样");
	assert.equal(result.filter((line) => line.includes(BAR)).length, 1, "整条消息只有一个标记");
	for (const [i, line] of result.entries()) {
		assert.equal(plain(line).length, plain(lines[i] ?? "").length, `第 ${i} 行不撑宽`);
	}
});

test("取色：默认槽位是弱化文字色 muted（前景槽，不做转换）", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			if (name === "muted") return "\u001b[38;2;129;133;150m"; // #818596
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			throw new Error(`Unknown theme background color: ${name}`);
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;129;133;150m");
});

test("取色：背景槽 selectedBg 转成前景（38/48 等值）", () => {
	const theme = {
		getFgAnsi: (name: string) => {
			throw new Error(`Unknown theme color: ${name}`);
		},
		getBgAnsi: (name: string) => {
			assert.equal(name, "selectedBg");
			return "\u001b[48;2;45;44;93m";
		},
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;2;45;44;93m");
});

test("取色：256 色皮肤同样只换 38/48 这一个数字", () => {
	const theme = {
		getFgAnsi: () => {
			throw new Error("Unknown theme color");
		},
		getBgAnsi: () => "\u001b[48;5;17m",
	};
	assert.equal(resolveBarAnsi(theme), "\u001b[38;5;17m");
});

test("取色：显式指定别的槽位名（如 toolDiffAdded）仍然直接取那个前景", () => {
	const theme = {
		getFgAnsi: (name: string) => (name === "toolDiffAdded" ? "\u001b[38;2;137;184;194m" : (() => { throw new Error("no"); })()),
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(theme, "toolDiffAdded"), "\u001b[38;2;137;184;194m");
});

test("取色：首选槽位不存在时按兜底顺序退到 selectedBg → toolDiffAdded，全没有则 undefined", () => {
	const noMuted = {
		getFgAnsi: (name: string) => {
			if (name === "toolDiffAdded") return "\u001b[38;2;1;2;3m";
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(noMuted), "\u001b[38;2;1;2;3m", "muted / selectedBg 都缺失 → toolDiffAdded");

	// 旧皮肤可能只有 selectedBg、没有 muted —— 应落到 selectedBg 的 38 转换上
	const legacy = {
		getFgAnsi: (name: string) => {
			throw new Error("no");
		},
		getBgAnsi: (name: string) => {
			if (name === "selectedBg") return "\u001b[48;2;45;44;93m";
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(legacy), "\u001b[38;2;45;44;93m", "muted 缺失 → selectedBg");

	const empty = {
		getFgAnsi: () => {
			throw new Error("no");
		},
		getBgAnsi: () => {
			throw new Error("no");
		},
	};
	assert.equal(resolveBarAnsi(empty), undefined);
	assert.equal(resolveBarAnsi(undefined), undefined);
});

test("补丁：只包一层，重复安装只换取色源", () => {
	let renderCalls = 0;
	class Fake {
		render(width: number): string[] {
			renderCalls += 1;
			return [`${BG} body${" ".repeat(Math.max(0, width - 5))}${BG_RESET}`];
		}
	}

	const first = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(first, true);

	const second = installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;4;5;6m", getBgAnsi: () => "" }),
		glyph: "|",
	});
	assert.equal(second, false, "第二次不该再包一层");

	const lines = new Fake().render(10);
	assert.equal(renderCalls, 1, "原始 render 只被调用一次");
	assert.equal(lines.length, 1);
	assert.equal(plain(lines[0]), "| body    ", "只加一个首行标记（+ 一格缩进），且换成了新的取色源");
	assert.equal(lines[0].includes("\u001b[38;2;4;5;6m"), true, "取色源已更新");
});

test("补丁：取色源拿不到颜色时原样返回（不抛、不加）", () => {
	class Fake {
		render(): string[] {
			return [`${BG} body${BG_RESET}`];
		}
	}
	installUserMessageBar({
		UserMessageComponent: Fake as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => undefined,
		glyph: "|",
	});
	assert.deepEqual(new Fake().render(), [`${BG} body${BG_RESET}`]);
});

test("补丁：原型没有 render 时什么都不做", () => {
	class Weird {}
	const installed = installUserMessageBar({
		UserMessageComponent: Weird as unknown as { prototype: Record<string | symbol, unknown> },
		theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
	});
	assert.equal(installed, false);
});


/* ==========================================================================
 * 消息框上方那条空行（addMessageBoxGap）
 * ========================================================================== */

test("addMessageBoxGap：在最前插一条裸空行，框内每行逐字节不变", () => {
	const lines = [`${BG} 正文${BG_RESET}`, `${BG}   ${BG_RESET}`];
	assert.deepEqual(addMessageBoxGap(lines), ["", ...lines]);
});

test("addMessageBoxGap：OSC 133 zone 起点留在第一条（它不能被空行挤到后面）", () => {
	const lines = [`${ZONE}${BG} 正文${BG_RESET}`];
	const result = addMessageBoxGap(lines);
	assert.deepEqual(result, [ZONE, `${BG} 正文${BG_RESET}`], "zone 跟空行同一行，正文那行不再带一份 zone");
	assert.equal(result[0]?.startsWith(ZONE), true, "整个消息的第一行仍带 zone 起点");
	assert.equal(plain(result[0] ?? ""), "", "它就是一条空行");
	assert.equal(result.length, lines.length + 1, "行数只加 1");
});

test("addMessageBoxGap：空渲染（0 行）不动，不凭空造一条空行", () => {
	assert.deepEqual(addMessageBoxGap([]), []);
});

test("startupLogoOwnsHeader：只认 startup-logo 写下的那个全局键", () => {
	const key = Symbol.for("litellm-any.pi-startup-logo.bootSuppressed");
	const host = globalThis as Record<symbol, unknown>;
	try {
		delete host[key];
		assert.equal(startupLogoOwnsHeader(), false, "没装 startup-logo（内置 header 还在）时不补那条缝");
		host[key] = true;
		assert.equal(startupLogoOwnsHeader(), true, "被静音了就得自己补");
		host[key] = "yes";
		assert.equal(startupLogoOwnsHeader(), false, "只认严格的 true");
	} finally {
		delete host[key];
	}
});

/** 可见列数（`plain()` 之后长度即列数：这套 fixture 里只有 ASCII 与 `|`）。 */
const visibleWidth = (line: string): number => plain(line).length;

/** 假 `UserMessageComponent`：只有 render（真组件的形状与本组用例无关）。 */
class FakeUserMessage {
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		const pad = Math.max(0, width - this.text.length - 2);
		return [`${BG} ${FG}${this.text}${FG_RESET}${" ".repeat(pad)}${BG_RESET}`];
	}
}

/**
 * 一个**全新原型**的假 `InteractiveMode`：`GAP_PATCHED` 是打在原型上的，而
 * `class X extends FakeInteractiveMode` 会继承那个标记 —— 拿它当"新类"会被认成"已经装过"而跳过。
 * 这里现场定义一个新类、把用户消息组件也接进来，`addMessageToChat` 补丁才会真的跑。
 */
function freshModeClass(Component: new (text: string) => FakeUserMessage) {
	return class FreshMode {
		chatContainer: { children: unknown[]; addChild(child: unknown): void } = {
			children: [],
			addChild(child: unknown) {
				this.children.push(child);
			},
		};
		addMessageToChat(message: { role: string; content?: string; timestamp?: number }): void {
			if (message.role === "user") this.chatContainer.addChild(new Component(message.content ?? ""));
		}
	};
}

test("startup-logo 占头顶：**第一个**消息框上方有一条空行，第二个没有", () => {
	const key = Symbol.for("litellm-any.pi-startup-logo.bootSuppressed");
	const host = globalThis as Record<symbol, unknown>;
	class Component extends FakeUserMessage {}
	try {
		host[key] = true;
		const Mode = freshModeClass(Component);
		installUserMessageGap({ InteractiveMode: Mode, UserMessageComponent: Component });
		installUserMessageBar({
			UserMessageComponent: Component,
			theme: () => ({
				getFgAnsi: (name: string) => (name === "muted" ? "\u001b[38;2;1;2;3m" : (() => { throw new Error("no"); })()),
				getBgAnsi: () => {
					throw new Error("no");
				},
			}),
			glyph: "|",
			startupLogoHeader: startupLogoOwnsHeader,
		});

		const mode = new Mode();
		mode.addMessageToChat({ role: "user", content: "一" });
		mode.addMessageToChat({ role: "user", content: "二" });
		const [first, second] = mode.chatContainer.children as Component[];

		// 基准：同一个组件在「上面不补缝」的渲染（第二条）；拿它逐字节对照第一条的框内那行
		const reference = second!.render(20);
		assert.equal(reference.length, 1, "第二条不加空行（上面本来就有消息）");

		const firstLines = first!.render(20);
		assert.equal(firstLines.length, 2, "框自己在 1 行 + 上方一条空行");
		assert.equal(firstLines[0], "", "最上面是那条裸空行");
		assert.equal(plain(firstLines[1] ?? "").startsWith("| 一"), true, "框内那行照旧（带首行标记）");
		assert.equal(visibleWidth(firstLines[1] ?? ""), visibleWidth(reference[0] ?? ""), "那条空行没撑宽任何一行");
	} finally {
		delete host[key];
	}
});

test("头顶不是 startup-logo：一条空行也不补（pi 内置 header 自带那条缝）", () => {
	class Component extends FakeUserMessage {}
	const Mode = freshModeClass(Component);
	installUserMessageGap({ InteractiveMode: Mode, UserMessageComponent: Component });
	installUserMessageBar({
		UserMessageComponent: Component,
		theme: () => ({
			getFgAnsi: (name: string) => (name === "muted" ? "\u001b[38;2;1;2;3m" : (() => { throw new Error("no"); })()),
			getBgAnsi: () => {
				throw new Error("no");
			},
		}),
		glyph: "|",
		startupLogoHeader: startupLogoOwnsHeader,
	});

	const mode = new Mode();
	mode.addMessageToChat({ role: "user", content: "正文" });
	const [first] = mode.chatContainer.children as Component[];
	assert.equal(first!.render(20).length, 1, "没装 startup-logo ⇒ 不补");
});

test("没装标记补丁（只装首行标记）：第一条也不补空行", () => {
	const key = Symbol.for("litellm-any.pi-startup-logo.bootSuppressed");
	const host = globalThis as Record<symbol, unknown>;
	class Component extends FakeUserMessage {}
	try {
		host[key] = true;
		installUserMessageBar({
			UserMessageComponent: Component,
			theme: () => ({ getFgAnsi: () => "\u001b[38;2;1;2;3m", getBgAnsi: () => "" }),
			glyph: "|",
			startupLogoHeader: startupLogoOwnsHeader,
		});
		const message = new Component("正文");
		assert.equal(message.render(20).length, 1, "没有 GAP_KEY 标记就不补");
	} finally {
		delete host[key];
	}
});
