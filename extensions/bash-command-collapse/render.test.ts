/**
 * Tests for the bash block shape (bash-command-collapse.ts) — 端到端：pi 自己的扩展加载器真的加载
 * 本扩展，再用 pi 自己的 `ToolExecutionComponent` 渲染真实的 bash 块，对渲染出来的**行**做断言。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/render.test.ts
 *
 * 为什么必须绕这一圈（不直接调扩展里的内部函数）：这个特性的**全部**价值在于“用户屏幕上长什么样”，
 * 而屏幕上的行是 `ToolExecutionComponent` → `renderCall` / `renderResult` → Box → pi-tui 折行
 * 一层层叠出来的。只测内部函数会漏掉实测踩过的那些问题：`└ ` 逐 child 画会出现两个、续行前缀
 * 挂错导致正文列跑偏、超宽行被 pi-tui 的渲染截掉、`state.resultSeen` 没让前缀从缩切换成 `│`。
 *
 * 断言口径（用户 2026-09-21 定的形状）：
 *   - 命令首行 `• Run `（圆点按状态变色，见下）；最多 2 个视觉行；第 2 行末尾溢出换 `…`；
 *     更长时第 2 行下面一行 `… +N lines`；
 *   - 命令续行 / `… +N lines` 起始列 == `Run ` 的 `n` 列（第 3 列）：执行中是两格缩进，执行完是 `│ `；
 *   - 状态圆点 `•`（U+2022）**只挂在命令首行**（续行、`… +N lines`、整棵结果树前面都没有），
 *     颜色：执行中 `dim`、成功 `toolDiffAdded`、失败 `toolDiffRemoved`；
 *   - 正文整体右移一格（`• Run …`）：`Run` / `│` / `└` 同在列 2、所有正文同在列 4，
 *     命令行与结果树因此不会错开（用户 2026-09-21 第二轮定的）；
 *   - 整块**没有任何底色**（pending / 成功 / 失败三种底都不画），且**其他工具的底色不受影响**；
 *   - 染色块**上下都没有空行**（命令就是块的第一行、结果就是最后一行）；
 *   - `└ ` 在**整块结果里恰好出现一次**，就在第一行实质输出上（截断提示行不算）；
 *   - 第一行实质输出之后的内容行不带竖线、也不带拐角符，只有两格缩进；
 *   - 没有输出时显示 `(no output)`，`└ ` 挂在它前面；
 *   - 每一行的可见宽度 <= 终端宽度（pi-tui 对超宽行会截断，多一格就丢内容）。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bash-command-collapse.ts");
/** 树形竖线行（`│ `）：命令续行、截断提示、以及 `└ ` 之上的所有行。 */
const PIPE = "\u2502";
/** 状态圆点 `•`（U+2022）：只挂在命令首行行首。 */
const BAR = "\u2022";
/** `…`（U+2026）：单独提出来只是为了让断言读起来清楚。 */
const ELLIPSIS_PLAIN = "\u2026";
/** 默认皮肤（dark）里三个状态槽的**真彩色**——圆点的颜色断言直接盯这三个值。 */
const DIM_ANSI = "\u001b[38;2;102;102;102m"; // dim       `#666666`
const ADDED_ANSI = "\u001b[38;2;181;189;104m"; // toolDiffAdded  `#b5bd68`
const REMOVED_ANSI = "\u001b[38;2;204;102;102m"; // toolDiffRemoved `#cc6666`
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
 *
 * 先从 `pi` 可执行文件反查**真正的安装位置**（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 判定方式是**能不能真 import**，不是路径存不存在
 *（那份副本可能是被剪掉同伴包的空壳）。全都不行就返回 undefined，整体 skip。
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

/**
 * pi 自带的 chalk 在**模块求值时**就定好「要不要输出样式」（非 TTY 下默认关掉），而
 * `theme.bold()` 就是它 —— 所以只有「加粗 / 颜色」那几个断言需要这个环境变量，且**必须
 * 在 import pi 之前**设。不设的话那些断言看到的全是不带 SGR 的裸文本，永远“通过”。
 * 只影响本测试进程，且尊重用户已有的 NO_COLOR。
 */
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) process.env.FORCE_COLOR = "3";

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

/**
 * 本进程能不能再套一层 `sandbox-exec`。
 *
 * seatbelt **不允许嵌套**：如果跑测试的 shell 自己就在沙箱里（比如在开了
 * `PI_SANDBOX` 的 pi 会话里跑 `node --test`），内层的 `sandbox_apply` 会直接
 * `Operation not permitted`（退出码 71）。这是环境条件而不是代码回归，
 * 所以真沙箱用例在这种情况下整体 skip（不假装通过，也不报一堆看不懂的错）。
 * 在普通终端里跑（没有外层沙箱）时它是 true，用例全部真跑。
 */
const NESTED_SKIP = "嵌套 sandbox-exec 不可用（本进程已在沙箱里），真沙箱用例跳过";
const nestedSandboxOk = (() => {
	if (piEntry === undefined) return false;
	try {
		execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/echo", "ok"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
})();
/** 真沙箱用例的 skip 值：平台不支持 / 找不到 pi / 嵌套不可用，三种情况都跳。 */
const sandboxSkip = skip !== false ? skip : nestedSandboxOk ? false : NESTED_SKIP;

interface BashToolDefinitionLike {
	renderShell?: string;
	renderCall?: (...args: any[]) => any;
	renderResult?: (...args: any[]) => any;
	execute?: (
		toolCallId: string,
		params: { command: string; timeout?: number },
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

interface PiApi {
	discoverAndLoadExtensions: (
		configuredPaths: string[],
		cwd: string,
		agentDir?: string,
		eventBus?: unknown,
	) => Promise<{
		extensions: Array<{ tools: Map<string, { definition: BashToolDefinitionLike }> }>;
		errors: Array<{ path: string; error: string }>;
	}>;
	createEventBus: () => unknown;
	initTheme: (name?: string, interactive?: boolean) => void;
	ToolExecutionComponent: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: unknown,
		toolDefinition: BashToolDefinitionLike,
		ui: { requestRender(): void },
		cwd: string,
	) => {
		rendererState: { startedAt?: number; endedAt?: number };
		setArgsComplete?: () => void;
		markExecutionStarted: () => void;
		setExpanded: (expanded: boolean) => void;
		updateResult: (result: unknown, isPartial?: boolean) => void;
		render: (width: number) => string[];
	};
}

let pi: PiApi | undefined;
if (piEntry) pi = (await import(pathToFileURL(piEntry).href)) as unknown as PiApi;

/** 剥掉所有 ANSI / OSC 转义，只留可见文本（断言直接看这个）。 */
const plain = (line: string): string =>
	line.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");

/** 可见列数（fixture 里只有 ASCII 与汉字；汉字 2 列，其余 1 列 —— 与 pi-tui 的算口一致）。 */
function widthOf(line: string): number {
	let width = 0;
	for (const ch of plain(line)) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/**
 * 用 pi 自己的加载器加载本扩展（模块求值时做一次，测试之间复用注册好的工具定义）。
 * 顶层 await 是必须的：`test()` 回调是同步的，而加载是异步的。
 */
let cached: { agentDir: string; projectDir: string; definition: BashToolDefinitionLike } | undefined;
let cleanup: (() => void) | undefined;

if (pi) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-shape-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	cleanup = () => fs.rmSync(root, { recursive: true, force: true });

	// 隔离持久白名单：不指向用户真实的 ~/.pi/agent/sandbox-allowlist.json，
	// 否则用户批准过某个目录后，这里的「越界删除被拒」用例就会因白名单命中而失败。
	const prevAllowlist = process.env.PI_SANDBOX_ALLOWLIST;
	process.env.PI_SANDBOX_ALLOWLIST = path.join(root, "sandbox-allowlist.json");
	let loaded;
	try {
		loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
	} finally {
		if (prevAllowlist === undefined) delete process.env.PI_SANDBOX_ALLOWLIST;
		else process.env.PI_SANDBOX_ALLOWLIST = prevAllowlist;
	}
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const definition = loaded.extensions[0]?.tools.get("bash")?.definition;
	assert.ok(definition, "本扩展必须注册 bash 工具（跨扩展同名注册是 first wins，见文件头）");
	pi.initTheme("dark");
	cached = { agentDir, projectDir, definition };
}

test.after(() => cleanup?.());

interface RenderOptions {
	output?: string;
	expanded?: boolean;
	partial?: boolean;
	timeout?: number;
	details?: unknown;
	/** 伪装成“跑了 N 毫秒”（页脚门槛判据用的是 `endedAt - startedAt`）。 */
	elapsedMs?: number;
	width?: number;
	/** 不调 `updateResult` —— 真实的“命令已发出、结果还没到”那一刻（`renderCall` 独舞）。 */
	noResult?: boolean;
	/** 命令失败（pi 把 `isError` 放在 tool result 上 —— 内置 bash 失败时 throw）。 */
	isError?: boolean;
}

/**
 * 一条失败命令的 tool result 正文，照抄 pi 的内置 bash 形态 —— `core/tools/bash.ts` 里
 * `formatOutput` 先把空输出换成 `(no output)`，再由 `appendStatus(text, status)` 拼上状态：
 * `` `${text}\n\n${status}` ``。所以**无输出时也是这个 `(no output)` 占位行**，
 * 不是空串 —— 扩展自己补的那个 `(no output)` 只用在结果正文真的为空的情况（不失败、也没输出）。
 */
const failed = (output: string, status = "Command exited with code 2"): string => `${output || "(no output)"}\n\n${status}`;

/**
 * 渲染一个真实的 bash 块：`markExecutionStarted` → `updateResult`，与 pi 的调用顺序一致
 *（`setArgsComplete` 在实时流里先于执行开始，`/resume` 重建时从不调用它 —— 这里都覆盖）。
 */
function renderBlock(command: string, options: RenderOptions = {}): string[] {
	assert.ok(pi && cached);
	const component = new pi.ToolExecutionComponent(
		"bash",
		"call-1",
		{ command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) },
		{},
		cached.definition,
		{ requestRender() {} },
		cached.projectDir,
	);
	component.setArgsComplete?.();
	component.markExecutionStarted();
	if (options.elapsedMs !== undefined) {
		component.rendererState.endedAt = (component.rendererState.startedAt ?? Date.now()) + options.elapsedMs;
	}
	component.setExpanded(options.expanded === true);
	if (!options.noResult) {
		component.updateResult(
			{
				content: [{ type: "text", text: options.output ?? "" }],
				details: options.details ?? {},
				// pi 把 isError 放在 result 上（`updateResult(message)` 收到的是那条 toolResult 消息），
				// 而渲染器的 `context.isError` 从它算出来 —— 失败状态的染色靠的就是这个。
				...(options.isError === undefined ? {} : { isError: options.isError }),
			},
			options.partial === true,
		);
	}
	const lines = component.render(options.width ?? 79);
	// pi 内置的 bash renderResult 在 `isPartial` 时挂了个每秒 invalidate 的定时器
	//（`setInterval(() => context.invalidate(), 1e3)`）。它是 pi 的组件、测试里没有
	// UI 会去清它，不清的话 node --test **永远退不出去**（实测挂死）。
	clearInterval((component.rendererState as { interval?: NodeJS.Timeout }).interval);
	return lines;
}

const text = (command: string, options: RenderOptions = {}): string[] => renderBlock(command, options).map(plain);

/** 那个“跑了 3 秒”伪装：越过 2s 门槛，于是 `Took` 页脚会画出来（测树里怎么摆）。 */
const SLOW = { elapsedMs: 3000 } as const;

const LONG_COMMAND =
	"cd /Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.86.0/5813aee6dbf81477902199f3db54e13ab115c8902b3ab00a8b290b3e44dcb3c8/node_modules/@earendil-works/pi-coding-agent";

/**
 * 规范化一行用于断言：行首的**状态圆点** `•` 换成空格（这样其余断言可以照旧按「块的第一行
 * 就是 `Run …`」来写，圆点本身由专门的用例负责）、去掉块左边距那 2 列的前 1 列 +
 * 首行的圆点那 1 列（即 `• ` / 两格空格 → 1 格），再剪掉行尾补白（`Box.render` 会把每行补满
 * 到终端宽度，补白不是内容）。**行首剩下的那 1 列空白要保留** —— 续行与结果树的缩进就靠它
 *（正文整体右移一格的观感，见源文件里的 `withHeadBar`）。
 */
const body = (line: string): string => line.replace(/^\u2022/, " ").replace(/ +$/, "").replace(/^ {2}/, "");

test("命令行：`•Run ` 开头，最多两行，第二行溢出换 `…`", { skip }, () => {
	const raw = renderBlock(LONG_COMMAND, { output: "a\nb\n" }).map(plain);
	const lines = raw.map(body);
	// 结构固定：命令首行 + 1 个续行 + `… +N lines` 标记，然后才是结果
	assert.equal(raw[0], "", "第 0 行是 pi self 模式的固定留白（不算在染色块里）");
	assert.equal(raw[1]!.startsWith("• Run cd "), true, `块的第 1 行应当是圆点 + 空格 + Run 开头的命令：${raw[1]}`);
	assert.equal(lines[2]!.startsWith("│ gent/"), true, `第 2 行应当是续行：${lines[2]}`);
	assert.equal(lines[2]!.endsWith(ELLIPSIS_PLAIN), true, `溢出的行尾必须换成 …：${lines[2]}`);
	assert.equal(lines[3], "│ … +1 lines", `第 3 行应当是折叠标记：${lines[3]}`);
	// 命令正文精确两行（Run 行 + 1 续行），第三条命令行是折叠标记而不是正文
	assert.equal(lines[2]!.includes("0.86.0"), true, "续行必须接着放命令正文");
	assert.equal(lines[4]!.startsWith("└ "), true, `第 4 行开始应当是结果：${lines[4]}`);
	// 不再有旧的 token 提示
	assert.equal(lines.some((line) => line.includes("tokens hidden")), false);
});

test("命令行：没溢出的短命令不画 `…`，也不画折叠标记", { skip }, () => {
	const lines = renderBlock("echo hello", { output: "hello\n" }).map(plain);
	// 首行 = 圆点 + 空格 + `Run ` + 命令，其余全是底色补白（`Box.applyBg` 补满到终端宽度）
	assert.equal(lines[1]!.trimEnd(), "• Run echo hello", "首行是圆点 + 空格 + Run + 命令");
	assert.equal(widthOf(lines[1]!), 79, `首行仍然占满整宽：${JSON.stringify(lines[1])}`);
	assert.equal(lines.some((line) => line.includes(ELLIPSIS_PLAIN)), false, "短命令不该有 …");
	assert.equal(lines.some((line) => line.includes("lines")), false, "短命令不该有 … +N lines");
});

test("状态圆点：只挂在命令首行，颜色按状态走（dim / 绿 / 红）", { skip }, () => {
	// 用户 2026-09-21 定的形状：`•Run ls …path…`，续行与结果树前面都没有这根圆点。
	// 颜色三个槽在默认皮肤（dark，见 initTheme）里的真彩色：dim `#666666`、
	// toolDiffAdded `#b5bd68`、toolDiffRemoved `#cc6666`。
	const bar = (line: string): string => {
		const match = /\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m/.exec(line);
		assert.ok(match, `首行应当带一颗带色的 •：${JSON.stringify(line)}`);
		return match![0];
	};

	// 执行中（`renderCall` 独舞，还没有任何结果）→ dim
	const pending = renderBlock("echo hello", { noResult: true });
	assert.equal(bar(pending[1]!), `${DIM_ANSI}${BAR}\u001b[39m`, `执行中该是 dim 灰：${JSON.stringify(pending[1])}`);
	// 流式的 partial 快照也是“还在跑” → dim
	assert.equal(bar(renderBlock("echo hello", { output: "", partial: true })[1]!), `${DIM_ANSI}${BAR}\u001b[39m`, "partial 也是 dim");

	// 成功 → toolDiffAdded（diff 新增行的绿）
	const ok = renderBlock("echo hello", { output: "hello\n" })[1]!;
	assert.equal(bar(ok), `${ADDED_ANSI}${BAR}\u001b[39m`, `成功该是绿色：${JSON.stringify(ok)}`);

	// 失败 → toolDiffRemoved（diff 删除行的红）
	const failedLine = renderBlock("false", { output: "boom\n", isError: true })[1]!;
	assert.equal(bar(failedLine), `${REMOVED_ANSI}${BAR}\u001b[39m`, `失败该是红色：${JSON.stringify(failedLine)}`);

	// **只有首行有**：长命令的续行、`… +N lines` 标记、整棵结果树都没有圆点
	const long = renderBlock(LONG_COMMAND, { output: "a\nb\n", isError: true });
	const plainLines = long.map(plain);
	assert.equal(plainLines.filter((line) => line.includes(BAR)).length, 1, `整块只能有一根圆点：${JSON.stringify(plainLines)}`);
	assert.equal(plainLines.findIndex((line) => line.includes(BAR)), 1, "圆点只在命令首行（块的第 1 行）");
});

test("状态圆点：颜色是从主题现取的（改主题 → 圆点跟着变）", { skip }, () => {
	// 断言的是「每次渲染都从主题现取」这件事本身，而不是写死三个色值：临时把 dark 皮肤的
	// 两个槽位指到别的色上再渲染，圆点必须跟着变 —— 缓存住了色值就会漏掉这条。
	// `theme.getFgAnsi` 与 pi 自己渲染用的单例读的是同一张 `fgColors` 表（见源文件里
	// withBashOutputColor 那条注释），所以直接改单例就是改扩展看到的色。
	const singleton = (globalThis as Record<symbol, unknown>)[Symbol.for("@earendil-works/pi-coding-agent:theme")] as
		| { fgColors?: Map<string, string> }
		| undefined;
	assert.ok(singleton?.fgColors?.set, "pi 的 theme 单例该在（initTheme 已调过）");
	const fgColors = singleton!.fgColors!;
	const dimBefore = fgColors.get("dim");
	const addedBefore = fgColors.get("toolDiffAdded");
	try {
		fgColors.set("dim", "\u001b[38;2;1;2;3m");
		fgColors.set("toolDiffAdded", "\u001b[38;2;4;5;6m");
		const pendingBar = /\u001b\[38;2;\d+;\d+;\d+m\u2022/.exec(renderBlock("x", { noResult: true })[1]!)?.[0];
		assert.equal(pendingBar, "\u001b[38;2;1;2;3m\u2022", "执行中的圆点该跟着新的 dim 走");
		const okBar = /\u001b\[38;2;\d+;\d+;\d+m\u2022/.exec(renderBlock("x", { output: "ok\n" })[1]!)?.[0];
		assert.equal(okBar, "\u001b[38;2;4;5;6m\u2022", "成功的圆点该跟着新的 toolDiffAdded 走");
	} finally {
		if (dimBefore === undefined) fgColors.delete("dim");
		else fgColors.set("dim", dimBefore);
		if (addedBefore === undefined) fgColors.delete("toolDiffAdded");
		else fgColors.set("toolDiffAdded", addedBefore);
	}
});

test("底色：bash 块整块不带底（pending / 成功 / 失败三种底都不画），其他工具不受影响", { skip }, () => {
	// 用户 2026-09-21 定的：bash 块**彻底去掉底色**（pending 的 `toolPendingBg`、成功的
	// `toolSuccessBg`、失败的 `toolErrorBg` 都不画），状态只由首行那颗圆点的颜色表达。
	// 判定看 SGR 的**背景**序列（`48;2;…` / `40-47` / `100-107`）—— 只要行首没有它，
	// 整行就没有底色（`Box` 是把 bgFn 套在整行上的）。
	const hasBg = (line: string): boolean => /\u001b\[(?:4[0-7]|10[0-7]|48[;:])/.test(line);
	const cases: Array<[string, string[]]> = [
		["执行中", renderBlock("echo hello", { noResult: true })],
		["流式 partial", renderBlock("echo hello", { output: "hi\n", partial: true })],
		["成功", renderBlock("echo hello", { output: "hello\n", ...SLOW })],
		["失败", renderBlock("false", { output: "(no output)\n\nCommand exited with code 1", isError: true, ...SLOW })],
		["展开态失败", renderBlock("cmd", { output: "1\n2\n3\n\nCommand exited with code 2", isError: true, expanded: true })],
	];
	for (const [label, lines] of cases) {
		const painted = lines.filter(hasBg);
		assert.deepEqual(painted, [], `${label}：bash 块不该有任何底色行：${JSON.stringify(painted.map(plain))}`);
		// 内容本身还在（别把"没底色"做成"整块没了"）
		assert.equal(lines.map(plain).some((line) => line.includes(BAR)), true, `${label}：命令首行该还在：${JSON.stringify(lines.map(plain))}`);
	}

	// 对照：其他工具（这里拿 pi 的**通用**渲染路径当替身 —— 不给 toolDefinition）底色照旧。
	// 这钉住的是「只去 bash 的」那半边：本扩展只注册了 `bash` 一个工具，
	// 别的工具走的是 ToolExecutionComponent 自己的 contentBox + bgFn。
	assert.ok(pi);
	const other = new pi.ToolExecutionComponent("read", "call-other", { path: "/tmp/x" }, {}, undefined, { requestRender() {} }, cached!.projectDir);
	other.updateResult({ content: [{ type: "text", text: "file content" }], details: {} }, false);
	const otherLines = other.render(79);
	assert.equal(otherLines.some(hasBg), true, `其他工具的底色必须还在：${JSON.stringify(otherLines.map(plain))}`);
});

test("无边界空行：上下都没有空行（命令是第一行、结果是最后一行）", { skip }, () => {
	// 用户 2026-09-21 定的：不再用上下两行染色空行撑开色块。所以块的第 1 行就是命令、
	// 最后一行就是结果本身（`Took` 页脚在树里时就是它），中间也不掺空行。
	for (const [label, lines] of [
		["执行中", renderBlock("echo hello", { noResult: true })],
		["成功", renderBlock("echo hello", { output: "hello\n", elapsedMs: 100 })],
		["失败", renderBlock("false", { output: "(no output)\n\nCommand exited with code 1", isError: true, elapsedMs: 100 })],
		["带 Took 的长命令", renderBlock("echo hi", { output: "hi\n", ...SLOW })],
	] as Array<[string, string[]]>) {
		const visible = lines.map(plain);
		// 首行是 pi self 模式的固定留白（`render()` 里 `lines.push("")`），它不是块的一部分
		assert.equal(visible[0], "", `${label}：第 0 行是 pi 的固定留白`);
		assert.equal(visible[1]!.startsWith(BAR), true, `${label}：第 1 行（块第一行）就该是带圆点的命令：${JSON.stringify(visible)}`);
		assert.notEqual(visible[visible.length - 1]!.trim(), "", `${label}：最后一行不该是空行（没有下边界空行）：${JSON.stringify(visible)}`);
		// 命令与结果之间也紧贴：块的第 2 行就是第一个结果行（`└ `），不是空行
		if (visible.length > 2) assert.equal(visible[2]!.trimStart().startsWith("└ "), true, `${label}：结果紧贴命令：${JSON.stringify(visible)}`);
	}
});

test("命令行：续行与折叠标记的正文列 == `Run ` 的 n 列", { skip }, () => {
	// 续行 / 折叠标记的前缀是 `│ `（2 列），所以它们的**正文**落在第 3 列（0 基的 2）——
	// 正是 `Run ` 里 `n` 那一列。用户样例里的两行就是这么对齐的。
	const lines = text(LONG_COMMAND, { output: "a\n" }).map(body);
	const run = lines.find((line) => line.startsWith("Run "))!;
	const continuation = lines[lines.indexOf(run) + 1]!;
	const marker = lines.find((line) => line.includes("+1 lines"))!;
	const nColumn = "Run ".indexOf("n");
	// 圆点在**列 0**（顶掉原本 Box 的那格左内边距），所以 `Run ` 的正文起点仍是列 2
	assert.equal(nColumn, 2, "`Run ` 的 n 在第 3 列（0 基 2）—— 断言口径的前提");
	assert.equal(continuation.slice(0, 2), `${PIPE} `, `续行应当带 2 列前缀：${continuation}`);
	assert.equal(continuation.slice(2).length > 0, true);
	assert.equal(marker.slice(0, 2), `${PIPE} `, `折叠标记应当带 2 列前缀：${marker}`);
	assert.equal(marker.indexOf(ELLIPSIS_PLAIN), nColumn, `折叠标记的 … 列不对：${marker}`);
	assert.equal(run.indexOf("Run "), 0, `Run 该在列 0（body 已经剥掉块左边距）：${run}`);
});

test("对齐：圆点在列 0、`Run` / `│` / `└` 同在列 2、正文同在列 4", { skip }, () => {
	// 用户 2026-09-21 第二轮定的观感：正文整体右移一格（`• Run …`，不再是 `•Run …`），
	// 而且**结果侧跟着一起移** —— 命令行在列 2、结果树在列 0 的话两截会错开。
	// 这条用例盯的就是「两侧同宽」：命令行与结果树各行的前导列必须落在同一张表上。
	// 输出用 3 行（正好是预览预算，全留）：`└ ` 落在第一行、第二行是它的缩进续行。
	const raw = renderBlock(LONG_COMMAND, { output: "one\ntwo\nthree\n" }).map(plain);
	const barIndex = raw.findIndex((line) => line.includes(BAR));
	assert.equal(barIndex, 1, `圆点在块的第 1 行：${JSON.stringify(raw)}`);
	assert.equal(raw[barIndex]!.indexOf(BAR), 0, `圆点在列 0：${JSON.stringify(raw[barIndex])}`);
	assert.equal(raw[barIndex]!.indexOf("Run "), 2, `\`Run \` 在列 2：${JSON.stringify(raw[barIndex])}`);

	// 命令行的续行与结果树的 `│ ` / `└ ` 都从列 2 起
	const continuation = raw.find((line) => line.includes("gent/") && line.includes("\u2502"))!;
	assert.ok(continuation?.startsWith("  \u2502 "), `命令续行应当在列 2：${JSON.stringify(raw)}`);
	const bodyColumn = continuation.indexOf("\u2502") + 2;
	assert.equal(bodyColumn, 4, `命令续行的正文在列 4：${JSON.stringify(continuation)}`);
	const corner = raw.find((line) => line.includes("\u2514 "))!;
	assert.equal(corner.indexOf("\u2514"), 2, `\`└ \` 在列 2：${JSON.stringify(corner)}`);
	// `└ ` 后面的正文同样落在列 4（与命令续行的正文同列）
	assert.equal(corner.indexOf("one"), bodyColumn, `结果正文该与命令正文同列：${JSON.stringify(corner)}`);
	// `└ ` 之下的续行只有缩进，正文也仍在列 4
	const rest = raw.find((line) => line.trimStart().startsWith("two"))!;
	assert.equal(rest.indexOf("two"), bodyColumn, `结果续行正文该在列 4：${JSON.stringify(rest)}`);
	// 整块左边距一致：每一行要么是空行、要么前两格是「圆点 / 树符 / 空格」这一族
	for (const [index, line] of raw.entries()) {
		if (line === "" || line.trim() === "") continue;
		const head = line.slice(0, 2);
		assert.match(head, /^(?:\u2022 |  |\u2502 |\u2514 | {2})/, `第 ${index} 行的左边距不对：${JSON.stringify(line)}`);
	}
});

test("命令行：命令还在跑（没有任何结果）用空格缩进，结果一到就是 `│ `", { skip }, () => {
	// 纯执行中（`renderCall` 独舞、`updateResult` 还没被调过）：整块都是纯缩进，一根竖线都没有
	const running = text(LONG_COMMAND, { noResult: true }).map(body);
	assert.equal(running[2]!.startsWith("  gent/"), true, `执行中续行应当是空格缩进：${running[2]}`);
	assert.equal(running.find((line) => line.includes("+1 lines"))!.startsWith("  …"), true, "执行中的折叠标记也只用缩进");
	assert.equal(running.some((line) => line.startsWith(`${PIPE} `) || line.startsWith("└ ")), false, "执行中不该出现树形符号");
	// 结果一到（哪怕还是 partial 快照），命令续行与折叠标记就换成 `│ `，树接上
	const withOutput = text(LONG_COMMAND, { output: "a\n", partial: true }).map(body);
	assert.equal(withOutput[2]!.startsWith(`${PIPE} gent/`), true, `出结果后续行应当是 │ ：${withOutput[2]}`);
	assert.equal(withOutput.find((line) => line.includes("+1 lines"))!.startsWith(`${PIPE} …`), true, "折叠标记也挂 │");
});

test("结果：`└ ` 在整块里恰好出现一次，就在第一行实质输出上", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "one\ntwo\nthree\n", ...SLOW }).map(body);
	const corners = lines.filter((line) => line.startsWith("└ "));
	assert.equal(corners.length, 1, `└ 只能出现一次：${JSON.stringify(lines)}`);
	assert.equal(corners[0], "└ one", "└ 必须挂在第一行实质输出上");
	// 后续内容行：两格缩进，不带竖线 / 拐角符
	assert.equal(lines[lines.indexOf(corners[0]!) + 1], "  two");
	assert.equal(lines[lines.indexOf(corners[0]!) + 2], "  three");
});

test("结果：截断提示行挂 `│ `，`└ ` 留给它下面的第一行输出", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "1\n2\n3\n4\n5\n6\n7\n", ...SLOW }).map(body);
	const hint = lines.find((line) => line.includes("earlier lines"))!;
	assert.equal(hint.startsWith("│ …"), true, `截断提示应当挂 │ ：${hint}`);
	const corner = lines.find((line) => line.startsWith("└ "))!;
	assert.equal(corner, "└ 5", `└ 应当挂在提示行下面的第一行输出上：${corner}`);
	assert.equal(lines[lines.indexOf(corner) + 1], "  6");
	assert.equal(lines[lines.indexOf(corner) + 2], "  7");
	// 页脚也在树里、同样只缩进（不再长竖线）
	const footer = lines.find((line) => line.startsWith("  Took "))!;
	assert.ok(footer, "Took 页脚应当缩进对齐");
	// `│ ` 只出现在 `└ ` 上面的那一段（命令续行 + 折叠标记 + 截断提示），`└ ` 之后一根都没有
	assert.equal(lines.findIndex((line) => line.startsWith("└ ")) < lines.findIndex((line) => line.startsWith("  Took ")), true);
	assert.equal(lines.slice(lines.findIndex((line) => line.startsWith("└ "))).some((line) => line.startsWith("│ ")), false, `└ 之后不该再画竖线：${JSON.stringify(lines)}`);
});

test("结果：没有输出时画 `(no output)`，`└ ` 挂在它前面", { skip }, () => {
	const lines = text("true", SLOW).map(body);
	assert.equal(lines.find((line) => line.startsWith("└ ")), "└ (no output)");
	// 执行中（还没结果）不保留行：那时“还没输出”不等于“没有输出”
	const running = text("sleep 5", { partial: true }).map(body);
	assert.equal(running.some((line) => line.includes("(no output)")), false, "执行中不该画 (no output)");
	assert.equal(running.some((line) => line.startsWith("└ ")), false, "执行中不该有 └");
});

test("结果：`(no output)` 排在 warnings 前面", { skip }, () => {
	const lines = text("cat huge", {
		output: "",
		details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 999 }, fullOutputPath: "/tmp/x.log" },
		...SLOW,
	}).map(body);
	const noOutput = lines.findIndex((line) => line.includes("(no output)"));
	const warning = lines.findIndex((line) => line.includes("Full output:"));
	assert.ok(noOutput !== -1 && warning !== -1, `两行都该在：${JSON.stringify(lines)}`);
	assert.ok(noOutput < warning, "(no output) 应当排在 warnings 前面");
	assert.equal(lines[noOutput]!.startsWith("└ "), true);
	assert.equal(lines[warning]!.startsWith("  "), true, "warnings 只缩进、不再挂拐角符");
});

test("结果：每一行的可见宽度都不超过终端宽度", { skip }, () => {
	const cases: Array<{ command: string; options: RenderOptions }> = [
		{ command: LONG_COMMAND, options: { output: "one\ntwo\nthree\n", ...SLOW } },
		{ command: "echo hi", options: { output: "hi\n", ...SLOW } },
		{ command: "true", options: SLOW },
		{ command: "echo " + "x".repeat(200), options: { output: "1\n2\n3\n" } },
		{ command: "echo 你好世界".repeat(20), options: { output: "第一行\n第二行\n" } },
		{ command: "cat huge", options: { output: "", details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 1, totalLines: 999 }, fullOutputPath: "/tmp/" + "y".repeat(120) }, ...SLOW } },
	];
	for (const width of [120, 79, 60, 40, 30, 25]) {
		for (const { command, options } of cases) {
			const lines = renderBlock(command, { ...options, width });
			for (const line of lines) {
				assert.ok(widthOf(line) <= width, `宽度 ${width} 下超宽：${JSON.stringify(plain(line))}（Run ${command.slice(0, 30)}…）`);
			}
		}
	}
});

test("展开态：结果不裁行、不挂 gutter（命令自己的续行前缀还在）", { skip }, () => {
	const lines = text(LONG_COMMAND, { output: "1\n2\n3\n4\n5\n6\n7\n8\n", expanded: true, ...SLOW }).map(body);
	// 结果段是原样输出：没有 `└ `、没有截断提示、每个输出行都顶格
	assert.equal(lines.some((line) => line.startsWith("└ ")), false, `展开态不该有 └ ：${JSON.stringify(lines)}`);
	assert.equal(lines.some((line) => line.includes("earlier lines")), false, "展开态不该有截断提示");
	// 左边距那 1 列仍挂着（`body` 只剥 2 列，所以这里还剩 1 格），正文列与折叠态一致
	for (const line of ["1", "2", "8"]) assert.equal(lines.includes(line), true, `展开态应当原样输出 ${line}：${JSON.stringify(lines)}`);
	assert.equal(lines.some((line) => line === " 1"), false, "展开态的输出也不该多留左边距（`body` 只剥 1 列）");
	// 命令段：不截断、没有 `… +N lines` 标记（但还是命令自己的续行前缀）
	assert.equal(lines.some((line) => line.endsWith(ELLIPSIS_PLAIN)), false, "展开态命令不截断");
	assert.equal(lines.some((line) => line.includes("+") && line.includes("lines")), false, "展开态不该有 … +N lines 标记");
	// 页脚也不在树里：顶格、没有 `│ ` / `└ `
	assert.equal(lines.find((line) => line.includes("Took "))!.startsWith("Took "), true);
});

test("着色：命令续行的 `│` 是 muted，不跟着后面 token 的颜色飘", { skip }, () => {
	// 命令第 2 行的正文是路径（`syntaxString`），第 1 行末尾也是路径 —— 两行的 `│` 与
	// `Run ` 必须各是各的色：结构符一头一尾都不能继承正文的颜色（实测踩过：`│` 跟着 path 色）。
	const lines = renderBlock(LONG_COMMAND, { output: "ok\n" });
	const run = lines.find((line) => plain(line).includes("Run cd "))!;
	const continuation = lines.find((line) => plain(line).includes("ent/0.86.0"))!;
	assert.ok(run && continuation, "两行命令行都该在");

	// 首行现在是 `•` + `Run `（圆点自成一段 SGR，`Run` 词上还套一层粗体），续行是 `│ `（muted）
	const runPrefix = /^\u001b\[38;2;\d+;\d+;\d+m\u2022\u001b\[39m \u001b\[38;2;212;212;212m\u001b\[1mRun\u001b\[22m \u001b\[39m/.exec(run);
	assert.ok(runPrefix, `Run 前缀应当是圆点 + 空格 + toolTitle 正常色 + 粗体：${JSON.stringify(run)}`);
	// 前缀直接顶在行首（没有 SGR 48 的底色前缀），见下面的「无底色」用例
	assert.equal(run.startsWith("\u001b[38;2;"), true, `bash 块首行不该有底色：${JSON.stringify(run)}`);
	const chainPrefix = /\u001b\[38;2;128;128;128m│ \u001b\[39m/.exec(continuation);
	assert.ok(chainPrefix, `续行的 │ 应当是 muted 灰、且颜色在正文前闭合：${JSON.stringify(continuation)}`);
	// 正文的 path 色（syntaxString）出现在 `│ ` 之后，而不是包住它
	const chainIndex = continuation.indexOf(chainPrefix![0]);
	const pathIndex = continuation.indexOf("\u001b[38;2;206;145;120m");
	assert.ok(pathIndex > chainIndex, "path 色必须排在 │ 前缀之后");
});

test("着色：只有 `Run` 那个词加粗，命令正文不加粗", { skip }, () => {
	const lines = renderBlock("echo hi", { output: "ok\n", ...SLOW });
	const run = lines.find((line) => plain(line).includes("Run echo hi"))!;
	assert.ok(run, "命令行该在");
	// `Run` 外面套着粗体开/关，**行尾那个空格在粗体之外**（包住前缀会让间距看着变宽）
	assert.match(run, /\u001b\[1mRun\u001b\[22m /, `Run 该加粗且空格不加粗：${JSON.stringify(run)}`);
	// 正文（echo / hi）不带任何粗体标记
	const body = run.slice(run.indexOf("\u001b[22m") + "\u001b[22m".length);
	assert.equal(body.includes("\u001b[1m"), false, `命令正文不该加粗：${JSON.stringify(body)}`);
	assert.equal(body.includes("\u001b[22m"), false, `命令正文不该有粗体复位：${JSON.stringify(body)}`);
	// 续行（`│ `）与结果（`└ `）都不加粗
	const styledCorner = lines.find((line) => plain(line).trimStart().startsWith("└ "))!;
	assert.ok(styledCorner, "结果行该在");
	assert.equal(styledCorner.includes("\u001b[1m"), false, "结果树的 └ 不该加粗");
	// 长命令的续行（`│ `）也不加粗
	const continuation = renderBlock(LONG_COMMAND, { output: "ok\n" }).find((line) => plain(line).trimStart().startsWith("\u2502 "));
	assert.ok(continuation, "长命令该有续行");
	assert.equal(continuation.includes("\u001b[1m"), false, "续行的 │ 不该加粗");
});

test("失败：`Command exited with code 2` 用 error 前景色", { skip }, () => {
	// pi 把它塞在结果正文末尾，前面跟输出一样是 `toolOutput`（默认 gray）—— 用户要的是红色。
	// 用默认皮肤（dark，见 initTheme）的色值断言：error = #cc6666 = `\u001b[38;2;204;102;102m`。
	const raw = renderBlock("for f in a b; do echo x; done", { output: failed("one\ntwo"), isError: true, elapsedMs: 100 });
	const status = raw.find((line) => plain(line).includes("Command exited with code 2"))!;
	assert.ok(status, `失败提示该在：${JSON.stringify(raw.map(plain))}`);
	assert.ok(status.includes("\u001b[38;2;204;102;102m"), `失败提示该是 error 红：${JSON.stringify(status)}`);
	// 有输出时那两行就是提示行本身，不能被树形 gutter 误伤
	// （它们落在 `└ ` 之后，所以只缩进两格、不带竖线）
	const after = raw.map(plain).map(body);
	assert.equal(after.find((line) => line.includes("Command exited"))!.startsWith("  Command exited"), true);

	const only = renderBlock("true; exit 3", { output: failed("", "Command exited with code 3"), isError: true, elapsedMs: 100 });
	const onlyStatus = only.find((line) => plain(line).includes("Command exited with code 3"))!;
	assert.ok(onlyStatus.includes("\u001b[38;2;204;102;102m"), `无输出时提示同样要红：${JSON.stringify(onlyStatus)}`);
	const onlyBody = only.map(plain).map(body);
	assert.equal(onlyBody.find((line) => line.startsWith("└ ")), "└ (no output)", "无输出时 └ 挂在占位行上");
	assert.equal(onlyBody.find((line) => line.includes("Command exited"))!.startsWith("  Command exited"), true, "提示紧随其后、缩进对齐");
});

test("失败：提示行上方不留没有前导符的空行（中间不能断层）", { skip }, () => {
	// pi 把状态拼在输出末尾，那句 `\n\n` 会画出一行没有前缀的空行 —— 用户看到的就是
	// “断层两层”（它挤在预览与 `└ Command exited…` 之间）。现在空行不再画（见文件头 ⑤）。
	const lines = text("true; exit 3", { output: failed("", "Command exited with code 3"), isError: true, elapsedMs: 100 }).map(body);
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	const status = lines.findIndex((line) => line.includes("Command exited"));
	assert.equal(lines[corner], "└ (no output)", `树起点：${JSON.stringify(lines)}`);
	assert.equal(status, corner + 1, `提示紧跟在占位行下面：${JSON.stringify(lines)}`);
	// 提示的前导符是两格缩进（`└ ` 已在上一行用过，树在那里就落地了）
	assert.equal(lines[status]!.startsWith("  Command exited"), true, `提示该缩进对齐：${JSON.stringify(lines[status])}`);
	// 整棵结果树里没有任何一行是断开的空行
	const tree = lines.slice(corner, status + 1);
	for (const line of tree) assert.match(line, /^(?:└ |  )/, `树里不该有断开前导符的行：${JSON.stringify(lines)}`);

	// 有输出、提示紧跟输出时，中间那几行都是内容，不是空行
	const withOutput = text("echo x; exit 5", { output: failed("x", "Command exited with code 5"), isError: true, elapsedMs: 100 }).map(body);
	const region = withOutput.slice(withOutput.findIndex((line) => line.startsWith("Run ")), withOutput.findIndex((line) => line.includes("Command exited")) + 1);
	assert.deepEqual(region, ["Run echo x; exit 5", "└ x", "  Command exited with code 5"], `命令与提示之间不该有空行：${JSON.stringify(withOutput)}`);
});

test("失败：提示不会被输出预览裁掉", { skip }, () => {
	// pi 把状态拼在输出末尾，预览只留最后 3 行 —— 状态前面那一句 `\n\n` 会把它挤出可视区，
	// 用户看到的就是只剩一条 `│ … (N earlier lines)` 加两行空行的断层。
	// 修复是把那行状态当成预览**必须留住的一行**（先摘下来、预算留给内容、再放回去）。
	const lines = text("cat big", { output: failed(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")), isError: true, elapsedMs: 100 }).map(body);
	const hint = lines.find((line) => line.includes("earlier lines"))!;
	assert.equal(hint.startsWith("│ "), true, `截断提示挂 │ ：${JSON.stringify(lines)}`);
	const corner = lines.find((line) => line.startsWith("└ "))!;
	assert.equal(corner, "└ line 29", `└ 该挂在提示下面第一行内容上（状态占掉一行预算）：${JSON.stringify(lines)}`);
	const status = lines.find((line) => line.includes("Command exited"))!;
	assert.equal(status.startsWith("  Command exited"), true, `失败提示在树里缩进：${status}`);
	assert.equal(lines.indexOf(status), lines.indexOf(corner) + 2, `提示该紧跟在两行预览后面：${JSON.stringify(lines)}`);
});

test("失败：正常输出里出现同样字样不会被误染也不会被吞掉", { skip }, () => {
	// 认形态必须是“真的是错的那次”（`context.isError`）+ 文本形态两条。只看文本会把把这句话
	// echo 出来的正常输出也染红、并且在末尾时把它当成状态摘走。
	const raw = renderBlock("echo 'Command exited with code 2'", {
		output: "Command exited with code 2\n",
		isError: false,
		elapsedMs: 100,
	});
	assert.equal(raw.some((line) => line.includes("\u001b[38;2;204;102;102m")), false, `成功的结果不该有 error 红：${JSON.stringify(raw.map(plain))}`);
	assert.deepEqual(raw.map(plain).map(body).slice(1), ["Run echo 'Command exited with code 2'", "└ Command exited with code 2"], "输出要原样保留");
});

test("失败：展开态（ctrl+o）里提示也要红", { skip }, () => {
	// 展开态不裁行、不挂树，但颜色不能丢（用户要的是“失败提示见红”，与折叠态无关）。
	const raw = renderBlock("cmd", {
		output: `1\n2\n3\n\nCommand exited with code 2`,
		isError: true,
		expanded: true,
		elapsedMs: 100,
	});
	const status = raw.find((line) => plain(line).includes("Command exited with code 2"))!;
	assert.ok(status.includes("\u001b[38;2;204;102;102m"), `展开态的提示该是 error 红：${JSON.stringify(status)}`);
	// 展开态不挂树：输出行顶格、`└ ` 不出现
	const lines = raw.map(plain).map(body);
	assert.equal(lines.some((line) => line.startsWith("└ ")), false, `展开态不该有 └ ：${JSON.stringify(lines)}`);
	assert.equal(lines.includes("1"), true, `展开态该原样输出：${JSON.stringify(lines)}`);
});

test("失败：空行不断栅栏 —— 树里的空行也带 `│ `", { skip }, () => {
	// 用户 2026-09-21 第二次报的形状（真实会话 13:01:21 的那条）：pi 的预览窗口
	// `truncateToVisualLines(styledOutput, 5, width)` 从尾部倒着切，窗口开头可能正好是一个空行
	//（输出自己的空行）。它夹在截断提示行与 `└ ` 之间，光秃秃地空着就成了“断层”。
	// 用户的定案：**这种空行要把 `│` 补在行前**，而不是删掉它。
	const lines = text("node x.mjs", {
		output: `1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n\nNode.js v26.4.0\n\n\nCommand exited with code 1`,
		isError: true,
		elapsedMs: 100,
	}).map(body);
	const hint = lines.findIndex((line) => line.includes("earlier lines"));
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	assert.ok(hint !== -1, `截断提示该在：${JSON.stringify(lines)}`);
	assert.equal(lines[corner], "└ Node.js v26.4.0", `└ 该在提示行下面：${JSON.stringify(lines)}`);
	// 提示行与 `└ ` 之间的每一行都是 `│`（这里就是那一行空行），没有裸空行
	for (let i = hint; i < corner; i++) assert.equal(lines[i]!.startsWith("│"), true, `第 ${i} 行断了栅栏：${JSON.stringify(lines)}`);
	// 整棵树从 `Run ` 到状态行之间的每一行都带前导（空行 = `│`）
	const status = lines.findIndex((line) => line.includes("Command exited"));
	for (let i = lines.findIndex((line) => line.startsWith("Run ")); i <= status; i++) {
		assert.match(lines[i]!, /^(?:Run |\u2502|└ |  )/, `树里断了栅栏：${JSON.stringify(lines)}`);
	}
	// 树之外那行 pi 的固定留白（self 模式 render() 的第一行）仍是空的
	assert.equal(lines[0], "", `命令上方应当留空：${JSON.stringify(lines)}`);
});

test("warnings：`[Full output: …]` 上方那行空行不带前导符（树在 `└ ` 就落地了）", { skip }, () => {
	// 用户 2026-09-21 定案：`└ ` 已经指到首行实质输出上，下面那截是缩进对齐的续行；
	// 所以 warnings（`[Full output: …]`）与 `Took` 各自前面那行前导空行都是**空行**，
	// 不能再挂 `│ ` —— 挂了反而像输出还没完。只在 `└ ` **之上**的空行才补（那里断了才是断层）。
	const lines = text("grep -rn x dist/", {
		output: "a\nb\nc\n\n[Showing lines 3-16 of 16 (50.0KB limit). Full output: /tmp/x.log]",
		isError: false,
		elapsedMs: 100,
	}).map(body);
	const corner = lines.findIndex((line) => line.startsWith("└ "));
	const warning = lines.findIndex((line) => line.includes("[Showing lines"));
	assert.ok(corner !== -1 && warning !== -1, `两段都该在：${JSON.stringify(lines)}`);
	// 输出行被预览裁过头一行（`a` 没了、只剩 `c`），这不影响本用例要断言的是前导符
	assert.match(lines[corner]!, /^└ \S/, `└ 挂实质输出上：${JSON.stringify(lines)}`);
	assert.equal(lines[warning - 1], "", `[Full output 前那行应当是空行：${JSON.stringify(lines)}`);
	assert.equal(lines.slice(corner, warning).some((line) => line.startsWith("│")), false, `└ 之下不该再画竖线：${JSON.stringify(lines)}`);
	// `└ ` 之上仍不充许裸空行（长输出 + 截断提示的场景）
	const long = text("grep -rn x dist/", {
		output: Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n\n[Showing lines 11-16 of 16 (50.0KB limit). Full output: /tmp/x.log]",
		isError: false,
		elapsedMs: 100,
	}).map(body);
	const c2 = long.findIndex((line) => line.startsWith("└ "));
	const run2 = long.findIndex((line) => line.startsWith("Run "));
	for (let i = run2; i < c2; i++) assert.notEqual(long[i], "", `└ 之上断了栅栏：${JSON.stringify(long)}`);
});

test("耗时页脚：短命令不画 `Took`，长命令画", { skip }, () => {
	const fast = text("echo hi", { output: "hi\n", elapsedMs: 100 }).map(body);
	assert.equal(fast.some((line) => line.includes("Took ")), false, "短命令不该有 Took 页脚");
	const slow = text("echo hi", { output: "hi\n", ...SLOW }).map(body);
	assert.equal(slow.find((line) => line.includes("Took "))!.startsWith("  Took "), true, "长命令的 Took 在树里缩进");
});

/* ------------------------------------------------------------------ *
 * 能力边界（seatbelt 沙箱）—— execute 路径的端到端断言
 *
 * 这里跑的是**真命令**，但全部无害：`echo`、往测试自己的临时目录写文件，
 * 以及一次**注定被沙箱拦住**的越界删除。越界目标用带随机后缀的探针文件名，
 * 万一沙箱没生效（测试就会失败）也只会在 $HOME 下多一个空文件，
 * 用例自己会把它清掉 —— 不会碰到任何已有文件。
 *
 * 口径（用户 2026-09-24）：写入不拦，只拦边界外的删除。
 * ------------------------------------------------------------------ */

/** 构造一个非交互的 ctx（hasUI: false → 越界不升级，直接失败）。
 *
 * 内置 bash 的 execute 会读 `ctx.sessionManager.getSessionId()` / `getSessionFile()`
 * 来注入 PI_SESSION_ID 等环境变量，所以这两个字段必须给 —— 否则报的不是沙箱错误
 * 而是 `Cannot read properties of undefined`，测试就看不出真正要验的东西。
 */
function execCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		ui: {},
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "sbx-test-session",
			getSessionFile: () => undefined,
		},
	};
}

/** 跑一条命令，返回 { ok, text }：成功取正文，失败取抛出的 message。 */
async function runCommand(definition: BashToolDefinitionLike, command: string, cwd: string) {
	assert.ok(definition.execute, "bash 工具必须有 execute");
	try {
		const result = await definition.execute("call-sbx", { command }, undefined, undefined, execCtx(cwd));
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 交互 ctx：`select` 按 `selections` 顺序回放（模拟用户在弹框里的选择），
 * `confirm` 按 `confirmAnswers` 回放（抽不出路径的兜底分支用）。两层授权的
 * 端到端用例全靠这个 harness 驱动。
 */
function execCtxUI(cwd: string, selections: string[], confirmAnswers: boolean[] = []) {
	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const notifies: string[] = [];
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		selects,
		confirms,
		notifies,
		ui: {
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return selections.shift();
			},
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return confirmAnswers.shift() ?? false;
			},
			notify: (text: string) => notifies.push(text),
		},
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "sbx-test-session",
			getSessionFile: () => undefined,
		},
	};
}

async function runCommandWithCtx(
	definition: BashToolDefinitionLike,
	command: string,
	ctx: ReturnType<typeof execCtxUI>,
) {
	assert.ok(definition.execute, "bash 工具必须有 execute");
	try {
		const result = await definition.execute("call-sbx", { command }, undefined, undefined, ctx);
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
		return { ok: true, text };
	} catch (err) {
		return { ok: false, text: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 为两层授权用例加载一份**独立的**扩展实例：`PI_SANDBOX_ALLOWLIST` 指向用例自己的
 * 临时文件（不碰用户真实白名单），会话 scope 集合清空（那是 globalThis 单例，
 * 跨用例残留会污染判定）。返回的 restore 负责把 env 与集合恢复原状。
 */
async function loadSandboxFixture(name: string): Promise<{
	definition: BashToolDefinitionLike;
	projectDir: string;
	allowlistFile: string;
	restore: () => void;
}> {
	assert.ok(pi);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bash-${name}-`));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	const allowlistFile = path.join(root, "sandbox-allowlist.json");
	const prevAllowlist = process.env.PI_SANDBOX_ALLOWLIST;
	process.env.PI_SANDBOX_ALLOWLIST = allowlistFile;
	let definition: BashToolDefinitionLike | undefined;
	try {
		const { getSessionScopes } = await import("./allowlist.ts");
		getSessionScopes().clear();
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
		assert.deepEqual(loaded.errors, [], "加载不该报错");
		definition = loaded.extensions[0]?.tools.get("bash")?.definition;
	} finally {
		if (prevAllowlist === undefined) delete process.env.PI_SANDBOX_ALLOWLIST;
		else process.env.PI_SANDBOX_ALLOWLIST = prevAllowlist;
	}
	assert.ok(definition?.execute, "应当注册 bash 工具");
	return {
		definition,
		projectDir,
		allowlistFile,
		restore: () => {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test("沙箱：边界内命令正常执行（echo、写 cwd、删 cwd 都成功）", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	const echoed = await runCommand(definition, "echo sandbox-ok", projectDir);
	assert.equal(echoed.ok, true, `echo 不该失败：${echoed.text}`);
	assert.match(echoed.text, /sandbox-ok/);

	// projectDir 在 /tmp 下，属于可删边界 → 写进去、删掉都应当成功
	const wrote = await runCommand(definition, "echo x > .sbx-write-probe && cat .sbx-write-probe", projectDir);
	assert.equal(wrote.ok, true, `边界内写入不该失败：${wrote.text}`);
	assert.match(wrote.text, /x/);

	const removed = await runCommand(definition, "rm -f .sbx-write-probe && echo removed", projectDir);
	assert.equal(removed.ok, true, `边界内删除不该失败：${removed.text}`);
	assert.match(removed.text, /removed/);
});

test("沙箱：越界写入放行（创建与覆盖都不拦）", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// 探针路径：$HOME 下、带随机后缀。写入按口径放行，所以它**会**被创建出来，
	// finally 里用测试进程自己的 fs（不走沙箱）清掉这个字面路径。
	const probe = path.join(os.homedir(), `.sbx-write-probe-${process.pid}-${Date.now()}.txt`);
	try {
		const created = await runCommand(definition, `echo hi > ${JSON.stringify(probe)}`, projectDir);
		assert.equal(created.ok, true, `越界写入应当放行：${created.text}`);
		assert.equal(fs.existsSync(probe), true, "越界文件应当被创建出来");

		const appended = await runCommand(definition, `echo more >> ${JSON.stringify(probe)}`, projectDir);
		assert.equal(appended.ok, true, `越界追写也应当放行：${appended.text}`);
	} finally {
		if (fs.existsSync(probe)) fs.rmSync(probe);
	}
});

test("沙箱：越界删除被 OS 拒绝，文件仍在，非交互环境不升级", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// 先用测试进程自己的 fs 在 $HOME 下建一个探针文件（不走沙箱，所以能建），
	// 再让沙箱里的命令去删它 —— 这才是两次事故的真实形状。
	const probe = path.join(os.homedir(), `.sbx-delete-probe-${process.pid}-${Date.now()}.txt`);
	fs.writeFileSync(probe, "victim\n");
	try {
		const denied = await runCommand(definition, `rm -f ${JSON.stringify(probe)}`, projectDir);
		assert.equal(denied.ok, false, "越界删除必须失败（沙箱没生效？）");
		assert.match(denied.text, /Operation not permitted|EPERM/, `应当是沙箱拒绝：${denied.text}`);
		assert.match(denied.text, /\[沙箱\]/, "非交互环境要带上沙箱说明");
		assert.match(denied.text, /删除可删边界之外/, "说明文案要点名是删除而不是写入");
		assert.equal(fs.existsSync(probe), true, "越界文件必须仍在");
		assert.equal(fs.readFileSync(probe, "utf8"), "victim\n", "内容也不能变");
	} finally {
		// 只清本用例自己建的那个字面路径；不存在就什么都不做。
		if (fs.existsSync(probe)) fs.rmSync(probe);
	}
});

test("沙箱：被 `;` 后成功命令掩盖的越界删除，结果里要带 [沙箱] 说明", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// 真实事故形状：`rm <越界> ; <成功命令>` —— 整条命令退出码 0，pi 不 throw，
	// 于是 catch 分支（弹框 + [沙箱] 提示）根本走不到，拒绝被静默吞掉。
	const probe = path.join(os.homedir(), `.sbx-masked-probe-${process.pid}-${Date.now()}.txt`);
	fs.writeFileSync(probe, "victim\n");
	try {
		const masked = await runCommand(definition, `rm ${JSON.stringify(probe)} ; true`, projectDir);
		assert.equal(masked.ok, true, "整条命令应当成功（`; true` 掩盖了 rm 的失败）");
		assert.match(masked.text, /Operation not permitted|EPERM/, "rm 的拒绝原文仍要在输出里");
		assert.match(masked.text, /\[沙箱\]/, "成功命令也要把被拦的删除说出来");
		assert.ok(masked.text.includes(probe), `说明要点名被拦路径：${masked.text}`);
		assert.match(masked.text, /sandbox-boundary allow/, "要给出授权出口");
		assert.equal(fs.existsSync(probe), true, "越界文件必须仍在（说明不是放行）");
		assert.equal(fs.readFileSync(probe, "utf8"), "victim\n", "内容也不能变");
	} finally {
		if (fs.existsSync(probe)) fs.rmSync(probe);
	}
});

test("沙箱：成功命令的输出里出现 Operation not permitted 字样不算被拦（grep 不误报）", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// 误报对照组：查日志是常用操作，输出里带这几个字不该多出 [沙箱] 噪音。
	const logFile = path.join(projectDir, "denial-shaped.log");
	fs.writeFileSync(logFile, "rm: /Users/someone/else/file: Operation not permitted\n");
	try {
		const grepped = await runCommand(definition, `grep "Operation not permitted" ${JSON.stringify(logFile)}`, projectDir);
		assert.equal(grepped.ok, true, `grep 应当成功：${grepped.text}`);
		assert.match(grepped.text, /Operation not permitted/, "grep 的命中行本身要在");
		assert.ok(!/\[沙箱\]/.test(grepped.text), `不该追加沙箱说明：${grepped.text}`);
	} finally {
		if (fs.existsSync(logFile)) fs.rmSync(logFile);
	}
});

test("沙箱：越界 rmdir 同样被拒，目录仍在", { skip: sandboxSkip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	const probe = path.join(os.homedir(), `.sbx-rmdir-probe-${process.pid}-${Date.now()}`);
	fs.mkdirSync(probe);
	try {
		const denied = await runCommand(definition, `rmdir ${JSON.stringify(probe)}`, projectDir);
		assert.equal(denied.ok, false, "越界 rmdir 必须失败");
		assert.match(denied.text, /Operation not permitted|EPERM/);
		assert.equal(fs.existsSync(probe), true, "越界目录必须仍在");
	} finally {
		if (fs.existsSync(probe)) fs.rmdirSync(probe);
	}
});

test("沙箱：PI_SANDBOX=off 时命令不被包裹（越界删除会成功）", { skip }, async () => {
	assert.ok(pi);
	// 用 off 重新加载一份扩展：sandboxOn 是注册时读的，改 env 必须重新加载才生效。
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-nosbx-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(projectDir);
	const prev = process.env.PI_SANDBOX;
	process.env.PI_SANDBOX = "off";
	let offDefinition: BashToolDefinitionLike | undefined;
	try {
		const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, pi.createEventBus());
		assert.deepEqual(loaded.errors, [], "off 模式加载不该报错");
		offDefinition = loaded.extensions[0]?.tools.get("bash")?.definition;
	} finally {
		if (prev === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = prev;
	}
	assert.ok(offDefinition?.execute, "off 模式仍要注册 bash 工具");

	// 关掉沙箱后，越界删除不再被拦 —— 这正是 PI_SANDBOX=off 的语义。
	// 用本用例自己的临时目录当"越界"目标：它在 /tmp 下，但 offDefinition 的
	// 边界概念已经不存在，所以这里只验证"命令原样执行、没有 sandbox-exec 前缀"。
	const probe = path.join(root, "off-probe.txt");
	try {
		const r = await runCommand(offDefinition, `echo off > ${JSON.stringify(probe)}`, projectDir);
		assert.equal(r.ok, true, `off 模式下写 root 内文件应当成功：${r.text}`);
		assert.equal(fs.existsSync(probe), true);
		const del = await runCommand(offDefinition, `rm -f ${JSON.stringify(probe)}`, projectDir);
		assert.equal(del.ok, true, `off 模式下删除也应当成功：${del.text}`);
		assert.equal(fs.existsSync(probe), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("沙箱：dangerous 模式（plan-mode 三态）运行时关掉包裹，越界删除不再被拦", { skip }, async () => {
	assert.ok(cached);
	const { definition, projectDir } = cached;

	// 与 PI_SANDBOX=off 的区别：这里用的是**同一份已注册的扩展**（sandboxOn 在注册时
	// 就是 true），开关是运行期由 plan-mode 通过 sandbox-mode 单例翻的 —— 所以必须
	// 在执行期判定，注册期读一次就切不动了。
	//
	// 本用例刻意用 `{ skip }` 而不是 `{ skip: sandboxSkip }`：dangerous 的语义就是
	// **不包 seatbelt**，所以它不需要嵌套沙箱可用，在已处于沙箱中的进程里也能真跑
	//（bypass 下「越界删除被拒」的对照组由上面那个真沙箱用例负责）。
	const { getSandboxMode, resetSandboxModeForTesting, setSandboxMode } = await import(
		pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox-mode.ts")).href
	);
	resetSandboxModeForTesting();
	assert.equal(getSandboxMode(), "bypass", "单例默认应在 bypass（安全默认）");

	// 探针放在**仓库工作区**里，而不是像其他用例那样放 $HOME 或 tmp：
	// 扩展的边界跟着 ctx.cwd（= tmp 里的 projectDir）算，所以仓库目录对它而言是越界的；
	// 而在 pi 会话里跑测试时，外层沙箱恰好只放行仓库目录与 temp 根 —— temp 根两边都在
	// 边界内，区分不出东西。只有仓库目录能同时满足「扩展看来越界」+「外层沙箱可删」，
	// 于是本用例在普通终端与 pi 沙箱里跑出的结果一致。
	// 仓库根不能写死层数：上游快照里本文件在 `clients/pi/extensions/bash-command-collapse/`，
	// 独立仓库里只有 `extensions/bash-command-collapse/` —— 差两级，写死 `..` 会让探针落到 $HOME。
	// 改成往上找第一个含 `.git` 的目录，找不到就退回 process.cwd()（`npm test` 时即仓库根）。
	let repoRoot = path.dirname(fileURLToPath(import.meta.url));
	while (!fs.existsSync(path.join(repoRoot, ".git"))) {
		const parent = path.dirname(repoRoot);
		if (parent === repoRoot) {
			repoRoot = process.cwd();
			break;
		}
		repoRoot = parent;
	}
	const probe = path.join(repoRoot, `.sbx-dangerous-probe-${process.pid}-${Date.now()}.txt`);
	fs.writeFileSync(probe, "victim\n");
	try {
		// 对照组（bypass）：**两种环境下都应当失败**，所以它不需要嵌套沙箱可用 ——
		// 普通终端里是内核 EPERM（仓库根含 .git → 危险档 → 非交互 fail-closed），
		// 在 pi 会话里跑则是嵌套 sandbox_apply 直接失败。没有这一段，上面那句
		// 「dangerous 下删除成功」就可能是空断言。
		const denied = await runCommand(definition, `rm -f ${JSON.stringify(probe)}`, projectDir);
		assert.equal(denied.ok, false, `bypass 下越界删除必须失败：${denied.text}`);
		assert.equal(fs.existsSync(probe), true, "bypass 下文件必须仍在");

		setSandboxMode("dangerous");
		assert.equal(getSandboxMode(), "dangerous");
		// 同一条命令、同一个已注册扩展：不再被包裹，删除成功（pi 原生任意权限的语义）。
		const removed = await runCommand(definition, `rm -f ${JSON.stringify(probe)}`, projectDir);
		assert.equal(removed.ok, true, `dangerous 下越界删除应当成功：${removed.text}`);
		assert.ok(!/Operation not permitted|EPERM/.test(removed.text), "不该有沙箱拒绝的痕迹");
		assert.ok(!/\[沙箱\]/.test(removed.text), "dangerous 下不该有沙箱说明");
		assert.equal(fs.existsSync(probe), false, "文件应当真被删掉（不是只返回成功）");

		// 切回 bypass 后拦截立即恢复（运行期开关，不需重新加载扩展）。
		setSandboxMode("bypass");
		const again = path.join(repoRoot, `.sbx-dangerous-probe2-${process.pid}-${Date.now()}.txt`);
		fs.writeFileSync(again, "victim\n");
		try {
			const restored = await runCommand(definition, `rm -f ${JSON.stringify(again)}`, projectDir);
			assert.equal(restored.ok, false, `切回 bypass 后越界删除必须重新被拦：${restored.text}`);
			assert.equal(fs.existsSync(again), true, "文件必须仍在");
		} finally {
			if (fs.existsSync(again)) fs.rmSync(again);
		}
	} finally {
		if (fs.existsSync(probe)) fs.rmSync(probe);
		resetSandboxModeForTesting();
	}
});

/* ------------------------------------------------------------------ *
 * 两层授权（用户 2026-09-24 定）的端到端断言
 *
 * 跑的是真命令 + 真 seatbelt 沙箱 + 真弹框（脚本化的 ui.select）。
 * 越界目标全部用带 pid + 时间戳的探针名，由用例自己的 fs 建和清，
 * 不碰任何已有文件；白名单指向用例自己的临时文件，不碰用户真实的那份。
 * ------------------------------------------------------------------ */

test("两层授权：普通目录首次弹框→记住→真删掉→同目录第二次不弹框", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("ordinary");
	// 探针目录：$HOME 下、带随机后缀 —— 边界外但不在危险名单里（普通目录）。
	const dir = path.join(os.homedir(), `.sbx-ordinary-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	fs.writeFileSync(first, "a\n");
	fs.writeFileSync(second, "b\n");
	try {
		// 第一次：弹框，选 `Allow for this session（并记住该目录）`
		const ctx1 = execCtxUI(fx.projectDir, ["Allow for this session（并记住该目录）"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `批准后应当删成功：${r1.text}`);
		assert.equal(fs.existsSync(first), false, "文件真的被删了（不是只返回成功）");
		assert.equal(ctx1.selects.length, 1, "应当弹一次框");
		assert.ok(ctx1.selects[0]!.title.includes("边界外"), `弹框标题：${ctx1.selects[0]!.title}`);
		assert.deepEqual(
			ctx1.selects[0]!.options,
			["Deny", "Allow for this session（并记住该目录）", "Allow once"],
			"普通目录的三选项",
		);
		assert.ok(ctx1.selects[0]!.title.includes("危险") === false, "普通目录不该走危险弹框");

		// 落盘：白名单里应当有这个目录（不是那个文件）
		const onDisk = JSON.parse(fs.readFileSync(fx.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [dir], "记住的是父目录");

		// 第二次：同目录另一个文件 —— profile 已带上白名单根，沙箱内直接成功，**不弹框**
		const ctx2 = execCtxUI(fx.projectDir, []);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, true, `第二次不该被拦：${r2.text}`);
		assert.equal(fs.existsSync(second), false);
		assert.equal(ctx2.selects.length, 0, "已记住的目录不再弹框（这就是本功能的意义）");
		assert.equal(ctx2.confirms.length, 0);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("两层授权：`Allow once` 删得掉但不落盘，同目录第二次仍弹框", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("once");
	const dir = path.join(os.homedir(), `.sbx-once-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	fs.writeFileSync(first, "a\n");
	fs.writeFileSync(second, "b\n");
	try {
		const ctx1 = execCtxUI(fx.projectDir, ["Allow once"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `本次批准应当删成功：${r1.text}`);
		assert.equal(fs.existsSync(first), false);
		assert.equal(fs.existsSync(fx.allowlistFile), false, "`Allow once` 不该落盘");

		const ctx2 = execCtxUI(fx.projectDir, ["Deny"]);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, false, "没记住 → 第二次仍被拦");
		assert.equal(ctx2.selects.length, 1, "第二次仍弹框");
		assert.equal(fs.existsSync(second), true, "Deny 后文件必须仍在");
		assert.match(r2.text, /用户拒绝/, `拒绝理由要给人看：${r2.text}`);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("两层授权：危险目录每次都弹，选 `Allow for this session` 后不弹，重新加载扩展后又弹", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("dangerous");
	// 危险目录：~/Library 在 DANGEROUS_HOME_DIRS 里（子树语义）。
	// 探针建在它下面，用例自己清掉 —— 不碰 ~/Library 里任何已有内容。
	const dir = path.join(os.homedir(), "Library", `.sbx-dangerous-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const first = path.join(dir, "a.txt");
	const second = path.join(dir, "b.txt");
	const third = path.join(dir, "c.txt");
	for (const f of [first, second, third]) fs.writeFileSync(f, "x\n");
	try {
		// 第一次：危险弹框，三选项与普通弹框不同
		const ctx1 = execCtxUI(fx.projectDir, ["Allow once"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `批准后应当删成功：${r1.text}`);
		assert.equal(fs.existsSync(first), false);
		assert.equal(ctx1.selects.length, 1);
		assert.ok(ctx1.selects[0]!.title.includes("危险目录"), `危险弹框标题：${ctx1.selects[0]!.title}`);
		assert.deepEqual(
			ctx1.selects[0]!.options,
			["Deny", "Allow once", "Allow for this session"],
			"危险目录没有「记住」选项",
		);
		assert.equal(fs.existsSync(fx.allowlistFile), false, "危险目录永远不落盘");

		// 第二次：仍是危险目录 → 仍弹框（这就是「每次必问」）
		const ctx2 = execCtxUI(fx.projectDir, ["Allow for this session"]);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, true, `会话豁免应当放行：${r2.text}`);
		assert.equal(ctx2.selects.length, 1, "危险目录第二次仍弹框");
		assert.equal(fs.existsSync(second), false);
		assert.equal(fs.existsSync(fx.allowlistFile), false, "会话豁免也不落盘");

		// 第三次：本会话已豁免 → 不弹框，profile 带上会话根后沙箱内直接成功
		const ctx3 = execCtxUI(fx.projectDir, []);
		const r3 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(third)}`, ctx3);
		assert.equal(r3.ok, true, `会话豁免后不该再被拦：${r3.text}`);
		assert.equal(ctx3.selects.length, 0, "会话豁免后不再弹框");
		assert.equal(fs.existsSync(third), false);

		// 会话豁免不落盘 → 重新加载一份扩展（模拟重启 pi）后又弹框。
		// 新实例读的是同一个空白名单文件，而会话 scope 是 globalThis 单例 ——
		// 所以这里先清掉它，模拟「重启后会话状态没了」。
		const { getSessionScopes } = await import("./allowlist.ts");
		getSessionScopes().clear();
		const fourth = path.join(dir, "d.txt");
		fs.writeFileSync(fourth, "x\n");
		const ctx4 = execCtxUI(fx.projectDir, ["Deny"]);
		const r4 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(fourth)}`, ctx4);
		assert.equal(r4.ok, false, "重启后危险目录恢复必问");
		assert.equal(ctx4.selects.length, 1, "又弹框了");
		assert.equal(fs.existsSync(fourth), true);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		const { getSessionScopes } = await import("./allowlist.ts");
		getSessionScopes().clear();
		fx.restore();
	}
});

test("两层授权：headless + 预置白名单 → 删除成功且不弹框", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("headless-allow");
	const dir = path.join(os.homedir(), `.sbx-headless-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	// 预置白名单：模拟用户之前在交互会话里批准过这个目录
	fs.writeFileSync(
		fx.allowlistFile,
		JSON.stringify({ version: 1, entries: [{ path: dir, addedAt: new Date().toISOString(), source: "confirm" }] }),
		"utf8",
	);
	try {
		// 重新加载一份扩展，让它读到预置的白名单（store 是单例缓存，按文件路径 keyed，
		// 而 loadSandboxFixture 的临时文件路径是新的，所以新实例会读盘）
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, true, `headless 下白名单应当生效：${r.text}`);
		assert.equal(fs.existsSync(target), false, "文件真被删了");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("两层授权：headless + 危险目录 → fail-closed 拒绝，文件仍在", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("headless-danger");
	const dir = path.join(os.homedir(), "Library", `.sbx-headless-danger-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	try {
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, false, "headless 下危险目录必须拒");
		assert.match(r.text, /非交互环境/, `理由要点明环境：${r.text}`);
		assert.equal(fs.existsSync(target), true, "文件必须仍在");
		assert.equal(fs.readFileSync(target, "utf8"), "a\n", "内容也不能变");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("永不删除：删 ~/.gnupg 下的探针不弹框、直接拒，文件仍在", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("never-delete");
	// 探针建在 ~/.gnupg（永不删除子树）下，由测试进程自己的 fs 创建（不走沙箱），
	// finally 里也由它自己清掉 —— 不碰 ~/.gnupg 里任何已有内容。
	const dir = path.join(os.homedir(), ".gnupg", `.sbx-never-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		// 给足「放行」选项：如果它真弹框并选了放行，这个用例就会失败 ——
		// 断言的正是「根本没有放行选项可给」。
		const ctx = execCtxUI(fx.projectDir, ["Allow for this session", "Allow once"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)}`, ctx);
		assert.equal(r.ok, false, "永不删除必须失败");
		assert.match(r.text, /永不删除/, `理由要点名档位：${r.text}`);
		assert.equal(ctx.selects.length, 0, "不弹框 —— 没有放行选项");
		assert.equal(ctx.confirms.length, 0);
		assert.equal(fs.existsSync(target), true, "文件必须仍在");
		assert.equal(fs.readFileSync(target, "utf8"), "victim\n", "内容也不能变");
		assert.equal(fs.existsSync(fx.allowlistFile), false, "什么都不落盘");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("永不删除：headless 下同样拒，且理由点名档位", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("never-delete-headless");
	const dir = path.join(os.homedir(), ".gnupg", `.sbx-never-h-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, false, "headless 下永不删除照样拒");
		assert.match(r.text, /永不删除/, `理由要点名档位：${r.text}`);
		assert.equal(fs.existsSync(target), true, "文件必须仍在");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("永不删除：嵌套条目 ~/.config/gh 下的探针同样拦死（2026-09-25 补充）", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("never-delete-nested");
	// ~/.config 整棵子树是普通档（用户 2026-09-25），但嵌套条目 .config/gh 把
	// gh token 所在目录捞回永不删除档 —— 断言的正是这个「捞回」真的生效。
	// 探针目录由测试进程自己的 fs 建清（recursive 只建到探针自己，finally 也只删探针自己）。
	const dir = path.join(os.homedir(), ".config", "gh", `.sbx-never-n-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		const ctx = execCtxUI(fx.projectDir, ["Allow for this session", "Allow once"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)}`, ctx);
		assert.equal(r.ok, false, "嵌套的永不删除子树必须失败");
		assert.match(r.text, /永不删除/, `理由要点名档位：${r.text}`);
		assert.equal(ctx.selects.length, 0, "不弹框 —— 没有放行选项");
		assert.equal(fs.existsSync(target), true, "文件必须仍在");
		assert.equal(fs.readFileSync(target, "utf8"), "victim\n", "内容也不能变");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("工具状态目录：删 ~/.pi/agent 下的探针弹三选项框，记住后不再问（用户 2026-09-25）", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("pi-agent-ordinary");
	// 复现 pi update --extensions 被拦的形状：~/.pi/agent 下的 stale lock。
	// 探针由测试进程自己的 fs 建和清，不碰 ~/.pi/agent 里任何已有内容。
	const dir = path.join(os.homedir(), ".pi", "agent", `.sbx-pi-${process.pid}-${Date.now()}.lock`);
	fs.mkdirSync(dir);
	const first = path.join(dir, "a");
	const second = path.join(dir, "b");
	fs.writeFileSync(first, "a\n");
	fs.writeFileSync(second, "b\n");
	try {
		const ctx1 = execCtxUI(fx.projectDir, ["Allow for this session（并记住该目录）"]);
		const r1 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(first)}`, ctx1);
		assert.equal(r1.ok, true, `批准后应当删成功：${r1.text}`);
		assert.equal(fs.existsSync(first), false, "文件真的被删了");
		assert.equal(ctx1.selects.length, 1, "应当弹一次框（不再是永不删除的直接拒）");
		assert.deepEqual(
			ctx1.selects[0]!.options,
			["Deny", "Allow for this session（并记住该目录）", "Allow once"],
			"普通目录的三选项",
		);
		// 落盘的是目标的父目录（memoryScopeFor 口径：文件记父目录）—— 临时白名单文件，不碰用户真实的那份
		const onDisk = JSON.parse(fs.readFileSync(fx.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [dir], "记住的是父目录");

		// 第二次：同目录 —— profile 已带上白名单根，沙箱内直接成功，不弹框
		const ctx2 = execCtxUI(fx.projectDir, []);
		const r2 = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(second)}`, ctx2);
		assert.equal(r2.ok, true, `已记住的目录不该再拦：${r2.text}`);
		assert.equal(ctx2.selects.length, 0);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("可再生缓存：删 ~/.cache 下的探针静默成功，不弹框", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("safe-cache");
	// ~/.cache 在可删边界内（SAFE_CACHE_HOME_DIRS）—— 删了能重建，不该打扰用户。
	const dir = path.join(os.homedir(), ".cache", `.sbx-cache-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, "probe.txt");
	fs.writeFileSync(target, "x\n");
	try {
		const ctx = execCtxUI(fx.projectDir, []);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)} && echo removed`, ctx);
		assert.equal(r.ok, true, `缓存目录在可删边界内，应当直接成功：${r.text}`);
		assert.match(r.text, /removed/);
		assert.equal(fs.existsSync(target), false, "文件真被删了");
		assert.equal(ctx.selects.length, 0, "不弹框");
		assert.equal(ctx.confirms.length, 0);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("两层授权：headless + 未授权的普通目录 → 也 fail-closed", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("headless-ordinary");
	const dir = path.join(os.homedir(), `.sbx-headless-ord-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	try {
		const r = await runCommand(fx.definition, `rm -f ${JSON.stringify(target)}`, fx.projectDir);
		assert.equal(r.ok, false, "没人在屏幕前，普通目录也不能默认同意");
		assert.match(r.text, /未授权/, `理由要点明未授权：${r.text}`);
		assert.equal(fs.existsSync(target), true);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("两层授权：一条命令里混有已授权与未授权路径 → 仍弹框（全部命中才自动放行）", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("mixed");
	const allowedDir = path.join(os.homedir(), `.sbx-mixed-allow-${process.pid}-${Date.now()}`);
	const otherDir = path.join(os.homedir(), `.sbx-mixed-other-${process.pid}-${Date.now()}`);
	fs.mkdirSync(allowedDir);
	fs.mkdirSync(otherDir);
	const a = path.join(allowedDir, "a.txt");
	const b = path.join(otherDir, "b.txt");
	fs.writeFileSync(a, "a\n");
	fs.writeFileSync(b, "b\n");
	fs.writeFileSync(
		fx.allowlistFile,
		JSON.stringify({ version: 1, entries: [{ path: allowedDir, addedAt: new Date().toISOString(), source: "confirm" }] }),
		"utf8",
	);
	try {
		// 两个目标一起删：已授权那个在沙箱内成功，未授权那个被拦 → 命令失败并弹框。
		// 弹框里只该出现未授权的那个（已授权的不该再问）。
		const ctx = execCtxUI(fx.projectDir, ["Deny"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(a)} ${JSON.stringify(b)}`, ctx);
		assert.equal(r.ok, false, "有未授权路径 → 不能静默放行整条命令");
		assert.equal(ctx.selects.length, 1, "应当弹框");
		assert.ok(ctx.selects[0]!.title.includes("边界外"), `弹框标题：${ctx.selects[0]!.title}`);
		assert.equal(fs.existsSync(b), true, "Deny 后未授权的文件必须仍在");
	} finally {
		for (const d of [allowedDir, otherDir]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
		fx.restore();
	}
});

test("两层授权：抽不出被拦路径（cd + 相对路径）→ 不弹框、不裸跑、原样报错", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("unparsed");
	const dir = path.join(os.homedir(), `.sbx-unparsed-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "a\n");
	try {
		// `cd` 到边界外再用**相对路径**删：BSD rm 报的是 `rm: a.txt: Operation not permitted`，
		// 里面没有绝对路径 —— extractDeniedPaths 刻意不认相对路径（猜不出绝对目标）。
		// 这是模型真实会写的形状（`cd X && rm -f y`），不是人造的极端用例。
		//
		// 旧行为：按整条命令会话级问一次（confirm），同意后整条命令在沙箱外裸跑。
		// 新行为（2026-09-24）：不弹框、不裸跑 —— 认不出目标就不许拿整条命令去换
		// 整层边界之外的删除能力。出口是 /sandbox-boundary allow <目录>。
		const ctx = execCtxUI(fx.projectDir, [], [true]);
		const r = await runCommandWithCtx(fx.definition, `cd ${JSON.stringify(dir)} && rm -f a.txt`, ctx);
		assert.equal(r.ok, false, "抽不出路径 → 命令保持失败");
		assert.equal(ctx.confirms.length, 0, "不再走 confirm（沙箱外重跑降级路径已删）");
		assert.equal(ctx.selects.length, 0, "也不走 select（认不出路径就无法分危险/普通）");
		assert.ok(r.text.includes("[沙箱] 认不出被拦的具体路径"), `报错要带 [沙箱] 提示：${r.text}`);
		assert.ok(r.text.includes("/sandbox-boundary allow"), `提示里要给出路：${r.text}`);
		assert.equal(fs.existsSync(target), true, "文件必须仍在（什么都没跑成）");
		assert.equal(fs.existsSync(fx.allowlistFile), false, "什么都没落盘");

		// 同一条命令再跑一次：行为不变（没有会话级批准这回事了）
		const ctx2 = execCtxUI(fx.projectDir, [], [true]);
		const r2 = await runCommandWithCtx(fx.definition, `cd ${JSON.stringify(dir)} && rm -f a.txt`, ctx2);
		assert.equal(r2.ok, false, "第二次同样失败 —— 不再有「会话内已批准」");
		assert.equal(ctx2.confirms.length, 0);
		assert.equal(fs.existsSync(target), true);
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

test("沙箱内 heredoc 成功（/var/tmp 在可删边界内）", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("heredoc");
	try {
		// bash 3.2 的 heredoc 必须先建 /var/tmp/sh-thd-* 再 unlink（delete-on-open）。
		// /var/tmp 进可删边界前这里 100% 失败（2026-09-24 实测），且每次泄漏一个 sh-thd-*。
		const before = fs.readdirSync("/private/var/tmp").filter((n) => n.startsWith("sh-thd-")).length;
		const ctx = execCtxUI(fx.projectDir, []);
		const r = await runCommandWithCtx(fx.definition, 'cat <<EOF\nhello heredoc\nEOF', ctx);
		assert.equal(r.ok, true, `heredoc 应当成功：${r.text}`);
		assert.ok(r.text.includes("hello heredoc"), "heredoc 正文要原样输出");
		assert.equal(ctx.selects.length, 0, "不该弹框");
		assert.equal(ctx.confirms.length, 0, "不该 confirm");
		const after = fs.readdirSync("/private/var/tmp").filter((n) => n.startsWith("sh-thd-")).length;
		// 用 <= 而不是 ==：本次运行不该新增（旧行为是 100% 泄漏），但系统清理掉
		// 一个旧的不该让用例假失败。
		assert.ok(after <= before, `不再泄漏 sh-thd-* 临时文件（before=${before} after=${after}）`);
	} finally {
		fx.restore();
	}
});

test("输出含 EPERM 但无删除形状 → 不弹框、不 confirm、带 [沙箱] 提示", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("exec-failure");
	try {
		// setuid / platform binary 在沙箱内 exec 直接 EPERM —— 不是删除，不该弹删除框。
		// /bin/ps 是 setuid，沙箱内必失败；输出形状 `bash: /bin/ps: Operation not permitted`
		// 被排除 2（shell prog）拦下，extractDeniedPaths 返回空 → 不弹框。
		const ctx = execCtxUI(fx.projectDir, []);
		const r = await runCommandWithCtx(fx.definition, "/bin/ps -o pid= 2>&1; exit 1", ctx);
		assert.equal(r.ok, false, "命令本身失败（exec EPERM）");
		assert.equal(ctx.selects.length, 0, "exec 失败不是删除，不弹 select");
		assert.equal(ctx.confirms.length, 0, "也不 confirm（沙箱外重跑降级路径已删）");
		assert.ok(r.text.includes("[沙箱] 认不出被拦的具体路径"), `报错要带 [沙箱] 提示：${r.text}`);
	} finally {
		fx.restore();
	}
});

test("两层授权：Deny 后文件仍在、内容不变，且什么都没落盘", { skip: sandboxSkip }, async () => {
	const fx = await loadSandboxFixture("deny");
	const dir = path.join(os.homedir(), `.sbx-deny-${process.pid}-${Date.now()}`);
	fs.mkdirSync(dir);
	const target = path.join(dir, "a.txt");
	fs.writeFileSync(target, "victim\n");
	try {
		const ctx = execCtxUI(fx.projectDir, ["Deny"]);
		const r = await runCommandWithCtx(fx.definition, `rm -f ${JSON.stringify(target)}`, ctx);
		assert.equal(r.ok, false);
		assert.equal(fs.existsSync(target), true, "Deny 后文件必须仍在");
		assert.equal(fs.readFileSync(target, "utf8"), "victim\n", "内容也不能变");
		assert.equal(fs.existsSync(fx.allowlistFile), false, "Deny 不该落盘");
		assert.ok(ctx.notifies.length === 0, "Deny 不该发 notify");
	} finally {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		fx.restore();
	}
});

