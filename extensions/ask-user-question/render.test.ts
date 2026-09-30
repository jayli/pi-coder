/**
 * Tests for the ask_user_question tool-block shape (ask-user-question/index.ts) — 端到端：
 * pi 自己的扩展加载器真的加载本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的工具块，
 * 对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/ask-user-question/render.test.ts
 *
 * 为什么必须绕这一圈（与 simple-task/render.test.ts 同一理由）：这个特性的全部价值在于
 * 「用户屏幕上长什么样」，而屏幕上的行是 `ToolExecutionComponent` → `renderCall` / `renderResult`
 * → 壳（contentBox / selfRenderContainer）一层层叠出来的。只断言 `renderShell === "self"` 会漏掉
 * 「self 模式下底色真的没画上去、上下空行真的没了」那一半。
 *
 * 断言口径（用户 2026-09-26 定：ask 块与 simple-task / bash / read 块同一套壳）：
 *   - 工具声明 `renderShell: "self"`；
 *   - 整块**没有任何底色**（pending / 成功 / 失败三种底都不画；selfRenderContainer 是纯 Container，
 *     bgFn 套不上去，扩展自己也不画）；
 *   - 整块**没有上下边界空行**（pi 默认壳 `Box(1, 1)` 的上下两条全没了）：块的第 0 行是 pi self 模式
 *     固定的那一行留白（`render()` 里 `lines.push("")`），第 1 行就是工具标题本身，
 *     最后一行是结果本身；
 *   - 标题与结果正文都从**列 1** 起（每行前置一个空格、不顶格 —— 补回默认壳原本提供的那一列左边距，
 *     由 Text 的 `paddingX = 1` 画）；
 *   - 其他工具照旧走默认壳（有底色）—— 有专门的对照断言。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 * 与 simple-task / bash / read 三份 render.test.ts 同一套查找逻辑：先从 `pi` 可执行文件反查安装位置，
 * 再退回 `~/.pi/agent/npm` 那份副本 —— 判定方式是能不能真 import。
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
 * pi 自带的 chalk 在模块求值时就定好「要不要输出样式」（非 TTY 下默认关掉）。
 * 底色断言看的是 SGR 序列，必须在 import pi 之前设 FORCE_COLOR。
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
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 底色判定：行首带背景 SGR 序列（`48;2;…` / `40-47` / `100-107`）就算有底色。 */
const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);

let cached: { projectDir: string; tools: Map<string, { definition: ToolDefinitionLike }> } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ask-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const tools = loaded.extensions[0]?.tools;
	assert.ok(tools, "本扩展必须注册工具");
	pi.initTheme("dark");
	cached = { projectDir, tools };
}

test.after(() => cleanup?.());

/** 渲染一个 ask 工具块：与 pi 的调用顺序一致（setArgsComplete → markExecutionStarted → updateResult）。 */
function renderBlock(args: unknown, result?: { content: unknown[]; details?: unknown; isError?: boolean }): string[] {
	assert.ok(pi && cached);
	const definition = cached.tools.get("ask_user_question")?.definition;
	assert.ok(definition, "本扩展必须注册 ask_user_question 工具");
	const component = new pi.ToolExecutionComponent("ask_user_question", "call-1", args, {}, definition, { requestRender() {} }, cached.projectDir);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (result) component.updateResult(result, false);
	return component.render(78);
}

/** 样例参数与三种结果（成功多选题也得覆盖 —— 它是 renderResult 的另一条分支）。 */
const ARGS = {
	questions: [
		{
			question: "Which library should we use?",
			header: "Library",
			options: [
				{ label: "Alpha (Recommended)", description: "fast but new" },
				{ label: "Beta", description: "boring but stable" },
			],
		},
	],
};
const RESULTS = {
	执行中: undefined,
	"成功（单选）": {
		content: [{ type: "text", text: "Q1: Alpha" }],
		details: { answers: [{ questionIndex: 0, kind: "option", answer: "Alpha" }] },
	},
	"成功（取消）": {
		content: [{ type: "text", text: "User declined to answer the questions" }],
		details: { cancelled: true, answers: [] },
	},
	失败: {
		content: [{ type: "text", text: "boom" }],
		details: { error: "boom", answers: [] },
		isError: true,
	},
} as const;

test("工具声明 renderShell: \"self\"", { skip }, () => {
	assert.ok(cached);
	assert.equal(cached.tools.get("ask_user_question")?.definition.renderShell, "self", "ask 块必须自带 self 壳");
});

test("整块没有任何底色（pending / 成功 / 失败三种底都不画）", { skip }, () => {
	for (const [label, result] of Object.entries(RESULTS)) {
		const lines = renderBlock(ARGS, result);
		const painted = lines.filter(hasBg);
		assert.deepEqual(painted, [], `${label}：ask 块不该有任何底色行：${JSON.stringify(painted.map(plain))}`);
		// 内容本身还在（别把"没底色"做成"整块没了"）
		assert.equal(lines.map(plain).some((line) => line.includes("ask_user_question")), true, `${label}：标题行该还在`);
	}

	// 对照：其他工具（不给 toolDefinition，走 pi 的通用渲染路径）底色照旧。
	// 钉住「只去 ask 的」那半边：别的工具仍走 ToolExecutionComponent 自己的 contentBox + bgFn。
	assert.ok(pi && cached);
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, cached.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	assert.equal(other.render(78).some(hasBg), true, "其他工具的底色必须还在");
});

test("无边界空行：标题是块的第一行、结果是最后一行，正文在列 1（每行前置一个空格）", { skip }, () => {
	for (const [label, result] of Object.entries(RESULTS)) {
		const visible = renderBlock(ARGS, result).map(plain);
		// 首行是 pi self 模式的固定留白（render() 里 lines.push("")），它不是块的一部分
		assert.equal(visible[0], "", `${label}：第 0 行是 pi 的固定留白`);
		// 块的第一行就是工具标题：前置**恰好一个**空格（不顶格，也不是两格）
		assert.equal(visible[1]!.startsWith(" ask_user_question"), true, `${label}：第 1 行该是「空格 + 标题」：${JSON.stringify(visible)}`);
		assert.notEqual(visible[1]!.startsWith("  ask_user_question"), true, `${label}：不该有两个前导空格：${JSON.stringify(visible[1])}`);
		// 最后一行是内容本身（没有下边界空行）
		assert.notEqual(visible[visible.length - 1]!.trim(), "", `${label}：最后一行不该是空行：${JSON.stringify(visible)}`);
		// 结果行同样前置一个空格、不顶格
		if (visible.length > 3) {
			const resultLine = visible[visible.length - 1]!;
			assert.equal(resultLine.startsWith(" ") && resultLine.trim() !== "", true, `${label}：结果行该前置一个空格：${JSON.stringify(resultLine)}`);
			assert.notEqual(resultLine.startsWith("  "), true, `${label}：结果行不该有两个前导空格：${JSON.stringify(resultLine)}`);
		}
	}
});

test("标题行以下的所有行都不顶格（选项行 / 多问题行都算）", { skip }, () => {
	// 单问题 + 多问题各验一次：renderCall 里选项列表行本身就是 "\n  1. …" 的硬缩进，
	// paddingX 再加一列，两条缩进叠加后仍不该出现顶格行。
	const multi = {
		questions: [
			ARGS.questions[0],
			{
				question: "Which extras?",
				header: "Extras",
				multiSelect: true,
				options: [
					{ label: "Previews", description: "md preview pane" },
					{ label: "Notes", description: "free-text note" },
				],
			},
		],
	};
	for (const [label, args] of [["单问题", ARGS], ["多问题", multi]] as Array<[string, unknown]>) {
		const visible = renderBlock(args).map(plain);
		for (let i = 1; i < visible.length; i++) {
			assert.equal(visible[i]!.startsWith(" "), true, `${label}：第 ${i} 行不该顶格：${JSON.stringify(visible[i])}`);
		}
	}
});
