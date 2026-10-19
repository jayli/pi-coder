/**
 * skill-invocation-reorder 的装配验证：用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）
 * 真加载 `skill-invocation-reorder.ts`，然后拿 pi 导出的 `InteractiveMode` 驱动被打过补丁的
 * `addMessageToChat`，对**画进 chatContainer 的组件顺序与渲染出来的行**做断言。
 *
 *   node --test clients/pi/extensions/skill-invocation-reorder/skill-invocation-reorder.test.ts
 *
 * 本文件**必须**放在 `skill-invocation-reorder/` 子目录里（该目录没有 `index.ts`，pi 的加载器会整个跳过），
 * 不能放回 `extensions/` 顶层：pi 对顶层文件只看后缀 `.ts/.js`、不区分 `.test.`，README 的
 * `cp clients/pi/extensions/*.ts` 又是通配符 —— 顶层的测试会被拷进 `~/.pi/agent/extensions/`，
 * 启动时被当成扩展 import（测试当场跑一遍），因没有默认导出的工厂函数而报
 * `Extension does not export a valid factory function`，pi 直接 `exit(1)` 起不来（2026-10-17 踩过）。
 *
 * 为什么必须绕这一圈（不直接调扩展里的函数）：这个特性的全部价值就是「屏幕上两块东西谁先谁后」，
 * 而顺序是 `addMessageToChat` 往 `chatContainer` 里 addChild 的次序决定的。只测纯函数测不到：
 *   - 补丁有没有真的装到 pi 渲染用的那个 `InteractiveMode` 上（跨模块实例问题，见扩展文件头）；
 *   - 命中条件有没有写窄（普通用户消息 / assistant / bash 必须原样委托给原函数）；
 *   - 复刻 pi 原分支时有没有漏掉 `Spacer(1)` / `setExpanded(toolOutputExpanded)` / `populateHistory`；
 *   - pi 升级换了私有字段名时，退回原函数这条兜底有没有生效（而不是抛异常打死渲染 tick）。
 *
 * ## 关键手法：先换掉 `addMessageToChat`，再加载扩展
 *
 * 补丁在**模块求值时**捕获当时的 `prototype.addMessageToChat` 当 `original`。所以本文件在
 * `import` 完 pi 之后、加载扩展之前，先把原型上的这个方法换成一个**只记录调用**的桩 ——
 * 于是扩展捕获到的 `original` 就是这个桩，「有没有委托给 pi 原逻辑」变成可直接断言的
 * `originalCalls.length`，而不必去满足真 `addMessageToChat` 那一大票私有字段
 * （`getUserMessageText` / `AssistantMessageComponent` / `pendingTools` …）。
 * 顺序反了（先加载扩展再换桩）就测不到委托：扩展捕获的会是真函数。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skill-invocation-reorder.ts");
const PATCH_KEY = Symbol.for("pi-skill-invocation-reorder.patched");

// =============================================================================
// 找到本机 pi 的库入口（background-tasks/index.test.ts 同源）
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

/** 剥掉所有 ANSI / OSC 转义，只留可见文本。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{ extensions: unknown[]; errors: Array<{ path: string; error: string }> }>;
	createEventBus: () => unknown;
	initTheme: (name?: string) => void;
	parseSkillBlock: (text: string) => { name: string; location: string; content: string; userMessage?: string } | null;
	InteractiveMode: { prototype: Record<string | symbol, unknown> };
	/** 对照组用：pi 原版的 skill 折叠行组件（带 `customMessageBg` 底色）。 */
	SkillInvocationMessageComponent: new (skillBlock: unknown, markdownTheme?: unknown, outputPad?: number) => {
		setExpanded: (expanded: boolean) => void;
		setBgFn?: (fn?: (text: string) => string) => void;
		render: (width: number) => string[];
	};
	/** 展开态的 skill 正文走真 `Markdown` 渲染，它要一份真的 markdown 主题（`theme.bold` 等）。 */
	getMarkdownTheme: () => unknown;
}

const pi = piEntry === undefined ? undefined : ((await import(pathToFileURL(piEntry).href)) as unknown as PiApi);

// =============================================================================
// 先装「记录桩」，再加载扩展（顺序不能反，见文件头）
// =============================================================================

/** 委托给 pi 原逻辑的调用记录（每个用例开头清空）。 */
let originalCalls: unknown[][] = [];

if (pi) {
	const prototype = pi.InteractiveMode.prototype;
	assert.equal(typeof prototype.addMessageToChat, "function", "pi 应有 addMessageToChat（否则本测试无意义）");
	prototype.addMessageToChat = function (this: unknown, ...args: unknown[]) {
		originalCalls.push(args);
	};
}

/** 扩展加载只做一次（模块求值即装补丁；jiti 缓存下重复加载不会重新求值）。 */
let loadErrors: string[] | undefined;
let loadPromise: Promise<void> | undefined;

async function loadExtensionOnce(): Promise<void> {
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		assert.ok(pi, "pi 入口必须已找到");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-reorder-"));
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(root, "project");
		fs.mkdirSync(agentDir);
		fs.mkdirSync(projectDir);
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
		fs.rmSync(root, { recursive: true, force: true });
		loadErrors = loaded.errors.map((e) => e.error);
		pi.initTheme("dark");
	})();
	return loadPromise;
}

/** pi 的 `_expandSkillCommand` 产出的真实形状（`agent-session.js`）。 */
function skillWrappedText(name: string, location: string, body: string, userMessage: string): string {
	return `<skill name="${name}" location="${location}">\nReferences are relative to ${path.dirname(location)}.\n\n${body}\n</skill>\n\n${userMessage}`;
}

const SKILL_TEXT = skillWrappedText(
	"knowledge-distill",
	"/Users/example/workspace/.pi/skills/knowledge-distill/SKILL.md",
	"# 知识蒸馏\n\n把零散材料蒸馏成知识条目。",
	"蒸馏markdown",
);

/** 只有 skill 块、没跟提示词的形状（pi 的 `_expandSkillCommand` 在 args 为空时产出）。 */
const BARE_SKILL_TEXT = `<skill name="commit" location="/a/b/skills/commit/SKILL.md">\nReferences are relative to /a/b/skills/commit.\n\n# commit\n\n提交。\n</skill>`;

/**
 * 一个最小的 `InteractiveMode` 替身：只提供补丁会读的那几个成员。
 * 刻意**不**继承真类（真构造函数要整套 runtime），但字段名与 pi 的私有字段逐字对齐 ——
 * 字段名写错时补丁会走「退回原函数」那条兜底，`originalCalls` 就会多一条，顺序断言随之失败，
 * 所以这个替身同时也是对「兜底不会静默通过」的验证。
 *
 * `seeded` 决定 chatContainer 里是否已有内容 —— pi 原分支只在**非空**时才补前置 `Spacer(1)`。
 */
function fakeMode(overrides: Record<string, unknown> = {}, seeded = true) {
	const children: unknown[] = seeded ? [{ render: () => ["<已有内容>"] }] : [];
	const history: string[] = [];
	const self: Record<string, unknown> = {
		chatContainer: {
			children,
			addChild(component: unknown) {
				children.push(component);
			},
		},
		outputPad: 1,
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: () => pi!.getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		editor: { addToHistory: (text: string) => history.push(text) },
		...overrides,
	};
	return { self, children, history };
}

/** 调被打过补丁的 `addMessageToChat`。 */
function addMessage(harness: ReturnType<typeof fakeMode>, message: unknown, options?: unknown): void {
	originalCalls = [];
	const patched = pi!.InteractiveMode.prototype.addMessageToChat as (m: unknown, o?: unknown) => void;
	patched.call(harness.self, message, options);
}

/** 一个组件渲染出来的可见文本（拼成多行，便于 includes 断言）。 */
function rendered(component: unknown, width = 100): string {
	const lines = (component as { render: (w: number) => string[] }).render(width);
	return lines.map(plain).join("\n");
}

/**
 * 取本次画出来的两块：`[用户消息, skill 行]`。
 * 从**尾部**数，不写下标 —— seeded 的那块与前置 Spacer 都在前面，写死下标会随 `seeded` 偏移
 * （第一版就是这么错的：把用户消息当成 skill 行断言，折叠态那条于是「假通过」）。
 */
function drawnPair(harness: ReturnType<typeof fakeMode>): [string, string] {
	return [rendered(harness.children.at(-2)), rendered(harness.children.at(-1))];
}

const userMessage = { role: "user", content: [{ type: "text", text: SKILL_TEXT }] };

test("扩展通过 pi 的加载器无错加载，并把补丁装到 pi 渲染用的那个 InteractiveMode 上", { skip }, async () => {
	await loadExtensionOnce();
	assert.deepEqual(loadErrors, [], "加载器不该报错");
	assert.equal(pi!.InteractiveMode.prototype[PATCH_KEY], true, "补丁应已装在原型上");
	assert.equal(typeof pi!.InteractiveMode.prototype.addMessageToChat, "function");
});

test("skill + 提示词：用户消息在前、[skill] 折叠行在后，且不委托给 pi 原逻辑", { skip }, async () => {
	await loadExtensionOnce();
	const h = fakeMode();
	addMessage(h, userMessage);

	assert.equal(originalCalls.length, 0, "命中 skill 分支时不该委托给原函数");
	// seeded 那块 + 前置 Spacer(1) + 用户消息 + skill 行
	assert.equal(h.children.length, 4, `应画四块（原有 / Spacer / 用户消息 / skill 行）：${h.children.length}`);
	assert.equal(rendered(h.children[0]), "<已有内容>", "第 0 块是原有内容（Spacer 加在它后面）");
	assert.equal(rendered(h.children[1]), "", "第 1 块是前置 Spacer（空行）");

	const [userText, skillText] = drawnPair(h);
	assert.ok(
		userText.includes("/skill:knowledge-distill 蒸馏markdown"),
		`用户消息在前且是**完整命令**（含 /skill: 前缀）：${JSON.stringify(userText)}`,
	);
	assert.ok(!userText.includes("[skill]"), "用户消息里不该出现 skill 标签");
	assert.ok(!userText.includes("知识蒸馏"), "skill 正文不该混进用户消息");

	assert.match(skillText, /\[skill\] knowledge-distill/, `skill 折叠行在后：${JSON.stringify(skillText)}`);
	assert.match(skillText, /to expand\)/, "折叠行带展开提示");
	assert.ok(!skillText.includes("蒸馏markdown"), "提示词不该重复出现在 skill 行里");
});

test("chatContainer 为空时不补前置 Spacer（与 pi 原分支同一个条件）", { skip }, async () => {
	await loadExtensionOnce();
	const h = fakeMode({}, false);
	addMessage(h, userMessage);
	assert.equal(h.children.length, 2, `空容器只画两块（用户消息 / skill 行）：${h.children.length}`);
	assert.ok(rendered(h.children[0]).includes("/skill:knowledge-distill"), "第一块就是用户消息（完整命令）");

	const seeded = fakeMode();
	addMessage(seeded, userMessage);
	assert.equal(rendered(seeded.children[1]), "", "非空容器则补一条前置 Spacer（pi 原分支的条件）");
});

test("skill 行默认折叠，setExpanded 跟随 toolOutputExpanded（ctrl+o 全局展开仍生效）", { skip }, async () => {
	await loadExtensionOnce();

	const collapsed = fakeMode();
	addMessage(collapsed, userMessage);
	const [collapsedUser, collapsedSkill] = drawnPair(collapsed);
	assert.ok(!collapsedSkill.includes("知识蒸馏"), `默认折叠：正文不可见：${JSON.stringify(collapsedSkill)}`);
	assert.match(collapsedSkill, /to expand\)/, "折叠态带展开提示");
	assert.ok(collapsedUser.includes("/skill:knowledge-distill 蒸馏markdown"), "用户消息不受折叠影响");

	const expanded = fakeMode({ toolOutputExpanded: true });
	addMessage(expanded, userMessage);
	const [, expandedSkill] = drawnPair(expanded);
	assert.ok(expandedSkill.includes("知识蒸馏"), `展开态应画出正文：${JSON.stringify(expandedSkill)}`);
	assert.ok(expandedSkill.includes("knowledge-distill"), "展开态带 skill 名");
});

test("skill 行不带底色、不留尾部空行：首行留白（间隔）、末行是内容", { skip }, async () => {
	await loadExtensionOnce();

	const skillBlock = pi!.parseSkillBlock(SKILL_TEXT);
	assert.ok(skillBlock, "对照组用的 skill 块应能解析");

	// **对照组**：pi 原版组件（不调 `setBgFn`）必须**有**底色且**有**尾部空行，
	// 否则下面「没有」的断言是空转（可能只是主题本来就没给 `customMessageBg` 颜色）。
	for (const expanded of [false, true]) {
		const stock = new pi!.SkillInvocationMessageComponent(skillBlock, pi!.getMarkdownTheme(), 1);
		stock.setExpanded(expanded);
		const stockLines = stock.render(100);
		assert.ok(
			stockLines.some((line) => line.includes("\x1b[48")),
			`pi 原版应带底色（expanded=${expanded}）：${JSON.stringify(stockLines.map(plain))}`,
		);
		assert.equal(plain(stockLines[stockLines.length - 1]!).trim(), "", `pi 原版末行是下内边距空行（expanded=${expanded}）`);
	}

	for (const toolOutputExpanded of [false, true]) {
		const h = fakeMode({ toolOutputExpanded });
		addMessage(h, userMessage);
		const [, skillComponent] = h.children.slice(-2);
		const raw = (skillComponent as { render: (w: number) => string[] }).render(100);
		assert.ok(raw.length > 0, "skill 行应渲染出行来");
		for (const line of raw) {
			assert.ok(!line.includes("\x1b[48"), `不该有背景 SGR（expanded=${toolOutputExpanded}）：${JSON.stringify(line)}`);
		}
		// 上内边距行保留（用户消息框与 [skill] 之间的间隔），下内边距行被裁掉。
		assert.equal(plain(raw[0]!).trim(), "", `首行应是保留的上内边距空行（expanded=${toolOutputExpanded}）：${JSON.stringify(plain(raw[0]!))}`);
		assert.notEqual(plain(raw[raw.length - 1]!).trim(), "", `末行应是内容、不是空行（expanded=${toolOutputExpanded}）：${JSON.stringify(plain(raw[raw.length - 1]!))}`);
		const themed = rendered(skillComponent);
		// 内容仍在（去的是底色与尾部空行，不是内容）。注意两态的版式不同：折叠态 `[skill] name` 同行，
		// 展开态 pi 把 `[skill]` 标签与 `**name**` 标题画在**两行**上，所以只能分开断言。
		assert.ok(themed.includes("[skill]"), "标签仍在");
		assert.ok(themed.includes("knowledge-distill"), "skill 名仍在");
		if (toolOutputExpanded) assert.ok(themed.includes("知识蒸馏"), "展开态正文仍在");
	}
});

test("普通用户消息委托给 pi 原逻辑（补丁不自己画）", { skip }, async () => {
	await loadExtensionOnce();
	const h = fakeMode();
	addMessage(h, { role: "user", content: [{ type: "text", text: "就是随便说句话" }] });
	assert.equal(originalCalls.length, 1, "应委托给原函数");
	assert.equal(h.children.length, 1, "补丁自己不该画任何东西（只剩 seeded 那块）");
});

test("assistant / bash / custom 消息一律委托给原函数", { skip }, async () => {
	await loadExtensionOnce();
	for (const message of [
		{ role: "assistant", content: [{ type: "text", text: SKILL_TEXT }] },
		{ role: "bashExecution", command: "ls" },
		{ role: "custom", customType: "x", content: "y", display: true },
	]) {
		const h = fakeMode();
		addMessage(h, message);
		assert.equal(originalCalls.length, 1, `${(message as { role: string }).role} 应委托给原函数`);
		assert.equal(h.children.length, 1, "补丁不该画东西");
	}
});

test("只有 skill 块、没跟提示词时委托给原函数（顺序无从反转，交回 pi 原渲染）", { skip }, async () => {
	await loadExtensionOnce();
	assert.ok(pi!.parseSkillBlock(BARE_SKILL_TEXT), "这个形状 pi 自己认得（对照组）");
	assert.equal(pi!.parseSkillBlock(BARE_SKILL_TEXT)!.userMessage, undefined, "且没有 userMessage");
	const h = fakeMode();
	addMessage(h, { role: "user", content: [{ type: "text", text: BARE_SKILL_TEXT }] });
	assert.equal(originalCalls.length, 1, "没有 userMessage 时不该自己画");
	assert.equal(h.children.length, 1);
});

test("消息框内容是重建的完整命令，不是展开后剩下的那截提示词", { skip }, async () => {
	await loadExtensionOnce();
	const h = fakeMode();
	// 提示词里带 markdown 特殊字符与多行，重建后应原样保留（只多一个 `/skill:name ` 前缀）
	const text = skillWrappedText(
		"commit",
		"/a/b/skills/commit/SKILL.md",
		"# commit\n\n提交。",
		"把 `adapter/` 下的改动提交\n\n- 不要 push",
	);
	addMessage(h, { role: "user", content: [{ type: "text", text }] });
	const [userText] = drawnPair(h);
	assert.ok(userText.includes("/skill:commit 把"), `前缀 + 提示词首行：${JSON.stringify(userText)}`);
	assert.ok(userText.includes("不要 push"), "多行提示词的后半也在");
	assert.ok(!userText.includes("# commit"), "skill 正文不该出现在消息框里");
});

test("populateHistory 时把展开后的原文塞回编辑器历史（与 pi 原分支一致）", { skip }, async () => {
	await loadExtensionOnce();
	const h = fakeMode();
	addMessage(h, userMessage, { populateHistory: true });
	assert.deepEqual(h.history, [SKILL_TEXT], "历史里是**展开后的原文**（pi 原分支用的同一个 textContent）");

	const noHistory = fakeMode();
	addMessage(noHistory, userMessage);
	assert.deepEqual(noHistory.history, [], "没给 populateHistory 就不写");
});

test("pi 改了内部结构（私有字段缺失）时退回原函数，不抛异常也不画半截", { skip }, async () => {
	await loadExtensionOnce();
	for (const overrides of [
		{ chatContainer: undefined },
		{ outputPad: undefined },
		{ getMarkdownThemeWithSettings: undefined },
		{ getMarkdownTransformers: undefined },
	]) {
		const h = fakeMode(overrides);
		addMessage(h, userMessage);
		assert.equal(originalCalls.length, 1, `缺 ${Object.keys(overrides)[0]} 时应退回原函数`);
		assert.equal(h.children.length, 1, "退回时不该画半截");
	}
});

test("重复加载（/reload）不重复包一层：补丁幂等", { skip }, async () => {
	await loadExtensionOnce();
	const first = pi!.InteractiveMode.prototype.addMessageToChat;
	await loadExtensionOnce();
	assert.equal(pi!.InteractiveMode.prototype.addMessageToChat, first, "第二次加载不该再包一层");

	const h = fakeMode();
	addMessage(h, userMessage);
	assert.equal(h.children.length, 4, "幂等后仍只画四块（没有被包两次导致重复）");
});
