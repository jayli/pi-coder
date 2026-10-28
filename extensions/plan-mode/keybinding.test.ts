/**
 * Tests for keybinding.ts — 思考等级循环键的改绑规则。
 *
 * Run with:  node --test clients/pi/extensions/plan-mode/keybinding.test.ts
 *
 * 最要紧的一条：用户自己配过 `app.thinking.cycle` 时**一个字都不能改**。一个扩展悄悄
 * 覆盖用户的键位配置是很讨厌的行为，所以「不动」的用例比「改对」的用例更重要。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THINKING_FALLBACK_KEY, THINKING_KEYBINDING_ID, keybindingsPath, rebindThinkingKey } from "./keybinding.ts";

const PATH = "/tmp/agent/keybindings.json";

describe("rebindThinkingKey：该改的", () => {
	it("空配置 → 生成只含这一项的新配置", () => {
		const { value, outcome } = rebindThinkingKey("", PATH);
		assert.equal(outcome.changed, true);
		assert.equal(outcome.path, PATH);
		assert.equal(outcome.reason, undefined);
		const parsed = JSON.parse(value) as Record<string, string>;
		assert.equal(parsed[THINKING_KEYBINDING_ID], THINKING_FALLBACK_KEY);
	});

	it("只有空白 → 当成空配置", () => {
		assert.equal(rebindThinkingKey("   \n", PATH).outcome.changed, true);
	});

	it("保留配置里已有的其它绑定", () => {
		const raw = `${JSON.stringify({ "tui.input.newLine": "ctrl+j", "app.suspend": "ctrl+z" }, null, 2)}\n`;
		const { value, outcome } = rebindThinkingKey(raw, PATH);
		assert.equal(outcome.changed, true);
		const parsed = JSON.parse(value) as Record<string, string>;
		assert.equal(parsed["tui.input.newLine"], "ctrl+j", "用户已有的绑定必须留着");
		assert.equal(parsed["app.suspend"], "ctrl+z");
		assert.equal(parsed[THINKING_KEYBINDING_ID], THINKING_FALLBACK_KEY);
	});

	it("输出以换行收尾（免得 diff 里出现 no-newline-at-eof）", () => {
		assert.ok(rebindThinkingKey("", PATH).value.endsWith("\n"));
	});
});

describe("rebindThinkingKey：不该改的", () => {
	it("用户已经自己配过 thinking cycle → 一个字都不动，也不提示", () => {
		const raw = `${JSON.stringify({ [THINKING_KEYBINDING_ID]: "ctrl+t" }, null, 2)}\n`;
		const { value, outcome } = rebindThinkingKey(raw, PATH);
		assert.equal(outcome.changed, false);
		assert.equal(value, raw);
		assert.match(outcome.reason ?? "", /is already bound/);
		assert.notEqual(outcome.needsAttention, true, "这是想要的状态，不该提醒用户");
	});

	it("上次已经改绑过（值就是 fallback）→ 幂等，不重写文件", () => {
		const raw = `${JSON.stringify({ [THINKING_KEYBINDING_ID]: THINKING_FALLBACK_KEY }, null, 2)}\n`;
		assert.equal(rebindThinkingKey(raw, PATH).outcome.changed, false);
	});

	it("配置不是合法 JSON → 不动、并要求用户手动处理", () => {
		const raw = "{ 这不是 JSON";
		const { value, outcome } = rebindThinkingKey(raw, PATH);
		assert.equal(outcome.changed, false);
		assert.equal(value, raw);
		assert.match(outcome.reason ?? "", /JSON/);
		assert.equal(outcome.needsAttention, true, "读不动且不敢改，应该让用户知道");
	});

	it("配置是 JSON 但不是对象（数组 / 字符串 / null）→ 不动", () => {
		for (const raw of ["[1, 2]", '"hello"', "null", "42"]) {
			const { value, outcome } = rebindThinkingKey(raw, PATH);
			assert.equal(outcome.changed, false, `不该改：${raw}`);
			assert.equal(value, raw);
		}
	});
});

describe("keybindingsPath", () => {
	it("默认落在 <agentDir>/keybindings.json", () => {
		const path = keybindingsPath({ PI_CODING_AGENT_DIR: "/custom/agent" } as NodeJS.ProcessEnv);
		assert.equal(path, "/custom/agent/keybindings.json");
	});

	it("没有环境变量时退回 ~/.pi/agent", () => {
		const path = keybindingsPath({} as NodeJS.ProcessEnv);
		assert.match(path, /\.pi\/agent\/keybindings\.json$/);
	});
});
