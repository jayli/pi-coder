/**
 * Tests for sandbox-mode.ts — plan-mode 与沙箱层之间的共享模式单例。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/sandbox-mode.test.ts
 *
 * 纯模块（不 import pi），所以直接断言读写行为。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getSandboxMode, resetSandboxModeForTesting, setSandboxMode } from "./sandbox-mode.ts";

describe("sandbox-mode 单例", () => {
	it("从未设置过时默认 bypass（安全默认：plan-mode 没装也照样拦删除）", () => {
		resetSandboxModeForTesting();
		assert.equal(getSandboxMode(), "bypass");
	});

	it("dangerous / bypass / plan 三态都能写入并读回", () => {
		resetSandboxModeForTesting();
		setSandboxMode("dangerous");
		assert.equal(getSandboxMode(), "dangerous");
		setSandboxMode("plan");
		assert.equal(getSandboxMode(), "plan");
		setSandboxMode("bypass");
		assert.equal(getSandboxMode(), "bypass");
	});

	it("认不出的值一律收敛到 bypass（白名单式，旧会话/坏数据不会变成 dangerous）", () => {
		resetSandboxModeForTesting();
		setSandboxMode("dangerous");
		setSandboxMode("execute");
		assert.equal(getSandboxMode(), "bypass");
		setSandboxMode("dangerous");
		setSandboxMode(undefined);
		assert.equal(getSandboxMode(), "bypass");
		setSandboxMode("dangerous");
		setSandboxMode(null);
		assert.equal(getSandboxMode(), "bypass");
	});

	it("reset 之后回到默认", () => {
		setSandboxMode("dangerous");
		resetSandboxModeForTesting();
		assert.equal(getSandboxMode(), "bypass");
	});

	it("挂在 globalThis 上：换一个模块实例读到的也是同一份状态", () => {
		resetSandboxModeForTesting();
		setSandboxMode("dangerous");
		// 模拟「另一个扩展 import 到的另一个模块实例」：直接读 globalThis 上的键。
		const host = globalThis as unknown as Record<string, unknown>;
		assert.equal(host["pi-sandbox-mode"], "dangerous");
	});
});
