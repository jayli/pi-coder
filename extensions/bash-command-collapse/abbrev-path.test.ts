/**
 * Tests for the command-path abbreviation (abbrev-path.ts) — 纯逻辑单测，不需要 pi
 *（与 sandbox.test.ts 同口径：本模块不 import 任何东西，`node --test` 直接跑）。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/abbrev-path.test.ts
 *
 * 断言口径（用户 2026-10-03 定）：
 *   - **一期只对特定地址动手**：`cat` / `cd` / `ls` / `ln` 的路径参数，外加任意位置的
 *     `NAME=<路径>` 赋值（用户样例 `P=…` 落在这支）。其余命令（`import … from "/Users/…"`
 *     那种代码里的地址）一律不动；
 *   - 阈值 = **命令正文可用列**（终端宽 − 块左边距 − `Run ` 前缀）的 40%，80 列终端上 29 列；
 *     路径可见宽度不超过阈值就原样返回；
 *   - 缩略**只动中间**：形态 `<头>…/<尾>`，开头的层数尽量保 2 层（放不下才退 1 层），
 *     **尾部层数优先**（用户选的「尾部能留几层留几层」）；
 *   - 只认**文件系统地址**：被点名命令的路径参数、`NAME=<路径>` 赋值。变量 / 反引号 /
 *     通配符 / 花括号展开 / 引号包裹（`"$HOME/…"`）/ `~` 开头 / 相对路径不足 3 层 /
 *     根目录，一律不缩（一期刻意保守）；heredoc（`<<EOF`）之后的词是数据，也不缩；
 *   - 地址之外的**每一个字符都保持不变**（命令名、选项、操作符、空格、其余参数）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { abbreviateCommandPaths, compressPath, pathAbbrevThreshold } from "./abbrev-path.ts";

/** 可见列数（fixture 只有 ASCII 与汉字；汉字 2 列 —— 与 pi-tui 的算口一致）。 */
function widthOf(text: string): number {
	let width = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/** 80 列终端：正文 73 列（80 − 左边距 3 − `Run ` 4）→ 阈值 29 列。 */
const T80 = pathAbbrevThreshold(73);
/** 120 列终端：正文 113 列 → 阈值 45 列。 */
const T120 = pathAbbrevThreshold(113);

const LNS =
	"/Users/bachi/Library/pnpm/store/v11/links/@earendil-works/pi-coding-agent/1.0.0/37d1cb5c3be3707b62fbfebebda5cf0a1317c413c77cb67cb1b35b90714d5e01/node_modules/@earendil-works/pi-coding-agent";

test("阈值：正文可用列的 40%（向下取整），极窄时兜底为 1", () => {
	assert.equal(T80, 29, `73 列的 40% = 29：${T80}`);
	assert.equal(T120, 45, `113 列的 40% = 45：${T120}`);
	assert.equal(pathAbbrevThreshold(80), 32);
	assert.equal(pathAbbrevThreshold(0), 1, "极窄终端也得给一个正整数，不能是 0");
	assert.equal(pathAbbrevThreshold(-5), 1);
});

test("compressPath：没超阈值就原样返回（一字不动）", () => {
	assert.equal(compressPath("/Users/bachi/x", T80), "/Users/bachi/x");
	// 恰好等于阈值也不缩（判定是「超过」）
	const exact = "/Users/bachi/Library/pnpm";
	assert.equal(widthOf(exact), 25, "断言口径的前提：这条路径 25 列");
	assert.equal(compressPath(exact, 25), exact);
});

test("compressPath：只缩中间，头尾各留一层以上，中间换 `…`", () => {
	const out = compressPath(LNS, T80);
	// 29 列预算下尾部只放得下 1 层（`@earendil-works/pi-coding-agent` 自己就 33 列），
	// 于是取「开头 2 层 + 最后 1 层」——形态仍是 `头…/尾`
	assert.equal(out, "/Users/bachi…/pi-coding-agent", `缩略形态：${out}`);
	assert.ok(widthOf(out) <= T80, `缩略后不该超阈值：${widthOf(out)} <= ${T80}`);
	assert.equal(out.startsWith("/Users/bachi"), true, "开头两层留着");
	assert.equal(out.endsWith("/pi-coding-agent"), true, "结尾一层留着");
	assert.equal(out.includes("…/"), true, `中间那层缩写要带斜杠：${out}`);
});

test("compressPath：尾部层数优先（预算够就多留尾部，必要时让出开头那一层）", () => {
	// 45 列：`/Users/bachi…/@earendil-works/pi-coding-agent`（45 列）= 开头 2 层 + 尾部 2 层 ——
	// 尾部取到 2 层为止（同尾层数时保开头 2 层）
	assert.equal(compressPath(LNS, T120), "/Users/bachi…/@earendil-works/pi-coding-agent");
	// 60 列：尾部继续涨到 3 层（`node_modules/@earendil-works/pi-coding-agent`）
	const packed = compressPath(LNS, 60);
	assert.equal(packed, "/Users/bachi…/node_modules/@earendil-works/pi-coding-agent");
	assert.equal(widthOf(packed), 58, "把预算用满（剩下的 2 列装不下再多一层）");
});

test("compressPath：路径本身就短 → 一个字都不改（含相对路径、根目录、浅路径）", () => {
	assert.equal(compressPath("./clients/pi/extensions", T80), "./clients/pi/extensions", "相对路径不足 3 层，缩了反而更难认");
	assert.equal(compressPath("src/a/b/c.js", T80), "src/a/b/c.js");
	assert.equal(compressPath("/", T80), "/");
	assert.equal(compressPath("/tmp", T80), "/tmp");
	// 超过阈值但只有 2 层：没有可缩的「中间」→ 原样（不能把开头或结尾整段吞掉）
	const shallow = "/verylongsegmentname1/verylongsegmentname2";
	assert.equal(compressPath(shallow, 10), shallow);
});

test("单测：40% 阈值 + 头尾保留（用户给的原命令）", () => {
	const command = `P=${LNS}; grep -rn "foo" src/`;
	const out = abbreviateCommandPaths(command, T80);
	assert.equal(out, 'P=/Users/bachi…/pi-coding-agent; grep -rn "foo" src/', `输出：${out}`);
	// 地址之外的部分一字未动（分号、命令、参数、引号全在）
	assert.equal(out.slice(out.indexOf("; grep")), command.slice(command.indexOf("; grep")));
	assert.ok(widthOf(out) < widthOf(command), `总宽度该变小：${widthOf(out)} < ${widthOf(command)}`);
});

test("一期点名命令：cat / cd / ls / ln 的地址参数才缩", () => {
	const cases: Array<[string, string]> = [
		[`cat ${LNS}/render.test.ts`, "cat /Users/bachi…/render.test.ts"],
		[`cd ${LNS}`, "cd /Users/bachi…/pi-coding-agent"],
		[`ls -la ${LNS}/dist/core/`, "ls -la /Users/bachi…/dist/core/"],
		// 尾部层数优先：28 列的 `/Users…/pi-coding-agent/a.ts` 比 18 列的 `/Users/bachi…/a.ts` 多留一层
		[`ln -sf ${LNS}/a.ts /tmp/x.ts`, "ln -sf /Users…/pi-coding-agent/a.ts /tmp/x.ts"],
		// 目录形态：尾部斜杠要保住
		[`ls ${LNS}/dist/core/`, "ls /Users/bachi…/dist/core/"],
	];
	for (const [command, expected] of cases) {
		assert.equal(abbreviateCommandPaths(command, T80), expected, `命令：${command}`);
	}
});

test("一期关键：**没被点名的命令**参数一律不动", () => {
	const cases = [
		`import { discoverAndLoadExtensions } from "${LNS}/dist/core/index.js"`,
		`grep -rn "foo" ${LNS}`,
		`cp ${LNS}/a.ts /tmp/b.ts`,
		`rm -rf ${LNS}`,
		`node ${LNS}/cli.js`,
		`echo ${LNS}`,
	];
	for (const command of cases) {
		assert.equal(abbreviateCommandPaths(command, T80), command, `不该动：${command}`);
	}
});

test("一期不动清单：变量 / 反引号 / 通配符 / 花括号 / 引号包裹 / `~` / heredoc", () => {
	const cases = [
		'cat "$HOME/.pi/agent/AGENTS.md"',
		`cat '${LNS}/a.ts'`,
		"cat `pwd`/a/b/c/d/e/f/g",
		`ls ${LNS}/*.js`,
		`ls ${LNS}/{a,b,c}.js`,
		"cd ~/Library/Logs/DiagnosticReports/Retired/Submissions",
		`cat ${LNS}/a-{1,2}.ts`,
		// heredoc：正文是数据，不是 cat 的地址参数
		`cat <<'EOF'\n${LNS}\nEOF`,
	];
	for (const command of cases) {
		assert.equal(abbreviateCommandPaths(command, T80), command, `一期不该动：${command}`);
	}
});

test("多地址：同一条命令里的每个地址都缩（用户选「全部缩略」）", () => {
	const command = `cat docs/a.md clients/pi/README.md ${LNS}/render.test.ts`;
	const out = abbreviateCommandPaths(command, T80);
	assert.equal(out, "cat docs/a.md clients/pi/README.md /Users/bachi…/render.test.ts", `短的不动、长的缩：${out}`);
	const both = abbreviateCommandPaths(`ln -sf ${LNS}/a.ts ${LNS}/b.ts`, T80);
	assert.equal(both, "ln -sf /Users…/pi-coding-agent/a.ts /Users…/pi-coding-agent/b.ts", `两个地址都缩：${both}`);});

test("分段：`;` `&&` `||` `|` 各段各自认命令与地址", () => {
	const out = abbreviateCommandPaths(`cd ${LNS} && ls -la ${LNS}/dist | cat`, T80);
	assert.equal(out, "cd /Users/bachi…/pi-coding-agent && ls -la /Users…/pi-coding-agent/dist | cat", `输出：${out}`);
});

test("选项与命令名不缩：`ls -la` 的 flag、命令自身的路径都不动", () => {
	const out = abbreviateCommandPaths(`/usr/local/bin/ls -la ${LNS}`, T80);
	assert.equal(out, "/usr/local/bin/ls -la /Users/bachi…/pi-coding-agent", `命令名原样、flag 原样：${out}`);
});

test("赋值：`NAME=<路径>` 一律缩（不看命令名 —— 用户样例就是 `P=…`）", () => {
	assert.equal(abbreviateCommandPaths(`P=${LNS}`, T80), "P=/Users/bachi…/pi-coding-agent");
	assert.equal(abbreviateCommandPaths(`FOO=bar`, T80), "FOO=bar", "值不是路径：不动");
	assert.equal(abbreviateCommandPaths('FOO="$HOME/x/y/z/1"', T80), 'FOO="$HOME/x/y/z/1"', "值含变量：不动");
	assert.equal(abbreviateCommandPaths(`P=${LNS} cat ${LNS}/a.ts`, T80), "P=/Users/bachi…/pi-coding-agent cat /Users…/pi-coding-agent/a.ts");
});

test("地址之外的字符一个不动（只删字符、不重写命令）", () => {
	const command = `cd ${LNS} && cat ${LNS}/render.test.ts || echo "not found"`;
	const out = abbreviateCommandPaths(command, T80);
	// 逐段对照：把输出里的 `…` 换回原地址前缀后必须与原文逐字相同（这里用最小反证法：
	// 输出必须是原文删掉若干字符后的结果）
	let cursor = 0;
	for (const ch of out.replaceAll("…", "")) {
		const at = command.indexOf(ch, cursor);
		assert.notEqual(at, -1, `输出里出现了原文没有的字符：${ch}（输出 ${out}）`);
		cursor = at + 1;
	}
	assert.ok(out.includes('|| echo "not found"'), `操作符与引号原样：${out}`);
	assert.ok(out.includes("&& cat "), `命令名原样：${out}`);
});

test("边界：空命令 / 只有空白的命令原样返回", () => {
	assert.equal(abbreviateCommandPaths("", T80), "");
	assert.equal(abbreviateCommandPaths("   ", T80), "   ");
	assert.equal(abbreviateCommandPaths("echo hello", T80), "echo hello");
});
