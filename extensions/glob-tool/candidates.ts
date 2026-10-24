/**
 * glob-tool / candidates —— 候选文件枚举的**三档**实现。零 pi 依赖（只用 node 标准库）。
 *
 * ## 三档，按"精度从高到低"排序，前一档成功就不走后面
 *
 * | 档 | 何时用 | 精度来源 | 实测 |
 * | --- | --- | --- | --- |
 * | 1. `git ls-files` | 目录在 git 工作树里 | git 自己的 `.gitignore` 实现 | 332 文件 53ms |
 * | 2. 裸仓库 + `--work-tree` | 无仓库但存在 `.gitignore` | 同上（git 解析 work-tree 的 ignore） | 82ms |
 * | 3. `opendir` 走查 | 上面都不行 | 本仓 `ignore.ts` 的子集 | 17 万文件 1.7s |
 *
 * 把"忽略语义"外包给 git 是这个设计最重要的一个取舍：`.gitignore` 的完整语义包含嵌套
 * 文件、`!` 否定、`.git/info/exclude`、全局 `core.excludesFile`、以及"父目录被忽略则子
 * 路径无法否定"这条陷阱 —— 自己实现一遍只会在这个精度上亏。而 git 已经在那儿了。
 *
 * ## 为什么档 3 不用 `fs.glob`
 *
 * 实测两个硬伤（见 spec §5.3）：① 它**无条件跳过隐藏目录的内部** —— 通配、点通配、
 * 以及"点目录 + 通配"的组合都进不去 `.hidden_dir/`，而 `hidden: true` 必须能进；② 它的
 * `exclude` 回调对同一个目录会**发两次**（`parentPath` 真值一次、`"."` 一次），于是剪枝
 * 计数与"只剪一次"的语义都不可靠。手写 `opendir` 遍历慢 60%，但三件事是确定的：
 * 点文件可控、剪枝显式、**不跟随符号链接**（`opendir` 的 Dirent 是 `lstat` 语义）。
 *
 * ## 这一层不做存在性过滤
 *
 * `git ls-files --cached` 会把"已 `rm` 但没 `git add`"的文件照样列出来（实测）。这一层
 * 的契约是"枚举 git / 目录认得的名字"，存在性由 `index.ts` 的 `statMtime` 统一过滤 ——
 * 因为档 3 只枚举磁盘上存在的条目，把过滤放在这里会让三档语义不一致。
 */

import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIgnoreDecider, createIgnoreMatcher, type IgnoreDecider } from "./ignore.ts";

/** git 子进程的硬上限：超过就降档，不能让一次查询卡住整个会话。 */
const GIT_TIMEOUT_MS = 10_000;
/** `ls-files` 输出上限：17 万文件 × 平均 60 字节 ≈ 10MB，留足余量。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** 走查档的并发 opendir 迭代器上限（实测 16 是最佳区间；见 spec §5.3）。 */
const WALK_CONCURRENCY = 16;
/** 走查档无条件剪掉的目录名（`includeIgnored` 时仍然剪，它们永远不该被列）。 */
const ALWAYS_PRUNE = new Set([".git"]);

export interface CollectOptions {
	/** 连 `.gitignore` 命中的路径也列出来。 */
	includeIgnored?: boolean;
	/** 点路径段是否参与（只影响走查档与档 1/2 的目录条目；轨道点文件永远参与匹配）。 */
	hidden?: boolean;
	signal?: AbortSignal;
}

/** 抛一个带 `code` 的错误，便于 `index.ts` 与测试识别。 */
function abortError(): Error {
	const error = new Error("Operation aborted");
	(error as Error & { code?: string }).code = "ABORT_ERR";
	return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

/** 跑一个 git 子进程，返回 stdout；任何失败（非零退出、超时、缺 git）都返回 `undefined`。 */
function runGit(args: string[], cwd: string | undefined, signal: AbortSignal | undefined): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, signal },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}

/** `-z` 输出按 NUL 切、丢空串。 */
function splitNul(output: string): string[] {
	return output.split("\0").filter((entry) => entry !== "");
}

/** 档 1：目录在 git 工作树里吗？ */
async function isGitWorkTree(root: string, signal: AbortSignal | undefined): Promise<boolean> {
	const out = await runGit(["-C", root, "rev-parse", "--is-inside-work-tree"], undefined, signal);
	return out?.trim() === "true";
}

/**
 * 找 `root` 或其祖先里的第一个 `.gitignore`（档 2 的触发条件）。
 *
 * 只用来判断"值不值得起裸仓库"：没有 `.gitignore` 时裸仓库与走查档结果完全一致，白付
 * 一次 `git init` 的 80ms。
 */
function findGitignore(root: string): string | undefined {
	let current = root;
	for (;;) {
		const candidate = join(current, ".gitignore");
		if (existsSync(candidate)) return candidate;
		const parent = join(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}

/** 裸仓库缓存的 key → `--git-dir` 路径。进程内复用一个 root 只 `git init` 一次。 */
const bareRepoCache = new Map<string, string>();

/** 供测试与服务关闭时清缓存。 */
export function resetBareRepoCache(): void {
	for (const gitDir of bareRepoCache.values()) removeQuietly(gitDir);
	bareRepoCache.clear();
}

/** 删一个临时目录；失败（权限 / 已被清）不影响功能。 */
function removeQuietly(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// 删不掉就让系统回收 —— 不能因为它打断查询。
	}
}

/** 档 2：在一个裸仓库里把 `root` 当 work-tree，让 git 自己解析 ignore。 */
async function collectWithBareRepo(
	root: string,
	options: CollectOptions,
): Promise<string[] | undefined> {
	assertNotAborted(options.signal);
	let gitDir = bareRepoCache.get(root);
	if (gitDir === undefined) {
		const created = mkdtempSync(join(tmpdir(), "glob-bare-"));
		const init = await runGit(["init", "-q", "--bare", created], undefined, options.signal);
		if (init === undefined) {
			// git 不可用 / 被沙箱拦：**不缓存**，也不把刚建的空目录留在 /tmp 里。
			// 不清就是每次调用漏一个 mkdtemp 目录（长时间会话里无界增长）。
			removeQuietly(created);
			return undefined;
		}
		gitDir = created;
		bareRepoCache.set(root, gitDir);
	}
	const args = ["--git-dir", gitDir, "--work-tree", root, "ls-files", "-z", "-o"];
	if (!options.includeIgnored) args.push("--exclude-standard");
	const out = await runGit(args, undefined, options.signal);
	return out === undefined ? undefined : splitNul(out).filter((entry) => !entry.endsWith("/"));
}

/** 读一个目录里的 `.gitignore`（缺失/不可读 → 空表）。 */
function readIgnoreFile(directory: string): string[] {
	try {
		return readFileSync(join(directory, ".gitignore"), "utf8").split("\n");
	} catch {
		return [];
	}
}

type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

/**
 * 把一个目录层的 `.gitignore` 叠到继承来的判定器之上。
 *
 * **必须用三态**（`true` / `false` / `undefined` = 本层无意见），不能合成一个布尔：
 * 父级 `*.log` + 子级 `!keep.log` 时，子级命中并给出 `false`（明确保留），这时要**定案**，
 * 不能再去问父级 —— 一问就会把 `keep.log` 剪掉，而 git 会保留它。这个方向正是
 * `ignore.ts` 文件头写的「宁可多列，不可误剪」。
 */
function combineMatchers(inherited: IgnoreDecider | undefined, lines: readonly string[]): IgnoreDecider | undefined {
	if (lines.length === 0) return inherited;
	const local = createIgnoreDecider(lines);
	if (inherited === undefined) return local;
	return (relPath: string, isDir: boolean): boolean | undefined => {
		const decision = local(relPath, isDir);
		// 本层有意见（命中忽略 **或** 命中否定）就定案；无意见才回落到父级。
		return decision === undefined ? inherited(relPath, isDir) : decision;
	};
}

/**
 * 档 3：BFS + 并发 `opendir` 走查。
 *
 * 剪枝规则（保守方向：宁可多列，不可误剪）：
 *   - `.git` 永远剪；`includeIgnored: false` 时 `node_modules` 也剪；
 *   - `includeIgnored: false` 时用沿途各级 `.gitignore` 的匹配器剪；
 *   - `hidden: false` 时点路径段不出现在结果里（但**目录仍然会被走进去**吗？不 —— 剪掉，
 *     否则在 `node_modules` 之外的点目录上白花时间）。
 *
 * 错误处理：`EACCES` / `ENOENT` / `ENOTDIR` 静默跳过该目录（权限不足、并发删除、符号链接
 * 指向文件），其余抛出 —— 让 `execute` 变成一次失败的 tool result，而不是静默少列。
 */
async function collectByWalking(root: string, options: CollectOptions): Promise<string[]> {
	const signal = options.signal;
	const includeIgnored = options.includeIgnored === true;
	const includeHidden = options.hidden === true;
	const results: string[] = [];
	/**
	 * 待走目录：相对路径 + **该目录生效的忽略匹配器**。
	 *
	 * 必须随队列传递 —— 父目录的 `.gitignore` 对深层文件同样生效（git 语义），只在本层
	 * 新建一个匹配器等于把父规则丢掉。曾经就是这样：注释写着"叠加到父级"，代码却是每层
	 * 一个独立的，于是 `l1/l2/l3/deep.log` 逃过了根目录的 `*.log`。
	 */
	const pending: Array<{ rel: string; matcher: IgnoreDecider | undefined }> = [
		{ rel: "", matcher: undefined },
	];
	let active = 0;

	return await new Promise<string[]>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			fn();
		};
		const pump = (): void => {
			if (settled) return;
			if (active === 0 && pending.length === 0) {
				finish(() => resolve(results));
				return;
			}
			while (active < WALK_CONCURRENCY && pending.length > 0) {
				const { rel, matcher: inheritedMatcher } = pending.shift()!;
				active++;
				void (async () => {
					try {
						assertNotAborted(signal);
						const absolute = rel === "" ? root : join(root, rel);
						// 本层的 .gitignore **叠加**在继承来的匹配器之上：父规则先判，本层规则后判
						// （后者胜，与 git 的"更深的文件优先"一致）。
						const localMatcher = includeIgnored ? inheritedMatcher : combineMatchers(inheritedMatcher, readIgnoreFile(absolute));
						const handle = await opendir(absolute);
						for await (const entry of handle) {
							assertNotAborted(signal);
							const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
							const isDir = entry.isDirectory();
							const isHiddenSegment = entry.name.startsWith(".");
							// `includeIgnored: false` 时 node_modules 恒剪；.git 永远剪。
							if (isDir) {
								if (ALWAYS_PRUNE.has(entry.name)) continue;
								if (!includeIgnored && entry.name === "node_modules") continue;
								if (!includeHidden && isHiddenSegment) continue;
								if (localMatcher?.(childRel, true)) continue;
								pending.push({ rel: childRel, matcher: localMatcher });
								continue;
							}
							if (!entry.isFile()) continue;
							if (!includeHidden && isHiddenSegment) continue;
							if (localMatcher?.(childRel, false)) continue;
							results.push(childRel);
						}
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
							// 权限不足 / 并发删除 / 不是目录：少列这一棵子树，整体不失败。
						} else if (code === "ABORT_ERR") {
							finish(() => reject(error));
							return;
						} else {
							finish(() => reject(error));
							return;
						}
					} finally {
						active--;
						pump();
					}
				})();
			}
		};
		pump();
	});
}

/**
 * 枚举 `root` 下所有候选的相对路径（posix 分隔符）。
 *
 * 顺序：git 工作树 → 裸仓库（仅当有 `.gitignore`）→ 走查。
 * 任何一档失败都静默降档；三档都不能用时以走查的异常结束。
 */
export async function collectCandidates(root: string, options: CollectOptions = {}): Promise<string[]> {
	assertNotAborted(options.signal);
	if (await isGitWorkTree(root, options.signal)) {
		assertNotAborted(options.signal);
		const args = ["-C", root, "ls-files", "-z", "--cached", "--others"];
		if (!options.includeIgnored) args.push("--exclude-standard");
		const out = await runGit(args, undefined, options.signal);
		if (out !== undefined) return splitNul(out).filter((entry) => !entry.endsWith("/"));
	}
	assertNotAborted(options.signal);
	if (!options.includeIgnored && findGitignore(root) !== undefined) {
		const fromBare = await collectWithBareRepo(root, options);
		if (fromBare !== undefined) return fromBare;
	}
	assertNotAborted(options.signal);
	return await collectByWalking(root, options);
}
