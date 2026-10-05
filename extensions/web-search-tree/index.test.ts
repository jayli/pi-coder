/**
 * Tests for the search block shape (web-search-tree/) — 端到端：pi 自己的扩展加载器真的加载
 * 本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 `pi_web_search` 块，对渲染出来的
 * **行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/web-search-tree/index.test.ts
 *
 * 为什么必须绕这一圈（不直接调 render.ts 里的纯函数）：这个特性的全部价值在于「用户屏幕上长什么样」，
 * 而屏幕上的行是 `ToolExecutionComponent` → 我们委托的**包自带**渲染器 → 我们挂的前缀 → pi-tui
 * 一层层叠出来的。只测纯函数会漏掉实测踩过的那几类问题：
 *   - 传给包渲染器的 `lastComponent` 传错 → pi **静默**退回 fallback（形状全变，无报错）；
 *   - `renderShell: "self"` 没生效 → 底色 / 上下空行还在；
 *   - 委托时没扣左边距 → 正文顶出终端宽度被 pi-tui 裁掉；
 *   - 包升级换了提示行措辞 / 换了 result 结构 → 我们的重排接不上。
 *
 * ## 与 bash / codemode / read 的测试床有个**刻意的不一致**，别照抄那边
 *
 * 那三处的 `index.test.ts` 都能 `import` pi 的库入口（`dist/bundle/index.js` 或 `dist/index.js`）。
 * 本测试**不能**：本扩展 `import` 的是 pi-web-access 的 `dist/index.js`，而那份 dist 里裸 import 了
 * `@modelcontextprotocol/sdk` / `undici` 等**它自己的依赖**—— 这些依赖只在 `~/.pi/agent/npm/node_modules`
 * 下（`.pnpm` 的 hoisted symlink 群），从 `dist/index.js` 那份**真实路径**出发能解析到，
 * 但从 `dist/bundle/index.js`（bun 打的 bundle）出发解析不到。
 *
 * 所以做法是：**两份都从 pi 的 `~/.pi/agent/npm/node_modules` 那份装**（`dist/bundle/index.js` 给
 * `ToolExecutionComponent` / 加载器用，`pi-web-access/dist/index.js` 给扩展用）—— 前者只提供组件与
 * 加载器，后者只提供工具定义，两边各取所需，不互相 import。实测可行（2026-10-02）。
 *
 * 断言口径（用户 2026-10-02 定）：
 *   - 圆点 `•` 在列 0、`│` / `└` 在列 2、正文在列 4；
 *   - `└ ` **一个**、落在末行（提示行就是末行）；
 *   - 查询值**完整**出现（不被截断到 40 列）；
 *   - 无底色、无上下空行；每行可见宽度 ≤ 终端宽度；
 *   - 成功圆点绿、失败圆点红（与 bash 成功态逐字节同色）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
/** pi 的 npm 安装落点 —— 组件 / 加载器与 pi-web-access 的依赖都在这棵树下。 */
const NPM_ROOT = path.join(os.homedir(), ".pi", "agent", "npm");
const PI_ENTRY = path.join(NPM_ROOT, "node_modules", "@earendil-works/pi-coding-agent", "dist", "bundle", "index.js");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const BAR = "\u2022"; // •
const PIPE = "\u2502"; // │
const CORNER = "\u2514"; // └

if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 一行里第一个非空字符的列号。 */
const firstColumn = (line: string): number => plain(line).search(/\S/);

const hasExtension = fs.existsSync(EXTENSION_PATH);
const hasPi = fs.existsSync(PI_ENTRY);
const hasPackage = fs.existsSync(path.join(NPM_ROOT, "node_modules", "pi-web-access", "dist", "index.js"));
const skip = !hasExtension || !hasPi || !hasPackage ? SKIP : false;

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: any }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: any,
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
if (!skip) pi = (await import(pathToFileURL(PI_ENTRY).href)) as unknown as PiApi;

/** 三条查询 —— 第一条是用户样例里那条长中文查询（40 列截断的受害者）。 */
const QUERIES = [
	"wechat-local-mcp 微信 重新签名 codesign 本地数据库 密钥 原理",
	"macOS WeChat local database decrypt re-sign app get-task-allow extract SQLCipher key from memory",
	"PyWxDump macOS 微信 数据库 密钥 获取 需要 重新签名 原因",
];

/**
 * **真实的结果形态**：照抄包自带 `renderResult` 认的那些 `details` 字段
 * （`queryCount` / `successfulQueries` / `totalResults` / `curatedQueries`），加上包自己产出的
 * `content`（模型看到的那一大坨 markdown，渲染时只当预览源）。
 *
 * 折叠态的提示行是包自己画的（`... (N more lines, M total, ctrl+o to expand)`），我们只是给它
 * 换前缀 —— 提示行**必须是包产出的那一行**，否则测的是一个不存在的场景。
 */
function searchDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		queryCount: 3,
		successfulQueries: 3,
		totalResults: 18,
		curatedQueries: QUERIES.map((query, index) => ({
			query,
			provider: "exa",
			answer: null,
			sources: [
				{ title: `Source ${index}-a`, url: `https://example.com/${index}/a` },
				{ title: `Source ${index}-b`, url: `https://example.com/${index}/b` },
			],
			error: null,
		})),
		...overrides,
	};
}

/** 与包自带渲染器实际产出的内容同形（模型看到的那份）。 */
const CONTENT = [
	`Search results for ${QUERIES.length} queries.`,
	"",
	...QUERIES.map((q, i) => `## ${i + 1}. ${q}\n\n- [Source ${i}-a](https://example.com/${i}/a)`),
].join("\n");

let cached:
	| {
			agentDir: string;
			projectDir: string;
			definition: any;
			stockDefinition?: any;
			stockFetch?: any;
			stockGet?: any;
			allOurs?: Map<string, any>;
		}
	| undefined;
let cleanup: (() => void) | undefined;
let loadErrors: string[] = [];

/** 我们要接管的工具名 —— 与 index.ts 保持一致。 */
const TARGET_TOOL = "pi_web_search";

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-websearch-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	// 本扩展 import 的是 `~/.pi/agent/npm/node_modules/pi-web-access`，与 agentDir 无关 ——
	// agentDir 只影响 pi 自己从别处加载什么（这里只给了显式路径，所以它加载不到别的）。
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	loadErrors = loaded.errors.map((e) => e.error);
	const definition = loaded.extensions[0]?.tools.get("pi_web_search")?.definition;

	// **对照组**：未接管的包原版定义 —— 直接从包里捕获（与 index.ts 同一个手法）。
	// 它证明下面那些形状断言**能分出好坏**：如果它们对原版也通过，那就是空转。
	const pkg = await import(pathToFileURL(path.join(NPM_ROOT, "node_modules", "pi-web-access", "dist", "index.js")).href);
	const stockTools: any[] = [];
	const factory = (pkg as { default: (api: unknown) => unknown }).default;
	await factory(
		new Proxy(
			{},
			{
				get(_target, property) {
					if (property === "registerTool") return (tool: any) => stockTools.push(tool);
					if (property === "on") return () => {};
					if (property === "registerCommand" || property === "registerShortcut") return () => {};
					if (property === "events") return {};
					// 工厂闭包里那些「读设置 / 写条目」的调用在捕获阶段不应该抛。
					return () => ({});
				},
			}),
	);
	const stockDefinition = stockTools.find((tool) => tool.name === TARGET_TOOL);
	// 包原版的另外两个（供 fetch / get_content 的对照组用）。
	const stockFetch = stockTools.find((tool) => tool.name === "fetch_content");
	const stockGet = stockTools.find((tool) => tool.name === "get_search_content");

	pi.initTheme("dark");
	// 三个被接管的定义都缓存起来（用户 2026-10-02 把范围从 search 扩到 fetch + get_content）。
	const allOurs = new Map<string, any>([...loaded.extensions[0]!.tools].map(([n, e]) => [n, (e as any).definition]));
	if (definition) cached = { agentDir, projectDir, definition, stockDefinition, stockFetch, stockGet, allOurs };
}

test.after(() => cleanup?.());

interface RenderOptions {
	expanded?: boolean;
	partial?: boolean;
	width?: number;
	/** 不调 `updateResult` —— 真实的「搜索已发出、结果还没到」那一刻（renderCall 独舞）。 */
	noResult?: boolean;
	isError?: boolean;
	details?: Record<string, unknown>;
}

/**
 * 渲染一个真实的块（可指定用哪个工具定义）。
 *
 * `definition` 默认为本扩展接管后的定义；传 `stockDefinition` 就是**未接管的包原版** ——
 * 下面那个对照组靠它。
 */
function renderBlock(options: RenderOptions & { definition?: any } = {}): string[] {
	assert.ok(pi && cached, "pi 库入口与扩展定义都必须就绪");
	const component = new pi.ToolExecutionComponent(
		"pi_web_search",
		"call-1",
		{ queries: QUERIES },
		{},
		options.definition ?? cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		const payload = {
			content: [{ type: "text", text: CONTENT }],
			details: options.details ?? searchDetails(),
			...(options.isError ? { isError: true } : {}),
		};
		component.updateResult(payload, options.partial === true);
	}
	return component.render(options.width ?? 100);
}

const text = (options: RenderOptions = {}): string[] => renderBlock(options).map(plain);
/** 盒子会把每行补满到整宽 —— 断言形状时先去掉尾部空白。 */
const trimmed = (lines: string[]): string[] => lines.map((l) => l.replace(/\s+$/, ""));

/**
 * 取出首行那颗圆点连同它的颜色 SGR（`\x1b[38;2;r;g;bm•\x1b[39m`）—— 颜色断言看这个。
 * 刻意**不硬编码色值**（主题一漂就整体误报，见 README），真正要钉的是「成功绿与 bash 工具
 * 成功态逐字节相同」这件事本身。
 */
/** pi 默认壳的底色（toolPendingBg / toolSuccessBg / toolErrorBg）：真彩色 `48;2;` / 256 色 `48;5;` / 16 色 `4X`。 */
const hasBackground = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48;)/.test(line);

function dotOf(line: string): string {
	const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
	assert.ok(match, `首行应当带一颗带色的 •：${JSON.stringify(line)}`);
	return match[0];
}

/** 用仓库里那份 bash 扩展渲染一次成功调用，取其圆点作对照。 */
let bashSuccessDot: string | undefined;
if (pi) {
	const bashExtensionPath = path.join(path.dirname(EXTENSION_PATH), "..", "bash-command-collapse.ts");
	const loadedBash = await pi.discoverAndLoadExtensions([bashExtensionPath], process.cwd(), process.cwd(), pi.createEventBus());
	const bashDefinition = loadedBash.extensions[0]?.tools.get("bash")?.definition;
	if (bashDefinition) {
		const bash = new pi.ToolExecutionComponent("bash", "bash-1", { command: "echo hi" }, {}, bashDefinition, { requestRender() {} }, process.cwd());
		bash.setArgsComplete?.();
		bash.markExecutionStarted();
		bash.updateResult({ content: [{ type: "text", text: "hi" }], details: {} }, false);
		bashSuccessDot = dotOf(bash.render(96)[1]!);
	}
}

test("扩展加载不报错，且注册的是会渲染的那个定义", { skip }, () => {
	assert.deepEqual(loadErrors, [], "pi 的扩展加载器不应该报错");
	assert.ok(cached, "必须捕获到 pi_web_search 的定义");
	assert.equal(cached.definition.renderShell, "self", "必须声明自绘外壳（这是无底色 / 无边界空行的开关）");
	assert.equal(typeof cached.definition.execute, "function", "执行逻辑必须原样继承（不是只做渲染的壳）");
	assert.equal(typeof cached.definition.renderCall, "function");
	assert.equal(typeof cached.definition.renderResult, "function");
});

test("块形状：圆点列 0、正文列 4、`└ ` 落在提示行（末行）", { skip }, () => {
	const lines = trimmed(text());
	// 第 0 行是 pi self 模式的固定留白（`ToolExecutionComponent.render()` 里 `lines.push("")`），
	// 不是块的一部分 —— bash / read / codemode 的测试用同一条口径（见 README）。
	assert.equal(lines[0], "", "第 0 行是 pi 的固定留白");
	assert.equal(firstColumn(lines[1]!), 0, `块首行该以圆点开头：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]!.slice(0, 2), `${BAR} `, `圆点后面接一格空格：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]!.slice(2, 8), "search", `工具名该从列 2 开始：${JSON.stringify(lines[1])}`);

	// `└ ` 一个、在末行 —— 本工具与 bash 的刻意区别（见 render.ts 文件头）
	const corners = lines.filter((line) => line.includes(CORNER));
	assert.equal(corners.length, 1, `整块只能有一个 └：${JSON.stringify(lines)}`);
	assert.equal(lines[lines.length - 1], corners[0], `└ 必须在最后一行：${JSON.stringify(lines)}`);
	assert.equal(firstColumn(lines[lines.length - 1]!), 2, `└ 在列 2：${JSON.stringify(lines[lines.length - 1])}`);

	// 其余非空行都挂 `│ ` 且正文在列 4（从第 2 行开始 —— 第 1 行是带圆点的首行）
	for (const line of lines.slice(2, -1)) {
		if (plain(line).trim() === "") continue;
		assert.equal(firstColumn(line), 2, `续行该以 │ 开头（列 2）：${JSON.stringify(line)}`);
		// 结构符后面可能是正文，也可能是一个空内容行（`│` 后面的空格被 trailing trim 掉了）——
		// 用户样例里 `Providers used: …` 与 `└ ...` 之间那根光秃的 `│` 就是后者。
		assert.equal(plain(line).slice(2, 3), PIPE, `第二列必须是结构符：${JSON.stringify(line)}`);
	}
});

test("折行的续行也挂在 `│ ` 后面（包原版的续行会掉到列 0）", { skip }, () => {
	const lines = trimmed(text({ width: 90 }));
	// 第二条英文查询比 90 列长 → 必然折行。续行必须仍在列 2 的 `│ ` 之后。
	const folded = lines.find((line) => plain(line).includes("key from memory"));
	assert.ok(folded, `应当有那么一条折行续行：${JSON.stringify(lines)}`);
	assert.equal(firstColumn(folded!), 2, `续行该带 │ 前缀（列 2）：${JSON.stringify(folded)}`);
});

test("查询值**完整**出现（不被截断）", { skip }, () => {
	// 查询值会比 90 列还长 → 会被折行、中间插进 `│ `，所以比之前先把结构符与空白去掉。
	const flattened = text().join("\n").replace(/[\s\u2502\u2514]/g, "");
	for (const query of QUERIES) {
		assert.ok(flattened.includes(query.replace(/\s/g, "")), `查询值必须完整出现：${JSON.stringify(query)}`);
	}
});

test("圆点三态：执行中 dim、成功绿（与 bash 同色）、失败红", { skip }, () => {
	const pending = dotOf(renderBlock({ noResult: true })[1]!);
	const ok = dotOf(renderBlock()[1]!);
	const failed = dotOf(renderBlock({ isError: true })[1]!);

	if (bashSuccessDot !== undefined) {
		assert.equal(ok, bashSuccessDot, "成功圆点必须与 bash 工具的成功圆点同色");
	}
	assert.notEqual(ok, pending, "成功与执行中必须是两种颜色");
	assert.notEqual(ok, failed, "成功与失败必须是两种颜色");
	assert.notEqual(pending, failed, "执行中与失败必须是两种颜色");
});

test("失败路径也要红点：包返回 `details.error` 而不是 throw 时不能显示绿点", { skip }, () => {
	// 这是实测里最容易漏的一格 —— 包有若干失败分支是**正常返回**一个带 error 的对象
	// （`details: { error: "No query provided" }`），pi 不会把它标成 isError。
	const returned = renderBlock({ details: { error: "No query provided" } });
	const okDot = dotOf(renderBlock()[1]!);
	assert.notEqual(dotOf(returned[1]!), okDot, "`details.error` 的失败必须换色（不能是成功绿）");
	assert.equal(dotOf(returned[1]!), dotOf(renderBlock({ isError: true })[1]!), "与 throw 的失败同色");
});

test("整块没有底色（三种状态底都不画）", { skip }, () => {
	// pi 的默认壳是 `Box(1, 1, bgFn)`，bgFn 按状态选 toolPendingBg / toolSuccessBg / toolErrorBg。
	for (const [label, rendered] of [
		["成功", renderBlock()],
		["流式中", renderBlock({ partial: true })],
		["失败", renderBlock({ isError: true })],
	] as const) {
		assert.equal(
			rendered.some(hasBackground),
			false,
			`${label}态不该有任何底色：${JSON.stringify(rendered.filter(hasBackground).map(plain))}`,
		);
	}
});

test("整块上下都没有边界空行", { skip }, () => {
	// 默认壳的 `Box(1, 1)` 上 / 下各画一行空行。self 模式下没有 —— 第 0 行是 pi 自己的留白，
	// 块本身从第 1 行开始、到最后一个非空行结束。
	const lines = text();
	assert.equal(lines[0], "", "第 0 行是 pi 的固定留白（不是块的边界空行）");
	assert.notEqual(plain(lines[1]!).trim(), "", "块的第一行必须是实体内容");
	const last = lines.length - 1;
	assert.notEqual(plain(lines[last]!).trim(), "", `块的最后一个非空行之后不该有空行：${JSON.stringify(lines.slice(-3).map(plain))}`);
});

test("每行可见宽度 ≤ 终端宽度（超宽会被 pi-tui 裁掉）", { skip }, () => {
	const widthOf = (line: string): number => {
		let width = 0;
		for (const ch of plain(line)) {
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
	};
	for (const width of [60, 80, 100, 120]) {
		for (const line of renderBlock({ width })) {
			assert.ok(widthOf(line) <= width, `宽 ${width} 下这一行超宽了：${widthOf(line)} 列 ${JSON.stringify(plain(line))}`);
		}
	}
});

test("窄终端（40 列）也不越界、且查询值仍在", { skip }, () => {
	const lines = text({ width: 40 });
	assert.ok(lines.length > 0);
	const joined = lines.join("\n");
	// 折行之后查询值会被拆成多行，所以按「去掉换行与空格后是否包含」来判。
	const flattened = joined.replace(/[\s\u2502\u2514]/g, "");
	assert.ok(flattened.includes(QUERIES[0]!.replace(/\s/g, "")), "窄终端下查询值也必须完整（只是折行）");
});

test("对照组：包原版确实是旧形状（底 + 无树 + 折行续行掉到列 0）—— 证明上面的断言能分出好坏", { skip }, () => {
	const stock = cached?.stockDefinition;
	if (!stock) return; // 包不在 / 结构变了：不假装通过，但也不把整组拖红
	const rendered = renderBlock({ definition: stock });
	const renderedText = rendered.map(plain);

	// ① 旧形状有底色（pi 默认壳的 toolSuccessBg）
	assert.ok(rendered.some(hasBackground), "包原版应当有底色（否则本扩展去掉底色的断言是空转）");

	// ② 旧形状没有树结构符
	assert.equal(renderedText.some((line) => line.includes(PIPE)), false, "包原版不该有 │ 结构符");

	// ③ 旧形状的**折行续行没有树前缀**（掉回包自己的两格缩进里）。判据取「以引号结尾的碎片行 /
	// 缩进只有包那两格的折行片」，不写死具体断在哪 —— 包原版与本扩展的折行点不同
	//（实测 2026-10-02：包在 `memory` 前断，我们在 `key` 前断，因为我们的预算少 4 列）。
	const stockBody = renderedText.slice(2, -1).filter((line) => line.trim() !== "");
	const stockContinuation = stockBody.find((line) => !/^\s{0,3}"/.test(line) && !line.includes("queries,"));
	assert.ok(stockContinuation, `包原版应当有折行续行：${JSON.stringify(stockBody)}`);
	assert.equal(stockContinuation!.includes(PIPE), false, `包原版的续行不带竖线：${JSON.stringify(stockContinuation)}`);

	// ④ 换成本扩展的定义后，这几件事全部反过来 —— 一个一个验，失败时报得清楚。
	const renderedOurs = renderBlock({ definition: cached!.definition });
	const oursText = renderedOurs.map(plain);
	assert.equal(renderedOurs.some(hasBackground), false, "接管后不该有底色");
	const oursBody = oursText.slice(1, -1).filter((line) => line.trim() !== "");
	// 本扩展的续行：带 `│ ` 且**不是以 `"` 开头的新条目**（即上一条被折了）。
	const oursFolded = oursBody.find((line) => line.includes(PIPE) && !/^\s*\u2502\s{0,3}"/.test(line));
	assert.ok(oursFolded, `接管后的折行续行应当出现：${JSON.stringify(oursBody)}`);
	assert.ok(oursFolded!.includes(PIPE), `接管后折行续行也带竖线：${JSON.stringify(oursFolded)}`);
});

test("fetch_content：接管后的形状（圆点 + 树 + 无底色 + 无边界空行）", { skip }, () => {
	const def = cached?.allOurs?.get("fetch_content");
	assert.ok(def, "fetch_content 必须被注册");
	assert.equal(def.renderShell, "self", "fetch_content 也必须声明自绘外壳");
	assert.equal(typeof def.execute, "function", "执行逻辑必须原样继承");

	const URL = "https://c.perf.qzz.io/";
	const render = (result: any, partial = false): string[] => {
		const c = new pi!.ToolExecutionComponent("fetch_content", "f1", { url: URL }, {}, def, { requestRender() {} }, cached!.projectDir);
		c.setArgsComplete?.();
		c.markExecutionStarted();
		if (result) c.updateResult(result, partial);
		return c.render(80);
	};

	// pending（用户 2026-10-02 贴的那个 `[░░░░] fetch`）：圆点 + `└` 提示，不再是无主的进度条
	const pending = render({ content: [{ type: "text", text: "Fetching 1 URL(s)..." }], details: { phase: "fetch", progress: 0 } }, true).map(plain);
	assert.equal(pending[1]!.slice(0, 2), `${BAR} `, `pending 首行该带圆点：${JSON.stringify(pending[1])}`);
	assert.ok(pending.some((l) => l.includes(CORNER)), "pending 也要有 `└ `");

	// 成功
	const ok = render({ content: [{ type: "text", text: "Title: c.perf.qzz.io\n\nContent." }], details: { urlCount: 1, successful: 1, totalChars: 1234, title: "c.perf.qzz.io" } });
	assert.equal(ok.some(hasBackground), false, "fetch 成功不该有底色");
	const okText = ok.map(plain).map((l) => l.replace(/\s+$/, ""));
	assert.equal(okText[0], "", "第 0 行是 pi 的固定留白");
	assert.equal(firstColumn(okText[1]!), 0, `块首行以圆点开头：${JSON.stringify(okText[1])}`);
	assert.equal(okText.filter((l) => l.includes(CORNER)).length, 1, "整块只能有一个 `└ `");
	assert.equal(okText[okText.length - 1], okText.find((l) => l.includes(CORNER)), "`└ ` 在末行");
});

test("get_search_content：同样被接管", { skip }, () => {
	const def = cached?.allOurs?.get("get_search_content");
	assert.ok(def, "get_search_content 必须被注册");
	assert.equal(def.renderShell, "self");
});

test("source_check / web_enable：**没有**被接管（用户划定的范围）", { skip }, () => {
	for (const name of ["source_check", "web_enable"]) {
		const def = cached?.allOurs?.get(name);
		if (!def) continue; // web_enable 在有的激活模式下不注册
		assert.equal(def.renderShell, undefined, `${name} 应保持 pi 默认壳（未接管）`);
		assert.equal(typeof def.execute, "function", `${name} 仍然可用`);
	}
});

test("三种状态的圆点：fetch 进行中 dim、成功绿、失败红", { skip }, () => {
	const def = cached?.allOurs?.get("fetch_content");
	assert.ok(def);
	const URL = "https://c.perf.qzz.io/";
	const render = (result: any, partial = false): string[] => {
		const c = new pi!.ToolExecutionComponent("fetch_content", "f1", { url: URL }, {}, def, { requestRender() {} }, cached!.projectDir);
		c.setArgsComplete?.();
		c.markExecutionStarted();
		if (result) c.updateResult(result, partial);
		return c.render(80);
	};
	const pending = dotOf(render({ content: [{ type: "text", text: "Fetching..." }], details: { phase: "fetch", progress: 0 } }, true)[1]!);
	const ok = dotOf(render({ content: [{ type: "text", text: "ok" }], details: { urlCount: 1, successful: 1, totalChars: 10, title: "t" } })[1]!);
	const failed = dotOf(render({ content: [{ type: "text", text: "boom" }], details: {}, isError: true })[1]!);
	if (bashSuccessDot !== undefined) assert.equal(ok, bashSuccessDot, "fetch 成功圆点与 bash 成功圆点同色");
	assert.notEqual(pending, ok, "进行中与成功必须不同色");
	assert.notEqual(ok, failed, "成功与失败必须不同色");
});

test("对照组（fetch）：包原版有底色、无树符 —— 证明 fetch 那几条断言不是空转", { skip }, () => {
	const stockFetch = cached?.stockFetch;
	if (!stockFetch) return;
	const URL = "https://c.perf.qzz.io/";
	const renderWith = (def: any, result: any): string[] => {
		const c = new pi!.ToolExecutionComponent("fetch_content", "f1", { url: URL }, {}, def, { requestRender() {} }, cached!.projectDir);
		c.setArgsComplete?.();
		c.markExecutionStarted();
		c.updateResult(result, false);
		return c.render(80);
	};
	const okResult = { content: [{ type: "text", text: "Title: t\n\nContent." }], details: { urlCount: 1, successful: 1, totalChars: 10, title: "t" } };
	const stock = renderWith(stockFetch, okResult);
	assert.ok(stock.some(hasBackground), "包原版 fetch 应当有底色");
	assert.equal(stock.map(plain).some((l) => l.includes(PIPE)), false, "包原版 fetch 不该有 │ 结构符");
	const ours = renderWith(cached!.allOurs!.get("fetch_content"), okResult);
	assert.equal(ours.some(hasBackground), false, "接管后 fetch 不该有底色");
	assert.ok(ours.map(plain).some((l) => l.includes(PIPE)), "接管后 fetch 有树结构符");
	// get_search_content 同样验一道
	if (cached?.stockGet) {
		const gr = { content: [{ type: "text", text: "stored slice" }], details: { responseId: "abc", totalChars: 4000 } };
		const gStock = renderWith(cached.stockGet, gr);
		const gOurs = renderWith(cached.allOurs!.get("get_search_content"), gr);
		assert.ok(gStock.some(hasBackground), "包原版 get_content 应当有底色");
		assert.equal(gOurs.some(hasBackground), false, "接管后 get_content 不该有底色");
	}
});

test("展开态：内容变多，`└ ` 仍在末行", { skip }, () => {
	const collapsed = trimmed(text());
	const expanded = trimmed(text({ expanded: true }));
	assert.ok(expanded.length >= collapsed.length, "展开态不该比折叠态短");
	const corners = expanded.filter((line) => line.includes(CORNER));
	assert.equal(corners.length, 1, `展开态也只能有一个 └：${JSON.stringify(expanded)}`);
	assert.equal(expanded[expanded.length - 1], corners[0], "展开态 `└ ` 仍在末行");
});
