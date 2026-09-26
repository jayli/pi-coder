/**
 * background-tasks/registry.ts 的纯逻辑测试：假子进程（EventEmitter）驱动完整状态机，
 * 不起真进程（真 spawn 的用例在 index.test.ts）。
 *
 *   node --test clients/pi/extensions/background-tasks/registry.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	createRegistry,
	formatElapsed,
	formatTaskLine,
	formatTaskList,
	truncateCommand,
	type BackgroundTask,
	type ChildLike,
	type SpawnFn,
} from "./registry.ts";

// =============================================================================
// 假子进程：EventEmitter 假造 spawn 出来的那一小片面
// =============================================================================

class FakeChild extends EventEmitter implements ChildLike {
	pid: number;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killedSignals: Array<NodeJS.Signals | number> = [];

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	override kill(signal?: NodeJS.Signals | number): boolean {
		this.killedSignals.push(signal ?? "SIGTERM");
		// 模拟收到 SIGTERM 就退出（exit code null + signal）
		queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
		return true;
	}
}

interface FakeSpawn {
	spawn: SpawnFn;
	children: FakeChild[];
	/** 下一次 spawn 要抛的错（测试 spawn 失败路径）。 */
	nextError: Error | undefined;
}

function makeFakeSpawn(): FakeSpawn {
	const fake: FakeSpawn = {
		children: [],
		nextError: undefined,
		spawn: (_file, _args, _options) => {
			if (fake.nextError) {
				const error = fake.nextError;
				fake.nextError = undefined;
				throw error;
			}
			// pid 刻意取在系统上限之上（macOS pid_max 默认 99998）：
			// signalGroup 会先试 process.kill(-pid) 杀进程组，假 pid 必须保证
			// ESRCH（组不存在）才能安全回退到 child.kill —— 否则测试可能
			// 真给某个无关进程组发信号。
			const child = new FakeChild(999000 + fake.children.length);
			fake.children.push(child);
			return child;
		},
	};
	return fake;
}

function makeLogDir(): { logDir: string; cleanup: () => void } {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-registry-"));
	return { logDir, cleanup: () => fs.rmSync(logDir, { recursive: true, force: true }) };
}

// =============================================================================
// 启动与 id
// =============================================================================

test("startTask 返回 bg_N 递增 id、running 状态、日志路径", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const a = registry.startTask({ command: "echo hi", cwd: logDir, logDir });
		const b = registry.startTask({ command: "sleep 1", cwd: logDir, logDir });
		assert.equal(a.id, "bg_1");
		assert.equal(b.id, "bg_2");
		assert.equal(a.status, "running");
		assert.equal(a.pid, 999000);
		assert.ok(a.logPath.endsWith("bg_1.log"));
		assert.ok(fs.existsSync(a.logPath), "日志文件应当被创建");
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("spawn 抛错：任务立即终态，错误写进输出与日志", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		fake.nextError = new Error("spawn /bin/bash ENOENT");
		const registry = createRegistry({ spawn: fake.spawn });
		const task = registry.startTask({ command: "anything", cwd: logDir, logDir });
		assert.equal(task.status, "exited");
		assert.match(task.spawnError ?? "", /ENOENT/);
		const result = registry.readOutput(task);
		assert.match(result.text, /spawn error/);
		assert.match(result.text, /ENOENT/);
		registry.dispose();
	} finally {
		cleanup();
	}
});

// =============================================================================
// 输出缓冲与增量读
// =============================================================================

test("输出进缓冲也进日志文件（双写）", async () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const task = registry.startTask({ command: "echo hi", cwd: logDir, logDir });
		const child = fake.children[0];
		child.stdout.emit("data", Buffer.from("hello "));
		child.stderr.emit("data", Buffer.from("world\n"));
		const result = registry.readOutput(task);
		assert.equal(result.text, "hello world\n");
		assert.equal(result.from, 0);
		assert.equal(result.to, 12);
		// 日志文件里也有（异步写，等一下）
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.match(fs.readFileSync(task.logPath, "utf-8"), /hello world/);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("增量读：不传 offset 从上次读到的位置继续，不重复", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const task = registry.startTask({ command: "seq", cwd: logDir, logDir });
		const child = fake.children[0];
		child.stdout.emit("data", Buffer.from("aaa"));
		const first = registry.readOutput(task);
		assert.equal(first.text, "aaa");
		assert.equal(first.to, 3);

		// 没有新输出：第二次读是空的，且不重复
		const empty = registry.readOutput(task);
		assert.equal(empty.text, "");
		assert.equal(empty.from, 3);
		assert.equal(empty.to, 3);

		child.stdout.emit("data", Buffer.from("bbb"));
		const second = registry.readOutput(task);
		assert.equal(second.text, "bbb");
		assert.equal(second.from, 3);
		assert.equal(second.to, 6);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("显式 offset：回读旧区间，且把 readOffset 推到末尾", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const task = registry.startTask({ command: "seq", cwd: logDir, logDir });
		const child = fake.children[0];
		child.stdout.emit("data", Buffer.from("abcdef"));
		registry.readOutput(task); // 读到 6
		const reread = registry.readOutput(task, 2);
		assert.equal(reread.text, "cdef");
		assert.equal(reread.from, 2);
		// 回读之后 readOffset 也推到 6：下一次默认读不会重发 cdef
		const after = registry.readOutput(task);
		assert.equal(after.text, "");
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("环形上限：超限丢最旧的块，droppedBefore 如实报告", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn, maxBufferChars: 10 });
		const task = registry.startTask({ command: "big", cwd: logDir, logDir });
		const child = fake.children[0];
		child.stdout.emit("data", Buffer.from("aaaaaaaa")); // 0..8
		child.stdout.emit("data", Buffer.from("bbbbbbbb")); // 8..16 → 缓冲 16 > 10，丢第一块
		const result = registry.readOutput(task, 0);
		assert.equal(result.text, "bbbbbbbb");
		assert.equal(result.droppedBefore, 8, "从 0 读时应当报告丢了前 8 个字符");
		// 从 8 开始读则没有丢弃
		const from8 = registry.readOutput(task, 8);
		assert.equal(from8.droppedBefore, 0);
		assert.equal(from8.text, "bbbbbbbb");
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("超大输出只返回尾部（MAX_READ_CHARS），truncatedToTail 置位", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const task = registry.startTask({ command: "big", cwd: logDir, logDir });
		const child = fake.children[0];
		// 40k 输出（超过 MAX_READ_CHARS=30k）：分块发，避免单块过大触发不了截断逻辑
		for (let i = 0; i < 40; i++) child.stdout.emit("data", Buffer.from("x".repeat(1024)));
		const result = registry.readOutput(task, 0);
		assert.equal(result.text.length, 30_000);
		assert.equal(result.truncatedToTail, true);
		assert.equal(result.to, 40 * 1024);
		// 尾部优先：返回的是最后 30k
		assert.equal(result.from, 40 * 1024 - 30_000);
		registry.dispose();
	} finally {
		cleanup();
	}
});

// =============================================================================
// 终态
// =============================================================================

test("exit：状态 exited + exitCode，onTerminal 回调触发一次", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const terminals: BackgroundTask[] = [];
		const registry = createRegistry({ spawn: fake.spawn, onTerminal: (task) => terminals.push(task) });
		const task = registry.startTask({ command: "true", cwd: logDir, logDir });
		fake.children[0].emit("exit", 0, null);
		assert.equal(task.status, "exited");
		assert.equal(task.exitCode, 0);
		assert.ok(task.endedAt !== undefined);
		assert.equal(terminals.length, 1);
		// 幂等：重复 exit 不再触发
		fake.children[0].emit("exit", 0, null);
		assert.equal(terminals.length, 1);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("非零退出码与信号都记录", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const a = registry.startTask({ command: "false", cwd: logDir, logDir });
		fake.children[0].emit("exit", 1, null);
		assert.equal(a.exitCode, 1);
		const b = registry.startTask({ command: "sleep 99", cwd: logDir, logDir });
		fake.children[1].emit("exit", null, "SIGKILL");
		assert.equal(b.status, "exited"); // 不是我们杀的 → exited，不是 killed
		assert.equal(b.signal, "SIGKILL");
		registry.dispose();
	} finally {
		cleanup();
	}
});

// =============================================================================
// kill
// =============================================================================

test("killTask：SIGTERM 发给进程组，任务随 exit 变 killed", async () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		const task = registry.startTask({ command: "sleep 99", cwd: logDir, logDir });
		const result = registry.killTask("bg_1");
		assert.equal(result.ok, true);
		// FakeChild.kill 是单进程路径的模拟；组杀走 process.kill(-pid)，
		// 在测试里对假 pid 会失败并回退到 child.kill —— 两条路都验证过语义即可。
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(task.status, "killed");
		assert.ok(task.killRequested);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("killTask 幂等：已终态的任务不能再杀", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		registry.startTask({ command: "true", cwd: logDir, logDir });
		fake.children[0].emit("exit", 0, null);
		const result = registry.killTask("bg_1");
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /已经/);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("killTask 未知 id 报错", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const registry = createRegistry({ spawn: makeFakeSpawn().spawn });
		const result = registry.killTask("bg_99");
		assert.equal(result.ok, false);
		assert.match(result.reason ?? "", /没有这个任务/);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("SIGTERM 被忽略时宽限期后补 SIGKILL", async () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		// 这个假子进程收 SIGTERM 不退出（覆盖 kill 让它静默）
		const spawn: SpawnFn = (file, args, options) => {
			const child = fake.spawn(file, args, options) as FakeChild;
			child.kill = (signal?: NodeJS.Signals | number) => {
				child.killedSignals.push(signal ?? "SIGTERM");
				return true; // 收了但假装没死
			};
			return child;
		};
		const registry = createRegistry({ spawn, killGraceMs: 30 });
		const task = registry.startTask({ command: "stubborn", cwd: logDir, logDir });
		const child = fake.children[0];
		registry.killTask("bg_1");
		assert.equal(task.status, "running", "SIGTERM 后任务仍在跑（假子进程没退出）");
		await new Promise((resolve) => setTimeout(resolve, 80));
		// 宽限期过了，应当补过 SIGKILL（组杀对假 pid 失败 → 回退 child.kill）
		assert.ok(
			child.killedSignals.includes("SIGKILL"),
			`应当补发 SIGKILL，实际收到：${child.killedSignals.join(",")}`,
		);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("killAll：只杀 running 的，返回数量", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		registry.startTask({ command: "a", cwd: logDir, logDir });
		registry.startTask({ command: "b", cwd: logDir, logDir });
		fake.children[0].emit("exit", 0, null); // 第一个已退出
		const count = registry.killAll();
		assert.equal(count, 1, "只有还在跑的那个被杀");
		registry.dispose();
	} finally {
		cleanup();
	}
});

// =============================================================================
// 查询与格式化
// =============================================================================

test("resolveTask / listTasks / runningCount", () => {
	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const registry = createRegistry({ spawn: fake.spawn });
		registry.startTask({ command: "a", cwd: logDir, logDir });
		registry.startTask({ command: "b", cwd: logDir, logDir });
		assert.ok(registry.resolveTask("bg_1"));
		assert.equal(registry.resolveTask("bg_404"), undefined);
		assert.equal(registry.listTasks().length, 2);
		assert.equal(registry.runningCount(), 2);
		fake.children[0].emit("exit", 0, null);
		assert.equal(registry.runningCount(), 1);
		registry.dispose();
	} finally {
		cleanup();
	}
});

test("formatElapsed / truncateCommand / formatTaskLine / formatTaskList", () => {
	assert.equal(formatElapsed(500), "0s");
	assert.equal(formatElapsed(5_000), "5s");
	assert.equal(formatElapsed(65_000), "1m5s");
	assert.equal(formatElapsed(3_700_000), "1h1m");

	assert.equal(truncateCommand("echo hi"), "echo hi");
	const long = "x".repeat(100);
	assert.equal(truncateCommand(long).length, 60);
	assert.ok(truncateCommand(long).endsWith("…"));
	assert.equal(truncateCommand("a\n\n  b\tc"), "a b c", "空白压平");

	const { logDir, cleanup } = makeLogDir();
	try {
		const fake = makeFakeSpawn();
		const now = () => 1_000_000;
		const registry = createRegistry({ spawn: fake.spawn, now });
		const task = registry.startTask({ command: "echo hi", cwd: logDir, logDir });
		const line = formatTaskLine(task, now() + 5_000);
		assert.match(line, /^bg_1\s+running\s+5s\s+pid=999000\s+echo hi$/);
		fake.children[0].emit("exit", 2, null);
		const doneLine = formatTaskLine(task, now());
		assert.match(doneLine, /exited/);
		assert.match(doneLine, /exit=2/);
		assert.equal(formatTaskList([], now()), "没有后台任务。");
		registry.dispose();
	} finally {
		cleanup();
	}
});
