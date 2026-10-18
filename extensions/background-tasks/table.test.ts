/**
 * Tests for table.ts — `run_in_background` 结果块末尾那张任务总览表的纯逻辑。
 *
 * Run with:  node --test clients/pi/extensions/background-tasks/table.test.ts
 *
 * table.ts 不 import pi / pi-tui，宽度量度与上色都由调用方注入。这里用一个与 pi-tui
 * `visibleWidth` 同口径的本地计数器（ANSI 剥掉、CJK 全角 2 列、`…` 1 列），断言列宽分配、
 * 命令截断、行数上限与折叠行这些**决定**。上色与树前缀挂在 index.test.ts 里走真加载器。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_TABLE_ROWS,
	MIN_COMMAND_WIDTH,
	moreTasksHint,
	renderTaskTable,
	type TaskTableRow,
	type TaskTableTask,
	clampText,
} from "./table.ts";

/** 剥 ANSI（这里只是防测试自己带色，实际上色不经过本模块）。 */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "");
}

/**
 * 可见宽度，口径与 pi-tui 的 `visibleWidth` 一致（ASCII 1 列、CJK / 全角 2 列）。
 * `⚠️` 这类 emoji 区间本用例用不到，只需要覆盖 CJK 这一条真正会踩到的分支。
 */
function widthOf(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) {
		const code = char.codePointAt(0)!;
		// CJK 统一表意文字 / 全角标点 / 常用中文标点
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

/** 把片段行拼成可见文本（上色在这里不影响宽度，因为注入的 role 映射是恒等）。 */
function plainRow(row: TaskTableRow): string {
	return row.map((segment) => segment.text).join("");
}

const NOW = 1_000_000;

function taskOf(overrides: Partial<TaskTableTask> = {}): TaskTableTask {
	return {
		id: "bg_1",
		command: "npm test",
		status: "exited",
		startedAt: NOW - 12_000,
		endedAt: NOW - 2_000,
		exitCode: 0,
		signal: undefined,
		...overrides,
	};
}

function render(tasks: TaskTableTask[], width: number, maxRows?: number): string[] {
	return renderTaskTable(tasks, { width, now: NOW, widthOf, maxRows }).map(plainRow);
}

describe("clampText：宽度口径与省略号", () => {
	it("装得下就原样返回", () => {
		assert.equal(clampText("npm test", 20, widthOf), "npm test");
		assert.equal(clampText("npm test", 8, widthOf), "npm test", "恰好等于宽度也算装得下");
	});

	it("装不下就裁到 width - 1 再补 …（尾部空格不留在省略号前面）", () => {
		assert.equal(clampText("npm test --silent", 10, widthOf), "npm test…");
		assert.equal(widthOf(clampText("npm test --silent", 10, widthOf)), 9, "省掉尾空格后是 9 列，padText 补到 10");
		assert.equal(clampText("abcdefghijkl", 10, widthOf), "abcdefghi…", "没有空格可略时就是 width - 1 个字 + …");
	});

	it("width 1 只放得下 …，width 0 / 负数返回空串", () => {
		assert.equal(clampText("npm test", 1, widthOf), "…");
		assert.equal(clampText("npm test", 0, widthOf), "");
		assert.equal(clampText("npm test", -3, widthOf), "");
	});

	it("CJK 按 2 列算，不会超宽", () => {
		const cut = clampText("运行测试套件并输出详细日志", 11, widthOf);
		assert.ok(widthOf(cut) <= 11, `宽度 ${widthOf(cut)} 超了 11：${JSON.stringify(cut)}`);
		assert.ok(cut.endsWith("…"), `应带省略号：${JSON.stringify(cut)}`);
	});
});

describe("renderTaskTable：形状与列", () => {
	it("表头是 id / command / status / time（第一列是路由键 id，不是 name）", () => {
		const lines = render([taskOf()], 60);
		assert.equal(lines[0]!.startsWith("┌"), true, `首行是顶边框：${JSON.stringify(lines[0])}`);
		assert.match(lines[1]!, /│ id +│ command +│ status +│ time +│/, `表头列名：${JSON.stringify(lines[1])}`);
		assert.equal(lines[2]!.startsWith("├"), true, `第三行是表头分隔线：${JSON.stringify(lines[2])}`);
		assert.equal(lines[lines.length - 1]!.startsWith("└"), true, `末行是底边框：${JSON.stringify(lines[lines.length - 1])}`);
	});

	it("所有行可见宽度严格一致（表格不歪）", () => {
		const lines = render(
			[taskOf(), taskOf({ id: "bg_10", command: "sleep 2; echo helloworld", status: "running", endedAt: undefined })],
			60,
		);
		const widths = new Set(lines.map((line) => widthOf(line)));
		assert.equal(widths.size, 1, `各行宽度应一致，实际：${JSON.stringify([...widths])} ${JSON.stringify(lines)}`);
	});

	it("整表宽度恰好等于传入的 width（command 吃掉剩余空间）", () => {
		for (const width of [40, 60, 80, 120]) {
			const lines = render([taskOf()], width);
			assert.equal(widthOf(lines[0]!), width, `width=${width} 的表格宽度：${JSON.stringify(lines[0])}`);
		}
	});

	it("status 走 dock 同一套词汇：running / exit 0 / exit=N / killed（没有 done）", () => {
		const lines = render(
			[
				taskOf({ id: "bg_1", status: "running", endedAt: undefined, exitCode: undefined }),
				taskOf({ id: "bg_2", status: "exited", exitCode: 0 }),
				taskOf({ id: "bg_3", status: "exited", exitCode: 3 }),
				taskOf({ id: "bg_4", status: "killed", exitCode: undefined, signal: "SIGTERM" }),
			],
			64,
		);
		const joined = lines.join("\n");
		assert.match(joined, /running/);
		assert.match(joined, /exit 0/);
		assert.match(joined, /exit=3/, "非 0 退出要带退出码（done 会把这条信息吞掉）");
		assert.match(joined, /killed/);
		assert.ok(!/done/.test(joined), "不采用草图里的 done");
	});

	it("time 列右对齐、内容是 formatElapsed（无空格）", () => {
		const lines = render([taskOf({ startedAt: NOW - 662_000, endedAt: NOW - 2_000 })], 60);
		const row = lines.find((line) => line.includes("bg_1"))!;
		assert.match(row, /11m0s/, `时长写法与 dock 一致：${JSON.stringify(row)}`);
		// 右对齐：`11m0s` 后面就是空格 + 收尾 │，前面可能有补位空格
		assert.match(row, / +11m0s +│$/);
	});
});

describe("renderTaskTable：行序、上限与折叠", () => {
	it("最旧在上、最新在下（与草图 bg_1 → bg_2 一致）", () => {
		const lines = render(
			[
				taskOf({ id: "bg_1", startedAt: NOW - 30_000 }),
				taskOf({ id: "bg_2", startedAt: NOW - 20_000, status: "running", endedAt: undefined }),
			],
			60,
		);
		const row1 = lines.findIndex((line) => line.includes("bg_1"));
		const row2 = lines.findIndex((line) => line.includes("bg_2"));
		assert.ok(row1 > 0 && row2 > row1, `bg_1 应在 bg_2 之上：${JSON.stringify(lines)}`);
	});

	it("默认最多 5 行任务，超出时丢最旧的并给折叠提示", () => {
		const tasks = Array.from({ length: 8 }, (_unused, index) =>
			taskOf({ id: `bg_${index + 1}`, startedAt: NOW - (8 - index) * 1_000, command: `cmd-${index + 1}` }),
		);
		const lines = render(tasks, 60);
		const body = lines.filter((line) => /bg_\d/.test(line));
		assert.equal(body.length, MAX_TABLE_ROWS, `任务行数应被压到 ${MAX_TABLE_ROWS}：${JSON.stringify(lines)}`);
		assert.match(lines.join("\n"), /…3 background tasks earlier/, `折叠提示：${JSON.stringify(lines)}`);
		assert.ok(!lines.join("\n").includes("bg_1 "), "最旧的 bg_1 被丢掉");
		assert.ok(lines.join("\n").includes("bg_8"), "最新的 bg_8 保留");
		// 折叠行在**表头之下、任务行之上**（用户 2026-10-17 定）：被丢掉的正是这些可见行之前的那几个
		const hintIndex = lines.findIndex((line) => line.includes("background tasks earlier"));
		const firstTask = lines.findIndex((line) => /│ bg_\d/.test(line));
		assert.equal(hintIndex, 3, `折叠行在表头分隔线之后：${JSON.stringify(lines)}`);
		assert.equal(firstTask, hintIndex + 1, `折叠行在第一条任务行之上：${JSON.stringify(lines)}`);
		assert.equal(lines[lines.length - 2]!.startsWith("│ bg_"), true, `末行任务行紧贴底边框（无折叠行夹在中间）：${JSON.stringify(lines)}`);
	});

	it("恰好 5 个时不折叠", () => {
		const tasks = Array.from({ length: 5 }, (_unused, index) => taskOf({ id: `bg_${index + 1}`, startedAt: NOW - index }));
		const lines = render(tasks, 60);
		assert.ok(!lines.join("\n").includes("background tasks earlier"), `不该出现折叠提示：${JSON.stringify(lines)}`);
	});

	it("maxRows 可覆盖上限（测试与将来调整用）", () => {
		const tasks = Array.from({ length: 6 }, (_unused, index) => taskOf({ id: `bg_${index + 1}`, startedAt: NOW - index }));
		const lines = render(tasks, 60, 2);
		assert.equal(lines.filter((line) => /bg_\d/.test(line)).length, 2);
		assert.match(lines.join("\n"), /…4 background tasks earlier/);
	});

	it("折叠行宽度与表格其余行一致", () => {
		const tasks = Array.from({ length: 7 }, (_unused, index) => taskOf({ id: `bg_${index + 1}`, startedAt: NOW - index }));
		const lines = render(tasks, 60);
		const widths = new Set(lines.map((line) => widthOf(line)));
		assert.equal(widths.size, 1, `含折叠行在内各行宽度应一致：${JSON.stringify([...widths])}`);
		assert.equal(lines[3]!.startsWith("│"), true, "折叠行用竖边（不是 └）");
		assert.equal(lines[lines.length - 1]!.startsWith("└"), true, "末行仍是底边框");
	});

	it("折叠行是一条普通表格行：文案在 command 格，其余三列填 -（用户 2026-10-17 定）", () => {
		const tasks = Array.from({ length: 7 }, (_unused, index) =>
			taskOf({ id: `bg_${index + 1}`, startedAt: NOW - index, command: `cmd-${index + 1}` }),
		);
		const lines = render(tasks, 60);
		const hint = lines.find((line) => line.includes("background tasks earlier"))!;
		// 四根竖线一根不少 —— 这是「表格结构不被破坏」的具体含义
		assert.equal(hint.split("│").length - 1, 5, `折叠行要保留 4 根内部竖线：${JSON.stringify(hint)}`);
		assert.equal(hint.startsWith("│"), true, `折叠行以左边框开头：${JSON.stringify(hint)}`);
		assert.equal(hint.endsWith("│"), true, `折叠行以右边框结尾：${JSON.stringify(hint)}`);
		// 与表头逐列对齐：文案落在第 2 格（command），id / status / time 三格是 -
		const cells = hint.split("│").slice(1, -1).map((cell) => cell.trim());
		const headerCells = lines.find((line) => line.startsWith("│ id"))!.split("│").slice(1, -1).map((cell) => cell.trim());
		assert.deepEqual(cells, ["-", "…2 background tasks earlier", "-", "-"], `折叠行四格：${JSON.stringify(cells)}`);
		// 占位 `-` 居中（与用户草图 `│  -   │ … │    -    │   -   │` 一致），不是左对齐
		for (const [index, cell] of hint.split("│").slice(1, -1).entries()) {
			if (index === 1) continue; // command 格是左对齐的文案
			const body = cell.slice(1, -1);
			const left = body.length - body.trimStart().length;
			const right = body.length - body.trimEnd().length;
			assert.ok(Math.abs(left - right) <= 1 && left > 0, `第 ${index} 格的 - 应居中：${JSON.stringify(cell)}`);
		}
		assert.deepEqual(headerCells, ["id", "command", "status", "time"], "表头不变");
	});

	it("moreTasksHint 文案固定（英文短句，只占 command 一格）", () => {
		assert.equal(moreTasksHint(3), "…3 background tasks earlier");
	});
});

describe("renderTaskTable：不画的条件", () => {
	it("没有任务 → 空数组（空表只剩表头，是噪音）", () => {
		assert.deepEqual(render([], 80), []);
	});

	it("太窄 → 整张表不画（不画半截表）", () => {
		// 13 帧宽 + 4(id) + 6(status) + 5(time) + 10(command) = 38 是下限
		assert.deepEqual(render([taskOf()], 30), []);
		assert.ok(render([taskOf()], 40).length > 0, "40 列应该画得出来");
	});

	it("宽度恰好卡在 command 下限时仍画（边界不抖）", () => {
		const frame = 13;
		const id = 4;
		const status = 7; // running
		const time = 5;
		const exact = frame + id + status + time + MIN_COMMAND_WIDTH;
		assert.ok(render([taskOf({ status: "running", endedAt: undefined })], exact).length > 0, `width=${exact} 应可画`);
		assert.deepEqual(render([taskOf({ status: "running", endedAt: undefined })], exact - 1), [], "少一列就不画");
	});

	it("width 为 0 / 负数 → 空数组", () => {
		assert.deepEqual(render([taskOf()], 0), []);
		assert.deepEqual(render([taskOf()], -5), []);
	});
});

describe("renderTaskTable：长命令截断", () => {
	it("命令放不下就裁成 …，且整行不超宽", () => {
		const lines = render([taskOf({ command: "x".repeat(200) })], 50);
		const row = lines.find((line) => line.includes("bg_1"))!;
		assert.ok(row.includes("…"), `应带省略号：${JSON.stringify(row)}`);
		assert.equal(widthOf(row), 50, `整行应与表格同宽：${JSON.stringify(row)}`);
	});

	it("命令里的换行会被压平（registry 的 truncateCommand 口径）", () => {
		const lines = render([taskOf({ command: "a\nb" })], 60);
		const row = lines.find((line) => line.includes("bg_1"))!;
		assert.ok(!row.includes("\n"), "表格行不能含换行");
	});
});
