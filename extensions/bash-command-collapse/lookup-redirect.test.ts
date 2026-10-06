/**
 * `lookup-redirect` 的单元测试 —— 单一探查闸的判定。
 *
 * 这套闸门是**硬拦**（`tool_call` handler 返回 `block`），拦错一次就白白浪费模型一轮，
 * 所以两个方向都要钉死：
 *
 *   - **该拦的**：纯单一探查（含 `cd X &&` 前缀、`| head -N` 截断习语）
 *   - **绝不能拦的**：变换器（`awk`/`wc`/`sort`/`jq`）、执行（`node`/`npm`/`git`）、写操作
 *     （重定向、`sed -i`）、以及原生 schema 表达不了的形态（`grep -v`、`find -mtime`、
 *     `ls -R`、多路径 `grep`）
 *
 * 判定用真命令（取自历史会话的典型形态），不是构造出来的玩具串。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectBashLookup, renderLookupRedirect } from "./lookup-redirect.ts";

/** 该拦：返回建议的工具名。 */
function gated(command: string): string | null {
	return detectBashLookup(command)?.tool ?? null;
}

test("拦：纯粹的单次 grep", () => {
	assert.equal(gated('grep -n "foo" file.ts'), "grep");
	assert.equal(gated('grep -rn "foo" src/'), "grep");
	assert.equal(gated("grep -rn foo ."), "grep");
	assert.equal(gated('grep -i needle .'), "grep");
	assert.equal(gated('grep -n "foo" --include="*.ts" src/'), "grep");
	assert.equal(gated('rg "foo" src/'), "grep");
});

test("拦：带 `cd X &&` 导航前缀的单一探查（实测最常见的形态）", () => {
	assert.equal(gated('cd /Users/x/proj && grep -rn "foo" .'), "grep");
	assert.equal(gated('cd "/path with space/proj" && grep -n "bar" index.html'), "grep");
	assert.equal(gated("cd /x && ls -la src/"), "ls");
});

test("拦：`| head -N` 只是截断习语，不算复合（原生工具有 limit）", () => {
	assert.equal(gated("grep -rn foo . | head -30"), "grep");
	assert.equal(gated("ls -la src/ | head -5"), "ls");
	assert.equal(gated('find . -name "*.ts" | head'), "find");
	assert.equal(gated("grep -rn foo . | tail -3"), "grep");
});

test("拦：列目录与按名找文件", () => {
	assert.equal(gated("ls -la src/"), "ls");
	assert.equal(gated("ls -t sessions/"), "ls");
	assert.equal(gated('find . -name "*.jsonl"'), "find");
	assert.equal(gated("find /x -type f"), "find");
});

test("拦：取文件内容（read 一族）", () => {
	assert.equal(gated("cat package.json"), "read");
	assert.equal(gated("head -20 README.md"), "read");
	assert.equal(gated('sed -n "1,60p" CHANGELOG.md'), "read");
	assert.equal(gated("sed -n '92,121p' CLAUDE.md"), "read");
});

test("不拦：变换器 —— 原生工具给不了，拦了只能逼模型换别的 bash", () => {
	assert.equal(gated('grep -rn foo . | awk -F: "{print $1}"'), null);
	assert.equal(gated("grep -rn foo . | wc -l"), null);
	assert.equal(gated("grep -rn foo . | sort -u"), null);
	assert.equal(gated('grep -rn foo . | jq -r ".[]"'), null);
	assert.equal(gated('find . -name "*.ts" | wc -l'), null);
	assert.equal(gated("grep -rn foo . | head -30 | wc -l"), null);
});

test("不拦：执行类命令 —— 那是真在跑东西", () => {
	assert.equal(gated("node --test x.test.ts 2>&1 | grep -E \"pass\""), null);
	assert.equal(gated("cd /x && npm test"), null);
	assert.equal(gated("git status"), null);
	assert.equal(gated("python3 -c \"print(1)\""), null);
	assert.equal(gated("cd /x && node -v; go version"), null);
	assert.equal(gated("cd /x && grep -n a f && echo done && node x.js"), null);
});

test("不拦：写操作与就地改写", () => {
	assert.equal(gated("sed -i \"\" \"s/a/b/\" f.txt"), null);
	assert.equal(gated('cat > /tmp/x.txt <<EOF\nhi\nEOF'), null);
	assert.equal(gated("echo hi > f.txt"), null);
	assert.equal(gated("grep -rn foo . > out.txt"), null);
	// 非 `-n` 的 sed 是替换，不是读
	assert.equal(gated('sed "s/a/b/" f.txt'), null);
});

test("不拦：原生 schema 表达不了的旗标", () => {
	assert.equal(gated("grep -c foo a.txt"), null); // 只要计数
	assert.equal(gated("grep -v foo a.txt"), null); // 反向匹配
	assert.equal(gated("grep -A 3 foo a.txt"), null); // 上下文行
	assert.equal(gated("grep -rn foo src/ dist/"), null); // 多路径
	assert.equal(gated("find . -maxdepth 2 -name x"), null); // 深度限制
	assert.equal(gated('find . -name "*.log" -mtime +7'), null); // 时间谓词
	assert.equal(gated('find . -name "*.log" -exec rm {} \\;'), null); // 副作用
	assert.equal(gated("ls -R src/"), null); // 递归
	assert.equal(gated("cat a.txt b.txt c.txt"), null); // 多文件
});

test("不拦：无关命令与空命令", () => {
	assert.equal(gated("echo hi"), null);
	assert.equal(gated("cd /x"), null);
	assert.equal(gated("which timeout"), null);
	assert.equal(gated("someunknowncmd --flag"), null);
	assert.equal(gated(""), null);
	assert.equal(gated("   "), null);
});

test("建议的调用形态：参数能对上原生 schema", () => {
	// `cd` 落点会拼进相对路径 —— 原生工具在**当前 cwd** 下解析 `path`，不是命令里 `cd` 之后那个目录。
	// 不拼的话模型会去读另一个文件（或 `Path not found`），而实测 74% 的拦截都带 `cd` 前缀 + 相对路径。
	const g = detectBashLookup('cd /Users/x/proj && grep -rn "NEVER_DELETE" src/')!;
	assert.equal(g.tool, "grep");
	assert.deepEqual(g.hint?.args, { pattern: "NEVER_DELETE", path: "/Users/x/proj/src/" });

	// `cd` 落点在没有显式 path 时充当作用域
	const g2 = detectBashLookup('cd /tmp/scope && grep -n foo .')!;
	assert.equal(g2.hint?.args?.path, ".");
	// 不带 `.` 时它就是那个目录本身
	assert.equal(detectBashLookup('cd /tmp/scope && grep -rn foo')?.hint?.args?.path, "/tmp/scope");
	assert.equal(detectBashLookup("cd /tmp/scope && cat f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && ls sub")?.hint?.args?.path, "/tmp/scope/sub");
	// 绝对路径与 `~` 不拼（已经完整）
	assert.equal(detectBashLookup("cd /tmp/scope && cat /abs/f.ts")?.hint?.args?.path, "/abs/f.ts");

	// 带引号的空格路径不能被切碎（`segmentVerb` 按空白切词，会把 `"/a b"` 切成 `"/a`）
	assert.equal(detectBashLookup('cd "/a b/proj" && cat f.ts')?.hint?.args?.path, "/a b/proj/f.ts");
	assert.equal(detectBashLookup('cd "/a b/proj" && ls')?.hint?.args?.path, "/a b/proj");

	// `--include` → glob，`-i` → ignoreCase
	const g3 = detectBashLookup('grep -i "x" --include="*.ts" src/')!;
	assert.equal(g3.hint?.args?.ignoreCase, true);
	assert.equal(g3.hint?.args?.glob, "*.ts");

	// `sed -n '92,121p'` → offset/limit（30 行）
	const g4 = detectBashLookup("sed -n '92,121p' CLAUDE.md")!;
	assert.equal(g4.hint?.args?.offset, 92);
	assert.equal(g4.hint?.args?.limit, 30);

	// `head -20 f` → limit 20
	const g5 = detectBashLookup("head -20 README.md")!;
	assert.equal(g5.hint?.args?.limit, 20);

	// `ls -t sessions/` → path
	const g6 = detectBashLookup("cd /x && ls -t sessions/ | head -5")!;
	assert.equal(g6.tool, "ls");
	assert.equal(g6.hint?.args?.path, "/x/sessions/");
});

test("不拦：需要 shell 先展开的形态 —— 原生工具**不做展开**，照抄建议必然失败", () => {
	// 实测：`ls({path: "*.md"})` 直接 `Path not found: …/*.md`。拦下来等于把模型推进死胡同：
	// 它只能自己摸出「用 bash 让 shell 展开」这条出路，净亏一轮。
	assert.equal(gated("ls *.md"), null);
	assert.equal(gated("ls -d */"), null);
	assert.equal(gated("ls ~/Downloads/*.png"), null);
	assert.equal(gated("cat *.log"), null);
	assert.equal(gated("head -20 *.md"), null);
	assert.equal(gated("grep -n foo *.ts"), null);
	assert.equal(gated("grep -rn foo `pwd`"), null);
	assert.equal(gated("cat $(ls | head -1)"), null);
	// 方括号是正则、不是 glob —— 不能把它当展开而漏拦
	assert.equal(gated("grep -n '[a-z]\\+' f.ts"), "grep");
});

test("不拦：从 **stdin** 读的 grep —— 原生 grep 只能搜文件，给不出替代调用", () => {
	// 上游是命令（不是文件）时，`grep pat` 没有 path，原生 schema 表达不了。
	assert.equal(gated("env | grep -i '^PI_'"), null);
	assert.equal(gated("env | grep -i '^PI_' | head -20"), null);
	assert.equal(gated("ls /x | grep -i qoder"), null);
	assert.equal(gated("history | grep npm"), null);
	// `cat f | grep pat` 理论上可推路径，但 `splitShellSegments` 把 `|` 与 `;` 当同一种分隔符，
	// 分不出「grep 读管道」还是「grep 读 stdin」—— 拿不准就不拦（实测占比 0.4%）。
	assert.equal(gated("cat a.txt | grep foo"), null);
	// `grep -rn pat`（递归而无 path）走当前目录，原生能表达
	assert.equal(gated("grep -rn foo"), "grep");
	assert.equal(gated("grep -rn foo ."), "grep");
});

test("不拦：一次列多个路径 —— 原生 ls 只收一个 path，照抄会静默漏掉其余", () => {
	assert.equal(gated("ls /a /b"), null);
	assert.equal(gated("cd /x && ls src test docs"), null);
});

test("拦：`head -n N f` 也要给出 limit（与 `head -N f` 同口径）", () => {
	// 原先只认 `-20` 那种写法，`-n 20` 拦下来却只给 `read({path})`，行数信息静默丢失。
	assert.equal(detectBashLookup("head -n 20 app.ts")?.hint?.args?.limit, 20);
	assert.equal(detectBashLookup("head -20 app.ts")?.hint?.args?.limit, 20);
	assert.equal(detectBashLookup("head -n 5 x.log")?.hint?.args?.path, "x.log");
});

test("建议的调用形态：`--include` 不得被误当成 `-i`", () => {
	// 原来的 `/^-.*i/` 会命中 `--include=*.ts` 里的字母 i，给出 ignoreCase: true ——
	// 模型照抄后检索结果被静默放大。
	const g = detectBashLookup("grep -rn foo --include=*.ts .")!;
	assert.equal(g.hint?.args?.glob, "*.ts");
	assert.equal(g.hint?.args?.ignoreCase, undefined);
	// 真的 `-i` 仍要认出来（含组合短旗标 `-rni`）
	assert.equal(detectBashLookup("grep -i foo x.ts")?.hint?.args?.ignoreCase, true);
	assert.equal(detectBashLookup("grep -rni foo x.ts")?.hint?.args?.ignoreCase, true);
});

test("建议的 path 必须能解析到命令真正的目标（`cd` 落点 + 相对路径）", () => {
	// 原生工具在**当前 cwd** 下解析 `path`，不是命令里 `cd` 之后那个目录 —— 不拼的话模型
	// 会去读另一个文件或 `Path not found`，而实测 74% 的拦截都带 `cd` 前缀 + 相对路径。
	assert.equal(detectBashLookup("cd /tmp/scope && cat f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && grep -n foo f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && head -20 f.ts")?.hint?.args?.path, "/tmp/scope/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && ls sub")?.hint?.args?.path, "/tmp/scope/sub");
	// 绝对 / `~` / `.` 不拼（已完整或语义就是当前目录）
	assert.equal(detectBashLookup("cd /tmp/scope && cat /abs/f.ts")?.hint?.args?.path, "/abs/f.ts");
	assert.equal(detectBashLookup("cd /tmp/scope && grep -n foo .")?.hint?.args?.path, ".");
});

test("建议的 path 不能带引号 / 通配符 / 未展开变量 —— 原生工具既不展开也不去引号", () => {
	// 实测：`ls({path: "*.md"})` 直接 `Path not found`；`read({path: "$D/x.md"})` 会去找名为 `$D` 的目录。
	// 这三类都是「照抄建议必失败」，拦下来反而比不拦更贵。
	assert.equal(gated("ls *.md"), null);
	assert.equal(gated("cd /tmp && cat $D/f.ts"), null);
	assert.equal(gated("cd /tmp && cat ${D}/f.ts"), null);
	// `cd` 落点本身不可解时照旧拦（命令确实是一次单探查），但**不得给出相对 path** ——
	// 那个相对名在当前 cwd 下指向另一个文件，静默指错比报错更坏。
	const unresolved = detectBashLookup("cd $DIR && cat f.ts")!;
	assert.equal(unresolved.tool, "read");
	assert.equal(unresolved.hint?.args?.path, undefined, "未解出的 cd 落点不能当成 path");
	assert.equal(detectBashLookup("cd /x/*/pkg && cat f.ts")?.hint?.args?.path, undefined);
});

test("拦截语必须交代 .gitignore 例外（否则「换原生」会变成静默漏搜）", () => {
	const g = detectBashLookup('grep -rn "x" .')!;
	const text = renderLookupRedirect(g);
	assert.ok(text.includes(".gitignore"), "grep 的拦截语必须提 .gitignore");
	assert.ok(text.includes("显式"), "必须给出穿透手法");
	// 必须包含可直接照抄的原生调用
	assert.ok(text.includes('grep({ pattern: "x", path: "." })'), `拦截语应给出照抄行，实际：${text}`);

	// read 一族没有 .gitignore 问题，不该提
	const r = detectBashLookup("cat package.json")!;
	assert.ok(!renderLookupRedirect(r).includes(".gitignore"));

	// 关闭方式要写在拦截语里（用户能自救）
	assert.ok(renderLookupRedirect(g).includes("PI_BASH_LOOKUP_GATE=off"));
});
