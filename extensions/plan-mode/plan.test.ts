/**
 * Tests for plan.ts — plan-mode 的三态状态机（dangerous / bypass / plan）与 bash 写操作判定。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/plan.test.ts
 *
 * plan.ts 不 import pi / pi-tui，所以这里全部是纯输入输出断言。bash 判定表按
 * 「读操作放行 / 写操作拦住」两类各钉一组真实命令；拦截用例断言的是 `ok === false`，
 * 不断言文案原文（文案会随开发调整，形状在最后一个用例里单独钉一次）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CYCLE_ORDER,
	cancelPlan,
	completeDocWrite,
	enterDocWriting,
	enterPlan,
	exitDangerous,
	initialPlanState,
	inspectBashCommand,
	nextCyclePhase,
	planModeToolSet,
	rejectPlan,
	restoredToolSet,
	splitSimpleCommands,
	stripHeredocBodies,
	submitPlan,
} from "./plan.ts";

// =============================================================================
// 状态机
// =============================================================================

const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "ls", "ask_user_question", "task_set", "mcp__wechat-local__status"];

describe("工具集", () => {
	it("plan 阶段摘掉写工具，其余动态注册的工具一个不动", () => {
		const tools = planModeToolSet(ALL_TOOLS);
		assert.ok(!tools.includes("edit"));
		assert.ok(!tools.includes("write"));
		assert.deepEqual(tools, ["read", "bash", "grep", "ls", "ask_user_question", "task_set", "mcp__wechat-local__status"]);
	});

	it("不碰只读工具与扩展注册的工具（powershell 也一样摘掉）", () => {
		assert.deepEqual(planModeToolSet(["read", "powershell", "recap"]), ["read", "recap"]);
	});

	it("去重保持 pi 自己的顺序", () => {
		assert.deepEqual(planModeToolSet(["read", "read", "write"]), ["read"]);
	});

	it("写文档子态单独放回 write，edit / powershell 仍摘着", () => {
		const tools = planModeToolSet(ALL_TOOLS, true);
		assert.ok(tools.includes("write"), "子态需要 write 把计划落成文件");
		assert.ok(!tools.includes("edit"));
		assert.ok(!tools.includes("powershell"));
	});

	it("退出时优先还原进入前的快照", () => {
		const state = enterPlan(initialPlanState(), ALL_TOOLS);
		assert.deepEqual(restoredToolSet(state, ["read", "bash"]), ALL_TOOLS);
	});

	it("没有快照时退回当前活动工具（会话中途换过 --tools）", () => {
		assert.deepEqual(restoredToolSet(initialPlanState(), ["read", "bash"]), ["read", "bash"]);
	});
});

describe("状态迁移", () => {
	const PLAN = "# 方案\n\n## 总结\n改两个文件。";

	it("默认态是 bypass（启动即开沙箱删除拦截）", () => {
		assert.equal(initialPlanState().phase, "bypass");
	});

	it("shift+tab 固定循环：dangerous → bypass → plan → dangerous", () => {
		assert.deepEqual(CYCLE_ORDER, ["dangerous", "bypass", "plan"]);
		assert.equal(nextCyclePhase("dangerous"), "bypass");
		assert.equal(nextCyclePhase("bypass"), "plan");
		assert.equal(nextCyclePhase("plan"), "dangerous");
	});

	it("nextCyclePhase 认不出的值退回 bypass（安全默认）", () => {
		assert.equal(nextCyclePhase("execute" as never), "bypass");
	});

	it("exitDangerous 回 bypass；不在 dangerous 里则不动", () => {
		assert.equal(exitDangerous({ phase: "dangerous" }).phase, "bypass");
		assert.equal(exitDangerous(initialPlanState()).phase, "bypass");
		assert.equal(exitDangerous(enterPlan(initialPlanState(), ALL_TOOLS)).phase, "plan");
	});

	it("enterPlan 记下快照与来路，并清空上一次计划的痕迹", () => {
		const state = enterPlan(initialPlanState(), ALL_TOOLS);
		assert.equal(state.phase, "plan");
		assert.equal(state.returnPhase, "bypass");
		assert.deepEqual(state.toolsBeforePlan, ALL_TOOLS);
		assert.equal(state.pending, undefined);
		assert.equal(state.docMode, undefined);
		assert.equal(state.docWriting, undefined);
	});

	it("从 dangerous 进 plan 时 returnPhase 记为 dangerous", () => {
		assert.equal(enterPlan({ phase: "dangerous" }, ALL_TOOLS).returnPhase, "dangerous");
	});

	it("重复 enterPlan 不覆盖快照，也不覆盖来路", () => {
		const once = enterPlan({ phase: "dangerous" }, ["read", "edit"]);
		const twice = enterPlan(once, ["read"]);
		assert.deepEqual(twice.toolsBeforePlan, ["read", "edit"]);
		assert.equal(twice.returnPhase, "dangerous");
	});

	it("enterPlan 清掉上一次留下的 docWriting（否则新一轮直接注入写文档指令）", () => {
		const stale = enterDocWriting(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN), "doc-only", "/tmp/a.md");
		const fresh = enterPlan({ ...stale, phase: "bypass" }, ALL_TOOLS);
		assert.equal(fresh.docWriting, undefined);
		assert.equal(fresh.pendingDocPath, undefined);
	});

	it("cancelPlan（shift+tab 离开 plan）落到 dangerous，不看 returnPhase", () => {
		const fromBypass = cancelPlan(enterPlan(initialPlanState(), ALL_TOOLS));
		assert.equal(fromBypass.phase, "dangerous", "固定循环的下一态，不是原路返回");
		const fromDangerous = cancelPlan(enterPlan({ phase: "dangerous" }, ALL_TOOLS));
		assert.equal(fromDangerous.phase, "dangerous");
	});

	it("cancelPlan 清空一切 plan 字段（含 returnPhase 与工具快照）", () => {
		const state = cancelPlan(enterDocWriting(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN), "doc-only", "/tmp/a.md"));
		assert.equal(state.returnPhase, undefined);
		assert.equal(state.toolsBeforePlan, undefined);
		assert.equal(state.pending, undefined);
		assert.equal(state.docWriting, undefined);
		assert.equal(state.pendingDocPath, undefined);
	});

	it("submitPlan 存下计划全文与总结，仍停在 plan 等审批", () => {
		const submitted = submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN, "  改两个文件  ");
		assert.equal(submitted.pending, PLAN);
		assert.equal(submitted.planSummary, "改两个文件", "总结要 trim");
		assert.equal(submitted.phase, "plan");
	});

	it("submitPlan 空总结记为 undefined（slug 会退回兜底值）", () => {
		const submitted = submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN, "   ");
		assert.equal(submitted.planSummary, undefined);
	});

	it("submitPlan 只在 plan 阶段生效", () => {
		assert.equal(submitPlan(initialPlanState(), PLAN).pending, undefined);
	});

	it("rejectPlan 留在 plan、丢掉 pending 与文档子态标记，但保住工具快照与来路", () => {
		const writing = enterDocWriting(submitPlan(enterPlan({ phase: "dangerous" }, ALL_TOOLS), PLAN), "doc-only", "/tmp/a.md");
		const rejected = rejectPlan(writing);
		assert.equal(rejected.phase, "plan", "打回不是退出，要继续改方案");
		assert.equal(rejected.pending, undefined);
		assert.equal(rejected.docWriting, undefined);
		assert.equal(rejected.pendingDocPath, undefined);
		assert.deepEqual(rejected.toolsBeforePlan, ALL_TOOLS);
		assert.equal(rejected.returnPhase, "dangerous", "打回后重新批准仍要回原来的模式");
	});
});

describe("写文档子态", () => {
	const PLAN = "# 方案";
	const DOC = "/repo/.pi/plans/2026-09-24-方案.md";

	function inDocWriting(mode: "execute-with-doc" | "doc-only" = "execute-with-doc") {
		return enterDocWriting(submitPlan(enterPlan(initialPlanState(), ALL_TOOLS), PLAN, "方案"), mode, DOC);
	}

	it("enterDocWriting 翻开关、记住路线与路径，phase 仍是 plan", () => {
		const state = inDocWriting();
		assert.equal(state.phase, "plan", "子态不是第三个 phase：bash 拦截与工具收拢全靠 plan 态");
		assert.equal(state.docWriting, true);
		assert.equal(state.docMode, "execute-with-doc");
		assert.equal(state.pendingDocPath, DOC);
		assert.equal(state.pending, PLAN, "计划全文留着，写文档指令要用");
	});

	it("重复 enterDocWriting 幂等，不覆盖已钉死的路径", () => {
		const once = inDocWriting();
		const twice = enterDocWriting(once, "doc-only", "/repo/.pi/plans/other.md");
		assert.equal(twice.pendingDocPath, DOC);
		assert.equal(twice.docMode, "execute-with-doc");
	});

	it("不在 plan 态时 enterDocWriting 不动", () => {
		assert.equal(enterDocWriting(initialPlanState(), "doc-only", DOC).docWriting, undefined);
	});

	it("completeDocWrite 收尾回 returnPhase，并把路线与路径交给调用方", () => {
		const outcome = completeDocWrite(inDocWriting("doc-only"));
		assert.ok(outcome);
		assert.equal(outcome.state.phase, "bypass");
		assert.equal(outcome.returnPhase, "bypass");
		assert.equal(outcome.docMode, "doc-only");
		assert.equal(outcome.docPath, DOC);
		assert.equal(outcome.state.docWriting, undefined);
		assert.equal(outcome.state.pending, undefined);
		assert.equal(outcome.state.toolsBeforePlan, undefined, "快照随状态清空（还原动作由调用方先做）");
	});

	it("从 dangerous 进的 plan，写完文档后实施阶段回 dangerous（从哪来回哪去）", () => {
		const fromDangerous = enterDocWriting(
			submitPlan(enterPlan({ phase: "dangerous" }, ALL_TOOLS), PLAN, "方案"),
			"execute-with-doc",
			DOC,
		);
		const outcome = completeDocWrite(fromDangerous);
		assert.equal(outcome?.state.phase, "dangerous");
		assert.equal(outcome?.returnPhase, "dangerous");
		assert.equal(outcome?.state.returnPhase, undefined, "收尾后不再持有来路");
	});

	it("returnPhase 缺失时收尾退回 bypass（安全默认：宁可多一层删除拦截）", () => {
		const outcome = completeDocWrite({ ...inDocWriting(), returnPhase: undefined });
		assert.equal(outcome?.state.phase, "bypass");
	});

	it("不在子态里调用 completeDocWrite 返回 undefined（那不是收尾）", () => {
		assert.equal(completeDocWrite(enterPlan(initialPlanState(), ALL_TOOLS)), undefined);
		assert.equal(completeDocWrite(initialPlanState()), undefined);
	});

	it("路径丢了也不收尾（宁可可恢复地停在子态，不要静默放行）", () => {
		const broken = { ...inDocWriting(), pendingDocPath: undefined };
		assert.equal(completeDocWrite(broken), undefined);
	});

	it("docMode 缺失时收尾按 execute-with-doc 走（批准过就该能实施）", () => {
		const outcome = completeDocWrite({ ...inDocWriting(), docMode: undefined });
		assert.equal(outcome?.docMode, "execute-with-doc");
	});
});

// =============================================================================
// bash 判定：放行
// =============================================================================

const SAFE_COMMANDS = [
	"ls -la",
	"cat src/index.ts",
	"rg 'plan' -n clients/pi",
	"git status",
	"git log --oneline -20",
	"git diff HEAD --stat",
	"git show HEAD:README.md",
	"git branch -a",
	"npm list --depth=0",
	"npm ls",
	"pnpm --version",
	"node --test clients/pi/extensions/plan-mode/plan.test.ts",
	"python3 -m unittest gateway/tests/test_qoder_provider.py",
	"echo hello",
	"pwd",
	"wc -l file",
	"jq '.models' gateway/config.yaml",
	"sed -n '1,20p' README.md",
	"2>&1",
	"cat a.txt 2>&1 | head -5",
	"git status && git log --oneline -3",
	"cat a.txt; ls -la",
	"make --dry-run",
	"cat <<EOF\nrm -rf /tmp/x\nEOF",
	"npm run build 2>/dev/null",
	"git diff > /dev/null",
	"find . -name '*.ts' -type f",
	"ls | grep plan",
	"env | sort",
	"echo 'a > b'",
	"cat \"file with > in name\"",
	"git config --get remote.origin.url",
	"name=value; ls",
];

describe("bash 判定：只读命令放行", () => {
	for (const command of SAFE_COMMANDS) {
		it(command.replace(/\n/g, "\\n"), () => {
			assert.deepEqual(inspectBashCommand(command), { ok: true });
		});
	}
});

// =============================================================================
// bash 判定：拦截
// =============================================================================

const WRITE_COMMANDS = [
	"echo hi > out.txt",
	"echo hi >> out.txt",
	"cat a.txt > b.txt",
	"rm -rf node_modules",
	"mv a b",
	"cp -r a b",
	"mkdir out",
	"touch newfile",
	"chmod +x script.sh",
	"tee out.txt",
	"sed -i '' 's/a/b/' file",
	"sed -i.bak 's/a/b/' file",
	"find . -name '*.ts' -delete",
	"find . -name '*.ts' -exec rm {} \\;",
	"git add -A",
	"git commit -m x",
	"git push",
	"git reset --hard",
	"git checkout -- .",
	"git stash",
	"npm install",
	"npm i lodash",
	"npm ci",
	"pnpm add -D typescript",
	"pip install requests",
	"brew install jq",
	"sudo rm -rf /",
	"apt-get install -y curl",
	"vim README.md",
	"make build",
	"eslint . --fix",
	"prettier --write .",
	"cat a.txt && rm -rf b",
	"ls; rm -rf /tmp/x",
	"ls | tee out.txt",
	"(cd /tmp && rm -rf x)",
	"echo x > /dev/null; rm -rf y",	"dd if=/dev/zero of=/tmp/x bs=1 count=1",
	"NODE_ENV=prod rm -rf dist",
	"truncate -s 0 log.txt",
];

describe("bash 判定：写操作拦住", () => {
	for (const command of WRITE_COMMANDS) {
		it(command, () => {
			assert.equal(inspectBashCommand(command).ok, false, `应拦住：${command}`);
		});
	}

	it("拒绝原因带 plan 阶段说明与具体命令（模型据此改道）", () => {
		const verdict = inspectBashCommand("rm -rf dist");
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason ?? "", /^plan 阶段不执行写操作/);
		assert.match(verdict.reason ?? "", /rm/);
	});

	it("复杂命令里读的那一半不算拦截理由，写的那一半才算", () => {
		const verdict = inspectBashCommand("cat a.txt && git status && rm -rf b");
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason ?? "", /rm/);
	});
});

// =============================================================================
// 解析细节
// =============================================================================

describe("splitSimpleCommands", () => {
	it("按 ; | & && || 括号与换行切段", () => {
		const heads = splitSimpleCommands("a; b | c && d || e & f\n(g)").map((simple) => simple.words[0]);
		assert.deepEqual(heads, ["a", "b", "c", "d", "e", "f", "g"]);
	});

	it("引号里的分隔符不切段", () => {
		const segments = splitSimpleCommands("echo 'a; b' \"c | d\"");
		assert.equal(segments.length, 1);
		assert.deepEqual(segments[0]!.words, ["echo", "a; b", "c | d"]);
	});

	it("重定向目标记进 writes，不混进参数", () => {
		const segments = splitSimpleCommands("echo hi > out.txt 2> err.txt");
		assert.deepEqual(segments[0]!.writes, ["out.txt", "err.txt"]);
		assert.deepEqual(segments[0]!.words, ["echo", "hi"]);
	});

	it("fd 复制（2>&1）不算写入", () => {
		assert.deepEqual(splitSimpleCommands("cat a 2>&1").map((simple) => simple.writes), [[]]);
	});

	it("here-string 与读取重定向都不算写入", () => {
		assert.deepEqual(splitSimpleCommands("wc -l <<< abc").map((simple) => simple.writes), [[]]);
		assert.deepEqual(splitSimpleCommands("sort < in.txt").map((simple) => simple.writes), [[]]);
	});

	it("转义的分隔符不切段", () => {
		assert.deepEqual(splitSimpleCommands("echo a\\;b").map((simple) => simple.words), [["echo", "a;b"]]);
	});
});

describe("stripHeredocBodies", () => {
	it("heredoc 正文换成空行，结束行保留", () => {
		const stripped = stripHeredocBodies("cat <<EOF\nrm -rf x\nEOF\nls");
		assert.ok(!stripped.includes("rm -rf x"));
		assert.match(stripped, /ls/);
	});

	it("<<- 的制表符缩进结束符也能认出", () => {
		const stripped = stripHeredocBodies("cat <<-EOF\n\trm -rf x\n\tEOF\nls");
		assert.ok(!stripped.includes("rm -rf x"));
		assert.match(stripped, /ls/);
	});

	it("引号分隔符（<<'EOF'）也识别", () => {
		const stripped = stripHeredocBodies("cat <<'EOF'\nrm -rf x\nEOF");
		assert.ok(!stripped.includes("rm -rf x"));
	});

	it("没有结束符时原样返回，不吞掉后面的命令", () => {
		const command = "cat <<EOF\nactive";
		assert.equal(stripHeredocBodies(command), command);
		assert.equal(inspectBashCommand(command).ok, true, "不确定时保守放行");
	});
});
