/**
 * explored-group / classify + phrases —— 纯函数测试（零 pi 依赖，`node --test` 直跑）。
 *
 * 语料来自本机 19847 条真实 bash 调用里挑出来的形态，每一条都标注了「为什么它该是这个答案」。
 * 判定错的方向只有两种，都不可接受：把要跑的东西折了（屏幕上「我跑了测试」消失）、
 * 或把该折的漏了（白留一堆行）。所以下面的用例两边都钉。
 *
 * Run with:  node --test clients/pi/extensions/explored-group/classify.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyBash, classifyToolCall, segmentVerb, splitShellSegments, stripHeredocBodies, stripRedirects } from "./classify.ts";
import { PATH_TAIL_DIRS, phraseForToolCall, phrasesForBash, readSpanSuffix, shortenPath } from "./phrases.ts";

const CWD = "/Users/bachi/jaylli/litellm-any";

test("classify：只读 bash 可折叠，且类别正确", () => {
	const cases: Array<[string, string | null]> = [
		// [命令, 期望 kind]
		["cd /Users/bachi/jaylli/litellm-any && grep -rn 'bashOutput' clients/pi --include=*.ts | head -30", "search"],
		["ls -la ~/.pi/agent/extensions/ 2>/dev/null | head -30", "list"],
		["cd X && sed -n '180,260p' bash-command-collapse.ts", "read"],
		["cat ~/.pi/agent/npm/node_modules/x/dist/index.d.ts", "read"],
		["git status --short && git log --oneline -8", "git"],
		["which jq node python3", "list"],
		["cd X && find . -name '*.jsonl' | head -20", "list"],
		["head -60 _vimrc", "read"],
		["tail -60 ~/.vimrc", "read"],
		["stat -f '%i %N' a.ts b.ts", "list"],
		["wc -l a b c", "read"],
		["diff -q a.ts b.ts", "read"],
	];
	for (const [command, expected] of cases) {
		assert.equal(classifyBash(command).kind, expected, command);
	}
});

test("classify：跑东西的命令**不**折叠（哪怕命令里带 grep）", () => {
	// 目标 session 里这形态很多：`node --test … | grep -E '^ℹ'`。折了就等于把「我跑了测试」
	// 从屏幕上抹掉 —— 那是错的。
	const mustNotFold = [
		"node --test index.test.ts 2>&1 | grep -E '^ℹ (tests|pass|fail)' | head -70",
		"cd X && node --test render.test.ts 2>&1 | grep -E '^(✔|✖)' | tail -20",
		"python3 -m unittest gateway/tests/test_x.py 2>&1 | tail -5",
		"npm run usage | head -50",
		"npx --yes ali-skills runtime start --skill-file x.md --json 2>&1 | tail -40",
		"pnpm install",
		"cd X && pm2 restart litellm-adapter",
		"curl -s https://example.com | jq .",
	];
	for (const command of mustNotFold) {
		assert.equal(classifyBash(command).kind, null, command);
	}
});

test("classify：写操作不折叠，且写法覆盖 > / >> / sed -i / rm", () => {
	const mustNotFold = [
		"cat > /tmp/x.mjs <<'EOF'\nimport fs\nEOF",
		"grep -n x a.ts > /tmp/out.txt",
		"grep -n x a.ts >> /tmp/out.txt",
		"sed -i '' 's/a/b/' ~/.zshrc",
		"perl -i -pe 's/a/b/' a.ts",
		"rm -f /tmp/a.mjs",
		"cp a b && ls",
		"mv a b",
		"mkdir -p /tmp/x && ls /tmp/x",
		"tee /tmp/out <<< 'x'",
		"cd X && git add -A && git commit -m x",
		"cd X && git push",
		"cd X && python3 - <<'PY'\np='README.md'\ns=open(p).read()\nopen(p,'w').write(s)\nPY",
	];
	for (const command of mustNotFold) {
		assert.equal(classifyBash(command).kind, null, command);
	}
});

test("classify：`2>/dev/null` 是重定向不是写，`>/dev/null` 也不该拦折叠", () => {
	// 这是真实高频形态：`ls dir 2>/dev/null | head`。把 stderr 丢弃不是「写文件」。
	assert.equal(classifyBash("ls -la dir 2>/dev/null | head -30").kind, "list");
	assert.equal(classifyBash("grep -rn x . 2>/dev/null | head").kind, "search");
	assert.equal(classifyBash("cat missing.txt 2>/dev/null").kind, "read");
});

test("classify：空命令 / 纯导航 / 纯 echo 不折叠（没有实质内容可折叠）", () => {
	for (const command of ["", "   ", "cd /tmp", "echo hi", "pwd", "true"]) {
		assert.equal(classifyBash(command).kind, null, JSON.stringify(command));
	}
});

test("classifyToolCall：原生工具名直接映射", () => {
	assert.equal(classifyToolCall("read", { path: "/a/b.ts" }).kind, "read");
	assert.equal(classifyToolCall("grep", { pattern: "x" }).kind, "search");
	assert.equal(classifyToolCall("find", { pattern: "*.ts" }).kind, "list");
	assert.equal(classifyToolCall("ls", { path: "/tmp" }).kind, "list");
	// 其他工具一律不折叠
	for (const name of ["write", "edit", "subagent", "task_set", "codemode", "background_output", "web_search"]) {
		assert.equal(classifyToolCall(name, {}).kind, null, name);
	}
});

// 用户 2026-10-06 报：读 SKILL.md 也被折成 `└ Read …/skills/commit/SKILL.md`，而 pi 本来给
// `• [skill] commit (ctrl+o to expand)`。只豁免 SKILL.md（用户定的范围），docs / resource 不豁免。
test("classify：读 SKILL.md 不折叠（让 pi 的 `[skill]` 紧凑形态自己渲染）", () => {
	const skillPaths = [
		"/Users/bachi/.pi/agent/git/github.com/jayli/superpowers/skills/commit/SKILL.md",
		"clients/pi/skills/x/SKILL.md", // cwd 相对
		"SKILL.md", // 裸文件名
		"/a/b/SKILL.md",
	];
	for (const path of skillPaths) {
		const verdict = classifyToolCall("read", { path });
		assert.equal(verdict.kind, null, path);
		// 必须是「确定的不可折叠」，不是 pending —— 它要照常触发断组，不能像 pending 那样被跳过
		assert.notEqual(verdict.pending, true, `${path} 不能判成 pending`);
	}

	// 只有 read 的 SKILL.md 才有这条豁免；别的工具不受影响
	assert.equal(classifyToolCall("grep", { pattern: "SKILL.md" }).kind, "search");
	assert.equal(classifyToolCall("bash", { command: "grep -rn SKILL.md ." }).kind, "search");

	// `docs` / `resource` 两种紧凑形态**不**豁免（用户只点名了 skill）：仍然照常折叠
	assert.equal(classifyToolCall("read", { path: "/pkg/docs/foo.md" }).kind, "read");
	assert.equal(classifyToolCall("read", { path: "/repo/AGENTS.md" }).kind, "read");
	assert.equal(classifyToolCall("read", { path: "/repo/CLAUDE.md" }).kind, "read");
	// 名字里含 SKILL.md 但不是这个名字的文件不该误豁免
	assert.equal(classifyToolCall("read", { path: "/a/b/SKILL.md.bak" }).kind, "read");
	assert.equal(classifyToolCall("read", { path: "/a/b/MYSKILL.md" }).kind, "read");
	// 末尾斜杠 / 空值不影响判定
	assert.equal(classifyToolCall("read", { path: "/a/b/SKILL.md/" }).kind, null);
	assert.equal(classifyToolCall("read", { path: "/a/b/" }).kind, "read");
});

test("stripHeredocBodies：剥正文、留命令头（写重定向因此仍可见）", () => {
	const command = "cat > /tmp/x.mjs <<'EOF'\nimport fs\nconst a = 1\nEOF\nnode /tmp/x.mjs";
	const stripped = stripHeredocBodies(command);
	assert.ok(stripped.includes("cat > /tmp/x.mjs <<'EOF'"), "命令头必须保留");
	assert.ok(!stripped.includes("import fs"), "正文必须剥掉（否则 import 会被当命令）");
	assert.ok(stripped.includes("node /tmp/x.mjs"), "heredoc 之后的命令要保留");
});

test("splitShellSegments：引号内的分隔符不切；heredoc 正文不切", () => {
	assert.deepEqual(splitShellSegments("grep -n 'a;b' f"), ["grep -n 'a;b' f"]);
	assert.deepEqual(splitShellSegments("a && b; c | d"), ["a", "b", "c", "d"]);
	// `2>&1` 里的 `&` 不能被当成段分隔符
	assert.deepEqual(splitShellSegments("node --test x.js 2>&1 | grep y"), ["node --test x.js", "grep y"]);
});

test("segmentVerb：跳过 VAR= 前缀与 sudo/env 包装", () => {
	assert.equal(segmentVerb("P=/usr/bin grep x").verb, "grep");
	assert.equal(segmentVerb("sudo cat /etc/hosts").verb, "cat");
	assert.equal(segmentVerb("env FOO=1 ls -la").verb, "ls");
	assert.equal(segmentVerb("cd /tmp").verb, "cd");
});

test("stripRedirects：取词时重定向目标必须消失", () => {
	// 实测踩过：不剥就成 `List 2>/dev/null`
	assert.equal(stripRedirects("ls -la dir 2>/dev/null").trim(), "ls -la dir");
	assert.equal(stripRedirects("grep -n x a.ts > /tmp/out.txt").trim(), "grep -n x a.ts");
	assert.equal(stripRedirects("cat f 2>&1").trim(), "cat f");
});

test("shortenPath：最多两层目录 + 最后一段，更长才加 `…/`", () => {
	const cases: Array<[string, string]> = [
		["/Users/bachi/jaylli/ttt/a/b/CLAUDE.md", "…/a/b/CLAUDE.md"],
		["/Users/bachi/jaylli/litellm-any/clients/pi/extensions/explored-group/phrases.ts", "…/extensions/explored-group/phrases.ts"],
		["clients/pi/extensions/read.ts", "…/pi/extensions/read.ts"],
		["clients/pi/read.ts", "clients/pi/read.ts"],
		["src/index.ts", "src/index.ts"],
		["package.json", "package.json"],
		["/tmp/x.mjs", "/tmp/x.mjs"],
	];
	for (const [input, expected] of cases) {
		assert.equal(shortenPath(input, CWD), expected, input);
	}
	// 常量就是「两层」这件事本身；改了要一起改期望
	assert.equal(PATH_TAIL_DIRS, 2);
});

test("shortenPath：cwd 相对优先于 home 相对", () => {
	// `/Users/bachi/jaylli/litellm-any/x.ts` 同时满足「在 home 下」与「在 cwd 下」，
	// 要的是后者（更短、也更有意义）
	assert.equal(shortenPath("/Users/bachi/jaylli/litellm-any/x.ts", CWD), "x.ts");
	assert.equal(shortenPath("/Users/bachi/other/deep/a/b/c.ts", CWD), "…/a/b/c.ts");
});

test("phrases：bash 短语表（真实命令）", () => {
	const cases: Array<[string, string[]]> = [
		[
			"cd /Users/bachi/jaylli/litellm-any && grep -rn 'bashOutput' clients/pi --include=*.ts | head -30",
			['Search "bashOutput" in clients/pi'],
		],
		["ls -la ~/.pi/agent/extensions/ 2>/dev/null | head -30", ["List …/.pi/agent/extensions"]],
		["cd X && sed -n '180,260p' bash-command-collapse.ts", ["Read bash-command-collapse.ts 180-260"]],
		["cd X && git status --short && git log --oneline -8", ["Git status", "Git log"]],
		["which jq node python3", ["Which jq node python3"]],
		["cd X && find . -name '*.jsonl' | head -20", ["Find *.jsonl in ."]],
		["tail -60 ~/.vimrc", ["Tail ~/.vimrc"]],
		["cd X && grep -rn x . | grep -v node_modules | head", ['Search "x" in .']],
	];
	for (const [command, expected] of cases) {
		assert.deepEqual(phrasesForBash(command, CWD), expected, command);
	}
});

test("phrases：`-v`（反转过滤）不冒充检索路径", () => {
	// `grep -rn x . | grep -v node_modules` 的第二段位置参数是 node_modules，不是路径
	const lines = phrasesForBash("grep -rn x . | grep -v node_modules", CWD);
	assert.deepEqual(lines, ['Search "x" in .']);
});

test("phrases：原生工具短语（用户样例里的两种）", () => {
	assert.equal(phraseForToolCall("grep", { pattern: "bashOutput", path: "clients/pi" }, CWD), 'Search "bashOutput" in clients/pi');
	assert.equal(phraseForToolCall("find", { pattern: "**/*.ts", path: "clients/pi/extensions" }, CWD), "Find **/*.ts in clients/pi/extensions");
	assert.equal(phraseForToolCall("ls", { path: "clients/pi/extensions" }, CWD), "List clients/pi/extensions");
	assert.equal(phraseForToolCall("read", { path: "/Users/bachi/jaylli/ttt/CLAUDE.md" }, CWD), "Read …/jaylli/ttt/CLAUDE.md");
	assert.equal(phraseForToolCall("read", { path: "/a/b/c/d/e.ts", offset: 1, limit: 60 }, CWD), "Read …/c/d/e.ts 1-60");
});

test("phrases：read 行号后缀三种给法都看得见（对齐 pi 原生 formatReadLineRange）", () => {
	// 旧实现的条件是 `offset && limit` —— 只给一个参数时区间静默消失（用户 2026-10-06 报）。
	// 口径翄 pi：`startLine = offset ?? 1`；`limit` 没给时只知道起点，不猜长度。
	const p = "/a/b/c/d/e.ts";
	assert.equal(phraseForToolCall("read", { path: p, offset: 100, limit: 70 }, CWD), "Read …/c/d/e.ts 100-169");
	assert.equal(phraseForToolCall("read", { path: p, offset: 100 }, CWD), "Read …/c/d/e.ts 100");
	assert.equal(phraseForToolCall("read", { path: p, limit: 45 }, CWD), "Read …/c/d/e.ts 1-45");
	assert.equal(phraseForToolCall("read", { path: p }, CWD), "Read …/c/d/e.ts");
	assert.equal(readSpanSuffix({ offset: 1, limit: 1 }), " 1-1");
});

test("phrases：兜底 —— 没点没斜杠的裸文件名也要出短语", () => {
	// `cat f` / `grep -n x f` 的 `f` 既不含 `/` 也不含 `.`，但仍是路径；
	// 不给兜底这些命令一行短语都生不出来（`grep` 那条只剩 `Search "x"`，丢了作用域）
	assert.deepEqual(phrasesForBash("cat f", CWD), ["Read f"]);
	assert.deepEqual(phrasesForBash("grep -n x f", CWD), ['Search "x" in f']);
	// 真没有位置参数时才回退到不带作用域的形式
	assert.deepEqual(phrasesForBash("grep -n x", CWD), ['Search "x"']);
});
