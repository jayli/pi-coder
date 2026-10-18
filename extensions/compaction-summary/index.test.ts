/**
 * compaction-summary 的装配验证：用 pi 自己的扩展加载器（`discoverAndLoadExtensions`）真加载
 * `index.ts`，再用 pi 导出的 `CompactionSummaryMessageComponent` 渲染，对**真正画出来的行**做断言。
 *
 *   node --test clients/pi/extensions/compaction-summary/index.test.ts
 *
 * 为什么非得走真加载器（与 `user-message-bar/index.test.ts` 同一个理由）：这个特性的全部价值是
 * 「补丁有没有落在 pi 渲染时用的那个类上」。`pi` 命令跑的是 bundle 形态，扩展 import 到的是加载器
 * virtualModules 给的那一份 —— 只有真过一遍加载器 + pi 自己的组件，才能证明这两者是同一个类。
 *
 * 断言口径（与 pi 原版逐项对照，比"看起来对不对"硬）：
 *   - **对照组**：未装补丁前 pi 原版必须**有**底色、上下各有内边距行 —— 否则「没有」的断言是空转；
 *   - 上色后：没有 `\x1b[48;…m` 背景序列、首行就是 `[compaction]`、末行就是正文；
 *   - 正文行首是 `✔ `，且**每一行可见宽度与 pi 原版完全一致**（pi-tui 对超宽行直接抛错）；
 *   - `[compaction]` 标签那一行**整行原样**（颜色 / 加粗 / 内边距都不动）；
 *   - 展开态（ctrl+o）能画出版式正文，且段落空行保留；
 *   - 旧 ctx 已作废 / 未拿到皮肤时：形态裁剪照做，但不画 `✔`，也不抛异常。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

/** pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。 */
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

/** 可见列数（fixture 里只有 ASCII 与 `✔`，长度即列数）。 */
const width = (line: string): number => plain(line).length;

const MARK = "\u2714";

interface CompactionComponent {
	setExpanded: (expanded: boolean) => void;
	render: (width: number) => string[];
}

interface PiApi {
	discoverAndLoadExtensions: (
		paths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{ extensions: Array<{ handlers: Map<string, Array<(e: unknown, c: unknown) => unknown>> }>; errors: Array<{ path: string; error: string }> }>;
	createEventBus: () => unknown;
	initTheme: (name?: string) => void;
	getMarkdownTheme: () => unknown;
	CompactionSummaryMessageComponent: new (message: unknown, markdownTheme?: unknown, outputPad?: number) => CompactionComponent;
}

const pi = piEntry === undefined ? undefined : ((await import(pathToFileURL(piEntry).href)) as unknown as PiApi);

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compaction-summary-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	return { agentDir, projectDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function loadExtension(): Promise<{ handlers: Map<string, Array<(e: unknown, c: unknown) => unknown>> }> {
	const workspace = makeWorkspace();
	try {
		const loaded = await pi!.discoverAndLoadExtensions([EXTENSION_PATH], workspace.projectDir, workspace.agentDir, pi!.createEventBus());
		assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
		const extension = loaded.extensions[0];
		assert.ok(extension, "应该加载到 compaction-summary 扩展");
		return extension;
	} finally {
		workspace.cleanup();
	}
}

/** 注入给扩展的 `ctx.ui.theme`：只有 `fg` 的假皮肤（`toolDiffAdded` 认，其余抛）。 */
const THEME = {
	fg: (slot: string, text: string): string => {
		if (slot === "toolDiffAdded") return `\u001b[38;2;137;184;194m${text}\u001b[39m`;
		throw new Error(`Unknown theme color: ${slot}`);
	},
};

/** pi 作废旧 ctx 时抛的那一句（`ExtensionRunner.assertActive()`）。 */
const STALE_CTX = "This extension ctx is stale after session replacement or reload.";

const MESSAGE = { role: "compactionSummary", tokensBefore: 208359, summary: "# Summary\n\nfirst para\n\nsecond para" };

/** 用 pi 自己的组件渲染一条压缩摘要。 */
function renderCompaction(expanded: boolean, width: number): string[] {
	assert.ok(pi);
	const component = new pi.CompactionSummaryMessageComponent(MESSAGE, pi.getMarkdownTheme(), 1);
	component.setExpanded(expanded);
	return component.render(width);
}

/** 未装补丁的**对照组**：清掉原型上的补丁再渲染（补丁是进程级的，所以要显式摘）。 */
function renderStockCompaction(expanded: boolean, width: number): string[] {
	assert.ok(pi);
	const prototype = pi.CompactionSummaryMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
	const key = Object.getOwnPropertySymbols(prototype).find((symbol) => symbol.description === "pi-compaction-summary.state");
	assert.ok(key, "补丁状态应挂在原型上（Symbol.for 的 description）");
	const patched = prototype.render;
	// 临时把 render 换回「只跑 pi 原版逻辑」的那一层：补丁包着的 original 就是它
	const state = prototype[key] as { theme: () => unknown };
	assert.ok(state);
	// 直接用 pi 原版的行：`restyleCompaction` 拿到的就是这些，所以等价于把补丁拆掉再看
	const raw = renderWithOriginal(expanded, width);
	prototype.render = patched;
	return raw;
}

/**
 * pi 原版的行（不经任何后处理）。
 *
 * 补丁包里没有把 `original` 暴露出来，所以这里直接把原型上的 `render` 摘掉一次、渲染、再装回去 ——
 * 比在补丁里加一个仅供测试的出口干净。摘的过程中不会有第二帧渲染（单线程、同步）。
 */
function renderWithOriginal(expanded: boolean, width: number): string[] {
	assert.ok(pi);
	const prototype = pi.CompactionSummaryMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
	const key = Object.getOwnPropertySymbols(prototype).find((symbol) => symbol.description === "pi-compaction-summary.state");
	const patched = prototype.render;
	const hidden = originalUnderPatch as ((this: unknown, w: number) => string[]) | undefined;
	assert.ok(hidden, "测试应已记录 pi 原版 render");
	const previous = prototype.render;
	prototype.render = hidden;
	try {
		return renderCompaction(expanded, width);
	} finally {
		prototype.render = previous;
		void patched;
	}
}

/** 加载扩展前记录 pi 原版 `render`（补丁会把它包起来）。 */
let originalUnderPatch: unknown;
if (pi) {
	pi.initTheme("pi-coder-1337");
	originalUnderPatch = pi.CompactionSummaryMessageComponent.prototype.render;
}

test("扩展能被 pi 的加载器加载，并注册 session_start / session_shutdown", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	assert.equal(extension.handlers.get("session_start")?.length, 1);
	assert.equal(extension.handlers.get("session_shutdown")?.length, 1);
});

test("对照组（pi 原版）：有底色、上下各有内边距行 —— 「没有」的断言才不是空转", { skip, timeout: 30_000 }, async () => {
	const stock = renderStockCompaction(false, 60);
	assert.ok(stock.length >= 5, `pi 原版应有内边距行 + 标签 + 间隔 + 正文：${JSON.stringify(stock.map(plain))}`);
	assert.ok(
		stock.some((line) => line.includes("\u001b[48")),
		`pi 原版应带 customMessageBg 底色：${JSON.stringify(stock.map(plain))}`,
	);
	assert.equal(plain(stock[0]!).trim(), "", "首行是上内边距空行");
	assert.equal(plain(stock[1]!).trim(), "[compaction]", "第二行才是标签");
	assert.equal(plain(stock.at(-1)!).trim(), "", "末行是下内边距空行");
});

test("拿到皮肤后：两行 —— `[compaction]` 与带 ✔ 的正文；无底色、无空行、宽度不变", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, { ui: { theme: THEME } });
	}

	const stock = renderStockCompaction(false, 60);
	const out = renderCompaction(false, 60);

	assert.equal(out.length, 2, `折叠态应为两行：${JSON.stringify(out.map(plain))}`);
	assert.equal(plain(out[0]!).trim(), "[compaction]", "首行就是标签（上内边距行已去掉）");
	assert.equal(
		plain(out[1]!).trimStart().startsWith(`${MARK} Compacted from 208,359 tokens (`),
		true,
		`正文行首是 ✔：${JSON.stringify(plain(out[1]!))}`,
	);
	assert.ok(!out.join("\n").includes("\u001b[48"), "不该再有背景 SGR（底色已去）");
	assert.equal(plain(out[1]!).trimEnd().endsWith("to expand)"), true, "折叠态的展开提示仍在");
	// 标签行与 pi 原版那一行**除背景序列外逐字相同**（颜色 / 加粗 / 内边距都没动）
	assert.equal(out[0], stock[1]!.replace(/\u001b\[48;[0-9;]*m/g, "").replace(/\u001b\[49m/g, ""), "标签行原样（只去掉底色）");
	// 每一行可见宽度与各自的原版行一致（60 列）
	for (const line of out) assert.equal(width(line), 60, `每行仍 60 列：${JSON.stringify(plain(line))}`);
});

test("展开态（ctrl+o）：正文照常画，段落空行保留，仍无底色无上下空行", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, { ui: { theme: THEME } });
	}
	const out = renderCompaction(true, 60);
	const text = out.map(plain).join("\n");

	assert.ok(text.includes("first para"), "展开态画出摘要正文");
	assert.ok(text.includes("second para"), "第二段也在");
	assert.equal(plain(out[0]!).trim(), "[compaction]", "首行仍是标签");
	assert.ok(plain(out[1]!).trimStart().startsWith(`${MARK} Compacted from`), "第二行是带 ✔ 的 Compacted 行");
	assert.equal(plain(out.at(-1)!).trim(), "second para", "末行是正文，不是内边距空行");
	assert.ok(!out.join("\n").includes("\u001b[48"), "展开态也不该有底色");
	// 版式：标签 / ✔Compacted / 空 / Summary / 空 / first para / 空 / second para —— 3 处段落空行全保留
	assert.equal(text.split("\n").filter((line) => line.trim() === "").length, 3, "正文自己的段落空行保留，只去掉首尾两条");
});

test("`✔` 走皮肤的 toolDiffAdded（正向绿）", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, { ui: { theme: THEME } });
	}
	const out = renderCompaction(false, 60);
	assert.ok(
		out[1]!.includes("\u001b[38;2;137;184;194m\u2714"),
		`✔ 用 toolDiffAdded 的色：${JSON.stringify(out[1]!)}`,
	);
});

test("会话替换窗口内（旧 ctx 已作废）渲染不抛，只是没有 ✔", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	const staleCtx = new Proxy(
		{},
		{
			get() {
				throw new Error(STALE_CTX);
			},
		},
	);
	for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, staleCtx);

	const out = renderCompaction(false, 60); // 以前这里会抛 → 直达 pi 的 uncaughtException
	assert.equal(out.length, 2, "形态仍然是对的");
	assert.ok(!plain(out[1]!).includes(MARK), "读不到皮肤就不画 ✔");
});

test("session_shutdown 之后不再画 ✔（取色源已复位）", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, { ui: { theme: THEME } });
	}
	assert.ok(plain(renderCompaction(false, 60)[1]!).includes(MARK), "换之前有 ✔");

	for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, undefined);
	const out = renderCompaction(false, 60);
	assert.ok(!plain(out[1]!).includes(MARK), "shutdown 之后不画 ✔");
	assert.equal(out.length, 2, "形态裁剪照旧生效");
});

test("窄终端（30 列）：正文折行后仍是 ≤30 列，首行标签、✔ 只在第一行", { skip, timeout: 30_000 }, async () => {
	const extension = await loadExtension();
	for (const handler of extension.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start" }, { ui: { theme: THEME } });
	}
	const out = renderCompaction(false, 30);
	assert.equal(plain(out[0]!).trim(), "[compaction]");
	assert.ok(plain(out[1]!).includes(MARK), "第一行正文带 ✔");
	assert.equal(out.filter((line) => plain(line).includes(MARK)).length, 1, "折出来的续行不再重复 ✔");
	for (const line of out) assert.equal(width(line) <= 30, true, `不超过 30 列：${JSON.stringify(plain(line))}`);
});
