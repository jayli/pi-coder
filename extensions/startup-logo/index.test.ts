/**
 * Tests for startup-logo/index.ts — 「启动 header 的 logo」与「剪掉整份启动清单」这条链路。
 *
 * Run with:  node --test clients/pi/extensions/startup-logo/index.test.ts
 *
 * pi 自己的扩展加载器真的加载 `index.ts`（import 面、事件注册面都在覆盖范围内），假的是扩展
 * 外面的一切：`ctx.ui.setHeader` 按 pi 的行为同步建组件并挂进假 header 容器，`ctx` 是一个
 * 最小对象。于是「装 header → 认容器 → 接管已加载资源清单」这条链能被完整摆出来。
 *
 * 这里**不**覆盖 pi 内部真实行为（渲染节流、换会话冻结窗口、诊断段），那些靠
 * `header-guard.test.ts` / `loaded-sections.test.ts` 的纯逻辑用例与本机实测。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MARK_WIDTH } from "./logo.ts";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

/**
 * pi 的库入口（非 CLI）：bundle 是 `pi` 实际跑的形态，dist 是 node 构建形态。
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
const skip = piEntry === undefined ? SKIP : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function createTestBus(): { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void } {
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
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
}

/** 形状照 pi-tui：`children` 是公开数组，`addChild` 住数组尾部推。 */
class FakeContainer {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => (child as { render(w: number): string[] }).render(width));
	}
}

class FakeSection {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	render(_width: number): string[] {
		return [`\u001b[38;2;121;214;193m[${this.name}]\u001b[39m`, `  ${this.name} 的内容`, ""];
	}
}

class FakeSpacer {
	render(_width: number): string[] {
		return [""];
	}
}

interface FakeTui {
	children: unknown[];
	headerContainer: FakeContainer;
	loadedResourcesContainer: FakeContainer;
	chatContainer: FakeContainer;
	documentContainer: FakeContainer;
	/** 当前挂着的 header 组件（`setHeader(undefined)` 之后是 undefined）。 */
	headerComponent: unknown;
}

function createFakeTui(): FakeTui {
	const headerContainer = new FakeContainer();
	const loadedResourcesContainer = new FakeContainer();
	const chatContainer = new FakeContainer();
	const documentContainer = new FakeContainer();
	documentContainer.addChild(headerContainer);
	documentContainer.addChild(loadedResourcesContainer);
	documentContainer.addChild(chatContainer);
	return {
		children: [documentContainer],
		headerContainer,
		loadedResourcesContainer,
		chatContainer,
		documentContainer,
		headerComponent: undefined,
	};
}

/** 主题：恒等上色（剥 ANSI 后就是纯文本，宽度口径跟真实主题一致）。 */
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
};

function createContext(tui: FakeTui): { ctx: unknown; setHeaderCalls: number } {
	const state = { setHeaderCalls: 0 };
	const ui = {
		theme: fakeTheme,
		// pi 的 setExtensionHeader 是同步建组件 + 挂进容器，这里照做（顺序对扩展可见）。
		setHeader(factory?: (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void }) {
			state.setHeaderCalls += 1;
			const children = tui.headerContainer.children;
			const index = children.indexOf(tui.headerComponent);
			if (index >= 0) children.splice(index, 1);
			tui.headerComponent = undefined;
			if (!factory) return;
			const component = factory(tui, fakeTheme);
			tui.headerComponent = component;
			children.push(component);
		},
		notify() {},
	};
	return { ctx: { mode: "tui", hasUI: true, cwd: "/Users/someone/proj", ui }, setHeaderCalls: state.setHeaderCalls };
}

interface LoadedExtension {
	handlers: Map<string, Handler[]>;
	commands: Map<string, unknown>;
	errors: Array<{ path: string; error: string }>;
}

/** 用 pi 自己的加载器加载本扩展（`./logo.ts` / `./loaded-sections.ts` 的 import 也一起验证）。 */
async function loadExtension(agentDir: string, projectDir: string): Promise<LoadedExtension> {
	const pi = (await import(pathToFileURL(piEntry as string).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, createTestBus());
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	return extension;
}

function makeWorkspace(): { agentDir: string; projectDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-logo-"));
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

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

const sectionTitlesIn = (container: FakeContainer): string[] =>
	container.children
		.flatMap((child) => {
			const lines = (child as { render(w: number): string[] }).render(80);
			const first = stripAnsi(lines[0] ?? "").trim();
			const match = /^\[([^[\]]+)\]$/.exec(first);
			return match ? [match[1]!] : [];
		})
		.filter((title) => title.length > 0);

test("扩展注册面：只有会话事件，不再有 `/logo` 命令", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir);
		assert.equal(extension.commands.size, 0, "`/logo` 命令已按用户要求去掉");
		assert.equal(extension.commands.has("logo"), false);
		for (const event of ["session_start", "session_tree", "session_shutdown"]) {
			assert.ok(extension.handlers.get(event)?.length, `应该注册了 ${event}`);
		}
	} finally {
		workspace.cleanup();
	}
});

test("session_start：header 是 logo（每行缩进一格、没有 /logo 提示），整份清单被剪空", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir);
		const sessionStart = extension.handlers.get("session_start")?.[0];
		assert.ok(sessionStart);
		const tui = createFakeTui();
		const { ctx } = createContext(tui);

		await sessionStart({}, ctx);
		assert.ok(tui.headerComponent, "session_start 应该装上 logo header");

		const lines = (tui.headerComponent as { render(w: number): string[] }).render(80);
		const plain = lines.map(stripAnsi);
		// 前四行是印记：每行都以留白开头，第 0/3 行（没挂侧栏）等宽
		for (const line of plain.slice(0, 4)) assert.ok(line.startsWith(" "), `印记行不能顶格：${JSON.stringify(line)}`);
		assert.equal(plain[0]!.length, MARK_WIDTH, "没挂侧栏的印记行就是整行宽度");
		assert.equal(plain[3]!.length, MARK_WIDTH, "没挂侧栏的印记行就是整行宽度");
		// 挂侧栏的第 1/2 行：侧栏贴在同一列（MARK_WIDTH + 2），所以列对齐
		assert.ok(plain[1]?.includes("pi v"), "侧栏应该带版本号");
		assert.equal(plain[1]!.indexOf("pi v"), MARK_WIDTH + 2, "版本号应该贴在第 MARK_WIDTH + 2 列");
		assert.ok(plain.some((line) => line.includes("/Users/someone/proj")), "侧栏应该带 cwd");
		assert.ok(plain.some((line) => line.includes("Pi can explain its own features")), "说明行应该保留");
		assert.equal(plain.some((line) => line.includes("/logo")), false, "`/logo toggles this header.` 提示已删掉");

		// 已加载资源清单：按 pi 的顺序填，四段连同各自的空行都不该进去（含开头那个额外空行）
		const { loadedResourcesContainer: loaded } = tui;
		loaded.addChild(new FakeSpacer());
		for (const name of ["Context", "Skills", "Prompts", "Extensions"]) {
			loaded.addChild(new FakeSection(name));
			loaded.addChild(new FakeSpacer());
		}
		assert.deepEqual(sectionTitlesIn(loaded), []);
		assert.equal(loaded.children.length, 0, "连开头那个额外空行也收掉，不留多余留白");
	} finally {
		workspace.cleanup();
	}
});

test("session_tree 重装 header：接管幂等，诊断段仍照常显示", { skip, timeout: 30_000 }, async () => {
	const workspace = makeWorkspace();
	try {
		const extension = await loadExtension(workspace.agentDir, workspace.projectDir);
		const sessionStart = extension.handlers.get("session_start")?.[0];
		const sessionTree = extension.handlers.get("session_tree")?.[0];
		assert.ok(sessionStart && sessionTree);
		const tui = createFakeTui();
		const { ctx } = createContext(tui);

		await sessionStart({}, ctx);
		await sessionTree({}, ctx);
		assert.equal(tui.headerContainer.children.filter((child) => child === tui.headerComponent).length, 1, "只应挂一个 header");

		// /reload 形态：清空后重新填一份
		tui.loadedResourcesContainer.children = [];
		tui.loadedResourcesContainer.addChild(new FakeSection("Themes"));
		tui.loadedResourcesContainer.addChild(new FakeSpacer());
		tui.loadedResourcesContainer.addChild(new FakeSection("Skills"));
		tui.loadedResourcesContainer.addChild(new FakeSpacer());
		tui.loadedResourcesContainer.addChild(new FakeSection("Skill conflicts"));
		assert.deepEqual(sectionTitlesIn(tui.loadedResourcesContainer), ["Skill conflicts"]);
	} finally {
		workspace.cleanup();
	}
});
