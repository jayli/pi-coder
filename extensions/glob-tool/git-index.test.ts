/**
 * glob-tool / git-index —— 索引解析的测试。
 *
 * 索引是二进制格式，所以测试分两层：
 * 1. **语法层**（纯 buffer）：人造索引覆盖 v2 / v3 / v4、长路径、目录条目，以及所有
 *    "不认识就放弃"的分支（版本越界、截断、`link` 扩展）。
 * 2. **真仓库层**：用 `git ls-files --cached` 做对照组 —— 这是唯一能证明解析器与 git
 *    字节级一致的断言，人造样本替代不了。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/git-index.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { findRepoRoot, parseIndexPaths, readIndexPaths } from "./git-index.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix = "glob-index-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function put(root: string, rel: string, content = "x"): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const gitSkip = hasGit ? false : "本机没有 git，无法与真 git 输出对拍";

const gitEnv = (): NodeJS.ProcessEnv => ({
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
});

function initRepo(root: string): void {
	execFileSync("git", ["init", "-q", "."], { cwd: root, env: gitEnv() });
	execFileSync("git", ["add", "-A"], { cwd: root, env: gitEnv() });
	execFileSync("git", ["commit", "-qm", "init", "--allow-empty"], { cwd: root, env: gitEnv() });
}

// ─────────────────────────────────────────────────────────────────────────────
// 人造索引：语法层
// ─────────────────────────────────────────────────────────────────────────────

/** 造一条 v2/v3 索引记录（定长路径情形）。 */
function entryV2(name: string, mode = 0o100644): Buffer {
	const nameBytes = Buffer.from(name, "utf8");
	const header = Buffer.alloc(62);
	header.writeUInt32BE(mode >>> 0, 24);
	// flags 低 12 位 = 路径长度（这里都 < 0xFFF）
	header.writeUInt16BE(nameBytes.length, 60);
	const body = Buffer.concat([header, nameBytes, Buffer.alloc(1)]);
	// 补零到 8 字节边界（相对记录起点）
	const pad = (8 - (body.length % 8)) % 8;
	return Buffer.concat([body, Buffer.alloc(pad)]);
}

function indexFile(version: number, entries: Buffer[]): Buffer {
	const header = Buffer.alloc(12);
	header.write("DIRC", 0, "ascii");
	header.writeUInt32BE(version, 4);
	header.writeUInt32BE(entries.length, 8);
	return Buffer.concat([header, ...entries]);
}

test("parseIndexPaths：v2 基本条目（含目录条目加尾斜杠）", () => {
	const buffer = indexFile(2, [entryV2("a.ts"), entryV2("nested", 0o040000), entryV2("b/c.ts")]);
	assert.deepEqual(parseIndexPaths(buffer), ["a.ts", "nested/", "b/c.ts"]);
});

test("parseIndexPaths：版本不在 2..4 时放弃（返回 undefined）", () => {
	for (const version of [1, 5, 99]) {
		assert.equal(parseIndexPaths(indexFile(version, [entryV2("a.ts")])), undefined, `v${version}`);
	}
});

test("parseIndexPaths：magic 不对时放弃", () => {
	const bad = indexFile(2, [entryV2("a.ts")]);
	bad.write("XXXX", 0, "ascii");
	assert.equal(parseIndexPaths(bad), undefined);
});

test("parseIndexPaths：条目被截断时放弃（不给部分结果）", () => {
	const full = indexFile(2, [entryV2("a.ts"), entryV2("b.ts")]);
	assert.equal(parseIndexPaths(full.subarray(0, full.length - 10)), undefined);
});

test("parseIndexPaths：出现 link 扩展（split index）时放弃", () => {
	const entries = indexFile(2, [entryV2("a.ts")]);
	// 追加一个 link 扩展：签名 + 长度 + 负载
	const size = Buffer.alloc(4);
	size.writeUInt32BE(4, 0);
	const extension = Buffer.concat([Buffer.from("link", "ascii"), size, Buffer.from("abcd", "ascii")]);
	assert.equal(parseIndexPaths(Buffer.concat([entries, extension])), undefined);
});

test("parseIndexPaths：TREE 扩展的哈希里出现字面量 link 时**不能**误判", () => {
	// 回归：初版在尾部裸扫 "link" 字样，TREE 扩展的二进制哈希里撞上就整份索引被判废。
	const entries = indexFile(2, [entryV2("a.ts")]);
	const payload = Buffer.concat([Buffer.from("prefixlink", "ascii"), Buffer.alloc(8)]);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(payload.length, 0);
	const extension = Buffer.concat([Buffer.from("TREE", "ascii"), size, payload]);
	assert.deepEqual(parseIndexPaths(Buffer.concat([entries, extension])), ["a.ts"]);
});

test("parseIndexPaths：v4 的前缀压缩解压正确", () => {
	// v4 记录：62 字节头 + varint(要剥掉的字节数) + 后缀 + NUL
	function entryV4(name: string, strip: number): Buffer {
		const header = Buffer.alloc(62);
		header.writeUInt32BE(0o100644, 24);
		// flags 里的长度位在 v4 不使用，置 0
		header.writeUInt16BE(0, 60);
		const suffix = Buffer.from(name, "utf8");
		// 单字节 varint（strip < 128）
		return Buffer.concat([header, Buffer.from([strip]), suffix, Buffer.alloc(1)]);
	}
	const buffer = indexFile(4, [entryV4("src/a.ts", 0), entryV4("b.ts", 4)]);
	// 第二条：上一条 `src/a.ts` 共 8 字节，公共前缀 `src/` 是 4 字节 ⇒ strip=4，
	// 剩下 `src/` 再续上后缀 `b.ts` → `src/b.ts`。
	assert.deepEqual(parseIndexPaths(buffer), ["src/a.ts", "src/b.ts"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 真仓库：与 git ls-files --cached 逐条对拍
// ─────────────────────────────────────────────────────────────────────────────

test("真仓库：解析结果与 git ls-files --cached 逐条相等", { skip: gitSkip }, () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "deep/nested/b.ts");
	put(root, ".github/workflows/ci.yml");
	put(root, "name with space.txt");
	put(root, "ünïcode.txt");
	symlinkSync("a.ts", join(root, "link.ts"));
	initRepo(root);

	const parsed = readIndexPaths(join(root, ".git/index"));
	assert.ok(parsed, "索引解析失败");
	const expected = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached"], { maxBuffer: 1 << 26 })
		.toString()
		.split("\0")
		.filter(Boolean);
	assert.deepEqual(parsed.slice().sort(), expected.slice().sort());
	// 符号链接条目必须那一份都在：这是 rg 做不到、索引必须提供的那一半语义。
	assert.ok(parsed!.includes("link.ts"), `实得 ${JSON.stringify(parsed)}`);
});

test("真仓库：已 rm 未 git add 的名字仍在索引里（存在性过滤是上层的事）", { skip: gitSkip }, () => {
	const root = makeRoot();
	put(root, "gone.ts");
	put(root, "stays.ts");
	initRepo(root);
	rmSync(join(root, "gone.ts"));

	const parsed = readIndexPaths(join(root, ".git/index"));
	assert.ok(parsed?.includes("gone.ts"), `实得 ${JSON.stringify(parsed)}`);
});

test("findRepoRoot：普通仓库、子目录、linked worktree 三种形态", { skip: gitSkip }, () => {
	const root = makeRoot();
	put(root, "a.ts");
	initRepo(root);

	// 仓库根与子目录
	assert.equal(findRepoRoot(root)?.root, root);
	const sub = join(root, "deep/nested");
	mkdirSync(sub, { recursive: true });
	assert.equal(findRepoRoot(sub)?.root, root, "子目录应向上找到仓库根");

	// linked worktree：.git 是文件，内容是 gitdir: <path>
	const worktree = makeRoot("glob-index-wt-");
	execFileSync("git", ["-C", root, "worktree", "add", "--detach", worktree, "HEAD"], { env: gitEnv() });
	const located = findRepoRoot(worktree);
	assert.ok(located, "worktree 的 .git 文件没被认出来");
	assert.equal(located!.root, worktree);
	assert.notEqual(located!.gitDir, join(worktree, ".git"), "worktree 的 gitDir 应指向主仓库的 .git/worktrees/…");
	assert.ok(located!.gitDir.includes("worktrees"), `实得 ${located!.gitDir}`);
	// 而且那份索引能解析出与主仓库相同的条目
	const fromWorktree = readIndexPaths(join(located!.gitDir, "index"));
	assert.ok(fromWorktree?.includes("a.ts"), `实得 ${JSON.stringify(fromWorktree)}`);
});

test("findRepoRoot：非仓库返回 undefined", () => {
	const root = makeRoot();
	put(root, "a.ts");
	assert.equal(findRepoRoot(root), undefined);
});
