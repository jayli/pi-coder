/**
 * Tests for recap/index.ts — the idle gate in front of the auto recap.
 *
 * Run with:  node --test clients/pi/extensions/recap/index.test.ts
 *
 * This one takes ~35s on purpose: the 10s idle threshold is hard-coded and the test uses
 * real timers (the whole point is "does it *not* recap while work is still running"), so
 * nothing is shortened or faked as a shortcut. What is faked is everything outside the
 * extension: the ctx (a canned last exchange + a recording modelRegistry/ui) and the
 * other side of the event bus. pi's own extension loader really loads `index.ts`, so the
 * `./subagents.ts` import and the handler/command registrations are covered too.
 *
 * Timeline asserted:
 *   agent_settled → 10s idle → probe #1 says "1 subagent running"  → no recap
 *                              (only a 10s poll is armed)
 *   flip the fake fleet to idle → probe #2 says "nothing running"  → still no recap
 *                              (the 10s idle timer restarts)
 *   → 10s later → recap generated and shown.
 *
 * The second test covers the widget's breathing line: the blank line above the recap is
 * decided at render time by walking the editor's widget container (`../simple-task/gap.ts`)
 * instead of guessing from the task-list state, and the re-entrancy guard keeps
 * simple-task's own walk (which renders this component right back) from recursing forever.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SUBAGENT_RPC_REPLY_PREFIX, SUBAGENT_RPC_REQUEST } from "./subagents.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态，两个都能加载扩展。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 后者是**扩展包的安装根**，`pi update --extensions` 会用
 * `--config.auto-install-peers=false` 把自动装进去的 `@earendil-works/pi-*` 同伴包剪掉，
 * 于是那份副本只剩空壳（文件都在、import 报 `ERR_MODULE_NOT_FOUND`；2026-09 升
 * pi-subagents 0.68.0 时实测踩到）。
 *
 * 判定方式是**能不能真 import**，不是路径存不存在 —— 只有真 import 一次才分得清空壳。
 * 全都不行就返回 undefined，调用方整体 skip（不假装通过）。
 */
async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const shimPath = path.join(dir, "pi");
		try {
			// npm 的 shim 是符号链接
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
const skip = piEntry === undefined ? "找不到本机 pi 的库入口（装过 pi 才有）" : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface WidgetComponent {
	render(width: number): string[];
}
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface Recorder {
	/** `modelRegistry.complete` 被调用的次数（摘要生成 = 一次）。 */
	completeCalls: number;
	/** 每次 `modelRegistry.complete` 收到的 options（`maxTokens` 等断言看这里）。 */
	completeOptions: Array<Record<string, unknown> | undefined>;
	/** 每次 `setWidget(key, <factory>)` 记一个；undefined 不入列。 */
	widgets: WidgetFactory[];
	/** `ui.notify` 收到的文案（成功是一条 `✦ Recap: …`，失败是「没能生成 recap…」）。 */
	notifies: string[];
}

/** 假 ctx：只提供 recap 这条路径上真正用到的东西。`complete` 可注入模型返回（含 stopReason）。 */
function createContext(recorder: Recorder, branch?: unknown[], complete?: () => unknown): unknown {
	return {
		mode: "tui",
		isIdle: () => true,
		model: { provider: "test", id: "test-model" },
		sessionManager: {
			getBranch: () =>
				branch ?? [
					{ type: "message", message: { role: "user", content: "把 recap 的定时改成等子代理结束" } },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "改完了，正在等子代理的结果。" }] } },
				],
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
			complete: async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
				recorder.completeCalls += 1;
				recorder.completeOptions.push(options);
				return complete ? complete() : { content: [{ type: "text", text: "已把 recap 定时改成等子代理结束" }] };
			},
		},
		ui: {
			setWidget: (_key: string, widget: unknown) => {
				if (widget) recorder.widgets.push(widget as WidgetFactory);
			},
			notify: (message: string) => {
				recorder.notifies.push(message);
			},
		},
	};
}

interface TestBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createTestBus(): TestBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.set(channel, set);
			set.add(handler);
			return () => {
				set.delete(handler);
			};
		},
		emit(channel, data) {
			// 复制一份：真实 EventEmitter 也是同步派发给订阅者。
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

/** 等谓词成立；超时就把「在等什么」一并报出来。 */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`等不到：${what}（超时 ${timeoutMs}ms）`);
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recap-idle-gate-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return {
		agentDir,
		projectDir,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

test("有子代理在跑时不生成摘要；等它结束后重新起 10s 定时再生成", { skip, timeout: 180_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		/** 假 pi-subagents：`active` 就是它 `status` 回包里的 `fleet.totalActive`。 */
		const bridge = { active: true, requests: [] as Array<Record<string, unknown>> };
		bus.on(SUBAGENT_RPC_REQUEST, (data) => {
			const request = data as Record<string, unknown>;
			bridge.requests.push(request);
			const reply = {
				version: 1,
				requestId: request.requestId,
				method: "status",
				success: true,
				data: { text: "…", fleet: { version: 1, entries: [], totalActive: bridge.active ? 1 : 0, omitted: 0 } },
			};
			// 真实 RPC 的回复是异步的（handler 里 await 过）。
			setTimeout(() => bus.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${String(request.requestId)}`, reply), 0);
		});

		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ handlers: Map<string, Handler[]>; commands: Map<string, unknown> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错（`./subagents.ts` 的 import 也在这里被验证）");
		assert.equal(loaded.extensions.length, 1);
		const extension = loaded.extensions[0];
		assert.ok(extension);

		// 注册面：这里挂了计时器（agent_settled / agent_start）与清理（session_*），命令面有 /recap。
		const settled = extension.handlers.get("agent_settled")?.[0];
		const shutdown = extension.handlers.get("session_shutdown")?.[0];
		assert.ok(settled, "应该注册了 agent_settled");
		assert.ok(extension.handlers.get("agent_start")?.length, "应该注册了 agent_start");
		assert.ok(extension.handlers.get("input")?.length, "应该注册了 input");
		assert.ok(shutdown, "应该注册了 session_shutdown");
		assert.ok(extension.commands.has("recap"), "应该注册了 /recap 命令");

		const recorder: Recorder = { completeCalls: 0, completeOptions: [], widgets: [], notifies: [] };
		const ctx = createContext(recorder);

		// 回合结束：起 10s 空闲表（此刻不会有任何输出）。
		await settled({}, ctx);
		assert.equal(recorder.completeCalls, 0);
		assert.equal(recorder.widgets.length, 0);

		// ~10s 后第一次探测：假舰队里有 1 个活跃子代理 → 只重查，不生成。
		await waitFor(() => bridge.requests.length >= 1, 45_000, "空闲 10s 后的第一次子代理探测");
		assert.equal(bridge.requests[0]?.method, "status");
		assert.equal(recorder.completeCalls, 0, "有子代理在跑时绝不能生成摘要");
		assert.equal(recorder.widgets.length, 0, "有子代理在跑时不能出现 recap widget");

		// 子代理结束：等下一次重查（10s 一轮）确认「没活了」——但这时也不生成，
		// 而是重新起一轮 10s 定时（结果刚回来、被唤醒的回合正要跑，现在总结是半截的）。
		bridge.active = false;
		await waitFor(() => bridge.requests.length >= 2, 15_000, "waiting 模式下的 10s 重查");
		assert.equal(recorder.completeCalls, 0, "刚查到没活时应重新起 10s 定时，而不是立刻生成");

		// 重新起表后 10s：生成并显示摘要。
		await waitFor(() => recorder.completeCalls >= 1, 45_000, "重新起表 10s 后的摘要生成");
		assert.equal(recorder.widgets.length, 1, "摘要应该已经挂上 widget");

		// widget 渲染的是清洗后的摘要文本（`✦ Recap:` 前缀 + 下方空行）。
		const component = recorder.widgets[0]?.(undefined, { fg: (_color: string, text: string) => text });
		assert.ok(component);
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /✦ Recap:/);
		assert.match(rendered, /已把 recap 定时改成等子代理结束/);

		await shutdown?.({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

test("间隔由渲染时探测邻居决定：无邻居不加、邻居有内容加一行、邻居已带空行不重复、重入不死循环", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{
					commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
				}>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("recap");
		assert.ok(command, "应该注册了 /recap 命令");

		// /recap 是 force=true 的那条路（不走 10s 闲置闸门），拿到的 widget 工厂就是渲染现场。
		const recorder: Recorder = { completeCalls: 0, completeOptions: [], widgets: [], notifies: [] };
		await command.handler("", createContext(recorder));
		assert.equal(recorder.widgets.length, 1, "/recap 应该挂上 widget");

		const theme = { fg: (_color: string, text: string) => text };
		/** 每个场景都要一个新组件：重入标记在闭包里，不能复用。 */
		const newComponent = (tui: unknown): WidgetComponent =>
			(recorder.widgets[0] as WidgetFactory)(tui, theme);
		/** pi 的「编辑器上方」容器长这样：先一个全空的 Spacer，再按注册顺序放各扩展的 widget。 */
		const container = (...neighbours: unknown[]): { children: unknown[] } => {
			const tui = { children: [{ render: (): string[] => [""] }] as unknown[] };
			for (const neighbour of neighbours) tui.children.push(neighbour);
			return tui;
		};

		// 1) 容器里只有自己（上面的 Spacer 是全空行）→ 不加前导空行。
		const alone = newComponent(undefined);
		const aloneLines = alone.render(80);
		assert.equal(aloneLines.length, 2, "单独显示 = 摘要一行 + 下方空行");
		assert.match(aloneLines[0] ?? "", /✦ Recap:/);
		assert.equal(aloneLines[1], "", "摘要下方固定补一个空行");

		// 2) 上方邻居有可见内容（任务清单 / pi-subagents 的 `async subagent` 块）→ 补前导空行。
		const withNeighbour = container({ render: (): string[] => [" ● 3 tasks", "  ◻ #1 甲"], invalidate() {} });
		const spaced = newComponent(withNeighbour);
		withNeighbour.children.push(spaced);
		const spacedLines = spaced.render(80);
		assert.equal(spacedLines.length, 3, "邻居有内容 → 恰好一个前导空行");
		assert.equal(spacedLines[0], "");
		assert.match(spacedLines[1] ?? "", /✦ Recap:/);
		assert.equal(spacedLines[2], "", "下方空行不受影响");

		// 3) 上方邻居自己就以空行收尾（间隔已经有了）→ 不再补，否则会多出一行。
		const blankTailed = container({ render: (): string[] => [" ● 3 tasks", ""], invalidate() {} });
		const quiet = newComponent(blankTailed);
		blankTailed.children.push(quiet);
		const quietLines = quiet.render(80);
		assert.equal(quietLines.length, 2, "邻居已带空行 → 不重复补");
		assert.match(quietLines[0] ?? "", /✦ Recap:/);

		// 4) 邻居的 render 反过来再渲染 recap（simple-task 的 gap.ts 就是这样看邻居的）→
		//    有重入保护：只重入一次，且那次不带前导空行；间隔由外层那次 walk 统一决定。
		const nested: string[][] = [];
		let cyclic: WidgetComponent | undefined;
		const cyclicNeighbour = {
			render: (): string[] => {
				nested.push(cyclic?.render(80) ?? []);
				return [" ● 3 tasks", "  ◻ #1 甲"];
			},
			invalidate() {},
		};
		const cyclicContainer = container(cyclicNeighbour);
		cyclic = newComponent(cyclicContainer);
		cyclicContainer.children.push(cyclic);
		const outerLines = cyclic.render(80);
		assert.equal(nested.length, 1, "重入只发生一次（没有重入保护会一直递归到栈溢出）");
		assert.equal(nested[0]?.length, 2, "重入的那次只输出内容行");
		assert.match(nested[0]?.[0] ?? "", /✦ Recap:/);
		assert.equal(outerLines.length, 3, "外层那次 walk 看到邻居有内容 → 补前导空行");
		assert.equal(outerLines[0], "");
		assert.match(outerLines[1] ?? "", /✦ Recap:/);
	} finally {
		workspace.cleanup();
	}
});

/**
 * `/recap` 的重复执行闸门：同一轮对话已经生成过摘要、且它还挂在屏幕上时，再执行不重跑
 * 模型、不重挂 widget、也不发通知 —— 那次生成一旦返回空，失败提示就会把刚生成的摘要顶掉。
 * 判据是「摘要存在 **且** 指纹（最后一轮 user+assistant+model）与上次生成时相同」，
 * 所以新对话一来闸门就放开：正常路径下 `input` 事件已经先把状态清了（这里也顺带覆盖），
 * 非交互来源的新消息则会因为指纹不同而放开。
 */
test("/recap 重复执行不重跑模型、不发提示；有新对话后才重新生成", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{
					handlers: Map<string, Handler[]>;
					commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
				}>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("recap");
		const onInput = loaded.extensions[0]?.handlers.get("input")?.[0];
		assert.ok(command, "应该注册了 /recap 命令");
		assert.ok(onInput, "应该注册了 input");

		/** 可变的对话分支：push 一对新消息就等于又聊了一轮。 */
		const branch: unknown[] = [
			{ type: "message", message: { role: "user", content: "甲" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "乙" }] } },
		];
		const recorder: Recorder = { completeCalls: 0, completeOptions: [], widgets: [], notifies: [] };
		const ctx = createContext(recorder, branch);

		// 第一次：正常生成 + 通知。
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 1, "第一次 /recap 应该生成");
		assert.equal(recorder.widgets.length, 1);
		assert.deepEqual(recorder.notifies, ["✦ Recap: 已把 recap 定时改成等子代理结束"]);

		// 第二次（没有新对话）：闸门命中，什么都不做。
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 1, "同一轮对话不该第二次调模型");
		assert.equal(recorder.widgets.length, 1, "不该重挂 widget");
		assert.equal(recorder.notifies.length, 1, "不该再发通知（失败提示会把摘要顶掉）");

		// 新对话 + 交互输入：`input` 先把摘要与状态清掉，再执行就该重新生成。
		branch.push({ type: "message", message: { role: "user", content: "丙" } });
		branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "丁" }] } });
		await onInput({ source: "interactive" }, ctx);
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 2, "input 清过状态后应该重新生成");
		assert.equal(recorder.notifies.length, 2);

		// 紧接着再按一次：又成了同一轮，不再重复。
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 2, "同一轮仍不重复");

		// 新对话但没人发过 `input`（非交互来源的消息，清不到状态）→ 指纹不同，闸门同样放开。
		branch.push({ type: "message", message: { role: "user", content: "戊" } });
		branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "己" }] } });
		await command.handler("", ctx);
		assert.equal(recorder.completeCalls, 3, "指纹变了就该重新生成");

		await loaded.extensions[0]?.handlers.get("session_shutdown")?.[0]?.({}, ctx);
	} finally {
		workspace.cleanup();
	}
});

/**
 * 输出预算必须容得下「思考 + 正文」。claude 路由在 `gateway/config.yaml` 里钉了
 * `thinking: {type: enabled}` + `reasoning_effort: max`，摘要请求就算不传 thinking 也会先思考，
 * 而 Anthropic 的 `max_tokens` 是两者共享的预算 —— 预算太小时思考吃光额度，正文只剩半句
 * （甚至 0 字符）。本机实测 96 时 17 次里 6 次 `stop_reason=max_tokens`，512 时 8/8 完整。
 */
test("摘要请求的输出预算要同时容得下思考与正文（96 会被思考吃光）", { skip, timeout: 30_000 }, async () => {	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("recap");
		assert.ok(command, "应该注册了 /recap 命令");

		const recorder: Recorder = { completeCalls: 0, completeOptions: [], widgets: [], notifies: [] };
		await command.handler("", createContext(recorder));

		const maxTokens = recorder.completeOptions[0]?.maxTokens;
		assert.equal(typeof maxTokens, "number", "generate() 必须显式给 maxTokens");
		assert.ok(
			(maxTokens as number) >= 1024,
			`输出预算 ${String(maxTokens)} 太小：思考与正文共享这个上限，实测 96 会被思考吃光并把正文切成半句`,
		);

		// 这些 max 档路由在 `temperature: 0` 下会退化成停不下来的长思考（`working-indicator`
		// 实测 2048 额度也被吃光且零正文，默认温度 3s 就正常返回）。摘要不需要确定性到那个程度。
		assert.notEqual(recorder.completeOptions[0]?.temperature, 0, "不能给这些 max 档路由传 temperature: 0");
	} finally {
		workspace.cleanup();
	}
});

/**
 * `stop_reason=max_tokens` 意味着模型的话没说完 —— 这时摘要必须带省略号，不能把半句话
 * 当成完整摘要显示。正常结束（`stop`）时一个字都不应该多（对照由上面几条 `notifies`
 * 的 deepEqual 钉住）。
 */
test("被 max_tokens 截断的摘要以省略号收尾，不把半句当完整摘要", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const bus = createTestBus();
		const pi = (await import(pathToFileURL(piEntry as string).href)) as {
			discoverAndLoadExtensions: (
				configuredPaths: string[],
				cwd: string,
				agentDir?: string,
				eventBus?: unknown,
			) => Promise<{
				extensions: Array<{ commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }> }>;
				errors: Array<{ path: string; error: string }>;
			}>;
		};
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, bus);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("recap");
		assert.ok(command, "应该注册了 /recap 命令");

		const recorder: Recorder = { completeCalls: 0, completeOptions: [], widgets: [], notifies: [] };
		await command.handler(
			"",
			createContext(recorder, undefined, () => ({
				content: [{ type: "text", text: "用户否决记忆弹窗方案改每次不记忆，助手" }],
				stopReason: "length",
			})),
		);

		assert.equal(recorder.notifies.length, 1);
		assert.match(recorder.notifies[0] ?? "", /助手…$/, "被 max_tokens 切断的正文必须补省略号");

		const component = recorder.widgets[0]?.(undefined, { fg: (_color: string, text: string) => text });
		assert.ok(component);
		assert.match(component.render(80).join("\n"), /助手…/, "widget 里显示的同样是带省略号的版本");
	} finally {
		workspace.cleanup();
	}
});
