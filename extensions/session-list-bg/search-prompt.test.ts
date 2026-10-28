/**
 * Tests for search-prompt.ts — `/resume` 搜索框提示符的纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/session-list-bg/search-prompt.test.ts
 *
 * 这里只需要假对象：真实形状（`SessionSelectorComponent.sessionList.searchInput.prompt`）
 * 是 pi 的私有字段，端到端那半在 `index.test.ts` 里用 pi 自己的组件验。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SEARCH_PROMPT, applySearchPrompt, resolveSearchPrompt } from "./search-prompt.ts";

test("默认提示符是 `Search: `", () => {
	assert.equal(DEFAULT_SEARCH_PROMPT, "Search: ");
	assert.equal(resolveSearchPrompt(undefined), "Search: ");
	assert.equal(resolveSearchPrompt(""), "Search: ");
	assert.equal(resolveSearchPrompt("   "), "Search: ");
});

test("off / none / - 表示不改（返回空串，与「没配」区分开）", () => {
	for (const raw of ["off", "OFF", " none ", "-"]) {
		assert.equal(resolveSearchPrompt(raw), "", `${raw} 应该关掉`);
	}
});

test("自定义文本：末尾缺空格时补一个，已有空格不重复补", () => {
	assert.equal(resolveSearchPrompt("Search:"), "Search: ");
	assert.equal(resolveSearchPrompt("Find: "), "Find: ");
	assert.equal(resolveSearchPrompt("搜："), "搜： ");
});

test("applySearchPrompt 改的是 sessionList.searchInput.prompt", () => {
	const searchInput = { prompt: "> " };
	const selector = { sessionList: { searchInput } };
	assert.equal(applySearchPrompt(selector, "Search: "), true);
	assert.equal(searchInput.prompt, "Search: ");
});

test("已经是目标值时返回 false（渲染每帧都会走一遍，不重复写）", () => {
	const searchInput = { prompt: "Search: " };
	assert.equal(applySearchPrompt({ sessionList: { searchInput } }, "Search: "), false);
});

test("空提示符（off）什么都不做，保留 pi 的 `> `", () => {
	const searchInput = { prompt: "> " };
	assert.equal(applySearchPrompt({ sessionList: { searchInput } }, ""), false);
	assert.equal(searchInput.prompt, "> ");
});

test("形状不认识时安静返回 false、不抛（渲染 tick 里抛出去会打死 pi）", () => {
	const shapes: unknown[] = [
		undefined,
		null,
		42,
		"selector",
		{},
		{ sessionList: null },
		{ sessionList: {} },
		{ sessionList: { searchInput: "not-an-input" } },
	];
	for (const shape of shapes) {
		assert.equal(applySearchPrompt(shape, "Search: "), false, `${JSON.stringify(shape)} 应该被跳过`);
	}
});

test("读私有字段本身抛（活 Proxy 失效）时也不抛", () => {
	const selector = {
		get sessionList(): never {
			throw new Error("stale context");
		},
	};
	assert.equal(applySearchPrompt(selector, "Search: "), false);
});
