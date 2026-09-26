/**
 * plan-mode 的纯逻辑层：三态状态机 + plan 阶段的 bash 写操作判定。
 *
 * 不 import pi / pi-tui，所以 `node --test clients/pi/extensions/plan-mode/plan.test.ts`
 * 能直接跑到每个分支。
 *
 * ## 状态机（三态：dangerous / bypass / plan）
 *
 * shift+tab 走**固定循环** `dangerous → bypass → plan → dangerous`（`nextCyclePhase`）：
 *
 *   dangerous ──shift+tab──▶ bypass ──shift+tab / enter_plan_mode──▶ plan
 *       ▲                                                            │
 *       └────────────────────── shift+tab（固定循环）────────────────┘
 *
 * 三态的权限含义：
 *
 *   - **dangerous**：pi 原生的任意权限形态 —— 沙箱删除拦截整体关闭。只能由用户
 *     shift+tab 切到（没有命令、没有模型路径能进来），所以 `cancelPlan` 落在这一态
 *     是安全的：那是用户自己按出来的。
 *   - **bypass**（默认）：沙箱删除拦截开启。启动、`/resume`、认不出的历史值都收敛到这里。
 *   - **plan**：只读探索。这一态不靠沙箱 —— 它自己的两道闸（工具收拢 + bash 写拦截）
 *     已经禁掉一切写入与删除，比沙箱的「只拦删除」更严。
 *
 * plan 有**三条出口**，落点不同（这是本状态机唯一需要记住来路的地方）：
 *
 *   plan ──exit_plan_mode + 用户批准──▶ 写文档子态 ──▶ returnPhase（从哪来回哪去）
 *     │                                     │
 *     └──── 用户打回（留在 plan）◀───────────┘
 *     └──── shift+tab ──▶ dangerous（固定循环的下一态，不看 returnPhase）
 *     └──── /plan ─────▶ bypass（安全默认：一条命令不该把用户送进沙箱关闭的态）
 *
 * `returnPhase` 由 `enterPlan` 记下（进 plan 之前的那一态，只会是 dangerous 或 bypass），
 * 只有「写完计划文档、进入实施阶段」这条路径用它 —— 用户批准了方案，实施就该在他原本
 * 选定的权限姿态下进行，而不是被 plan mode 顺手改掉。
 *
 * 注意固定循环是 dangerous → bypass → plan → dangerous，所以 **shift+tab 从 dangerous
 * 到不了 plan**（中间隔着 bypass）；带着 dangerous 来路进 plan 的是模型路径
 * （`enter_plan_mode`）与 `--plan`。
 *
 * **没有 execute 态**：批准之后写权限恢复、状态直接回 bypass，「按计划文档实施」是一次性
 * 交给模型的指令（工具结果里），不是扩展持有的一个阶段。进度也交还给模型 —— 它认为该建
 * 任务清单就自己 `task_set`，扩展不再镜像步骤、不再记 `[DONE:n]`（2026-09-24 改，理由见
 * README 的 plan mode 一节）。
 *
 * plan 态里有一个**写文档子态**（`docWriting`）：用户在审批框里选了带文档的路线时进入。
 * 它刻意**不是第三个 phase** —— phase 仍是 `plan`，所以 bash 写拦截、工具收拢、
 * `exit_plan_mode` 的入口判定全部照常生效；唯一的区别是每轮注入的上下文换成写文档指令，
 * 而 `write` 工具被单独放回来（`planModeToolSet(active, true)`），并由 `tool_call` 钩子
 * 限死只能写计划文档那一个路径。文档写出来（`tool_result` 钩子看到 write 成功）即收尾：
 * 回 bypass、还原工具表，收尾指令按 `docMode` 分流 —— `execute-with-doc` 让模型接着实施，
 * `doc-only` 让它只报告文档路径就停。
 *
 * plan 阶段进入时对 `pi.getActiveTools()` 做一次快照，退出时**原样还原**：本机 pi 的
 * 工具表里有二十多个扩展动态注册的工具（mcp / ask_user_question / task_set / task_update …），
 * 硬编码白名单会把它们全吃掉（官方 plan-mode 示例就是那么写的，所以这里没照抄）。
 *
 * ## bash 判定
 *
 * 判定「这条命令会不会改工作区」，粒度是**简单命令** —— 用 `;` `&` `|` `&&` `||` `(` `)`
 * 和换行切开，所以 `cat a.txt && rm -rf b` 会被 rm 那一段拦住，而不是被 `cat` 那一段放过。
 * 识别四类写操作：
 *
 *   1. 写重定向：`>` / `>>`（`2> f` 的 fd 前缀不算参数、`2>&1` 这种 fd 复制不算写入）
 *   2. 写命令：rm / mv / cp / sed -i / tee / dd / git commit / npm install / sudo …
 *   3. 全局危险参数：`--fix` / `--write` / `--in-place`（eslint --fix、prettier --write …）
 *   4. heredoc 正文先剥掉再判，免得「读一个 heredoc」里顺带出现的一句写命令被误判
 *
 * **这是给配合的模型用的护栏，不是沙箱。** 模型被明确告知 plan 阶段不能改动代码，这里
 * 只负责拦下它顺手打出的写操作并把原因回给它（错误结果就是模型的反馈）。要真正防住
 * 恶意写入得靠操作系统级沙箱，不在这个扩展的范围内。两个已知的漏网形状：双引号内的
 * `$(...)` 命令替换、以及 `npm run <script>` 这类由脚本内容决定副作用的命令 —— 都是
 * 刻意放行的（宁可放行也不要把正常探索全部拦死）。
 */

// =============================================================================
// 工具集
// =============================================================================

/** pi 的写工具（`powershell` 是 bash 在 Windows 侧的等价物）。 */
export const WRITE_TOOLS = ["edit", "write", "powershell"] as const;

/**
 * plan 阶段的活动工具：摘掉写工具，**其余原样保留**。
 * 顺序与去重都保持 pi 自己的口径，避免把动态注册的工具漏掉或重复。
 *
 * `allowWrite` 是写文档子态的开关：那时模型需要 `write` 把计划落成文件，但 `edit`
 * （改现有代码）与 `powershell`（另一个写口子）仍然摘着。放开的那一个 `write` 由
 * `tool_call` 钩子再限一道：只许写计划文档那个路径。
 */
export function planModeToolSet(activeTools: readonly string[], allowWrite = false): string[] {
	const hidden = new Set<string>(WRITE_TOOLS);
	if (allowWrite) hidden.delete("write");
	return [...new Set(activeTools.filter((name) => !hidden.has(name)))];
}

// =============================================================================
// 状态机
// =============================================================================

export type PlanPhase = "dangerous" | "bypass" | "plan";

/** plan 的「实施阶段」要回到的模式：进 plan 之前的那一态（plan 自己当然不算）。 */
export type ReturnPhase = "dangerous" | "bypass";

/**
 * shift+tab 的固定循环顺序（用户 2026-09-27 定）。
 * 顺序写死在这里，测试直接钉这张表 —— 改顺序就是改契约。
 */
export const CYCLE_ORDER: readonly PlanPhase[] = ["dangerous", "bypass", "plan"];

/**
 * shift+tab 的下一态：dangerous → bypass → plan → dangerous。
 * 认不出的值退回 `bypass`（安全默认，与 `normalizePhase` 同口径）。
 */
export function nextCyclePhase(phase: PlanPhase): PlanPhase {
	const index = CYCLE_ORDER.indexOf(phase);
	if (index === -1) return "bypass";
	return CYCLE_ORDER[(index + 1) % CYCLE_ORDER.length]!;
}

/**
 * 用户在审批对话框里选的路线（两条都写文档，区别只在写完要不要接着实施）。
 *   - execute-with-doc：写计划文档，然后按文档实施
 *   - doc-only：只写计划文档，不实施
 */
export type PlanDocMode = "execute-with-doc" | "doc-only";

export interface PlanState {
	phase: PlanPhase;
	/**
	 * plan 阶段：进入前的模式（dangerous 或 bypass）。
	 * 只有「计划文档写完、进入实施阶段」这条出口用它（`completeDocWrite`）；
	 * shift+tab 离开 plan 走固定循环回 dangerous，不看这个字段。
	 */
	returnPhase?: ReturnPhase;
	/** plan 阶段：进入前的活动工具快照，退出时原样还原。 */
	toolsBeforePlan?: string[];
	/**
	 * plan 阶段：模型通过 `exit_plan_mode` 提交上来、等用户审批的计划全文（markdown）。
	 * 与 Claude Code 的 `ExitPlanMode(plan)` 同形 —— 不再是一串结构化步骤：步骤化是
	 * 「扩展持有进度」时代的产物，进度交还模型之后它只剩展示与生成文件名两个用途。
	 */
	pending?: string;
	/** 用户选了哪条路线（文档写完前记住它，收尾指令据此分流）。 */
	docMode?: PlanDocMode;
	/**
	 * 写文档子态：模型正在把计划落成文档。
	 * phase 仍是 "plan"（bash 写拦截、工具收拢全部照常），这个布尔是唯一的区分信号：
	 * 每轮注入的上下文从只读探索换成写文档指令，`write` 被单独放回来。
	 */
	docWriting?: boolean;
	/**
	 * 写文档子态的目标路径：用户选路线的那一刻算好并落盘。
	 * 不能每次注入时重算 —— 撞名判定问的是文件系统，`/resume` 后重算可能得到不同的
	 * `-2` 后缀，模型就会往另一个文件写。算一次、钉死在状态里才是对的。
	 */
	pendingDocPath?: string;
	/**
	 * 本次提交的 `summary`（模型给的一句话总结）。
	 * 两个用途：写文档指令里的「方案总结」一行，以及模型漏传 `slug` 时的文档名兜底。
	 * 跟着落盘：写文档子态里 `/resume` 之后还要靠它算出同一个路径。
	 */
	planSummary?: string;
}

export function initialPlanState(): PlanState {
	return { phase: "bypass" };
}

/**
 * 进 plan 模式。已在 plan 里则原样返回（不覆盖工具快照，也不覆盖 returnPhase）。
 * 文档相关的字段一并清掉：上一次计划留下的 docMode / docWriting / pendingDocPath /
 * pending 对新计划没有意义（docWriting 若残留，新一轮会直接注入写文档指令）。
 */
export function enterPlan(state: PlanState, activeTools: readonly string[]): PlanState {
	if (state.phase === "plan") return state;
	return {
		phase: "plan",
		// 记下来路：写完计划文档进入实施阶段时要回到这里（dangerous 进的就回 dangerous）。
		returnPhase: state.phase === "dangerous" ? "dangerous" : "bypass",
		toolsBeforePlan: [...activeTools],
		pending: undefined,
		docMode: undefined,
		docWriting: undefined,
		pendingDocPath: undefined,
		planSummary: undefined,
	};
}

/** 清空一切 plan 相关字段，只留指定的 phase（三条出口共用同一口径）。 */
function cleared(phase: PlanPhase): PlanState {
	return {
		phase,
		returnPhase: undefined,
		toolsBeforePlan: undefined,
		pending: undefined,
		docMode: undefined,
		docWriting: undefined,
		pendingDocPath: undefined,
		planSummary: undefined,
	};
}

/**
 * 离开 plan 到指定的非-plan 模式，清空一切 plan 字段。
 * 三条出口共用：`cancelPlan`（shift+tab，固定循环去 dangerous）与 `/plan`
 * （回到 returnPhase，从哪来回哪去）。
 */
export function exitPlanTo(state: PlanState, phase: ReturnPhase): PlanState {
	void state;
	return cleared(phase);
}

/**
 * shift+tab / 固定循环离开 plan：落到 **dangerous**（循环的下一态），
 * 工具快照随之清空（还原动作由调用方执行）。
 *
 * 刻意不看 `returnPhase`：shift+tab 是「按循环走」，不是「原路返回」—— 用户按一次
 * 就该看到下一个模式，否则从 bypass 进的 plan 按 shift+tab 会回到 bypass，看起来像
 * 没切动。想回 bypass 再按一次即可（dangerous → bypass）。
 *
 * 落在 dangerous 是安全的：dangerous 只能由用户 shift+tab 切到（没有命令、没有模型
 * 路径能进来），所以这里到达它必然是用户自己按出来的。
 */
export function cancelPlan(state: PlanState): PlanState {
	void state;
	return cleared("dangerous");
}

/**
 * dangerous → bypass：重新打开沙箱删除拦截。
 * 这一态没有任何扩展持有的状态（不收工具、不记快照），所以只是换个 phase。
 * 不在 dangerous 里则原样返回（幂等）。
 */
export function exitDangerous(state: PlanState): PlanState {
	if (state.phase !== "dangerous") return state;
	return { ...state, phase: "bypass" };
}

/** 模型通过 exit_plan_mode 提交计划全文，等用户审批。 */
export function submitPlan(state: PlanState, plan: string, summary?: string): PlanState {
	if (state.phase !== "plan") return state;
	const trimmedSummary = typeof summary === "string" ? summary.trim() : "";
	return {
		...state,
		pending: plan,
		planSummary: trimmedSummary === "" ? undefined : trimmedSummary,
	};
}

/**
 * 用户打回：**留在 plan**（不是回 bypass），继续等模型改方案。
 * 工具快照留着 —— 下一轮 `exit_plan_mode` 覆盖 pending 即可。
 * 写文档子态的标记一并清掉：打回等于这次提交（含路线选择）作废。
 */
export function rejectPlan(state: PlanState): PlanState {
	if (state.phase !== "plan") return state;
	return { ...state, pending: undefined, docMode: undefined, docWriting: undefined, pendingDocPath: undefined };
}

/**
 * 进写文档子态：phase 留在 "plan"（bash 写拦截与工具收拢全靠它），只翻 docWriting
 * 开关并记住用户选的路线与目标路径。pending 与工具快照原样保留 —— 文档写完后还要按
 * 路线分流收尾。已在子态里则原样返回（幂等，不覆盖已钉死的路径）。
 */
export function enterDocWriting(state: PlanState, docMode: PlanDocMode, docPath: string): PlanState {
	if (state.phase !== "plan") return state;
	if (state.docWriting) return state;
	return { ...state, docMode, docWriting: true, pendingDocPath: docPath };
}

export interface DocWriteOutcome {
	/** 收尾后的状态：phase 回到 returnPhase，文档字段清空。 */
	state: PlanState;
	/** 用户选的路线，收尾指令据此分流。 */
	docMode: PlanDocMode;
	/** 计划文档的路径（收尾指令里要报给用户与模型）。 */
	docPath: string;
	/** 收尾落在哪个模式（= state.phase，单独给出来是为了让调用方不必再判一次）。 */
	returnPhase: ReturnPhase;
}

/**
 * 写文档子态收尾：计划文档已经落盘（由调用方验过），状态回 **returnPhase** ——
 * 从哪个模式进的 plan，实施阶段就在哪个模式下进行（用户 2026-09-27 定）。
 * 没有记录时退回 `bypass`（安全默认：宁可多一层删除拦截）。
 *
 * 不在子态里（docWriting 为假）返回 undefined —— 那不是收尾。
 *
 * **工具表的还原由调用方在拿到返回值之前做**：还原要用的是旧状态里的 `toolsBeforePlan`
 * 快照，而返回的新状态已经把它清掉了（与 `cancelPlan` 同一条口径）。
 */
export function completeDocWrite(state: PlanState): DocWriteOutcome | undefined {
	if (state.phase !== "plan" || !state.docWriting) return undefined;
	const docPath = state.pendingDocPath;
	if (typeof docPath !== "string" || docPath === "") return undefined;
	const returnPhase: ReturnPhase = state.returnPhase === "dangerous" ? "dangerous" : "bypass";
	return {
		state: cleared(returnPhase),
		docMode: state.docMode ?? "execute-with-doc",
		docPath,
		returnPhase,
	};
}

/**
 * 退出 plan 时要还原的工具集：优先用进入时的快照，没有快照就退回当前活动工具
 * （`--tools` 在会话中途被改过时，尊重新的加载结果比还原旧快照更合理）。
 */
export function restoredToolSet(state: PlanState, activeTools: readonly string[]): string[] {
	return state.toolsBeforePlan ? [...state.toolsBeforePlan] : [...activeTools];
}

// =============================================================================
// bash 判定
// =============================================================================

export interface BashVerdict {
	ok: boolean;
	/** 被拒的原因，会作为工具错误结果回给模型。 */
	reason?: string;
}

/** 一个简单命令：命令词 + 参数，以及它写到磁盘的重定向目标。 */
interface SimpleCommand {
	words: string[];
	writes: string[];
}

/**
 * 写完磁盘的命令词。只列**明确会改工作区**的；`npm run` / `make` 这类副作用取决于
 * 脚本内容的命令刻意不列（见文件头注释的取舍说明）。
 */
const WRITE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"install",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
	"patch",
	"sudo",
	"doas",
	"su",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"systemctl",
	"service",
	"launchctl",
	"vi",
	"vim",
	"nvim",
	"nano",
	"emacs",
	"code",
	"subl",
	"make",
]);

/** `git` 的写子命令；`git status/log/diff/show/branch -a` 等读操作不在表里。 */
const GIT_WRITE_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"push",
	"pull",
	"merge",
	"rebase",
	"reset",
	"checkout",
	"switch",
	"restore",
	"stash",
	"clean",
	"cherry-pick",
	"revert",
	"tag",
	"init",
	"clone",
	"rm",
	"mv",
	"apply",
	"am",
	"gc",
	"prune",
	"update-ref",
	"symbolic-ref",
	"worktree",
	"submodule",
]);

/** 包管理器的写子命令。 */
const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun", "pip", "pip3", "poetry", "gem", "cargo", "go", "composer", "brew"]);
const PACKAGE_WRITE_SUBCOMMANDS = new Set([
	"install",
	"i",
	"add",
	"remove",
	"rm",
	"uninstall",
	"ci",
	"link",
	"publish",
	"update",
	"upgrade",
	"get",
	"dlv",
]);

/** 系统包管理器：几乎每个子命令都会改系统。 */
const SYSTEM_PACKAGE_MANAGERS = new Set(["apt", "apt-get", "dnf", "yum", "apk", "pacman", "port", "macports"]);

/** 任何命令带上这些参数都算写操作。 */
const WRITE_FLAGS = new Set(["--fix", "--write", "--in-place", "--replace"]);

/**
 * 写了也不算改工作区的目标：`cmd 2>/dev/null` 是模型的口头禅，拦它纯属噪音。
 * 只列真正的黑洞设备，任何真实路径（包括 `/tmp/x`）都不在内。
 */
const HARMLESS_WRITE_TARGETS = new Set([
	"/dev/null",
	"/dev/stderr",
	"/dev/stdout",
	"/dev/tty",
	"/dev/zero",
	"nul",
]);

/** 会被当作透明前缀跳过的包装命令（`sudo -u root rm -rf x` 的 `rm` 也要认出来）。 */
const WRAPPER_COMMANDS = new Set(["env", "command", "nohup", "time", "nice", "xargs", "builtin", "exec"]);

/**
 * 判断一条 bash 命令在 plan 阶段是否允许执行。
 * 返回 `{ ok: false, reason }` 时调用方应把 reason 作为工具错误结果回给模型。
 */
export function inspectBashCommand(command: string): BashVerdict {
	const scanned = stripHeredocBodies(command);
	for (const simple of splitSimpleCommands(scanned)) {
		const writes = simple.writes.filter((target) => !HARMLESS_WRITE_TARGETS.has(target));
		if (writes.length > 0) {
			return blocked(`重定向写入到 ${writes.map(quote).join(", ")}`);
		}
		const verdict = inspectSimpleCommand(simple);
		if (!verdict.ok) return verdict;
	}
	return { ok: true };
}

function inspectSimpleCommand(simple: SimpleCommand): BashVerdict {
	const { head, args } = unwrap(simple.words);
	if (!head) return { ok: true };

	for (const arg of args) {
		if (!WRITE_FLAGS.has(arg)) continue;
		return blocked(`命令 \`${head}\` 带写参数 ${arg}`);
	}

	if (WRITE_COMMANDS.has(head)) {
		if (head === "systemctl" || head === "service" || head === "launchctl") {
			const action = args.find((arg) => !arg.startsWith("-"));
			if (!action || action === "status" || action === "show" || action === "list-units" || action === "is-active") {
				return { ok: true };
			}
			return blocked(`命令 \`${head} ${action}\``);
		}
		// `make --dry-run` / `-n` 只打印要跑什么，不改任何东西
		if (head === "make" && args.some((arg) => arg === "--dry-run" || arg === "--just-print" || arg === "-n")) {
			return { ok: true };
		}
		return blocked(`命令 \`${head}\``);
	}

	if (head === "git") {
		const sub = args.find((arg) => !arg.startsWith("-"));
		if (!sub || !GIT_WRITE_SUBCOMMANDS.has(sub)) return { ok: true };
		// `git branch -a` / `git config --get` 是读操作，明确放行；没带这些开关的写子命令不在 git 的写表里。
		return blocked(`命令 \`git ${sub}\``);
	}

	if (PACKAGE_MANAGERS.has(head)) {
		const sub = args.find((arg) => !arg.startsWith("-"));
		if (!sub || !PACKAGE_WRITE_SUBCOMMANDS.has(sub)) return { ok: true };
		return blocked(`命令 \`${head} ${sub}\``);
	}

	if (SYSTEM_PACKAGE_MANAGERS.has(head)) return blocked(`命令 \`${head}\``);

	// `sed` / `perl` / `awk` 只在带原地编辑开关时算写
	if (head === "sed" || head === "perl") {
		if (args.some((arg) => arg === "-i" || arg.startsWith("-i.") || arg === "--in-place")) {
			return blocked(`命令 \`${head} -i\``);
		}
	}

	// `find … -delete` / `-exec rm` 这类写操作挂在参数上
	if (head === "find" && args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir")) {
		return blocked("命令 `find` 带写动作（-delete / -exec）");
	}

	// `truncate` 之类已在上表；这里兜住 `>| file` 之外的少见形状不额外处理。

	return { ok: true };
}

/** 跳过 `FOO=bar` 赋值与 `env`/`sudo` 之类包装命令，拿到真正的命令词与它的参数。 */
function unwrap(words: readonly string[]): { head: string; args: string[] } {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPER_COMMANDS.has(word)) {
			index += 1;
			continue;
		}
		// 包装命令自己的开关（`nice -n 10 rm`）跳过
		if (word.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const head = words[index]?.split("/").pop() ?? "";
	return { head, args: words.slice(index + 1) };
}

function blocked(reason: string): BashVerdict {
	return { ok: false, reason: `plan 阶段不执行写操作：${reason}` };
}

function quote(text: string): string {
	return /[\s"'`$]/.test(text) ? `"${text}"` : text;
}

/**
 * 按 shell 的简单命令边界切开，并做引号 / 转义感知。
 *
 * 已知取舍：双引号内的 `$(...)` 命令替换被当成普通文本（不切开），因为常见的
 * `echo "…" > file` 里 `>` 在引号外、已经被写重定向那条规则拦住了，为了它把引号内
 * 也拆开只会引入更多误判。
 */
export function splitSimpleCommands(command: string): SimpleCommand[] {
	const segments: SimpleCommand[] = [];
	let words: string[] = [];
	let writes: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: '"' | "'" | null = null;
	/** 刚扫到的重定向：下一个词是它的目标，不是普通参数。 */
	let redirect: "write" | "read" | "dup" | null = null;

	// 只有真的推出去一个词才清掉「等重定向目标」的状态：`>  out.txt` 这种
	// 运算符与目标之间有空格时，空格处的 pushToken() 不能把状态提前清掉。
	const pushToken = () => {
		if (!hasToken) return;
		if (redirect === "write") writes.push(token);
		else if (redirect === null) words.push(token);
		// read / dup 的目标既不是参数也不是写入
		token = "";
		hasToken = false;
		redirect = null;
	};

	const endSegment = () => {
		pushToken();
		if (words.length > 0 || writes.length > 0) segments.push({ words, writes });
		words = [];
		writes = [];
		redirect = null;
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;

		if (quote === "'") {
			if (char === "'") quote = null;
			else token += char;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") {
				const next = command[index + 1];
				if (next !== undefined && '"\\$`'.includes(next)) {
					token += next;
					index += 1;
				} else {
					token += char;
				}
			} else if (char === '"') {
				quote = null;
			} else {
				token += char;
			}
			continue;
		}

		if (char === "\\") {
			const next = command[index + 1];
			if (next !== undefined) {
				token += next;
				hasToken = true;
				index += 1;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasToken = true;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "\n") {
			endSegment();
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			pushToken();
			continue;
		}
		if (char === ">" || char === "<") {
			// `2> f` 的数字前缀是文件描述符，不是命令词
			if (hasToken && /^\d+$/.test(token)) {
				token = "";
				hasToken = false;
			}
			while (command[index + 1] === char) index += 1;
			const dup = command[index + 1] === "&";
			if (dup) index += 1;
			redirect = char === ">" ? (dup ? "dup" : "write") : dup ? "dup" : "read";
			continue;
		}

		token += char;
		hasToken = true;
	}
	endSegment();

	return segments;
}

/**
 * 把 heredoc 正文换成空行（保留行结构），免得「读一段脚本」里的写命令被当成真的要执行。
 * 找不到结束分隔符时**原样返回**：宁可保留正文继续扫（偏保守），也不要因为解析不全而漏判。
 */
export function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const heredoc = findHeredoc(line);
		kept.push(line);
		if (!heredoc) continue;

		const { delimiter, stripTabs } = heredoc;
		let end = index + 1;
		for (; end < lines.length; end += 1) {
			const candidate = lines[end]!;
			const body = stripTabs ? candidate.replace(/^\t+/, "") : candidate;
			if (body.trimEnd() === delimiter) break;
			kept.push("");
		}
		if (end >= lines.length) return command; // 没有结束符：整段原样返回
		kept.push(lines[end]!);
		index = end;
	}

	return kept.join("\n");
}

/** 在一行里找 `<<DELIM` / `<<-DELIM` / `<<'DELIM'`，返回分隔符。 */
function findHeredoc(line: string): { delimiter: string; stripTabs: boolean } | undefined {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char !== "<" || line[index + 1] !== "<") continue;
		if (line[index + 2] === "<") {
			index += 2; // here-string：没有正文
			continue;
		}
		let cursor = index + 2;
		const stripTabs = line[cursor] === "-";
		if (stripTabs) cursor += 1;
		while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
		const delimiter = readDelimiter(line, cursor);
		if (delimiter) return { delimiter, stripTabs };
		index = cursor;
	}
	return undefined;
}

function readDelimiter(line: string, start: number): string | undefined {
	const quote = line[start];
	if (quote === "'" || quote === '"') {
		const end = line.indexOf(quote, start + 1);
		if (end === -1) return undefined;
		const value = line.slice(start + 1, end);
		return value.length > 0 ? value : undefined;
	}
	const match = /^[^\s;&|<>()]+/.exec(line.slice(start));
	return match ? match[0] : undefined;
}
