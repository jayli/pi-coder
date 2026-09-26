/**
 * Tests for tool-diff.ts 的**提示词元数据**（promptSnippet / promptGuidelines）—— 端到端：
 * pi 自己的扩展加载器真的加载本扩展，再断言注册出来的 edit / write 定义体带着元数据。
 *
 * Run with:  node --test clients/pi/extensions/tool-diff/prompt-metadata.test.ts
 *
 * 为什么值得单独立一个测试文件：这个 bug 是**静默**的。工具照样能调、`description` 照样进
 * tool schema、渲染照样正常，唯一症状是 system prompt 里少了两行 `<tools>` 条目和 5 条
 * `<rules>` guidance —— 没有任何报错，肉眼在终端上看不出来。根因是注册时用了
 * `createEditTool()` / `createWriteTool()`（`wrapToolDefinition` 的包装器，只保留 8 个字段）
 * 而不是 `createEditToolDefinition()` / `createWriteToolDefinition()`（定义体，12 / 10 个字段），
 * 包装器把 `promptSnippet` / `promptGuidelines` 剥掉了。pi 官方示例
 * `examples/extensions/built-in-tool-renderer.ts` 用的正是包装器，**它自己就带这个 bug**，
 * 所以「照着官方示例抄」不构成保护 —— 只有断言能。
 *
 * 消费侧（pi 0.87.1，实测）：`agent-session.js` `_refreshToolRegistry` 里扩展注册的工具
 * `definitionRegistry.set` **覆盖**内置同名工具，snippet / guidelines 直接从
 * `definition.promptSnippet` / `definition.promptGuidelines` 建表；`system-prompt.js` 的
 * `visibleTools = selectedTools.filter(name => !!toolSnippets[name])` 决定 `<tools>` 段有没有
 * 这一行，`buildRules` 里的 `toolGuidelines[name]` 决定 `<rules>` 段有没有那几条。
 * 修复前实测：全部 70 条 system prompt 里 `- edit:` / `- write:` 行与 5 条 guidance **命中 0 次**。
 *
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tool-diff.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 * 与 `read-path-collapse/render.test.ts` 同一套反查逻辑：先从 `pi` 可执行文件反查真正的
 * 安装位置（pnpm/npm 的 shim 脚本里留有 `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上
 * 则是符号链接，两种都试），再退回 `~/.pi/agent/npm` 那份副本 —— 判定方式是**能不能真
 * import**，不是路径存不存在（那份副本可能是被剪掉同伴包的空壳）。全都不行就 skip。
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

interface ToolDefinitionLike {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	prepareArguments?: unknown;
	constrainedSampling?: unknown;
	execute?: unknown;
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
	createEditToolDefinition: (cwd: string) => ToolDefinitionLike;
	createWriteToolDefinition: (cwd: string) => ToolDefinitionLike;
	createEditTool: (cwd: string) => ToolDefinitionLike;
	createWriteTool: (cwd: string) => ToolDefinitionLike;
}

const piEntry = await findPiLibraryEntry();
let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/**
 * 用 pi 自己的加载器加载本扩展（模块求值时做一次，测试之间复用注册好的定义体）。
 * 顶层 await 是必须的：`test()` 回调是同步的，而加载是异步的。
 */
let registered: Map<string, { definition: ToolDefinitionLike }> | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-diff-prompt-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	registered = loaded.extensions[0]?.tools;
	assert.ok(registered, "本扩展必须注册工具");
	pi.initTheme("dark");
}

test.after(() => cleanup?.());

test("edit / write 都注册出来了（跨扩展同名注册是 first wins）", { skip: pi === undefined ? SKIP : false }, () => {
	assert.ok(registered);
	for (const name of ["edit", "write"]) {
		assert.ok(registered.get(name)?.definition, `本扩展必须注册 ${name} 工具`);
	}
});

test("edit 定义体带 promptSnippet + 4 条 promptGuidelines（修复前是 undefined / 0 条）", {
	skip: pi === undefined ? SKIP : false,
}, () => {
	assert.ok(pi && registered);
	const definition = registered.get("edit")!.definition;
	const builtin = pi.createEditToolDefinition(process.cwd());

	assert.equal(typeof definition.promptSnippet, "string", "promptSnippet 必须活着到达注册出来的定义体");
	assert.equal(definition.promptSnippet, builtin.promptSnippet, "必须与 pi 内置 edit 的 snippet 逐字相同");
	assert.ok(definition.promptSnippet!.includes("Make precise file edits"), "snippet 内容对不上 pi 的 edit 贡献");

	assert.ok(Array.isArray(definition.promptGuidelines), "promptGuidelines 必须是数组");
	assert.deepEqual(definition.promptGuidelines, builtin.promptGuidelines, "guidelines 必须与 pi 内置的逐条相同");
	assert.equal(definition.promptGuidelines!.length, 4, "edit 有 4 条 guidance（少一条就说明又被剥了）");
	assert.ok(
		definition.promptGuidelines!.some((rule) => rule.includes("Use edit for precise changes")),
		"必须含 <rules> 段里那条 'Use edit for precise changes…'",
	);
});

test("write 定义体带 promptSnippet + 1 条 promptGuidelines（修复前是 undefined / 0 条）", {
	skip: pi === undefined ? SKIP : false,
}, () => {
	assert.ok(pi && registered);
	const definition = registered.get("write")!.definition;
	const builtin = pi.createWriteToolDefinition(process.cwd());

	assert.equal(definition.promptSnippet, builtin.promptSnippet, "必须与 pi 内置 write 的 snippet 逐字相同");
	assert.equal(definition.promptSnippet, "Create or overwrite files");

	assert.deepEqual(definition.promptGuidelines, builtin.promptGuidelines, "guidelines 必须与 pi 内置的逐条相同");
	assert.deepEqual(definition.promptGuidelines, ["Use write only for new files or complete rewrites."]);
});

test("包装器确实会剥掉元数据（钉住根因，别哪天又换回 createEditTool）", {
	skip: pi === undefined ? SKIP : false,
}, () => {
	assert.ok(pi);
	const cwd = process.cwd();
	// 这一组断言是**反例**：它证明 `createEditTool` / `createWriteTool` 拿不到元数据，
	// 所以扩展里出现这两个名字就是 bug。pi 升级后若包装器改成保留元数据，这里会失败 ——
	// 那时应该重新评估（届时用哪个都行，但注释里的根因描述要跟着改）。
	assert.equal(pi.createEditTool(cwd).promptSnippet, undefined, "包装器剥掉 edit 的 snippet");
	assert.equal(pi.createEditTool(cwd).promptGuidelines, undefined, "包装器剥掉 edit 的 guidelines");
	assert.equal(pi.createWriteTool(cwd).promptSnippet, undefined, "包装器剥掉 write 的 snippet");
	assert.equal(pi.createWriteTool(cwd).promptGuidelines, undefined, "包装器剥掉 write 的 guidelines");
	// 定义体则带着 —— 与上面两条形成对照。
	assert.ok(pi.createEditToolDefinition(cwd).promptSnippet, "定义体带 edit 的 snippet");
	assert.ok(pi.createWriteToolDefinition(cwd).promptSnippet, "定义体带 write 的 snippet");
});

test("换定义体没有丢执行侧字段（execute / parameters / constrainedSampling / prepareArguments）", {
	skip: pi === undefined ? SKIP : false,
}, () => {
	assert.ok(pi && registered);
	const edit = registered.get("edit")!.definition;
	const write = registered.get("write")!.definition;
	const builtinEdit = pi.createEditToolDefinition(process.cwd());

	assert.equal(typeof edit.execute, "function", "edit 的 execute 必须还在（否则工具调不动）");
	assert.equal(typeof write.execute, "function", "write 的 execute 必须还在");
	// deepEqual 而不是 equal：`constrainedSampling` 是定义体里内联的对象字面量，每次调用都是新对象，
	// 比身份永远不等。
	assert.deepEqual(edit.constrainedSampling, builtinEdit.constrainedSampling, "edit 的 constrainedSampling 必须原样继承");
	assert.equal(
		typeof edit.prepareArguments,
		"function",
		"edit 的 prepareArguments 必须还在（它负责把字符串 / 单对象形状的 edits 修成数组）",
	);
	assert.equal(edit.prepareArguments, builtinEdit.prepareArguments, "prepareArguments 必须是 pi 内置那一个");
	assert.equal(edit.description, builtinEdit.description, "description 必须原样继承");
});

test("渲染槽仍然是本扩展自己的（定义体自带的内置渲染器必须被覆盖掉）", {
	skip: pi === undefined ? SKIP : false,
}, () => {
	assert.ok(pi && registered);
	const cwd = process.cwd();
	const builtins: Record<string, ToolDefinitionLike> = {
		edit: pi.createEditToolDefinition(cwd),
		write: pi.createWriteToolDefinition(cwd),
	};
	for (const name of ["edit", "write"]) {
		const definition = registered.get(name)!.definition;
		assert.equal(definition.renderShell, "self", `${name} 必须走 self 壳（逐行底色才不会被整块盒子染色）`);
		assert.equal(typeof definition.renderCall, "function", `${name} 必须自带 renderCall`);
		assert.equal(typeof definition.renderResult, "function", `${name} 必须自带 renderResult`);
		// 定义体自带内置渲染器（`...editRenderers` / `...writeRenderers` 在末尾展开），所以
		// 「不是各自内置那一个」才是覆盖成功的证据 —— 否则 edit 会渲染两遗 diff、write 会把
		// 整个 content 铺出来。
		assert.notEqual(definition.renderCall, builtins[name]!.renderCall, `${name} 的 renderCall 必须覆盖内置实现`);
		assert.notEqual(
			definition.renderResult,
			builtins[name]!.renderResult,
			`${name} 的 renderResult 必须覆盖内置实现`,
		);
	}
});
