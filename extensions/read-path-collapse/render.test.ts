/**
 * Tests for the read block shape (read-path-collapse.ts) — 端到端：pi 自己的扩展加载器真的加载
 * 本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 read 块，对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/read-path-collapse/render.test.ts
 *
 * 为什么必须绕这一圈（不直接调扩展里的内部函数）：这个特性的**全部**价值在于“用户屏幕上长什么
 * 样”，而屏幕上的行是 `ToolExecutionComponent` → `renderCall` / `renderResult` → Box → pi-tui
 * 一层层叠出来的。只测内部函数会漏掉实测踩过的那些问题：`lastComponent` 传错导致 pi 静默退回
 * fallback（标题只剩 `read`、路径全丢）、标题行与结果正文的左边距不一致、超宽行被 pi-tui 截掉。
 *
 * 断言口径（用户 2026-09-21 定的形状，与 `bash-command-collapse.ts` 同一套观感）：
 *   - 标题行 `• Read <路径>`：圆点在**列 0**、`Read` 的 `R` 在**列 2**、路径紧跟其后；
 *   - 圆点颜色三态：读的时候（pending / partial）`dim`、成功 `toolDiffAdded`、失败 `toolDiffRemoved`；
 *   - 结果正文每一行前面两格空格（与 `Read` 同列）；pi 那个前导空行被剥掉（正文紧贴标题）；
 *   - 整块**没有底色**（`toolPendingBg` / `toolSuccessBg` / `toolErrorBg` 都不画；
 *     其他工具照旧有底色 —— 有专门的对照断言）；
 *   - 整块**没有上下边界空行**（pi 默认壳的 `Box(1, 1)` 那两条），也没有中间空行；
 *   - 每一行的可见宽度 <= 终端宽度（pi-tui 对超宽行会截断，多一格就丢内容）；
 *   - 长路径压缩分支（`…` 前缀）、紧凑形态（`[skill]`）、展开态（ctrl+o）都保住上面的形状。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "read-path-collapse.ts");
/** 状态圆点 `•`（U+2022）：只挂在标题行行首。 */
const BAR = "\u2022";
/** 默认皮肤（dark）里三个状态槽的**真彩色** —— 圆点的颜色断言直接盯这三个值。 */
const DIM_ANSI = "\u001b[38;2;102;102;102m"; // dim            `#666666`
const ADDED_ANSI = "\u001b[38;2;181;189;104m"; // toolDiffAdded  `#b5bd68`
const REMOVED_ANSI = "\u001b[38;2;204;102;102m"; // toolDiffRemoved `#cc6666`
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 判定方式是**能不能真 import**，不是路径存不存在
 *（那份副本可能是被剪掉同伴包的空壳）。全都不行就返回 undefined，整体 skip。
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
 * pi 自带的 chalk 在**模块求值时**就定好「要不要输出样式」（非 TTY 下默认关掉），而
 * `theme.bold()` 就是它 —— 所以颜色那几个断言需要这个环境变量，且**必须在 import pi 之前**设。
 * 不设的话那些断言看到的全是不带 SGR 的裸文本，永远“通过”。
 * 只影响本测试进程，且尊重用户已有的 NO_COLOR。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface ToolDefinitionLike {
	renderShell?: string;
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
		extensions: Array<{ tools: Map<string, { definition: ToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: ToolDefinitionLike | undefined,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		rendererState: { startedAt?: number; endedAt?: number; interval?: NodeJS.Timeout };
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC / OSC 8 超链接转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line
		.replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\][^\u0007]*\u0007/g, "")
		.replace(/\u001b\\/g, "")
		.replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 可见列数（fixture 里只有 ASCII；汉字按 2 列，与 pi-tui 的算口一致）。 */
function widthOf(line: string): number {
	let width = 0;
	for (const ch of plain(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide = code >= 0x2e80 && code <= 0xa4cf;
		width += wide ? 2 : 1;
	}
	return width;
}

/**
 * 用 pi 自己的加载器加载本扩展（模块求值时做一次，测试之间复用注册好的工具定义）。
 * 顶层 await 是必须的：`test()` 回调是同步的，而加载是异步的。
 */
let cached: { agentDir: string; projectDir: string; definition: ToolDefinitionLike } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-read-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const definition = loaded.extensions[0]?.tools.get("read")?.definition;
	assert.ok(definition, "本扩展必须注册 read 工具（跨扩展同名注册是 first wins）");
	assert.equal(definition.renderShell, "self", "read 块必须走 self 壳（无底色、无上下边界空行）");
	pi.initTheme("dark");
	cached = { agentDir, projectDir, definition };
}

test.after(() => cleanup?.());

interface RenderOptions {
	content?: string;
	isError?: boolean;
	partial?: boolean;
	expanded?: boolean;
	/** 不调 `updateResult` —— 真实的“已经开读、结果还没到”那一刻。 */
	noResult?: boolean;
	width?: number;
	details?: unknown;
}

/** 渲染一个真实的 read 块：`markExecutionStarted` → `updateResult`，与 pi 的调用顺序一致。 */
function renderBlock(args: unknown, options: RenderOptions = {}): string[] {
	assert.ok(pi && cached);
	const component = new pi.ToolExecutionComponent(
		"read",
		"call-1",
		args,
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.content ?? "" }],
				details: options.details ?? {},
				...(options.isError === undefined ? {} : { isError: options.isError }),
			},
			options.partial === true,
		);
	}
	const lines = component.render(options.width ?? 79);
	// read 的结果渲染器在 partial 时也会挂每秒 invalidate 的定时器；不清的话 node --test 退不出去
	clearInterval(component.rendererState.interval);
	return lines;
}

const text = (args: unknown, options: RenderOptions = {}): string[] => renderBlock(args, options).map(plain);

/** 那个长到必然触发压缩的路径（`read-path-collapse.ts` 的存在理由）。 */
const LONG_PATH =
	"/Users/bachi/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/**
 * 规范化一行用于断言：去掉行首那两格左边距（`• ` / 两格空格）与行尾补白（`Box.render` 会把
 * 每行补满到终端宽度，补白不是内容）。**行首剩下的内容不动**。
 */
const body = (line: string): string => line.replace(/ +$/, "").replace(/^(?:\u2022 |  )/, "");

test("标题行：`• Read <路径>`，圆点在列 0、`Read` 在列 2", { skip }, () => {
	const raw = renderBlock({ path: "/tmp/x.js" }, { content: "const a = 1;\n" }).map(plain);
	assert.equal(raw[0], "", "第 0 行是 pi self 模式的固定留白（不算在块里）");
	const title = raw[1]!;
	assert.equal(title.startsWith(`${BAR} Read `), true, `标题行应当是 \`• Read \` 开头：${JSON.stringify(title)}`);
	assert.equal(title.indexOf(BAR), 0, "圆点在列 0");
	assert.equal(title.indexOf("Read"), 2, "`Read` 在列 2（正文整体右移一格）");
	assert.equal(title.includes("/tmp/x.js"), true, `路径仍在标题行上：${JSON.stringify(title)}`);
	// 只有标题行这一个圆点
	assert.equal(raw.filter((line) => line.includes(BAR)).length, 1, `整块只能有一个圆点：${JSON.stringify(raw)}`);
});

test("圆点颜色：读的时候 dim、成功绿、失败红", { skip }, () => {
	// 用户 2026-09-21 定：与 bash 块同一套语义（字形都是 `•`，着色逻辑一字不差）。
	const barAnsi = (line: string): string | undefined => /(\u001b\[38;2;\d+;\d+;\d+m)\u2022/.exec(line)?.[1];

	// 「读的时候」= 结果还没回来（`renderCall` 独舞）
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/x.js" }, { noResult: true })[1]!),
		DIM_ANSI,
		"pending 时圆点该是 dim 灰",
	);
	// 流式的 partial 快照同样是「还在读」
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/x.js" }, { content: "a\n", partial: true })[1]!),
		DIM_ANSI,
		"partial 时圆点该是 dim 灰",
	);
	// 成功 → toolDiffAdded（diff 新增行的绿）
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/x.js" }, { content: "a\n" })[1]!),
		ADDED_ANSI,
		"成功时圆点该是绿色",
	);
	// 失败 → toolDiffRemoved（diff 删除行的红）
	assert.equal(
		barAnsi(renderBlock({ path: "/tmp/nope.js" }, { content: "File not found", isError: true })[1]!),
		REMOVED_ANSI,
		"失败时圆点该是红色",
	);
});

test("圆点颜色是从主题现取的（改主题 → 下次渲染就跟着变）", { skip }, () => {
	// 断言「每次渲染现取」而不是写死三个色值：临时改 dark 皮肤的两个槽位再渲染，颜色必须跟着变。
	// 改的是 `fgAnsi`（已解析的 SGR 表）：0.99.1 起 pi 的 `Theme` 只剩 `fgAnsi` / `bgAnsi`
	// （`fgColors` 那份色值表已经不存在），扩展与 pi 自己的渲染都从它取。
	const singleton = (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] as
		| { fgAnsi?: Map<string, string> }
		| undefined;
	assert.ok(singleton?.fgAnsi?.set, "pi 的 theme 单例该在（initTheme 已调过）");
	const fgAnsi = singleton!.fgAnsi!;
	const dimBefore = fgAnsi.get("dim");
	const addedBefore = fgAnsi.get("toolDiffAdded");
	try {
		fgAnsi.set("dim", "\u001b[38;2;1;2;3m");
		fgAnsi.set("toolDiffAdded", "\u001b[38;2;4;5;6m");
		assert.equal(
			/(\u001b\[38;2;\d+;\d+;\d+m)\u2022/.exec(renderBlock({ path: "/tmp/x.js" }, { noResult: true })[1]!)?.[1],
			"\u001b[38;2;1;2;3m",
			"读的时候该跟着新的 dim 走",
		);
		assert.equal(
			/(\u001b\[38;2;\d+;\d+;\d+m)\u2022/.exec(renderBlock({ path: "/tmp/x.js" }, { content: "a\n" })[1]!)?.[1],
			"\u001b[38;2;4;5;6m",
			"成功该跟着新的 toolDiffAdded 走",
		);
	} finally {
		if (dimBefore === undefined) fgAnsi.delete("dim");
		else fgAnsi.set("dim", dimBefore);
		if (addedBefore === undefined) fgAnsi.delete("toolDiffAdded");
		else fgAnsi.set("toolDiffAdded", addedBefore);
	}
});

test("结果正文：每行两格缩进，与 `Read` 同列", { skip }, () => {
	// 折叠态下 pi 只有出错才画结果正文（`formatReadResult` 的 `!expanded && !isError` 守卫），
	// 所以拿**失败**那次来验正文的列位。
	const raw = renderBlock({ path: "/tmp/nope.js" }, { content: "File not found\nsecond line", isError: true }).map(plain);
	const title = raw[1]!;
	assert.equal(title.indexOf("Read"), 2, "标题的 `Read` 在列 2");
	const first = raw.find((line) => line.includes("File not found"))!;
	assert.equal(first.indexOf("File"), 2, `结果正文该与 \`Read\` 同列：${JSON.stringify(raw)}`);
	const second = raw.find((line) => line.includes("second line"))!;
	assert.equal(second.indexOf("second"), 2, `第二行同样缩进两格：${JSON.stringify(raw)}`);
});

test("整块：没有底色（pending / 成功 / 失败三种底都不画）", { skip }, () => {
	// 背景序列（`48;2;…` / `40-47` / `100-107`）一个都不该有 —— `Box` 不带 bgFn 就是这个意思。
	const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);
	const cases: Array<[string, string[]]> = [
		["读的时候", renderBlock({ path: "/tmp/x.js" }, { noResult: true })],
		["成功", renderBlock({ path: "/tmp/x.js" }, { content: "a\nb\n" })],
		["失败", renderBlock({ path: "/tmp/nope.js" }, { content: "File not found", isError: true })],
		["展开态", renderBlock({ path: "/tmp/x.js" }, { content: "a\nb\n", expanded: true })],
	];
	for (const [label, lines] of cases) {
		assert.deepEqual(lines.filter(hasBg), [], `${label}：read 块不该有任何底色行`);
		// 内容还在（别把“没底色”做成“整块没了”）
		assert.equal(lines.map(plain).some((line) => line.includes(BAR)), true, `${label}：标题行该还在`);
	}
});

test("整块：没有上下边界空行，正文紧贴标题", { skip }, () => {
	// 折叠态的结果正文只在失败时出现（见上一条），所以用失败的那次验“正文紧贴标题”。
	const raw = renderBlock({ path: "/tmp/nope.js" }, { content: "File not found", isError: true }).map(plain);
	// 第 0 行是 pi self 模式的固定留白；块本身从第 1 行开始、到最后一个有内容的行结束
	assert.equal(raw[0], "", "第 0 行是 pi 的固定留白");
	assert.equal(raw[1]!.includes(BAR), true, `块的第 1 行就该是标题（没有上边界空行）：${JSON.stringify(raw)}`);
	const last = raw[raw.length - 1]!;
	assert.notEqual(last.trim(), "", `最后一行不该是空行（没有下边界空行）：${JSON.stringify(raw)}`);
	// 中间也不掺空行：标题下一行就是正文（pi 那个前导 `\n` 被剥掉了）
	assert.equal(raw[2]!.includes("File not found"), true, `标题下面紧贴正文：${JSON.stringify(raw)}`);
	for (const [index, line] of raw.entries()) {
		if (index === 0) continue;
		assert.notEqual(line.trim(), "", `块内不该有空行（第 ${index} 行）：${JSON.stringify(raw)}`);
	}
	// 读得成功时折叠态**没有**结果正文（pi 的行为，本扩展不掺和）：整块就只有标题一行
	const ok = renderBlock({ path: "/tmp/x.js" }, { content: "a\nb\n" }).map(plain);
	assert.equal(ok.length, 2, `成功 + 折叠态应当只有 pi 的留白行 + 标题行：${JSON.stringify(ok)}`);
});

test("对照：其他工具的底色 / 边界空行照旧（只改 read）", { skip }, () => {
	// 本扩展只注册 `read` 一个工具，其他工具走 pi 自己的默认壳（`Box(1, 1)` + bgFn）。
	// 不给 toolDefinition 就是那条通用路径。
	assert.ok(pi && cached);
	const other = new pi.ToolExecutionComponent(
		"grep",
		"call-other",
		{ pattern: "x" },
		{},
		undefined,
		{ requestRender() {} },
		cached.projectDir,
	);
	other.updateResult({ content: [{ type: "text", text: "some output" }], details: {} }, false);
	const lines = other.render(79);
	assert.equal(lines.some((line) => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line)), true, "其他工具必须仍有底色");
	assert.equal(plain(lines[0]!).trim(), "", "其他工具必须仍有上边界空行");
});

test("长路径：压缩成一行（`…` 前缀），圆点与缩进不变", { skip }, () => {
	const raw = renderBlock({ path: LONG_PATH }, { content: "x\n" }).map(plain);
	const title = raw[1]!;
	assert.equal(title.startsWith(`${BAR} Read `), true, `压缩后仍是 \`• Read \` 开头：${JSON.stringify(title)}`);
	assert.equal(title.includes("…"), true, `超长路径该带 …：${JSON.stringify(title)}`);
	assert.equal(title.trimEnd().split("\n").length, 1, "仍然是单行");
	// 压缩后整行不超宽（pi-tui 对超宽行会截断）
	assert.ok(widthOf(raw[1]!) <= 79, `压缩后不该超宽（${widthOf(raw[1]!)} > 79）`);
});

test("每一行的可见宽度都不超过终端宽度", { skip }, () => {
	const cases: Array<{ args: unknown; options: RenderOptions }> = [
		{ args: { path: "/tmp/x.js" }, options: { content: "a\nb\nc\n" } },
		{ args: { path: LONG_PATH }, options: { content: "a\nb\n" } },
		{ args: { path: LONG_PATH, offset: 10, limit: 20 }, options: { content: "a\n" } },
		{ args: { path: "/tmp/" + "y".repeat(120) }, options: { content: "a\n" } },
		{ args: { path: "/tmp/你好世界/" + "深".repeat(60) + ".js" }, options: { content: "a\n" } },
		{ args: { path: "/tmp/x.js" }, options: { content: "x".repeat(300) + "\n" } },
	];
	for (const width of [120, 79, 60, 40, 30, 25]) {
		for (const { args, options } of cases) {
			for (const line of renderBlock(args, { ...options, width })) {
				assert.ok(
					widthOf(line) <= width,
					`宽度 ${width} 下超宽：${JSON.stringify(plain(line))}（${JSON.stringify(args)}）`,
				);
			}
		}
	}
});

test("紧凑形态（`[skill]`）与行号区间都保住圆点和缩进", { skip }, () => {
	// 紧凑形态的标题由 pi 自己画（本扩展只在超宽时压缩它），左边距照样是我们挂的
	const skill = renderBlock({ path: join(os.homedir(), ".pi/agent/skills/commit/SKILL.md") }, { content: "x\n" }).map(plain);
	assert.equal(skill[1]!.startsWith(`${BAR} `), true, `[skill] 形态也要有圆点：${JSON.stringify(skill)}`);
	assert.equal(skill[1]!.includes("[skill]"), true, `该走紧凑形态：${JSON.stringify(skill)}`);

	// 行号区间（`offset` / `limit`）跟在路径后面，圆点与列位不变
	const ranged = renderBlock({ path: "/tmp/x.js", offset: 10, limit: 20 }, { content: "a\n" }).map(plain);
	const title = ranged[1]!;
	assert.equal(title.startsWith(`${BAR} Read `), true, `行号区间形态：${JSON.stringify(title)}`);
	assert.equal(title.includes(":10-29"), true, `行号区间该在：${JSON.stringify(title)}`);
	assert.equal(title.indexOf("Read"), 2, "`Read` 仍在列 2");
});

test("cwd 之外的资源文件：压缩后标签是路径，不是一个 `.`", { skip }, () => {
	// 回归：`cwdRelativePath` 曾把 pi 的 `resolvePath(input, baseDir)` 写成 node 的
	// `resolve(base, target)` —— 绝对路径进来时 node 直接返回 base，文件被丢掉，
	// `relative(cwd, cwd)` = "" 于是判定为「在 cwd 内」，标签退化成 `"."`。
	// 症状：读 `~/.pi/agent/AGENTS.md` 在窄终端上显示 `Read resource .:67-80`。
	// cwd 之内的文件碰巧正确，所以必须用 cwd 之外的路径才测得出来。
	const outside = join(os.homedir(), ".pi/agent/AGENTS.md");
	assert.notEqual(path.dirname(outside), cached!.projectDir, "fixture 必须在 cwd 之外，否则测不到这个坑");
	for (const width of [79, 66, 60, 40]) {
		const title = body(text({ path: outside, offset: 67, limit: 14 }, { content: "x\n", width })[1]!);
		assert.equal(/\s\.(:|\s|$)/.test(title), false, `标签不该退化成 \`.\`（width=${width}）：${JSON.stringify(title)}`);
		assert.equal(title.includes("AGENTS.md"), true, `文件名该在标题里（width=${width}）：${JSON.stringify(title)}`);
		assert.equal(title.includes(":67-80"), true, `行号区间该在（width=${width}）：${JSON.stringify(title)}`);
		assert.ok(widthOf(title) <= width, `超宽（width=${width}）：${JSON.stringify(title)}`);
	}

	// cwd 之内的资源文件仍走相对标签（修复不能把它一起改坏）
	const inside = join(cached!.projectDir, "CLAUDE.md");
	fs.writeFileSync(inside, "# hi\n");
	for (const raw of ["CLAUDE.md", inside]) {
		const title = body(text({ path: raw }, { content: "x\n", width: 60 })[1]!);
		assert.equal(title.includes("CLAUDE.md"), true, `cwd 内该是相对标签：${JSON.stringify(title)}`);
		assert.equal(title.includes(cached!.projectDir), false, `cwd 内不该出现绝对前缀：${JSON.stringify(title)}`);
	}
});

test("展开态（ctrl+o）：结果不裁行，圆点与缩进照旧", { skip }, () => {
	const raw = renderBlock({ path: "/tmp/x.js" }, { content: "1\n2\n3\n4\n5\n6\n7\n8\n", expanded: true }).map(plain);
	assert.equal(raw[1]!.startsWith(`${BAR} Read `), true, `展开态也要有圆点：${JSON.stringify(raw)}`);
	for (const line of ["1", "2", "8"]) {
		assert.equal(raw.some((l) => l.trimEnd() === `  ${line}`), true, `展开态该原样输出 ${line}（两格缩进）：${JSON.stringify(raw)}`);
	}
	assert.equal(raw.some((line) => line.includes("more lines")), false, `展开态不该有截断提示：${JSON.stringify(raw)}`);
});
