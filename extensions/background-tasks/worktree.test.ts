/**
 * background-tasks/worktree.ts 的测试：**真 git fixture** 驱动（tmpdir 里 `git init` +
 * 一次 commit + 一个被忽略的 node_modules），不起 pi、不 mock git。
 *
 * 为什么真 git 而不是假执行器：这里要验证的正是 git 自己的语义 —— worktree 元数据落在
 * `.git/worktrees/`、`git status --porcelain` 对未跟踪文件算不算改动、`worktree remove`
 * 删不删目录、`prune` 收不收尾。假 git 只能重复我自己写的假设。
 *
 *   node --test clients/pi/extensions/background-tasks/worktree.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	DEFAULT_LINK_DIRS,
	cleanupWorktree,
	createWorktree,
	defaultRunGit,
	detectChanges,
	linkIgnoredDirs,
	prepareWorktree,
	serializeGit,
} from "./worktree.ts";

// =============================================================================
// fixture：一个真 git 仓库
// =============================================================================

interface Fixture {
	root: string;
	repo: string;
	tmpRoot: string;
	/** git worktree 元数据是否还留着本 fixture 的记录。 */
	worktreeNames(): string[];
}

const cleanup: Array<() => void> = [];
test.after(() => {
	for (const fn of cleanup) fn();
});

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	assert.equal(result.status, 0, `git ${args.join(" ")} 失败：${result.stderr}`);
	return result.stdout;
}

/** 建一个 fixture 仓库：一次 commit + 被 .gitignore 的 node_modules/。 */
function makeFixture(options: { commit?: boolean } = {}): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-wt-test-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	const tmpRoot = path.join(root, "worktrees");
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(tmpRoot, { recursive: true });

	git(["init", "-q"], repo);
	// git identity：CI 机器上可能没配全局 user.name/email，带上 -c 保证 commit 能成
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "test"], repo);
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
	fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
	fs.writeFileSync(path.join(repo, "sub", "file.txt"), "hello\n");
	if (options.commit !== false) {
		git(["add", "."], repo);
		git(["commit", "-q", "-m", "init"], repo);
	}

	return {
		root,
		repo,
		tmpRoot,
		worktreeNames() {
			const dir = path.join(repo, ".git", "worktrees");
			try {
				return fs.readdirSync(dir);
			} catch {
				return [];
			}
		},
	};
}

// =============================================================================
// createWorktree
// =============================================================================

test("createWorktree：从 HEAD 建、路径在 tmpRoot 下、runCwd 指向子目录", () => {
	const fx = makeFixture();
	const result = createWorktree({
		cwd: path.join(fx.repo, "sub"),
		runDir: path.join(fx.repo, "sub"),
		tmpRoot: fx.tmpRoot,
	});
	assert.equal(result.ok, true, result.ok ? "" : result.reason);
	if (!result.ok) return;

	assert.equal(path.dirname(result.worktree.path), fx.tmpRoot, "worktree 应当建在 tmpRoot 下");
	assert.match(path.basename(result.worktree.path), /^pi-bg-/);
	assert.equal(result.worktree.repoRoot, fs.realpathSync(fx.repo));
	assert.equal(result.worktree.runCwd, path.join(result.worktree.path, "sub"), "runCwd 应当是 worktree 里对应的子目录");
	assert.ok(fs.existsSync(path.join(result.worktree.runCwd, "file.txt")), "HEAD 的文件应当已经在 worktree 里");
	assert.equal(result.worktree.baseCommit, git(["rev-parse", "HEAD"], fx.repo).trim());
});

test("createWorktree：未提交的改动**不**带进去（基线是 HEAD，与 CC 一致）", () => {
	const fx = makeFixture();
	fs.writeFileSync(path.join(fx.repo, "sub", "file.txt"), "edited but not committed\n");
	fs.writeFileSync(path.join(fx.repo, "sub", "brand-new.txt"), "untracked\n");

	const result = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(result.ok, true, result.ok ? "" : result.reason);
	if (!result.ok) return;

	assert.equal(fs.readFileSync(path.join(result.worktree.path, "sub", "file.txt"), "utf-8"), "hello\n");
	assert.equal(fs.existsSync(path.join(result.worktree.path, "sub", "brand-new.txt")), false);
	// 干净的起点正是「有没有改动」判定可靠的前提
	assert.equal(detectChanges(result.worktree.path, result.worktree.baseCommit).dirtyFiles, 0);
});

test("createWorktree：node_modules 被 symlink 进来，且链到主仓库那一份", () => {
	const fx = makeFixture();
	const modules = path.join(fx.repo, "node_modules");
	fs.mkdirSync(path.join(modules, "some-pkg"), { recursive: true });
	fs.writeFileSync(path.join(modules, "some-pkg", "index.js"), "module.exports = 1\n");

	const result = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(result.ok, true, result.ok ? "" : result.reason);
	if (!result.ok) return;

	const linked = path.join(result.worktree.path, "node_modules");
	assert.ok(fs.lstatSync(linked).isSymbolicLink(), "应当是符号链接而不是复制");
	assert.equal(fs.realpathSync(linked), fs.realpathSync(modules));
	assert.deepEqual(result.worktree.linkedDirs, ["node_modules"], "报的是 worktree 内的相对路径");
	// symlink 的 node_modules 不能算改动：`.gitignore` 的 `node_modules/` 只匹配目录，
	// 符号链接会被 git 当成未跟踪文件，所以判定走 pathspec 排除（实测踩到过）
	assert.equal(detectChanges(result.worktree.path, result.worktree.baseCommit, undefined, result.worktree.linkedDirs).dirtyFiles, 0);
	assert.ok(git(["status", "--porcelain"], result.worktree.path).includes("node_modules"), "不排除时 git 确实会把它当未跟踪（这就是要排除的原因）");
});

test("linkIgnoredDirs：未被 ignore 的目录不链（否则会污染 git status）", () => {
	const fx = makeFixture();
	// tracked/ 是被提交的目录，不该被当成依赖链走
	fs.mkdirSync(path.join(fx.repo, "tracked"), { recursive: true });
	fs.writeFileSync(path.join(fx.repo, "tracked", "x.txt"), "x\n");
	git(["add", "tracked"], fx.repo);
	git(["commit", "-q", "-m", "tracked dir"], fx.repo);

	const result = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(result.ok, true, result.ok ? "" : result.reason);
	if (!result.ok) return;

	const linked = linkIgnoredDirs(fx.repo, result.worktree.path, ["tracked", "node_modules"]);
	assert.deepEqual(linked, [], "两个都不该被链：一个存在但没被忽略，一个被忽略但不存在");
	assert.equal(fs.lstatSync(path.join(result.worktree.path, "tracked")).isSymbolicLink(), false);
});

test("DEFAULT_LINK_DIRS 是 node_modules（本机项目的依赖目录口径）", () => {
	assert.deepEqual([...DEFAULT_LINK_DIRS], ["node_modules"]);
});

test("非 git 目录 / 空仓库：降级为 ok:false + 可读原因，不抛异常", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-wt-nogit-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));

	const notRepo = createWorktree({ cwd: root, runDir: root, tmpRoot: path.join(root, "w") });
	assert.equal(notRepo.ok, false);
	if (!notRepo.ok) assert.match(notRepo.reason, /git 仓库/);

	const empty = path.join(root, "empty-repo");
	fs.mkdirSync(empty, { recursive: true });
	git(["init", "-q"], empty);
	const noHead = createWorktree({ cwd: empty, runDir: empty, tmpRoot: path.join(root, "w") });
	assert.equal(noHead.ok, false);
	if (!noHead.ok) assert.match(noHead.reason, /HEAD/);
});

// =============================================================================
// detectChanges / cleanupWorktree：三态
// =============================================================================

test("三态①：一条文件都没碰 → 整个删掉，worktree 元数据也清干净", async () => {
	const fx = makeFixture();
	const prepared = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
	if (!prepared.ok) return;
	const wt = prepared.worktree;
	assert.equal(fx.worktreeNames().length, 1, "建完应当有一条 worktree 记录");

	// 只读任务：读了文件、建了被 ignore 的产物（都不算改动）
	fs.readFileSync(path.join(wt.path, "sub", "file.txt"), "utf-8");
	fs.mkdirSync(path.join(wt.path, "dist"), { recursive: true });
	fs.writeFileSync(path.join(wt.path, "dist", "out.txt"), "artifact\n");

	const outcome = await cleanupWorktree(wt);
	assert.equal(outcome.kind, "removed", JSON.stringify(outcome));
	assert.equal(fs.existsSync(wt.path), false, "worktree 目录应当被删掉");
	assert.deepEqual(fx.worktreeNames(), [], ".git/worktrees 的元数据应当被 prune 掉");
});

test("三态②a：改了文件 → 保留 + 报改动文件数，目录与内容都在", async () => {
	const fx = makeFixture();
	const prepared = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
	if (!prepared.ok) return;
	const wt = prepared.worktree;

	fs.writeFileSync(path.join(wt.path, "sub", "file.txt"), "changed by task\n");
	fs.writeFileSync(path.join(wt.path, "NEW.md"), "created by task\n");

	const outcome = await cleanupWorktree(wt);
	assert.equal(outcome.kind, "kept", JSON.stringify(outcome));
	if (outcome.kind !== "kept") return;
	assert.equal(outcome.changes.dirtyFiles, 2);
	assert.equal(outcome.changes.commits, 0);
	assert.equal(outcome.branch, undefined, "没有新 commit 就不该挂分支");
	assert.match(outcome.reason, /2 个文件有改动/);
	assert.equal(fs.readFileSync(path.join(wt.path, "sub", "file.txt"), "utf-8"), "changed by task\n");
});

test("三态②b：有 commit → 保留 + 挂一个分支保住 detached commit（否则会被 gc 丢掉）", async () => {
	const fx = makeFixture();
	const prepared = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
	if (!prepared.ok) return;
	const wt = prepared.worktree;

	fs.writeFileSync(path.join(wt.path, "work.txt"), "committed by task\n");
	git(["add", "work.txt"], wt.path);
	git(["commit", "-q", "-m", "task commit"], wt.path);
	const headSha = git(["rev-parse", "HEAD"], wt.path).trim();

	const outcome = await cleanupWorktree(wt, "pi/bg_bg_7");
	assert.equal(outcome.kind, "kept", JSON.stringify(outcome));
	if (outcome.kind !== "kept") return;
	assert.equal(outcome.changes.commits, 1);
	assert.ok(outcome.branch, "有新 commit 时必须挂分支");
	assert.match(outcome.branch!, /^pi\/bg_bg_7-/);
	// 分支确实指向那个 detached commit（工作区里没有引用时 commit 会被 gc 回收）
	assert.equal(git(["rev-parse", outcome.branch!], fx.repo).trim(), headSha);
	assert.match(outcome.reason, /1 个新提交|1 个新提交/);
});

test("三态②c：无 commit 时 branchPrefix 为空串也不挂分支（测试路径）", async () => {
	const fx = makeFixture();
	const prepared = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
	if (!prepared.ok) return;
	fs.writeFileSync(path.join(prepared.worktree.path, "x.txt"), "x\n");
	const outcome = await cleanupWorktree(prepared.worktree, "");
	assert.equal(outcome.kind, "kept");
	if (outcome.kind === "kept") assert.equal(outcome.branch, undefined);
});

test("detectChanges：未跟踪文件也算改动（任务新建的文件不能丢）", () => {
	const fx = makeFixture();
	const prepared = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
	if (!prepared.ok) return;
	const wt = prepared.worktree;
	assert.equal(detectChanges(wt.path, wt.baseCommit).dirtyFiles, 0);

	fs.writeFileSync(path.join(wt.path, "untracked.txt"), "x\n");
	assert.equal(detectChanges(wt.path, wt.baseCommit).dirtyFiles, 1);

	fs.writeFileSync(path.join(wt.path, "untracked.txt"), "");
	fs.mkdirSync(path.join(wt.path, "ignored-dir"), { recursive: true });
	fs.writeFileSync(path.join(wt.path, "ignored-dir", "a"), "x\n");
	// gitignore 里的东西不该算改动（否则每个 npm/playwright 产物都会让 worktree 被保留）
	fs.appendFileSync(path.join(wt.path, ".gitignore"), "ignored-dir/\n");
	const state = detectChanges(wt.path, wt.baseCommit);
	assert.equal(state.dirtyFiles, 2, "空文件与 .gitignore 自身是改动");
});

test("cleanupWorktree 幂等：删过之后再删一次也不抛，按 left 报", async () => {
	const fx = makeFixture();
	const prepared = createWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot });
	assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.reason);
	if (!prepared.ok) return;

	const first = await cleanupWorktree(prepared.worktree);
	assert.equal(first.kind, "removed");
	const second = await cleanupWorktree(prepared.worktree);
	assert.ok(second.kind === "removed" || second.kind === "left", `二次清理应当是 removed 或 left，实际 ${second.kind}`);
	assert.equal(fs.existsSync(prepared.worktree.path), false);
});

// =============================================================================
// serializeGit：并发建删串行化
// =============================================================================

test("serializeGit：同一时刻只有一个任务在跑（并发建 worktree 不撞 .git 锁）", async () => {
	let active = 0;
	let maxActive = 0;
	const runs = Array.from({ length: 6 }, (_, index) =>
		serializeGit(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5 + index));
			active -= 1;
			return index;
		}),
	);
	const results = await Promise.all(runs);
	assert.deepEqual(results, [0, 1, 2, 3, 4, 5], "顺序应当保持调用顺序");
	assert.equal(maxActive, 1);
});

test("serializeGit：一次失败不会毒化后续调用", async () => {
	await assert.rejects(() => serializeGit(() => {
		throw new Error("boom");
	}));
	const ok = await serializeGit(() => "still works");
	assert.equal(ok, "still works");
	// 同步抛出的 rejection 也要被真处理掉，避免 unhandled rejection 噪声
	await new Promise((resolve) => setTimeout(resolve, 10));
});

test("prepareWorktree 走队列且真建出一份（端到端等价路径）", async () => {
	const fx = makeFixture();
	const results = await Promise.all([
		prepareWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot }),
		prepareWorktree({ cwd: fx.repo, runDir: fx.repo, tmpRoot: fx.tmpRoot }),
	]);
	for (const result of results) assert.equal(result.ok, true, result.ok ? "" : result.reason);
	assert.equal(fx.worktreeNames().length, 2, "两份都在");
	for (const result of results) {
		if (result.ok) await cleanupWorktree(result.worktree);
	}
	assert.deepEqual(fx.worktreeNames(), []);
});

// =============================================================================
// 降级路径的细节
// =============================================================================

test("realpath 归一：cwd 用 /var 而 git 返回 /private/var 时，runCwd 仍落在 worktree 里", () => {
	const fx = makeFixture();
	// macOS 的 syscall realpath 会走 /private/var；用 fixture 的 realpath 反过来构造这个差异
	const realRepo = fs.realpathSync(fx.repo);
	const result = createWorktree({ cwd: realRepo, runDir: path.join(realRepo, "sub"), tmpRoot: fx.tmpRoot });
	assert.equal(result.ok, true, result.ok ? "" : result.reason);
	if (!result.ok) return;
	assert.ok(
		result.worktree.runCwd.startsWith(result.worktree.path),
		`runCwd ${result.worktree.runCwd} 应当落在 ${result.worktree.path} 里`,
	);
});

test("defaultRunGit 在非仓库目录返回非零码而不是抛异常", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-wt-plain-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const result = defaultRunGit(["rev-parse", "--show-toplevel"], root);
	assert.notEqual(result.code, 0);
});
