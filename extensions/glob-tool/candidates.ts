/**
 * glob-tool / candidates —— 候选文件枚举。零 pi 依赖（只用 node 标准库）。
 *
 * ## 引擎选择（用户 2026-10-26 定：高速档默认开启，手动可回退）
 *
 * | 引擎 | 何时用 | tracked 来源 | 磁盘来源 | 实测（394 条仓库） |
 * | --- | --- | --- | --- | --- |
 * | `git`（旧档） | `PI_GLOB_ENGINE=git`，或 rg 找不到 | `git ls-files` | `git ls-files --others` | 117 ms |
 * | `rg`（默认） | rg 可用且 index 可解析 | **直接读 `.git/index`**（0.12 ms） | `rg --files` + `fd -t l` | 60 ms |
 *
 * 两者语义等价：`git ls-files --cached --others --exclude-standard` ≡
 * **索引里的一切** ∪ **磁盘上未被 ignore 的**。高速档把两半分别交给最合适的工具：
 *
 * - 索引那一半**不能让 rg 顶替** —— 符号链接条目、`git add -f` 强加的已跟踪但被 ignore
 *   的文件、已 `rm` 未 `git add` 的名字、嵌套仓库的目录条目，磁盘上要么不存在、要么
 *   被 ignore 藏掉。所以直接 `readFileSync` + 解析索引二进制（`git-index.ts`）。
 * - 磁盘那一半用 `rg --files --no-require-git`：`--no-require-git` 是关键词 ——
 *   没有它，rg 在**不是 git 仓库**的目录里会完全无视 `.gitignore`（实测），于是裸仓库
 *   兜底（`git init --bare`，46 ms）还得留着；有它，非 git 目录的 ignore 语义白送。
 * - 符号链接 rg 不列（设计如此）且 `--follow` 会展开目标、遇断链直接报错，所以另跑一次
 *   `fd -H -t l` 只拿链接条目本身（22 ms）。
 * - `--hidden` 会让 rg 深入 `.git/`（实测 40 条），所以必须显式 `--glob '!.git/'`。
 *
 * 旧的三档（git 工作树 → 裸仓库 → `opendir` 走查）全部保留：高速档任一步失败（rg / fd
 * 定位不到、索引版本不认识、`PI_GLOB_ENGINE=git`）就静默落到它们，**绝不因为工具缺失
 * 而报错**。
 *
 * ## 这一层不做存在性过滤
 *
 * `git ls-files --cached` 会把"已 `rm` 但没 `git add`"的文件照样列出来（实测）。这一层
 * 的契约是"枚举 git / 目录认得的名字"，存在性由 `index.ts` 的 `statMtime` 统一过滤 ——
 * 因为走查档只枚举磁盘上存在的条目，把过滤放在这里会让各档语义不一致。
 */

import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { readFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative as relativePath } from "node:path";
import { locateFd, locateRipgrep } from "./bin.ts";
import { findRepoRoot, readIndexPaths } from "./git-index.ts";
import { createIgnoreDecider, createIgnoreMatcher, type IgnoreDecider } from "./ignore.ts";

/** git 子进程的硬上限：超过就降档，不能让一次查询卡住整个会话。 */
const GIT_TIMEOUT_MS = 10_000;
/** 外部工具（rg / fd）的超时：与 git 同量级；超时就降档。 */
const TOOL_TIMEOUT_MS = 10_000;
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
 * 跑一个短命外部工具（rg / fd），stdout 按 NUL 切分。任何失败（非零退出、超时、信号）
 * 返回 `undefined` —— 调用方据此降档。
 */
function runTool(command: string, args: string[], cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ cwd, timeout: TOOL_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, signal, encoding: "utf8" },
			(error, stdout) => resolve(error ? undefined : stdout),
		);
	});
}

/** 高速档的磁盘半边：`rg --files` 的固定参数。 */
const RG_BASE_ARGS = ["--files", "-0", "--hidden", "--glob", "!.git/"];

/** 路径里是否有以点开头的段。 */
function hasDotSegment(value: string): boolean {
	return value.split("/").some((segment) => segment.startsWith("."));
}

/**
 * 嵌套 git 仓库的边界：由 `files` 反推出全部目录，返回那些**目录里坐着一个 `.git`**
 * 的前缀（`"nested"`、`"a/b"`）。
 *
 * 旧引擎靠的是 `git ls-files` 不会进入子仓库、只报一条 `nested/` 目录条目（随后被尾斜杠
 * 规则丢掉），而 rg 会直接穿进去把 `nested/inner.ts` 列出来 —— 这是实测到的**唯一**语义
 * 漂移（`/tmp/edge-verify` 的 7 处差异全是它）。要保住旧语义，就得在高速档里显式还原
 * 这条边界：子仓库里的条目整体丢掉，只留目录名本身（与 git 的 `nested/` 一致）。
 *
 * 代价：需要为**出现过的每个目录**做一次 `existsSync`（3.2 万文件 / 3205 个目录实测 6.6ms）。
 * 做不到就对不上语义 —— 而语义是这个工具存在的理由。
 */
function findNestedRepoPrefixes(root: string, entries: readonly string[]): string[] {
	const directories = new Set<string>();
	for (const entry of entries) {
		if (entry.endsWith("/")) continue;
		let directory = dirname(entry);
		while (directory !== "." && directory !== "/" && directory !== "") {
			directories.add(directory);
			directory = dirname(directory);
		}
	}
	const nested: string[] = [];
	for (const directory of directories) {
		if (existsSync(join(root, directory, ".git"))) nested.push(directory);
	}
	return nested;
}

/**
 * 高速档：索引里的 tracked 名字 ∪ 磁盘上未忽略的文件 ∪ 符号链接条目。
 *
 * 返回 `undefined` 表示这条引擎用不了（rg 定位不到 / 跑挂了）—— 调用方降档。
 * 索引解析失败**不算**不可用：那只影响 tracked 半边，磁盘半边仍然是对的。
 */
async function collectWithRg(root: string, options: CollectOptions): Promise<string[] | undefined> {
	const rgCommand = locateRipgrep();
	if (rgCommand === undefined) return undefined;
	assertNotAborted(options.signal);

	const paths = new Set<string>();

	// ① tracked：直接读索引，零子进程。子目录调用时按前缀裁剪。
	//    `hidden: false` **不过滤这一半** —— 轨道点文件（`.github/workflows/ci.yml`）
	//    是仓库的一部分，与 `match.ts` 的 `unhide` 同一口径。
	const repo = findRepoRoot(root);
	if (repo !== undefined) {
		const tracked = readIndexPaths(join(repo.gitDir, "index"));
		if (tracked !== undefined) {
			const prefix = relativePath(repo.root, root).split("\\").join("/");
			for (const entry of tracked) {
				// 目录 / gitlink 条目（尾斜杠）直接丢 —— 与 `ls-files` 分支的过滤一致。
				if (entry.endsWith("/")) continue;
				if (prefix === "") paths.add(entry);
				else if (entry.startsWith(`${prefix}/`)) paths.add(entry.slice(prefix.length + 1));
			}
		}
	}

	// ② 磁盘半边。三个开关缺一不可，每个都对应一个实测过的坑：
	//    `--no-require-git`  没有仓库的目录里也认 `.gitignore`（否则只能靠裸仓库兜底）；
	//    `--no-ignore-parent` 不读**搜索根之上**的 `.gitignore` —— 加了 no-require-git 后 rg
	//                        会一路往上找，实测 `~/.pi/agent/npm/.gitignore`（内容 `*`）把
	//                        一次 3.2 万文件的查询滤成了 0 条，而 git 只读工作树内的；
	//    `--no-ignore-dot`   不让 `.ignore` / `.rgignore` 生效 —— git 也不认那两个文件。
	const rgArgs = [...RG_BASE_ARGS, "--no-require-git", "--no-ignore-parent", "--no-ignore-dot"];
	if (options.includeIgnored) rgArgs.push("--no-ignore");
	const fromRg = await runTool(rgCommand, rgArgs, root, options.signal);
	if (fromRg === undefined) return undefined;
	// `hidden` 历来**不**作用于 git 档（`git ls-files` 根本没有 hidden 概念：`.gitignore`、
	// 未跟踪的 `.env.example` 全都列），只作用于走查档（那里是 shell 语义）。
	// 旧档落到走查的唯一条件 = 没有仓库 **且** 没有可用的 `.gitignore`；这里照那个条件复刻，
	// 其余情形与旧档 1/2 逐条一致（否则会凭空多出新行为）。
	const applyHiddenFilter = options.hidden !== true && repo === undefined && findGitignore(root) === undefined;
	const diskEntries = splitNul(fromRg).filter((entry) => !(applyHiddenFilter && hasDotSegment(entry)));

	// ②b 嵌套仓库边界：git 不进入子仓库，rg 会穿进去。两种状态（实测 `/tmp/nest-*`）：
	//       - 子仓库内的文件**不在**父索引里（未跟踪 / 子仓库被父 add 过）→ `ls-files`
	//         只报 `nested/` 目录条目；旧档 1 随后把尾斜杠条目全丢掉 ⇒ 内部文件一个不出。
	//       - 文件先 add、**后来**才在 `nested/` 里 `git init` → 索引里已是普通 blob，
	//         `ls-files` 照样列 `nested/inner.ts`。
	//     所以：**索引来的条目永远保留**，只对**磁盘拓来的**条目应用子仓库边界。
	//     不补 `nested/` 目录条目 —— 旧档 1 会把它过滤掉（本层契约：不返回目录）。
	const nestedPrefixes = findNestedRepoPrefixes(root, diskEntries);
	const trackedPaths = new Set(paths);
	const insideNested = (entry: string): boolean =>
		nestedPrefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}/`));
	for (const entry of diskEntries) {
		if (insideNested(entry) && !trackedPaths.has(entry)) continue;
		paths.add(entry);
	}
	// ③ 符号链接：rg 不列（设计如此），`--follow` 会展开目标、遇到断链直接报错。
	//    `fd -t l` 只拿链接条目本身；是否为文件由 `index.ts` 的 statMtime 判定
	//    （指向目录的链接会被它丢掉）。
	//
	//    **fd 定位不到时必须整档降级**，不能“少一块但继续”：未跟踪的符号链接只有 fd 能补
	//    （实测：`git ls-files` 会列出 `untracked_link.ts`，rg 不列），静默少掉等于改了语义。
	//    引导代价（降级后跑 `git ls-files`，约 +50ms）比一份看起来正常、实际上漏了结果的
	//    列表小得多。
	const fdCommand = locateFd();
	if (fdCommand === undefined) return undefined;
	assertNotAborted(options.signal);
	const fromFd = await runTool(
		fdCommand,
		// 两个开关与 rg 那边同一个理由：`--no-require-git` 让非仓库目录也认 `.gitignore`，
		// `--no-ignore-parent` 阻止它读到搜索根之上的 `.gitignore`（实测漏了后者会让 715 个
		// 符号链接全部消失：祖先 `~/.pi/agent/npm/.gitignore` 的内容就是 `*`）。
		["-H", "-t", "l", "--no-require-git", "--no-ignore-parent", "--strip-cwd-prefix"],
		root,
		options.signal,
	);
	// fd 装了但跑挂了：同样不能当“没有链接”收场，否则会静默少掉未跟踪的符号链接。
	if (fromFd === undefined) return undefined;
	for (const entry of fromFd.split("\n")) {
		if (entry === "") continue;
		// `.git/` 里的链接没有查询价值，且会把内部结构漏给模型。
		if (entry === ".git" || entry.startsWith(".git/")) continue;
		if (applyHiddenFilter && hasDotSegment(entry)) continue;
		if (insideNested(entry) && !trackedPaths.has(entry)) continue;
		paths.add(entry);
	}

	return [...paths];
}

/** `PI_GLOB_ENGINE=git` 时的旧档：git 工作树 → 裸仓库 → 走查。 */
async function collectWithGit(root: string, options: CollectOptions): Promise<string[]> {
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

/**
 * 枚举 `root` 下所有候选的相对路径（posix 分隔符）。
 *
 * 顺序：**rg 高速档** → git 三档（工作树 → 裸仓库 → 走查）。
 * `PI_GLOB_ENGINE=git` 跳过高速档；高速档跑不了（rg 定位不到 / 超时 / 出错）自动降档。
 * 旧三档都不行时以走查的异常结束。
 */
export async function collectCandidates(root: string, options: CollectOptions = {}): Promise<string[]> {
	assertNotAborted(options.signal);
	if (process.env.PI_GLOB_ENGINE?.trim() !== "git") {
		const fast = await collectWithRg(root, options);
		if (fast !== undefined) return fast;
	}
	return await collectWithGit(root, options);
}
