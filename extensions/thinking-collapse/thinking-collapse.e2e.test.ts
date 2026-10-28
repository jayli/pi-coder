/**
 * thinking 滚动窗口 + `/think-tail` 残影开关的**端到端**验证：用 pi 自己的扩展加载器真加载
 * `thinking-collapse.ts`，拿到它注册的 markdown transformer，再拿**真的 pi-tui `Markdown`
 * 组件**渲染出口文本。
 *
 * 为什么必须走到这一步：本特性的全部价值是「屏幕上长什么样」，而最容易出问题的地方
 * 恰恰在接线处 —— 夹进去的转义会不会被 pi 二次处理、`visibleWidth` 量得对不对、
 * 渲染后会不会超过预算被 pi 折成两行（本扩展的核心约束是出口恰好一行）。
 * 只测纯函数会漏掉这些。
 *
 *   node --test clients/pi/extensions/thinking-collapse/thinking-collapse.e2e.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, "..", "thinking-collapse.ts");

/**
 * 找本机 pi 的库入口。
 *
 * **顺序很重要**：先看 `PATH` 上的 `pi` shim —— 那才是用户真正在跑的副本（本机是
 * 1.1.0 的 bundle）。`~/.pi/agent/npm/` 下的那份是旧版本残留（0.87.1），它的 pi-tui
 * 没有 `okhslColor` / `foregroundAnsi`（本特性要用），拿它测会“颜色静默消失”而误判成 bug。
 * 这跟 background-tasks 的 findPiLibraryEntry 同一套做法。
 */
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

const cleanups: Array<() => void> = [];
test.after(() => {
	for (const fn of cleanups) fn();
});

interface TransformerLike {
	(markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }): string;
}

interface LoadedExtension {
	markdownTransformer?: TransformerLike;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>;
}

interface Harness {
	transform: TransformerLike;
	/** 跑一个命令（`/think-tail`）。 */
	command(args: string, name?: string): Promise<void>;
	startSession(): Promise<void>;
	/** 派发一个扩展事件（流式事件用这个驱动 `thinkingStreaming` 状态机）。 */
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	notifies: Array<{ text: string; level?: string }>;
	/** `/think-tail` 的配置文件。 */
	thinkTailFile: string;
}

async function loadHarness(
	options: {
		/** `/think-tail` 的初始状态（不传 = 不写配置文件 ⇒ 走默认 off）。 */
		thinkTail?: boolean;
		/** 预置的历史会话条目（恢复会话场景用）。 */
		history?: Array<Record<string, unknown>>;
		/** 覆盖 `PI_THINK_TAIL` 总闸（默认清掉）。 */
		thinkTailEnv?: string;
	} = {},
): Promise<Harness> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }>; runtime: Record<string, unknown> }>;
		createEventBus: () => unknown;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-thinking-e2e-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	cleanups.push(() => {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			// 清理失败不影响测试结论
		}
	});

	// 配置隔离：扩展在 session_start 时按 env 解析路径，所以 env 必须在加载前设好。
	const thinkTailFile = path.join(root, "think-tail.json");
	if (options.thinkTail !== undefined) fs.writeFileSync(thinkTailFile, JSON.stringify({ enabled: options.thinkTail }));
	const savedThinkTailConfig = process.env.PI_THINK_TAIL_CONFIG;
	const savedThinkTailState = process.env.PI_THINK_TAIL;
	process.env.PI_THINK_TAIL_CONFIG = thinkTailFile;
	if (options.thinkTailEnv === undefined) delete process.env.PI_THINK_TAIL;
	else process.env.PI_THINK_TAIL = options.thinkTailEnv;
	cleanups.push(() => {
		if (savedThinkTailConfig === undefined) delete process.env.PI_THINK_TAIL_CONFIG;
		else process.env.PI_THINK_TAIL_CONFIG = savedThinkTailConfig;
		if (savedThinkTailState === undefined) delete process.env.PI_THINK_TAIL;
		else process.env.PI_THINK_TAIL = savedThinkTailState;
	});

	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到 thinking-collapse 扩展");
	assert.ok(extension.markdownTransformer, "应该注册 markdown transformer");

	const notifies: Array<{ text: string; level?: string }> = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: projectDir,
		ui: { notify: (text: string, level?: string) => notifies.push({ text, level }) },
		sessionManager: {
			getEntries: () => [...(options.history ?? [])],
		},
	};

	return {
		transform: extension.markdownTransformer,
		command: async (args: string, name = "think-tail") => {
			const command = extension.commands.get(name);
			assert.ok(command, `应该注册 /${name} 命令`);
			await command.handler(args, ctx);
		},
		startSession: async () => {
			for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
		},
		emit: async (event, payload = {}) => {
			for (const handler of extension.handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
		},
		notifies,
		thinkTailFile,
	};
}

/**
 * 建 harness 并跑一遍 `session_start`。
 *
 * 真 pi 在会话开始/恢复时**总是**发 `session_start`，transform 则在那之后才被调 ——
 * 所以这里跟着走同一个次序，才能保证测的是真实生命周期。
 */
async function loadSession(
	options: {
		thinkTail?: boolean;
		history?: Array<Record<string, unknown>>;
		thinkTailEnv?: string;
	} = {},
): Promise<Harness> {
	const harness = await loadHarness(options);
	await harness.startSession();
	return harness;
}

const STREAMING = { messageType: "assistant-thinking", isStreaming: true, availableWidth: 60 };
const SETTLED = { messageType: "assistant-thinking", isStreaming: false, availableWidth: 60 };

/** 去掉所有 ANSI，拿回纯文本（与 pi-tui 的 visibleWidth 同口径地剥 CSI 序列）。 */
function plain(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * 从与 pi **同一安装**里取 pi-tui。
 *
 * 解析路径要从**真实包根**出发，不能从 `piEntry` 的字面路径出发：本机 pi 是 pnpm 全局装的，
 * shim 的 `cmd-shim-target` 指向 `~/Library/pnpm/global/<ver>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，
 * 而那个 `pi-coding-agent` 目录只是指向 pnpm store 的**符号链接**，`dist/bundle` 的旁边并没有
 * `node_modules`（pi 是 bundle 安装，pi-tui 被内嵌进 chunk，磁盘上不是它的依赖）。所以按
 * `piEntry/../node_modules/...` 拼出来的路径必然不存在 —— 这正是这个函数曾经静默走到
 * `~/.pi/agent/npm/` 那份旧残留、把「颜色消失」误判成 bug 的原因。
 *
 * 正确做法：先截出 `.../node_modules/@earendil-works/pi-coding-agent` 这一段包根，`realpathSync`
 * 解开符号链接，再从那儿的 `package.json` 起 `require.resolve("@earendil-works/pi-tui")`
 * （pnpm 会解析到 store 里的真身）；解析不出来就退到 realpath 后的**同级目录**
 * `@earendil-works/pi-tui/dist/index.js`。两者都拿的是与运行时 pi 同一版本的 pi-tui。
 */
async function loadTui(): Promise<{
	Markdown: new (
		text: string,
		padX: number,
		padY: number,
		theme: Record<string, unknown>,
		style: Record<string, unknown>,
		options: Record<string, unknown>,
	) => { render(width: number): string[] };
	visibleWidth: (text: string) => number;
}> {
	const { createRequire } = await import("node:module");
	const candidates: string[] = [];

	// 1) 从真实包根做 require.resolve（pnpm 符号链接下的唯一可靠途径）。
	const pkgMarker = `${path.sep}node_modules${path.sep}@earendil-works${path.sep}pi-coding-agent${path.sep}`;
	const markerAt = (piEntry as string).indexOf(pkgMarker);
	if (markerAt >= 0) {
		const pkgRoot = (piEntry as string).slice(0, markerAt + pkgMarker.length - 1);
		let realPkgRoot = pkgRoot;
		try {
			realPkgRoot = fs.realpathSync(pkgRoot);
		} catch {
			// 链接断了就用字面路径继续试
		}
		try {
			candidates.push(createRequire(path.join(realPkgRoot, "package.json")).resolve("@earendil-works/pi-tui"));
		} catch {
			// bundle 安装：这个包不是它的声明依赖，require.resolve 会失败 —— 改走同级目录
		}
		candidates.push(path.join(path.dirname(realPkgRoot), "pi-tui", "dist", "index.js"));
	}

	// 2) 兜底：piEntry 字面路径的旁边、以及 pi 自己装外部包的目录（版本可能更旧，排在最后）。
	candidates.push(
		path.join(path.dirname(piEntry as string), "..", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
		path.join(os.homedir(), ".pi/agent/npm/node_modules/@earendil-works/pi-tui/dist/index.js"),
	);

	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate) || !fs.existsSync(candidate)) continue;
		seen.add(candidate);
		const mod = (await import(pathToFileURL(candidate).href)) as Record<string, unknown>;
		// 版本对不上时（旧 pi-tui 没有色彩工具）宁可换下一份，除非已经没得选
		if (typeof mod.visibleWidth === "function" && typeof mod.Markdown === "function") return mod as never;
	}
	throw new Error(`找不到可用的 pi-tui：${[...seen].join(", ")}`);
}

const identity = (text: string) => text;
const MD_THEME = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: (text: string) => `\u001b[38;2;230;192;123m${text}\u001b[39m`,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	underline: identity,
	strikethrough: identity,
	highlightCode: (code: string) => code.split("\n"),
};

test("renders through pi-tui's real Markdown to exactly one line, and never wider than the budget", { skip }, async () => {
	const h = await loadSession({});
	const tui = await loadTui();

	const cases: Array<{ text: string; width: number }> = [
		{ text: "alpha beta gamma delta epsilon zeta eta theta", width: 40 },
		{ text: "中文思考内容每个字一个颜色一二三四五六七八九十", width: 30 },
		{ text: "mixed 中英 file 里的 `code span` tail", width: 36 },
		{ text: "x".repeat(300), width: 24 },
		{ text: "head `span` tail\n\n" + "再一段中文内容", width: 28 },
	];

	for (const { text, width } of cases) {
		// 走扩展的 transformer → 交给 pi-tui 的真 Markdown 组件渲染
		const transformed = h.transform(text, {
			messageType: "assistant-thinking",
			isStreaming: true,
			availableWidth: width - 2, // Markdown 组件左右各 1 列 padding
		});
		const component = new tui.Markdown(transformed, 1, 0, MD_THEME, { color: identity, italic: false }, {});
		const lines = component.render(width);
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		assert.equal(nonEmpty.length, 1, `出口必须恰好一行：${JSON.stringify(nonEmpty)}`);
		for (const line of lines) {
			assert.ok(
				tui.visibleWidth(line) <= width,
				`行宽 ${tui.visibleWidth(line)} 超过 ${width}：${JSON.stringify(plain(line))}`,
			);
		}
	}
});

/**
 * 右侧留白（用户 2026-10-27 定）：滚动行不顶格到右边界，屏幕上离右边框约 3 个英文字符。
 *
 * 这条用例走**真渲染**：`availableWidth = width - 2`（Markdown 组件左右各 1 列 padding），
 * 所以留白后的出口行在屏幕上应 ≤ `width - 2 - 3`。只看纯函数会漏掉接线问题（转义 / marked
 * 把行弄宽后又顶回去）—— 而本特性的全部价值就是屏幕上长什么样。
 */
test("the scrolling line stops three columns short of the right edge on screen", { skip }, async () => {
	const h = await loadSession({});
	const tui = await loadTui();

	for (const width of [80, 60, 40]) {
		const transformed = h.transform("x".repeat(400), {
			messageType: "assistant-thinking",
			isStreaming: true,
			availableWidth: width - 2,
		});
		const component = new tui.Markdown(transformed, 1, 0, MD_THEME, { color: identity, italic: false }, {});
		const lines = component.render(width);
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		assert.equal(nonEmpty.length, 1, `宽度 ${width} 下必须恰好一行：${JSON.stringify(nonEmpty.map(plain))}`);
		const rendered = tui.visibleWidth(nonEmpty[0].replace(/ +$/, ""));
		// 渲染行自带 Markdown 组件的 1 列左 padding；内容预算是 `width - 2 - 3`，
		// 所以可见宽度上限 = 1 + (width - 5) = width - 4（屏幕上离右边框 = 1 列组件 padding + 3 列留白）。
		assert.ok(
			rendered <= width - 4,
			`宽度 ${width} 下行宽 ${rendered} 顶到了右边界（应 ≤ ${width - 4}）：${JSON.stringify(plain(nonEmpty[0]))}`,
		);
	}
});

/**
 * 可见文字里出现了 CSI 参数残尾（如 `38;2;149;174;43m`）—— 那就是我们夹的 ANSI 转义被
 * marked 拆开了，转义的尾巴当成普通字显示出来。这种残尾既会弄脏文字，也会把行宽顶超
 * 预算（pi 于是二次折行）。只删 CSI 后再找 `\[[0-9;]*m?` 这种形状。
 */
function leakedEscapeResidue(rendered: string): string[] {
	const visible = plain(rendered);
	return visible.match(/\[?[0-9]{1,3}(;[0-9]{1,3})+m?/g) ?? [];
}

/**
 * 把一段带 ANSI 的文本里的 **所有** 终端转义剔干净（CSI 任意终止符 + OSC + APC）。
 *
 * 比文件头的 `plain()` 强：那个只剔 `m` 结尾的 SGR，而 pi 渲染链接时会发 OSC-8
 * （`\x1b]8;;url\x1b\\`）—— 不剔掉它，两边的可见文字就对不上。
 *
 * 用来算“基准渲染”：同一份文字但一条转义都没有时，marked 会把它渲染成什么样。
 */
function stripAllAnsi(text: string): string {
	return text
		.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\u001b[\]_][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

/** 渲染结果去转义 + 去 padding，拿到可与基准直接比的可见文字。 */
function visibleOf(lines: readonly string[]): string {
	return lines.map((line) => stripAllAnsi(line).replace(/ +$/, "").trim()).join("");
}

/**
 * 折行的真因（用户 2026-10-12 报的 bug，已用真实会话文本逐字复现）：
 *
 * pi 会把本扩展的出口文本再交给 marked 解析一次，而窗口夹在标签两边的斜体转义
 * `\x1b[23m` / `\x1b[3m` 对 marked 而言只是一串普通字符 —— 它的 email 自动链接规则
 * （`url` tokenizer 的 `[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+`）
 * 会把尾巴上的 `3m` 当成邮箱**用户名的一部分**吞进链接，转义于是被截成
 * `\x1b[` —— 没有终止字符 `m`，pi 的 `visibleWidth` 不认它，残尾就变成
 * 可见文字（屏幕上就是 `3mfoo@bar.com` 这种形状），行宽跟着超出预算，
 * pi 再折一次 —— 折出来的续行没有 `Think: ` 标签。
 *
 * 同类第二条路径（**至今仍然活在绝大多数情况下**）：正文里的 `](` 让 CSI 的 `[`
 * 变成 markdown 链接的左括号，`[3msee foo](bar)` 整个被当成链接，链接文字只剩 `3msee foo`。
 *
 * 两条路径的共同修法：把 `@` 与**窗口内未配对**的 `]` 转义成 `\@` / `\]`（marked 的 escape 规则会把
 * 反斜杠吃掉，渲染后逐字变回原样）。本用例钉住三个不变量：出口仍然恰好一行、无转义残尾、
 * 可见文字与“同一份文本不带任何 ANSI”的基准渲染逐字相同（后一条就是“转义对 markdown 必须透明”；
 * 刻意不拿原文比，因为像 `[0](x)` 这种**本来就是合法链接**的内容，marked 会渲染成 `0` ——
 * 那是内容驱动的行为，与本 bug 无关，带不带转义都一样）。
 */
test("an email-looking token after an ANSI escape does not wrap the line", { skip }, async () => {
	const h = await loadSession({});
	const tui = await loadTui();

	const cases: Array<{ text: string; width: number }> = [
		// 用户报的原句（取自 2026-10-12 真实会话的 thinking）
		{
			text:
				"The packages entry needs full dependency graph of pi-web-access@0.39.0 — same as 0.38.0 (same ranges). So: duplicate the entry.",
			width: 78,
		},
		// 最小复现：一个 email 形状的 token 就够
		{ text: "check pi-web-access@0.39.0 now", width: 40 },
		{ text: "mail foo@bar.com ok", width: 24 },
		// 同类第二路径：`]( ` 把 CSI 的 `[` 当成链接左括号
		{ text: "see foo](bar) and arr[0](x) here", width: 40 },
		{ text: "a [label](http://x.dev) b", width: 34 },
		// 带凭据的裸 URL：里面的 `@` 不转义（转了会渲染出多一个反斜杠的假 URL）
		{ text: "curl https://user:pass@localhost:8002/x now", width: 44 },
	];

	for (const { text, width } of cases) {
		const transformed = h.transform(text, {
			messageType: "assistant-thinking",
			isStreaming: true,
			availableWidth: width - 2,
		});
		const component = new tui.Markdown(transformed, 1, 0, MD_THEME, { color: identity, italic: false }, {});
		const lines = component.render(width);
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		const rendered = nonEmpty.join("");

		assert.deepEqual(
			leakedEscapeResidue(rendered),
			[],
			`ANSI 转义被 marked 拆开了（可见文字里出现 CSI 参数）：${JSON.stringify(stripAllAnsi(rendered))}`,
		);
		assert.equal(nonEmpty.length, 1, `出口必须恰好一行：${JSON.stringify(nonEmpty.map(plain))}`);
		for (const line of lines) {
			assert.ok(
				tui.visibleWidth(line) <= width,
				`行宽 ${tui.visibleWidth(line)} 超过 ${width}：${JSON.stringify(plain(line))}`,
			);
		}

		// 转义对 markdown 必须透明：可见文字等于“同一份文本不带任何 ANSI”的基准渲染
		const reference = visibleOf(
			new tui.Markdown(stripAllAnsi(transformed), 1, 0, MD_THEME, { color: identity, italic: false }, {})
				.render(width)
				.filter((line) => line.trim() !== ""),
		);
		assert.equal(
			visibleOf(nonEmpty),
			reference,
			`可见文字应与无色基准渲染逐字相同（原文：${JSON.stringify(text)}）`,
		);
		// 转义不得把反斜杠泄露成可见字符（marked 的 escape 规则应该把它吃掉）
		assert.ok(
			!visibleOf(nonEmpty).includes("\\"),
			`不该出现可见的反斜杠：${JSON.stringify(visibleOf(nonEmpty))}`,
		);
	}
});

// =============================================================================
// /think-tail：残影开关（thinking 定型后显示滚动残影 / 一行摘要）
// =============================================================================

/** 一段 thinking 走完的完整事件序列，返回值能控制段的时长。 */
async function runThinking(
	h: Harness,
	text: string,
	options: { settle?: boolean; durationMs?: number; contentIndex?: number } = {},
): Promise<void> {
	const contentIndex = options.contentIndex ?? 0;
	const chunks = splitHalf(text);
	await h.emit("message_start", { message: { role: "assistant", content: [] } });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex } });
	for (const chunk of chunks) {
		await h.emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: chunk },
		});
		// 真实时间流逝：段计时用的是 `Date.now()`，这里真等（毫秒级，不值当去 stub 时钟）
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	await h.emit("message_update", {
		assistantMessageEvent: { type: "thinking_end", contentIndex, content: text },
	});
	if (options.settle !== false) {
		await h.emit("message_end", {
			message: { role: "assistant", content: [{ type: "thinking", thinking: text }], durationMs: options.durationMs ?? 5_000 },
		});
	}
}

/** 把文本切成两三块（模拟流式增量），空串返回空数组。 */
function splitHalf(text: string): string[] {
	if (text === "") return [];
	const mid = Math.max(1, Math.floor(text.length / 2));
	return [text.slice(0, mid), text.slice(mid)].filter((part) => part !== "");
}

test("think-tail defaults to off: the settled line becomes a one-line Thought summary", { skip }, async () => {
	// 不传 thinkTail ⇒ 不写配置文件 ⇒ 走出厂默认
	const h = await loadSession({});
	await runThinking(h, "alpha beta gamma", { durationMs: 23_000 });
	const settled = h.transform("alpha beta gamma", SETTLED);
	const text = plain(settled);
	assert.match(text, /^Thought for \d+s \(\d+ tokens\)$/, `默认应不留残影：${JSON.stringify(text)}`);
	assert.equal(settled.includes("\n"), false, "默认形态必须恰好一行");
});

test("think-tail on keeps the rolling tail once settled", { skip }, async () => {
	const h = await loadSession({ thinkTail: true });
	await runThinking(h, "alpha beta gamma", { durationMs: 23_000 });
	assert.equal(plain(h.transform("alpha beta gamma", SETTLED)), "Think: alpha beta gamma", "on 时应保持残影形态");
});

test("think-tail off replaces the tail with a one-line Thought summary", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "alpha beta gamma", { durationMs: 23_000 });
	const settled = h.transform("alpha beta gamma", SETTLED);
	const text = plain(settled);
	assert.match(text, /^Thought for \d+s \(\d+ tokens\)$/, `应是单行摘要：${JSON.stringify(text)}`);
	assert.ok(!text.startsWith("Think: "), "不该再有 Think: 标签");
	assert.equal(settled.includes("\n"), false, "摘要必须恰好一行");
});

test("think-tail off leaves the streaming view untouched (still the rolling line)", { skip }, async () => {
	// 用户要的是「滚动不变，只是结束后不留残影」
	const h = await loadSession({ thinkTail: false });
	await h.emit("message_start", { message: { role: "assistant", content: [] } });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "滚动中" } });
	const streaming = h.transform("滚动中", STREAMING);
	assert.equal(plain(streaming), "Think: 滚动中", "流式期间必须还是滚动行");
});

test("think-tail off measures only the thinking span, not the whole response", { skip }, async () => {
	// 用户选的口径：`Thought for Ns` 只算 Think 段。`durationMs` 是整条响应（这里故意给很大），
	// live 路径必须用实测的段时长而不是它。
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "短思考", { durationMs: 600_000 });
	const text = plain(h.transform("短思考", SETTLED));
	assert.ok(!/Thought for (\d+)m/.test(text), `不该用整条响应的 10 分钟：${text}`);
	assert.match(text, /^Thought for \ds \(\d+ tokens\)$/, `应是实测的零秒级时长：${text}`);
});

test("think-tail off falls back to the rolling tail when the duration is unknown", { skip }, async () => {
	// 会话恢复前的历史消息 / 时钟异常：宁可保持残影，也不自造一个数字
	const h = await loadSession({ thinkTail: false });
	const settled = h.transform("从没见过的思考内容", SETTLED);
	assert.equal(plain(settled), "Think: 从没见过的思考内容");
});

test("think-tail off keeps the summary across the message_end re-render", { skip }, async () => {
	// pi 在 message_end 之后会再渲染一次（此时 isStreaming 已是 false），摘要必须还在
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "alpha beta", { durationMs: 9_000 });
	assert.match(plain(h.transform("alpha beta", SETTLED)), /^Thought for /);
	// 再渲染第二次（换宽度）也要稳定命中，不是一次性状态
	assert.match(plain(h.transform("alpha beta", { ...SETTLED, availableWidth: 100 })), /^Thought for /);
});

test("think-tail off swaps to the summary as soon as thinking ends (answer still streaming)", { skip }, async () => {
	// 用户 2026-10-26 选的口径：thinking 一结束就换，不等整条消息（正文还在流也无所谓）
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "alpha beta", { settle: false });
	const midStream = h.transform("alpha beta", STREAMING);
	assert.match(plain(midStream), /^Thought for \ds \(\d+ tokens\)$/, `thinking 结束就该换摘要：${JSON.stringify(plain(midStream))}`);
});

test("think-tail off reports the estimated token count of that thinking block", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	// 5 个汉字 = 5 token（宽字符每字 1 token，与 working-indicator 同口径）
	await runThinking(h, "中文五个字", { durationMs: 3_000 });
	assert.match(plain(h.transform("中文五个字", SETTLED)), /\(5 tokens\)$/);
	// ASCII 每 4 个 1 token：`abcdefgh` = 2
	await runThinking(h, "abcdefgh", { durationMs: 3_000 });
	assert.match(plain(h.transform("abcdefgh", SETTLED)), /\(2 tokens\)$/);
});

test("think-tail off honors the whitespace-normalized key (streaming vs rendered text)", { skip }, async () => {
	// 流式事件里攒的原文与渲染器拿到的 markdown 空白形态不同，键必须归一到同一口径
	const h = await loadSession({ thinkTail: false });
	await h.emit("message_start", { message: { role: "assistant", content: [] } });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "第一段\n\n第二段" } });
	await h.emit("message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "第一段\n\n第二段" } });
	await h.emit("message_end", {
		message: { role: "assistant", content: [{ type: "thinking", thinking: "第一段\n\n第二段" }], durationMs: 3_000 },
	});
	// 渲染器拿到的形态带前后空白
	assert.match(plain(h.transform("  第一段\n\n\n第二段  ", SETTLED)), /^Thought for /);
});

test("think-tail off does not show a summary for a message without thinking", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	await h.emit("message_start", { message: { role: "assistant", content: [] } });
	await h.emit("message_end", { message: { role: "assistant", content: [], durationMs: 4_000 } });
	// 没有 thinking 段时没有键可命中 ⇒ 退回原来那条滚动行逻辑（这里也没有 thinking 内容，
	// 所以是一行只有标签的空壳，肯定不是 Thought 摘要）
	assert.doesNotMatch(plain(h.transform("别的内容", SETTLED)), /^Thought for /);
});

test("think-tail off produces a line with no ANSI from the window", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "alpha beta gamma", { durationMs: 4_000 });
	const settled = h.transform("alpha beta gamma", SETTLED);
	const text = plain(settled);
	assert.match(text, /^Thought for /);
	assert.ok(!settled.includes("\u001b[3m") && !settled.includes("\u001b[23m"), "摘要行不夹斜体控制码（pi 自己给）");
});

test("think-tail off truncates instead of wrapping on a narrow terminal", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "alpha", { durationMs: 3_600_000 });
	const out = h.transform("alpha", { ...SETTLED, availableWidth: 18 });
	assert.equal(out.includes("\n"), false, "仍然恰好一行");
	assert.ok(out.endsWith("…"), `窄终端从尾部截断：${JSON.stringify(out)}`);
	assert.ok(out.startsWith("Thought for"), `头部优先保留：${JSON.stringify(out)}`);
});

test("/think-tail on|off persists to think-tail.json and takes effect without reload", { skip }, async () => {
	// 初始态显式给 on（出厂默认已是 off，不写配置就拿不到残影作对照）
	const h = await loadSession({ thinkTail: true });
	await runThinking(h, "alpha beta", { durationMs: 7_000 });
	assert.equal(plain(h.transform("alpha beta", SETTLED)), "Think: alpha beta", "初始是残影");

	await h.command("off", "think-tail");
	assert.match(plain(h.transform("alpha beta", SETTLED)), /^Thought for /, "关掉后立刻变摘要");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.thinkTailFile, "utf8")), { enabled: false }, "关要落盘");

	await h.command("on", "think-tail");
	assert.equal(plain(h.transform("alpha beta", SETTLED)), "Think: alpha beta", "开回来立刻恢复残影");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.thinkTailFile, "utf8")), { enabled: true }, "开也要落盘");

	// 无参数 / status 只报状态，不改状态
	await h.command("", "think-tail");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.thinkTailFile, "utf8")), { enabled: true });
	assert.equal(h.notifies.at(-1)?.text?.includes("on"), true, "应提示当前为开");
});

test("/think-tail rejects an unknown argument and keeps the state", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	await h.command("maybe", "think-tail");
	assert.deepEqual(JSON.parse(fs.readFileSync(h.thinkTailFile, "utf8")), { enabled: false }, "状态不该被改");
	assert.equal(h.notifies.at(-1)?.level, "warning");
});

test("PI_THINK_TAIL=off matches the factory default and the command still works", { skip }, async () => {
	// 总闸现在只是把已经是 off 的初始值再钉一遍；命令照旧能开回来
	const h = await loadSession({ thinkTailEnv: "off" });
	await runThinking(h, "alpha", { durationMs: 2_000 });
	assert.match(plain(h.transform("alpha", SETTLED)), /^Thought for /, "总闸应保持关掉残影");
	await h.command("on", "think-tail");
	assert.equal(plain(h.transform("alpha", SETTLED)), "Think: alpha", "命令仍能开回来");
});

test("restored sessions hydrate durations from session history", { skip }, async () => {
	// 恢复会话：没有流式事件，只能靠 sessionManager 里的历史条目预填
	const history = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "历史里的思考" }],
				durationMs: 42_000,
			},
		},
	];
	const h = await loadSession({ thinkTail: false, history });
	const text = plain(h.transform("历史里的思考", SETTLED));
	assert.equal(text, "Thought for 42s (6 tokens)", `应从历史预填秒数：${JSON.stringify(text)}`);
});

test("restored sessions without durationMs keep the rolling tail", { skip }, async () => {
	const history = [
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "没有时长" }] } },
	];
	const h = await loadSession({ thinkTail: false, history });
	assert.equal(plain(h.transform("没有时长", SETTLED)), "Think: 没有时长");
});

test("the Thought summary renders through pi-tui's Markdown as exactly one line", { skip }, async () => {
	const h = await loadSession({ thinkTail: false });
	await runThinking(h, "alpha beta gamma", { durationMs: 23_000 });
	const tui = await loadTui();
	for (const width of [40, 24, 18]) {
		const transformed = h.transform("alpha beta gamma", {
			messageType: "assistant-thinking",
			isStreaming: false,
			availableWidth: width - 2,
		});
		const component = new tui.Markdown(transformed, 1, 0, MD_THEME, { color: identity, italic: true }, {});
		const lines = component.render(width);
		const nonEmpty = lines.filter((line) => line.trim() !== "");
		assert.equal(nonEmpty.length, 1, `宽度 ${width} 下必须恰好一行：${JSON.stringify(nonEmpty.map(plain))}`);
		for (const line of lines) {
			assert.ok(tui.visibleWidth(line) <= width, `宽度 ${width} 下超宽：${JSON.stringify(plain(line))}`);
		}
	}
});
