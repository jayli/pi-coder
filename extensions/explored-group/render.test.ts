/**
 * explored-group / render —— 端到端渲染测试。
 *
 * 手法与 `bash-command-collapse/render.test.ts` 一致：pi 自己的加载器真加载三个扩展，
 * 再用 pi 自己的 `ToolExecutionComponent` 渲染真实块，对**渲染出来的行**做断言 ——
 * 这个特性的全部价值就是「屏幕上长什么样」，只测内部函数会漏掉分层叠出来的问题。
 *
 * Run with:  node --test clients/pi/extensions/explored-group/render.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.join(HERE, "..");
const CWD = "/Users/bachi/jaylli/litellm-any";
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

async function findPiLibraryEntry(): Promise<string | undefined> {
	const packageDir = path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent");
	const candidates = [
		process.env.PI_TEST_PI_ENTRY,
		path.join(packageDir, "dist/bundle/index.js"),
		path.join(packageDir, "dist/index.js"),
	].filter((c): c is string => typeof c === "string");
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

if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: any }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: any,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		markExecutionStarted: () => void;
		setArgsComplete?: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) {
	pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;
	// 渲染要读主题（`theme.getFgAnsi` / `theme.fg`），不初始化会直接抛
	// 「Theme not initialized」。默认皮肤在别处被改过，这里固定用 1337。
	pi.initTheme("pi-coder-1337", false);
}

/** 三个扩展一起加载：分组状态是跨扩展的 `globalThis` 单例，必须真加载才建得起来。 */
const loaded = pi
	? await pi.discoverAndLoadExtensions(
			[
				path.join(EXT_DIR, "explored-group/index.ts"),
				path.join(EXT_DIR, "bash-command-collapse.ts"),
				path.join(EXT_DIR, "read-path-collapse.ts"),
			],
			CWD,
			path.join(os.tmpdir(), "explored-group-test-agent"),
			pi.createEventBus(),
		)
	: undefined;

const definitionOf = (name: string): any =>
	loaded?.extensions.flatMap((e) => [...e.tools.entries()]).find(([n]) => n === name)?.[1].definition;

const registry = piEntry ? await import(pathToFileURL(path.join(HERE, "registry.ts")).href) : undefined;

/** 剥掉 ANSI / OSC，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "").replace(/\s+$/, "");
/** 整块渲染 + 去 ANSI + 去掉 ToolExecutionComponent 自己加的那个前导空行。 */
function renderBlock(name: string, id: string, args: unknown, expanded = false, width = 100): string[] {
	const component = new pi!.ToolExecutionComponent(name, id, args, {}, definitionOf(name), { requestRender() {} }, CWD);
	component.markExecutionStarted();
	component.setArgsComplete?.(); // 不置位的话 bash 块会一直按「命令还在流」隐藏（原有行为）
	component.setExpanded(expanded);
	const lines = component.render(width).map(plain);
	if (lines[0] === "") lines.shift();
	return lines;
}

/** 整块渲染，**保留 ANSI**（加粗断言用；`plain` 会把粗体一起剥掉）。 */
function renderBlockRaw(name: string, id: string, args: unknown, width = 100, expanded = false): string[] {
	const component = new pi!.ToolExecutionComponent(name, id, args, {}, definitionOf(name), { requestRender() {} }, CWD);
	component.markExecutionStarted();
	component.setArgsComplete?.();
	component.setExpanded(expanded);
	const lines = component.render(width);
	if (lines[0] === "") lines.shift();
	return lines;
}

/** 该行里 `Read` 这个词是不是粗体（只看动词，不看后续路径）。 */
function readVerbIsBold(line: string): boolean {
	// 字形周围的粗体开关：pi 用 `\u001b[1m` … `\u001b[22m`（`theme.bold()` = chalk.bold）
	const at = line.indexOf("Read");
	if (at < 0) return false;
	const before = line.slice(0, at);
	const lastOn = before.lastIndexOf("\u001b[1m");
	const lastOff = before.lastIndexOf("\u001b[22m");
	return lastOn > lastOff;
}

/**
 * 建一条 assistant 消息并重放（断组与登记的权威入口）。
 *
 * 走的是与 `index.ts` 的 `message_end` 处理器**相同的两步**：先 `replayMessage`（断组 + 登记），
 * 再 `markMessageReady`（开闸让成员进树）。少第二步的话，测试会把「历史里的消息」
 * 当成「正在流的消息」，所有行都停在未就绪态而渲染成空 —— 那是测试没模拟对，不是实现错。
 *
 * 需要「只登记、不开闸」（测流式期隐身）时用 `replayStreaming()`。
 */
function replay(content: unknown[]): void {
	registry!.replayMessage({ role: "assistant", content });
	registry!.markMessageReady({ role: "assistant", content });
}

/** 只重放消息（模拟 `message_update` 那一刻：已登记，但命令还没吐完）。 */
function replayStreaming(content: unknown[]): void {
	registry!.replayMessage({ role: "assistant", content });
}

function reset(): void {
	registry!.resetForTesting();
	// `resetForTesting` 会把「已接手」闸门一起清掉，而真实会话里 `session_start` 会开它；
	// 不开的话渲染层不会遮任何东西 —— 测试就测不到流式那一帧了。
	registry!.arm();
}

const BASH = (command: string) => ({ command });
const READ = (p: string) => ({ path: p });

/**
 * 流式帧渲染：模拟 pi 在参数**还没到齐**时的真实调用序列。
 *
 * `renderBlock` 一上来就 `markExecutionStarted` + `setArgsComplete`，那是**参数已齐**的终态；
 * 而实时会话里 pi 先构造组件（args 为 `{}` 或半截），之后每收一个 `input_json_delta`
 * 调一次 `updateArgs()` —— 用户 2026-10-06 报的「先流出一段灰文本再折叠」就在这段里。
 * 返回每一步渲染出的行（已去 ANSI），供断言「中途一帧都不许出」。
 */
function renderStreamingFrames(name: string, id: string, argsSteps: unknown[], width = 100): string[][] {
	const frames: string[][] = [];
	const push = (c: any) => {
		const lines = c.render(width).map(plain);
		if (lines[0] === "") lines.shift();
		frames.push(lines);
	};
	const component = new pi!.ToolExecutionComponent(name, id, {}, {}, definitionOf(name), { requestRender() {} }, CWD);
	push(component);
	for (const args of argsSteps) {
		component.updateArgs(args);
		push(component);
	}
	return frames;
}

test("流式：参数未吐完不进树，吐完那一刻直接出折叠行（用户 2026-10-07 报「先流灰文本再折叠」）", { skip }, () => {
	// 用户原话：「不要先输出原始流式文本，bash 指令被吐完后…直接输出为折叠后的 Search」。
	// 两段都要拦：
	//   1. **不能冒原生帧** —— `ensureRegistered` 在 pending 时返回 null，渲染器假设
	//      「null = 不可折叠」而退回内置渲染，屏幕上先闪一帧 `grep // in .`。
	//   2. **也不能在树里逐字长** —— 行内文字跟着 token 变（`└ bash` → `Search "auth"` → …）
	//      仍然是「先看到流式文本」，只是换了个地方。
	reset();
	const frames = renderStreamingFrames("grep", "s1", [{ pattern: "" }, { pattern: "a" }, { pattern: "authorization", path: "proxy/proxy-core" }]);
	// 全程（命令还在流）一行都不出 —— 既不是原生帧，也不是半截的 Explored 行
	for (const [i, lines] of frames.entries()) {
		assert.deepEqual(lines, [], `第 ${i} 帧（命令还没吐完）不该出任何行，实际：${JSON.stringify(lines)}`);
	}
	// 「吐完」那一刻（真实 pi 里是 message_end）→ 直接就是完整的一行
	registry!.markMessageReady({ role: "assistant", content: [{ type: "toolCall", id: "s1", name: "grep", arguments: { pattern: "authorization", path: "proxy/proxy-core" } }] });
	const after = new pi!.ToolExecutionComponent("grep", "s1", { pattern: "authorization", path: "proxy/proxy-core" }, {}, definitionOf("grep"), { requestRender() {} }, CWD);
	after.markExecutionStarted();
	after.setArgsComplete?.();
	const lines = after.render(100).map(plain);
	if (lines[0] === "") lines.shift();
	assert.deepEqual(lines, ["• Explored", '  └ Search "authorization" in proxy/proxy-core']);
});

test("流式：被中断（args 永远不齐）的块不得永久隐身 —— 仍要能看到报错", { skip }, () => {
	// pi 在 message_end(aborted / error) 时对每个未完成的块调 `updateResult({...}, false)`，
	// **既不置 argsComplete 也不补 args**。只看 «参数未到齐» 就遮的话，这个块会永久隐身，
	// 用户连那条 `Operation aborted` 都看不到 —— 所以遮的条件必须同时要求 `isPartial`
	//（与 bash 侧同一条口径，见 `shouldHideWhilePending`）。
	reset();
	const component = new pi!.ToolExecutionComponent("grep", "abort-1", {}, {}, definitionOf("grep"), { requestRender() {} }, CWD);
	// 中断前：args 未到齐 + 还在跑（构造时 isPartial 默认 true）→ 隐身（不画原生帧）
	assert.deepEqual(component.render(100).map(plain).filter((l: string) => l !== ""), [], "中断前应隐身，不得画原生帧");
	// 模拟 pi：带错误结果、isPartial=false，args 仍是空的
	component.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
	const lines = component.render(100).map(plain).filter((l: string) => l !== "");
	assert.ok(lines.length > 0, `中断后必须画出内容（否则永久隐身），实际：${JSON.stringify(lines)}`);
	assert.ok(lines.join("\n").includes("Operation aborted"), `中断后应能看到报错，实际：${JSON.stringify(lines)}`);
	// 同时把「快退化成永久隐身」的失效形态钉住：带 `isPartial=false` 时**不能**再遮。
	// `shouldHideWhilePending` 的三个条件缺一不可；去掉 `isPartial` 这一项时，
	// 这个块会只剩报错行、`grep` 标题消失（实测过）。
	assert.ok(lines.some((l: string) => l.includes("grep")), `中断后标题也应恢复（不能只剩报错），实际：${JSON.stringify(lines)}`);
});

test("流式：原生 find / ls / read 同样不先出原生帧", { skip }, () => {
	// find：`{}` / `pattern:""` 隐藏，pattern 一到就 Explored（曾冒出 `find  in .`）
	reset();
	const findFrames = renderStreamingFrames("find", "st-find", [{ pattern: "" }, { pattern: "*.ts", path: "clients" }]);
	for (const [i, lines] of findFrames.entries()) assert.deepEqual(lines, [], `find 第 ${i} 帧（命令还在流）不该出，实际：${JSON.stringify(lines)}`);

	// read：同样（曾冒出 `• Read ...`）
	reset();
	const readFrames = renderStreamingFrames("read", "st-read", [
		{ path: "" },
		{ path: "/Users/bachi/jaylli/litellm-any/README.md" },
	]);
	for (const [i, lines] of readFrames.entries()) assert.deepEqual(lines, [], `read 第 ${i} 帧（参数还在流）不该出，实际：${JSON.stringify(lines)}`);

	// ls：同样要等（曾冒出一帧原生 `ls`）
	reset();
	const lsFrames = renderStreamingFrames("ls", "st-ls", [{ path: "clients/pi" }]);
	for (const [i, lines] of lsFrames.entries()) assert.deepEqual(lines, [], `ls 第 ${i} 帧不该出，实际：${JSON.stringify(lines)}`);

	// 「吐完」之后三者都直接出折叠行
	for (const [name, id, args, expected] of [
		["find", "st-find", { pattern: "*.ts", path: "clients" }, ['  └ Find *.ts in clients']],
		["read", "st-read", { path: "/Users/bachi/jaylli/litellm-any/README.md" }, ["  └ Read README.md"]],
		["ls", "st-ls", { path: "clients/pi" }, ["  └ List clients/pi"]],
	] as Array<[string, string, unknown, string[]]>) {
		reset();
		registry!.markMessageReady({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
		const c = new pi!.ToolExecutionComponent(name, id, args, {}, definitionOf(name), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		const lines = c.render(100).map(plain);
		if (lines[0] === "") lines.shift();
		assert.deepEqual(lines, ["• Explored", ...expected], `${name} 吐完后应直接出折叠行`);
	}
});

test("流式：异常路径不许让块永久隐身（漏了 message_end / 中断 / 只有 execution_end）", { skip }, () => {
	// 「命令未吐完就不进树」天然带一个风险：开闸信号没跟上时那个块会**永久隐身**。
	// 主信号是 `message_end`，但实测有三条路径拿不到它（或拿到时 args 已不能读），
	// 所以 `index.ts` 还挂了 `tool_execution_end`、渲染器里还有 `markReadyIfSettled` 兜底。
	// 这三条都是实测发现的真缺陷形态，删掉任何一层兜底都会把它们放回来。
	const CMD = "grep -n authorization f.ts";
	const content = [{ type: "toolCall", id: "ab1", name: "bash", arguments: { command: CMD } }];
	const renderOne = (): string[] => {
		const c = new pi!.ToolExecutionComponent("bash", "ab1", { command: CMD }, {}, definitionOf("bash"), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		const lines = c.render(100).map(plain).filter((l: string) => l !== "");
		return lines;
	};

	// ① 结果回了但 message_end 从未到（只有 tool_execution_end）
	reset();
	registry!.replayMessage({ role: "assistant", content });
	registry!.markMemberReady("ab1"); // 等价于 index.ts 里 tool_execution_end 的那一下
	assert.ok(renderOne().length > 0, "① 只有 execution_end 时也不能隐身");

	// ② 中断：args 完整但从未 ready（message_end 到了，但那时已不再补开闸）
	reset();
	registry!.replayMessage({ role: "assistant", content });
	const c2 = new pi!.ToolExecutionComponent("bash", "ab1", { command: CMD }, {}, definitionOf("bash"), { requestRender() {} }, CWD);
	c2.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
	const lines2 = c2.render(100).map(plain).filter((l: string) => l !== "");
	assert.ok(lines2.length > 0, `② 中断后也不能隐身，实际：${JSON.stringify(lines2)}`);

	// ③ 只有 message_end、工具还没执行完（既无结果也无 execution_end）
	reset();
	registry!.replayMessage({ role: "assistant", content });
	registry!.markMessageReady({ role: "assistant", content });
	assert.ok(renderOne().length > 0, "③ 吐完后即执行中，应当已可见");
});

test("形态：Search 与原生 Read 合在同一块（用户 2026-10-06 第二轮定）", { skip }, () => {
	reset();
	const content = [
		{ type: "thinking", text: "let me look" },
		{ type: "toolCall", id: "g1", name: "bash", arguments: BASH("cd /Users/bachi/jaylli/litellm-any && grep -rn 'bashOutput' clients/pi --include=*.ts | head -30") },
		{ type: "toolCall", id: "g2", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/CLAUDE.md") },
		{ type: "toolCall", id: "g3", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/package.json") },
	];
	replay(content);

	// 三条合为一棵：Search 一行，两个连续原生 read 合并成下一行（不再分两块）
	assert.deepEqual(renderBlock("bash", "g1", content[1]!.arguments), [
		"• Explored",
		'  └ Search "bashOutput" in clients/pi',
		"    Read …/jaylli/ttt/CLAUDE.md, …/jaylli/ttt/package.json",
	]);
	// 同组成员隐身：原生 read 也不再另起块
	assert.equal(renderBlock("read", "g2", content[2]!.arguments).length, 0);
	assert.equal(renderBlock("read", "g3", content[3]!.arguments).length, 0);
});

test("形态：Search/List/Git 同族各占一行，连续 read 合并成一行", { skip }, () => {
	reset();
	const content = [
		{ type: "toolCall", id: "m1", name: "bash", arguments: BASH("grep -rn x . --include=*.ts | head") },
		{ type: "toolCall", id: "m4", name: "ls", arguments: { path: "clients/pi/extensions" } },
		{ type: "toolCall", id: "m5", name: "grep", arguments: { pattern: "Explored", path: "clients/pi" } },
	];
	replay(content);
	// 非 read 三件（bash search / 原生 ls / 原生 grep）同族，共一棵树、各占一行
	assert.deepEqual(renderBlock("bash", "m1", content[0]!.arguments), [
		"• Explored",
		'  └ Search "x" in .',
		"    List clients/pi/extensions",
		'    Search "Explored" in clients/pi',
	]);
});

test("断组：thinking 插在中间 → 两个独立 Explored 块", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "k1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "thinking", text: "hmm" },
		{ type: "toolCall", id: "k2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.deepEqual(renderBlock("bash", "k1", BASH("grep -n a f1.ts")), ["• Explored", '  └ Search "a" in f1.ts']);
	// k2 自己成了新组的组长 —— 两个块，各自一棵树
	assert.deepEqual(renderBlock("bash", "k2", BASH("grep -n b f2.ts")), ["• Explored", '  └ Search "b" in f2.ts']);
});

test("断组：旁白（非空 text）插在中间同样拆开", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "n1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "text", text: "先看一下 A，再去看 B。" },
		{ type: "toolCall", id: "n2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.equal(renderBlock("bash", "n1", BASH("grep -n a f1.ts"))[0], "• Explored");
	assert.equal(renderBlock("bash", "n2", BASH("grep -n b f2.ts"))[0], "• Explored");
	// 空 text 不断组（流式里会先来一个空 text 块）
	reset();
	replay([
		{ type: "toolCall", id: "p1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "text", text: "   \n " },
		{ type: "toolCall", id: "p2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.deepEqual(renderBlock("bash", "p1", BASH("grep -n a f1.ts")), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		'    Search "b" in f2.ts',
	]);
	assert.equal(renderBlock("bash", "p2", BASH("grep -n b f2.ts")).length, 0, "p2 是同组成员，应隐身");
});

test("断组：不可折叠的 bash（跑测试）打断分组，且自己原样渲染", { skip }, () => {
	reset();
	const testCmd = "node --test index.test.ts 2>&1 | grep -E '^ℹ (tests|pass|fail)' | head -70";
	replay([
		{ type: "toolCall", id: "q1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "q2", name: "bash", arguments: BASH(testCmd) },
		{ type: "toolCall", id: "q3", name: "bash", arguments: BASH("grep -n c f3.ts") },
	]);
	assert.equal(renderBlock("bash", "q1", BASH("grep -n a f1.ts"))[0], "• Explored");
	// q2 不折叠 —— 它自己渲染成原来的 bash 块（有 `Run ` 前缀，不是 Explored）
	const q2 = renderBlock("bash", "q2", BASH(testCmd));
	assert.ok(q2.length > 0, "跑测试的块必须可见");
	assert.ok(q2.some((l) => l.includes("Run ")), "应走原有 bash 渲染");
	assert.ok(!q2.some((l) => l.includes("Explored")), "不该被折进 Explored");
	// q3 因 q2 断组而另开一组
	assert.equal(renderBlock("bash", "q3", BASH("grep -n c f3.ts"))[0], "• Explored");
});

test("断组：用户消息断组", { skip }, () => {
	reset();
	replay([{ type: "toolCall", id: "u1", name: "bash", arguments: BASH("grep -n a f1.ts") }]);
	registry!.noteUserMessage();
	replay([{ type: "toolCall", id: "u2", name: "bash", arguments: BASH("grep -n b f2.ts") }]);
	assert.deepEqual(renderBlock("bash", "u1", BASH("grep -n a f1.ts")), ["• Explored", '  └ Search "a" in f1.ts']);
	assert.deepEqual(renderBlock("bash", "u2", BASH("grep -n b f2.ts")), ["• Explored", '  └ Search "b" in f2.ts']);
});

test("增长：成员依次到达，组长的树跟着长（不需要重新登记）", { skip }, () => {
	reset();
	// 用**同族**的两个 bash（原生 read 会另开一组，见 `familyOf`）
	const content: any[] = [{ type: "toolCall", id: "r1", name: "bash", arguments: BASH("grep -n a f1.ts") }];
	replay(content);
	assert.deepEqual(renderBlock("bash", "r1", content[0].arguments), ["• Explored", '  └ Search "a" in f1.ts']);
	// 流式追加第二个成员（`message_update` 反复触发，registry 按内容指纹去重）
	content.push({ type: "toolCall", id: "r2", name: "bash", arguments: BASH("ls -la /tmp") });
	replay(content);
	assert.deepEqual(renderBlock("bash", "r1", content[0].arguments), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		"    List /tmp",
	]);
	// 原生 read 也并进这棵树（2026-10-06 第二轮：家族不再断组），行内按来源切段
	content.push({ type: "toolCall", id: "r3", name: "read", arguments: READ("/tmp/a/b/c.ts") });
	replay(content);
	assert.deepEqual(renderBlock("bash", "r1", content[0].arguments), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		"    List /tmp",
		"    Read …/a/b/c.ts",
	]);
	assert.equal(renderBlock("read", "r3", READ("/tmp/a/b/c.ts")).length, 0, "成员应隐身");
});

test("回归：流式反复更新不得拆组（pi 每次 message_update 都发新对象）", { skip }, () => {
	// 用户 2026-10-06 报的「两个相邻 Explored」：每个 assistant 消息都以 thinking 开头，
	// 而 `replayMessage` 曾用**消息对象**做去重键 —— pi 发的是 `{...partialMessage}`（新对象），
	// 于是每次 token 更新都重跑一遍 content[0] 的 thinking、再断一次组，工具块全部各自成组。
	reset();
	const th = { type: "thinking", text: "x" };
	const a = { type: "toolCall", id: "A", name: "bash", arguments: BASH("grep -n a f1.ts") };
	const b = { type: "toolCall", id: "B", name: "bash", arguments: BASH("grep -n b f2.ts") };
	// 注意 `replay()` 收的是 **content 数组**（它自己包 role），别传 {role, content} 进去
	replay([th]);
	// 模拟 pi 的流式：每次一个新对象，content 逐步追加；工具块一被创建就 renderCall 登记
	registry!.ensureRegistered("A", "bash", a.arguments);
	replay([th, a]);
	registry!.ensureRegistered("B", "bash", b.arguments);
	replay([th, a, b]);
	assert.equal(registry!.groupOf("A")?.leaderId, "A");
	assert.equal(registry!.groupOf("B")?.leaderId, "A", "同一条消息里的第二个可折叠块必须并进同一组");
	// 但**下一条** assistant 消息的 thinking 仍然断组（用户明确要求 Think 依断）
	replay([{ type: "thinking", text: "y" }, { type: "toolCall", id: "C", name: "bash", arguments: BASH("grep -n c f3.ts") }]);
	assert.equal(registry!.groupOf("C")?.leaderId, "C", "新消息的 thinking 必须断组");
});

test("回归：组长块折叠态也不画自己的输出（整组都不看内容）", { skip }, () => {
	// 用户 2026-10-06 报的第一个问题：短语树下面跟了一大片 grep 命中行。
	// 根因是 renderResult 只隐了**成员**、没隐**组长**。
	reset();
	replay([
		{ type: "toolCall", id: "L1", name: "bash", arguments: BASH("grep -n needle f1.ts") },
		{ type: "toolCall", id: "L2", name: "bash", arguments: BASH("grep -n other f2.ts") },
	]);
	const result = {
		content: [{ type: "text", text: "4:from http.server import ThreadingHTTPServer\n57:    server = ThreadingHTTPServer((\"0.0.0.0\", PORT), StaticHandler)" }],
		details: {},
	};
	const renderLeader = (expanded: boolean): string[] => {
		const c = new pi!.ToolExecutionComponent("bash", "L1", BASH("grep -n needle f1.ts"), {}, definitionOf("bash"), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		c.setExpanded(expanded);
		c.updateResult(result, false);
		return c.render(120).map(plain);
	};
	const collapsed = renderLeader(false);
	assert.ok(
		!collapsed.some((l) => l.includes("ThreadingHTTPServer")),
		`折叠态不得出现输出内容：${JSON.stringify(collapsed)}`,
	);
	// 展开态（ctrl+o）仍然给出内容 —— 那是唯一看得到内容的地方
	const expanded = renderLeader(true);
	assert.ok(expanded.some((l) => l.includes("ThreadingHTTPServer")), "展开态必须能看到内容");
});

test("回归：流式早期拿到空 args，后续真实 args 必须刷新（曾出现 `└ Read read`）", { skip }, () => {
	// `renderCall` 在参数还在流式到达时就会跑，第一次登记常常拿到空 args。
	// `register` 幂等他不能「定了就不改」，否则 path 永远不进来了。
	reset();
	registry!.ensureRegistered("R1", "read", {});
	registry!.ensureRegistered("R1", "read", READ("/Users/bachi/jaylli/ttt/a/b/c/CLAUDE.md"));
	replay([
		{ type: "toolCall", id: "R1", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/a/b/c/CLAUDE.md") },
		{ type: "toolCall", id: "R2", name: "read", arguments: READ("/Users/bachi/jaylli/ttt/a/b/c/package.json") },
	]);
	const lines = renderBlock("read", "R1", READ("/Users/bachi/jaylli/ttt/a/b/c/CLAUDE.md"));
	assert.ok(!lines.some((l) => /└ Read read\b/.test(l)), `不得出现 Read read：${JSON.stringify(lines)}`);
	assert.ok(
		lines.some((l) => l.includes("CLAUDE.md") && l.includes("package.json")),
		`应显示两个真实路径且缩略到两层目录：${JSON.stringify(lines)}`,
	);
});

test("回归：参数未到齐时不得断组（曾拆出三个相邻 Explored）", { skip }, () => {
	// 用户 2026-10-06 第二轮报的：同一条消息里三个连续只读 bash，却渲染成三个独立
	// `Explored`。根因在 pi 的流累加 —— 一个工具块刚出现时 `arguments` 是 `{}`
	//（`content_block_start` 里 `event.content_block.input ?? {}` 的种子），之后靠
	// `input_json_delta` 逐片填。旧代码拿空 args 去分类，`classifyBash("")` 回 `null`，
	// 于是每个块出现的那一刻都触发一次 `beginBreak()`，把上一块刚开的组关掉。
	reset();
	const th = { type: "thinking", text: "x" };
	const mk = (id: string, cmd: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: cmd } });
	const b1 = mk("B1", "cd /tmp; git status 2>&1 | head -3");
	const b2 = mk("B2", "cd /tmp; ls -t sessions/ | head -5");
	// 三条都取非 read 族（`sed -n` 归 read，会合法地另开一组）
	const b3 = mk("B3", "cd /tmp; grep -n version CHANGELOG.md");
	// 逐块流式：每块出现时 args 还是 {}，紧接着 args 到齐（renderCall 会跑两次）
	for (const [n, block] of [[1, b1], [2, b2], [3, b3]] as const) {
		const filled = [b1, b2, b3].slice(0, n - 1);
		replay([th, ...filled, { ...block, arguments: {} }]);
		registry!.ensureRegistered(block.id, "bash", {});
		registry!.ensureRegistered(block.id, "bash", block.arguments);
		replay([th, ...filled, block]);
	}
	assert.equal(registry!.groupOf("B1")?.leaderId, "B1");
	assert.equal(registry!.groupOf("B2")?.leaderId, "B1", "参数未到齐不得把 B1 的组关掉");
	assert.equal(registry!.groupOf("B3")?.leaderId, "B1", "第三个也必须并进同一组");
	// 渲染出来应该只有一棵树、三行成员（首行 `└ ` + 两行四格缩进）
	const lines = renderBlock("bash", "B1", b1.arguments);
	assert.equal(lines.filter((l) => l.startsWith("• Explored")).length, 1);
	assert.deepEqual(lines, [
		"• Explored",
		"  └ Git status",
		"    List sessions/",
		'    Search "version" in CHANGELOG.md',
	]);
	// `└ ` 整块只出现一次（用户 2026-10-06 第三轮定），后续成员行四格缩进
	assert.equal(lines.filter((l) => l.includes("└ ")).length, 1, `应只有一个 └：${JSON.stringify(lines)}`);
});
test("pending：read / grep 缺必填参数也算未到齐，ls 则不算", { skip }, () => {
	// `ls` 的 `path` 是可选的（缺省 = 当前目录），所以不能把它当「还没到」而漏掉分组
	reset();
	registry!.replayMessage({ role: "assistant", content: [{ type: "thinking", text: "x" }] });
	assert.equal(registry!.ensureRegistered("P1", "read", {}), null, "read 缺 path → 这一帧不接管");
	assert.equal(registry!.ensureRegistered("P2", "grep", {}), null, "grep 缺 pattern → 不接管");
	assert.ok(registry!.ensureRegistered("P3", "ls", {}) !== null, "ls 缺 path 是合法取值，应正常入组");
});

test("回归：读 SKILL.md 不被折进 Explored，恢复 pi 的 `[skill] <名字>` 紧凑形态", { skip }, () => {
	// 用户 2026-10-06 报：读 skill 文件变成了 `└ Read …/skills/commit/SKILL.md`，
	// 而他预期的是 pi 原来的 `• [skill] commit (ctrl+o to expand)`。
	// 只豁免 SKILL.md（用户定的范围）—— `read docs` / `read resource` 仍照常折叠。
	reset();
	replay([
		{ type: "toolCall", id: "S1", name: "read", arguments: READ("/Users/bachi/.pi/agent/git/github.com/jayli/superpowers/skills/commit/SKILL.md") },
	]);
	const lines = renderBlock("read", "S1", READ("/Users/bachi/.pi/agent/git/github.com/jayli/superpowers/skills/commit/SKILL.md"));
	const joined = lines.join("\n");
	assert.ok(!joined.includes("Explored"), `SKILL.md 不得折成 Explored：${JSON.stringify(lines)}`);
	assert.ok(joined.includes("[skill]"), `应走 pi 的 [skill] 形态：${JSON.stringify(lines)}`);
	assert.ok(joined.includes("commit"), `标签应是所在目录名：${JSON.stringify(lines)}`);
});

test("回归：读 SKILL.md 既不断组也不入组，但要打断前后两个只读组", { skip }, () => {
	// SKILL.md 是「确定的不可折叠」（不是 pending），所以它像「跑测试」那个块一样：
	// 自己原样渲染 + 把上一组封口。读 skill 前后的探查不该被并成一组。
	reset();
	replay([
		{ type: "toolCall", id: "Z1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "Z2", name: "read", arguments: READ("/a/b/skills/x/SKILL.md") },
		{ type: "toolCall", id: "Z3", name: "bash", arguments: BASH("grep -n c f3.ts") },
	]);
	assert.equal(registry!.groupOf("Z2"), undefined, "SKILL.md 不得入组");
	assert.deepEqual(renderBlock("bash", "Z1", BASH("grep -n a f1.ts")), ["• Explored", '  └ Search "a" in f1.ts']);
	// Z3 在 SKILL.md **之后** → 必须另开一组（说明 Z2 真的断组了，而不是被跳过）
	assert.deepEqual(renderBlock("bash", "Z3", BASH("grep -n c f3.ts")), ["• Explored", '  └ Search "c" in f3.ts']);
});

test("标记：原生 read 的 `Read` 加粗，bash 转义的 Read 不加粗（只加粗动词，路径不加粗）", { skip }, () => {
	// 用户 2026-10-06 定：`cat f` 与原生 `read({path: f})` 短语一模一样，屏幕分不出 ——
	// 所以只有**原生 read 工具**那一行的 `Read` 加粗。
	// 只渲**原生 read** 组（家族规则保证同组内不可能混入 bash 转义的 Read）。
	reset();
	replay([
		{ type: "toolCall", id: "b1", name: "read", arguments: READ("/tmp/native.ts") },
		{ type: "toolCall", id: "b2", name: "read", arguments: READ("/tmp/native2.ts") },
	]);
	const nativeLines = renderBlockRaw("read", "b1", READ("/tmp/native.ts"));
	const nativeRow = nativeLines.find((l) => l.includes("native.ts"))!;
	assert.ok(readVerbIsBold(nativeRow), `原生 read 必须加粗：${JSON.stringify(nativeRow)}`);
	// **路径不能加粗**：`Read` 词后紧跟着粗体关闭序列（否则路径也被包进去了）
	const afterVerb = nativeRow.slice(nativeRow.indexOf("Read") + "Read".length);
	assert.ok(
		afterVerb.startsWith("\u001b[22m"),
		`粗体必须在 \`Read\` 之后立即关掉（路径不加粗）：${JSON.stringify(nativeRow)}`,
	);
	assert.ok(!afterVerb.includes("\u001b[1m"), `路径里不得再开粗体：${JSON.stringify(afterVerb)}`);

	// 同一个文件用 bash 的 `cat` 读 —— 形态一模一样，但 Read 不加粗。
	// 两边都只读**一个**文件，去掉颜色后才应是逐字相同的字符串。
	reset();
	replay([{ type: "toolCall", id: "b1", name: "read", arguments: READ("/tmp/native.ts") }]);
	const singleNativeRow = renderBlockRaw("read", "b1", READ("/tmp/native.ts")).find((l) => l.includes("native.ts"))!;
	reset();
	replay([{ type: "toolCall", id: "c1", name: "bash", arguments: BASH("cat /tmp/native.ts") }]);
	const bashLines = renderBlockRaw("bash", "c1", BASH("cat /tmp/native.ts"));
	const bashRow = bashLines.find((l) => l.includes("native.ts"))!;
	assert.ok(!readVerbIsBold(bashRow), `bash 转义的 Read 不得加粗：${JSON.stringify(bashRow)}`);
	// 两者去掉颜色后必须完全一致 —— 差别**只在**加粗这一个标记上
	assert.equal(plain(singleNativeRow).trim(), plain(bashRow).trim());
});

test("回归：长文件名折行时，续行不重画 Read（用户 2026-10-07 报，width=79 实测）", { skip }, () => {
	// 用户报的形态：bash 转义出的 `cat <长名>`，名字恰好一行装不下，于是屏幕上成了
	//
	//     └ Read pi-session-…-c7ec684628
	//       Read 7d.html                 ← 续行多了一个动词，看着像读了两个文件
	//
	// 根因在 `layoutRows`：`flatMap` 把每个条目的折行块卷平后**丢掉了「它属于哪个条目」**，
	// 于是续行与「下一个文件」在循环里长得一模一样，都拿到一行 `Read ` 前缀。
	// 修法：折行后保留「本块属于哪个条目、是不是该条目的开头」两个位。
	const NAME = "pi-session-2026-10-06T13-48-58-965Z_01a11179-84d5-77fd-bf01-c7ec6846287d.html";
	reset();
	const args = BASH(`cat ${NAME}`);
	replay([{ type: "toolCall", id: "n1", name: "bash", arguments: args }]);
	const lines = renderBlock("bash", "n1", args, false, 79);

	// 该行折了两行：组头 1 行 + 成员 2 行
	assert.equal(lines.length, 3, `应折成「组头 + 2 行成员」：${JSON.stringify(lines)}`);
	assert.ok(lines[1]!.startsWith("  └ Read "), `首行仍带 └ 与 Read：${JSON.stringify(lines[1])}`);
	// 续行必须**只有缩进**，不得再出现 `Read`；把它拼回去要恰好等于原文件名
	const body = lines.slice(1);
	assert.ok(!body[1]!.includes("Read"), `续行不得重画 Read：${JSON.stringify(body[1])}`);
	assert.equal(body[1]!.trim(), "7d.html", `续行只应是尾部：${JSON.stringify(body[1])}`);
	const rebuilt = body[0]!.replace("  └ Read ", "") + body[1]!.trim();
	assert.equal(rebuilt, NAME, `两行拼回必须等于原文件名：${JSON.stringify(rebuilt)}`);
});

test("回归：单文件折行后不得与后一个文件用 `, ` 缝在一起", { skip }, () => {
	// 同一根因的第二个症状（更难发现、也更错）：条目 A 的**尾部碎块**在下一轮循环里
	// 被当成了「另一个条目」，于是与真实的 b.ts 用 `, ` 拼成 `Read z, b.ts` ——
	// 屏幕上看起来像「读了两个文件」，实际上 A 的名字被切断、多出一个不存在的 `z`。
	// 实测：A 长 71（70 个 a + z）、宽度 79 时稳定复现。
	reset();
	const A = `${"a".repeat(70)}z`;
	const content = [
		{ type: "toolCall", id: "t1", name: "read", arguments: READ(A) },
		{ type: "toolCall", id: "t2", name: "read", arguments: READ("b.ts") },
	];
	replay(content);
	const lines = renderBlock("read", "t1", READ(A), false, 79);
	const body = lines.slice(1);
	assert.ok(!body.some((l) => /z, b\.ts/.test(l)), `A 的尾块不得与 b.ts 缝合：${JSON.stringify(body)}`);
	// A 的两块拼起来仍是 A（中间不插任何分隔符）
	const aLines = body.filter((l) => !l.includes("b.ts"));
	assert.equal(
		aLines.map((l) => l.replace(/^\s*(└ )?Read /, "").replace(/^\s+/, "")).join(""),
		A,
		`A 的折行碎块拼回应等于 A：${JSON.stringify(aLines)}`,
	);
});

test("标记：read 合并行折行时，续行的 Read 也跟着加粗", { skip }, () => {
	reset();
	const long = (n: string): string => `/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/a-very-long-file-name-${n}.ts`;
	replay([
		{ type: "toolCall", id: "l1", name: "read", arguments: READ(long("a")) },
		{ type: "toolCall", id: "l2", name: "read", arguments: READ(long("b")) },
		{ type: "toolCall", id: "l3", name: "read", arguments: READ(long("c")) },
	]);
	const lines = renderBlockRaw("read", "l1", READ(long("a")), 80);
	// 用 `plain` 过滤：原始行里 `Read` 后面紧跟粗体关闭序列，`includes("Read ")` 匹配不到
	const readRows = lines.filter((l) => plain(l).includes("Read "));
	assert.ok(readRows.length >= 2, `窄宽度下应折成多行：${JSON.stringify(lines.map(plain))}`);
	for (const row of readRows) {
		assert.ok(readVerbIsBold(row), `每一行的 Read 都要加粗：${JSON.stringify(plain(row))}`);
	}
});

test("合并：跨 assistant 消息的连续探查合为一块（用户 2026-10-06 第二轮定）", { skip }, () => {
	// 用户实测的观感问题：每条 assistant 消息开头都断一次，于是满屏都是一行的 Explored。
	// 现在只由旁白 / Thinking / 不可折叠工具 / 用户消息断开，**消息边界不断**。
	reset();
	replay([{ type: "toolCall", id: "m1", name: "bash", arguments: BASH("grep -n a f1.ts") }]);
	// 第二条 assistant 消息（中间没有旁白 / thinking）
	replay([
		{ type: "toolCall", id: "m2", name: "read", arguments: READ("/a/x.ts") },
		{ type: "toolCall", id: "m3", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.equal(registry!.groupOf("m2")?.leaderId, "m1", "跨消息不得断组");
	assert.equal(registry!.groupOf("m3")?.leaderId, "m1", "跨消息不得断组");
	assert.deepEqual(renderBlock("bash", "m1", BASH("grep -n a f1.ts")), [
		"• Explored",
		'  └ Search "a" in f1.ts',
		"    Read /a/x.ts",
		'    Search "b" in f2.ts',
	]);

	// 但消息里出现旁白就断（这条规则不变）
	reset();
	replay([{ type: "toolCall", id: "n1", name: "bash", arguments: BASH("grep -n a f1.ts") }]);
	replay([
		{ type: "text", text: "先看到这里。" },
		{ type: "toolCall", id: "n2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	assert.equal(registry!.groupOf("n2")?.leaderId, "n2", "旁白仍要断组");
});

test("回归：回放历史（resume / fork）也要断组，不得整段并成一块", { skip }, () => {
	// pi 重建历史时不发 `message_*`（`renderInitialMessages` 只构造组件就渲染），
	// 所以历史里的断组事件由 `index.ts` 的 `hydrateFromHistory` 重放 `buildContextEntries()` 补上。
	// 不补的话：因为消息边界不再断组，整个会话会并成一块 —— 实测最大 326 个成员、
	// 屏幕只显示 5 行，历史等于全丢（本轮实测 367 个会话里 319 个中招）。
	reset();
	// 直接重放「历史条目」的形态（与 hydrateFromHistory 同源：按序 replayMessage / noteUserMessage）
	const history = [
		{ type: "thinking", text: "a" },
		{ type: "toolCall", id: "H1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "H2", name: "read", arguments: READ("/a/one.ts") },
		// 下一条 assistant 消息：thinking 断组
		{ type: "thinking", text: "b" },
		{ type: "toolCall", id: "H3", name: "bash", arguments: BASH("grep -n b f2.ts") },
	];
	// 分成两条消息重放（历史的形态就是多条）
	replay(history.slice(0, 3));
	replay(history.slice(3));
	assert.equal(registry!.groupOf("H2")?.leaderId, "H1", "同一条消息里的 Search 与 Read 合一块");
	assert.equal(registry!.groupOf("H3")?.leaderId, "H3", "下一条消息的 thinking 必须断组（不得整段并一块）");
});

test("混来源：同一块里原生 Read 与 bash 转义 Read 分行，加粗只落在原生那行", { skip }, () => {
	// 2026-10-06 第二轮：分组不再按家族拆，所以「同组内 read 只可能同来源」不再成立 ——
	// 改由**行内按来源切段**来保住「加粗 = 原生工具」。
	reset();
	const content = [
		{ type: "toolCall", id: "c1", name: "bash", arguments: BASH("cat /a/first.ts") },
		{ type: "toolCall", id: "N1", name: "read", arguments: READ("/a/second.ts") },
		{ type: "toolCall", id: "N2", name: "read", arguments: READ("/a/third.ts") },
		{ type: "toolCall", id: "c2", name: "bash", arguments: BASH("cat /a/fourth.ts") },
	];
	replay(content);
	// 四条同组（不再被家族切开）
	for (const id of ["N1", "N2", "c2"]) {
		assert.equal(registry!.groupOf(id)?.leaderId, "c1", `${id} 应与 c1 同组`);
	}
	assert.deepEqual(renderBlock("bash", "c1", content[0]!.arguments), [
		"• Explored",
		"  └ Read /a/first.ts", // bash 转义：不加粗
		"    Read /a/second.ts, /a/third.ts", // 两个原生 read 合并
		"    Read /a/fourth.ts", // 又回到 bash：换行重新写动词
	]);
	// 加粗只落在原生那一行（第二行），bash 的两行都不加粗
	const lines = renderBlockRaw("bash", "c1", content[0]!.arguments);
	assert.equal(readVerbIsBold(lines[1]!), false, "第一行是 bash 转义，不该加粗");
	assert.equal(readVerbIsBold(lines[2]!), true, "第二行是原生 read，应加粗");
	assert.equal(readVerbIsBold(lines[3]!), false, "第三行又是 bash 转义，不该加粗");
});

test("家族已取消：原生 read 与 bash 转义 Read 现在同组（旧规则的反向断言）", { skip }, () => {
	// 旧实现里 familyOf 把两者拆成两组（2026-10-06 第四轮）；第二轮用户要求合并，
	// 所以这条改成反向断言 —— 若哪天有人再把家族规则加回来，这里会立刻变红。
	const B = (id: string, cmd: string) => ({ type: "toolCall", id, name: "bash", arguments: BASH(cmd) });
	reset();
	replay([
		{ type: "thinking", text: "x" },
		B("g1", "cd /tmp; git status"),
		B("l1", "cd /tmp; ls -t sessions/ | head -5"),
		B("r1", "cd /tmp; sed -n '1,60p' CHANGELOG.md"),
		{ type: "toolCall", id: "R1", name: "read", arguments: READ("/a/x.ts") },
		B("s2", "cd /tmp; grep -n c f2.ts"),
	]);
	for (const id of ["l1", "r1", "R1", "s2"]) {
		assert.equal(registry!.groupOf(id)?.leaderId, "g1", `${id} 应与 g1 同组（家族与类别都不再断组）`);
	}
});

test("状态：组头圆点按全组状态变色（跑=白，全 ok=绿，有错=红）", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "s1", name: "bash", arguments: BASH("grep -n a f1.ts") },
		{ type: "toolCall", id: "s2", name: "bash", arguments: BASH("grep -n b f2.ts") },
	]);
	// 用 pi-coder-1337：text=`#f8f8f2` 白、toolDiffAdded=`#8bc391` 绿、toolDiffRemoved=`#e27878` 红
	pi!.initTheme("pi-coder-1337", false);
	const WHITE = "\u001b[38;2;248;248;242m";
	const GREEN = "\u001b[38;2;139;195;145m";
	const RED = "\u001b[38;2;226;120;120m";
	const dotOf = (): string => {
		const component = new pi!.ToolExecutionComponent("bash", "s1", BASH("grep -n a f1.ts"), {}, definitionOf("bash"), { requestRender() {} }, CWD);
		component.markExecutionStarted();
		component.setArgsComplete?.();
		const line = component.render(100).find((l) => l.includes("\u2022")) ?? "";
		return line.slice(0, 22);
	};
	assert.ok(dotOf().startsWith(WHITE), `还有成员在跑 → 白，实际 ${JSON.stringify(dotOf())}`);
	registry!.setMemberStatus("s1", "ok");
	assert.ok(dotOf().startsWith(WHITE), `仍有一个在跑 → 还是白，实际 ${JSON.stringify(dotOf())}`);
	registry!.setMemberStatus("s2", "ok");
	assert.ok(dotOf().startsWith(GREEN), `全部成功 → 绿，实际 ${JSON.stringify(dotOf())}`);
	registry!.setMemberStatus("s2", "error");
	assert.ok(dotOf().startsWith(RED), `有错 → 红，实际 ${JSON.stringify(dotOf())}`);
});

test("行上限：超过 GROUP_MAX_ROWS 折成 `… +N`，展开态全出", { skip }, () => {
	reset();
	const content = Array.from({ length: 8 }, (_, i) => ({
		type: "toolCall",
		id: `c${i}`,
		name: "bash",
		// 每行一个独立 search，避免被 read 合并
		arguments: BASH(`grep -n needle${i} file${i}.ts`),
	}));
	replay(content);
	const collapsed = renderBlock("bash", "c0", content[0]!.arguments);
	assert.ok(collapsed.some((l) => /… \+\d+$/.test(l)), `应有折叠行：${JSON.stringify(collapsed)}`);
	const expanded = renderBlock("bash", "c0", content[0]!.arguments, true);
	assert.ok(!expanded.some((l) => /… \+\d+$/.test(l)), "展开态不该折");
	assert.ok(expanded.length > collapsed.length);
});

test("宽度：每行可见宽度不超过终端宽", { skip }, () => {
	reset();
	replay([
		{ type: "toolCall", id: "w1", name: "bash", arguments: BASH("grep -rn 'a-very-long-pattern-indeed-with-many-chars' some/deeply/nested/directory/path | head") },
		{ type: "toolCall", id: "w2", name: "read", arguments: READ("/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/registry.ts") },
		{ type: "toolCall", id: "w3", name: "read", arguments: READ("/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/render.ts") },
	]);
	for (const width of [40, 60, 80, 120]) {
		for (const line of renderBlock("bash", "w1", BASH("grep -rn x f | head"), false, width)) {
			const visible = [...line].length; // fixture 全 ASCII
			assert.ok(visible <= width, `width=${width} 超宽 ${visible}: ${JSON.stringify(line)}`);
		}
	}
});

test("展开态：成员各自显示内容（折叠态则隐身）", { skip }, () => {
	reset();
	// 原生 read 自成一组（家族规则），所以两个原生 read 才能同组
	replay([
		{ type: "toolCall", id: "x1", name: "read", arguments: READ("/tmp/leader.ts") },
		{ type: "toolCall", id: "x2", name: "read", arguments: READ("/tmp/a.ts") },
	]);
	// 结果必须真给：展开态放的正是「成员自己的内容」，没结果时它本来就是 0 行
	const result = { content: [{ type: "text", text: "line1\nline2\nline3" }], details: {} };
	const renderWith = (expanded: boolean): string[] => {
		const c = new pi!.ToolExecutionComponent("read", "x2", READ("/tmp/a.ts"), {}, definitionOf("read"), { requestRender() {} }, CWD);
		c.markExecutionStarted();
		c.setArgsComplete?.();
		c.setExpanded(expanded);
		c.updateResult(result, false);
		const lines = c.render(100).map(plain);
		if (lines[0] === "") lines.shift();
		return lines;
	};
	assert.equal(renderWith(false).length, 0, "折叠态成员必须隐身");
	const expanded = renderWith(true);
	assert.ok(expanded.some((l) => l.includes("line1")), `展开态必须能看到内容：${JSON.stringify(expanded)}`);
});

test("形态：└ 整块只出现一次，后续成员行四格缩进", { skip }, () => {
	// 用户 2026-10-06 第三轮定：树拐角只在第一行。后续成员行（以及 read 合并行的折行续行）
	// 一律四格缩进 —— 与 bash / codemode / web-search 结果树同一条语言。
	reset();
	replay([
		{ type: "thinking", text: "x" },
		{ type: "toolCall", id: "z1", name: "grep", arguments: { pattern: "alpha", path: "clients/pi" } },
		{ type: "toolCall", id: "z2", name: "ls", arguments: { path: "clients/pi/extensions" } },
	]);
	const lines = renderBlock("grep", "z1", { pattern: "alpha", path: "clients/pi" });
	assert.deepEqual(lines, [
		"• Explored",
		'  └ Search "alpha" in clients/pi',
		"    List clients/pi/extensions",
	]);
	// 首行 `└ ` 在列 2；续行是四格空格，正文（`List` 的 L）与首行正文同列（列 4）
	assert.equal(lines[1]!.indexOf("Search"), 4);
	assert.equal(lines[2]!.indexOf("List"), 4);
});

test("回归：read 合并行折行时续行不重画 └（但保留 Read 与行号）", { skip }, () => {
	// 折行的续行重画 `Read `（动词，不重画就成了光秃秃一串路径），但不重画 `└ `。
	// fixture 用长路径强制在窄宽度下折行（行号区间必须跟着各自那一段走）。
	reset();
	const a = "/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/very-long-name-a.ts";
	const b = "/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/very-long-name-b.ts";
	replay([
		{ type: "toolCall", id: "f1", name: "read", arguments: { path: a, offset: 100, limit: 70 } },
		{ type: "toolCall", id: "f2", name: "read", arguments: { path: b } },
	]);
	const lines = renderBlock("read", "f1", { path: a, offset: 100, limit: 70 }, false, 80);
	assert.equal(lines.filter((l) => l.includes("└ ")).length, 1, `└ 只该出现一次：${JSON.stringify(lines)}`);
	for (const line of lines.slice(2)) assert.ok(line.startsWith("    Read "), `续行应四格缩进且重画 Read：${JSON.stringify(line)}`);
	assert.ok(lines[1]!.includes("100-169"), `行号区间必须保留：${JSON.stringify(lines)}`);
});

test("颜色：Read 携带行号区间时，数字用 warning、中间的横线用前景色（用户 2026-10-07 定）", { skip }, () => {
	// 钉 pi-coder-1337 的真实字节。这条测试**故意**断言具体颜色值：判据本身就是「哪个槽位」，
	// 用宽松正则去「提取颜色」等于没测（memory「渲染测试别断言颜色值」的例外在这里是刻意的 ——
	// 那条约会的前提是「槽位不重要」，而这里槽位就是需求）。
	pi!.initTheme("pi-coder-1337", false);
	const WARN = "\u001b[38;2;253;176;130m"; // theme.fg("warning", …)
	const FG = "\u001b[38;2;248;248;242m"; // theme.fg("text", …) —— 主题的 `fg` 变量就是这个槽
	const OFF = "\u001b[39m";
	const p = "/Users/bachi/jaylli/litellm-any/a.ts";
	const span = (args: any): string => {
		reset();
		replay([{ type: "toolCall", id: "s1", name: "read", arguments: args }]);
		return renderBlockRaw("read", "s1", args).find((l) => l.includes("a.ts")) ?? "";
	};

	// ① offset+limit：`100`(warning) `-`(前景色) `169`(warning)
	assert.ok(
		span({ path: p, offset: 100, limit: 70 }).includes(` ${WARN}100${OFF}${FG}-${OFF}${WARN}169${OFF}`),
		`①② 应为 100(warning)-（前景）169(warning)：${JSON.stringify(span({ path: p, offset: 100, limit: 70 }))}`,
	);
	// ② 只给 offset：只有数字上色，不该凭空出现一条横线（也就不会有横线那份前景色）
	const onlyOffset = span({ path: p, offset: 100 });
	assert.ok(onlyOffset.includes(` ${WARN}100${OFF}`), `只给 offset 时应上色：${JSON.stringify(onlyOffset)}`);
	assert.ok(!onlyOffset.includes(FG), `只给 offset 时不该有横线：${JSON.stringify(onlyOffset)}`);
	// ③ 不带区间：整行不得出现 warning
	assert.ok(!span({ path: p }).includes(WARN), `无区间时不该上色：${JSON.stringify(span({ path: p }))}`);

	// ④ bash 转义出来的 Read（`sed -n '100,169p' f`）同样上色，但 `Read` 本身不加粗
	reset();
	const cmd = { command: `sed -n '100,169p' ${p}` };
	replay([{ type: "toolCall", id: "s2", name: "bash", arguments: cmd }]);
	const bashLine = renderBlockRaw("bash", "s2", cmd).find((l) => l.includes("a.ts")) ?? "";
	assert.ok(bashLine.includes(`${WARN}100${OFF}${FG}-${OFF}${WARN}169${OFF}`), `bash 的区间也要上色：${JSON.stringify(bashLine)}`);
	assert.ok(!readVerbIsBold(bashLine), `bash 的 Read 不加粗：${JSON.stringify(bashLine)}`);
});

test("颜色：折行不许把行号区间劈成两半（劈了就只剩半边颜色）", { skip }, () => {
	// 上色是靠在行尾认「空格 + 数字（-数字）」，而更早的 break-all 折行会在**字符级**断开 ——
	// 实测宽度 60 时 `…a.ts 100-169` 正好劈在数字中间，第二行成了 `Read -169`：
	// 区间没了（`-169` 单独毫无意义）颜色也只剩半边。区间是这一行唯一的结构化信息，
	// 折行时按整体处理：贴不上就整块另起一行。
	pi!.initTheme("pi-coder-1337", false);
	const WARN = "\u001b[38;2;253;176;130m";
	const FG = "\u001b[38;2;248;248;242m";
	const OFF = "\u001b[39m";
	reset();
	const args = {
		path: "/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/very-long-name-a.ts",
		offset: 100,
		limit: 70,
	};
	replay([{ type: "toolCall", id: "w1", name: "read", arguments: args }]);
	for (const width of [60, 50, 45]) {
		const lines = renderBlockRaw("read", "w1", args, width);
		const intact = lines.filter((l) => l.includes(`${WARN}100${OFF}${FG}-${OFF}${WARN}169${OFF}`));
		assert.equal(intact.length, 1, `width=${width} 时区间应完整出现在某一行且带色：${JSON.stringify(lines)}`);
		for (const line of lines) {
			const visible = [...plain(line)].length;
			assert.ok(visible <= width, `width=${width} 超宽 ${visible}：${JSON.stringify(plain(line))}`);
		}
	}
});

test("回归：只给 offset / 只给 limit 时行号也得看得见（对齐 pi 原生）", { skip }, () => {
	// 旧实现的条件是 `offset && limit`，于是只给一个参数时整段区间静默消失（用户 2026-10-06 报
	// 「行号信息似乎丢失了」）。真实语料里这两种形态都存在：全库 440 个会话统计
	// `offset+limit` 1176 次 / 只给 `offset` 40 次 / 只给 `limit` 90 次。
	const p = "/Users/bachi/jaylli/litellm-any/a.ts";
	const cases: Array<[any, string]> = [
		[{ path: p, offset: 100, limit: 70 }, " 100-169"],
		[{ path: p, offset: 100 }, " 100"],
		[{ path: p, limit: 45 }, " 1-45"],
		[{ path: p }, ""],
		[{ path: p, offset: 1, limit: 1 }, " 1-1"],
	];
	for (const [args, span] of cases) {
		reset();
		replay([{ type: "toolCall", id: "s", name: "read", arguments: args }]);
		const line = renderBlock("read", "s", args)[1]!;
		assert.equal(line, `  └ Read a.ts${span}`, JSON.stringify(args));
	}
});
