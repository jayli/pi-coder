/**
 * memory 扩展的装配验证：纯逻辑在 store/context 各自的测试里；
 * 这里**不 mock pi**，用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）真加载
 * `index.ts`，然后驱动它注册的工具与 `before_agent_start` handler。
 *
 *   node --test clients/pi/extensions/memory/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// 找到本机 pi 的库入口（verify-loop/index.test.ts 同源）
// =============================================================================

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
			// 不是符号链接 / 不存在
		}
		try {
			const match = /^# cmd-shim-target=(.+)$/m.exec(fs.readFileSync(shimPath, "utf8"));
			if (match?.[1]) candidates.push(path.join(path.dirname(match[1].trim()), "index.js"));
		} catch {
			// 读不到这个 shim
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
			// 空壳副本：换下一个
		}
	}
	return undefined;
}

/**
 * pi 自带的 chalk 在模块求值时就定好「要不要输出样式」（非 TTY 下默认关掉）。
 * 底色断言看的是 SGR 序列，必须在 import pi 之前设 FORCE_COLOR（同 simple-task/render.test.ts）。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

// =============================================================================
// 加载与驱动
// =============================================================================

interface ToolDefinitionLike {
	name: string;
	description: string;
	promptSnippet?: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
	tools: Map<string, { definition: ToolDefinitionLike }>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

interface Harness {
	extension: LoadedExtension;
	root: string;
	projectDir: string;
	memoryDir: string;
	notifies: string[];
	widgets: Array<{ key: string; content: string[] | undefined }>;
	selects: Array<{ title: string; options: string[] }>;
	/** 下一次 ctx.ui.select 返回的选项（测试注入）。 */
	selectReply: string | undefined;
	tool(name: string, params: unknown): Promise<{ text: string; details: unknown }>;
	beforeAgentStart(): Promise<{ sections: Record<string, string> }>;
	command(args: string): Promise<void>;
}

async function loadHarness(): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
		createEventBus: () => unknown;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const memoryRoot = path.join(root, "memory-root");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	// env 隔离：PI_MEMORY_DIR 覆盖记忆根（slug 仍生效，所以记忆目录是 memoryRoot/<slug>）。
	// 注意：扩展是**每次工具调用 / 每次注入时**才读 env（不是工厂里读一次），
	// 所以 env 必须活到 harness 用完为止 —— 在 test.after 里还原。
	const savedDir = process.env.PI_MEMORY_DIR;
	const savedOff = process.env.PI_MEMORY;
	process.env.PI_MEMORY_DIR = memoryRoot;
	delete process.env.PI_MEMORY;
	cleanup.push(() => {
		if (savedDir === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = savedDir;
		if (savedOff === undefined) delete process.env.PI_MEMORY;
		else process.env.PI_MEMORY = savedOff;
	});

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());

	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 memory 扩展");

	const harness: Harness = {
		extension,
		root,
		projectDir,
		memoryDir: path.join(memoryRoot, projectDir.replace(/[/.]/g, "-")),
		notifies: [],
		widgets: [],
		selects: [],
		selectReply: undefined,
		tool: async () => ({ text: "", details: undefined }),
		beforeAgentStart: async () => ({ sections: {} }),
		command: async () => {},
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => true,
		signal: undefined,
		ui: {
			notify: (text: string) => harness.notifies.push(text),
			setWidget: (key: string, content: string[] | undefined) => harness.widgets.push({ key, content }),
			select: async (title: string, options: string[]) => {
				harness.selects.push({ title, options });
				return harness.selectReply;
			},
		},
	};

	harness.tool = async (name: string, params: unknown) => {
		const definition = extension.tools.get(name)?.definition;
		assert.ok(definition, `本扩展必须注册 ${name} 工具`);
		const result = await definition.execute("call-1", params, undefined, undefined, ctx);
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
		return { text, details: result.details };
	};

	harness.beforeAgentStart = async () => {
		const handlers = extension.handlers.get("before_agent_start") ?? [];
		const sections: Record<string, string> = {};
		const event = { type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections } };
		for (const handler of handlers) await handler(event, ctx);
		return { sections };
	};

	harness.command = async (args: string) => {
		const command = extension.commands.get("memory");
		assert.ok(command, "本扩展必须注册 /memory 命令");
		await command.handler(args, ctx);
	};

	return harness;
}

const cleanup: Array<() => void> = [];
test.after(() => {
	for (const fn of cleanup) fn();
});

// =============================================================================
// 用例
// =============================================================================

test("注册 4 个工具 + /memory 命令，工具带 promptSnippet", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	for (const name of ["memory_write", "memory_read", "memory_forget", "memory_search"]) {
		const definition = h.extension.tools.get(name)?.definition;
		assert.ok(definition, `必须注册 ${name} 工具`);
		// issue #13 那个 bug 的回归点：包装器会静默剥掉 promptSnippet，
		// 丢了它工具就从 system prompt 的 <tools> 段整体消失。
		assert.ok(definition.promptSnippet, `${name} 必须带 promptSnippet，否则不进 <tools> 段`);
		const result = await h.tool(name, { name: "probe", query: "probe", description: "d", type: "user", content: "c" });
		assert.ok(typeof result.text === "string");
	}
	assert.ok(h.extension.commands.has("memory"), "必须注册 /memory 命令");
	await h.command("");
	assert.equal(h.selects[0]?.title, "Memory");
});

test("memory_write 落盘 + 机械重建索引", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	const result = await h.tool("memory_write", {
		name: "gitlab-push-rule",
		description: "内网 GitLab 拒绝非公司邮箱提交",
		type: "project",
		content: "推送被 pre-receive hook 拒绝。\n\n**Why:** push rule 要求公司邮箱。\n**How to apply:** 用 bachi@taobao.com。",
	});
	assert.match(result.text, /Saved memory "gitlab-push-rule"/);

	const memoryFile = path.join(h.memoryDir, "gitlab-push-rule.md");
	assert.ok(fs.existsSync(memoryFile), "正文文件必须落盘");
	const text = fs.readFileSync(memoryFile, "utf-8");
	assert.match(text, /^---\nname: gitlab-push-rule/);
	assert.match(text, /type: project/);
	assert.match(text, /modified: \d{4}-\d{2}-\d{2}T/);
	assert.match(text, /\*\*Why:\*\*/);

	const index = fs.readFileSync(path.join(h.memoryDir, "MEMORY.md"), "utf-8");
	assert.match(index, /^# Memory Index/);
	assert.match(index, /- \[gitlab-push-rule\]\(gitlab-push-rule\.md\) — project — 内网 GitLab 拒绝非公司邮箱提交/);
});

test("memory_write 同名更新而非重复", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	const base = { name: "pref", description: "d", type: "feedback", content: "v1" };
	await h.tool("memory_write", base);
	const second = await h.tool("memory_write", { ...base, content: "v2" });
	assert.match(second.text, /Updated memory "pref"/);
	assert.match(fs.readFileSync(path.join(h.memoryDir, "pref.md"), "utf-8"), /v2/);
	const index = fs.readFileSync(path.join(h.memoryDir, "MEMORY.md"), "utf-8");
	assert.equal(index.split("- [pref]").length - 1, 1, "索引里只能有一条");
});

test("memory_write 拒绝非法 name / type / 空内容", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	const bad = await h.tool("memory_write", { name: "../evil", description: "d", type: "user", content: "x" });
	assert.match(bad.text, /Invalid memory name/);
	const badType = await h.tool("memory_write", { name: "ok", description: "d", type: "nope", content: "x" });
	assert.match(badType.text, /Invalid type/);
	const empty = await h.tool("memory_write", { name: "ok", description: "", type: "user", content: "" });
	assert.match(empty.text, /required/);
	assert.ok(!fs.existsSync(path.join(h.memoryDir, "evil.md")), "非法名不得落盘");
});

test("before_agent_start 注入 sections.memory（纪律 + 索引）", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	// 空库不注入
	const empty = await h.beforeAgentStart();
	assert.equal(empty.sections.memory, undefined);

	await h.tool("memory_write", { name: "nuc-terminfo", description: "nuc 缺 xterm-ghostty terminfo", type: "reference", content: "退格不重绘。" });
	const injected = await h.beforeAgentStart();
	assert.ok(injected.sections.memory, "有记忆时必须注入");
	assert.match(injected.sections.memory, /# auto memory/);
	assert.match(injected.sections.memory, /past-tense observations/);
	assert.match(injected.sections.memory, /- \[nuc-terminfo\]/);
});

test("手改正文文件后索引自动跟上（幂等）", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	await h.tool("memory_write", { name: "a", description: "d", type: "user", content: "c" });
	// 用户手工新增一个记忆文件（不经工具）
	fs.writeFileSync(
		path.join(h.memoryDir, "b.md"),
		"---\nname: b\ndescription: hand written\nmetadata:\n  type: feedback\n  modified: 2026-09-26T00:00:00.000Z\n---\n\nbody\n",
		"utf-8",
	);
	const before = fs.readFileSync(path.join(h.memoryDir, "MEMORY.md"), "utf-8");
	assert.ok(!before.includes("hand written"), "注入前索引还没有手改的那条");

	await h.beforeAgentStart();
	const after = fs.readFileSync(path.join(h.memoryDir, "MEMORY.md"), "utf-8");
	assert.match(after, /hand written/, "before_agent_start 应把手改的文件纳入索引");

	// 再跑一次：内容一致则 mtime 不变（幂等）
	const mtime = fs.statSync(path.join(h.memoryDir, "MEMORY.md")).mtimeMs;
	await h.beforeAgentStart();
	assert.equal(fs.statSync(path.join(h.memoryDir, "MEMORY.md")).mtimeMs, mtime);
});

test("memory_read 读正文 / 列全部 / 未命中", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	await h.tool("memory_write", { name: "one", description: "first", type: "user", content: "body one" });
	const read = await h.tool("memory_read", { name: "one" });
	assert.match(read.text, /body one/);
	assert.match(read.text, /type: user/);

	const list = await h.tool("memory_read", {});
	assert.match(list.text, /- one \(user/);

	const miss = await h.tool("memory_read", { name: "nope" });
	assert.match(miss.text, /No memory named "nope"/);
});

test("memory_forget 删文件并更新索引", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	await h.tool("memory_write", { name: "gone", description: "d", type: "project", content: "c" });
	const result = await h.tool("memory_forget", { name: "gone" });
	assert.match(result.text, /Deleted memory "gone"/);
	assert.ok(!fs.existsSync(path.join(h.memoryDir, "gone.md")));
	assert.ok(!fs.readFileSync(path.join(h.memoryDir, "MEMORY.md"), "utf-8").includes("gone"));

	const miss = await h.tool("memory_forget", { name: "gone" });
	assert.match(miss.text, /nothing deleted/);
});

test("memory_search 命中正文与描述", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	await h.tool("memory_write", { name: "ghostty", description: "terminfo 缺失", type: "reference", content: "nuc 上退格不重绘" });
	await h.tool("memory_write", { name: "unrelated", description: "别的", type: "user", content: "无关内容" });

	const hit = await h.tool("memory_search", { query: "terminfo" });
	assert.match(hit.text, /## ghostty/);
	assert.ok(!hit.text.includes("## unrelated"));

	const miss = await h.tool("memory_search", { query: "zzz-nothing" });
	assert.match(miss.text, /No memories match/);
});

test("/memory 菜单：状态行 + 三项操作", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	await h.tool("memory_write", { name: "x", description: "d", type: "user", content: "c" });

	h.selectReply = "Show memory index";
	await h.command("");
	const menu = h.selects[0];
	assert.equal(menu.title, "Memory");
	assert.match(menu.options[0], /Auto-memory: on · 1 memories/);
	assert.deepEqual(menu.options.slice(1), ["Open memory folder", "Show memory index", "Disable auto-memory"]);
	assert.equal(h.widgets[0]?.key, "memory-index");
	assert.ok(h.widgets[0]?.content?.some((line) => line.includes("[x](x.md)")));
});

test("/memory 切换 off 后：不注入、工具拒写、菜单变 Enable", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));

	await h.tool("memory_write", { name: "x", description: "d", type: "user", content: "c" });
	h.selectReply = "Disable auto-memory";
	await h.command("");
	assert.match(h.notifies.at(-1) ?? "", /disabled/);
	assert.ok(fs.existsSync(path.join(h.memoryDir, ".disabled")));

	const injected = await h.beforeAgentStart();
	assert.equal(injected.sections.memory, undefined, "关闭后不得注入");

	const blocked = await h.tool("memory_write", { name: "y", description: "d", type: "user", content: "c" });
	assert.match(blocked.text, /Memory is disabled/);
	assert.ok(!fs.existsSync(path.join(h.memoryDir, "y.md")));

	h.selectReply = undefined;
	await h.command("");
	assert.ok(h.selects.at(-1)?.options.includes("Enable auto-memory"));

	h.selectReply = "Enable auto-memory";
	await h.command("");
	assert.ok(!fs.existsSync(path.join(h.memoryDir, ".disabled")));
	const back = await h.beforeAgentStart();
	assert.ok(back.sections.memory, "重新开启后恢复注入");
});

test("PI_MEMORY=off 时扩展整体不注册", { skip }, async () => {
	const savedDir = process.env.PI_MEMORY_DIR;
	const savedOff = process.env.PI_MEMORY;
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-off-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	process.env.PI_MEMORY = "off";
	process.env.PI_MEMORY_DIR = path.join(root, "mem");
	try {
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				paths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{ extensions: LoadedExtension[]; errors: unknown[] }>;
			createEventBus: () => unknown;
		};
		const projectDir = path.join(root, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, path.join(root, "agent"), pi.createEventBus());
		assert.deepEqual(loaded.errors, []);
		const extension = loaded.extensions[0];
		// 工厂提前 return：没有工具、没有命令、没有 handler
		assert.equal(extension?.tools.size ?? 0, 0);
		assert.equal(extension?.commands.size ?? 0, 0);
	} finally {
		if (savedDir === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = savedDir;
		if (savedOff === undefined) delete process.env.PI_MEMORY;
		else process.env.PI_MEMORY = savedOff;
	}
});

// =============================================================================
// 工具块的渲染形态（用户 2026-09-30 定：与 bash / plan / 后台任务块同族的树形 self 壳）
//
// 这一节断言的是「用户屏幕上长什么样」：屏幕上的行是 `ToolExecutionComponent` →
// `renderCall` / `renderResult` → 壳（contentBox / selfRenderContainer）一层层叠出来的，
// 只断言 `renderShell === "self"` 会漏掉「self 模式下底色真的没画上去」这一半。
// =============================================================================

/** 假主题：丢掉颜色以便断言可见文本；bold 也原样返回。 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** 着色主题：把每段包成 `slot(text)` 以便断言用的是哪个语义色槽（与 background-tasks/index.test.ts 同形）。 */
const paintedTheme = {
	fg: (color: string, text: string) => `${color}(${text})`,
	bold: (text: string) => text,
};

/** 剥掉所有 ANSI / OSC 转义，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 底色判定：行里带背景 SGR 序列（`48;2;…` / `40-47` / `100-107`）就算有底色。 */
const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);

/** 造一个渲染 context：state 是跨 renderCall/renderResult 共享的同一个对象（与 pi 一致）。 */
function renderContext(overrides: { isPartial?: boolean; isError?: boolean } = {}) {
	return {
		state: {} as { outcome?: string },
		isPartial: overrides.isPartial ?? false,
		isError: overrides.isError ?? false,
	};
}

/** memory_write 成功那条的真实形状（用户给的那两行，宽 80 下不折行）。 */
const WRITE_RESULT = {
	content: [
		{
			type: "text",
			text: 'Updated memory "checkmark-means-task-finished-not-call-succeeded"\n(feedback). Index: 4 memories.',
		},
	],
	details: { action: "updated", name: "checkmark-means-task-finished-not-call-succeeded", type: "feedback", totalCount: 4 },
};

const MEMORY_TOOLS = ["memory_write", "memory_read", "memory_forget", "memory_search"];

test("四个工具都用 self 壳（去底色 + 去上下空行的唯一途径）", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	for (const name of MEMORY_TOOLS) {
		const definition = h.extension.tools.get(name)?.definition as any;
		assert.ok(definition, `必须注册 ${name} 工具`);
		assert.equal(definition.renderShell, "self", `${name} 应设 renderShell: "self"`);
		assert.equal(typeof definition.renderCall, "function", `${name} 应有 renderCall`);
		assert.equal(typeof definition.renderResult, "function", `${name} 应有 renderResult`);
	}
});

test("标题行：成功是绿 • 工具名，顶格、无任何标记（state 传递）", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const definition = h.extension.tools.get("memory_write")!.definition as any;

	// 成功：先跑 renderResult 写 state.outcome，再 renderCall 读它（pi 的真实顺序是
	// callRenderer 先于 resultRenderer，但屏幕绘制在两者之后，所以懒组件读到的是写好的值）。
	const okCtx = renderContext();
	definition.renderResult(WRITE_RESULT, { expanded: false }, plainTheme, okCtx);
	const okTitle = plain(definition.renderCall({}, plainTheme, okCtx).render(80)[0]!);
	assert.equal(okTitle, "• memory_write", `成功标题（顶格、无标记）：${JSON.stringify(okTitle)}`);
	assert.ok(!okTitle.includes("✔") && !okTitle.includes("✘"), "工具块不该出现任何标记");
	// 成功与 pending / declined 的可见文本相同，区分只在圆点颜色：成功走 success（绿）。
	const okPainted = definition.renderCall({}, paintedTheme, okCtx).render(80)[0]!;
	assert.match(okPainted, /success\(\u2022\)/, "成功圆点走 success 槽（绿）");
});

test("标题行：没办成（rejected / not_found）是灰点、真错误是红点，都无标记", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const definition = h.extension.tools.get("memory_read")!.definition as any;

	const declinedCtx = renderContext();
	definition.renderResult(
		{ content: [{ type: "text", text: 'No memory named "nope".' }], details: { action: "not_found", name: "nope" } },
		{ expanded: false },
		plainTheme,
		declinedCtx,
	);
	assert.equal(
		plain(definition.renderCall({}, plainTheme, declinedCtx).render(80)[0]!),
		"• memory_read",
		"declined 标题同样无标记",
	);
	assert.match(definition.renderCall({}, paintedTheme, declinedCtx).render(80)[0]!, /dim\(\u2022\)/, "declined 圆点走 dim 槽（灰）");

	// isError 只在 context 上（pi 传给 resultRenderer 的对象没有这个字段）
	const errCtx = renderContext({ isError: true });
	definition.renderResult({ content: [{ type: "text", text: "boom" }], details: {} }, { expanded: false }, plainTheme, errCtx);
	assert.match(definition.renderCall({}, paintedTheme, errCtx).render(80)[0]!, /error\(\u2022\)/, "真错误圆点走 error 槽（红）");
	assert.ok(!definition.renderCall({}, paintedTheme, errCtx).render(80)[0]!.includes("success("), "错误时不该出现 success 槽");
});

test("标题行：执行中（结果未到）是灰 • 工具名", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const definition = h.extension.tools.get("memory_search")!.definition as any;
	const ctx = renderContext({ isPartial: true });
	assert.equal(plain(definition.renderCall({}, plainTheme, ctx).render(80)[0]!), "• memory_search");
	assert.match(definition.renderCall({}, paintedTheme, ctx).render(80)[0]!, /dim\(\u2022\)/, "执行中圆点走 dim 槽（灰）");
});

test("正文：结果全文折行挂树，除末行外 │、末行 └，正文对齐第 5 列（工具名首字母 m 正下方）", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const definition = h.extension.tools.get("memory_write")!.definition as any;
	const lines = definition.renderResult(WRITE_RESULT, { expanded: false }, plainTheme, renderContext()).render(80).map(plain);

	assert.equal(lines.length, 2, `两行正文（宽 80 不折行）：${JSON.stringify(lines)}`);
	assert.ok(lines[0]!.startsWith("  │ "), `首行挂 │（2 列缩进）：${JSON.stringify(lines[0])}`);
	assert.ok(lines[1]!.startsWith("  └ "), `末行挂 └：${JSON.stringify(lines[1])}`);
	assert.equal(lines.filter((line: string) => line.includes("└")).length, 1, "└ 只能出现一次");
	// 树符在列 2（`memory_write` 首字母 m 正下方），正文从列 4 起
	assert.equal(lines[0]!.indexOf("│"), 2, `│ 在列 2：${JSON.stringify(lines[0])}`);
	assert.equal(lines[0]!.indexOf("Updated memory"), 4, `正文列：${JSON.stringify(lines[0])}`);
	assert.equal(lines[1]!.indexOf("(feedback)"), 4, `末行正文列：${JSON.stringify(lines[1])}`);

	// 结构符走 muted 槽、正文走 text 槽，且各自成一段 SGR（不让正文色透到结构符上）
	const painted = definition.renderResult(WRITE_RESULT, { expanded: false }, paintedTheme, renderContext()).render(80);
	assert.match(painted[0]!, /^ {2}muted\(│ \)text\(/, `结构符 muted、正文 text：${JSON.stringify(painted[0])}`);
});

test("正文：长行折行后 └ 仍只在最后一个视觉行（碎片也算独立行）", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const definition = h.extension.tools.get("memory_read")!.definition as any;
	const long = "这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的记忆正文";
	const lines = definition
		.renderResult({ content: [{ type: "text", text: long }], details: { action: "read" } }, { expanded: false }, plainTheme, renderContext())
		.render(30)
		.map(plain);
	assert.ok(lines.length > 1, `窄宽度下应折成多行：${JSON.stringify(lines)}`);
	assert.equal(lines.filter((line: string) => line.includes("└")).length, 1, `└ 只能出现一次：${JSON.stringify(lines)}`);
	assert.ok(lines[lines.length - 1]!.includes("└"), `└ 必须在最后一行：${JSON.stringify(lines)}`);
	assert.ok(lines.slice(0, -1).every((line: string) => line.includes("│")), `其余行都挂 │：${JSON.stringify(lines)}`);
});

test("预览截断：超过 10 行只画 10 行 + 提示行，展开态（ctrl+o）不裁", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const definition = h.extension.tools.get("memory_read")!.definition as any;
	// memory_read 不带 name 时一条记忆一行，库大了就会超屏
	const many = Array.from({ length: 14 }, (_unused, index) => `- memory-${index + 1} (user) — d`).join("\n");
	const result = { content: [{ type: "text", text: many }], details: { action: "list", count: 14 } };

	const collapsed = definition.renderResult(result, { expanded: false }, plainTheme, renderContext()).render(80).map(plain);
	assert.equal(collapsed.length, 11, `10 行正文 + 1 行提示：${JSON.stringify(collapsed)}`);
	assert.match(collapsed[10]!, /4 more lines, ctrl\+o to expand/, `提示行：${JSON.stringify(collapsed[10])}`);
	assert.ok(collapsed[10]!.includes("└"), "提示行是树的末行，挂 └");
	assert.ok(!collapsed.join("\n").includes("memory-11"), "被裁的行不该出现");

	const expandedLines = definition.renderResult(result, { expanded: true }, plainTheme, renderContext()).render(80).map(plain);
	assert.equal(expandedLines.length, 14, `展开态全画：${JSON.stringify(expandedLines)}`);
	assert.ok(expandedLines.join("\n").includes("memory-14"), "展开态含最后一行");
	assert.ok(!expandedLines.some((line: string) => line.includes("to expand")), "展开态不出提示行");
});

test("整块无底色、无上下边界空行：经 pi 真实组件渲染后不含背景 SGR", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		initTheme: (name?: string) => void;
		ToolExecutionComponent: new (
			toolName: string,
			toolCallId: string,
			args: unknown,
			options: unknown,
			toolDefinition: unknown,
			ui: { requestRender(): void },
			cwd: string,
		) => {
			setArgsComplete?: () => void;
			markExecutionStarted: () => void;
			updateResult: (result: unknown, isPartial?: boolean) => void;
			render: (width: number) => string[];
		};
	};
	pi.initTheme("dark");

	for (const [name, result] of [
		["memory_write", WRITE_RESULT],
		["memory_read", { content: [{ type: "text", text: "name: one\ntype: user\n\nbody one" }], details: { action: "read", name: "one" } }],
		["memory_forget", { content: [{ type: "text", text: 'Deleted memory "gone".' }], details: { action: "deleted", name: "gone" } }],
		["memory_search", { content: [{ type: "text", text: "## one (user)\nd\nsnippet" }], details: { action: "search", count: 1 } }],
	] as Array<[string, { content: unknown[]; details: unknown }]>) {
		const definition = h.extension.tools.get(name)!.definition;
		for (const [label, res] of [
			["成功", result],
			["失败", { content: [{ type: "text", text: "boom" }], details: {}, isError: true }],
		] as Array<[string, unknown]>) {
			const component = new pi.ToolExecutionComponent(name, "call-1", {}, {}, definition, { requestRender() {} }, h.projectDir);
			component.setArgsComplete?.();
			component.markExecutionStarted();
			component.updateResult(res, false);
			const raw = component.render(80);
			assert.deepEqual(raw.filter(hasBg), [], `${name} ${label}：记忆块不该有任何底色行`);
			assert.equal(raw[0], "", `${name} ${label}：第 0 行是 pi self 模式固定的留白`);
			assert.notEqual(raw[raw.length - 1]!.trim(), "", `${name} ${label}：最后一行不是空行（无下边界空行）`);

			const visible = raw.map(plain).filter((line) => line.trim() !== "");
			assert.equal(visible[0], `• ${name}`, `${name} ${label}：标题行顶格（圆点前无空格、无标记）：${JSON.stringify(visible[0])}`);
			assert.equal(visible[0]!.indexOf(name), 2, `${name} ${label}：工具名首字母在列 2：${JSON.stringify(visible[0])}`);
			// 树符与标题对齐：`│` / `└` 在列 2，正好是工具名首字母的正下方
			for (const line of visible.slice(1)) {
				assert.equal(line.search(/[│└]/), 2, `${name} ${label}：树符应在列 2：${JSON.stringify(line)}`);
			}
		}
	}

	// 对照：其他工具（不给 toolDefinition，走 pi 的通用渲染路径）底色照旧 ——
	// 钉住「只去记忆块的」那半边。
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, h.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	assert.equal(other.render(80).some(hasBg), true, "其他工具的底色必须还在");
});

test("执行中的块：只有标题行、无正文、无底色", { skip }, async () => {
	const h = await loadHarness();
	cleanup.push(() => fs.rmSync(h.root, { recursive: true, force: true }));
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		initTheme: (name?: string) => void;
		ToolExecutionComponent: new (
			toolName: string,
			toolCallId: string,
			args: unknown,
			options: unknown,
			toolDefinition: unknown,
			ui: { requestRender(): void },
			cwd: string,
		) => { setArgsComplete?: () => void; markExecutionStarted: () => void; render: (width: number) => string[] };
	};
	pi.initTheme("dark");
	const definition = h.extension.tools.get("memory_write")!.definition;
	const component = new pi.ToolExecutionComponent("memory_write", "call-1", { name: "x" }, {}, definition, { requestRender() {} }, h.projectDir);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	const raw = component.render(80);
	assert.deepEqual(raw.filter(hasBg), [], "执行中也不该有底色（toolPendingBg 同样不画）");
	const visible = raw.map(plain).filter((line) => line.trim() !== "");
	assert.deepEqual(visible, ["• memory_write"], `执行中只有标题行：${JSON.stringify(visible)}`);
});
