/**
 * background-tasks/worktree.ts — 后台任务的 **git worktree 隔离**（纯逻辑，不碰 pi API）。
 *
 * ## 为什么
 *
 * `run_in_background` 原先直接在会话的 `cwd` 里 spawn，多个并发任务共享**同一份工作区**。
 * 2026-09-30 的 mc-heavy 会话（峰值 8 个并发）实测到后果：`bg_4` 的 A/B 脚本改写
 * `minecart-config.js` 时，`bg_3` 声称在测「基线」却读到了处理组的代码 —— 基线数据静默作废。
 * 限流解决不了这件事（8 个并发全在阈值以下，而 `cargo test` / `npm install` 这类安全并行
 * 反会被误伤）；根因是**多个写者共享一份工作区**，所以要的是隔离而不是排队。
 *
 * ## 语义：对齐 CC 的 `isolation: "worktree"`
 *
 * CC 的工具描述原文是「the worktree is automatically cleaned up if the agent makes no
 * changes; otherwise the path and branch are returned in the result」—— 三态：
 *
 *   | 终态时 worktree 的状态 | 处理 |
 *   |---|---|
 *   | 无改动（未提交改动为空 **且** 无新 commit） | 整个删掉（`git worktree remove` + `prune`），无痕 |
 *   | 有未提交改动 / 有新 commit | **保留**，路径（新 commit 还加一个分支名）交给调用方报给模型 |
 *   | 删除失败 | 保留 + 原始 git 报错，fail-safe（宁可留，不可误删） |
 *
 * 为什么有改动就保留而不是也删掉：那时它已经不是「跑测试的后台任务」而是「并行的写作者」，
 * 删掉 worktree 等于把产出一起删掉。
 *
 * ## 三个实现选择（用户 2026-09-30 拍板）
 *
 * 1. **基线 = HEAD**（与 CC 一致）：从最近一次提交建，工作区里未提交的改动**不带进去**。
 *    好处是起始状态干净 —— 「任务有没有改文件」的判定因此完全可靠（对比 HEAD 即可）。
 *    代价：先在前台改完文件再起后台测试，测到的是旧代码；要测当前工作区必须显式关掉隔离。
 * 2. **依赖目录 symlink 主仓库那份**：worktree 里没有 `node_modules`（被 gitignore），
 *    不链过去任务根本跑不起来。只在**被 gitignore 覆盖**且**主仓库里真实存在**时才链，
 *    且用 `lstat` 跳过已经是符号链接的条目（否则链中链）。
 * 3. **worktree 落在系统临时目录**（`fs.mkdtempSync(os.tmpdir() + "/pi-bg-")`）：在 seatbelt
 *    可删边界内（`git worktree remove` 不会被内核拦下），且保留态不会污染仓库树。
 *
 * `--detach` 而非 `-B <branch>`：不动 `git branch` 列表。无痕是这次的目标，CC 的 `-B` 会
 * 在工作区留一个分支，所以不照抄。有新 commit 时（detached 的 commit 会被 gc 丢掉）才
 * 补挂一个 `pi/bg_<id>-<时间戳>` 引用保住它。
 *
 * ## 串行化
 *
 * 建与删都要写主仓库的 `.git/worktrees/`，多个任务并行时有极小概率撞 git 自己的锁。
 * `serializeGit` 是一个进程内的 promise 链，只把这两步排成队列（任务本身的执行仍并行）。
 *
 * ## 可注入
 *
 * `runGit` 可注入，测试用真 git 驱动（fixture 在 tmpdir 里 `git init`），也可以用假的
 * 命令执行器断言参数。所有函数不抛异常路径给调用方 —— 建失败返回 `error`，调用方降级成
 * 「不隔离」跑，删失败返回 `kept`。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 一次 git 调用的结果。`code === 0` 为成功。 */
export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type RunGit = (args: readonly string[], cwd: string) => GitResult;

/** 默认实现：同步 spawn（建/删 worktree 只花几十毫秒，且必须在下一次 spawn 之前完成）。 */
export const defaultRunGit: RunGit = (args, cwd) => {
	const result = spawnSync("git", args as string[], { cwd, encoding: "utf-8" });
	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		// 没有可执行文件时 spawnSync 回 error 而不是非零码，这里折进 stderr 供报错用
		stderr: result.stderr || (result.error ? String(result.error.message) : ""),
	};
};

/** 进程内的 git 串行队列：同一时刻只有一个建/删在跑。 */
let queue: Promise<unknown> = Promise.resolve();

export function serializeGit<T>(fn: () => T): Promise<T> {
	const next = queue.then(fn, fn);
	// 链上不保留失败，否则一次失败会毒化后续所有调用
	queue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

/** 建 worktree 用的输入。 */
export interface CreateWorktreeOptions {
	/** 会话当前的工作目录（任务的 cwd 或其祖先）。 */
	cwd: string;
	/** 主仓库里要对应到 worktree 里的那个目录（相对或绝对）。 */
	runDir: string;
	/** 主仓库里要 symlink 进 worktree 的 gitignore 目录（默认 `["node_modules"]`）。 */
	linkIgnoredDirs?: readonly string[];
	/** 临时目录的父目录，测试隔离用（默认 `os.tmpdir()`）。 */
	tmpRoot?: string;
	/** git 执行器，测试注入用。 */
	runGit?: RunGit;
}

export interface CreatedWorktree {
	/** worktree 的绝对路径。 */
	path: string;
	/** 主仓库根。 */
	repoRoot: string;
	/** 建时的 HEAD commit sha —— 判定「有没有新 commit」的基线。 */
	baseCommit: string;
	/** 任务实际应该 spawn 的 cwd（= worktree 里与 runDir 对应的绝对路径）。 */
	runCwd: string;
	/** 已 symlink 进来的依赖目录（**worktree 内的相对路径**，如 `node_modules`）。
	 *  改动判定靠它的 pathspec 排除，见 `detectChanges`。 */
	linkedDirs: string[];
}

export type CreateWorktreeResult =
	| { ok: true; worktree: CreatedWorktree }
	| { ok: false; reason: string };

/**
 * 在给定的仓库里建一个 worktree，并算出任务实际要跑的目录。
 *
 * 失败一律返回 `{ ok: false, reason }`（不在 git 仓库、worktree add 失败），调用方据此
 * 降级成「不隔离」在原 cwd 跑 —— **不能因为隔离失败就拒绝任务**。
 */
export function createWorktree(options: CreateWorktreeOptions): CreateWorktreeResult {
	const runGit = options.runGit ?? defaultRunGit;
	const cwd = path.resolve(options.cwd);
	const runDir = path.resolve(cwd, options.runDir);

	const rootResult = runGit(["rev-parse", "--show-toplevel"], cwd);
	if (rootResult.code !== 0 || !rootResult.stdout.trim()) {
		return { ok: false, reason: "不在 git 仓库里" };
	}
	// --show-toplevel 可能返回 /private/var/... 而 cwd 是 /var/...（macOS 的 /tmp 软链），
	// 两边都用 realpath 归一，否则下面的 relative() 会算出爬出仓库的 ../..
	const repoRoot = realpath(rootResult.stdout.trim());
	const head = runGit(["rev-parse", "HEAD"], repoRoot);
	if (head.code !== 0 || !head.stdout.trim()) {
		// 空仓库（还没有任何 commit）：没有 HEAD 可作基线，降级不隔离
		return { ok: false, reason: "仓库还没有任何提交（HEAD 不存在）" };
	}
	const baseCommit = head.stdout.trim();

	let worktreePath: string;
	try {
		worktreePath = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "pi-bg-"));
	} catch (error) {
		return { ok: false, reason: `建临时目录失败：${message(error)}` };
	}

	const add = runGit(["worktree", "add", "--detach", worktreePath, baseCommit], repoRoot);
	if (add.code !== 0) {
		// 半成品目录：git 可能已经建了一部分，清掉自己的这一份，不留残骸
		fs.rmSync(worktreePath, { recursive: true, force: true });
		runGit(["worktree", "prune"], repoRoot);
		return { ok: false, reason: `git worktree add 失败：${firstLine(add.stderr) || `exit ${add.code}`}` };
	}

	const linkedDirs = linkIgnoredDirs(
		repoRoot,
		worktreePath,
		options.linkIgnoredDirs ?? DEFAULT_LINK_DIRS,
		runGit,
	);

	const relative = path.relative(realpath(repoRoot), realpath(runDir));
	const runCwd = relative === "" ? worktreePath : path.join(worktreePath, relative);
	return { ok: true, worktree: { path: worktreePath, repoRoot, baseCommit, runCwd, linkedDirs } };
}

/** 默认要链进 worktree 的被忽略目录（本机项目的依赖目录）。 */
export const DEFAULT_LINK_DIRS: readonly string[] = ["node_modules"];

/**
 * 把主仓库里被 gitignore 的依赖目录 symlink 进 worktree。
 *
 * 三条安全条件缺一不可：① 主仓库里真实存在且是**目录**（用 `lstat`，已经是符号链接的跳过，
 * 否则链中链在删 worktree 时可能被 `rm -rf` 跟随）；② 被 gitignore 覆盖（否则链进去会污染
 * `git status`，「有没有改动」的判定就废了）；③ worktree 里还不存在同名条目。
 *
 * 返回的是**worktree 内的相对路径**（`detectChanges` 要拿它做 pathspec 排除）。
 */
export function linkIgnoredDirs(
	repoRoot: string,
	worktreePath: string,
	dirs: readonly string[],
	runGit: RunGit = defaultRunGit,
): string[] {
	const linked: string[] = [];
	for (const dir of dirs) {
		const source = path.join(repoRoot, dir);
		const target = path.join(worktreePath, dir);
		try {
			const stat = fs.lstatSync(source);
			if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
		} catch {
			continue; // 主仓库里没有这个目录
		}
		try {
			fs.lstatSync(target);
			continue; // worktree 里已经有同名条目（例如被跟踪的目录）
		} catch {
			// 不存在才链
		}
		// 用 `git check-ignore -q` 判定：被忽略的才链。退出码 0 = 被忽略，1 = 未忽略。
		const ignored = runGit(["check-ignore", "-q", "--", dir], repoRoot).code === 0;
		if (!ignored) continue;
		try {
			fs.symlinkSync(source, target, "dir");
			linked.push(dir);
		} catch {
			// 链不上（权限 / 竞态）不致命：任务可能只是跑不起来，报错留给任务自己
		}
	}
	return linked;
}

/** 工作区的改动状态 —— 三态判定的输入。 */
export interface ChangeState {
	/** 未提交改动的文件数（`git status --porcelain` 的行数，含未跟踪文件）。 */
	dirtyFiles: number;
	/** 相对基线的提交数。 */
	commits: number;
	/** HEAD（或工作区）的 sha，有 commit 时用来挂分支。 */
	headSha: string;
}

/**
 * 读取 worktree 相对基线的改动状态。
 *
 * `linkedDirs` 必须传进来（`cleanupWorktree` 已经做了）：`.gitignore` 里的 `node_modules/`
 * 只匹配**目录**，我们链进去的是一个**符号链接**，git 会把它当成未跟踪文件（`?? node_modules`）。
 * 不排除的话，每个任务无论干什么都会被判成「有改动」，无改动就删的那一态永远走不到 ——
 * 实测踩到过。排除用 pathspec（`:(exclude)<dir>`）而不是改 `.gitignore`：后者会改仓库文件，
 * 也不属于这里该管的事。
 */
export function detectChanges(
	worktreePath: string,
	baseCommit: string,
	runGit: RunGit = defaultRunGit,
	linkedDirs: readonly string[] = [],
): ChangeState {
	// pathspec 的 `:(exclude)X` 相对 cwd，所以转成从 worktree 根算起的相对路径（`dir` 本身就是
	// 相对路径，先 resolve 成绝对再 relative —— 直接 relative 会把它当成相对进程 cwd 的路径，
	// 算出爬出 worktree 的 ../.. 而被下面的过滤丢掉）。`.` 显式限定范围。
	const excludes = linkedDirs
		.map((dir) => path.relative(worktreePath, path.resolve(worktreePath, dir)))
		.filter((rel) => rel && !rel.startsWith(".."))
		.map((rel) => `:(exclude)${rel}`);
	const status = runGit(["status", "--porcelain", "--", ".", ...excludes], worktreePath);
	const commits = runGit(["rev-list", "--count", `${baseCommit}..HEAD`], worktreePath);
	const head = runGit(["rev-parse", "HEAD"], worktreePath);
	return {
		// git 读不出来时按 0 算：删除路径另有 `kept` 兜底（remove 失败会保留），
		// 而反过来把一次成功的只读任务误判成「有改动」会在 $TMPDIR 里堆积垃圾。
		dirtyFiles: status.code === 0 ? countLines(status.stdout) : 0,
		commits: commits.code === 0 ? Number.parseInt(commits.stdout.trim() || "0", 10) || 0 : 0,
		headSha: head.code === 0 ? head.stdout.trim() : "",
	};
}

export type CleanupOutcome =
	/** 无改动，已彻底删除。 */
	| { kind: "removed" }
	/** 有改动，保留；`branch` 仅在确实有新 commit 时给出。 */
	| { kind: "kept"; reason: string; changes: ChangeState; branch?: string }
	/** 删除失败，保留 + 原始报错。 */
	| { kind: "left"; reason: string };

/**
 * 终态清理：读改动 → 决定保留还是删除（三态）。
 *
 * `branchPrefix` 为空串时不给新 commit 挂分支（测试用）；默认 `pi/bg_<id>`。
 */
export function cleanupWorktree(
	worktree: Pick<CreatedWorktree, "path" | "repoRoot" | "baseCommit" | "linkedDirs">,
	branchPrefix = "",
	runGit: RunGit = defaultRunGit,
): Promise<CleanupOutcome> {
	return serializeGit(() => {
		const changes = detectChanges(worktree.path, worktree.baseCommit, runGit, worktree.linkedDirs);
		if (changes.dirtyFiles > 0 || changes.commits > 0) {
			let branch: string | undefined;
			if (changes.commits > 0 && changes.headSha) {
				const name = `${branchPrefix || "pi/bg"}-${Date.now().toString(36)}`;
				// detached 的 commit 会被 gc 丢掉，挂一个 ref 保住它。挂不上（重名）不算失败 —— 
				// 路径仍在，成果不会丢。
				if (runGit(["branch", name, changes.headSha], worktree.repoRoot).code === 0) branch = name;
			}
			const reason =
				changes.commits > 0
					? `${changes.dirtyFiles} 个文件有改动，另有 ${changes.commits} 个新提交`
					: `${changes.dirtyFiles} 个文件有改动`;
			return { kind: "kept", reason, changes, branch } satisfies CleanupOutcome;
		}
		const remove = runGit(["worktree", "remove", "--force", worktree.path], worktree.repoRoot);
		if (remove.code === 0) {
			// `worktree remove` 会删目录；`.git/worktrees/<name>` 的残记录用 prune 收尾
			runGit(["worktree", "prune"], worktree.repoRoot);
			fs.rmSync(worktree.path, { recursive: true, force: true });
			return { kind: "removed" } satisfies CleanupOutcome;
		}
		return {
			kind: "left",
			reason: firstLine(remove.stderr) || `git worktree remove 失败（exit ${remove.code}）`,
		} satisfies CleanupOutcome;
	});
}

/**
 * 任务启动前的建 + 链，整体走串行队列。
 *
 * 建失败返回 `{ ok: false }`，调用方降级成「不隔离」跑在会话的 cwd 里 —— 隔离是增强，
 * 不是任务能否跑的前提。
 */
export function prepareWorktree(options: CreateWorktreeOptions): Promise<CreateWorktreeResult> {
	return serializeGit(() => createWorktree(options));
}

function realpath(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return target;
	}
}

function countLines(text: string): number {
	return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
