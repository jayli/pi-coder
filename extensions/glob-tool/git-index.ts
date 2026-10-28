/**
 * glob-tool / git-index —— **直接解析 `.git/index`**，不启动 git 进程。
 *
 * ## 为什么自己解析
 *
 * `git ls-files` 的耗时几乎全是进程启动：本机实测 `git --version`（不做任何工作）
 * **47.5 ms**，`git ls-files -c -o --exclude-standard` 55 ms —— 394 文件与 17 万文件
 * 两个数量级之间只差几毫秒。而 `readFileSync` + 解析同一个索引是 **0.12 ms**。
 *
 * 索引语义是这个工具存在的理由（符号链接条目、`git add -f` 强加的已跟踪但被 ignore 的
 * 文件、已 `rm` 未 `git add` 的名字、嵌套仓库的目录条目）—— 这些恰恰是 ripgrep 枚举
 * 磁盘做不到的。所以机器必须来自索引，只是不必来自 git 二进制。
 *
 * ## 只做「读」，任何不确定都返回 `undefined`
 *
 * 调用方拿到 `undefined` 就降级跑真 `git ls-files`。目前覆盖：版本不认识、文件截断、
 * 出现 `link` 扩展（split index —— 此时这份索引**不完整**）、路径长度溢出。
 * 宁可多跑一次 git，也不能少列或错列文件。
 *
 * 引用：`Documentation/gitformat-index.adoc`。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** 索引头 `DIRC` 之后的版本号。v2 是绝大多数仓库的形态，v3 加扩展标志，v4 用前缀压缩。 */
const MIN_VERSION = 2;
const MAX_VERSION = 4;

/** v2/v3 定长头：ctime(8) mtime(8) dev(4) ino(4) mode(4) uid(4) gid(4) size(4) sha(20) flags(2)。 */
const ENTRY_HEADER_BYTES = 62;

/** `flags` 低 12 位是路径长度；等于 0xFFF 表示"长度溢出，路径以 NUL 结尾"。 */
const PATH_LENGTH_MASK = 0x0fff;

/** v3 起 `flags` 的 bit 14 表示多出 2 字节扩展标志。 */
const EXTENDED_FLAG = 0x4000;

/** 目录 / gitlink（子模块）的 mode 高 4 位。 */
const MODE_DIRECTORY = 0o040000;
const MODE_TYPE_MASK = 0o170000;

/**
 * 解析一份索引 buffer，返回**索引里的路径**（`ls-files --cached` 的顺序即字节序）。
 *
 * - 目录与 gitlink 以尾斜杠返回（与 `git ls-files` 的呈现一致，由调用方丢弃）；
 * - 任一不认识的形态都返回 `undefined`，绝不给"看起来对"的部分结果。
 */
export function parseIndexPaths(buffer: Buffer): string[] | undefined {
	if (buffer.length < 12) return undefined;
	if (buffer.toString("ascii", 0, 4) !== "DIRC") return undefined;
	const version = buffer.readUInt32BE(4);
	if (version < MIN_VERSION || version > MAX_VERSION) return undefined;
	const count = buffer.readUInt32BE(8);

	const paths: string[] = [];
	let offset = 12;
	let previous = "";

	for (let index = 0; index < count; index++) {
		const start = offset;
		if (start + ENTRY_HEADER_BYTES > buffer.length) return undefined;
		const mode = buffer.readUInt32BE(start + 24);
		const flags = buffer.readUInt16BE(start + 60);
		const headerBytes = version >= 3 && (flags & EXTENDED_FLAG) !== 0 ? ENTRY_HEADER_BYTES + 2 : ENTRY_HEADER_BYTES;
		if (start + headerBytes > buffer.length) return undefined;

		let name: string;
		if (version === 4) {
			// v4：先一个 varint 表示"要剥掉上一路径的多少字节"，再是 NUL 结尾的后缀。
			let cursor = start + headerBytes;
			let strip = 0;
			for (;;) {
				if (cursor >= buffer.length) return undefined;
				const byte = buffer[cursor++]!;
				strip = (strip << 7) | (byte & 0x7f);
				if ((byte & 0x80) === 0) break;
			}
			if (strip > previous.length) return undefined;
			const end = buffer.indexOf(0, cursor);
			if (end < 0) return undefined;
			name = previous.slice(0, previous.length - strip) + buffer.toString("utf8", cursor, end);
			offset = end + 1;
		} else {
			const pathLength = flags & PATH_LENGTH_MASK;
			let end: number;
			if (pathLength < PATH_LENGTH_MASK) {
				end = start + headerBytes + pathLength;
				if (end > buffer.length) return undefined;
				name = buffer.toString("utf8", start + headerBytes, end);
				// 定长路径之后紧跟 NUL，整条记录补零到 8 字节边界（**相对记录起点**）。
				offset = start + Math.ceil((end + 1 - start) / 8) * 8;
			} else {
				end = buffer.indexOf(0, start + headerBytes);
				if (end < 0) return undefined;
				name = buffer.toString("utf8", start + headerBytes, end);
				offset = start + Math.ceil((end + 1 - start) / 8) * 8;
			}
		}

		previous = name;
		if ((mode & MODE_TYPE_MASK) === MODE_DIRECTORY) paths.push(`${name}/`);
		else paths.push(name);
	}

	// 扩展区是 (4 字节签名 + 4 字节长度 + 负载) 的链。必须按链走而不是裸扫 "link" 字样 ——
	// TREE 扩展的哈希里出现字面量 "link" 的概率不为零（初版裸扫时当场踩到，整份索引被判废）。
	let extension = offset;
	while (extension + 8 <= buffer.length) {
		const signature = buffer.toString("ascii", extension, extension + 4);
		if (!/^[A-Za-z0-9]{4}$/.test(signature)) break;
		const size = buffer.readUInt32BE(extension + 4);
		// split index：真实条目分散在共享索引里，这份文件只 hold 一部分。
		if (signature === "link") return undefined;
		extension += 8 + size;
	}

	return paths;
}

/** 读并解析磁盘上的索引文件；读不到 / 解析不了返回 `undefined`。 */
export function readIndexPaths(indexPath: string): string[] | undefined {
	let buffer: Buffer;
	try {
		buffer = readFileSync(indexPath);
	} catch {
		return undefined;
	}
	return parseIndexPaths(buffer);
}

export interface RepoLocation {
	/** 工作树根（`.git` 所在目录）。 */
	root: string;
	/** git 目录：普通仓库是 `<root>/.git`，worktree / submodule 是 `gitdir:` 指向的地方。 */
	gitDir: string;
}

/**
 * 从 `start` 向上找第一个带 `.git` 的目录 —— **不启动 git 进程**（`git rev-parse` 在本机
 * 要 47 ms，而这段是纯 fs 调用）。
 *
 * 两种 `.git` 都要认：
 * - 普通仓库 / submodule：`.git` 是**目录**；
 * - linked worktree（`git worktree add`）：`.git` 是**文件**，内容是 `gitdir: <路径>`，
 *   索引在指向的那个目录里。不认它会让 worktree 里的 glob 直接掉进降级档。
 */
export function findRepoRoot(start: string): RepoLocation | undefined {
	let directory = start;
	for (;;) {
		const dotGit = join(directory, ".git");
		if (existsSync(dotGit)) {
			let gitDir = dotGit;
			try {
				if (statSync(dotGit).isFile()) {
					const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
					if (match === null) return undefined;
					const target = match[1]!.trim();
					gitDir = isAbsolute(target) ? target : join(directory, target);
				}
			} catch {
				return undefined;
			}
			return { root: directory, gitDir };
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}
