/**
 * Tests for path.ts — Windows / POSIX cwd → ~/.pi/folder-history/<name>.jsonl
 *
 * Run with:  node --test extensions/folder-history/path.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { posix, win32 } from "node:path";

import { historyFileName } from "./path.ts";

const HISTORY_DIR_WIN = "C:\\Users\\ethan\\.pi\\folder-history";
const HISTORY_DIR_POSIX = "/home/user/.pi/folder-history";

describe("historyFileName", () => {
	it("turns a unix cwd into a single dashed segment", () => {
		assert.equal(historyFileName("/home/user/project"), "-home-user-project");
	});

	it("strips a windows drive letter and backslashes", () => {
		assert.equal(historyFileName("D:\\Program Files\\tty7"), "D-Program Files-tty7");
	});

	it("treats mixed windows slashes the same as backslashes", () => {
		assert.equal(historyFileName("D:/Program Files/tty7"), "D-Program Files-tty7");
	});

	it("collapses runs of slashes (UNC / doubled separators)", () => {
		assert.equal(historyFileName("\\\\server\\share\\foo"), "-server-share-foo");
		assert.equal(historyFileName("/tmp//foo"), "-tmp-foo");
	});

	it("leaves no :, / or \\ that path.win32.join would treat as another drive", () => {
		const name = historyFileName("D:\\Program Files\\tty7");
		assert.equal(/[:/\\]/.test(name), false);
		assert.equal(
			win32.join(HISTORY_DIR_WIN, `${name}.jsonl`),
			"C:\\Users\\ethan\\.pi\\folder-history\\D-Program Files-tty7.jsonl",
		);
	});

	it("regression: the old replace-only-/ name joins to a nested D:\\ path on win32", () => {
		const oldName = "D:\\Program Files\\tty7".replace(/\//g, "-");
		assert.equal(
			win32.join(HISTORY_DIR_WIN, `${oldName}.jsonl`),
			"C:\\Users\\ethan\\.pi\\folder-history\\D:\\Program Files\\tty7.jsonl",
		);
	});

	it("stays a child of the posix history dir", () => {
		const name = historyFileName("/tmp/foo");
		assert.equal(
			posix.join(HISTORY_DIR_POSIX, `${name}.jsonl`),
			"/home/user/.pi/folder-history/-tmp-foo.jsonl",
		);
	});
});
