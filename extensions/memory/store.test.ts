/**
 * memory/store 的纯函数测试。
 *   node --test clients/pi/extensions/memory/store.test.ts
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	INDEX_MAX_LINES,
	buildIndex,
	findProjectRoot,
	isValidMemoryName,
	loadMemories,
	parseFrontmatter,
	resolveMemoryDir,
	resolveMemoryLayout,
	searchMemories,
	serializeMemoryFile,
	slugifyPath,
	truncateDescription,
	type MemoryEntry,
} from "./store.ts";

/** 临时根的真实路径：macOS 的 `os.tmpdir()` 是 `/var/folders/…`，realpath 后是 `/private/…`。
 *  `findProjectRoot` 归一化符号链接（与 CC 一致），所以期望值也必须用真实路径。 */
const TMP = fs.realpathSync(os.tmpdir());

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		name: "sample",
		description: "a sample memory",
		type: "project",
		modified: "2026-09-26T00:00:00.000Z",
		body: "the body",
		filename: "sample.md",
		...overrides,
	};
}

test("slugifyPath 把 / 与 . 换成 -", () => {
	assert.equal(slugifyPath("/Users/bachi/jaylli/litellm-any"), "-Users-bachi-jaylli-litellm-any");
	assert.equal(slugifyPath("/a.b/c.d"), "-a-b-c-d");
});

test("findProjectRoot 找到 git 根；非 git 目录返回自身", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-root-"));
	const nested = path.join(tmp, "a", "b");
	fs.mkdirSync(nested, { recursive: true });
	// 无 .git：返回传入目录本身
	assert.equal(findProjectRoot(nested), nested);
	// 有 .git：返回 git 根
	fs.mkdirSync(path.join(tmp, ".git"));
	assert.equal(findProjectRoot(nested), tmp);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveMemoryDir 默认落在 CC 的 <slug>/memory/（两个 agent 共用一份）", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-cc-"));
	const proj = path.join(tmp, "proj");
	fs.mkdirSync(proj, { recursive: true });
	// 不传任何布局环境变量 = 默认 cc 布局
	const dir = resolveMemoryDir(proj, {} as NodeJS.ProcessEnv);
	assert.equal(dir, path.join(os.homedir(), ".claude", "projects", slugifyPath(proj), "memory"));
	// 显式 PI_MEMORY_LAYOUT=cc 等价
	assert.equal(resolveMemoryDir(proj, { PI_MEMORY_LAYOUT: "cc" } as NodeJS.ProcessEnv), dir);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveMemoryDir 用 PI_MEMORY_DIR 覆盖根，slug 仍生效（两种布局都带 slug）", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-base-"));
	const proj = path.join(tmp, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const slug = slugifyPath(proj);
	// cc（默认）：<根>/<slug>/memory
	assert.equal(
		resolveMemoryDir(proj, { PI_MEMORY_DIR: "/custom/root" } as NodeJS.ProcessEnv),
		path.join("/custom/root", slug, "memory"),
	);
	// pi：<根>/<slug>
	assert.equal(
		resolveMemoryDir(proj, { PI_MEMORY_DIR: "/custom/root", PI_MEMORY_LAYOUT: "pi" } as NodeJS.ProcessEnv),
		path.join("/custom/root", slug),
	);
	// `~` 展开
	assert.equal(
		resolveMemoryDir(proj, { PI_MEMORY_DIR: "~/mem" } as NodeJS.ProcessEnv),
		path.join(os.homedir(), "mem", slug, "memory"),
	);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveMemoryDir 的 pi 布局退回旧位置 <agentDir>/memory/<slug>", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-legacy-"));
	const proj = path.join(tmp, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const dir = resolveMemoryDir(proj, { PI_MEMORY_LAYOUT: "pi", PI_CODING_AGENT_DIR: "/agent" } as NodeJS.ProcessEnv);
	assert.equal(dir, path.join("/agent", "memory", slugifyPath(proj)));
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveMemoryLayout 只认 cc/pi，未知值回退 cc", () => {
	assert.equal(resolveMemoryLayout({} as NodeJS.ProcessEnv), "cc");
	assert.equal(resolveMemoryLayout({ PI_MEMORY_LAYOUT: "cc" } as NodeJS.ProcessEnv), "cc");
	assert.equal(resolveMemoryLayout({ PI_MEMORY_LAYOUT: "pi" } as NodeJS.ProcessEnv), "pi");
	assert.equal(resolveMemoryLayout({ PI_MEMORY_LAYOUT: "whatever" } as NodeJS.ProcessEnv), "cc");
});

test("isValidMemoryName 接受 kebab-case，拒绝路径成分", () => {
	assert.ok(isValidMemoryName("gitlab-push-rule"));
	assert.ok(isValidMemoryName("a1"));
	assert.ok(!isValidMemoryName("Bad_Name"));
	assert.ok(!isValidMemoryName("../etc"));
	assert.ok(!isValidMemoryName("a/b"));
	assert.ok(!isValidMemoryName(""));
});

test("frontmatter 往返：序列化后能解析回来", () => {
	const text = serializeMemoryFile({
		name: "x",
		description: "desc",
		type: "feedback",
		modified: "2026-09-26T01:02:03.000Z",
		body: "line one\nline two",
	});
	const { fields, body } = parseFrontmatter(text);
	assert.equal(fields.name, "x");
	assert.equal(fields.description, "desc");
	assert.equal(fields.type, "feedback");
	assert.equal(fields.modified, "2026-09-26T01:02:03.000Z");
	assert.equal(body, "line one\nline two");
});

test("parseFrontmatter 无 frontmatter 时原样返回 body", () => {
	const { fields, body } = parseFrontmatter("just text");
	assert.deepEqual(fields, {});
	assert.equal(body, "just text");
});

test("truncateDescription 压成一行并截断", () => {
	assert.equal(truncateDescription("  a\n\nb  "), "a b");
	const long = "x".repeat(200);
	const out = truncateDescription(long, 150);
	assert.ok(out.length <= 150);
	assert.ok(out.endsWith("…"));
});

test("buildIndex 每条一行，超限截断并报告 dropped", () => {
	const many = Array.from({ length: INDEX_MAX_LINES + 10 }, (_, i) =>
		entry({ name: `m-${String(i).padStart(3, "0")}`, filename: `m-${String(i).padStart(3, "0")}.md` }),
	);
	const result = buildIndex(many);
	assert.ok(result.droppedCount > 0);
	assert.equal(result.totalCount, many.length);
	const dataLines = result.content.split("\n").filter((l) => l.startsWith("- "));
	assert.ok(dataLines.length <= INDEX_MAX_LINES);
});

test("loadMemories 跳过索引与隐藏文件，损坏文件不炸", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-load-"));
	fs.writeFileSync(path.join(tmp, "MEMORY.md"), "# index");
	fs.writeFileSync(path.join(tmp, ".hidden.md"), "x");
	fs.writeFileSync(
		path.join(tmp, "good.md"),
		serializeMemoryFile({ name: "good", description: "d", type: "user", modified: "2026-01-01T00:00:00.000Z", body: "b" }),
	);
	fs.writeFileSync(path.join(tmp, "broken.md"), "---\nname: broken\n"); // 未闭合 frontmatter
	const entries = loadMemories(tmp);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].name, "good");
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("searchMemories 按 frontmatter 加权命中", () => {
	const entries = [
		entry({ name: "alpha", description: "gitlab push rule", body: "about email" }),
		entry({ name: "beta", description: "unrelated", body: "mentions gitlab deep in body" }),
	];
	const hits = searchMemories(entries, "gitlab");
	assert.equal(hits.length, 2);
	assert.equal(hits[0].name, "alpha"); // description 命中权重更高
	assert.deepEqual(searchMemories(entries, ""), []);
});

// =============================================================================
// worktree / 符号链接：与 Claude Code 的 slug 口径对齐（2026-10-27 实测 CC 2.1.308）
// =============================================================================

/** 在 `dir` 里初始化一个只有初始提交的仓库。 */
function initRepo(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", "."], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
	execFileSync("git", ["add", "a.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

test("findProjectRoot 归一化符号链接（CC 用 realpath 算 slug）", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-link-"));
	const real = path.join(tmp, "real");
	initRepo(real);
	const link = path.join(tmp, "link");
	fs.symlinkSync(real, link);
	// 从软链进入：返回真实路径，不是软链路径
	assert.equal(findProjectRoot(link), real);
	assert.equal(findProjectRoot(path.join(link, "sub")), real);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("findProjectRoot 把 worktree 回推到主仓库根（sibling 与 nested 都算）", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-wt-"));
	const repo = path.join(tmp, "repo");
	initRepo(repo);
	// sibling worktree（仓库外）
	const sibling = path.join(tmp, "sibling");
	execFileSync("git", ["worktree", "add", "-q", sibling, "-b", "sib"], { cwd: repo });
	// nested worktree（仓库内）
	const nested = path.join(repo, "nested");
	execFileSync("git", ["worktree", "add", "-q", nested, "-b", "nest"], { cwd: repo });
	// 三处共用同一个记忆目录（CC 实测行为）
	assert.equal(findProjectRoot(sibling), repo);
	assert.equal(findProjectRoot(nested), repo);
	// worktree 里的子目录同样回推
	assert.equal(findProjectRoot(path.join(sibling, "a", "b")), repo);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("findProjectRoot 对 --separate-git-dir 保持工作目录本身（gitdir 在别处也不算主仓库）", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-sep-"));
	const gitdir = path.join(tmp, "gitdirs", "sep.git");
	fs.mkdirSync(path.dirname(gitdir), { recursive: true });
	const work = path.join(tmp, "work");
	fs.mkdirSync(work);
	execFileSync("git", ["init", "-q", `--separate-git-dir=${gitdir}`, "."], { cwd: work });
	// 没有 commondir ⇒ 不能把 gitdir 当成仓库根
	assert.equal(fs.statSync(path.join(work, ".git")).isFile(), true);
	assert.equal(findProjectRoot(work), work);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveMemoryDir 用真实路径算 slug（软链进入与直接进入同一目录）", () => {
	const tmp = fs.mkdtempSync(path.join(TMP, "mem-slug-"));
	const real = path.join(tmp, "real");
	initRepo(real);
	const link = path.join(tmp, "link");
	fs.symlinkSync(real, link);
	const env = { PI_MEMORY_DIR: path.join(tmp, "root") } as NodeJS.ProcessEnv;
	// 软链路径与真实路径落到同一个记忆目录
	assert.equal(resolveMemoryDir(link, env), resolveMemoryDir(real, env));
	assert.equal(resolveMemoryDir(link, env), path.join(tmp, "root", slugifyPath(real), "memory"));
	fs.rmSync(tmp, { recursive: true, force: true });
});
