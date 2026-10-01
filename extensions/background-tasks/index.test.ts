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
import { spawnSync } from "node:child_process";
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
	statuses: Map<string, string | undefined>;
	/** 每一次 setStatus 调用的完整记录（dock 测试要数次数 / 看时序）。 */
	statusSets: Array<{ key: string; text: string | undefined }>;
	sent: SentMessage[];
	idle: boolean;
	tool(name: string, params: unknown): Promise<{ text: string; details: any }>;
	command(args: string): Promise<void>;
	shutdown(): Promise<void>;
	/** 把隔离相关的环境变量拨到指定的样子（每个用例用完自己还原）。 */
	setIsolationEnv(values: { worktree?: string; tmpdir?: string }): void;
}

const cleanup: Array<() => void> = [];
/**
 * 隔离环境（`PI_BACKGROUND_TASKS_WORKTREE` / `TMPDIR`）的待还原项。
 *
 * 单独一个列表而不是混在 `cleanup` 里：`cleanup` 要到整个文件跑完才执行，而这两个环境变量
 * **必须每个用例间就还原** —— 否则前一个用例设的 `TMPDIR` 会把后一个用例的 worktree 落到前一个
 * 用例的临时目录里（实测：路径会一层层嵌套），`WORKTREE=off` 也会漏到下一个用例、把它的隔离
 * 偷偷关掉。所以每次 `loadHarness()` 开头先把上一轮的还回去。
 */
let pendingEnvRestores: Array<() => void> = [];

function restoreIsolationEnv(): void {
	for (const restore of pendingEnvRestores.splice(0).reverse()) restore();
}

test.after(() => {
	restoreIsolationEnv();
	for (const fn of cleanup) fn();
});

async function loadHarness(): Promise<Harness> {
	// 上一个用例留下的隔离环境先还回去（见 pendingEnvRestores 的注释）
	restoreIsolationEnv();
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
	// dock 的两个旋钮（PI_BACKGROUND_TASKS_DOCK / _LINGER_MS）是工厂期读的，
	// 用例在调 loadHarness 之前自己设，这里统一还原。
	const savedDir = process.env.PI_BACKGROUND_TASKS_DIR;
	const savedOff = process.env.PI_BACKGROUND_TASKS;
	const savedDock = process.env.PI_BACKGROUND_TASKS_DOCK;
	const savedLinger = process.env.PI_BACKGROUND_TASKS_DOCK_LINGER_MS;
	process.env.PI_BACKGROUND_TASKS_DIR = logRoot;
	delete process.env.PI_BACKGROUND_TASKS;
	cleanup.push(() => {
		if (savedDir === undefined) delete process.env.PI_BACKGROUND_TASKS_DIR;
		else process.env.PI_BACKGROUND_TASKS_DIR = savedDir;
		if (savedOff === undefined) delete process.env.PI_BACKGROUND_TASKS;
		else process.env.PI_BACKGROUND_TASKS = savedOff;
		if (savedDock === undefined) delete process.env.PI_BACKGROUND_TASKS_DOCK;
		else process.env.PI_BACKGROUND_TASKS_DOCK = savedDock;
		if (savedLinger === undefined) delete process.env.PI_BACKGROUND_TASKS_DOCK_LINGER_MS;
		else process.env.PI_BACKGROUND_TASKS_DOCK_LINGER_MS = savedLinger;
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
		statuses: new Map(),
		statusSets: [],
		sent: [],
		idle: true,
		tool: async () => ({ text: "", details: undefined }),
		command: async () => {},
		shutdown: async () => {},
		setIsolationEnv: () => {},
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
			setStatus: (key: string, text: string | undefined) => {
				harness.statusSets.push({ key, text });
				if (text === undefined) harness.statuses.delete(key);
				else harness.statuses.set(key, text);
			},
			// 与 user-message-bar 测试同口径：自造皮肤，色值可控。
			theme: { fg: (color: string, text: string) => `${color}(${text})` },
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

	/**
	 * 隔离相关环境的拨弄（下一个 `loadHarness()` 开头会自动还原，所以用例不必自己收拾）。
	 * 两个旋钮的差别：`PI_BACKGROUND_TASKS_WORKTREE` 在**每次工具调用时**读；`TMPDIR` 决定
	 * worktree 落在哪里（Node 的 `os.tmpdir()` 每次都重新读 `process.env.TMPDIR`）。
	 */
	harness.setIsolationEnv = (values) => {
		for (const [key, value] of Object.entries(values)) {
			const envKey = key === "worktree" ? "PI_BACKGROUND_TASKS_WORKTREE" : "TMPDIR";
			const previous = process.env[envKey];
			pendingEnvRestores.push(() => {
				if (previous === undefined) delete process.env[envKey];
				else process.env[envKey] = previous;
			});
			if (value === undefined) delete process.env[envKey];
			else process.env[envKey] = value;
		}
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
	// 关闭隔离，本用例验证的是 cwd 解析本身（默认隔离下命令跑在 worktree 里）
	h.setIsolationEnv({ worktree: "off" });
	const sub = path.join(h.projectDir, "sub");
	fs.mkdirSync(sub, { recursive: true });
	await h.tool("run_in_background", { command: "pwd > where.txt", cwd: "sub" });
	await waitFor(() => fs.existsSync(path.join(sub, "where.txt")), 8000, "命令在 sub 目录里跑完");
	assert.equal(fs.readFileSync(path.join(sub, "where.txt"), "utf-8").trim(), fs.realpathSync(sub));
	await h.shutdown();
});

// =============================================================================
// worktree 隔离（真 git 仓库 + 真 spawn）
// =============================================================================

/** 把 harness 的 projectDir 变成一个真 git 仓库（已提交一个文件）。 */
function makeProjectRepo(dir: string): void {
	const git = (args: string[]) => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
		assert.equal(result.status, 0, `git ${args.join(" ")} 失败：${result.stderr}`);
	};
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "test"]);
	fs.writeFileSync(path.join(dir, "tracked.txt"), "committed\n");
	git(["add", "."]);
	git(["commit", "-q", "-m", "init"]);
}

test("默认隔离：命令在 $TMPDIR 下的 worktree 里跑，不是会话 cwd", { skip }, async () => {
	const h = await loadHarness();
	makeProjectRepo(h.projectDir);
	const tmpRoot = path.join(h.root, "wt-tmp");
	fs.mkdirSync(tmpRoot, { recursive: true });
	h.setIsolationEnv({ tmpdir: tmpRoot });

	const result = await h.tool("run_in_background", { command: "pwd > where.txt; sleep 0.2" });
	assert.equal(result.details.ok, true, result.text);
	const wtPath = result.details.task.worktree?.path;
	assert.ok(wtPath, "工具结果里应当带上 worktree 路径");
	assert.equal(fs.realpathSync(path.dirname(wtPath!)), fs.realpathSync(tmpRoot), "worktree 应当落在 $TMPDIR 下");
	assert.match(result.text, /隔离工作区：/);

	// 命令真的跑在 worktree 里：pwd 的落地路径在 worktree 内，不在会话目录里
	await waitFor(() => fs.existsSync(path.join(wtPath!, "where.txt")), 8000, "命令在 worktree 里写出文件");
	assert.equal(fs.existsSync(path.join(h.projectDir, "where.txt")), false, "会话目录不该出现这个文件");
	assert.equal(
		fs.realpathSync(fs.readFileSync(path.join(wtPath!, "where.txt"), "utf-8").trim()),
		fs.realpathSync(wtPath!),
	);
	// 未提交改动不在 worktree 里：HEAD 的内容在，先前工区新写的文件不在
	assert.equal(fs.readFileSync(path.join(wtPath!, "tracked.txt"), "utf-8"), "committed\n");
	fs.writeFileSync(path.join(h.projectDir, "uncommitted.txt"), "dirty\n");
	assert.equal(fs.existsSync(path.join(wtPath!, "uncommitted.txt")), false);
});

test("无改动的任务终态后 worktree 自动消失（完全无痕）", { skip }, async () => {
	const h = await loadHarness();
	makeProjectRepo(h.projectDir);
	const tmpRoot = path.join(h.root, "wt-tmp");
	fs.mkdirSync(tmpRoot, { recursive: true });
	h.setIsolationEnv({ tmpdir: tmpRoot });

	const result = await h.tool("run_in_background", { command: "echo just-reading" });
	const wtPath = result.details.task.worktree?.path;
	assert.ok(wtPath);

	await waitFor(() => h.sent.some((m) => m.message.customType === "background-task"), 10000, "终态通知");
	const notice = h.sent.find((m) => m.message.customType === "background-task")!.message.content;
	assert.match(notice, /无改动，已自动清理/);
	await waitFor(() => !fs.existsSync(wtPath!), 5000, "worktree 目录被删掉");
	assert.deepEqual(fs.readdirSync(fs.realpathSync(tmpRoot)), [], "$TMPDIR 下不能留残留目录");
	// worktree 元数据也清干净：`git worktree list` 只剩主仓库
	const list = spawnSync("git", ["worktree", "list"], { cwd: h.projectDir, encoding: "utf-8" }).stdout;
	assert.equal(list.trim().split("\n").length, 1, list);
	await h.shutdown();
});

test("改了文件的任务终态后 worktree 保留，通知里给出路径与改动数", { skip }, async () => {
	const h = await loadHarness();
	makeProjectRepo(h.projectDir);
	const tmpRoot = path.join(h.root, "wt-tmp");
	fs.mkdirSync(tmpRoot, { recursive: true });
	h.setIsolationEnv({ tmpdir: tmpRoot });

	const result = await h.tool("run_in_background", { command: "echo produced > artifact.txt" });
	const wtPath = result.details.task.worktree?.path;
	assert.ok(wtPath);

	await waitFor(() => h.sent.some((m) => m.message.customType === "background-task"), 10000, "终态通知");
	const notice = h.sent.find((m) => m.message.customType === "background-task")!.message.content;
	assert.match(notice, /1 个文件有改动/);
	assert.ok(notice.includes(wtPath!), `通知里应当带上路径，实际：${notice}`);
	assert.equal(fs.readFileSync(path.join(wtPath!, "artifact.txt"), "utf-8"), "produced\n", "产出必须留着");
	assert.equal(fs.existsSync(path.join(h.projectDir, "artifact.txt")), false, "不能落到会话目录");
	// 留着的目录不能被后续清理误删：再读一次状态仍是有改动
	assert.equal(fs.existsSync(wtPath!), true);
	await h.shutdown();
});

test("worktree:false 关闭隔离：命令在原 cwd 里跑，看得到未提交改动", { skip }, async () => {
	const h = await loadHarness();
	makeProjectRepo(h.projectDir);
	fs.writeFileSync(path.join(h.projectDir, "uncommitted.txt"), "dirty\n");

	const result = await h.tool("run_in_background", { command: "cat uncommitted.txt > seen.txt", worktree: false });
	assert.equal(result.details.task.worktree, undefined, "关闭隔离时不应有 worktree");
	assert.doesNotMatch(result.text, /隔离工作区：/);
	const seenPath = path.join(h.projectDir, "seen.txt");
	// 等**内容**而不是等文件存在：shell 的重定向先建空文件，cat 才写进去，
	// 只等存在会在写入前就断言到空串（实测踩到过）
	await waitFor(() => {
		try {
			return fs.readFileSync(seenPath, "utf-8") === "dirty\n";
		} catch {
			return false;
		}
	}, 8000, "命令在原 cwd 里跑完");
	assert.equal(fs.readFileSync(seenPath, "utf-8"), "dirty\n");
	await h.shutdown();
});

test("非 git 目录：静默降级为不隔离，任务照跑并告知原因", { skip }, async () => {
	const h = await loadHarness();
	// projectDir 默认就不是 git 仓库（其余 41 个用例都跑在这条降级路径上）
	const result = await h.tool("run_in_background", { command: "echo hi" });
	assert.equal(result.details.ok, true);
	assert.equal(result.details.task.worktree, undefined);
	assert.match(result.text, /未隔离（不在 git 仓库里）/);
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

// =============================================================================
// 工具块与终态通知的渲染形态（用户 2026-09-30 定：参照 plan 块的 self 壳 + 树形）
// =============================================================================

/** 假主题：丢掉颜色以便断言可见文本；bold 也原样返回。 */
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** 着色主题：把每段包成 `slot(text)` 以便断言用的是哪个语义色槽（与 plan-mode/render.test.ts 同形）。 */
const paintedTheme = {
	fg: (color: string, text: string) => `${color}(${text})`,
	bold: (text: string) => text,
};

/** 剥掉所有 ANSI / OSC 转义，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 造一个渲染 context：state 是跨 renderCall/renderResult 共享的同一个对象（与 pi 一致）。 */
function renderContext(overrides: { isPartial?: boolean; isError?: boolean } = {}) {
	return {
		state: {} as { outcome?: string },
		isPartial: overrides.isPartial ?? false,
		isError: overrides.isError ?? false,
	};
}

/** run_in_background 成功那条的真实形状（五行，宽 80 下不折行）。 */
const RUN_RESULT = {
	content: [
		{
			type: "text",
			text: "已在后台启动 bg_1（pid 12345）。\n命令：npm test\n日志：/tmp/bg_1.log\n它会自己跑。\n需要中途看输出用 background_output。",
		},
	],
	details: { ok: true, task: { id: "bg_1", status: "running" } },
};

test("三个工具都用 self 壳（去底色 + 去上下空行的唯一途径）", { skip }, async () => {
	const h = await loadHarness();
	for (const name of ["run_in_background", "background_output", "background_kill"]) {
		const definition = h.extension.tools.get(name)?.definition as any;
		assert.equal(definition.renderShell, "self", `${name} 应设 renderShell: "self"`);
		assert.equal(typeof definition.renderCall, "function", `${name} 应有 renderCall`);
		assert.equal(typeof definition.renderResult, "function", `${name} 应有 renderResult`);
	}
	await h.shutdown();
});

test("标题行：成功 / ok:false 都只有 • 工具名（工具块无任何标记，区分只在点色）（state 传递）", { skip }, async () => {
	const h = await loadHarness();
	const definition = h.extension.tools.get("run_in_background")!.definition as any;

	// 成功：先跑 renderResult 写 state.outcome，再 renderCall 读它（pi 的真实顺序是
	// callRenderer 先于 resultRenderer，但屏幕绘制在两者之后，所以懒组件读到的是写好的值）。
	const okCtx = renderContext();
	definition.renderResult(RUN_RESULT, { expanded: false, isPartial: false }, plainTheme, okCtx);
	const okTitle = plain(definition.renderCall({}, plainTheme, okCtx).render(80)[0]!);
	// 工具块不打任何标记：✔ 只属于终态通知，✘ 对工具块也是多余的（圆点已表达结局）。
	assert.equal(okTitle, "• run_in_background", `成功标题（顶格、无标记）：${JSON.stringify(okTitle)}`);
	assert.ok(!okTitle.includes("✔") && !okTitle.includes("✘"), "工具块不该出现任何标记");
	// 成功与 pending / declined 的可见文本相同，区分只在圆点颜色：成功走 success（绿）。
	const okPainted = definition.renderCall({}, paintedTheme, okCtx).render(80)[0]!;
	assert.match(okPainted, /success\(\u2022\)/, "成功圆点走 success 槽（绿）");

	// 没成但不是错（declined）：details.ok === false —— 同样无标记，只靠灰点。
	const noCtx = renderContext();
	definition.renderResult(
		{ content: [{ type: "text", text: "command 不能为空。" }], details: { ok: false } },
		{ expanded: false, isPartial: false },
		plainTheme,
		noCtx,
	);
	const noTitle = plain(definition.renderCall({}, plainTheme, noCtx).render(80)[0]!);
	assert.equal(noTitle, "• run_in_background", `declined 标题（无 ✘）：${JSON.stringify(noTitle)}`);
	assert.ok(!noTitle.includes("✔") && !noTitle.includes("✘"), "declined 也不该出现任何标记");
	const noPainted = definition.renderCall({}, paintedTheme, noCtx).render(80)[0]!;
	assert.match(noPainted, /dim\(\u2022\)/, "declined 圆点走 dim 槽（灰）");
	await h.shutdown();
});

test("标题行：执行中（结果未到）是灰 • 工具名、无标记", { skip }, async () => {
	const h = await loadHarness();
	const definition = h.extension.tools.get("background_output")!.definition as any;
	const ctx = renderContext({ isPartial: true });
	const title = plain(definition.renderCall({}, plainTheme, ctx).render(80)[0]!);
	assert.equal(title, "• background_output", `执行中标题（顶格）：${JSON.stringify(title)}`);
	await h.shutdown();
});

test("正文：结果全文折行挂树，除末行外 │、末行 └，正文对齐第 5 列", { skip }, async () => {
	const h = await loadHarness();
	const definition = h.extension.tools.get("run_in_background")!.definition as any;
	const lines = definition
		.renderResult(RUN_RESULT, { expanded: false, isPartial: false }, plainTheme, renderContext())
		.render(80)
		.map(plain);
	assert.equal(lines.length, 5, `五行正文（宽 80 不折行、不超预览上限）：${JSON.stringify(lines)}`);
	assert.ok(lines[0]!.startsWith("  │ "), `首行挂 │（2 列缩进）：${JSON.stringify(lines[0])}`);
	assert.ok(lines[4]!.startsWith("  └ "), `末行挂 └：${JSON.stringify(lines[4])}`);
	assert.equal(lines.filter((line: string) => line.includes("└")).length, 1, "└ 只能出现一次");
	// 树符在列 2（`run_in_background` 首字母 r 正下方），正文从列 4 起
	assert.equal(lines[0]!.indexOf("│"), 2, `│ 在列 2：${JSON.stringify(lines[0])}`);
	assert.equal(lines[0]!.indexOf("已在后台启动"), 4, `正文列：${JSON.stringify(lines[0])}`);
	assert.equal(lines[4]!.indexOf("需要中途"), 4, `末行正文列：${JSON.stringify(lines[4])}`);
	await h.shutdown();
});

test("正文：长行折行后 └ 仍只在最后一个视觉行（碎片也算独立行）", { skip }, async () => {
	const h = await loadHarness();
	const definition = h.extension.tools.get("run_in_background")!.definition as any;
	const long = "这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的日志路径";
	const lines = definition
		.renderResult(
			{ content: [{ type: "text", text: long }], details: { ok: true } },
			{ expanded: false, isPartial: false },
			plainTheme,
			renderContext(),
		)
		.render(30)
		.map(plain);
	assert.ok(lines.length > 1, `窄宽度下应折成多行：${JSON.stringify(lines)}`);
	const corners = lines.filter((line: string) => line.includes("└"));
	assert.equal(corners.length, 1, `└ 只能出现一次：${JSON.stringify(lines)}`);
	assert.ok(lines[lines.length - 1]!.includes("└"), `└ 必须在最后一行：${JSON.stringify(lines)}`);
	assert.ok(lines.slice(0, -1).every((line: string) => line.includes("│")), `其余行都挂 │：${JSON.stringify(lines)}`);
	await h.shutdown();
});

test("预览截断：超过 10 行只画 10 行 + 提示行，展开态（ctrl+o）不裁", { skip }, async () => {
	const h = await loadHarness();
	const definition = h.extension.tools.get("background_output")!.definition as any;
	// 14 行真输出（background_output 一次可返回 30000 字符，不裁就平铺满屏）
	const many = Array.from({ length: 14 }, (_unused, index) => `line-${index + 1}`).join("\n");
	const result = { content: [{ type: "text", text: many }], details: { ok: true } };

	const collapsed = definition
		.renderResult(result, { expanded: false, isPartial: false }, plainTheme, renderContext())
		.render(80)
		.map(plain);
	assert.equal(collapsed.length, 11, `10 行正文 + 1 行提示：${JSON.stringify(collapsed)}`);
	assert.match(collapsed[10]!, /4 more lines, ctrl\+o to expand/, `提示行：${JSON.stringify(collapsed[10])}`);
	assert.ok(collapsed[10]!.includes("└"), "提示行是树的末行，挂 └");
	assert.ok(!collapsed.join("\n").includes("line-11"), "被裁的行不该出现");

	const expandedLines = definition
		.renderResult(result, { expanded: true, isPartial: false }, plainTheme, renderContext())
		.render(80)
		.map(plain);
	assert.equal(expandedLines.length, 14, `展开态全画：${JSON.stringify(expandedLines)}`);
	assert.ok(expandedLines.join("\n").includes("line-14"), "展开态含最后一行");
	assert.ok(!expandedLines.some((line: string) => line.includes("to expand")), "展开态不出提示行");
	await h.shutdown();
});

test("整块无底色：self 壳经 pi 真实组件渲染后不含背景 SGR（\\x1b[48）", { skip }, async () => {
	const h = await loadHarness();
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
			markExecutionStarted: () => void;
			updateResult: (result: unknown, isPartial?: boolean) => void;
			render: (width: number) => string[];
		};
	};
	const definition = h.extension.tools.get("run_in_background")!.definition;
	pi.initTheme("dark");
	const component = new pi.ToolExecutionComponent(
		"run_in_background",
		"call-1",
		{ command: "npm test" },
		{},
		definition,
		{ requestRender() {} },
		h.projectDir,
	);
	component.markExecutionStarted();
	component.updateResult(RUN_RESULT, false);
	const raw = component.render(80);
	assert.equal(raw[0], "", "第 0 行是 pi self 模式固定的留白");
	assert.notEqual(raw[raw.length - 1]!.trim(), "", "最后一行不是空行（无下边界空行）");
	for (const line of raw) {
		assert.ok(!line.includes("\x1b[48"), `不该有背景 SGR：${JSON.stringify(line)}`);
	}
	const visible = raw.map(plain).filter((line) => line.trim() !== "");
	assert.ok(visible[0]!.startsWith("• run_in_background"), `标题行顶格（圆点前无空格）：${JSON.stringify(visible[0])}`);
	assert.ok(!visible[0]!.includes("✔"), "工具块成功不打 ✔（对号只属于终态通知）");
	assert.equal(visible[0]!.indexOf("r"), 2, `标题里 r 在列 2：${JSON.stringify(visible[0])}`);
	// 树符与标题对齐：`│` / `└` 在列 2，正好是 `run_in_background` 首字母 r 的正下方
	for (const line of visible.slice(1)) {
		assert.equal(line.search(/[│└]/), 2, `树符应在列 2（与 r 对齐）：${JSON.stringify(line)}`);
	}
	await h.shutdown();
});

test("终态通知：圆点顶格 + 对号在行末 + 树形正文，无底色无下空行", { skip }, async () => {
	const h = await loadHarness();
	const renderer = h.extension.messageRenderers.get("background-task") as any;
	assert.ok(renderer, "必须注册终态通知的渲染器");

	const message = {
		customType: "background-task",
		content: "<background-task-notification>\n后台任务 bg_1 已成功结束（exit 0），运行 5s。\n完整日志：/tmp/bg_1.log\n</background-task-notification>",
		display: true,
		details: { kind: "terminal", task: { id: "bg_1", status: "exited", exitCode: 0 } },
	};
	const lines = renderer(message, { expanded: false, outputPad: 1 }, plainTheme).render(80).map(plain);

	assert.equal(lines[0], "• 后台任务 bg_1 结束 ✔", `标题行（圆点顶格、对号行末）：${JSON.stringify(lines[0])}`);
	assert.ok(!lines[0]!.includes("✓"), "旧的 ✓ 前缀已移走");
	assert.ok(!lines[0]!.includes(":"), "旧的冒号已去掉");
	// 正文挂树：包裹标签不显示，两行正文 → 一行 │ + 一行 └
	assert.equal(lines.length, 3, `标题 + 两行正文：${JSON.stringify(lines)}`);
	assert.ok(lines[1]!.startsWith("  │ 后台任务 bg_1 已成功结束"), `首行挂 │：${JSON.stringify(lines[1])}`);
	assert.ok(lines[2]!.startsWith("  └ 完整日志"), `末行挂 └：${JSON.stringify(lines[2])}`);
	assert.ok(!lines.join("\n").includes("background-task-notification>"), "包裹标签不该显示");
	await h.shutdown();
});

test("终态通知：失败 / 被 kill 也是行末 ✔（只要结束就是 ✔），但圆点与 ✔ 都变红", { skip }, async () => {
	const h = await loadHarness();
	const renderer = h.extension.messageRenderers.get("background-task") as any;
	const body = "后台任务 bg_1 已结束。";
	const failedMsg = { customType: "background-task", content: body, display: true, details: { task: { id: "bg_1", status: "exited", exitCode: 1 } } };
	const killedMsg = { customType: "background-task", content: body, display: true, details: { task: { id: "bg_2", status: "killed", signal: "SIGTERM" } } };
	const okMsg = { customType: "background-task", content: body, display: true, details: { task: { id: "bg_3", status: "exited", exitCode: 0 } } };

	// 可见文本（plainTheme）：三种结局的行末都是 ✔ —— ✔ 断言的是「结束」而非「成功」。
	assert.equal(
		plain(renderer(failedMsg, { expanded: false, outputPad: 1 }, plainTheme).render(80)[0]!),
		"• 后台任务 bg_1 结束 ✔",
		"非 0 退出也是 ✔",
	);
	assert.equal(
		plain(renderer(killedMsg, { expanded: false, outputPad: 1 }, plainTheme).render(80)[0]!),
		"• 后台任务 bg_2 结束 ✔",
		"被 kill 也是 ✔",
	);
	for (const msg of [failedMsg, killedMsg, okMsg]) {
		const line = plain(renderer(msg, { expanded: false, outputPad: 1 }, plainTheme).render(80)[0]!);
		assert.ok(!line.includes("✘"), `通知里不该出现 ✘：${JSON.stringify(line)}`);
	}

	// 色槽（paintedTheme）：失败时圆点与 ✔ **都走 error（红）** —— 成败靠颜色与正文区分。
	const failed = renderer(failedMsg, { expanded: false, outputPad: 1 }, paintedTheme).render(80);
	assert.match(failed[0]!, /error\(\u2022\)/, "失败圆点走 error 槽（红）");
	assert.match(failed[0]!, /error\(\u2714\)/, "失败时 ✔ 也走 error 槽（与点同色）");
	assert.ok(!failed[0]!.includes("success("), "失败时不该出现任何 success 槽");

	// 成功时圆点与 ✔ 都走 success（绿），标题文字走 toolTitle（与工具名同一个 Title 色）
	const ok = renderer(okMsg, { expanded: false, outputPad: 1 }, paintedTheme).render(80);
	assert.match(ok[0]!, /success\(\u2022\)/, "成功圆点走 success 槽");
	assert.match(ok[0]!, /success\(\u2714\)/, "✔ 走 success 槽");
	assert.match(ok[0]!, /toolTitle\(/, "标题文字走 toolTitle 槽");
	await h.shutdown();
});

test("终态通知：无底色，正文走 text 槽、结构符走 muted 槽", { skip }, async () => {
	const h = await loadHarness();
	const renderer = h.extension.messageRenderers.get("background-task") as any;
	const lines = renderer(
		{
			customType: "background-task",
			content: "后台任务 bg_1 已成功结束（exit 0）。",
			display: true,
			details: { task: { id: "bg_1", status: "exited", exitCode: 0 } },
		},
		{ expanded: false, outputPad: 1 },
		paintedTheme,
	).render(80);
	// 不再套 customMessageBg：整块不该出现任何背景槽
	assert.ok(!lines.join("\n").includes("customMessageBg"), "不该再套 customMessageBg 底色");
	assert.match(lines[1]!, /muted\(\u2514 \)/, "└ 单独取 muted 槽（树前缀含尾空格，与 plan 块同形）");
	assert.match(lines[1]!, /text\(后台任务 bg_1/, "正文走 text 槽（与 exit_plan_mode 下方正文同色）");
	await h.shutdown();
});

// =============================================================================
// statusline 任务 dock（真 spawn + 真定时器）
// =============================================================================

const DOCK_KEY = "background-tasks";

/** 触发一个生命周期钩子（ctx 用 harness 里那只，dock 要靠它拿 theme / setStatus）。 */
async function fire(h: Harness, event: string): Promise<void> {
	for (const handler of h.extension.handlers.get(event) ?? []) await handler({}, {});
}

test("dock：任务启动即发布一行，含 id / 状态 / 时长 / 命令", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });
	const line = h.statuses.get(DOCK_KEY);
	assert.ok(line, "启动后应当发布 dock 行");
	assert.match(line!, /bg_1/);
	assert.match(line!, /warning\(running\)/, "running 用 warning 槽");
	assert.match(line!, /accent\(bg_1\)/, "id 用 accent 槽");
	assert.match(line!, /sleep 30/);
	assert.match(line!, /^\u2699 |dim\(\u2699\)/, "行首是 ⚙ 图标");
	await h.shutdown();
});

test("dock：秒级 tick 推进运行时长", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });
	const first = h.statuses.get(DOCK_KEY)!;
	assert.match(first, /0s/);
	// 真定时器：等过两个 tick，时长应当已经跳到 2s 上下
	await waitFor(() => /muted\((1|2|3)s\)/.test(h.statuses.get(DOCK_KEY) ?? ""), 6000, "时长每秒跳动");
	assert.ok(h.statusSets.length >= 2, "tick 应当重复发布过");
	await h.shutdown();
});

test("dock：终态换成 exit 文案，驻留窗口过后自动清掉", { skip }, async () => {
	// 工厂期读 env，所以必须在 loadHarness 之前设；loadHarness 负责还原。
	process.env.PI_BACKGROUND_TASKS_DOCK_LINGER_MS = "300";
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "echo dock-done" });
	await waitFor(() => h.sent.length > 0, 8000, "任务结束");
	assert.match(h.statuses.get(DOCK_KEY) ?? "", /success\(exit 0\)/, "exit 0 用 success 槽");
	// 驻留 300ms + 一个 1s tick 之内应当清键并停表
	await waitFor(() => h.statuses.get(DOCK_KEY) === undefined, 6000, "驻留窗口过后清掉 dock 行");
	const after = h.statusSets.length;
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(h.statusSets.length, after, "清掉之后不该再有秒级重绘（表已停）");
	await h.shutdown();
});

test("dock：弹窗期间停表，弹窗结束后恢复", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });
	assert.ok(h.statuses.get(DOCK_KEY), "先确认 dock 在跑");

	await fire(h, "ui_prompt_start");
	const frozen = h.statusSets.length;
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(h.statusSets.length, frozen, "弹窗期间不该有任何重绘（否则会把用户的 scrollback 拽回底部）");

	await fire(h, "ui_prompt_end");
	assert.ok(h.statuses.get(DOCK_KEY), "弹窗结束后 dock 行应当立刻回来");
	await waitFor(() => h.statusSets.length > frozen + 1, 6000, "恢复后 tick 继续跑");
	await h.shutdown();
});

test("dock：session_shutdown 清键并停表", { skip }, async () => {
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });
	assert.ok(h.statuses.get(DOCK_KEY));
	await h.shutdown();
	assert.equal(h.statuses.get(DOCK_KEY), undefined, "shutdown 应当清掉 dock 行");
	const after = h.statusSets.length;
	await new Promise((resolve) => setTimeout(resolve, 1300));
	assert.equal(h.statusSets.length, after, "shutdown 后不该再发布");
});

test("dock：PI_BACKGROUND_TASKS_DOCK=off 时一行都不发布，工具照旧", { skip }, async () => {
	process.env.PI_BACKGROUND_TASKS_DOCK = "off";
	const h = await loadHarness();
	const result = await h.tool("run_in_background", { command: "sleep 30" });
	assert.match(result.text, /已在后台启动 bg_1/, "关掉 dock 不影响工具本身");
	await new Promise((resolve) => setTimeout(resolve, 1300));
	assert.equal(h.statuses.get(DOCK_KEY), undefined, "dock 关掉后不该发布任何状态");
	assert.equal(h.statusSets.length, 0, "一次 setStatus 都不该调");
	await h.shutdown();
});

test("dock：注册了 ui_prompt_start / ui_prompt_end 两个冻结钩子", { skip }, async () => {
	const h = await loadHarness();
	assert.ok(h.extension.handlers.get("ui_prompt_start")?.length, "必须注册 ui_prompt_start");
	assert.ok(h.extension.handlers.get("ui_prompt_end")?.length, "必须注册 ui_prompt_end");
	await h.shutdown();
});

test("dock：弹窗期间连事件驱动的那一下也不发布（终态通知不触发重绘）", { skip }, async () => {
	// env 还原在全局 test.after 里，前面的用例设过的值会漏到这里 —— 自己先清干净。
	delete process.env.PI_BACKGROUND_TASKS_DOCK;
	process.env.PI_BACKGROUND_TASKS_DOCK_LINGER_MS = "8000";
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "echo frozen-dock" });
	assert.ok(h.statuses.get(DOCK_KEY), "先确认 dock 在跑");

	await fire(h, "ui_prompt_start");
	const frozen = h.statusSets.length;
	// 任务在弹窗期间结束：终态回调会注入通知（那是给模型的，不是重绘），
	// 但 dock 一次都不该发布 —— 一次重绘同样会把用户的 scrollback 拽回底部。
	await waitFor(() => h.sent.length > 0, 8000, "任务在弹窗期间结束");
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(h.statusSets.length, frozen, "弹窗期间一次 setStatus 都不该有");

	await fire(h, "ui_prompt_end");
	const line = h.statuses.get(DOCK_KEY);
	assert.ok(line, "弹窗一关按当前真实状态重算");
	assert.match(line!, /success\(exit 0\)/, "重算后看到的是终态，不是停在旧值");
	await h.shutdown();
});

// ── 结轮提示（本轮已结束 + 任务仍在跑）────────────────────────────────────

/** 取 dock 值的第二行；只有一行时返回 undefined。 */
function noteLine(h: Harness): string | undefined {
	const value = h.statuses.get(DOCK_KEY);
	if (!value) return undefined;
	return value.split("\n")[1];
}

test("dock：agent_settled 后给跑满阈值的任务补第二行，agent_start 再清掉", { skip }, async () => {
	// 阈值设小：任务是真长跑（sleep），但我们不想真等 5s。
	process.env.PI_BACKGROUND_TASKS_TURN_NOTE_MS = "300";
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "sleep 30" });

	// 本轮进行中：只有一行，绝不说「本轮已结束」。
	assert.equal(noteLine(h), undefined, "本轮进行中不该有第二行");

	await fire(h, "agent_settled");
	// 任务还没跑满阈值 → 仍然只有一行。
	assert.equal(noteLine(h), undefined, "没跑满阈值不该有第二行");

	// 过了阈值：下一帧重绘（秒级 tick）就补上那句提示。
	await waitFor(() => noteLine(h) !== undefined, 6000, "阈值过后补第二行");
	assert.match(noteLine(h)!, /Task is still running/);
	// harness 的 theme 是着色的（其它用例断言 `warning(running)` 同源），所以 `└` 外面
	// 包着 muted(...)；只断言图形与缩进位置，不断言颜色包裹的写法。
	assert.match(noteLine(h)!, /^\s+\S*\(?\u2514/, "第二行以 └ 开头（带缩进）");
	assert.match(noteLine(h)!, /muted\(\u2514\)/, "└ 单独取 muted 槽");
	assert.match(h.statuses.get(DOCK_KEY)!, /running/, "第一行仍然报告任务在跑");

	// 新一轮开始：那句话立刻变假，必须消失。
	await fire(h, "agent_start");
	assert.equal(noteLine(h), undefined, "新轮开始后第二行必须消失");
	await h.shutdown();
});

test("dock：终态任务不会被补上「本轮已结束」（驻留窗口里不需要那句话）", { skip }, async () => {
	process.env.PI_BACKGROUND_TASKS_TURN_NOTE_MS = "0";
	const h = await loadHarness();
	await h.tool("run_in_background", { command: "echo done-quick" });
	await waitFor(() => h.sent.length > 0, 8000, "任务结束");
	await fire(h, "agent_settled");
	assert.match(h.statuses.get(DOCK_KEY) ?? "", /exit 0/, "驻留窗口内还看得见终态行");
	assert.equal(noteLine(h), undefined, "终态任务不该有第二行");
	await h.shutdown();
});

test("dock：注册了 agent_start / agent_settled 两个回合钩子", { skip }, async () => {
	const h = await loadHarness();
	assert.ok(h.extension.handlers.get("agent_start")?.length, "必须注册 agent_start");
	assert.ok(h.extension.handlers.get("agent_settled")?.length, "必须注册 agent_settled");
	await h.shutdown();
});
