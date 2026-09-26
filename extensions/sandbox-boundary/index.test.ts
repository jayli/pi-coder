/**
 * Tests for sandbox-boundary/index.ts — 用 pi 自己的加载器真实加载扩展，
 * 把真实的 `tool_call` 事件喂进去，断言放行 / 确认 / 拦截三种结果。
 *
 * Run with:  node --test clients/pi/extensions/sandbox-boundary/index.test.ts
 *
 * 断言口径（用户 2026-09-24 定，同日收窄到「只管删除」，后又加了两层授权、再加「永不删除」档）：
 *   - **写入一律不拦**：write / edit / multiedit 无论目标在边界内外都直接放行、不弹窗；
 *   - apply_patch 只看 `*** Delete File:` 行：
 *     - 删除目标在边界内（项目目录、/tmp、可再生缓存 ~/.cache 等）→ 直接放行；
 *     - **永不删除**（`~/.zshrc`、`~/.ssh/…`、`~/.gnupg/…`、嵌套条目 `~/.config/gh/…`
 *       `~/.config/gcloud/…` 等身份/凭据/手写配置；`~/.config` `~/.pi` `~/.claude` `~/.codex`
 *       自身自 2026-09-25 起是普通档）→ **不弹框、无任何放行选项**，直接 block；整份 patch 一起拒；
 *     - **危险路径**（系统根、`~/Library/…`、含 `.git` 的路径…）→ 每次必问，
 *       选项是 Deny / Allow once / Allow for this session（没有「记住」）；
 *     - **普通边界外路径**（`~/Downloads/x` 这类）→ 问一次，选项是
 *       Deny / Allow for this session（并记住该目录）/ Allow once；记住后落盘，下次不弹；
 *     - `Update File` / `Add File` 是写入，边界外也放行；
 *   - 只读工具（read/grep）与认不出删除目标的工具一律放行；
 *   - 非交互环境：持久白名单生效（命中则放行），永不删除与危险/普通未授权都 fail-closed 直接 block；
 *   - PI_SANDBOX=off 时整个钩子不生效；
 *   - plan-mode 的 dangerous 模式（运行期单例）同样让钩子不生效 —— 包括永不删除档。
 *
 * 注意 harness 的 projectDir 在 /tmp 下（mkdtempSync），本身就在可删边界内 ——
 * 所以"边界内"用例用 projectDir 下的路径，"边界外"用例用 $HOME 下的路径。
 * 白名单指向 harness 自己的临时文件（`PI_SANDBOX_ALLOWLIST`），不碰用户真实的那份；
 * 会话豁免是 globalThis 单例，每个用例前后都要清，否则跨用例残留会污染判定。
 * 找不到本机 pi 的库入口就整体 skip（不假装通过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";
const HOME = os.homedir();

/**
 * 找 pi 的库入口：先从 `pi` 可执行文件反查真正的安装位置（pnpm/npm 的 shim 脚本里留有
 * `# cmd-shim-target=<绝对路径>`；npm 在 Unix 上则是符号链接，两种都试），再退回
 * `~/.pi/agent/npm` 那份副本 —— 判定方式是能不能真 import。全都不行就返回 undefined，整体 skip。
 * （与 bash-command-collapse/render.test.ts 同一套逻辑。）
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

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;

interface Verdict {
	block?: boolean;
	reason?: string;
}

interface Harness {
	cwd: string;
	/** 弹过的 select（两层授权的主弹框）。 */
	selects: Array<{ title: string; options: string[] }>;
	confirms: Array<{ title: string; message: string }>;
	notifies: string[];
	/** 本 harness 的白名单文件路径。 */
	allowlistFile: string;
	cleanup: () => void;
	/** 喂一个 tool_call 事件，返回拦截结果（{} = 放行）。 */
	call(toolName: string, input: Record<string, unknown>): Promise<Verdict>;
	/** 跑 /sandbox-boundary 命令（可带子命令参数）。 */
	runCommand(args?: string): Promise<void>;
}

/**
 * 用 pi 的加载器真实加载扩展。`selections` 按顺序回放用户在 select 里的选择，
 * `confirmAnswer` 给旧的 confirm 分支用（现已不走，留着防回归）。
 */
async function loadHarness(
	options: { hasUI?: boolean; selections?: string[]; confirmAnswer?: boolean; seedAllowlist?: string[] } = {},
): Promise<Harness> {
	const { hasUI = true, selections = [], confirmAnswer = true, seedAllowlist } = options;
	const pi = (await import(pathToFileURL(piEntry!).href)) as {
		discoverAndLoadExtensions: (
			configuredPaths: string[],
			cwd: string,
			agentDir?: string,
			eventBus?: unknown,
		) => Promise<{ extensions: LoadedExtension[]; errors: Array<{ path: string; error: string }> }>;
	};

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-boundary-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	const allowlistFile = path.join(root, "sandbox-allowlist.json");
	if (seedAllowlist) {
		fs.writeFileSync(
			allowlistFile,
			JSON.stringify({
				version: 1,
				entries: seedAllowlist.map((p) => ({ path: p, addedAt: new Date().toISOString(), source: "confirm" })),
			}),
			"utf8",
		);
	}

	// 白名单指向自己的临时文件；会话豁免（globalThis 单例）清空。
	const prevAllowlist = process.env.PI_SANDBOX_ALLOWLIST;
	process.env.PI_SANDBOX_ALLOWLIST = allowlistFile;
	const { getSessionScopes, resetAllowlistStoreCache } = await import("../bash-command-collapse/allowlist.ts");
	resetAllowlistStoreCache();
	getSessionScopes().clear();

	const bus = { on: () => () => undefined, emit: () => undefined };
	const loaded = await pi.discoverAndLoadExtensions([EXTENSION_PATH], projectDir, agentDir, bus);
	if (prevAllowlist === undefined) delete process.env.PI_SANDBOX_ALLOWLIST;
	else process.env.PI_SANDBOX_ALLOWLIST = prevAllowlist;
	assert.deepEqual(loaded.errors, [], "pi 的扩展加载器不应该报错");
	const extension = loaded.extensions[0];
	assert.ok(extension, "应该加载到一个扩展");

	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const notifies: string[] = [];
	const queue = [...selections];
	const ctx = {
		mode: "tui",
		hasUI,
		cwd: projectDir,
		ui: {
			notify: (text: string) => notifies.push(text),
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				return queue.shift();
			},
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return confirmAnswer;
			},
		},
	};

	return {
		cwd: projectDir,
		selects,
		confirms,
		notifies,
		allowlistFile,
		cleanup: () => {
			getSessionScopes().clear();
			resetAllowlistStoreCache();
			fs.rmSync(root, { recursive: true, force: true });
		},
		async call(toolName: string, input: Record<string, unknown>): Promise<Verdict> {
			for (const handler of extension.handlers.get("tool_call") ?? []) {
				const verdict = (await handler({ toolName, input }, ctx)) as Verdict | undefined;
				if (verdict?.block) return verdict;
			}
			return {};
		},
		async runCommand(args = ""): Promise<void> {
			const command = extension.commands.get("sandbox-boundary");
			assert.ok(command, "应当注册 /sandbox-boundary 命令");
			await command.handler(args, ctx);
		},
	};
}

interface LoadedExtension {
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

test("写入一律放行：write 到边界外也不弹窗", { skip }, async () => {
	const h = await loadHarness();
	try {
		const verdict = await h.call("write", { path: `${HOME}/.zshrc`, content: "x" });
		assert.deepEqual(verdict, {}, "写入不拦，哪怕在边界外");
		assert.equal(h.confirms.length, 0, "写入一次都不该弹窗");
	} finally {
		h.cleanup();
	}
});

test("写入一律放行：edit / multiedit 到边界外也不弹窗", { skip }, async () => {
	const h = await loadHarness();
	try {
		assert.deepEqual(await h.call("edit", { path: `${HOME}/.gitconfig`, oldText: "a", newText: "b" }), {});
		assert.deepEqual(await h.call("multiedit", { path: `${HOME}/.config/foo`, edits: [] }), {});
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("apply_patch：边界内删除直接放行，不弹窗", { skip }, async () => {
	const h = await loadHarness();
	try {
		const patch = `*** Delete File: ${path.join(h.cwd, "old.ts")}\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.deepEqual(verdict, {}, "边界内删除不该拦");
		assert.equal(h.selects.length, 0, "边界内一次都不该弹窗");
		assert.equal(h.confirms.length, 0);
		assert.equal(h.notifies.length, 0, "边界内也不该 notify（那是绝大多数操作）");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：危险路径（~/Library）弹危险框，没有「记住」选项，同意则放行", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once"] });
	try {
		const patch = `*** Delete File: ${HOME}/Library/Preferences/sbx-probe.plist\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.deepEqual(verdict, {}, "同意后应放行");
		assert.equal(h.selects.length, 1, "应当弹一次框");
		assert.match(h.selects[0].title, /危险目录/, "~/Library 是危险档（必问可豁免）");
		assert.deepEqual(h.selects[0].options, ["Deny", "Allow once", "Allow for this session"], "危险目录没有「记住」选项");
		assert.ok(h.selects[0].title.includes("可删边界之外"));
		assert.equal(fs.existsSync(h.allowlistFile), false, "危险路径永远不落盘");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：永不删除路径（~/.zshrc）不弹框、无任何放行选项，直接 block", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once", "Allow for this session"] });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.equal(verdict.block, true, "永不删除：不给删");
		assert.match(verdict.reason ?? "", /永不删除/, "理由要点名档位");
		assert.equal(h.selects.length, 0, "不弹框 —— 没有放行选项可给");
		assert.equal(h.confirms.length, 0);
		assert.equal(fs.existsSync(h.allowlistFile), false, "什么都不落盘");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：永不删除子树（~/.ssh、~/.gnupg）同样 block；项目内同名文件不受影响", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once"] });
	try {
		const v1 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.ssh/id_rsa\n` });
		assert.equal(v1.block, true, "凭据子树拦");
		const v2 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.gnupg/x\n` });
		assert.equal(v2.block, true, "凭据子树拦");
		assert.equal(h.selects.length, 0, "两次都不弹框");
		// 2026-09-25 补充的嵌套条目：~/.config 整棵是普通档，但 .config/gh 捞回永不删除档
		const v3 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.config/gh/hosts.yml\n` });
		assert.equal(v3.block, true, "嵌套的永不删除子树拦");
		assert.equal(h.selects.length, 0, "嵌套条目也不弹框");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：永不删除与普通路径混排 —— 整份 patch 一起拒", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session（并记住该目录）"] });
	try {
		const patch = `*** Delete File: ${HOME}/Downloads/ok.txt\n*** Delete File: ${HOME}/.zshrc\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.equal(verdict.block, true, "混一个永不删除路径，整份 patch 拒");
		assert.match(verdict.reason ?? "", /永不删除/);
		assert.equal(h.selects.length, 0, "不给「批准其余部分」的机会");
		assert.equal(fs.existsSync(h.allowlistFile), false, "也不落盘");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：危险路径每次都问，「Allow for this session」后本会话不弹，重启（重新加载）后又弹", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session", "Deny"] });
	try {
		const patch = `*** Delete File: ${HOME}/Library/sbx-probe/foo\n`;
		assert.deepEqual(await h.call("apply_patch", { patch }), {}, "第一次批准后放行");
		assert.deepEqual(await h.call("apply_patch", { patch }), {}, "会话豁免后不弹直接放行");
		assert.equal(h.selects.length, 1, "第二次不该再弹");
		assert.equal(fs.existsSync(h.allowlistFile), false, "会话豁免不落盘");
		// 会话豁免是 notify 过的（covered 命中），这里不细断内容，只断重启语义：
		// cleanup 会清会话集合，模拟重启；重新加载一份扩展后危险路径又弹框。
	} finally {
		h.cleanup();
	}
	const h2 = await loadHarness({ selections: ["Deny"] });
	try {
		const verdict = await h2.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/sbx-probe/foo\n` });
		assert.equal(verdict.block, true, "重启后危险路径恢复必问，Deny 则拦");
		assert.equal(h2.selects.length, 1, "又弹框了");
	} finally {
		h2.cleanup();
	}
});

test("apply_patch：普通边界外路径（~/Downloads）弹普通框，`Allow for this session（并记住该目录）`后落盘且不再问", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session（并记住该目录）"] });
	const target = `${HOME}/Downloads/sbx-probe-file.txt`;
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${target}\n` });
		assert.deepEqual(verdict, {}, "同意后应放行");
		assert.equal(h.selects.length, 1);
		assert.deepEqual(h.selects[0].options, ["Deny", "Allow for this session（并记住该目录）", "Allow once"], "普通目录的三选项");
		assert.ok(h.selects[0].title.includes("可删边界之外") && !h.selects[0].title.includes("危险"), "普通框不是危险框");
		// 落盘：记住的是父目录 ~/Downloads，不是那个文件
		const onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [`${HOME}/Downloads`]);
		// 第二次：同目录另一个文件 —— 命中白名单，不弹框，补一行 notify
		const verdict2 = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/sbx-probe-2.txt\n` });
		assert.deepEqual(verdict2, {});
		assert.equal(h.selects.length, 1, "已记住的目录不再弹框");
		assert.ok(h.notifies.some((n) => n.includes("白名单")), "命中白名单放行要 notify（不能静默）");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：工具状态目录（~/.pi、~/.config、~/.claude、~/.codex）是普通档 —— 弹框可记住（用户 2026-09-25）", { skip }, async () => {
	const h = await loadHarness({
		selections: [
			"Allow for this session（并记住该目录）",
			"Allow for this session（并记住该目录）",
			"Allow for this session（并记住该目录）",
			"Allow for this session（并记住该目录）",
		],
	});
	try {
		// 探针名用不存在的文件（apply_patch 钩子不看存在性）—— 否则 memoryScopeFor 会把
		// 真实存在的目录（如本机的 ~/.pi/agent/trust.json.lock）当成目标自身记住。
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.pi/agent/sbx-probe-lock.txt\n` });
		assert.deepEqual(verdict, {}, "同意后应放行（不再是永不删除的直接拒）");
		assert.equal(h.selects.length, 1, "应当弹一次框");
		assert.deepEqual(h.selects[0].options, ["Deny", "Allow for this session（并记住该目录）", "Allow once"], "普通目录的三选项");
		assert.ok(!h.selects[0].title.includes("危险"), "不是危险框");
		const onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [`${HOME}/.pi/agent`], "记住父目录");

		// 另外三个同样走普通档（未授权 → 弹框）
		for (const p of [`${HOME}/.config/sbx-probe.txt`, `${HOME}/.claude/sbx-probe.txt`, `${HOME}/.codex/sbx-probe.txt`]) {
			const v = await h.call("apply_patch", { patch: `*** Delete File: ${p}\n` });
			assert.deepEqual(v, {}, `${p} 同意后放行`);
		}
		assert.equal(h.selects.length, 4, "三个未记住的目录各弹一次");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：普通路径选`Allow once`不落盘，同目录第二个文件仍弹框", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once", "Deny"] });
	try {
		assert.deepEqual(await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/a.txt\n` }), {});
		assert.equal(fs.existsSync(h.allowlistFile), false, "`Allow once`不落盘");
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/b.txt\n` });
		assert.equal(verdict.block, true, "没记住 → 第二个文件仍问，Deny 则拦");
		assert.equal(h.selects.length, 2);
	} finally {
		h.cleanup();
	}
});

test("apply_patch：拒绝（Deny）则拦截，什么都没落盘", { skip }, async () => {
	const h = await loadHarness({ selections: ["Deny"] });
	try {
		const patch = `*** Delete File: ${HOME}/Library/Preferences/sbx-deny.plist\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.equal(verdict.block, true, "拒绝后应拦截");
		assert.match(verdict.reason ?? "", /拒绝删除/);
		assert.equal(fs.existsSync(h.allowlistFile), false);
	} finally {
		h.cleanup();
	}
});

test("apply_patch：Update / Add File 是写入，边界外也放行", { skip }, async () => {
	const h = await loadHarness({ selections: ["Deny"] });
	try {
		const patch = `*** Update File: ${HOME}/.pi/agent/settings.json\n*** Add File: ${HOME}/new-file.txt\n`;
		const verdict = await h.call("apply_patch", { patch });
		assert.deepEqual(verdict, {}, "没有 Delete File 就不该拦");
		assert.equal(h.selects.length, 0, "写入不该弹窗");
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("apply_patch：同一危险路径`Allow once`后仍会再问（不进任何记忆）", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow once", "Allow once"] });
	try {
		await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Foo/bar\n` });
		await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Foo/bar\n` });
		assert.equal(h.selects.length, 2, "危险路径每次必问，`Allow once`不豁免");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：非交互环境 fail-closed，未授权的边界外删除直接 block，不弹窗", { skip }, async () => {
	const h = await loadHarness({ hasUI: false });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Preferences/sbx-headless.plist\n` });
		assert.equal(verdict.block, true, "非交互应直接拦");
		assert.match(verdict.reason ?? "", /非交互环境/);
		assert.equal(h.selects.length, 0, "非交互不该有弹窗");
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("apply_patch：非交互环境 + 预置白名单 → 放行（授权本来就是交互时给的）", { skip }, async () => {
	const h = await loadHarness({ hasUI: false, seedAllowlist: [`${HOME}/Downloads`] });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/old.zip\n` });
		assert.deepEqual(verdict, {}, "headless 下白名单应当生效");
		assert.equal(h.selects.length, 0, "非交互本来也没有弹窗可言");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：非交互环境 + 预置白名单也拦危险路径", { skip }, async () => {
	const h = await loadHarness({ hasUI: false, seedAllowlist: [`${HOME}/Downloads`] });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Library/Preferences/sbx-headless2.plist\n` });
		assert.equal(verdict.block, true, "白名单里没有它 → 仍 fail-closed");
		assert.match(verdict.reason ?? "", /非交互环境/);
		assert.match(verdict.reason ?? "", /持久白名单：1 条/, "理由要告诉模型现在有几条白名单");
	} finally {
		h.cleanup();
	}
});

test("apply_patch：非交互环境也拦永不删除路径（理由点名档位）", { skip }, async () => {
	const h = await loadHarness({ hasUI: false });
	try {
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.equal(verdict.block, true, "headless 下永不删除照样拦");
		assert.match(verdict.reason ?? "", /永不删除/);
		assert.equal(h.selects.length, 0);
	} finally {
		h.cleanup();
	}
});

test("只读工具与无删除目标的工具一律放行", { skip }, async () => {
	const h = await loadHarness();
	try {
		assert.deepEqual(await h.call("read", { path: `${HOME}/.zshrc` }), {}, "read 是只读的");
		assert.deepEqual(await h.call("grep", { pattern: "x" }), {}, "grep 无路径");
		assert.deepEqual(await h.call("bash", { command: "rm -rf /" }), {}, "bash 归沙箱管，不归这里");
		assert.deepEqual(await h.call("apply_patch", { patch: "*** Update File: x.ts\n" }), {}, "无 Delete 行");
		assert.equal(h.selects.length, 0);
		assert.equal(h.confirms.length, 0);
	} finally {
		h.cleanup();
	}
});

test("PI_SANDBOX=off 时整个钩子不生效", { skip }, async () => {
	const prior = process.env.PI_SANDBOX;
	process.env.PI_SANDBOX = "off";
	let h: Harness | undefined;
	try {
		h = await loadHarness();
		const verdict = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.deepEqual(verdict, {}, "off 时不该拦");
		assert.equal(h.selects.length, 0, "off 时不该弹窗");
		assert.equal(h.confirms.length, 0);
	} finally {
		if (prior === undefined) delete process.env.PI_SANDBOX;
		else process.env.PI_SANDBOX = prior;
		h?.cleanup();
	}
});

test("dangerous 模式（plan-mode 三态）：整个钩子不生效，连永不删除档也不拦", { skip }, async () => {
	// dangerous 是 pi 原生的任意权限形态，只能由用户 shift+tab 切到。与 PI_SANDBOX=off
	// 的区别：那是注册期读的 env 总闸，这个是**运行期**单例 —— 所以用同一份已加载的
	// harness，只翻单例，就能验证「执行期判定」这条路径。
	const { getSandboxMode, resetSandboxModeForTesting, setSandboxMode } = await import(
		pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bash-command-collapse", "sandbox-mode.ts")).href
	);
	resetSandboxModeForTesting();
	const h = await loadHarness();
	try {
		// 对照组：bypass 下永不删除档 fail-closed（不弹框、直接 block）。
		assert.equal(getSandboxMode(), "bypass");
		const blocked = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.equal(blocked.block, true, "bypass 下 ~/.zshrc 必须被拦");

		// 切到 dangerous：同一条 patch 放行，且不弹框。
		setSandboxMode("dangerous");
		const passed = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/.zshrc\n` });
		assert.deepEqual(passed, {}, "dangerous 下不该拦（任意权限）");
		assert.equal(h.selects.length, 0, "dangerous 下不该弹窗");
		assert.equal(h.confirms.length, 0);

		// 普通边界外路径在 dangerous 下也不弹框（对照组：bypass 下会弹）。
		const ordinary = await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/sbx-dangerous-probe.txt\n` });
		assert.deepEqual(ordinary, {}, "dangerous 下普通越界删除也不问");
		assert.equal(h.selects.length, 0);
	} finally {
		resetSandboxModeForTesting();
		h.cleanup();
	}
});

test("dangerous 模式下 /sandbox-boundary 命令说明拦截已关", { skip }, async () => {
	const { resetSandboxModeForTesting, setSandboxMode } = await import(
		pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bash-command-collapse", "sandbox-mode.ts")).href
	);
	resetSandboxModeForTesting();
	const h = await loadHarness();
	try {
		setSandboxMode("dangerous");
		await h.runCommand();
		const report = h.notifies[h.notifies.length - 1] ?? "";
		assert.match(report, /dangerous/, "要说清当前是 dangerous 模式");
		assert.match(report, /shift\+tab/, "要给出切回 bypass 的出口");
	} finally {
		resetSandboxModeForTesting();
		h.cleanup();
	}
});

test("/sandbox-boundary 命令报告边界、白名单与会话豁免", { skip }, async () => {
	const h = await loadHarness({ selections: ["Allow for this session（并记住该目录）"] });
	try {
		await h.call("apply_patch", { patch: `*** Delete File: ${HOME}/Downloads/sbx-probe.txt\n` });
		await h.runCommand();
		const report = h.notifies[h.notifies.length - 1] ?? "";
		assert.match(report, /可删边界/);
		assert.match(report, /持久白名单/, "要列出持久白名单");
		assert.ok(report.includes(`${HOME}/Downloads`), "白名单条目要显示出来");
		assert.match(report, /会话级豁免/);
	} finally {
		h.cleanup();
	}
});

test("/sandbox-boundary allow 预授权、forget 移除、clear 清空", { skip }, async () => {
	const h = await loadHarness();
	try {
		await h.runCommand(`allow ${HOME}/Downloads`);
		let onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries.map((e: { path: string }) => e.path), [`${HOME}/Downloads`], "allow 落盘");
		assert.equal(onDisk.entries[0].source, "command", "手动加的标 command");

		await h.runCommand(`allow ${HOME}/.ssh`);
		onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.equal(onDisk.entries.length, 1, "永不删除路径预授权被安全闸挡下");

		await h.runCommand(`forget ${HOME}/Downloads`);
		onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries, [], "forget 移除");

		await h.runCommand(`allow ${HOME}/Downloads`);
		await h.runCommand("clear");
		onDisk = JSON.parse(fs.readFileSync(h.allowlistFile, "utf8"));
		assert.deepEqual(onDisk.entries, [], "clear 清空");
	} finally {
		h.cleanup();
	}
});
