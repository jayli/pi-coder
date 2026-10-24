/**
 * glob-tool / execute —— 端到端测试：真加载扩展、真调 `definition.execute()`。
 *
 * 与 `explored-group/render.test.ts` 同一套手法：用 pi 自己的 `discoverAndLoadExtensions`
 * 加载本扩展取出 `definition`，避免"我另起一份 schema / 另写一份编排"。
 *
 * 每种目录形态各造一棵临时树（`mktemp -d`），跑完删除。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/execute.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SKIP = "找不到本机 pi 的库入口（装过 pi 才有）";

async function findPiLibraryEntry(): Promise<string | undefined> {
	const candidates: string[] = [];
	if (process.env.PI_TEST_PI_ENTRY) candidates.push(process.env.PI_TEST_PI_ENTRY);

	// 本机的 pi 是 pnpm 全局安装：`~/.pi/agent/npm/node_modules/@earendil-works/` 根本不存在
	// （那里只有依赖），所以必须先用 PATH 里的 `pi` shim 反查真实安装位置，否则测试会静默全 skip。
	// 与 `ask-user-question/render.test.ts` 同一套查找逻辑。
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
	candidates.push(
		path.join(packageDir, "dist/bundle/index.js"),
		path.join(packageDir, "dist/index.js"),
	);
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
}

const piEntry = await findPiLibraryEntry();
const skip = piEntry === undefined ? SKIP : false;
const pi = piEntry ? ((await import(pathToFileURL(piEntry).href)) as unknown as PiApi) : undefined;

const roots: string[] = [];
after(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "glob-exec-"));
	roots.push(root);
	return root;
}

function put(root: string, rel: string, content = "x\n"): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

function initRepo(root: string): void {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.com",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
	};
	execFileSync("git", ["init", "-q", "."], { cwd: root, env });
	execFileSync("git", ["add", "-A"], { cwd: root, env });
	execFileSync("git", ["commit", "-qm", "init", "--allow-empty"], { cwd: root, env });
}

/** 每棵树都要单独加载扩展 —— `discoverAndLoadExtensions` 的 cwd 决定 `createGlobTool(cwd)`。 */
async function definitionFor(root: string): Promise<any> {
	const loaded = await pi!.discoverAndLoadExtensions(
		[path.join(HERE, "index.ts")],
		root,
		path.join(os.tmpdir(), "glob-exec-test-agent"),
		pi!.createEventBus(),
	);
	assert.deepEqual(loaded.errors, [], `扩展加载报错：${JSON.stringify(loaded.errors)}`);
	const entry = loaded.extensions.flatMap((e) => [...e.tools.entries()]).find(([name]) => name === "glob");
	assert.ok(entry, "没注册出 glob 工具");
	return entry![1].definition;
}

/** 调一次 execute，返回正文文本。 */
async function run(root: string, params: Record<string, unknown>): Promise<string> {
	const definition = await definitionFor(root);
	const ctx = { cwd: root } as any;
	const result = await definition.execute("call-1", params, undefined, undefined, ctx);
	return result.content.map((part: any) => part.text ?? "").join("");
}

const lines = (text: string): string[] =>
	text
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("["))
		.sort();

test("execute：不含 / 的模式隐式递归", { skip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "sub/b.ts");
	put(root, "sub/deep/c.ts");
	put(root, "sub/skip.js");
	assert.deepEqual(lines(await run(root, { pattern: "*.ts" })), ["a.ts", "sub/b.ts", "sub/deep/c.ts"]);
});

test("execute：轨道点文件不受 hidden 门控", { skip: !hasGit ? "本机没有 git" : skip }, async () => {
	const root = makeRoot();
	put(root, "a.yml");
	put(root, ".github/workflows/ci.yml");
	initRepo(root);
	assert.deepEqual(lines(await run(root, { pattern: "**/*.yml" })), [".github/workflows/ci.yml", "a.yml"]);
});

test("execute：未 staged 的 rm 不出现在结果里", { skip: !hasGit ? "本机没有 git" : skip }, async () => {
	const root = makeRoot();
	put(root, "gone.ts");
	put(root, "stays.ts");
	initRepo(root);
	fs.rmSync(path.join(root, "gone.ts"));
	assert.deepEqual(lines(await run(root, { pattern: "**/*.ts" })), ["stays.ts"]);
});

test("execute：limit 为 0 回落默认，不清空结果", { skip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "b.ts");
	assert.deepEqual(lines(await run(root, { pattern: "**/*.ts", limit: 0 })), ["a.ts", "b.ts"]);
});

test("execute：pattern 为空白时报错", { skip }, async () => {
	const root = makeRoot();
	await assert.rejects(run(root, { pattern: "   " }), /pattern is required/);
});

test("execute：path 指向子目录时输出相对该子目录", { skip }, async () => {
	const root = makeRoot();
	put(root, "outside.ts");
	put(root, "sub/inside.ts");
	assert.deepEqual(lines(await run(root, { pattern: "**/*.ts", path: "sub" })), ["inside.ts"]);
});

test("execute：path 不存在时报错", { skip }, async () => {
	const root = makeRoot();
	await assert.rejects(run(root, { pattern: "**/*.ts", path: "nope" }), /Path not found/);
});

test("execute：无匹配时返回固定文案", { skip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	assert.equal((await run(root, { pattern: "**/*.nope" })).trim(), "No files found matching pattern");
});

test("execute：sort_by_mtime 把最新的排前面", { skip }, async () => {
	const root = makeRoot();
	put(root, "old.ts");
	put(root, "new.ts");
	const old = new Date("2020-01-01T00:00:00Z");
	fs.utimesSync(path.join(root, "old.ts"), old, old);
	const text = await run(root, { pattern: "**/*.ts", sort_by_mtime: true });
	assert.equal(lines(text)[0], "new.ts");
	assert.equal(lines(text)[1], "old.ts");
});

test("工具文案：与内置 find 的差异按**真实**差异写，不写 find 的假缺陷", { skip }, async () => {
	// 回归（2026-10-26 实测）：第一版 description 与 find 几乎逐字相同，模型面对两句同义
	// 描述只能猜，一句「仓库里有哪些 python 测试文件」会先试两次 find 才落到 glob。
	//
	// 2026-10-24 复核改口：初版那三条卖点里的两条（find 拒绝带 '/' 的模式、find 会钻 .git/）
	// 在 pi 1.4.0 里**都不成立** —— find 内部会给带 '/' 的模式补递归前缀交给 `fd --full-path`，
	// 且在 git 仓库内照样遵守 .gitignore。所以文案与断言都收窄到唯一稳定的差异：
	// glob 读 git 索引，find 走文件系统且能返回目录。
	const definition = await definitionFor(process.cwd());
	const description: string = definition.description ?? "";
	const snippet: string = definition.promptSnippet ?? "";
	const guidelines: string[] = definition.promptGuidelines ?? [];

	assert.ok(
		!/^Find files by glob pattern/.test(description),
		`description 不该以 find 的开头起句：${description.slice(0, 60)}`,
	);
	assert.match(description, /repository index/i, "description 首段要写明候选来自索引");
	assert.match(snippet, /index/i, `snippet 要点明 index：${snippet}`);
	// 不得再声称 find 有不存在的缺陷（旧文案里的两条论据）。
	const all = [description, snippet, ...guidelines].join("\n");
	assert.doesNotMatch(all, /rejects patterns containing/i, "不得声称 fd --glob 拒绝带 '/' 的模式");
	assert.doesNotMatch(all, /Prefer glob over find/i, "不再用无条件的『prefer glob』告诉模型该选哪个");
	// 新口径要写明两者都能用，差异在候选来源 + find 能返回目录。
	assert.ok(
		guidelines.some((line) => /git index/i.test(line) && /filesystem/i.test(line)),
		`guidelines 要说清候选来源不同：${JSON.stringify(guidelines)}`,
	);
	assert.ok(
		guidelines.some((line) => /directories/i.test(line)),
		`guidelines 要指出 find 能返回目录（glob 不能）：${JSON.stringify(guidelines)}`,
	);
});
