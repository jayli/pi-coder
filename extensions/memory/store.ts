/**
 * memory/store — 记忆存储层的纯函数部分（无 pi 依赖，node --test 直接测）。
 *
 * 布局（设计见 docs/superpowers/specs/2026-09-26-pi-memory-design.md）：
 *
 *   <baseDir>/memory/<project-slug>/
 *   ├── MEMORY.md            索引，扩展机械生成，模型不手写
 *   ├── <name>.md            一条记忆一个文件，CC 兼容 frontmatter
 *   └── .disabled            存在即关闭本项目记忆（/memory 切换）
 *
 * slug 规则照 CC / pi-claude-memory：项目根绝对路径的 `/` 与 `.` 换成 `-`，
 * 同一 git 仓库的所有 worktree 共享一个记忆目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const INDEX_FILENAME = "MEMORY.md";
export const DISABLED_MARKER = ".disabled";
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
export const DESCRIPTION_MAX_CHARS = 150;

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryEntry {
	name: string;
	description: string;
	type: MemoryType;
	modified: string;
	body: string;
	filename: string;
}

/** 项目根绝对路径 → slug（`/` 与 `.` 换 `-`）。 */
export function slugifyPath(absPath: string): string {
	return absPath.replace(/[/.]/g, "-");
}

/** 向上找 git 根（`.git` 目录或 worktree 的 `.git` 文件）；找不到返回 cwd 本身。 */
export function findProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	for (;;) {
		try {
			fs.statSync(path.join(dir, ".git"));
			return dir;
		} catch {
			// 继续向上
		}
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(cwd);
		dir = parent;
	}
}

/** pi 的 agent 目录（`PI_CODING_AGENT_DIR` 可覆盖，否则 `~/.pi/agent`）。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
	return path.join(os.homedir(), ".pi", "agent");
}

/**
 * 本项目的记忆目录。
 * `PI_MEMORY_DIR` 覆盖**根**（取代 `<agentDir>/memory`，测试隔离用），slug 仍然生效，
 * 所以即使指定了根，不同项目也各自一个子目录。
 */
export function resolveMemoryDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_MEMORY_DIR;
	const root = override
		? override.startsWith("~")
			? path.join(os.homedir(), override.slice(1))
			: override
		: path.join(resolveAgentDir(env), "memory");
	return path.join(root, slugifyPath(findProjectRoot(cwd)));
}

/** 记忆文件名合法性：kebab-case，禁路径成分。 */
export function isValidMemoryName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.includes("..");
}

/**
 * 极简 YAML frontmatter 解析：只认一层 `key: value` 与 `metadata:` 下的两格缩进键。
 *
 * 没有 frontmatter 的文件是合法记忆（CC 也不给无 frontmatter 的文件补），
 * 但「以 `---` 开头却没有闭合分隔符」是损坏文件，返回 `malformed: true` 让调用方跳过。
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string; malformed: boolean } {
	const fields: Record<string, string> = {};
	if (!text.startsWith("---")) return { fields, body: text, malformed: false };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { fields, body: text, malformed: true };
	const block = text.slice(3, end).replace(/^\r?\n/, "");
	let inMetadata = false;
	for (const line of block.split(/\r?\n/)) {
		if (/^metadata:\s*$/.test(line)) {
			inMetadata = true;
			continue;
		}
		const m = inMetadata ? line.match(/^\s{2,}([A-Za-z_][\w-]*):\s*(.*)$/) : line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (m) fields[m[1]] = m[2].trim();
		if (inMetadata && /^\S/.test(line) && !/^metadata:/.test(line)) inMetadata = false;
	}
	// 闭合分隔符后通常跟一个空行再是正文：剥掉前导空行与尾部空白，保证与序列化往返一致。
	const body = text.slice(end + 4).replace(/^(?:\r?\n)+/, "").trimEnd();
	return { fields, body, malformed: false };
}

/** 序列化一个记忆文件（frontmatter + 正文）。 */
export function serializeMemoryFile(entry: Pick<MemoryEntry, "name" | "description" | "type" | "modified" | "body">): string {
	return [
		"---",
		`name: ${entry.name}`,
		`description: ${entry.description}`,
		"metadata:",
		`  type: ${entry.type}`,
		`  modified: ${entry.modified}`,
		"---",
		"",
		entry.body.trim(),
		"",
	].join("\n");
}

/** description 截断到一行（~150 字符，CC 同款）。 */
export function truncateDescription(desc: string, max = DESCRIPTION_MAX_CHARS): string {
	const oneLine = desc.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/** 读目录里全部记忆（跳过索引与隐藏文件），按 name 排序。损坏文件跳过。 */
export function loadMemories(dir: string): MemoryEntry[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== INDEX_FILENAME && !f.startsWith("."));
	} catch {
		return [];
	}
	const entries: MemoryEntry[] = [];
	for (const filename of files) {
		try {
			const text = fs.readFileSync(path.join(dir, filename), "utf-8");
			const { fields, body, malformed } = parseFrontmatter(text);
			if (malformed) continue; // 未闭合 frontmatter = 损坏文件，跳过
			const type = MEMORY_TYPES.includes(fields.type as MemoryType) ? (fields.type as MemoryType) : "project";
			entries.push({
				name: fields.name || filename.replace(/\.md$/, ""),
				description: fields.description || "",
				type,
				modified: fields.modified || "",
				body,
				filename,
			});
		} catch {
			// 损坏文件跳过，不让一条坏记忆挡住整个库
		}
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return entries;
}

export interface IndexBuildResult {
	content: string;
	/** 被上限截断的条目数（>0 时注入里要附警告）。 */
	droppedCount: number;
	totalCount: number;
}

/** 从记忆条目机械生成索引（每条一行）。超 200 行 / 25KB 时截断并报告。 */
export function buildIndex(entries: MemoryEntry[]): IndexBuildResult {
	const lines: string[] = ["# Memory Index", ""];
	let bytes = 0;
	let kept = 0;
	for (const entry of entries) {
		const line = `- [${entry.name}](${entry.filename}) — ${entry.type} — ${truncateDescription(entry.description) || "(no description)"}`;
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (kept + 2 > INDEX_MAX_LINES || bytes + lineBytes > INDEX_MAX_BYTES) break;
		lines.push(line);
		bytes += lineBytes;
		kept++;
	}
	return { content: lines.join("\n") + "\n", droppedCount: entries.length - kept, totalCount: entries.length };
}

/** 关键词检索：frontmatter 命中权重 3、正文权重 1，返回 top N。 */
export function searchMemories(entries: MemoryEntry[], query: string, limit = 5): MemoryEntry[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	if (terms.length === 0) return [];
	const scored = entries
		.map((entry) => {
			const head = `${entry.name} ${entry.description}`.toLowerCase();
			const body = entry.body.toLowerCase();
			let score = 0;
			for (const term of terms) {
				if (head.includes(term)) score += 3;
				if (body.includes(term)) score += 1;
			}
			return { entry, score };
		})
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
	return scored.slice(0, limit).map((s) => s.entry);
}
