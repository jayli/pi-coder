/**
 * Tests for status.ts — the statusline background-task dock line.
 *
 * Run with:  node --test clients/pi/extensions/background-tasks/status.test.ts
 *
 * status.ts never imports pi / pi-tui, so plain fakes reach every branch: `plain` drops
 * colours (assert exact visible text), `painted` wraps each run as `color(text)` (assert
 * which theme colour slot every part uses).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DOCK_ICON,
	NOTE_GLYPH,
	STATUS_COMMAND_MAX,
	STATUS_KEY,
	TERMINAL_LINGER_MS,
	TURN_ENDED_NOTE,
	TURN_NOTE_THRESHOLD_MS,
	formatBackgroundStatus,
	type BackgroundStatusTask,
	type BackgroundStatusTheme,
} from "./status.ts";

const plain: BackgroundStatusTheme = { fg: (_color, text) => text };
const painted: BackgroundStatusTheme = { fg: (color, text) => `${color}(${text})` };

const NOW = 1_000_000;

function taskOf(overrides: Partial<BackgroundStatusTask> = {}): BackgroundStatusTask {
	return {
		id: "bg_1",
		command: "npm run test --silent",
		status: "running",
		startedAt: NOW - 12_000,
		endedAt: undefined,
		exitCode: undefined,
		signal: undefined,
		...overrides,
	};
}

describe("formatBackgroundStatus", () => {
	it("renders the running shape: icon, id, status, elapsed, command", () => {
		const line = formatBackgroundStatus(plain, [taskOf()], NOW);
		assert.equal(line, `${DOCK_ICON} bg_1 running 12s · npm run test --silent`);
	});

	it("pins the icon to U+2699 (no look-alike swap)", () => {
		assert.equal(DOCK_ICON, "\u2699");
		assert.equal([...DOCK_ICON].length, 1, "icon must be a single code point, no VS16");
	});

	it("paints each segment with its own semantic slot", () => {
		const line = formatBackgroundStatus(painted, [taskOf()], NOW);
		assert.equal(
			line,
			"dim(⚙) accent(bg_1) warning(running) muted(12s) dim(·) dim(npm run test --silent)",
		);
	});

	it("shows exit 0 in success and a non-zero exit in error", () => {
		const ok = taskOf({ status: "exited", endedAt: NOW - 2_000, exitCode: 0 });
		const bad = taskOf({ status: "exited", endedAt: NOW - 2_000, exitCode: 3 });
		assert.equal(
			formatBackgroundStatus(painted, [ok], NOW),
			"dim(⚙) accent(bg_1) success(exit 0) muted(10s) dim(·) dim(npm run test --silent)",
		);
		assert.equal(
			formatBackgroundStatus(painted, [bad], NOW),
			"dim(⚙) accent(bg_1) error(exit=3) muted(10s) dim(·) dim(npm run test --silent)",
		);
	});

	it("shows killed in error, and falls back to the signal when there is no exit code", () => {
		const killed = taskOf({ status: "killed", endedAt: NOW - 1_000, signal: "SIGTERM" });
		assert.match(formatBackgroundStatus(painted, [killed], NOW)!, /error\(killed\)/);

		const signalled = taskOf({
			status: "exited",
			endedAt: NOW - 1_000,
			exitCode: undefined,
			signal: "SIGKILL",
		});
		assert.match(formatBackgroundStatus(painted, [signalled], NOW)!, /error\(exit=SIGKILL\)/);
	});

	it("measures elapsed against endedAt once a task is terminal", () => {
		const done = taskOf({
			status: "exited",
			startedAt: NOW - 65_000,
			endedAt: NOW - 5_000,
			exitCode: 0,
		});
		assert.match(formatBackgroundStatus(plain, [done], NOW)!, /exit 0 1m0s ·/);
	});

	it("prefers the newest running task and folds the rest into (+N) before the command", () => {
		const tasks = [
			taskOf({ id: "bg_1", startedAt: NOW - 60_000 }),
			taskOf({ id: "bg_2", startedAt: NOW - 30_000, command: "node --test" }),
			taskOf({ id: "bg_3", startedAt: NOW - 5_000, command: "npm run build" }),
		];
		const line = formatBackgroundStatus(plain, tasks, NOW);
		// 计数在命令之前：超宽时只有行尾命令被截，`(+2)` 永远看得见。
		assert.equal(line, `${DOCK_ICON} bg_3 running 5s (+2) · npm run build`);
	});

	it("falls back to the newest lingering terminal task when nothing is running", () => {
		const tasks = [
			taskOf({ id: "bg_1", status: "exited", startedAt: NOW - 40_000, endedAt: NOW - 9_000, exitCode: 0 }),
			taskOf({ id: "bg_2", status: "exited", startedAt: NOW - 20_000, endedAt: NOW - 3_000, exitCode: 1 }),
		];
		const line = formatBackgroundStatus(plain, tasks, NOW);
		assert.equal(line, `${DOCK_ICON} bg_2 exit=1 17s (+1) · npm run test --silent`);
	});

	it("a running task wins over a terminal one even when the terminal one is newer", () => {
		const tasks = [
			taskOf({ id: "bg_1", status: "exited", startedAt: NOW - 5_000, endedAt: NOW - 1_000, exitCode: 0 }),
			taskOf({ id: "bg_2", startedAt: NOW - 60_000, command: "sleep 999" }),
		];
		assert.equal(
			formatBackgroundStatus(plain, tasks, NOW),
			`${DOCK_ICON} bg_2 running 1m0s · sleep 999`,
		);
	});

	it("drops a terminal task once it is past the linger window", () => {
		const stale = taskOf({
			status: "exited",
			startedAt: NOW - 60_000,
			endedAt: NOW - (TERMINAL_LINGER_MS + 1),
			exitCode: 0,
		});
		assert.equal(formatBackgroundStatus(plain, [stale], NOW), undefined);
		// exactly at the boundary it is still shown (inclusive)
		const edge = taskOf({
			status: "exited",
			startedAt: NOW - 60_000,
			endedAt: NOW - TERMINAL_LINGER_MS,
			exitCode: 0,
		});
		assert.ok(formatBackgroundStatus(plain, [edge], NOW));
	});

	it("honours an injected linger window", () => {
		const done = taskOf({ status: "exited", startedAt: NOW - 60_000, endedAt: NOW - 5_000, exitCode: 0 });
		assert.ok(formatBackgroundStatus(plain, [done], NOW, 10_000));
		assert.equal(formatBackgroundStatus(plain, [done], NOW, 1_000), undefined);
	});

	it("returns undefined for an empty task list", () => {
		assert.equal(formatBackgroundStatus(plain, [], NOW), undefined);
	});

	it("caps the command at STATUS_COMMAND_MAX with an ellipsis, keeping the head", () => {
		const long = `node --test ${"x".repeat(STATUS_COMMAND_MAX * 2)}`;
		const line = formatBackgroundStatus(plain, [taskOf({ command: long })], NOW)!;
		const command = line.split(" · ")[1]!;
		assert.equal([...command].length, STATUS_COMMAND_MAX);
		assert.ok(command.endsWith("…"));
		assert.ok(command.startsWith("node --test xxx"));
	});

	it("flattens a multi-line command into one line (the dock row must never wrap)", () => {
		const line = formatBackgroundStatus(plain, [taskOf({ command: "npm run\n\t  test   --silent" })], NOW)!;
		assert.equal(line.includes("\n"), false);
		assert.equal(line.includes("\t"), false);
		assert.match(line, /· npm run test --silent$/);
	});

	it("keeps the (+N) count visible when the command is truncated away", () => {
		// 回归：计数曾放在命令之后，一条长命令就能把它截掉 —— 而它正是多任务时
		// 唯一的信息。现在它在命令之前，终端宽度收口只吃行尾。
		const tasks = [
			taskOf({ id: "bg_1", startedAt: NOW - 60_000, command: `x ${"y".repeat(200)}` }),
			taskOf({ id: "bg_2", startedAt: NOW - 30_000, command: `z ${"w".repeat(200)}` }),
		];
		const line = formatBackgroundStatus(plain, tasks, NOW)!;
		const truncated = [...line].length > 60 ? `${[...line].slice(0, 59).join("")}…` : line;
		assert.ok(truncated.includes("(+1)"), truncated);
		assert.ok(truncated.includes("bg_2 running 30s"), truncated);
	});

	it("exposes the reserved status key the statusline pulls out", () => {
		assert.equal(STATUS_KEY, "background-tasks");
	});
});

// =============================================================================
// 结轮提示的第二行（本轮已结束，任务仍在跑）
// =============================================================================

describe("formatBackgroundStatus — 结轮提示", () => {
	// 任务已跑 5m10s，远超默认 5s 阈值。
	const longRunning = taskOf({ id: "bg_2", startedAt: NOW - 310_000 });
	const settled = { settledAt: NOW - 1_000 };

	it("在结轮且任务已跑满阈值时补第二行，`└` 悬在正文列", () => {
		const line = formatBackgroundStatus(plain, [longRunning], NOW, TERMINAL_LINGER_MS, settled);
		assert.equal(
			line,
			`${DOCK_ICON} bg_2 running 5m10s · npm run test --silent\n  ${NOTE_GLYPH} ${TURN_ENDED_NOTE}`,
		);
		// `└` 落在正文列（第一行 id 的首字符那一列）：行首两空格 + `└`。
		assert.equal(line!.split("\n")[1]!.indexOf(NOTE_GLYPH), 2);
	});

	it("pins the glyph to U+2514 (no look-alike swap)", () => {
		assert.equal(NOTE_GLYPH, "\u2514");
		assert.equal([...NOTE_GLYPH].length, 1);
	});

	it("本轮进行中（settledAt === undefined）不出第二行", () => {
		const line = formatBackgroundStatus(plain, [longRunning], NOW, TERMINAL_LINGER_MS, {
			settledAt: undefined,
		});
		assert.equal(line, `${DOCK_ICON} bg_2 running 5m10s · npm run test --silent`);
	});

	it("省略 turn 参数时永不换行（向后兼容）", () => {
		const line = formatBackgroundStatus(plain, [longRunning], NOW);
		assert.equal(line!.includes("\n"), false);
	});

	it("任务还没跑满阈值（默认 5s）就不出第二行", () => {
		// 4.9s：本轮刚结束、长任务才起几秒 —— 完全正常，不该被当成可能多余的。
		const fresh = taskOf({ id: "bg_3", startedAt: NOW - 4_900 });
		assert.equal(
			formatBackgroundStatus(plain, [fresh], NOW, TERMINAL_LINGER_MS, settled),
			`${DOCK_ICON} bg_3 running 4s · npm run test --silent`,
		);
		// 刚好到阈值就出（>= 包含边界）。
		const atThreshold = taskOf({ id: "bg_4", startedAt: NOW - TURN_NOTE_THRESHOLD_MS });
		assert.ok(formatBackgroundStatus(plain, [atThreshold], NOW, TERMINAL_LINGER_MS, settled)!.includes(TURN_ENDED_NOTE));
	});

	it("阈值可由 noteMs 覆盖；给 0 就是任务一起就提示", () => {
		const fresh = taskOf({ id: "bg_3", startedAt: NOW - 100 });
		assert.equal(
			formatBackgroundStatus(plain, [fresh], NOW, TERMINAL_LINGER_MS, { settledAt: NOW, noteMs: 0 })!
				.includes(TURN_ENDED_NOTE),
			true,
		);
		// 调高阈值则重新变安静
		assert.equal(
			formatBackgroundStatus(plain, [fresh], NOW, TERMINAL_LINGER_MS, { settledAt: NOW, noteMs: 60_000 })!
				.includes(TURN_ENDED_NOTE),
			false,
		);
	});

	it("终态任务不出第二行（驻留窗口里那几秒不需要这句话）", () => {
		const done = taskOf({ id: "bg_5", status: "exited", startedAt: NOW - 310_000, endedAt: NOW - 500, exitCode: 0 });
		const line = formatBackgroundStatus(plain, [done], NOW, TERMINAL_LINGER_MS, settled)!;
		assert.equal(line.includes(TURN_ENDED_NOTE), false);
	});

	it("只有被选中的那条 running 任务决定第二行，而非被折叠的 (+N)", () => {
		const tasks = [
			// 老任务早已跑满阈值，但新任务刚起 → 选中的是新任务，不提示。
			taskOf({ id: "bg_1", startedAt: NOW - 600_000 }),
			taskOf({ id: "bg_2", startedAt: NOW - 1_000, command: "node --test" }),
		];
		const line = formatBackgroundStatus(plain, tasks, NOW, TERMINAL_LINGER_MS, settled)!;
		assert.ok(line.includes("bg_2 running 1s (+1)"), line);
		assert.equal(line.includes(TURN_ENDED_NOTE), false);
	});

	it("第二行按 warning 着色，`└` 单独取 muted（结构字符不吃后面文案的颜色）", () => {
		const line = formatBackgroundStatus(painted, [longRunning], NOW, TERMINAL_LINGER_MS, settled)!;
		const sub = line.split("\n")[1]!;
		assert.equal(sub, `  muted(${NOTE_GLYPH}) warning(${TURN_ENDED_NOTE})`);
	});

	it("缺省阈值常量是 5s（用户 2026-09-29 定的）", () => {
		assert.equal(TURN_NOTE_THRESHOLD_MS, 5_000);
	});
});
