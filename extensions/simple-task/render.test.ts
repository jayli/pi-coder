/**
 * Tests for the task tool block shape (simple-task/index.ts) — 端到端：pi 自己的扩展加载器
 * 真的加载本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 task 工具块，
 * 对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/simple-task/render.test.ts
 *
 * 为什么必须绕这一圈：这个特性的全部价值在于「用户屏幕上长什么样」，而屏幕上的行是
 * `ToolExecutionComponent` → `renderCall` / `renderResult` → 壳（contentBox / selfRenderContainer）
 * 一层层叠出来的。只断言 `renderShell === "self"` 会漏掉「self 模式下底色真的没画上去」这一半。
 *
 * 断言口径（用户 2026-09-26 定：task 块与 bash 块同一套壳）：
 *   - 三个工具（`task_set` / `task_update` / `task_get`）都声明 `renderShell: "self"`；
 *   - 整块**没有任何底色**（pending / 成功 / 失败三种底都不画 —— 与 bash / read 块同一手法：
 *     selfRenderContainer 是纯 Container，bgFn 套不上去，扩展自己也不画）；
 *   - 整块**没有上下边界空行**（pi 默认壳 `Box(1, 1)` 的上下两条全没了）：
 *     块的第 0 行是 pi self 模式固定的那一行留白（`render()` 里 `lines.push("")`），
 *     第 1 行就是工具标题本身，最后一行是结果本身；
 *   - 标题与结果正文都从**列 1** 起（每行前置一个空格、不顶格 —— 用户 2026-09-26 定：
 *     补回默认壳原本提供的那一列左边距，由 Text 的 `paddingX = 1` 画）；
 *   - 失败结果（校验失败 / execute 抛错）同样从列 1 起（用户 2026-10-13 定）：isError 走
 *     index.ts 的 renderFailureResult 自绘 —— 修复前成功路径的 renderResult 读不到错误
 *     形状里的 details 而抛错，内核退回自己的 fallback（paddingX = 0，顶格）；现形状
 *     照抄内核 fallback 的 10 行预览 + 展开提示，只补缩进；对照断言钉住内核 fallback
 *     本身仍是列 0（本修复不动内核，只让扩展不再掉进 fallback）；
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
 * 与 bash / read 两个 render.test.ts 同一套查找逻辑：先从 `pi` 可执行文件反查安装位置，
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
	execute?: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
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
		setExpanded?: (expanded: boolean) => void;
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-shape-"));
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

/** 渲染一个 task 工具块：与 pi 的调用顺序一致（setArgsComplete → markExecutionStarted → updateResult）。 */
function renderBlock(
	name: string,
	args: unknown,
	result?: { content: unknown[]; details?: unknown; isError?: boolean },
	expanded = false,
): string[] {
	assert.ok(pi && cached);
	const definition = cached.tools.get(name)?.definition;
	assert.ok(definition, `本扩展必须注册 ${name} 工具`);
	const component = new pi.ToolExecutionComponent(name, "call-1", args, {}, definition, { requestRender() {} }, cached.projectDir);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (expanded) component.setExpanded?.(true);
	if (result) component.updateResult(result, false);
	return component.render(79);
}

/**
 * 内核校验失败时交给 renderResult 的错误形状（createErrorToolResult：纯文本 + details:{} +
 * isError:true）—— 文本形状照抄 chunk-OIM2DMFI.js 的 errorMessage4 模板。
 */
function validationFailureResult(args: { tasks: unknown[] }): {
	content: Array<{ type: string; text: string }>;
	details: Record<string, never>;
	isError: boolean;
} {
	const errorLines = args.tasks.map((_value, index) => `  - tasks.${index}: must be string`).join("\n");
	const text = `Validation failed for tool "task_set":\n${errorLines}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`;
	return { content: [{ type: "text", text }], details: {}, isError: true };
}

/** 三个工具各自的样例参数与成功结果（details 里的 state 供 renderResult 读计数）。 */
const SAMPLES: Record<string, { args: unknown; result: { content: unknown[]; details: unknown } }> = {
	task_set: {
		args: { tasks: ["a", "b", "c"] },
		result: {
			content: [{ type: "text", text: "Task list set with 3 task(s)." }],
			details: {
				action: "set",
				state: { active: true, nextId: 4, tasks: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 2, text: "b", status: "done" },
					{ id: 3, text: "c", status: "pending" },
				] },
			},
		},
	},
	task_update: {
		args: { id: 2, status: "done" },
		result: {
			content: [{ type: "text", text: "Task #2 → done." }],
			details: { action: "update", state: { active: true, nextId: 4, tasks: [] } },
		},
	},
	task_get: {
		args: {},
		result: {
			content: [{ type: "text", text: "[x] #2 b" }],
			details: {
				action: "get",
				state: { active: true, nextId: 4, tasks: [
					{ id: 1, text: "a", status: "pending" },
					{ id: 2, text: "b", status: "done" },
					{ id: 3, text: "c", status: "pending" },
				] },
			},
		},
	},
};

test("三个工具都声明 renderShell: \"self\"", { skip }, () => {
	assert.ok(cached);
	for (const name of ["task_set", "task_update", "task_get"]) {
		assert.equal(cached.tools.get(name)?.definition.renderShell, "self", `${name} 必须自带 self 壳`);
	}
});

test("整块没有任何底色（pending / 成功 / 失败三种底都不画）", { skip }, () => {
	assert.ok(cached);
	for (const [name, sample] of Object.entries(SAMPLES)) {
		const pending = renderBlock(name, sample.args);
		const success = renderBlock(name, sample.args, sample.result);
		const failed = renderBlock(name, sample.args, { content: [{ type: "text", text: "boom" }], details: {}, isError: true });
		for (const [label, lines] of [["执行中", pending], ["成功", success], ["失败", failed]] as Array<[string, string[]]>) {
			const painted = lines.filter(hasBg);
			assert.deepEqual(painted, [], `${name} ${label}：task 块不该有任何底色行：${JSON.stringify(painted.map(plain))}`);
			// 内容本身还在（别把"没底色"做成"整块没了"）
			assert.equal(lines.map(plain).some((line) => line.includes(name)), true, `${name} ${label}：标题行该还在`);
		}
	}

	// 对照：其他工具（不给 toolDefinition，走 pi 的通用渲染路径）底色照旧。
	// 钉住「只去 task 的」那半边：别的工具仍走 ToolExecutionComponent 自己的 contentBox + bgFn。
	assert.ok(pi);
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, cached!.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	assert.equal(other.render(79).some(hasBg), true, "其他工具的底色必须还在");
});

test("失败结果不顶格：错误正文与截断提示都从列 1 起（用户 2026-10-13 定）", { skip }, () => {
	const args = { tasks: [1, 2, 3, 4, 5] };
	const failed = validationFailureResult(args);
	const visible = renderBlock("task_set", args, failed).map(plain);
	assert.equal(visible[0], "", "第 0 行是 pi 的固定留白");
	assert.equal(visible[1]!.startsWith(" task_set"), true, "标题行从列 1 起");
	// 每行 = 恰好一个空格 + 内核错误原文行（原文自身带的缩进原样保留 —— 用户样例的逐字形状）
	const srcLines = (failed.content[0]!.text ?? "").split("\n").slice(0, 10);
	srcLines.forEach((src, index) => {
		const rendered = visible[2 + index]!;
		if (src === "") {
			assert.equal(rendered.trim(), "", `第 ${index} 行是空行`);
			return;
		}
		assert.equal(
			rendered.startsWith(` ${src}`),
			true,
			`第 ${index} 行该是「空格 + 原文」：${JSON.stringify({ src, rendered })}`,
		);
	});
	// 截断提示与内核 fallback 同文案，同样从列 1 起
	const hint = visible.find((line) => line.includes("more lines"));
	assert.ok(hint, "非展开态该有 ... (N more lines) 提示");
	assert.equal(hint.startsWith(" ... ("), true, `提示行该从列 1 起：${JSON.stringify(hint)}`);
});

test("失败结果展开态（ctrl+o）不裁剪、全文都从列 1 起", { skip }, () => {
	const args = { tasks: [1, 2, 3, 4, 5] };
	const visible = renderBlock("task_set", args, validationFailureResult(args), true).map(plain);
	assert.equal(visible.some((line) => line.includes("more lines")), false, "展开态不该有截断提示");
	assert.equal(visible.some((line) => line.trim() === "}"), true, `参数 JSON 的收尾行该在（全文展开）：${JSON.stringify(visible)}`);
});

test("三个工具的失败结果都不顶格（共享同一条 isError 分支）", { skip }, () => {
	for (const name of ["task_set", "task_update", "task_get"]) {
		const visible = renderBlock(name, {}, { content: [{ type: "text", text: "boom" }], details: {}, isError: true }).map(plain);
		assert.equal(visible[2]!.startsWith(" boom"), true, `${name} 失败正文该从列 1 起：${JSON.stringify(visible[2])}`);
		assert.equal(visible[2]!.startsWith("  "), false, `${name} 失败正文不该顶格或两格：${JSON.stringify(visible[2])}`);
	}
});

test("对照：内核 fallback（renderResult 抛错的 definition）保持列 0 顶格不动", { skip }, () => {
	assert.ok(pi && cached);
	// 复刻修复前的旧路径：renderResult 读不到期望字段而抛错 → 内核 catch → 自己的 fallback（paddingX = 0）
	const throwingDefinition = {
		renderShell: "self",
		renderCall: () => ({ render: () => [] as string[], invalidate() {} }),
		renderResult: () => {
			throw new Error("renderer exploded");
		},
	};
	const component = new pi.ToolExecutionComponent(
		"custom",
		"call-x",
		{},
		{},
		throwingDefinition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.updateResult({ content: [{ type: "text", text: "boom" }], details: {}, isError: true }, false);
	const visible = component.render(79).map(plain);
	assert.equal(
		visible.some((line) => line.startsWith("boom")),
		true,
		"内核 fallback 该保持列 0 顶格（本修复不动内核，只让扩展不再掉进 fallback）：" + JSON.stringify(visible),
	);
});

test("无边界空行：标题是块的第一行、结果是最后一行，正文在列 1（每行前置一个空格）", { skip }, () => {
	assert.ok(cached);
	for (const [name, sample] of Object.entries(SAMPLES)) {
		for (const [label, lines] of [
			["执行中", renderBlock(name, sample.args)],
			["成功", renderBlock(name, sample.args, sample.result)],
		] as Array<[string, string[]]>) {
			const visible = lines.map(plain);
			// 首行是 pi self 模式的固定留白（render() 里 lines.push("")），它不是块的一部分
			assert.equal(visible[0], "", `${name} ${label}：第 0 行是 pi 的固定留白`);
			// 块的第一行就是工具标题：前置**恰好一个**空格（不顶格，也不是两格）
			assert.equal(visible[1]!.startsWith(` ${name}`), true, `${name} ${label}：第 1 行该是「空格 + 标题」：${JSON.stringify(visible)}`);
			assert.notEqual(visible[1]!.startsWith(`  ${name}`), true, `${name} ${label}：不该有两个前导空格：${JSON.stringify(visible[1])}`);
			// 最后一行是内容本身（没有下边界空行）
			assert.notEqual(visible[visible.length - 1]!.trim(), "", `${name} ${label}：最后一行不该是空行：${JSON.stringify(visible)}`);
			// 结果行同样前置一个空格、不顶格
			if (visible.length > 2) {
				assert.equal(visible[2]!.startsWith(" ") && visible[2]!.trim() !== "", true, `${name} ${label}：结果行该前置一个空格：${JSON.stringify(visible[2])}`);
				assert.notEqual(visible[2]!.startsWith("  "), true, `${name} ${label}：结果行不该有两个前导空格：${JSON.stringify(visible[2])}`);
			}
		}
	}
});
