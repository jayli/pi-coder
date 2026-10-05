/**
 * Tests for simple-task 的 widget 视口渲染 — 端到端：pi 自己的扩展加载器真加载本扩展，
 * 驱动一次 task_set 拿到扩展注册的 widget 工厂，再渲染真实行做断言。
 *
 * Run with:  node --test clients/pi/extensions/simple-task/widget.test.ts
 *
 * 为什么绕这一圈：视口的全部价值在「用户屏幕上滚不滚」，而屏幕上那几行是
 * 扩展自己注册的工厂 → `buildWidgetLines` 拼出来的。只看 `computeViewport` 的纯代数
 * 会漏掉「窗口滚了但渲染没跟上」这一半 —— 这里断言的是**整块的行**。
 *
 * 断言口径（用户 2026-10-02 给的样例逐字复现）：13 项、前 10 项完成、`#11` in_progress →
 * 头部 + `… 3 more` + `#4`..#11 八条 + `… and 2 more`，窗口内恰好 8 条任务项。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { widgetGaps } from "./gap.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
/** 与 render.test.ts / recap 的 index.test.ts 同一套查找逻辑：能真 import 的那个入口。 */
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

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface WidgetComponent {
	render(width: number): string[];
}
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface Harness {
	/** 注册过的 widget 工厂（每次 setWidget 都记一条，undefined = 摘掉 widget）。 */
	widgets: Array<{ key: string; factory?: WidgetFactory }>;
	/** 按 id 设置任务状态。 */
	update(id: number, status: "pending" | "in_progress" | "done"): Promise<void>;
	/** 建一份新的任务清单。 */
	set(texts: string[]): Promise<void>;
	/** 最近一次挂上的 widget 渲染出来的可见行（剥掉 ANSI）。 */
	lines(width?: number): string[];
	/** 直出最近一次挂上的组件（同样每帧新组件），用于喂给 gap.ts 的邻居判定。 */
	component(): WidgetComponent;
}

/** 剥掉所有 ANSI / OSC 转义，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 测试用的主题：颜色名原样写出来，断言直接看得见（同 web-search-tree 的做法）。 */
const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => `~${text}~`, bold: (t: string) => t };

async function loadHarness(): Promise<{ harness: Harness; cleanup: () => void }> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{
			extensions: Array<{
				handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
				tools: Map<string, { definition: { execute: (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> } }>;
			}>;
			errors: Array<{ path: string; error: string }>;
			runtime: Record<string, unknown>;
		}>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-task-viewport-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, undefined);
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 simple-task 扩展");

	// spinner 的 setInterval 在扩展闭包里 —— 不关掉的话 node 的事件循环不退出，
	// 整个 `node --test` 会挂到超时。这正是 session_shutdown 在真实会话里的职责。
	const shutdown = extension.handlers.get("session_shutdown")?.[0];
	assert.ok(shutdown, "扩展应当注册 session_shutdown 来停掉动画定时器");

	const widgets: Harness["widgets"] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		ui: {
			setWidget: (key: string, content: unknown) => {
				widgets.push({ key, factory: typeof content === "function" ? (content as WidgetFactory) : undefined });
			},
			notify: () => {},
		},
		sessionManager: { getBranch: () => [] },
	};
	loaded.runtime.appendEntry = () => {};

	const run = async (name: string, params: unknown): Promise<void> => {
		const definition = extension.tools.get(name)?.definition;
		assert.ok(definition, `扩展必须注册 ${name}`);
		await definition.execute("call-1", params, undefined, undefined, ctx);
	};

	const lastRendered = (): WidgetFactory => {
		for (let index = widgets.length - 1; index >= 0; index -= 1) {
			const entry = widgets[index];
			if (entry?.factory) return entry.factory;
		}
		throw new Error("还没有挂上 widget");
	};

	const harness: Harness = {
		widgets,
		async set(texts) {
			await run("task_set", { tasks: texts });
		},
		async update(id, status) {
			await run("task_update", { id, status });
		},
		component() {
			return lastRendered()(undefined, theme);
		},
		lines(width = 79) {
			return harness.component().render(width).map(plain);
		},
	};

	return {
		harness,
		cleanup: () => {
			void shutdown({}, ctx);
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

const TEXTS = Array.from({ length: 13 }, (_, index) => `Task ${index + 1}`);

test("13 项、前 10 项完成、#11 进行中 → 视口滚到 #4..#11，窗口内恰好 8 项", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 10; id += 1) await harness.update(id, "done");
		await harness.update(11, "in_progress");

		const lines = harness.lines();
		assert.deepEqual(
			lines,
			[
				"● 13 tasks (10 done, 1 in progress, 2 open)",
				"    … 3 more",
				"  ✔ ~#4 Task 4~",
				"  ✔ ~#5 Task 5~",
				"  ✔ ~#6 Task 6~",
				"  ✔ ~#7 Task 7~",
				"  ✔ ~#8 Task 8~",
				"  ✔ ~#9 Task 9~",
				"  ✔ ~#10 Task 10~",
				"  ▣ #11 Task 11…",
				"    … and 2 more",
			],
			"当前项 #11 必须落在视口末行，窗口内 8 条",
		);
	} finally {
		cleanup();
	}
});

test("前 8 项还没完成时窗口停在开头（最小位移，不提前滚动）", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 7; id += 1) await harness.update(id, "done");
		await harness.update(8, "in_progress");

		const lines = harness.lines();
		assert.equal(lines[1], "  ✔ ~#1 Task 1~", "第 8 项是锚点、还在窗口里 → 不滚，仍从 #1 起");
		assert.equal(lines[8], "  ▣ #8 Task 8…");
		assert.equal(lines[9], "    … and 5 more");
		assert.equal(lines.some((line) => line.includes("… 1 more")), false, "没有上方隐藏项时不该出现上行折叠提示");
	} finally {
		cleanup();
	}
});

test("全部完成时窗口停在末尾 —— 下面没有内容了，不该再显示省略行", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 13; id += 1) await harness.update(id, "done");

		const lines = harness.lines();
		assert.equal(lines[0], "● 13 tasks (13 done)");
		assert.equal(lines[1], "    … 5 more");
		assert.equal(lines[2], "  ✔ ~#6 Task 6~", "窗口贴住末尾 8 条");
		assert.equal(lines[9], "  ✔ ~#13 Task 13~");
		assert.equal(lines.length, 10, "末尾没有隐藏项 → 不出现下方省略行");
	} finally {
		cleanup();
	}
});

test("8 项以内与改动前逐字节相同（无折叠行、不缩进）", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS.slice(0, 3));
		await harness.update(1, "done");
		await harness.update(2, "in_progress");
		const lines = harness.lines();
		assert.deepEqual(lines, [
			"● 3 tasks (1 done, 1 in progress, 1 open)",
			"  ✔ ~#1 Task 1~",
			"  ▣ #2 Task 2…",
			"  ◻ #3 Task 3",
		]);
		assert.equal(lines.some((line) => line.includes(" more")), false, "无隐藏项时两端都不该出现折叠行");
	} finally {
		cleanup();
	}
});

/**
 * gap.ts 的判定输入：折叠提示行有可见文字，不能被当成空白。
 * 把真 widget 组件原样喂给 widgetGaps（它只看 render 结果），不用重写一份假行 ——
 * 阶梯与行首缩进都在真实渲染里产生，假行会让这条断言变成空转。
 */
test("上下折叠提示行算「有内容」，邻居仍会补一行空行", { skip }, async () => {
	const { harness, cleanup } = await loadHarness();
	try {
		await harness.set(TEXTS);
		for (let id = 1; id <= 10; id += 1) await harness.update(id, "done");
		await harness.update(11, "in_progress");
		assert.equal(harness.lines()[1], "    … 3 more", "前提：上方确实有折叠行");

		// 把真组件喂给 gap.ts（它只看 render 结果）—— 阶梯与行首缩进都在真实渲染里产生。
		const neighbour = { render: (): string[] => ["● 3 tasks", "  ◻ #1 其它块"], invalidate() {} };
		const self = harness.component();
		const below = { render: (): string[] => ["● other widget"], invalidate() {} };

		assert.deepEqual(
			widgetGaps({ children: [neighbour, self] }, self, 79),
			{ above: true, below: false },
			"上方邻居有内容 → 补一行；自己顶行的折叠提示不能被当成空行",
		);
		// 同一个组件实例只能喂同一棵树（widgetGaps 按引用找自己）。
		const self2 = harness.component();
		assert.deepEqual(
			widgetGaps({ children: [self2, below] }, self2, 79),
			{ above: false, below: true },
			"下方邻居有内容 → 补一行；自己底行的折叠提示不能被当成空行",
		);
	} finally {
		cleanup();
	}
});
