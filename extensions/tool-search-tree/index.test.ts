/**
 * Tests for the tool_search block shape (tool-search-tree/) — 端到端：pi 自己的扩展加载器真的加载
 * 本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 tool_search 块，对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/tool-search-tree/index.test.ts
 *
 * 与 codemode-tree/index.test.ts 同形：断言对象是渲染出来的行，不是内部返回值 ——
 * 「用户屏幕上长什么样」才是这个扩展的全部价值（self 壳没生效、宽度没扣、前缀列位漂移，
 * 这些只在真渲染链上暴露）。
 *
 * 形状断言口径（用户 2026-10-13 定：照 memory 工具块同款）：圆点在列 0、`│`/`└` 在列 2、
 * 正文在列 4；`└ ` 整块只出现一次；无底色、无上下空行；圆点用 memory 同款三槽
 * （执行中灰 / 成功绿 / 失败红），成功圆点与 memory_write **逐字节同色**。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const BAR = "\u2022"; // •
const PIPE = "\u2502"; // │
const CORNER = "\u2514"; // └

/**
 * pi 的库入口（codemode-tree / memory 的 index.test.ts 同源）：
 * 先从 `pi` 可执行文件反查真正的安装位置，再退回 `~/.pi/agent/npm` 那份副本；
 * 判定方式是**能不能真 import**。全都不行就整体 skip —— 不假装通过。
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
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
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

/**
 * `theme.bold()` 走 pi 自带的 chalk，而 chalk 在**模块求值时**就定好"要不要输出样式"
 * （非 TTY 下默认关掉）—— 所以颜色 / 加粗断言必须靠这个环境变量，且**必须在 import pi 之前**设。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface DefinitionLike {
	name?: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	exposure?: string;
	defaultActive?: boolean;
	renderShell?: string;
	parameters?: unknown;
	execute?: (...args: any[]) => any;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: DefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: DefinitionLike,
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
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 一行的可见宽度（fixture 全是 ASCII 与少量 CJK；盒子会把每行补到整宽）。 */
const widthOf = (line: string): number => {
	let width = 0;
	for (const ch of Array.from(plain(line))) {
		const code = ch.codePointAt(0) ?? 0;
		width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
	}
	return width;
};

/** 一行里第一个非空字符的列号。 */
const firstColumn = (line: string): number => plain(line).search(/\S/);

/** 一段注册 deferred 工具的 fixture 扩展：给 execute 的真检索提供候选（写入临时目录）。 */
const FIXTURE_SOURCE = `export default function (pi: any) {
	pi.registerTool({
		name: "probe_deferred_tool",
		label: "Probe Deferred",
		description: "A deferred fixture tool about weather reports.",
		promptSnippet: "Probe deferred fixture tool.",
		parameters: { type: "object", properties: {} },
		exposure: "deferred",
		async execute() {
			return { content: [{ type: "text", text: "probe ok" }] };
		},
	});
}
`;

interface Harness {
	definition: DefinitionLike;
	memoryWriteDefinition: DefinitionLike | undefined;
	memoryReadDefinition: DefinitionLike | undefined;
	projectDir: string;
	root: string;
}

let cached: Harness | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-search-tree-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const fixturePath = path.join(root, "probe-extension.ts");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(fixturePath, FIXTURE_SOURCE, "utf-8");

	// memory 扩展做「同族圆点」对照（success 槽应与 tool_search 同色）；记忆根指到临时目录，
	// 不碰真实记忆。两个 env 都要在 test.after 还原（memory 扩展是执行期读 env）。
	const savedMemoryDir = process.env.PI_MEMORY_DIR;
	const savedMemoryOff = process.env.PI_MEMORY;
	process.env.PI_MEMORY_DIR = path.join(root, "memory-root");
	delete process.env.PI_MEMORY;

	cleanup = () => {
		if (savedMemoryDir === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = savedMemoryDir;
		if (savedMemoryOff === undefined) delete process.env.PI_MEMORY;
		else process.env.PI_MEMORY = savedMemoryOff;
		fs.rmSync(root, { recursive: true, force: true });
	};

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH, fixturePath, path.join(path.dirname(EXTENSION_PATH), "..", "memory", "index.ts")], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(
		loaded.errors.map((e) => `${e.path}: ${e.error}`),
		[],
		"pi 的扩展加载器不应该报错",
	);
	const extensions = loaded.extensions;
	const ours = extensions.flatMap((e) => [...e.tools.entries()]).find(([name]) => name === "tool_search");
	assert.ok(ours, "本扩展必须注册 tool_search 工具");
	pi.initTheme("dark");
	cached = {
		definition: ours![1].definition,
		memoryWriteDefinition: extensions.flatMap((e) => [...e.tools.entries()]).find(([name]) => name === "memory_write")?.[1].definition,
		memoryReadDefinition: extensions.flatMap((e) => [...e.tools.entries()]).find(([name]) => name === "memory_read")?.[1].definition,
		projectDir,
		root,
	};
}

test.after(() => cleanup?.());

/** 一次真实的结果形态：内置 execute 的返回（单 text block + details.loaded）。 */
function toolSearchResult(names: string[]): unknown {
	if (names.length === 0) return { content: [{ type: "text", text: "No matching tools found." }], details: { loaded: [] } };
	return {
		content: [
			{
				type: "text",
				text: `Loaded ${names.length} tool${names.length === 1 ? "" : "s"}. They are available from your next call:\n${names
					.map((name) => `- ${name}: description line of ${name}`)
					.join("\n")}`,
			},
		],
		details: { loaded: names },
	};
}

interface RenderOptions {
	query?: string;
	limit?: number;
	partialArgs?: boolean;
	partialResult?: boolean;
	isError?: boolean;
	expanded?: boolean;
	width?: number;
	/** 不调 updateResult —— 结果还没到（renderCall 独舞）。 */
	noResult?: boolean;
	/** 结果正文行数（截断断言用，> 10 才会出提示行）。 */
	bodyLines?: number;
}

/** 渲染一个真实的 tool_search 块，调用顺序与 pi 的 interactive-mode 一致。 */
function renderBlock(options: RenderOptions = {}): string[] {
	assert.ok(pi && cached, "pi 库入口与扩展定义都必须就绪");
	const args: Record<string, unknown> = {};
	if (options.query !== undefined) args.query = options.query;
	if (options.limit !== undefined) args.limit = options.limit;
	const component = new pi.ToolExecutionComponent(
		"tool_search",
		"call-1",
		args,
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	if (!options.partialArgs) component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		const names = options.bodyLines === undefined ? ["probe_deferred_tool"] : ["a", "b", "c"];
		const result = toolSearchResult(names) as { content: Array<{ type: string; text?: string }>; details: unknown };
		if (options.bodyLines !== undefined) {
			result.content = [{ type: "text", text: Array.from({ length: options.bodyLines }, (_, i) => `result line ${i}`).join("\n") }];
		}
		if (options.isError) (result as Record<string, unknown>).isError = true;
		component.updateResult(result, options.partialResult === true);
	}
	return component.render(options.width ?? 100);
}

const text = (options: RenderOptions = {}): string[] => renderBlock(options).map(plain);

/** 盒子会把每行补满到整宽 —— 断言形状时先去掉尾部空白。 */
const trimmed = (lines: string[]): string[] => lines.map((l) => l.replace(/\s+$/, ""));

/**
 * 取出首行那颗圆点连同它的颜色 SGR（`\x1b[38;2;r;g;bm•\x1b[39m`）—— 颜色断言看这个。
 * 刻意**不硬编码色值**（主题一漂就整体误报）；「与 memory_write 成功圆点逐字节相同」才是要钉的事实。
 */
function dotOf(line: string): string {
	const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
	assert.ok(match, `首行应当带一颗带色的 •：${JSON.stringify(line)}`);
	return match[0];
}

/** 用 memory 扩展渲染一次成功调用，取其圆点作对照（同族色彩 = 用户要的「参考 memory」）。 */
let memorySuccessDot: string | undefined;
if (pi && cached?.memoryWriteDefinition) {
	const memory = new pi.ToolExecutionComponent(
		"memory_write",
		"memory-1",
		{ name: "probe", description: "d", type: "user", content: "c" },
		{},
		cached.memoryWriteDefinition,
		{ requestRender() {} },
		cached.projectDir,
	);
	memory.setArgsComplete?.();
	memory.markExecutionStarted();
	memory.updateResult({ content: [{ type: "text", text: "Saved memory." }], details: { action: "created" } }, false);
	const line = memory.render(96).find((l) => l.includes(BAR));
	if (line) {
		const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
		memorySuccessDot = match?.[0];
	}
}

/**
 * 从一行里抠出「直接接在 `text` 前面的那段 SGR」（`\x1b[38;2;…m<text>`）—— 只要颜色段，
 * 不要文字，这样才能拿两个不同文字的同槽着色做逐字节对比。抠不到就抛。
 */
function colorOfRun(line: string, text: string): string {
	const escaped = text.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(\\u001b\\[[0-9;:]*m)${escaped}`).exec(line);
	assert.ok(match, `应带色渲染 ${JSON.stringify(text)}：${JSON.stringify(line)}`);
	return match[1]!;
}

/**
 * 用 memory 扩展渲染“内存标题名 / `memory_read` 的 `name:` 字段名”两条参照色，
 * 供 tool_search 两侧做逐字节对照。
 */
let memoryNameFieldRun: string | undefined;
let memoryTitleNameRun: string | undefined;
if (pi && cached?.memoryReadDefinition && cached?.memoryWriteDefinition) {
	const memoryRoot = process.env.PI_MEMORY_DIR;
	assert.ok(memoryRoot, "memory 根必须已指向临时目录");
	const projectRoot = path.resolve(cached.projectDir);
	const memoryDir = path.join(memoryRoot, "memory", projectRoot.replace(/[/.]/g, "-"));
	fs.mkdirSync(memoryDir, { recursive: true });
	fs.writeFileSync(
		path.join(memoryDir, "probe-color.md"),
		[
			"---",
			"name: probe-color",
			"description: probe color",
			"metadata:",
			"  type: project",
			"  modified: 2026-10-18",
			"---",
			"",
			"body",
			"",
		].join("\n"),
		"utf-8",
	);
	const renderMemory = (toolName: string, definition: DefinitionLike, args: unknown, result: unknown): string[] => {
		const component = new pi!.ToolExecutionComponent(
			toolName,
			`${toolName}-color-1`,
			args,
			{},
			definition,
			{ requestRender() {} },
			cached!.projectDir,
		);
		component.setArgsComplete?.();
		component.markExecutionStarted();
		component.updateResult(result, false);
		return component.render(96);
	};
	const readLines = renderMemory("memory_read", cached.memoryReadDefinition, { name: "probe-color" }, {
		content: [
			{ type: "text", text: "name: probe-color\ntype: project\nmodified: 2026-10-18\ndescription: probe color\n\nbody" },
		],
		details: { action: "read", name: "probe-color", type: "project" },
	});
	const nameLine = readLines.find((line) => line.includes("name:"));
	if (nameLine) memoryNameFieldRun = colorOfRun(nameLine, "name:");
	const writeLines = renderMemory(
		"memory_write",
		cached.memoryWriteDefinition,
		{ name: "probe", description: "d", type: "user", content: "c" },
		{ content: [{ type: "text", text: "Saved memory." }], details: { action: "created" } },
	);
	const titleLine = writeLines.find((line) => line.includes("memory_write"));
	if (titleLine) memoryTitleNameRun = colorOfRun(titleLine, "memory_write");
}

// =============================================================================
// 语义：接管不改执行
// =============================================================================

test("tool_search 定义：执行逻辑与 prompt 元数据全部继承，壳是 self", { skip }, async () => {
	assert.ok(cached, "定义必须就绪");
	const definition = cached.definition as unknown as Record<string, unknown>;
	assert.equal(definition["name"], "tool_search");
	assert.equal(definition["label"], "tool_search");
	assert.equal(definition["exposure"], "model-only");
	assert.equal(definition["defaultActive"], false, "默认不激活，要靠 defaultTools / tool_search 激活");
	assert.equal(typeof definition["execute"], "function", "执行逻辑必须继承");
	assert.equal(definition["renderShell"], "self", "壳必须是 self，否则底色与边界空行又会回来");
	assert.ok(String(definition["description"]).includes("# Tool discovery"), "描述必须原样继承");
	assert.ok(definition["promptSnippet"], "promptSnippet 必须继承，否则不进 <tools> 段");
	const parameters = definition["parameters"] as { properties?: Record<string, { type?: string }>; required?: string[] };
	assert.equal(parameters.properties?.["query"]?.type, "string", "参数 schema 必须继承（MCP 靠引用认 tool_search）");
	assert.ok(parameters.required?.includes("query"));
});

test("tool_search execute：零复制接管 —— schema 引用相等 + execute 行为指纹", { skip }, async () => {
	assert.ok(pi && cached, "定义必须就绪");
	// 纯加载器环境跑不了完整 execute（session runtime 未初始化，getActiveTools 会抛），
	// 但接管契约能用两条更强的证据钉住：
	// ① parameters / description 是**模块级**对象 —— 两次工厂调用实例化出来的定义
	//    引用相等成立，而 parameters 引用正是 MCP 扩展 isToolSearchTool() 认
	//    「这是真的 tool_search」的依据（execute 闭包是每次工厂调用新建的，没有跨实例可比性）。
	let builtin: DefinitionLike | undefined;
	const stub = new Proxy({}, {
		get(_t, property) {
			if (property === "registerTool") return (definition: DefinitionLike) => { builtin = definition; };
			return () => undefined;
		},
	});
	(pi as unknown as { createToolSearchExtension: () => (pi2: unknown) => void }).createToolSearchExtension()(stub);
	assert.ok(builtin, "应能从包工厂捕获内置定义");
	const ours = cached.definition as unknown as Record<string, unknown>;
	const theirs = builtin as unknown as Record<string, unknown>;
	assert.equal(ours["parameters"], theirs["parameters"], "parameters 必须是同一个 schema 引用（MCP isToolSearchTool 靠它）");
	assert.equal(ours["description"], theirs["description"], "描述必须原样继承");
	// ② execute 行为指纹：接管走 ...target 展开（见 index.ts），拿内置 execute 的参数校验分支
	//    直接验证 —— 这些分支不触 runtime，能真跑；文案与内置源码逐字一致。
	await assert.rejects(
		() => (ours["execute"] as (id: string, params: unknown) => Promise<unknown>)("call-1", { query: "" }),
		/query must not be empty/,
		"空 query 必须走内置 execute 的原校验分支",
	);
	await assert.rejects(
		() => (ours["execute"] as (id: string, params: unknown) => Promise<unknown>)("call-1", { query: "x", limit: 0 }),
		/limit must be a positive integer/,
		"非法 limit 必须走内置 execute 的原校验分支",
	);
});

// =============================================================================
// 形状：memory 同款树形块
// =============================================================================

test("tool_search 块：标题 `• tool_search <query>` 顶格，正文树 │ 在列 2、正文列 4", { skip }, () => {
	const lines = trimmed(text({ query: "memory 渲染" }));
	// 第 0 行是 pi self 模式的固定留白（`ToolExecutionComponent.render()` 里 `lines.push("")`），
	// 不是块的一部分 —— bash / codemode 的测试用同一条口径。
	assert.equal(lines[0], "", "第 0 行是 pi 的固定留白");
	assert.equal(firstColumn(lines[1]!), 0, `块首行该以圆点开头：${JSON.stringify(lines[1])}`);
	assert.match(lines[1]!, /^• tool_search memory 渲染$/, `标题形状：${JSON.stringify(lines[1])}`);
	const body = lines.filter((l) => l.includes(PIPE) || l.includes(CORNER));
	assert.ok(body.length >= 2, `正文树必须出现：${JSON.stringify(lines)}`);
	for (const line of body) {
		assert.equal(firstColumn(line), 2, `树形结构符该在列 2：${JSON.stringify(line)}`);
	}
	const firstBody = body[0]!;
	assert.equal(firstBody.slice(2, 3), PIPE, "列 2 是竖线本身");
	assert.match(firstBody.slice(4), /^Loaded 1 tool/, `正文从列 4 起、从 Loaded 开始：${JSON.stringify(firstBody)}`);
});

test("tool_search 块：`└ ` 只出现一次，挂在末行", { skip }, () => {
	const lines = trimmed(text({ query: "x" }));
	const corners = lines.filter((l) => l.includes(CORNER));
	assert.equal(corners.length, 1, `整块只该有一个拐角符：${JSON.stringify(corners)}`);
	const cornerIndex = lines.indexOf(corners[0]!);
	assert.equal(lines[cornerIndex]!.trimEnd(), lines[cornerIndex]!.trimEnd(), "sanity");
	// 末行（最后一个非空行）就是拐角所在
	const last = lines[lines.length - 1]!;
	assert.equal(last, corners[0], `└ 该挂在最后一个非空行：${JSON.stringify(lines.slice(-3))}`);
});

test("tool_search 块：整块没有底色（三种状态底都不画）", { skip }, () => {
	// pi 的默认壳是 `Box(1, 1, bgFn)`，bgFn 按状态选 toolPendingBg / toolSuccessBg / toolErrorBg。
	// 真彩色背景的 SGR 是 `\x1b[48;2;…m`，256 色是 `\x1b[48;5;…m`，16 色是 `\x1b[4Xm`。
	const hasBackground = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48;)/.test(line);
	for (const [label, rendered] of [
		["成功", renderBlock({ query: "x" })],
		["流式中", renderBlock({ query: "x", partialResult: true })],
		["失败", renderBlock({ query: "x", isError: true })],
	] as const) {
		assert.equal(
			rendered.some(hasBackground),
			false,
			`${label}态不该有任何底色：${JSON.stringify(rendered.filter(hasBackground).map(plain))}`,
		);
	}
});

test("tool_search 块：上下没有 pi 默认壳画的边界空行", { skip }, () => {
	const lines = text();
	assert.equal(lines[0]!.trim(), "", "第 0 行是 pi 的固定留白");
	assert.notEqual(lines[1]!.trim(), "", "块的第 1 行就该是内容（默认壳会在上面再留一行）");
	assert.notEqual(lines[lines.length - 1]!.trim(), "", "最后一行也该是内容（默认壳会在下面留一行）");
});

test("tool_search 块：圆点三态 —— 执行中灰、成功绿（与 memory_write 同色）、失败红", { skip }, () => {
	const pending = dotOf(renderBlock({ query: "x", noResult: true })[1]!);
	const ok = dotOf(renderBlock({ query: "x" })[1]!);
	const failed = dotOf(renderBlock({ query: "x", isError: true })[1]!);
	if (memorySuccessDot !== undefined) {
		assert.equal(ok, memorySuccessDot, "成功圆点必须与 memory_write 的成功圆点同色（同一套界面语言）");
	}
	assert.notEqual(ok, pending, "成功与执行中必须是两种颜色");
	assert.notEqual(ok, failed, "成功与失败必须是两种颜色");
	assert.notEqual(pending, failed, "执行中与失败必须是两种颜色");
});

test("tool_search 块：结果到达后圆点从执行中切到结局色（缓存键必须带状态）", { skip }, () => {
	const before = dotOf(renderBlock({ query: "x", noResult: true })[1]!);
	const after = dotOf(renderBlock({ query: "x" })[1]!);
	assert.notEqual(before, after, `结果到达后圆点必须换色（before=${JSON.stringify(before)}）`);
});

// =============================================================================
// 着色（用户 2026-10-18 定：标题名照 memory 标题、正文工具名照 memory_read 的 name 字段）
// =============================================================================

test("tool_search 块：标题里的工具名与 memory_write 标题同色同加粗（toolTitle 槽）", { skip }, () => {
	assert.ok(memoryTitleNameRun, "memory_write 标题参照色必须就绪");
	const line = renderBlock({ query: "x" })[1]!;
	const ours = colorOfRun(line, "tool_search");
	assert.equal(
		ours,
		memoryTitleNameRun,
		`标题工具名必须与 memory 标题逐字节同色（ours=${JSON.stringify(ours)} ref=${JSON.stringify(memoryTitleNameRun)}）`,
	);
	// 加粗也在（memory 那边是 theme.bold 包在 fg 里），逐字节对比已隐含，这里只钉住它没丢
	assert.ok(line.includes("\u001b[1mtool_search"), `工具名应当加粗：${JSON.stringify(line)}`);
});

test("tool_search 块：正文每条 `- <name>:` 的工具名与 memory_read 的 `name:` 同色", { skip }, () => {
	assert.ok(memoryNameFieldRun, "memory_read 的 name: 参照色必须就绪");
	const lines = renderBlock({ query: "x" });
	const entry = lines.find((line) => line.includes("- probe_deferred_tool:"));
	assert.ok(entry, `必须出现工具条目行：${JSON.stringify(lines.map(plain))}`);
	const ours = colorOfRun(entry!, "- probe_deferred_tool:");
	assert.equal(
		ours,
		memoryNameFieldRun,
		`正文工具名必须与 memory_read 的 name: 逐字节同色（ours=${JSON.stringify(ours)} ref=${JSON.stringify(memoryNameFieldRun)}）`,
	);
	// 冒号后的描述必须回到 text 槽（两段各自一段 SGR，不得整行一个颜色）
	const beforeColon = entry!.indexOf("- probe_deferred_tool:");
	const colonEnd = beforeColon + "- probe_deferred_tool:".length;
	const rest = entry!.slice(colonEnd);
	assert.ok(/^\u001b\[39m/.test(rest), `描述段必须关掉名字的颜色：${JSON.stringify(rest.slice(0, 40))}`);
	assert.ok(rest.includes("description line of probe_deferred_tool"), "描述文字必须保留");
});

test("tool_search 块：标题句走 text 槽，不被误当成工具条目（后缀着色段永不为空）", { skip }, () => {
	assert.ok(memoryNameFieldRun, "memory_read 的 name: 参照色必须就绪");
	const lines = renderBlock({ query: "x" });
	const header = lines.find((line) => plain(line).includes("They are available from your next call"));
	assert.ok(header, `标题句必须在：${JSON.stringify(lines.map(plain))}`);
	const ours = colorOfRun(header!, "Loaded");
	const entryLine = lines.find((line) => plain(line).includes("- probe_deferred_tool:"))!;
	const entryColor = colorOfRun(entryLine, "- probe_deferred_tool:");
	assert.notEqual(ours, entryColor, `标题句不得用工具名的颜色：${JSON.stringify(header)}`);
	assert.notEqual(ours, memoryNameFieldRun, "标题句不得用 syntaxKeyword 色");
});

// =============================================================================
// 标题行与预览截断
// =============================================================================

test("tool_search 块：参数未流完（partial args）时 query 显示占位符 …", { skip }, () => {
	const lines = trimmed(text({ partialArgs: true }));
	assert.match(lines[1]!, /^• tool_search …$/, `占位符形状：${JSON.stringify(lines[1])}`);
});

test("tool_search 块：limit ≠ 8 时标题带 ` · limit=N`，缺省不带", { skip }, () => {
	const withLimit = trimmed(text({ query: "x", limit: 3 }));
	assert.match(withLimit[1]!, /· limit=3$/, `limit 尾缀：${JSON.stringify(withLimit[1])}`);
	const without = trimmed(text({ query: "x" }));
	assert.ok(!without[1]!.includes("limit"), `缺省不该有尾缀：${JSON.stringify(without[1])}`);
});

test("tool_search 块：超宽 query 折叠为单行截断（不超终端宽）", { skip }, () => {
	const width = 60;
	const lines = trimmed(text({ query: "a very long query that certainly exceeds the width ".repeat(3), width }));
	assert.match(lines[1]!, /^• tool_search .*…$/, `截断以 … 收尾：${JSON.stringify(lines[1])}`);
	assert.equal(lines[1]!.includes("\n"), false);
	assert.ok(widthOf(renderBlock({ query: "x".repeat(200), width })[1]!) <= width, "标题行不得超宽");
});

test("tool_search 块：预览截断 —— 15 行正文裁到 10 行 + 提示行，提示行挂 `└ `", { skip }, () => {
	const lines = trimmed(text({ query: "x", bodyLines: 15 }));
	const hint = lines.find((l) => /… \(\d+ more lines?, ctrl\+o to expand\)/.test(l));
	assert.ok(hint, `必须出现截断提示行：${JSON.stringify(lines)}`);
	const visible = lines.filter((l) => /^  │ result line/.test(l));
	assert.equal(visible.length, 10, `正文该裁到 10 行，实际 ${visible.length}`);
	const corners = lines.filter((l) => l.includes(CORNER));
	assert.equal(corners.length, 1);
	assert.equal(corners[0], hint, `提示行该挂 └（它是树的末行）：${JSON.stringify(corners[0])} vs ${JSON.stringify(hint)}`);
});

test("tool_search 块：展开态（ctrl+o）不截断、无提示行", { skip }, () => {
	const lines = trimmed(text({ query: "x", bodyLines: 15, expanded: true }));
	assert.ok(!lines.some((l) => /ctrl\+o/.test(l)), `展开态不该有提示行：${JSON.stringify(lines)}`);
	const visible = lines.filter((l) => /result line/.test(l));
	assert.equal(visible.length, 15, `展开态 15 行全出，实际 ${visible.length}`);
});

test("tool_search 块：宽度变化不会让正文超宽", { skip }, () => {
	for (const width of [40, 60, 79, 100, 140]) {
		for (const line of renderBlock({ query: "tool discovery for deferred weather tools", width })) {
			assert.ok(
				widthOf(line) <= width,
				`width=${width} 时出现超宽行（${widthOf(line)} 列）：${JSON.stringify(plain(line))}`,
			);
		}
	}
});

test("tool_search 块：CJK query 的标题按宽字符计宽", { skip }, () => {
	// 30 列宽 + 全 CJK query：标题必须收进 30 列（宽字符记 2）
	const lines = trimmed(text({ query: "查".repeat(60), width: 30 }));
	assert.ok(widthOf(lines[1]!) <= 30, `标题超宽：${widthOf(lines[1]!)}：${JSON.stringify(lines[1])}`);
});
