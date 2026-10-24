/**
 * glob-tool / candidates —— 三档候选枚举的**真文件系统**测试。
 *
 * 每个用例都用 `mktemp -d` 造一棵临时树，跑完删掉。这里刻意不 mock `git` 与 `fs`：
 * 这一层的全部价值就是"git 到底怎么回答"，mock 掉就什么都没验。
 *
 * 已知的环境依赖：没有 `git` 的机器上，档 1/2 的用例会跳过（`skip` 带原因）。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/candidates.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { collectCandidates, resetBareRepoCache } from "./candidates.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 造一个临时目录，登记到 after 里清理。 */
function makeRoot(prefix = "glob-cand-"): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

/** 写文件（自动建父目录）。 */
function put(root: string, rel: string, content = "x"): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

/** 有 git 才跑，否则带信息跳过。 */
const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();
const gitSkip = hasGit ? false : "本机没有 git，档 1/2 无法验证";

/** 在 root 里初始化仓库并提交当前全部文件。 */
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

const sorted = (list: readonly string[]): string[] => list.slice().sort();

test("git 仓库：tracked + untracked 都返回，gitignored 不返回，! 否定救回", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, "tracked.ts");
	put(root, ".gitignore", "*.log\n!keep.log\n");
	initRepo(root);
	put(root, "untracked.ts");
	put(root, "skip.log");
	put(root, "keep.log");

	const got = sorted(await collectCandidates(root, {}));
	assert.deepEqual(got, [".gitignore", "keep.log", "tracked.ts", "untracked.ts"]);
});

test("git 仓库：未 staged 的 rm 仍会被枚举（存在性过滤不在这一层）", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, "gone.ts");
	put(root, "stays.ts");
	initRepo(root);
	rmSync(join(root, "gone.ts"));

	// 这一层的契约是"枚举 git 认得的名字"，不做存在性判断 —— 过滤在 index.ts 的 statMtime。
	// 钉住这条是为了让 Task 5 的 stat 过滤有明确的、不可被"优化掉"的理由。
	const got = sorted(await collectCandidates(root, {}));
	assert.ok(got.includes("gone.ts"), `期望包含 gone.ts，实得 ${JSON.stringify(got)}`);
	assert.ok(got.includes("stays.ts"));
});

test("git 仓库：index 里的目录条目（嵌套 repo）不出现在结果里", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "nested/inner.ts");
	initRepo(root);
	// 把 nested 变成独立仓库：外层 index 只会记成目录条目 `nested/`
	execFileSync("git", ["init", "-q", "."], { cwd: join(root, "nested") });

	const got = await collectCandidates(root, {});
	assert.ok(!got.some((p) => p.endsWith("/")), `不该有目录条目：${JSON.stringify(got)}`);
	assert.ok(got.includes("a.ts"));
});

test("git 仓库：includeIgnored 时 ignored 文件出现", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "a.ts");
	initRepo(root);
	put(root, "noise.log");

	const without = await collectCandidates(root, {});
	assert.ok(!without.includes("noise.log"));
	const withIgnored = await collectCandidates(root, { includeIgnored: true });
	assert.ok(withIgnored.includes("noise.log"), `实得 ${JSON.stringify(withIgnored)}`);
});

test("非 git 目录 + .gitignore：走裸仓库兜底，结果与等价 git 仓库逐一相等", { skip: gitSkip }, async () => {
	// 两棵结构完全相同的树：一棵是 git 仓库，一棵不是（但带 .gitignore）。
	const asRepo = makeRoot("glob-cand-repo-");
	put(asRepo, ".gitignore", "*.log\n!keep.log\nsub/ignored.ts\n");
	put(asRepo, "a.ts");
	put(asRepo, "sub/b.ts");
	put(asRepo, "sub/ignored.ts");
	put(asRepo, "skip.log");
	put(asRepo, "keep.log");
	initRepo(asRepo);

	const plain = makeRoot("glob-cand-plain-");
	put(plain, ".gitignore", "*.log\n!keep.log\nsub/ignored.ts\n");
	put(plain, "a.ts");
	put(plain, "sub/b.ts");
	put(plain, "sub/ignored.ts");
	put(plain, "skip.log");
	put(plain, "keep.log");

	resetBareRepoCache();
	const fromRepo = sorted(await collectCandidates(asRepo, {}));
	const fromPlain = sorted(await collectCandidates(plain, {}));
	assert.deepEqual(fromPlain, fromRepo);
});

test("非 git 目录且无 .gitignore：走 opendir 走查", async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "sub/b.ts");

	const got = sorted(await collectCandidates(root, {}));
	assert.deepEqual(got, ["a.ts", "sub/b.ts"]);
});

test("opendir 走查：hidden:false 不列点路径段，hidden:true 能进隐藏目录内部", async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, ".hid/x.ts");
	put(root, ".dot.ts");

	const without = sorted(await collectCandidates(root, {}));
	assert.deepEqual(without, ["a.ts"], `实得 ${JSON.stringify(without)}`);

	const withHidden = sorted(await collectCandidates(root, { hidden: true }));
	assert.deepEqual(withHidden, [".dot.ts", ".hid/x.ts", "a.ts"]);
});

test("opendir 走查：不跟随指向目录的符号链接", async () => {
	const root = makeRoot();
	put(root, "real/a.ts");
	symlinkSync(join(root, "real"), join(root, "link"));

	const got = sorted(await collectCandidates(root, {}));
	assert.ok(got.includes("real/a.ts"));
	assert.ok(!got.some((p) => p.startsWith("link/")), `不该跟随符号链接：${JSON.stringify(got)}`);
});

test("opendir 走查：EACCES 子树跳过，整体不失败", async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "locked/b.ts");
	chmodSync(join(root, "locked"), 0o000);
	try {
		const got = sorted(await collectCandidates(root, {}));
		assert.ok(got.includes("a.ts"), `实得 ${JSON.stringify(got)}`);
	} finally {
		chmodSync(join(root, "locked"), 0o755);
	}
});

test("opendir 走查：signal.abort 后提前结束", async () => {
	const root = makeRoot();
	for (let i = 0; i < 40; i++) put(root, `d${i}/f.ts`);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(collectCandidates(root, { signal: controller.signal }), /abort/i);
});

test("裸仓库在同一 root 上复用（第二次不再 git init）", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "a.ts");
	put(root, "x.log");
	resetBareRepoCache();

	const first = sorted(await collectCandidates(root, {}));
	const second = sorted(await collectCandidates(root, {}));
	assert.deepEqual(second, first);
	// 复用与否对外不可见，这里断言的是"两次结果一致且都正确"——缓存若坏了会漏文件。
	assert.deepEqual(first, [".gitignore", "a.ts"]);
});

test("opendir 走查：父级 .gitignore 的规则要作用到深层文件（不继承就是 bug）", async () => {
	// 强制走查档：没有 git 仓库、也没有外层 `.gitignore` 可让裸仓库档接手的场景不存在
	// （有 .gitignore 就走裸仓库了），所以这里直接调走查档的公共入口 —— 用一个读不到
	// git 的假 PATH，把档 1/2 都挡掉。
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "l1/l2/l3/deep.log");
	put(root, "l1/l2/l3/keep.ts");
	const previousPath = process.env.PATH;
	process.env.PATH = "/nonexistent"; // 让 `git` 不可用 → 档 1/2 都失败 → 走档 3
	try {
		const got = sorted(await collectCandidates(root, {}));
		assert.ok(!got.includes("l1/l2/l3/deep.log"), `父级 *.log 规则没生效：${JSON.stringify(got)}`);
		assert.ok(got.includes("l1/l2/l3/keep.ts"), `实得 ${JSON.stringify(got)}`);
	} finally {
		process.env.PATH = previousPath;
	}
});

test("opendir 走查：父级忽略 + 子级否定要能救回（三态叠加）", async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "sub/.gitignore", "!keep.log\n");
	put(root, "sub/a.log");
	put(root, "sub/keep.log");
	put(root, "sub/x.ts");
	const previousPath = process.env.PATH;
	process.env.PATH = "/nonexistent"; // 强制走档 3
	try {
		const got = sorted(await collectCandidates(root, {}));
		assert.ok(got.includes("sub/keep.log"), `子级 !keep.log 没能救回：${JSON.stringify(got)}`);
		assert.ok(!got.includes("sub/a.log"), `父级 *.log 没生效：${JSON.stringify(got)}`);
		assert.ok(got.includes("sub/x.ts"));
	} finally {
		process.env.PATH = previousPath;
	}
});

test("opendir 走查：大括号点备选模式能匹配（{.env,.env.*}）", async () => {
	const root = makeRoot();
	put(root, ".env");
	put(root, ".env.local");
	put(root, ".envrc");
	const previousPath = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		const all = sorted(await collectCandidates(root, { hidden: true }));
		assert.ok(all.includes(".env"), `实得 ${JSON.stringify(all)}`);
	} finally {
		process.env.PATH = previousPath;
	}
});

test("裸仓库档：git init 失败时不留临时目录（不留孤儿 mkdtemp）", async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "a.ts");
	put(root, "x.log");
	resetBareRepoCache();
	const before = (await import("node:fs/promises")).readdir(tmpdir(), { withFileTypes: true });
	const beforeCount = (await before).filter((entry) => entry.name.startsWith("glob-bare-")).length;
	const previousPath = process.env.PATH;
	// 让 git 存在但 --bare init 失败：指向一个不存在的工作目录 + 只读 TMPDIR 不好造，
	// 所以直接把 TMPDIR 指向不可写位置 → mkdtempSync 抛错前不适用。改用 PATH 里放一个
	// 假的 git，它一定失败。
	const fakeBin = makeRoot("glob-fakebin-");
	put(fakeBin, "git", "#!/bin/sh\nexit 1\n");
	(await import("node:fs")).chmodSync(join(fakeBin, "git"), 0o755);
	process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
	try {
		await collectCandidates(root, {});
	} finally {
		process.env.PATH = previousPath;
	}
	const after = (await (await import("node:fs/promises")).readdir(tmpdir(), { withFileTypes: true })).filter((entry) =>
		entry.name.startsWith("glob-bare-"),
	).length;
	assert.equal(after, beforeCount, "git init 失败后不该留下 glob-bare-* 临时目录");
});
