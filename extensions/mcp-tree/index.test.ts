/**
 * Tests for the MCP block shape (mcp-tree/) — 端到端：pi 自己的扩展加载器真的加载本扩展，
 * 再用 pi 自己的 `ToolExecutionComponent` 渲染一个真实的 MCP 工具块，对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/mcp-tree/index.test.ts
 *
 * ## 为什么必须绕这一圈（不直接调 render.ts 里的纯函数）
 *
 * 这个特性的全部价值在于「用户屏幕上长什么样」，而屏幕上的行是
 * `ToolExecutionComponent` → 我们注册的解析器 → **内置 MCP 渲染器** → 我们挂的前缀 →
 * pi-tui 一层层叠出来的。只测纯函数会漏掉实测踩过的那几类问题：
 *   - 解析器没盖住内置的 → 内置渲染器那套「底色 + 上下空行」原样出现；
 *   - `renderShell: "self"` 没生效 → 同上；
 *   - 传给内置渲染器的 `lastComponent` 传错 → pi **静默**退回 fallback（形状全变，无报错）；
 *   - 内置渲染器的前置 `Spacer(1)` 没削 → 标题下面多一根悬空 `│`；
 *   - 委托时没扣左边距 → 正文顶出终端宽度被 pi-tui 裁掉。
 *
 * ## 与兄弟测试的一个关键差异：**没有「捕获 + 同名重注册」这一步**
 *
 * `web-search-tree` / `codemode-tree` / `tool-search-tree` 的测试要从包里捕获工具定义，
 * 因为它们的扩展是那样接线的。本扩展走 `registerToolRenderer` —— 它**不注册任何工具**，
 * 只是在渲染期插入一个解析器。所以这里的两个对照组都是「用同一个 `ToolExecutionComponent`
 * 换一个 renderers 定义」：
 *
 *   ① **内置对照组**：只用内置 MCP 扩展注册的解析器 → 应当看到底色 / 上下空行 / 无树；
 *   ② **非 MCP 对照组**：`read` 这类工具名走 ours → `next()` 原样返回（不被我们改写）。
 *
 * 两组都用真实组件渲染，所以它们证明下面那些形状断言**能分出好坏** —— 如果对内置原版也通过，
 * 那就是空转。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BODY_INDENT, GUTTER_LEAD, MARGIN_WIDTH, PREVIEW_MAX_LINES, contentWidth } from "./render.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const BAR = "\u2022"; // •
const PIPE = "\u2502"; // │
const CORNER = "\u2514"; // └
const TOOL_NAME = "mcp__repo_bot__search_knowledge";
const ARGS = { query: "双十一 进展", limit: 8 };

/**
 * `theme.bold()` 走 pi 自带的 chalk，而 chalk 在**模块求值时**就定好「要不要输出样式」
 * （非 TTY 下默认关掉）—— 所以颜色 / 加粗断言必须靠这个环境变量，且**必须在 import pi 之前**设。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

/**
 * 找到本机 pi 的库入口。
 *
 * `~/.pi/agent/npm/` 那份是**旧残留**、不能当首选（见 memory：pi 是 pnpm bundle 安装，
 * pi-tui 被内嵌进 chunk，从 `dist/bundle/index.js` 出发解析不到 pi 的依赖）。所以先扫
 * `PATH` 上的 `pi` shim 读它的 `exec` 目标。
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			const real = fs.realpathSync(shimPath);
			if (real !== shimPath) candidates.push(path.join(path.dirname(real), "index.js"));
		} catch {
			// 不是符号链接 / 不存在：看下面的 shim 脚本
		}
		try {
			// pnpm 的 shim 是 shell 脚本，里面写着 `exec node "$basedir/../global/v11/…/dist/bundle/cli.js"`。
			// 注意 `$basedir` 必须替换成 shim 自己的目录 —— 直接当路径用会得到一个带字面量
			// `$basedir` 的字符串，`existsSync` 恒为 false（这个坑实测踩过：整组测试静默 skip）。
			const shim = fs.readFileSync(shimPath, "utf8");
			const match = /exec\s+(?:"[^"]*node(?:\.exe)?"|node(?:\.exe)?)\s+"([^"]+cli\.js)"/.exec(shim);
			if (match?.[1]) {
				const target = match[1].replace(/\$basedir(?:_win)?/g, path.dirname(shimPath));
				candidates.push(path.join(path.dirname(target), "index.js"));
			}
		} catch {
			// 读不到这个 shim：跳过
		}
	}

	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	candidates.push(path.join(packageDir, "dist/bundle/index.js"), path.join(packageDir, "dist/index.js"));

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			await import(pathToFileURL(candidate).href);
			return candidate;
		} catch {
			// 空壳副本：换下一个候选
		}
	}
	return undefined;
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");
/** 一行里第一个非空字符的列号。 */
const firstColumn = (line: string): number => plain(line).search(/\S/);
/** 盒子会把每行补满到整宽 —— 断言形状时先去掉尾部空白。 */
const trimmed = (lines: string[]): string[] => lines.map((l) => l.replace(/\s+$/, ""));
/** pi 默认壳的底色（toolPendingBg / toolSuccessBg / toolErrorBg）：真彩色 `48;2;` / 256 色 `48;5;` / 16 色 `4X`。 */
const hasBackground = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48;)/.test(line);

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ toolRenderers?: Array<(toolName: string, next: () => unknown) => unknown> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	createMcpExtension: () => (pi: unknown) => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: unknown,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		rendererState: Record<string, unknown>;
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (!skip) pi = (await import(pathToFileURL(piEntry!).href)) as unknown as PiApi;

/** MCP 结果正文 —— 照内置渲染器认的形状（`content` 里是 text block）。 */
const RESULT_TEXT = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");

interface Cached {
	agentDir: string;
	projectDir: string;
	/** 我们注册的解析器（本扩展唯一注册的东西）。 */
	ourResolver: (toolName: string, next: () => unknown) => unknown;
	/** 内置 MCP 扩展注册的解析器 —— 对照组。 */
	builtinResolver: (toolName: string, next: () => unknown) => unknown;
}

let cached: Cached | undefined;
let cleanup: (() => void) | undefined;
let loadErrors: string[] = [];

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcptree-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	loadErrors = loaded.errors.map((e) => e.error);
	const ourResolver = loaded.extensions[0]?.toolRenderers?.[0];

	// 主题必须先初始化 —— 内置渲染器画标题时走 `formatToolCallWithArgs` → `theme.fg`，
	// 未初始化会抛 `Theme not initialized`（web-search-tree 的测试同样先调这一句）。
	pi.initTheme("dark");

	// 内置 MCP 扩展的解析器：用假 pi 捕获它注册的那一个（它不 registerTool，所以没有别的副作用）。
	const captured: Array<(toolName: string, next: () => unknown) => unknown> = [];
	const fake = new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "registerToolRenderer") return (resolver: (typeof captured)[number]) => captured.push(resolver);
				if (property === "events") return {};
				if (property === "getMcpServers") return () => [];
				return () => ({});
			},
		},
	);
	(pi.createMcpExtension() as (api: unknown) => unknown)(fake);

	if (ourResolver && captured[0]) {
		cached = { agentDir, projectDir, ourResolver, builtinResolver: captured[0] };
	}
}

test.after(() => cleanup?.());

/**
 * 把若干解析器串成 pi 的解析链（`resolveToolRenderers` 的同一算法：按顺序调用，
 * 最后一个的 `next()` 落到「已注册工具的定义」—— 这里用 `undefined` 代表）。
 */
function chain(toolName: string, resolvers: Array<(toolName: string, next: () => unknown) => unknown>): unknown {
	const resolve = (index: number): unknown =>
		index < resolvers.length ? resolvers[index]!(toolName, () => resolve(index + 1)) : undefined;
	return resolve(0);
}

interface RenderOptions {
	expanded?: boolean;
	partial?: boolean;
	width?: number;
	/** 不调 `updateResult` —— 真实的「工具已发出、结果还没到」那一刻（renderCall 独舞）。 */
	noResult?: boolean;
	isError?: boolean;
	details?: Record<string, unknown>;
	text?: string;
	/** 用哪条链渲染：`ours`（默认）/ `builtin`（对照组）/ `none`（走 pi 默认壳）。 */
	chainOf?: "ours" | "builtin" | "none";
}

/** 渲染一个真实的 MCP 工具块。 */
function renderBlock(options: RenderOptions = {}): string[] {
	assert.ok(pi && cached, "pi 库入口与本扩展的解析器都必须就绪");
	const which = options.chainOf ?? "ours";
	const definition =
		which === "ours"
			? chain(TOOL_NAME, [cached.ourResolver, cached.builtinResolver])
			: which === "builtin"
				? chain(TOOL_NAME, [cached.builtinResolver])
				: undefined;

	const component = new pi.ToolExecutionComponent(
		TOOL_NAME,
		"call-1",
		ARGS,
		{},
		definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.text ?? RESULT_TEXT }],
				details: options.details ?? { server: "repo_bot", tool: "search_knowledge" },
				...(options.isError ? { isError: true } : {}),
			},
			options.partial === true,
		);
	}
	return component.render(options.width ?? 100);
}

const text = (options: RenderOptions = {}): string[] => renderBlock(options).map(plain);

// ---------------------------------------------------------------------------

test("扩展加载不报错，且注册的是渲染器解析器（不注册任何工具）", { skip }, () => {
	assert.deepEqual(loadErrors, [], "pi 的扩展加载器不应该报错");
	assert.ok(cached, "必须捕获到本扩展的解析器与内置 MCP 的解析器");
});

test("解析器只在 mcp__ 前缀上生效，其余工具原样交给 next()", { skip }, () => {
	assert.ok(cached);
	let nextCalled = false;
	const mine = cached.ourResolver("read", () => {
		nextCalled = true;
		return { renderShell: "default", renderCall: () => ({ render: () => ["BASE"] }) };
	});
	assert.equal(nextCalled, true, "非 MCP 工具必须把控制权交下去");
	assert.deepEqual(mine, { renderShell: "default", renderCall: (mine as { renderCall: unknown }).renderCall }, "原样返回 next() 的结果");
});

test("解析器盖过内置：无论两种加载顺序，最终都用我们的 self 壳", { skip }, () => {
	assert.ok(cached);
	// 顺序 A：我们排在内置之前
	const a = chain(TOOL_NAME, [cached.ourResolver, cached.builtinResolver]) as { renderShell?: string } | undefined;
	assert.equal(a?.renderShell, "self", "我们排在前面时必须声明 self 壳");
	// 顺序 B：我们排在内置之后
	const b = chain(TOOL_NAME, [cached.builtinResolver, cached.ourResolver]) as { renderShell?: string } | undefined;
	assert.equal(b?.renderShell, "self", "我们排在后面时，内置的解析器调 next() 也要走到我们");
});

test("对照组：内置渲染器确实有底色（证明形状断言能分出好坏）", { skip }, () => {
	const lines = renderBlock({ chainOf: "builtin" });
	assert.ok(lines.some(hasBackground), "内置壳必须带底色 —— 否则下面「无底色」的断言就是空转");
});

test("无底色、无上下边界空行（self 壳生效）", { skip }, () => {
	const lines = renderBlock();
	assert.ok(!lines.some(hasBackground), "self 壳下整块都不该有底色");
	// pi 在 self 分支里固定 push 的那一行留白是行 0，不算块的一部分（bash / read 同一口径）。
	const body = trimmed(text()).filter((l, i) => !(i === 0 && l === ""));
	assert.ok(!body.some((l) => l === ""), "块内不该再有整行空白（上下边界空行已被 self 壳去掉）");
});

test("标题行：圆点在列 0、参数完整保留、工具名沿用内置的 label", { skip }, () => {
	const lines = trimmed(text());
	const title = lines[1]!;
	assert.equal(firstColumn(title), 0, "圆点必须在列 0");
	assert.ok(title.startsWith(BAR), `首行必须以圆点开头：${JSON.stringify(title)}`);
	assert.ok(title.includes("repo_bot/search_knowledge"), `工具名必须保留（内置 label 是 server/tool）：${JSON.stringify(title)}`);
	assert.ok(title.includes('query="双十一 进展"'), `参数必须完整保留在标题行：${JSON.stringify(title)}`);
	assert.ok(title.includes("limit=8"), `多余参数也要在：${JSON.stringify(title)}`);
});

test("正文：结构符在列 2、正文在列 4、`└ ` 只出现一次且落在末行", { skip }, () => {
	const lines = trimmed(text());
	const body = lines.slice(2);
	assert.ok(body.length > 0, "必须有正文行");

	const corners = body.filter((l) => plain(l).includes(CORNER));
	assert.equal(corners.length, 1, "`└ ` 整块只能出现一次");
	assert.ok(plain(body[body.length - 1]!).includes(CORNER), "`└ ` 必须落在末行");

	for (const line of body) {
		assert.equal(firstColumn(line), MARGIN_WIDTH, `结构符落在列 2：${JSON.stringify(plain(line))}`);
		const structure = plain(line)[MARGIN_WIDTH];
		assert.ok(structure === CORNER || structure === PIPE, `列 2 必须是结构符，实际 ${JSON.stringify(structure)}`);
		assert.equal(plain(line)[MARGIN_WIDTH + 1], " ", "结构符后一个空格");
	}
	// 正文列：结构符 2 列 + 1 空格 → 内容从列 4 起。逐行去掉「留白 + 结构符 + 空格」这三截再对。
	assert.equal(BODY_INDENT.length, 4);
	const content = plain(body[0]!).slice(MARGIN_WIDTH + 2);
	assert.ok(content.length > 0, "正文行必须有内容");
	assert.notEqual(content[0], " ", `正文必须紧跟在结构符那一个空格之后：${JSON.stringify(content)}`);
});

test("标题下面没有悬空 `│`（内置渲染器的前置 Spacer 被削掉）", { skip }, () => {
	const lines = trimmed(text());
	// 标题是行 1，行 2 必须是**有内容**的正文行 —— 不能是一行只有结构符的悬空竖线。
	const firstBody = plain(lines[2]!).trim();
	assert.notEqual(firstBody, PIPE, "标题下面不该出现只有 `│` 的空行");
	assert.ok(firstBody.length > 1, `标题下面直接是正文：${JSON.stringify(firstBody)}`);
});

test("预览截断：折叠态裁到 PREVIEW_MAX_LINES 并带 ctrl+o 提示", { skip }, () => {
	const lines = trimmed(text());
	const body = lines.slice(2);
	// 12 行正文 + 1 行提示，裁到 5 行正文 + 提示。
	assert.ok(body.length <= PREVIEW_MAX_LINES + 1, `折叠态最多 ${PREVIEW_MAX_LINES} 行正文 + 1 行提示，实际 ${body.length}`);
	assert.ok(body.some((l) => /more lines/.test(l)), "必须有 ctrl+o 展开提示");
});

test("展开态不裁（全部正文都画出来）", { skip }, () => {
	const lines = trimmed(text({ expanded: true }));
	const body = lines.slice(2);
	assert.ok(body.length >= 12, `展开态应当画出全部 12 行正文，实际 ${body.length}`);
	assert.ok(!body.some((l) => /more lines,/.test(l)), "展开态不该再有折叠提示");
});

test("圆点三态：执行中 / 部分结果都灰、成功绿、失败红", { skip }, () => {
	const dotOf = (line: string): string => {
		const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
		assert.ok(match, `首行应当带一颗带色的 •：${JSON.stringify(line)}`);
		return match[0];
	};
	// 三态语义（与 render.ts 的 stateDotSlot 一致）：
	//   isPartial（执行中 / 结果还在流）→ dim 灰；完成且成功 → 绿；完成且失败 → 红。
	const pending = dotOf(renderBlock({ noResult: true })[1]!);
	const partial = dotOf(renderBlock({ partial: true })[1]!);
	const ok = dotOf(renderBlock()[1]!);
	const failure = dotOf(renderBlock({ isError: true })[1]!);

	assert.equal(partial, pending, "结果还在流时与「还没结果」同色 —— 都是执行中的灰");
	assert.notEqual(ok, pending, "完成后必须换成成功色");
	assert.notEqual(failure, pending, "失败不能是执行中的灰");
	assert.notEqual(failure, ok, "成功与失败的圆点颜色必须不同");
});

test("失败正文里的 Error: 行被染成失败红", { skip }, () => {
	const lines = renderBlock({ isError: true, text: "Error: repo-bot 不可用" });
	const errLine = lines.find((l) => plain(l).includes("Error: repo-bot"));
	assert.ok(errLine, "错误行必须在");
	// 与成功块的同位置行比：错误行的前景色应当与失败圆点同槽（这里只断言它带了颜色且不是默认）。
	assert.ok(/\u001b\[38;2;\d+;\d+;\d+m/.test(errLine!), "Error: 行必须被着色");
});

test("details.error 也算失败（内置/服务端有「正常返回但带 error」的路径）", { skip }, () => {
	const withError = renderBlock({ details: { server: "repo_bot", tool: "search_knowledge", error: "boom" }, text: "ok" });
	const without = renderBlock({ text: "ok" });
	const dotOf = (line: string): string => {
		const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
		assert.ok(match, "首行应当带一颗带色的 •");
		return match[0];
	};
	assert.notEqual(dotOf(withError[1]!), dotOf(without[1]!), "details.error 非空时圆点必须是失败色");
});

test("宽度预算：正文按 width - 4 渲染，每行不超宽", { skip }, () => {
	const width = 60;
	const lines = renderBlock({ width, expanded: true });
	for (const line of lines) {
		// 可见宽度 ≤ 终端宽度（pi-tui 对超宽行直接抛错，所以这里也必须成立）。
		assert.ok(plain(line).length <= width, `行超宽（${plain(line).length} > ${width}）：${JSON.stringify(plain(line))}`);
	}
	assert.equal(contentWidth(width), width - 4);
});

test("多次 render 结果稳定（按宽度 + 形状键缓存的正确性）", { skip }, () => {
	assert.ok(pi && cached);
	const component = new pi.ToolExecutionComponent(TOOL_NAME, "call-2", ARGS, {}, chain(TOOL_NAME, [cached.ourResolver, cached.builtinResolver]), { requestRender() {} }, cached.projectDir);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: RESULT_TEXT }], details: {} }, false);
	const a = component.render(100).map(plain);
	const b = component.render(100).map(plain);
	assert.deepEqual(b, a, "同宽度同状态的两次 render 必须一致");
	// 换宽度后不能返回上一帧的行（缓存键必须带 width）。
	const wide = component.render(140).map(plain);
	assert.equal(wide[1]!.length >= a[1]!.length, true, "换宽度后应当按新宽度重排");
	assert.equal(GUTTER_LEAD.length, 2);
});
