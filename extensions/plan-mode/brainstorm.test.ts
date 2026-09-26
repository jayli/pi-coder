/**
 * Tests for brainstorm.ts — brainstorming ↔ plan mode 二选一的纯判定。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/brainstorm.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { brainstormingLoadedInRun, findRunStart, type RunMessage } from "./brainstorm.ts";

/** 造一条 assistant 消息，content 里放一个 read toolCall 块。 */
function readCall(path: string): RunMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path } }],
	};
}

/** 造一条 assistant 消息，content 里放一个任意工具调用。 */
function toolCall(name: string, args: Record<string, unknown> = {}): RunMessage {
	return { role: "assistant", content: [{ type: "toolCall", id: "call-1", name, arguments: args }] };
}

const user = (text = "hi"): RunMessage => ({ role: "user", content: [{ type: "text", text }] });

const SKILL_PATH = "/Users/bachi/.agents/skills/superpowers/brainstorming/SKILL.md";

test("findRunStart：最后一条 user 消息的下标；没有 user 时 -1", () => {
	assert.equal(findRunStart([]), -1);
	assert.equal(findRunStart([readCall("/x")]), -1);
	assert.equal(findRunStart([user(), readCall("/x")]), 0);
	assert.equal(findRunStart([user("a"), readCall("/x"), user("b"), toolCall("bash")]), 2);
});

test("run 内 read 过 brainstorming SKILL.md → true", () => {
	assert.equal(brainstormingLoadedInRun([user(), readCall(SKILL_PATH)]), true);
});

test("run 内多个工具调用，其中一个是 brainstorming read → true", () => {
	assert.equal(
		brainstormingLoadedInRun([user(), toolCall("bash", { command: "ls" }), readCall(SKILL_PATH), toolCall("edit", { path: "/a" })]),
		true,
	);
});

test("read 在最后一条 user 消息之前（上一轮的）→ 不算", () => {
	assert.equal(brainstormingLoadedInRun([user("a"), readCall(SKILL_PATH), user("b"), toolCall("bash")]), false);
});

test("整个分支没有 user 消息：全分支都算窗口 → 算", () => {
	assert.equal(brainstormingLoadedInRun([readCall(SKILL_PATH)]), true);
});

test("空分支 → false", () => {
	assert.equal(brainstormingLoadedInRun([]), false);
});

test("非 read 工具读了同一路径 → 不算", () => {
	assert.equal(brainstormingLoadedInRun([user(), toolCall("bash", { command: `cat ${SKILL_PATH}` })]), false);
});

test("read 别的路径 → 不算", () => {
	assert.equal(brainstormingLoadedInRun([user(), readCall("/Users/bachi/.pi/agent/AGENTS.md")]), false);
});

test("路径片段带斜杠边界：brainstorming2/ 之类的邻居目录不误中", () => {
	assert.equal(brainstormingLoadedInRun([user(), readCall("/skills/brainstorming2/SKILL.md")]), false);
	assert.equal(brainstormingLoadedInRun([user(), readCall("/skills/my-brainstorming-notes/x.md")]), false);
});

test("反斜杠路径（规范化后）也算", () => {
	assert.equal(brainstormingLoadedInRun([user(), readCall("C:\\skills\\brainstorming\\SKILL.md")]), true);
});

test("非 assistant 消息里的 toolCall 块不算（形状防御）", () => {
	const weird: RunMessage = { role: "toolResult", content: [{ type: "toolCall", name: "read", arguments: { path: SKILL_PATH } }] };
	assert.equal(brainstormingLoadedInRun([user(), weird]), false);
});

test("content 不是数组 / arguments 缺 path：不崩、不算", () => {
	const noArray: RunMessage = { role: "assistant", content: "plain text" };
	const noArgs: RunMessage = { role: "assistant", content: [{ type: "toolCall", name: "read" }] };
	const badPath: RunMessage = { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: 42 } }] };
	assert.equal(brainstormingLoadedInRun([user(), noArray, noArgs, badPath]), false);
});

test("custom 注入消息不切断 run 窗口（续跑链共用窗口）", () => {
	const injected: RunMessage = { role: "custom", content: [{ type: "text", text: "gate" }] };
	assert.equal(brainstormingLoadedInRun([user(), readCall(SKILL_PATH), injected, toolCall("bash")]), true);
});
