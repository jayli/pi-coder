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
