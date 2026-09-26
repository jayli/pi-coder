/**
 * background-tasks 扩展的装配验证：纯逻辑在 registry.test.ts 里；
 * 这里**不 mock pi**，用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）真加载
 * `index.ts`，然后驱动它注册的工具 / 命令 / 生命周期钩子。
 *
 * 工具执行用**真 spawn**（`echo` / `sleep`），所以完成通知、增量读、kill 都是端到端的。
 *
 *   node --test clients/pi/extensions/background-tasks/index.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

// =============================================================================
// 找到本机 pi 的库入口（memory/index.test.ts 同源）
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
	promptGuidelines?: string[];
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
	messageRenderers: Map<string, unknown>;
}

interface SentMessage {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

interface Harness {
	root: string;
	projectDir: string;
	logRoot: string;
	extension: LoadedExtension;
	notifies: Array<{ text: string; level?: string }>;
	sent: SentMessage[];
	idle: boolean;
	tool(name: string, params: unknown): Promise<{ text: string; details: any }>;
	command(args: string): Promise<void>;
	shutdown(): Promise<void>;
}

const cleanup: Array<() => void> = [];
test.after(() => {
	for (const fn of cleanup) fn();
});

async function loadHarness(): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }>; runtime: Record<string, unknown> }>;
		createEventBus: () => unknown;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-ext-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const logRoot = path.join(root, "bg-logs");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });

	// env 隔离：日志根指到临时目录。扩展在**每次工具调用时**才读 env（不是工厂里读一次），
	// 所以 env 必须活到 harness 用完为止 —— 在 test.after 里还原。
	const savedDir = process.env.PI_BACKGROUND_TASKS_DIR;
	const savedOff = process.env.PI_BACKGROUND_TASKS;
	process.env.PI_BACKGROUND_TASKS_DIR = logRoot;
	delete process.env.PI_BACKGROUND_TASKS;
	cleanup.push(() => {
		if (savedDir === undefined) delete process.env.PI_BACKGROUND_TASKS_DIR;
		else process.env.PI_BACKGROUND_TASKS_DIR = savedDir;
		if (savedOff === undefined) delete process.env.PI_BACKGROUND_TASKS;
		else process.env.PI_BACKGROUND_TASKS = savedOff;
	});

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 background-tasks 扩展");

	const harness: Harness = {
		root,
		projectDir,
		logRoot,
		extension,
		notifies: [],
		sent: [],
		idle: true,
		tool: async () => ({ text: "", details: undefined }),
		command: async () => {},
		shutdown: async () => {},
	};

	// loader.js 的 runtime 上 sendMessage 是抛错桩（notInitialized），
	// 但包装函数在**调用时**才读 runtime 属性，所以这里换成记录器就行。
	loaded.runtime.sendMessage = (message: SentMessage["message"], options?: SentMessage["options"]) => {
		harness.sent.push({ message, options });
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		isIdle: () => harness.idle,
		signal: undefined,
		ui: {
			notify: (text: string, level?: string) => harness.notifies.push({ text, level }),
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getBranch: () => [],
			buildContextEntries: () => [],
		},
	};

	harness.tool = async (name: string, params: unknown) => {
		const definition = extension.tools.get(name)?.definition;
		assert.ok(definition, `本扩展必须注册 ${name} 工具`);
		const result = await definition.execute("call-1", params, undefined, undefined, ctx);
		const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
		return { text, details: result.details as any };
	};

	harness.command = async (args: string) => {
		const command = extension.commands.get("background");
		assert.ok(command, "本扩展必须注册 /background 命令");
		await command.handler(args, ctx);
	};

	harness.shutdown = async () => {
		for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	};

	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return harness;
}

/** 轮询等待条件成立（真进程有调度延迟，不能靠固定 sleep）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "条件"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`等待超时：${label}`);
}

// =============================================================================
// 注册面
// =============================================================================

test("注册 3 个工具 + /background 命令 + 通知渲染器，工具带 promptSnippet", { skip }, async () => {
	const h = await loadHarness();
	for (const name of ["run_in_background", "background_output", "background_kill"]) {
		const definition = h.extension.tools.get(name)?.definition;
		assert.ok(definition, `必须注册 ${name} 工具`);
		// 没有 promptSnippet 的工具会从 system prompt 的 <tools> 段整体消失
		// （tool-diff 那个 bug 的教训），所以这里是硬断言。
		assert.ok(definition.promptSnippet, `${name} 必须带 promptSnippet，否则不进 <tools> 段`);
		assert.ok(definition.description.length > 40, `${name} 的 description 应当足够模型判断何时用`);
	}
	assert.ok(h.extension.commands.get("background"), "必须注册 /background 命令");
	assert.ok(h.extension.messageRenderers.get("background-task"), "必须注册终态通知的渲染器");
	assert.ok(h.extension.handlers.get("session_shutdown")?.length, "必须注册 session_shutdown 收尾");
	// run_in_background 的描述里要写明「不要轮询」与「不经过删除边界」
	const run = h.extension.tools.get("run_in_background")!.definition;
	assert.match(run.description, /do NOT sleep|never poll|不要/i);
	assert.match(run.description, /seatbelt|delete boundary/i);
	await h.shutdown();
});

test("PI_BACKGROUND_TASKS=off 时整个扩展不注册任何东西", { skip }, async () => {
	const saved = process.env.PI_BACKGROUND_TASKS;
	process.env.PI_BACKGROUND_TASKS = "off";
	try {
		const pi = (await import(pathToFileURL(piEntry as string).href)) as any;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-off-"));
		cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
		const loaded = await pi.discoverAndLoadExtensions(
			[EXTENSION_PATH],
			path.join(root, "p"),
			path.join(root, "a"),
			pi.createEventBus(),
		);
		assert.deepEqual(loaded.errors, []);
		const extension = loaded.extensions[0];
		// off 时工厂直接 return：工具表里没有本扩展的三个工具
		assert.equal(extension?.tools?.get("run_in_background"), undefined);
		assert.equal(extension?.commands?.get("background"), undefined);
	} finally {
		if (saved === undefined) delete process.env.PI_BACKGROUND_TASKS;
		else process.env.PI_BACKGROUND_TASKS = saved;
	}
});

// =============================================================================
// 端到端：真 spawn
// =============================================================================

test("run_in_background 立即返回 id / pid / 日志路径，命令真在跑", { skip }, async () => {
	const h = await loadHarness();
	const started = Date.now();
	const result = await h.tool("run_in_background", { command: "sleep 5" });
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 2000, `应当立即返回，实际花了 ${elapsed}ms`);
	assert.match(result.text, /bg_1/);
	assert.match(result.text, /pid \d+/);
	assert.equal(result.details.ok, true);
	assert.equal(result.details.task.status, "running");
	// 日志文件当场存在（工具结果把路径交给了模型，路径必须可用）
	assert.ok(fs.existsSync(result.details.task.logPath), "日志文件应当已创建");
	assert.match(result.details.task.logPath, new RegExp(h.logRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	// 别把 sleep 5 留在那儿
	await h.tool("background_kill", { id: "bg_1" });
	await h.shutdown();
});

test("空 command 与不存在的工作目录都被拒绝", { skip }, async () => {
	const h = await loadHarness();
	const empty = await h.tool("run_in_background", { command: "   " });
	assert.equal(empty.details.ok, false);
	assert.match(empty.text, /不能为空/);

	const badCwd = await h.tool("run_in_background", { command: "echo hi", cwd: "definitely-not-here" });
	assert.equal(badCwd.details.ok, false);
	assert.match(badCwd.text, /工作目录不存在/);
	await h.shutdown();
});

test("background_output 增量读到真输出，第二次不重复", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "printf 'line1\\n'; sleep 0.3; printf 'line2\\n'; sleep 3" });
	await waitFor(() => {
		const content = fs.readFileSync(path.join(h.logRoot, "test-session", "bg_1.log"), "utf-8");
		return content.includes("line1");
	}, 5000, "line1 出现在日志里");

	const first = await h.tool("background_output", { id: "bg_1" });
	assert.match(first.text, /line1/);
	assert.equal(first.details.read.from, 0);

	// 立刻再读一次：line1 不该重复出现
	const second = await h.tool("background_output", { id: "bg_1" });
	assert.doesNotMatch(second.text, /line1/);
	assert.match(second.text, /没有新输出|line2/);

	await waitFor(() => {
		const content = fs.readFileSync(path.join(h.logRoot, "test-session", "bg_1.log"), "utf-8");
		return content.includes("line2");
	}, 5000, "line2 出现在日志里");
	const third = await h.tool("background_output", { id: "bg_1" });
	assert.match(third.text, /line2/);

	await h.tool("background_kill", { id: "bg_1" });
	await h.shutdown();
});

test("stderr 也进同一条流（等价 2>&1）", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "echo to-stdout; echo to-stderr >&2; sleep 3" });
	await waitFor(() => {
		const content = fs.readFileSync(path.join(h.logRoot, "test-session", "bg_1.log"), "utf-8");
		return content.includes("to-stdout") && content.includes("to-stderr");
	}, 5000, "stdout 与 stderr 都进日志");
	const result = await h.tool("background_output", { id: "bg_1" });
	assert.match(result.text, /to-stdout/);
	assert.match(result.text, /to-stderr/);
	await h.tool("background_kill", { id: "bg_1" });
	await h.shutdown();
});

test("任务结束：注入 <background-task-notification> 并 triggerTurn 唤醒模型", { skip }, async () => {
	const h = await loadHarness();
	h.idle = true;
	await h.tool("run_in_background", { command: "echo done-and-exit" });
	await waitFor(() => h.sent.length > 0, 8000, "终态通知被注入");

	const sent = h.sent[0];
	assert.equal(sent.message.customType, "background-task");
	assert.equal(sent.message.display, true, "通知要对用户可见（CC 的 hook feedback 同形）");
	assert.match(sent.message.content, /<background-task-notification>/);
	assert.match(sent.message.content, /bg_1/);
	assert.match(sent.message.content, /成功结束（exit 0）/);
	assert.match(sent.message.content, /不需要再调 background_output 确认状态/, "要告诉模型别为了确认状态而轮询");
	assert.equal(sent.options?.triggerTurn, true, "必须触发一轮模型跟进");
	assert.equal(sent.options?.deliverAs, undefined, "空闲时直接起新一轮");
	await h.shutdown();
});

test("流式中结束：deliverAs=followUp，不打断当前推理", { skip }, async () => {
	const h = await loadHarness();
	h.idle = false; // 模拟模型正在流式输出
	await h.tool("run_in_background", { command: "echo quick" });
	await waitFor(() => h.sent.length > 0, 8000, "终态通知被注入");
	assert.equal(h.sent[0].options?.triggerTurn, true);
	assert.equal(h.sent[0].options?.deliverAs, "followUp");
	await h.shutdown();
});

test("非零退出与失败措辞", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "exit 3" });
	await waitFor(() => h.sent.length > 0, 8000, "终态通知被注入");
	assert.match(h.sent[0].message.content, /失败结束/);
	assert.match(h.sent[0].message.content, /exit=3/);
	await h.shutdown();
});

test("background_kill 真把进程停掉，终态是 killed", { skip }, async () => {
	const h = await loadHarness();
	const started = await h.tool("run_in_background", { command: "sleep 30" });
	const pid = started.details.task.pid as number;
	assert.ok(pid > 0);

	const killed = await h.tool("background_kill", { id: "bg_1" });
	assert.equal(killed.details.ok, true);
	assert.match(killed.text, /SIGTERM/);

	await waitFor(() => h.sent.length > 0, 8000, "killed 的终态通知");
	assert.match(h.sent[0].message.content, /被终止/);

	// 进程真的没了（不是只返回成功）
	await waitFor(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, 8000, "进程已消失");
	await h.shutdown();
});

test("kill 整个进程组：子进程派生的孙进程也一起走", { skip }, async () => {
	const h = await loadHarness();
	// bash -c 里再派生一个 sleep，并把它 pid 写进文件：
	// 只杀组长的话这个孙进程会活下来（detached + kill(-pid) 的意义就在这里）
	const pidFile = path.join(h.projectDir, "grandchild.pid");
	await h.tool("run_in_background", { command: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait` });
	await waitFor(() => fs.existsSync(pidFile), 8000, "孙进程 pid 文件写出");
	const grandchild = Number(fs.readFileSync(pidFile, "utf-8").trim());
	assert.ok(grandchild > 0);

	await h.tool("background_kill", { id: "bg_1" });
	await waitFor(() => {
		try {
			process.kill(grandchild, 0);
			return false;
		} catch {
			return true;
		}
	}, 10000, "孙进程也被组杀带走");
	await h.shutdown();
});

test("未知 id / 已终态任务的 kill 都给出可读原因", { skip }, async () => {
	const h = await loadHarness();
	const unknown = await h.tool("background_kill", { id: "bg_404" });
	assert.equal(unknown.details.ok, false);
	assert.match(unknown.text, /没有这个任务/);

	const unknownRead = await h.tool("background_output", { id: "bg_404" });
	assert.equal(unknownRead.details.ok, false);
	assert.match(unknownRead.text, /本会话还没启动过后台任务/);

	await h.tool("run_in_background", { command: "echo x" });
	await waitFor(() => h.sent.length > 0, 8000, "任务结束");
	const again = await h.tool("background_kill", { id: "bg_1" });
	assert.equal(again.details.ok, false);
	assert.match(again.text, /已经/);
	await h.shutdown();
});

test("cwd 参数生效（相对路径按会话 cwd 解析）", { skip }, async () => {
	const h = await loadHarness();
	const sub = path.join(h.projectDir, "sub");
	fs.mkdirSync(sub, { recursive: true });
	await h.tool("run_in_background", { command: "pwd > where.txt", cwd: "sub" });
	await waitFor(() => fs.existsSync(path.join(sub, "where.txt")), 8000, "命令在 sub 目录里跑完");
	assert.equal(fs.readFileSync(path.join(sub, "where.txt"), "utf-8").trim(), fs.realpathSync(sub));
	await h.shutdown();
});

// =============================================================================
// /background 命令
// =============================================================================

test("/background 列表、详情、kill 三个形态", { skip }, async () => {
	const h = await loadHarness();
	await h.command("");
	assert.match(h.notifies.at(-1)!.text, /没有后台任务/);
	assert.match(h.notifies.at(-1)!.text, /不经过前台 bash 的 seatbelt 删除边界/, "列表里要印沙箱提示");

	await h.tool("run_in_background", { command: "echo hello-from-bg; sleep 3" });
	h.notifies.length = 0;
	await h.command("");
	const list = h.notifies.at(-1)!.text;
	assert.match(list, /后台任务 1 个（在跑 1）/);
	assert.match(list, /bg_1\s+running/);
	assert.match(list, /echo hello-from-bg/);

	h.notifies.length = 0;
	await h.command("bg_1");
	const detail = h.notifies.at(-1)!.text;
	assert.match(detail, /^bg_1\s+running/m);
	assert.match(detail, /cwd: /);
	assert.match(detail, /日志: /);

	h.notifies.length = 0;
	await h.command("bg_404");
	assert.match(h.notifies.at(-1)!.text, /没有这个任务/);
	assert.equal(h.notifies.at(-1)!.level, "warning");

	h.notifies.length = 0;
	await h.command("kill");
	assert.match(h.notifies.at(-1)!.text, /用法：\/background kill <id>/);

	h.notifies.length = 0;
	await h.command("kill bg_1");
	assert.match(h.notifies.at(-1)!.text, /已向 bg_1 发送 SIGTERM/);
	await waitFor(() => h.sent.length > 0, 8000, "kill 后的终态通知");
	await h.shutdown();
});

test("/background 详情读日志尾部，不推进模型的增量 offset", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "echo first-line; sleep 3" });
	await waitFor(() => {
		const content = fs.readFileSync(path.join(h.logRoot, "test-session", "bg_1.log"), "utf-8");
		return content.includes("first-line");
	}, 8000, "输出落盘");

	h.notifies.length = 0;
	await h.command("bg_1");
	assert.match(h.notifies.at(-1)!.text, /first-line/, "详情里应当看到输出");

	// 关键：/background 不该吃掉模型的增量读 —— 之后 background_output 仍要能读到 first-line
	const result = await h.tool("background_output", { id: "bg_1" });
	assert.match(result.text, /first-line/);
	assert.equal(result.details.read.from, 0);

	await h.tool("background_kill", { id: "bg_1" });
	await h.shutdown();
});

// =============================================================================
// 生命周期
// =============================================================================

test("session_shutdown 杀掉在跑的任务（不留孤儿进程）", { skip }, async () => {
	const h = await loadHarness();
	const started = await h.tool("run_in_background", { command: "sleep 30" });
	const pid = started.details.task.pid as number;
	await h.shutdown();
	await waitFor(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, 10000, "shutdown 之后进程应当消失");
});

test("session_shutdown 幂等：连跑两次不抛", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });
	await h.shutdown();
	await h.shutdown();
	// shutdown 之后终态通知不再注入（否则会在会话结束后凭空起一轮）
	const before = h.sent.length;
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(h.sent.length, before, "shutdown 后不该再有新通知");
});

test("shutdown 后结束的任务不再注入通知", { skip }, async () => {
	const h = await loadHarness();
	// 用一个自己会很快结束的命令，但在它结束前先 shutdown
	await h.tool("run_in_background", { command: "sleep 0.4; echo late" });
	await h.shutdown(); // 会 SIGTERM 掉它 → 终态在 shutdown 之后到达
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(h.sent.length, 0, "disposed 之后不该注入任何通知");
});

test("会话替换（shutdown → session_start）后新任务仍能唤醒：disposed 被复位", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "echo old-session" });
	await waitFor(() => h.sent.length > 0, 8000, "第一个任务结束");

	// 模拟 /clear：shutdown 后新会话的 session_start
	await h.shutdown();
	for (const handler of h.extension.handlers.get("session_start") ?? []) await handler({}, {});

	// 新会话里的任务：完成时仍要能注入通知（disposed 被复位了）
	await h.tool("run_in_background", { command: "echo new-session" });
	await waitFor(() => h.sent.length > 1, 8000, "新会话的任务也注入了通知");
	assert.match(h.sent[1].message.content, /new-session/);
	await h.shutdown();
});

test("旧 registry 的迟到终态不注入新会话（registry 身份闸）", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });
	// shutdown 会 killAll（SIGTERM 旧任务）并销毁 registry；紧接着新会话 session_start 复位 disposed
	await h.shutdown();
	for (const handler of h.extension.handlers.get("session_start") ?? []) await handler({}, {});
	// 新会话起一个**不会在测试窗口内结束**的任务（新 registry）：
	// 若旧任务的迟到 exit 被错误注入，sent 会多出一条；用长任务排除新任务自身完成的干扰
	await h.tool("run_in_background", { command: "sleep 30" });
	const before = h.sent.length;
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(h.sent.length, before, "旧 registry 的迟到终态不该注入新会话");
	await h.tool("background_kill", { id: "bg_1" });
	await h.shutdown();
});
