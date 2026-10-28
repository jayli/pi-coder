/**
 * glob-tool / engine —— **新旧候选引擎的等价性**测试。
 *
 * `PI_GLOB_ENGINE=git`（旧：`git ls-files` 三档）与默认高速档（索引 + rg + fd）必须
 * 在同一棵树上给出**同一份候选集**。这是整个改动的验收面：性能是其次，语义是承重的。
 *
 * 已知且被明确接受的两处偏差（都是边界，且高速档这边更"对"）：
 * - 嵌套 git 仓库：旧档给出目录条目 `nested/`，高速档会深入进去列出里面的文件；
 * - 断链符号链接：两档都列出，但都会被上层 `statMtime` 丢 —— 所以候选集的这一条差异
 *   在最终结果里不可见。
 *
 * Run with:  node --test clients/pi/extensions/glob-tool/engine.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import { collectCandidates } from "./candidates.ts";
import { locateFd, locateRipgrep } from "./bin.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix = "glob-engine-"): string {
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
const gitSkip = hasGit ? false : "本机没有 git";
const fastSkip = locateRipgrep() === undefined ? "本机定位不到 rg（PI_GLOB_RG / <agentDir>/bin / PATH 都没有）" : false;

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

/** 用指定引擎跑一次候选枚举。 */
async function collectWith(root: string, engine: "git" | "fast", options: Record<string, unknown> = {}): Promise<string[]> {
	const previous = process.env.PI_GLOB_ENGINE;
	if (engine === "git") process.env.PI_GLOB_ENGINE = "git";
	else delete process.env.PI_GLOB_ENGINE;
	try {
		return await collectCandidates(root, options);
	} finally {
		if (previous === undefined) delete process.env.PI_GLOB_ENGINE;
		else process.env.PI_GLOB_ENGINE = previous;
	}
}

/** 两边的有序快照，便于读失败信息。 */
const snapshot = (list: readonly string[]): string[] => list.slice().filter((p) => !p.endsWith("/")).sort();

test("等价：嵌套 git 仓库的两种状态（git 不穿进去，rg 会 —— 必须显式还原边界）", { skip: gitSkip || fastSkip }, async () => {
	// 回归（2026-10-26 实测）：这是新旧引擎**唯一**的语义漂移。两种状态：
	//   A 子仓库内的文件不在父索引里 → `ls-files` 只报 `nested/` 目录条目，旧档 1 又把它
	//     过滤掉 ⇒ 内部文件一个不出；
	//   B 文件先 add、**后来**才在 `nested/` 里 `git init` → 索引里已是普通 blob，照常列。
	// 高速档因此只对「磁盘拓来的」条目应用子仓库边界，索引来的条目永远保留。
	for (const state of ["A", "B"] as const) {
		const root = makeRoot(`glob-nest-${state}-`);
		put(root, "top.ts");
		put(root, "nested/inner.ts");
		if (state === "A") {
			// 先建子仓库，父仓库只 add top.ts
			execFileSync("git", ["init", "-q", "."], { cwd: join(root, "nested"), env: gitEnv() });
			execFileSync("git", ["init", "-q", "."], { cwd: root, env: gitEnv() });
			execFileSync("git", ["add", "top.ts"], { cwd: root, env: gitEnv() });
			execFileSync("git", ["commit", "-qm", "init"], { cwd: root, env: gitEnv() });
		} else {
			initRepo(root); // 先把 nested/inner.ts 加进索引
			execFileSync("git", ["init", "-q", "."], { cwd: join(root, "nested"), env: gitEnv() });
		}

		const slow = snapshot(await collectWith(root, "git"));
		const fast = snapshot(await collectWith(root, "fast"));
		assert.deepEqual(fast, slow, `状态 ${state} 不一致`);
		if (state === "B") assert.ok(slow.includes("nested/inner.ts"), `状态 B 旧档应列出索引里的文件：${JSON.stringify(slow)}`);
		else assert.ok(!slow.some((p) => p.startsWith("nested/")), `状态 A 旧档不该列子仓库内部：${JSON.stringify(slow)}`);
	}
});

test("等价：真实本仓库（git 引擎 vs 高速引擎）", { skip: gitSkip || fastSkip }, async () => {
	const root = process.cwd();
	const slow = snapshot(await collectWith(root, "git"));
	const fast = snapshot(await collectWith(root, "fast"));
	assert.deepEqual(fast, slow);
});

test("等价：tracked + untracked + ignored + 否定", { skip: gitSkip || fastSkip }, async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n!keep.log\n");
	put(root, "tracked.ts");
	initRepo(root);
	put(root, "untracked.ts");
	put(root, "skip.log");
	put(root, "keep.log");

	assert.deepEqual(snapshot(await collectWith(root, "fast")), snapshot(await collectWith(root, "git")));
});

test("等价：已 rm 未 git add 的名字（索引半边必须来自索引，不是磁盘）", { skip: gitSkip || fastSkip }, async () => {
	const root = makeRoot();
	put(root, "gone.ts");
	put(root, "stays.ts");
	initRepo(root);
	rmSync(join(root, "gone.ts"));

	const slow = snapshot(await collectWith(root, "git"));
	const fast = snapshot(await collectWith(root, "fast"));
	assert.ok(slow.includes("gone.ts"), `旧档应包含 gone.ts：${JSON.stringify(slow)}`);
	assert.deepEqual(fast, slow);
});

test("等价：git add -f 强加的已跟踪但被 ignore 的文件", { skip: gitSkip || fastSkip }, async () => {
	const root = makeRoot();
	put(root, ".gitignore", "dist/\n");
	put(root, "dist/forced.js");
	put(root, "src.ts");
	execFileSync("git", ["init", "-q", "."], { cwd: root, env: gitEnv() });
	execFileSync("git", ["add", "-A"], { cwd: root, env: gitEnv() });
	execFileSync("git", ["add", "-f", "dist/forced.js"], { cwd: root, env: gitEnv() });
	execFileSync("git", ["commit", "-qm", "init", "--allow-empty"], { cwd: root, env: gitEnv() });

	const slow = snapshot(await collectWith(root, "git"));
	const fast = snapshot(await collectWith(root, "fast"));
	assert.ok(slow.includes("dist/forced.js"), `旧档应包含：${JSON.stringify(slow)}`);
	assert.deepEqual(fast, slow);
});

test("等价：符号链接条目（rg 不列，索引里有）", { skip: gitSkip || fastSkip }, async () => {
	const root = makeRoot();
	put(root, "real.ts");
	symlinkSync("real.ts", join(root, "link.ts"));
	initRepo(root);

	const slow = snapshot(await collectWith(root, "git"));
	const fast = snapshot(await collectWith(root, "fast"));
	assert.ok(slow.includes("link.ts"), `旧档应包含 link.ts：${JSON.stringify(slow)}`);
	assert.deepEqual(fast, slow);
});

test("等价：未跟踪的符号链接（靠 fd -t l 补）", { skip: gitSkip || fastSkip || (locateFd() === undefined ? "本机定位不到 fd" : false) }, async () => {
	const root = makeRoot();
	put(root, "real.ts");
	initRepo(root);
	symlinkSync("real.ts", join(root, "untracked_link.ts"));

	const slow = snapshot(await collectWith(root, "git"));
	const fast = snapshot(await collectWith(root, "fast"));
	assert.ok(slow.includes("untracked_link.ts"), `旧档应包含未跟踪链接：${JSON.stringify(slow)}`);
	assert.deepEqual(fast, slow);
});

test("等价：includeIgnored 模式", { skip: gitSkip || fastSkip }, async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "a.ts");
	initRepo(root);
	put(root, "noise.log");

	const slow = snapshot(await collectWith(root, "git", { includeIgnored: true }));
	const fast = snapshot(await collectWith(root, "fast", { includeIgnored: true }));
	assert.ok(slow.includes("noise.log"));
	assert.deepEqual(fast, slow);
});

test("等价：子目录调用（相对路径基准）", { skip: gitSkip || fastSkip }, async () => {
	const root = makeRoot();
	put(root, "top.ts");
	put(root, "sub/a.ts");
	put(root, "sub/deep/b.ts");
	initRepo(root);
	const sub = join(root, "sub");

	assert.deepEqual(snapshot(await collectWith(sub, "fast")), snapshot(await collectWith(sub, "git")));
});

test("等价：非 git 目录 + 嵌套 .gitignore + 否定（高速档靠 --no-require-git）", { skip: fastSkip }, async () => {
	const root = makeRoot();
	put(root, ".gitignore", "*.log\n");
	put(root, "sub/.gitignore", "!keep.log\n");
	put(root, "sub/a.log");
	put(root, "sub/keep.log");
	put(root, "sub/x.ts");

	const fast = snapshot(await collectWith(root, "fast"));
	assert.ok(!fast.includes("sub/a.log"), `父级 *.log 没生效：${JSON.stringify(fast)}`);
	assert.ok(fast.includes("sub/keep.log"), `子级否定没生效：${JSON.stringify(fast)}`);
	assert.ok(fast.includes("sub/x.ts"));
});

test("等价：搜索根之上的 `.gitignore` 不能被读到（--no-ignore-parent 的回归）", { skip: fastSkip }, async () => {
	// 回归（2026-10-26 实测）：加上 `--no-require-git` 后，rg 会一路向上读祖先目录的
	// `.gitignore`。`~/.pi/agent/npm/.gitignore` 内容就一个 `*`，但它把 3.2 万文件的查询
	// 滤成了 0 条 —— 而 git 只读工作树内部的 `.gitignore`。
	const parent = makeRoot("glob-ancestor-");
	put(parent, ".gitignore", "*\n"); // 祖先把下面的一切都忽略
	const root = join(parent, "work");
	put(root, "a.ts");
	put(root, "sub/b.ts");

	const fast = snapshot(await collectWith(root, "fast"));
	assert.deepEqual(fast, ["a.ts", "sub/b.ts"], `祖先 .gitignore 泄漏进结果：${JSON.stringify(fast)}`);
});

test("等价：非 git 目录里的符号链接也不受祖先 .gitignore 影响（fd 的 --no-ignore-parent）", { skip: fastSkip || fastSkip === false && locateFd() === undefined ? "本机定位不到 fd" : fastSkip }, async () => {
	// 回归（2026-10-26 实测）：fd 也认 `--no-require-git`，但**不加 --no-ignore-parent**
	// 时会读到祖先的 `.gitignore`。`~/.pi/agent/npm/.gitignore` 内容 `*`，当场洗掉 715 个
	// 符号链接（pnpm 的 `.bin/*` 全是）。
	const parent = makeRoot("glob-ancestor-link-");
	put(parent, ".gitignore", "*\n");
	const root = join(parent, "work");
	put(root, "real.ts");
	symlinkSync("real.ts", join(root, "link.ts"));

	const fast = snapshot(await collectWith(root, "fast"));
	assert.ok(fast.includes("link.ts"), `祖先 .gitignore 把符号链接洗掉了：${JSON.stringify(fast)}`);
});

test("等价：非 git 且无 .gitignore（`hidden` 的旧语义在这里才生效）", { skip: fastSkip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, ".dot.ts");
	put(root, ".hid/x.ts");

	// 旧档落到走查档时才过滤点路径，这里两档都要给同一份答案。
	const fastDefault = snapshot(await collectWith(root, "fast"));
	assert.deepEqual(fastDefault, ["a.ts"], `实得 ${JSON.stringify(fastDefault)}`);

	const fastHidden = snapshot(await collectWith(root, "fast", { hidden: true }));
	assert.deepEqual(fastHidden, [".dot.ts", ".hid/x.ts", "a.ts"]);
});

test("高速引擎：fd 定位不到时整档降级（未跟踪的符号链接只有 fd 能补）", { skip: gitSkip || fastSkip }, async () => {
	// 回归（2026-10-26 实测）：`git ls-files` 会列未跟踪的符号链接，rg 不列 —— 只有 fd 能补。
	// 所以 fd 缺失时必须降级跑 git，不能“少一块但继续”（那会静默改语义）。
	const root = makeRoot();
	put(root, "real.ts");
	initRepo(root);
	symlinkSync("real.ts", join(root, "untracked_link.ts"));

	const expected = snapshot(await collectWith(root, "git"));
	const previousFd = process.env.PI_GLOB_FD;
	process.env.PI_GLOB_FD = "/nonexistent/fd";
	try {
		assert.equal(locateFd(), undefined, "PI_GLOB_FD 指向不存在的路径时应当定位失败");
		const got = snapshot(await collectCandidates(root, {}));
		assert.ok(got.includes("untracked_link.ts"), `降级后不该漏掉未跟踪链接：${JSON.stringify(got)}`);
		assert.deepEqual(got, expected);
	} finally {
		if (previousFd === undefined) delete process.env.PI_GLOB_FD;
		else process.env.PI_GLOB_FD = previousFd;
	}
});

test("高速引擎：rg 定位不到时静默降级，结果与 git 引擎一致", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	put(root, "sub/b.ts");
	initRepo(root);

	const expected = snapshot(await collectWith(root, "git"));
	const previousRg = process.env.PI_GLOB_RG;
	const previousPath = process.env.PATH;
	process.env.PI_GLOB_RG = "/nonexistent/rg";
	process.env.PATH = "/nonexistent"; // 连带把 git 也挡掉 → 只剩走查档
	try {
		const fromWalking = snapshot(await collectCandidates(root, {}));
		// 走查档不认 .git，但 .git 被 ALWAYS_PRUNE 剪掉 ⇒ 与 git 档应当一致
		assert.deepEqual(fromWalking, expected);
	} finally {
		if (previousRg === undefined) delete process.env.PI_GLOB_RG;
		else process.env.PI_GLOB_RG = previousRg;
		process.env.PATH = previousPath;
	}
});

test("PI_GLOB_ENGINE=git 完全绕开高速档（即使 rg 可用）", { skip: gitSkip }, async () => {
	const root = makeRoot();
	put(root, "a.ts");
	initRepo(root);
	const previousRg = process.env.PI_GLOB_RG;
	// 把 rg 换成一个一跑就失败的假程序：若引擎仍是 fast，就会降级到 git 档；
	// 而这里要钉的是「配置写了 git 就压根不试 rg」—— 用一个会把结果写坏的假 rg 来验。
	const fakeBin = makeRoot("glob-fake-rg-");
	put(fakeBin, "rg", "#!/bin/sh\necho 'poisoned\0garbage'\n");
	execFileSync("chmod", ["755", join(fakeBin, "rg")]);
	process.env.PI_GLOB_RG = join(fakeBin, "rg");
	try {
		const got = snapshot(await collectWith(root, "git"));
		assert.ok(!got.includes("poisoned"), `PI_GLOB_ENGINE=git 时不该跑 rg：${JSON.stringify(got)}`);
		assert.deepEqual(got, ["a.ts"]);
	} finally {
		if (previousRg === undefined) delete process.env.PI_GLOB_RG;
		else process.env.PI_GLOB_RG = previousRg;
	}
});
