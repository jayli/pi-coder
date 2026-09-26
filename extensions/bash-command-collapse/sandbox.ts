/**
 * Seatbelt（`sandbox-exec`）能力边界 —— 纯逻辑，无 IO、无 pi 依赖。
 *
 * ## 为什么是能力边界而不是黑名单
 *
 * 2026-09-23 的两次误删事故证明：枚举"坏的形状"（`rm -rf /`、`path.dirname(x ?? "/tmp")`）
 * 永远有漏网之鱼，因为坏形状是无穷的。Codex 从不弹确认框也从不误删全局文件，靠的不是
 * 更长的黑名单，而是**把强制点交给操作系统**：每条命令都在 seatbelt / landlock 沙箱里跑。
 * 本实现把强制点收窄到**删除**上（两次事故的损失面全是删除）：边界外的 `unlink` 被内核
 * 直接 `EPERM` 拒绝，写入则不限制（见下面「边界」一节）。
 *
 * 于是"确认"只在该出现的时候出现：正常操作（边界内删除、任何写入）→ 一次都不弹；
 * 越界删除 → 命令先失败，用户明确批准后才带着批准的范围**在沙箱内**重跑。这是 fail-closed ——
 * 枚举之外的洞不存在，因为根本不枚举。
 *
 * 本模块只负责**生成 profile 与判定边界**，真正执行在 `bash-command-collapse.ts`。
 *
 * ## 边界（用户 2026-09-24 定，同日收窄到「只管删除」）
 *
 * - **写入**：不限制。`echo x > ~/.zshrc` 这类边界外的写直接放行、不弹框 ——
 *   用户定的口径是「写入目标在可写边界之外不需要提醒」。
 * - **删除**：只有项目目录（`cwd`）+ 临时目录（`/tmp`、`/private/tmp`、`/var/folders`、`/var/tmp`）
 *   + 可再生缓存（`SAFE_CACHE_HOME_DIRS`）+ `PI_SANDBOX_EXTRA_WRITE` 里显式列出的路径
 *   **之内**才放行；边界外的 `unlink` 被内核 `EPERM` 拒绝，然后才弹一次确认。
 *   两次事故的损失面（`~/.zshrc`、`~/.pi/agent/sessions`、`~/.claude`）全是**删除**造成的，
 *   所以强制点就落在删除上。
 * - **读**：不限制。Codex 的 `workspace-write` 同样只管写不管读；限制读会打断
 *   `cat ~/.zshrc` 这类完全正常的排查动作。
 * - **网络**：全放行。本机的 npm / git / 网关流量都依赖出站，而风险面是文件删除不是网络。
 *
 * ## 三档授权（用户 2026-09-24 定，同日新增「永不删除」档）
 *
 * 边界外的删除按**目标路径**分三档：
 *
 * - **永不删除**（`NEVER_DELETE_HOME_FILES` / `NEVER_DELETE_HOME_DIRS`）：身份 / 凭据
 *   （`~/.zshrc`、`~/.ssh`、`~/.gnupg`…）。**不弹框、无任何放行选项**，
 *   白名单 / 会话豁免 / `PI_SANDBOX_EXTRA_WRITE` 都压不过（内核 deny 行在 allow 行之后）。
 *   2026-09-23 第二次事故删掉的 `~/.zshrc`、`~/.gitconfig`、`~/.zprofile` 就在这一档。
 *   用户 2026-09-25 把 `~/.config`、`~/.pi`、`~/.claude`、`~/.codex` 移出这一档 ——
 *   它们是**工具状态目录**（含 lock、缓存、会话日志等日常要清理的东西），不是凭据，
 *   应当走「弹框 + 可记住目录」那一档。
 * - **危险路径**（`DANGEROUS_ROOTS` + `~/Library` + 任何一级是 `.git`/`.hg`/`.svn`）：
 *   每次删除都问，只支持**会话级**豁免（重启 pi 后恢复）。这是 unix 系统根、
 *   bin、应用程序安装目录 —— 删错难恢复，但不是凭据。
 * - **普通路径**（边界外但不在上面两档）：问一次，同意后把**目录范围**写进
 *   `~/.pi/agent/sandbox-allowlist.json`，以后（含 headless）都不再问。
 *
 * 记住一个目录 = 把它加进 profile 的 `(allow file-write-unlink (subpath …))`，
 * 所以删除在沙箱**内**就成功了，命令的其余部分仍被沙箱管着 —— 授权范围恰好等于
 * 「这个目录的删除能力」，一分不多。这也是为什么常见路径**零弹框零重跑**：
 * profile 在命令执行前就已经带上了白名单根。
 *
 * ## 一个必须知道的代价：rename 也走 unlink
 *
 * seatbelt **没有** `file-write-rename` 这个操作（实测 `(allow file-write-rename)` 报
 * `unbound variable`），`rename(2)` 在沙箱眼里就是对源路径的一次 `file-write-unlink`。
 * 所以边界外这些操作会一并被拦，尽管它们的意图是「写」而不是「删」：
 *
 * - `sed -i '' 's/a/b/' ~/.some.conf` —— 原子替换 = 写临时文件 + rename 覆盖原文件
 * - `mv ~/.a ~/.b` —— 源在边界外
 * - 在边界外的仓库里 `git init` / `git commit` —— git 靠 `*.lock` + rename 落盘
 *
 * 这不是漏洞而是删除语义的必然：原子替换确实会让原来那个 inode 消失。相比改动前
 * （边界外**所有**写都被拦）这是严格放宽，没有任何操作从「能用」变成「不能用」。
 * 但「永不删除」档是例外：`sed -i '' ~/.zshrc` 这类对配置文件的**原地改写**也会被
 * 内核拦下（rename 走 unlink）—— 这正是用户要的「永不删除」强度，代价是改配置得
 * 自己在终端做，或 `PI_SANDBOX=off` 整体关掉这一层。
 *
 * `sandbox-exec` 被 Apple 标记为 deprecated，但在 macOS 26.5.1 上实测可用
 * （边界外 `echo >` 成功、边界外 `rm` 得到 `Operation not permitted` 且文件仍在、
 * 边界内 `rm` 正常删除、`curl` 出站 200）。
 */

import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

/**
 * 可写根集合构成的边界。`cwd` 与 `extraWrites` 都应是已解析的绝对路径。
 *
 * 名字里的 "write" 是历史沿用：自 2026-09-24 起这道边界**只约束删除**
 * （seatbelt 的 `file-write-unlink`），写入本身不限制。
 */
export interface WriteBoundary {
	readonly cwd: string;
	readonly extraWrites: readonly string[];
}

/**
 * 临时目录根。系统托管、自动清理、不含用户数据，所以算"安全沙箱目录"的一部分。
 *
 * `/var/folders` 是 macOS 真正的 `$TMPDIR`：node / git / npm / python3 都往那里写临时文件，
 * 不放行会让大量正常命令失败。`/private/...` 是它们的 realpath 形式，两种拼写都要在表里
 * （与 `destructive-guard` 的 `TEMP_ROOTS` 同一套理由）。
 *
 * `/var/tmp` 是 macOS 自带 **bash 3.2** 的 heredoc 临时目录，而且**编译期写死**：
 * `strings /bin/bash` 只含 `/var/tmp/` 与 `sh-thd`，`TMPDIR=/tmp`、`TMPDIR=<项目目录>`、
 * `env -u TMPDIR` 全部无效（实测内层 `$TMPDIR` 已是新值，文件仍落 `/private/var/tmp/sh-thd-*`）。
 * bash 3.2 的 heredoc 实现必须先建临时文件再 unlink（delete-on-open），不放行这个根，
 * **沙箱内任何 heredoc 都 100% 失败**，还会每次泄漏一个 `sh-thd-*`。用户口径：
 * `/var/tmp` 与 `/tmp` 同级，「怎么折腾都没事」。注意它比 `/tmp` 更「持久」——
 * 本机没有 `/etc/periodic` 也没有 periodic LaunchDaemon，`/private/var/tmp` 里确有数月前的条目。
 */
export const TEMP_WRITE_ROOTS: readonly string[] = [
	"/tmp",
	"/private/tmp",
	"/var/folders",
	"/private/var/folders",
	"/var/tmp",
	"/private/var/tmp",
];

/**
 * 危险路径：每次删除都必问，只支持会话级豁免。
 *
 * 口径（用户 2026-09-24 选的「窄枚举」）：unix 重要系统根目录 + bin +
 * 应用程序安装目录。`/usr/local` 与 `/opt/homebrew` 是包管理器前缀
 * （`brew uninstall` / `npm -g` 的地盘），单列出来是因为它们比 `/usr` 更常被
 * 正常操作碰到，但删错了同样难恢复。
 *
 * home 下的身份 / 凭据 / 配置目录已升入「永不删除」档（`NEVER_DELETE_HOME_DIRS`），
 * 这张表的 home 部分只剩 `~/Library`。
 *
 * `/private/...` 是 macOS 的 realpath 形式（`/etc` → `/private/etc`），两种拼写都要在表里 ——
 * 与 `TEMP_WRITE_ROOTS` 同一套理由。注意 `/private/tmp` 与 `/private/var/folders`
 * 虽然在 `/private` 下，但它们在**可删边界内**，根本走不到危险判定这一步
 * （`classifyOutsidePaths` 先判边界）。
 *
 * ## 子树危险 vs 仅自身危险
 *
 * 这两张表的区分是整个名单的关键，弄反了功能就废了：
 *
 * - **子树危险**（`DANGEROUS_ROOTS` + `DANGEROUS_HOME_DIRS`）：它**与它下面的一切**都危险。
 *   `/usr/local/bin/tsc` 危险，因为 `/usr` 在表里。
 * - **仅自身危险**（`DANGEROUS_EXACT`）：只有它自己危险，它的子路径要**单独判**。
 *   `$HOME` 在这一档 —— 删掉整个 home 是灾难，但 `~/Downloads` 是普通目录，该走
 *   「问一次就记住」那一档。把 `$HOME` 放进子树表会让 home 下**所有**路径都变成
 *   危险，普通目录白名单就永远不会生效了。`/Users` 同理。
 *
 * 身份 / 凭据 / 手写配置已升入「永不删除」档（`NEVER_DELETE_*`），不再走这张表。
 */
export const DANGEROUS_ROOTS: readonly string[] = [
	"/System",
	"/Library",
	"/Applications",
	"/bin",
	"/sbin",
	"/usr",
	"/opt",
	"/etc",
	"/private",
	"/var",
	"/Volumes",
	"/cores",
	"/dev",
];

/**
 * 仅**自身**危险的根：删掉它是灾难，但它的子路径要单独判。
 *
 * `/` 在这里而不是在 `DANGEROUS_ROOTS` 里，是因为子树语义对 `/` 没有意义
 * （所有绝对路径都在它下面）；`/Users` 在这里是因为子树语义会把每个用户的 home
 * 都判成危险，而自己的 home 已经由 `$HOME`（运行时注入）单独管了。
 */
export const DANGEROUS_EXACT: readonly string[] = ["/", "/Users"];

/**
 * `$HOME` 下「与配置项有关」的目录，**每次必问、可会话豁免**那一档。
 *
 * 凭据 / 身份类目录（`.ssh`、`.gnupg`、`.aws`…）在「永不删除」档
 * （`NEVER_DELETE_HOME_DIRS`），这里只剩 `~/Library` ——
 * macOS 应用偏好与 Application Support 的所在，删错难恢复但不是凭据，仍走必问可豁免。
 *
 * `~/.config`、`~/.pi`、`~/.claude`、`~/.codex` **不在这一档也不在永不删除档**
 * （用户 2026-09-25 定）：它们落到「普通边界外」档 —— 问一次，同意后可永久记住目录。
 *
 * 注意 `~/Library/Caches`、`~/Library/Developer/Xcode/DerivedData` 在**可删边界内**
 * （`SAFE_CACHE_HOME_DIRS`），`classifyOutsidePaths` 先判边界，走不到这里。
 */
export const DANGEROUS_HOME_DIRS: readonly string[] = ["Library"];

/**
 * 「永不删除」档：删了补不回的身份 / 凭据 / 手写配置。内核级拦死，不弹框、
 * 无任何放行选项（`Allow once` / `Allow for this session` / 白名单 / extraWrites
 * 都压不过）。用户 2026-09-24 定的口径：只列**身份 / 凭据 / 手写配置**，
 * 缓存类 dotfile（`.cache`、`.npm`、`.dartServer`…）一律不列。
 *
 * 用户 2026-09-25 进一步收窄：`~/.config`、`~/.pi`、`~/.claude`、`~/.codex` 移出本档
 * （它们是工具状态目录，日常要清理 lock / 缓存 / 会话日志），落到「普通边界外」档 ——
 * 弹三选项框，`Allow for this session（并记住该目录）` 后不再问。
 *
 * 与「危险必问」档的区别：危险档是「能删但要明确同意」，这一档是「不给删」。
 * 2026-09-23 第二次事故删掉的 `~/.zshrc`、`~/.gitconfig`、`~/.zprofile` 就在这一档。
 *
 * 只列 **home 一级**（`~/.zshrc`），不递归 —— `~/projects/.zshrc` 是项目文件，
 * 不该按永不删除处理。
 *
 * 2026-09-25 补了一批**本机尚未出现、但按惯例同样是身份 / 凭据 / 手写配置**的通用名
 * （`.bash_history`、`.hgrc`、`.envrc`、`.tool-versions`、`.yarnrc`、`.bunfig.toml`、
 * `.boto`、`.s3cfg`…）：名单是**预防性**的，等文件出现再补就晚了 —— 事故当天被删的
 * `~/.zprofile` 同样是「本机只有一个」的文件。
 */
export const NEVER_DELETE_HOME_FILES: readonly string[] = [
	// shell 启动项
	".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout",
	".bashrc", ".bash_profile", ".bash_login", ".bash_logout",
	".profile", ".cshrc", ".login", ".hushlogin",
	// git / VCS
	".gitconfig", ".git-credentials", ".gitattributes", ".gitignore", ".hgrc",
	// 凭据
	".netrc", ".npmrc", ".pgpass", ".my.cnf", ".pypirc", ".vault-token", ".terraformrc",
	".boto", ".s3cfg",
	// shell / 工具配置
	".inputrc", ".editorconfig", ".tmux.conf", ".screenrc", ".vimrc",
	".curlrc", ".wgetrc", ".gemrc", ".irbrc", ".pryrc", ".pythonrc",
	".Rprofile", ".Renviron", ".condarc",
	// 版本 / 包管理器的手写配置
	".tool-versions", ".yarnrc", ".yarnrc.yml", ".bunfig.toml",
	// direnv（常含导出到环境的密钥）
	".envrc",
	// AI / agent
	".claude.json",
	// 环境
	".env",
	// shell 历史：丢了补不回，且常含临时敲进去的 token
	".bash_history",
];

/**
 * 「永不删除」档的目录（子树语义）：`~/.ssh/id_rsa`、`~/.aws/credentials` 都拦。
 *
 * **刻意不列**（用户 2026-09-25）：`~/.config`、`~/.pi`、`~/.claude`、`~/.codex`。
 * 这四个是**工具状态目录**，里面既有手写配置也有大量日常要清理的派生物
 * （`trust.json.lock`、`settings.json.lock`、缓存、会话日志）—— 整棵子树不给删，
 * 连 pi 自己清理 stale lock 都会被内核 EPERM 拦死（实测：`pi update --extensions`
 * 因此退出码 1）。它们走「普通边界外」档：弹框、可记住目录、记住后不再问。
 *
 * 代价说清楚：`~/.pi/agent/extensions`、`~/.pi/agent/AGENTS.md`、`sessions/`、
 * `rewind/`、`sandbox-allowlist.json` 也在这四个子树里，所以守卫的自保护从
 * 「内核无条件拦死」降级为「弹框 + 用户明确同意」。项目目录豁免（cwd 在其下时
 * 不判 blocked）本来就是既有口径，不受影响。
 *
 * **名字里可以带斜杠**（`neverDeletePaths` 只是把名字拼到 home 下再解析），所以
 * 凭据下沉到两级的工具用嵌套条目精确点名：`.config/gh`（`hosts.yml` 存 GitHub token）、
 * `.config/gcloud`（`credentials.db` / `application_default_credentials.json`）。
 * 这是 2026-09-25「`~/.config` 整棵子树移出本档」之后唯一能把 `~/.config` 下真凭据
 * 捞回来的办法 —— 代价是 `isSafeAllowlistRoot` 的祖先闸必须只对**危险档**生效，
 * 否则 `~/.config` 会因为「是 `~/.config/gh` 的祖先」而永远记不住（用户 2026-09-25 选）。
 * 安全性不受影响：内核 deny 行在 allow 行之后无条件收回，记住 `~/.config` 也交不出
 * `~/.config/gh`；`classifyOutsidePaths` 同样先判 blocked 再判白名单。
 */
export const NEVER_DELETE_HOME_DIRS: readonly string[] = [
	// 凭据 / 身份
	".ssh", ".gnupg", ".aws", ".kube", ".docker",
	// 云厂商 CLI 的凭据与配置
	".azure", ".gcloud", ".terraform.d", ".helm", ".minikube",
	// 密码库
	".password-store",
	// 凭据下沉到 ~/.config 两级的工具（嵌套条目，见上面 docstring）
	".config/gh", ".config/gcloud",
	// AI / agent
	".agents", ".copilot", ".iflow", ".lingma",
	".aone_copilot", ".aone-copilot-preview", ".codex-claude-proxy", ".cursor-tutor",
];

/**
 * 可再生缓存：删了能干净重建，进**可删边界**（静默放行，不弹框）。
 * 用户 2026-09-24 定的口径。home 相对路径，`writableRoots` 解析成绝对路径。
 *
 * 明确**不列**的：`Library/pnpm/store`（pi 本体安装位置）、`.deno`（含 bin）、
 * `.nvm`（含已装 Node 版本）、`.gem` / `.bundle`（小且混合）—— 删了不能干净重建。
 */
export const SAFE_CACHE_HOME_DIRS: readonly string[] = [
	".cache",
	".npm",
	".gradle/caches",
	".m2/repository",
	".cargo/registry",
	".bun/install/cache",
	".node-gyp",
	".Trash",
	"Library/Caches",
	"Library/Developer/Xcode/DerivedData",
];

/** 版本控制存储的目录名：路径里**任何一级**是它就算危险（删掉是丢只此一份的历史）。 */
export const VCS_DIR_NAMES: readonly string[] = [".git", ".hg", ".svn"];

/**
 * 允许写进白名单的最浅深度（绝对路径的组件数）。
 *
 * `/` = 0、`/Users` = 1、`/Users/bachi` = 2、`/Users/bachi/Downloads` = 3。
 * 卡 3 是为了让「记父目录」这个动作**永远不可能**退化成记下 `$HOME` 或更浅的东西 ——
 * `$HOME`（`/Users/bachi`，2 个组件）本身就在危险名单里，这里是第二道保险
 * （名单将来被改动时仍然成立）。而 `$HOME` 的直接子目录（`~/Downloads`，3 个组件）
 * 刚好过闸 —— 这正是「删 ~/Downloads/x 记住 ~/Downloads」这个核心用例需要的宽度。
 */
export const MIN_ALLOWLIST_DEPTH = 3;

/**
 * 沙箱拒绝删除时，命令输出里的特征串。
 *
 * seatbelt 的拒绝是 `EPERM`（`Operation not permitted`）。刻意**不**匹配
 * `Permission denied` —— 那是 `EACCES`，来自文件权限位而不是沙箱，拿它当升级信号
 * 会把"这个文件本来就没权限"误报成"沙箱拦的"。
 */
const SANDBOX_DENIAL_PATTERNS: readonly RegExp[] = [/Operation not permitted/i, /\bEPERM\b/];

/** 升级确认框的固定标题（与 `destructive-guard` 一样，标题不随命令变化）。 */
export const ESCALATION_TITLE = "沙箱拦截了对边界外文件的删除";

/**
 * 命令输出是否像"被沙箱拒绝删除"。
 *
 * 只在命令**已经失败**的前提下调用才有意义：成功命令的输出里出现这些字样
 * （比如 `grep "Operation not permitted"`）不该触发升级。
 */
export function looksLikeSandboxDenial(output: string): boolean {
	if (!output) return false;
	return SANDBOX_DENIAL_PATTERNS.some((re) => re.test(output));
}

/**
 * 解析 `PI_SANDBOX_EXTRA_WRITE`：冒号分隔（同 `PATH`），逐项展开 `~` 并解析成绝对路径。
 *
 * 空项与纯空白项丢掉。相对路径按 `cwd` 解析 —— 配置里写 `../shared` 是合理的意图，
 * 不该被静默忽略。
 */
export function parseExtraWrites(raw: string | undefined, cwd: string): string[] {
	if (!raw) return [];
	const out: string[] = [];
	for (const item of raw.split(":")) {
		const trimmed = item.trim();
		if (!trimmed) continue;
		out.push(resolveAgainst(trimmed, cwd));
	}
	return out;
}

/** 展开 `~` 并把相对路径按 `cwd` 解析成绝对路径。 */
export function resolveAgainst(target: string, cwd: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolvePath(homedir(), target.slice(2));
	if (isAbsolute(target)) return resolvePath(target);
	return resolvePath(cwd, target);
}

/** 构造边界对象。`extraWrites` 会被解析成绝对路径。 */
export function makeBoundary(cwd: string, extraWrites: readonly string[] = []): WriteBoundary {
	const resolvedCwd = resolvePath(cwd || process.cwd());
	return {
		cwd: resolvedCwd,
		extraWrites: extraWrites.map((p) => resolveAgainst(p, resolvedCwd)),
	};
}

/**
 * 全部可写根：项目目录 + 临时目录 + 可再生缓存 + 显式额外路径。
 *
 * 可再生缓存（`SAFE_CACHE_HOME_DIRS`）按 `homedir()` 解析成绝对路径 ——
 * 与 `makeBoundary` 用同一个 `homedir()`，口径一致。
 */
export function writableRoots(boundary: WriteBoundary): string[] {
	const home = stripTrailingSlash(homedir());
	const cacheRoots = SAFE_CACHE_HOME_DIRS.map((rel) => `${home}/${rel}`);
	return [boundary.cwd, ...TEMP_WRITE_ROOTS, ...cacheRoots, ...boundary.extraWrites];
}

/**
 * 「永不删除」路径的绝对形式（home 一级文件 + 目录子树根 + 嵌套条目如 `.config/gh`）。
 *
 * 名字里带斜杠的条目同样成立：拼到 home 下再 `resolvePath`，得到两级绝对路径。
 *
 * 供三处共用：`classifyOutsidePaths` 的 `blocked` 档、`buildSeatbeltProfile` 的
 * deny 行、`isSafeAllowlistRoot` 的白名单闸 —— 同一张表，口径不会漂移。
 *
 * `home` 可注入（与 `dangerousRoots(env)` 同一口径），不传则用 `homedir()`。
 */
export function neverDeletePaths(home: string = homedir()): string[] {
	const base = stripTrailingSlash(resolvePath(home));
	return [...NEVER_DELETE_HOME_FILES, ...NEVER_DELETE_HOME_DIRS].map((name) =>
		stripTrailingSlash(resolvePath(`${base}/${name}`)),
	);
}

/**
 * 目标是不是「永不删除」路径：等于名单里某项，或在其子树下。
 *
 * 与 `dangerousReasonFor` 同一套双形态判定（词法 + realpath），所以
 * `~/link → ~/.ssh` 这类符号链接逃逸也拦得住。
 */
export function neverDeleteReasonFor(target: string, env: PathEnv): string | undefined {
	const roots = neverDeletePaths(env.home);
	const forms = [stripTrailingSlash(resolvePath(target))];
	const real = env.realpath?.(target);
	if (real) {
		const resolvedReal = stripTrailingSlash(resolvePath(real));
		if (!forms.includes(resolvedReal)) forms.push(resolvedReal);
	}
	for (const form of forms) {
		for (const root of roots) {
			if (form === root) return `${form} 是永不删除的身份/凭据/手写配置`;
			if (form.startsWith(`${root}/`)) return `${form} 在永不删除的 ${root} 下`;
		}
	}
	return undefined;
}

/**
 * 目标路径是否落在边界内（`target` 等于某个可写根，或在其子树下）。
 *
 * 边界内 = 可以直接删除；边界外 = 删除需要确认（bash 侧由内核 EPERM 强制）。
 *
 * 这是**白名单**判定：不在名单里就是外面，不需要枚举任何"危险路径"。
 * 比较前把两边都解析成绝对路径并去掉尾斜杠，避免 `/tmp/` 与 `/tmp` 判成两处。
 */
export function isPathInWriteBoundary(target: string, boundary: WriteBoundary): boolean {
	return isUnderRoots(target, writableRoots(boundary), boundary.cwd);
}

/** `target` 是否等于 `roots` 里的某一个，或在其子树下。两边都解析成绝对路径并去尾斜杠。 */
export function isUnderRoots(target: string, roots: readonly string[], cwd: string): boolean {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	return roots.some((root) => {
		const r = stripTrailingSlash(resolvePath(root));
		return resolved === r || resolved.startsWith(r + "/");
	});
}

/** 路径分类需要的环境。`realpath` / `isDirectory` 是 IO，由调用方注入，本模块保持纯逻辑。 */
export interface PathEnv {
	readonly home: string;
	/** 解析符号链接。不传则只做词法判定（`~/link → /etc` 这类逃逸就看不见）。 */
	readonly realpath?: (path: string) => string | undefined;
	/** 目标是不是目录。不传则一律按文件处理（记父目录，范围更宽但受深度/危险规则约束）。 */
	readonly isDirectory?: (path: string) => boolean;
}

/**
 * 当前环境下的危险路径，分两档（见 `DANGEROUS_ROOTS` 文件头那段说明）。
 *
 * - `subtree`：它**与它下面的一切**都危险。
 * - `exact`：只有它自己危险，子路径要单独判（`$HOME`、`/`、`/Users`）。
 */
export interface DangerousTables {
	readonly subtree: readonly string[];
	readonly exact: readonly string[];
}

export function dangerousRoots(env: PathEnv): DangerousTables {
	const home = stripTrailingSlash(resolvePath(env.home));
	return {
		subtree: [...DANGEROUS_ROOTS, ...DANGEROUS_HOME_DIRS.map((name) => `${home}/${name}`)].map((p) =>
			stripTrailingSlash(resolvePath(p)),
		),
		exact: [...DANGEROUS_EXACT, home].map((p) => stripTrailingSlash(resolvePath(p))),
	};
}

/**
 * 目标为什么危险；不危险返回 `undefined`。
 *
 * 三类命中：
 * 1. 等于某个危险根，或在其子树下（`/usr/local/bin/tsc` → `/usr/local`）；
 * 2. 路径里**任何一级**是 `.git` / `.hg` / `.svn`（`~/projects/x/.git` 在哪个目录都危险）；
 * 3. 传了 `realpath` 时，符号链接解析后的形态命中 1 或 2（`~/link → /etc`）。
 *
 * 词法形态与 realpath 形态**都判**，取更危险的那个结论 —— 只判词法会漏掉链接逃逸，
 * 只判 realpath 会在目标已被删掉（realpath 失败）时漏掉。
 */
export function dangerousReasonFor(target: string, env: PathEnv): string | undefined {
	const tables = dangerousRoots(env);
	const forms = [stripTrailingSlash(resolvePath(target))];
	const real = env.realpath?.(target);
	if (real) {
		const resolvedReal = stripTrailingSlash(resolvePath(real));
		if (!forms.includes(resolvedReal)) forms.push(resolvedReal);
	}

	for (const form of forms) {
		for (const root of tables.exact) {
			if (form === root) return `${form} 本身就是受保护的危险路径`;
		}
		for (const root of tables.subtree) {
			if (form === root) return `${form} 本身就是受保护的危险路径`;
			if (form.startsWith(root + "/")) return `${form} 在危险路径 ${root} 下`;
		}
		const segments = form.split("/").filter(Boolean);
		const vcs = segments.find((s) => VCS_DIR_NAMES.includes(s));
		if (vcs) return `${form} 含版本控制存储 ${vcs}（删掉是丢只此一份的历史）`;
	}
	return undefined;
}

/**
 * 这个路径能不能作为白名单根持久化。
 *
 * 四道闸：组件数 ≥ `MIN_ALLOWLIST_DEPTH`、自身不危险、自身不是永不删除路径、
 * 且**不是任何危险路径的祖先**（记下 `$HOME` 就等于把 `~/Library` 一起交出去）。
 * 加载白名单时也跑这一遍，手改或损坏的 JSON 塞不进 `/`。
 *
 * 祖先闸**只对危险档生效**，不查永不删除档（用户 2026-09-25 选）：永不删除名单里
 * 有嵌套条目（`.config/gh`、`.config/gcloud`）之后，若祖先闸也查它，`~/.config` 会因
 * 「是 `~/.config/gh` 的祖先」而永远记不住，直接推翻「`~/.config` 是普通档、可记住」
 * 的决定。安全上无损失：内核 deny 行在 allow 行之后无条件收回永不删除子树，
 * `classifyOutsidePaths` 也先判 blocked 再判白名单 —— 记住 `~/.config` 交不出
 * `~/.config/gh`。危险档仍需祖先闸：危险根没有内核 deny 行兜底，白名单就是唯一防线。
 */
export function isSafeAllowlistRoot(path: string, env: PathEnv): boolean {
	const resolved = stripTrailingSlash(resolvePath(path));
	if (componentCount(resolved) < MIN_ALLOWLIST_DEPTH) return false;
	if (dangerousReasonFor(resolved, env)) return false;
	if (neverDeleteReasonFor(resolved, env)) return false;
	// 不能是任何危险路径的**祖先**：记下 `$HOME` 就等于把 `~/Library` 一起交出去。
	// 永不删除路径不在这里查 —— 见上面 docstring（嵌套条目与可记住的 ~/.config 冲突）。
	const tables = dangerousRoots(env);
	const all = [...tables.subtree, ...tables.exact];
	return !all.some((root) => root !== resolved && root.startsWith(resolved + "/"));
}

/** 绝对路径的组件数：`/` = 0，`/Users` = 1，`/Users/bachi` = 2。 */
export function componentCount(resolved: string): number {
	return resolved.split("/").filter(Boolean).length;
}

/**
 * 「记住这个删除」应该记多大范围。
 *
 * 目标是目录 → 记它自己（用户说的「这个目录是安全的」就是它）；
 * 目标是文件 → 记父目录（否则同目录删第二个文件还要再问一次，功能就白做了）。
 *
 * 但算出来的范围必须过 `isSafeAllowlistRoot`：过不了就**降级为只记精确路径**，
 * 精确路径也过不了就返回 `undefined`（什么都不记，只能走会话级豁免）。
 * 于是确认删 `~/.zshrc.bak` 只会记住那一个文件，绝不会记住 `$HOME`。
 */
export function memoryScopeFor(target: string, env: PathEnv, cwd = process.cwd()): string | undefined {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	const isDir = env.isDirectory?.(resolved) ?? false;
	const preferred = isDir ? resolved : parentOf(resolved);
	if (preferred && isSafeAllowlistRoot(preferred, env)) return preferred;
	if (isSafeAllowlistRoot(resolved, env)) return resolved;
	return undefined;
}

function parentOf(resolved: string): string | undefined {
	const idx = resolved.lastIndexOf("/");
	if (idx <= 0) return undefined;
	return resolved.slice(0, idx);
}

/**
 * `Allow for this session`（危险路径分支，旧名「本会话不再询问」）应该豁免多大范围。
 *
 * 与 `memoryScopeFor` 的区别：会话豁免**不落盘**、重启即失效，所以可以比持久白名单宽 ——
 * 允许落在危险子树根**之下**（比如 `~/Library/Foo`），这样用户豁免一次后，同一子目录里的
 * 兄弟文件本会话不再反复问（用户口径：「当前会话就不再弹框确认」）。但仍有一道硬闸：
 *
 * - 范围不能**本身是**某个危险根 / 永不删除路径（豁免了 `~/Library` 就等于把整个偏好目录交出去）；
 * - 范围不能是某个危险根的**祖先**（豁免了 `$HOME` 就等于把 `~/Library` 一起交出去）；
 * - 组件数 ≥ `MIN_ALLOWLIST_DEPTH`。
 *
 * 三条都过不了就退回**精确路径**（只豁免这一个目标）。于是豁免删 `~/Library/Foo/bar`
 * 会记下 `~/Library/Foo`，但豁免删 `~/Library/x.plist`（父目录是 `~/Library`，本身是危险根）
 * 只会记下 `~/Library/x.plist` 这一个文件。
 *
 * 注：永不删除路径（`~/.zshrc`、`~/.ssh`…）在 `classifyOutsidePaths` 里进 `blocked` 档，
 * 根本走不到会话豁免这一步 —— 硬闸的具体口径见 `isSafeSessionRoot`。
 */
export function sessionScopeFor(target: string, env: PathEnv, cwd = process.cwd()): string {
	const resolved = stripTrailingSlash(resolveAgainst(target, cwd));
	const isDir = env.isDirectory?.(resolved) ?? false;
	const preferred = isDir ? resolved : parentOf(resolved);
	if (preferred && isSafeSessionRoot(preferred, env)) return preferred;
	return resolved;
}

/**
 * 会话豁免范围能不能用：深度够、自身不是危险根 / 永不删除路径、也不是危险根的祖先。
 *
 * 与持久白名单不同，这里**允许**落在危险子树根之下（`~/Library/Foo` 在 `~/Library` 下）——
 * 会话豁免不落盘、重启即失效，宽一点是安全的，而且这正是 `Allow for this session` 的语义：
 * 豁免一次后同子目录的兄弟文件不再反复问。
 *
 * 永不删除路径没有豁免一说（blocked 档根本走不到这里），但为了口径一致仍把自身判定
 * 纳入硬闸 —— 将来调用方误用时不会静默交出 `~/.ssh`。祖先闸本来就只查危险档
 * （与 `isSafeAllowlistRoot` 2026-09-25 改后的口径一致）：永不删除名单有嵌套条目
 * （`.config/gh`），祖先闸查它会把 `~/.config` 的会话豁免一并废掉，而内核 deny 行本就
 * 拦死永不删除子树。
 *
 * 深度闸与持久白名单同宽：`$HOME` 的直接子目录（`~/Downloads`，2 个组件）放行，
 * 其余卡 `MIN_ALLOWLIST_DEPTH`。
 */
function isSafeSessionRoot(path: string, env: PathEnv): boolean {
	const resolved = stripTrailingSlash(resolvePath(path));
	if (componentCount(resolved) < MIN_ALLOWLIST_DEPTH) return false;
	// 永不删除是**子树**语义：它下面的一切都不能豁免（`~/.config/gh/foo` 也算，
	// 但 `~/.config/foo` 不算 —— ~/.config 自身自 2026-09-25 起是普通档）。
	if (neverDeleteReasonFor(resolved, env)) return false;
	const tables = dangerousRoots(env);
	const all = [...tables.subtree, ...tables.exact];
	for (const root of all) {
		if (resolved === root) return false; // 自身是危险根（豁免了 ~/Library 就等于交出整个偏好目录）
		if (root.startsWith(resolved + "/")) return false; // 是危险根的祖先（豁免了 $HOME 就等于交出 ~/Library）
	}
	return true;
}

/**
 * heredoc 临时文件失败的特征串（排除 1）。
 *
 * macOS 自带 bash 3.2 的 heredoc 实现必须先建临时文件再 unlink（delete-on-open），
 * 而该临时目录**编译期写死在 `/var/tmp`**（`strings /bin/bash` 只含 `/var/tmp/` 与 `sh-thd`，
 * `TMPDIR` 怎么改都无效）。`/var/tmp` 进可删边界后这条失败本身已消失，但保留这道排除：
 * 它不是删除用户数据，不该弹删除确认框。
 */
const HERE_DOCUMENT_RE = /here[\s-]*document/i;

/**
 * 行首 prog token 是 shell 或 `sandbox-exec` 时整行跳过（排除 2）。
 *
 * shell 自己报的 EPERM 是 **exec 失败**（setuid / platform binary，如 `/bin/ps`、`/usr/bin/top`），
 * 不是 unlink；bash 唯一会 unlink 的是 heredoc 临时文件，已由排除 1 覆盖。
 * `sandbox-exec: sandbox_apply: Operation not permitted` 是嵌套沙箱不可用，同样不是删除。
 * 带不带路径前缀都认（`bash:` 与 `/bin/bash:` 是同一个程序）。
 */
const SHELL_PROG_RE = /^(?:\/[\w./+-]+\/)?(bash|sh|zsh|dash|ksh|csh|tcsh|fish|sandbox-exec)$/i;

/**
 * 从**已失败**命令的输出里抽出被沙箱拦下的路径。
 *
 * 内核只给 `EPERM`，不会告诉你是谁拦的 —— 按目录记忆的前提就是能从 stderr 里认出路径。
 * 只扫含 `Operation not permitted` / `EPERM` 的行（成功命令的输出里出现这些字样不该触发）。
 *
 * ## 排除法，不是白名单（用户 2026-09-24 定）
 *
 * 曾考虑过「只认 `rm|rmdir|unlink|…` 这些程序名」的白名单，实测会**静默丢掉**三类真实
 * 删除形状 —— 恰是这套机制要拦的「脚本驱动的边界外删除」：
 *
 * - `PermissionError: [Errno 1] Operation not permitted: '/p'`（python3，路径在 EPERM **之后**
 *   且无 `cannot`，prog token 是 `PermissionError` 不是 `python3`，两条正则都够不着）
 * - `find: /p: Operation not permitted`（`find -delete` / `-exec rm`）
 * - `ln: /p: Operation not permitted`（`ln -sf` 覆盖 = unlink 目标）
 *
 * 白名单的本质是「枚举删除程序」，永远枚举不全。所以这里**保留兜底扫描**，只排除已知的
 * 误报源（覆盖面只增不减）。
 *
 * ## 逐行判定顺序
 *
 * 1. 不含 `Operation not permitted` / `EPERM` → 跳过
 * 2. **排除 1**：含 `here document` → 跳过该行（**逐行**，不是全局 ——
 *    `cat <<EOF …; rm /边界外` 这种 `;` 串联命令里，真删除的那一行仍会被抽出）
 * 3. **排除 2**：行首 prog 是 shell / `sandbox-exec` → 跳过该行
 * 4. `mv: rename A to B: …` / `sed: rename(A to B): …` → 取**源** A（unlink 落在源上）
 * 5. GNU 的 `rm: cannot remove 'X': …` / `unlink: cannot unlink 'X': …` → 取引号里的 X
 * 6. BSD 的 `rm: X: …` / `rmdir: X: …` → 取程序名后面那个 **单 token**（`(\S+?)`，
 *    不含空格 —— 旧的 `(.+?)` 会把 `find: /p/a: cannot unlink:` 的中段一起吃进来）
 * 7. **兜底**：行里所有看起来像绝对路径的 token（rvm 的 `errno=1` 形状、
 *    `ruby: … @ apply2files - /p`、`xargs: rm: /p`、node 的 `EPERM … unlink '/p'`、
 *    git 的 `unable to unlink '/p'` 全靠它）
 *
 * 4-6 抽不出东西时**不再 `continue`**，而是落到兜底 —— 旧实现的 `continue` 正是
 * `bash: line 0: /usr/bin/top` 返回空而非兜底抽取的原因。
 *
 * **抽不出任何路径时返回空数组**，调用方据此**不弹框**、原样返回失败输出并追加一行
 * `[沙箱]` 提示 —— 猜不出目标就不许进记忆逻辑，这是 `AGENTS.md`
 * 「Never derive a delete target」的同一口径。
 *
 * 抽错了也不会静默放行：弹框会把这些路径原样列给用户看，确认之前不会落盘。
 */
export function extractDeniedPaths(output: string): string[] {
	if (!output) return [];
	const found: string[] = [];
	/** 返回是否真的抽到了一个合法绝对路径（决定要不要继续往兜底走）。 */
	const push = (candidate: string | undefined): boolean => {
		const cleaned = cleanExtractedPath(candidate);
		if (!cleaned) return false;
		if (!found.includes(cleaned)) found.push(cleaned);
		return true;
	};

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!SANDBOX_DENIAL_PATTERNS.some((re) => re.test(line))) continue;
		if (HERE_DOCUMENT_RE.test(line)) continue; // 排除 1

		const prog = /^([\w.+-]+|\/[\w./+-]+):/.exec(line)?.[1];
		if (prog && SHELL_PROG_RE.test(prog)) continue; // 排除 2

		// rename A to B —— mv / sed -i / git 落 ref 都是这个形状，unlink 在源上
		const rename = /rename[\s(]+(.+?)\s+to\s+(.+?)[\s)]*[:：]?\s*(?:Operation not permitted|EPERM)/i.exec(line);
		if (rename?.[1] && push(rename[1])) continue;

		// GNU: cannot remove '/path': …
		const quoted = /cannot\s+\w+\s+'([^']+)'/.exec(line);
		if (quoted?.[1] && push(quoted[1])) continue;

		// BSD: prog: /path: Operation not permitted —— 捕获只取单 token，抽不出就落兜底
		const bsd = /^[\w./+-]+:\s*(\S+?)\s*[:：]\s*(?:Operation not permitted|EPERM)/i.exec(line);
		if (bsd?.[1] && push(bsd[1])) continue;

		// 兜底：行里所有绝对路径 token
		for (const token of line.split(/\s+/)) push(token);
	}
	return found;
}

/**
 * 去掉包裹的引号与首尾标点，只留下以 `/` 开头、长度 > 1 的绝对路径。
 *
 * 一次性剥掉首尾的空白 / 引号 / 标点：旧实现先剥引号再剥标点，对 `'…lock':`
 * 这种「引号在标点内侧」的形状会留下尾引号（抽成 `/p'`）。
 */
function cleanExtractedPath(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	const value = candidate.trim().replace(/^[\s'"`,;:]+|[\s'"`,;:]+$/g, "");
	if (!value.startsWith("/") || value.length <= 1) return undefined;
	return stripTrailingSlash(value);
}

/**
 * 从一条**整体成功**（退出码 0）的命令输出里，找出被掩盖的越界删除目标。
 *
 * 为什么需要：pi 内置 bash 只在退出码非零时 throw，而升级弹框挂在 `catch` 上。
 * 于是 `rm <越界> ; <任何成功的命令>` 这种形状里，内核照样 EPERM 拒了删除，
 * 但整条命令退出码 0 —— `catch` 走不到，拒绝被静默吞掉（实测事故：
 * `rm ~/.local/share/claude/versions/2.1.274 ; ls -la …`，没弹框也没提示）。
 *
 * 成功命令的输出不能只按字样判定 —— `grep "Operation not permitted" 日志`
 * 是查沙箱问题的常用操作，它的命中行与真实拒绝**形状完全相同**（连 `rm:`
 * 前缀都一样），按字样报就是误报。所以这里加两道过滤：
 *
 * 1. 只留**边界外且未被授权**的路径（`classifyOutsidePaths` 的 dangerous /
 *    ordinary 两档）。边界内的删除本来就成功，不该出现在这里；已授权的路径
 *    profile 里已放行，拦不住它的不是我们这层。`blocked`（永不删除档）也跳过：
 *    那一档没有任何授权出口，而本函数的产出正是「去授权」这个动作。
 * 2. 只留**磁盘上仍在**的路径。真实拒绝会把文件原样留下，所以「它还在」既是
 *    误报过滤（grep 命中的日志行里那个路径通常不存在），也是提示本身的语义
 *    前提 —— 说明文案要讲「文件仍在、可授权后删」，目标不存在时这句话是假的。
 *
 * 返回空数组 = 不需要追加任何说明。
 */
export function maskedDenialPaths(
	output: string,
	opts: {
		readonly boundary: WriteBoundary;
		readonly allowedRoots: readonly string[];
		readonly sessionRoots: readonly string[];
		readonly env: PathEnv;
		/** 目标是否仍在磁盘上（注入以便纯单测）。 */
		readonly exists: (path: string) => boolean;
	},
): string[] {
	if (!looksLikeSandboxDenial(output)) return [];
	const denied = extractDeniedPaths(output);
	if (denied.length === 0) return [];

	const classification = classifyOutsidePaths(denied, {
		boundary: opts.boundary,
		allowedRoots: opts.allowedRoots,
		sessionRoots: opts.sessionRoots,
		env: opts.env,
	});

	const authorizable = [...classification.dangerous.map((d) => d.path), ...classification.ordinary];
	return authorizable.filter((p) => opts.exists(p));
}

/** `classifyOutsidePaths` 的结果：五档互斥，调用方据此决定弹不弹、弹哪种。 */
export interface PathClassification {
	/** 永不删除 → 直接拒，不弹框、无任何放行选项。带命中原因。 */
	readonly blocked: ReadonlyArray<{ path: string; reason: string }>;
	/** 已被持久白名单或会话豁免覆盖 → 静默放行，不弹框。 */
	readonly covered: string[];
	/** 危险 → 每次必问，只能会话级豁免。带命中原因，弹框里要给人看。 */
	readonly dangerous: ReadonlyArray<{ path: string; reason: string }>;
	/** 普通边界外 → 问一次，同意后可永久记住。 */
	readonly ordinary: string[];
	/** 边界内 → 本来就能删，不该弹框（列出来只为让调用方能断言）。 */
	readonly inside: string[];
}

/**
 * 把一批删除目标分成五档。这是 bash 与 `apply_patch` 两条路线**共用**的判定核心，
 * 所以两边的口径不会漂移。
 *
 * 顺序很重要：
 *
 * 1. **永不删除**（`blocked`）最先判，且**先于边界** —— 否则 `PI_SANDBOX_EXTRA_WRITE=~/.ssh`
 *    或白名单里手塞了 `~/.ssh` 就能把凭据目录变成可删。但有一个例外：**项目目录
 *    （`boundary.cwd`）之下不判 blocked** —— 否则在 `~/.pi/agent/extensions/x` 这种
 *    本身就在永不删除目录里的项目干活时，删自己的文件会被全部拦死（项目目录
 *    按定义在可删边界内，这是既有口径）。
 * 2. 边界内直接放行（`/private/tmp` 在 `/private` 下但它在边界内；`~/.cache` 同理）。
 * 3. 再判已授权，最后才分危险 / 普通。
 *
 * 自动放行的口径是「**全部**命中」而不是「任一命中」：调用方只有在 `blocked`、
 * `dangerous` 与 `ordinary` 都为空时才能不弹框。否则 `rm 已授权目录 未授权目录`
 * 会因为前者被静默放行、后者跟着裸跑。
 */
export function classifyOutsidePaths(
	paths: readonly string[],
	opts: {
		readonly boundary: WriteBoundary;
		/** 持久白名单根（`sandbox-allowlist.json`）。 */
		readonly allowedRoots: readonly string[];
		/** 会话级豁免根（危险目录的 `Allow for this session`）。 */
		readonly sessionRoots: readonly string[];
		readonly env: PathEnv;
	},
): PathClassification {
	const blocked: Array<{ path: string; reason: string }> = [];
	const covered: string[] = [];
	const dangerous: Array<{ path: string; reason: string }> = [];
	const ordinary: string[] = [];
	const inside: string[] = [];
	const seen = new Set<string>();
	const cwd = stripTrailingSlash(resolvePath(opts.boundary.cwd));

	for (const raw of paths) {
		const resolved = stripTrailingSlash(resolveAgainst(raw, opts.boundary.cwd));
		if (seen.has(resolved)) continue;
		seen.add(resolved);

		// 项目目录之下不判永不删除（见上面顺序说明第 1 条）。
		const inProject = resolved === cwd || resolved.startsWith(`${cwd}/`);
		if (!inProject) {
			const neverReason = neverDeleteReasonFor(resolved, opts.env);
			if (neverReason) {
				blocked.push({ path: resolved, reason: neverReason });
				continue;
			}
		}

		if (isPathInWriteBoundary(resolved, opts.boundary)) {
			inside.push(resolved);
			continue;
		}
		// 会话豁免优先于危险判定：用户已经在本会话里明确说过「不再问」。
		if (isUnderRoots(resolved, opts.sessionRoots, opts.boundary.cwd)) {
			covered.push(resolved);
			continue;
		}
		if (isUnderRoots(resolved, opts.allowedRoots, opts.boundary.cwd)) {
			covered.push(resolved);
			continue;
		}
		const reason = dangerousReasonFor(resolved, opts.env);
		if (reason) dangerous.push({ path: resolved, reason });
		else ordinary.push(resolved);
	}

	return { blocked, covered, dangerous, ordinary, inside };
}

/** 把一批目标折算成要记住的目录范围（去重、丢掉算不出安全范围的）。 */
export function memoryScopesFor(paths: readonly string[], env: PathEnv, cwd = process.cwd()): string[] {
	const out: string[] = [];
	for (const p of paths) {
		const scope = memoryScopeFor(p, env, cwd);
		if (scope && !out.includes(scope)) out.push(scope);
	}
	return out;
}

/**
 * 生成 seatbelt profile。
 *
 * 形状是 `deny default` 打底，再逐项放行 —— 顺序很重要：seatbelt 里**后写的规则覆盖先写的**，
 * 所以「全局放行 → 局部收回」这个顺序就是本 profile 的全部技巧。
 *
 * 放行的能力：
 * - `file-read*` 全放行（读不限制）
 * - `network*` 全放行（出站不限制）
 * - `process-fork` / `process-exec` / `signal`：跑子命令、`kill` 自己的进程组
 * - `sysctl-read` / `mach-lookup` / `ipc-posix*`：几乎所有程序启动都要
 * - `file-write*` **全放行**（写不限制 —— 用户 2026-09-24 定的口径）
 *
 * 收回的能力只有一项：
 * - `file-write-unlink` 先全局 `deny`，再只对可写根 `allow`。于是边界外的 `rm` / `rmdir`
 *   （以及一切 rename，见文件头）拿到 `EPERM`，边界内照常删除。
 *
 * `extraUnlinkRoots` 是两层授权的注入点：持久白名单与会话豁免的目录在这里并进
 * 同一行 `(allow file-write-unlink …)` —— 记住一个目录 = 加宽这一行，删除在沙箱内
 * 直接成功，命令的其余部分仍被沙箱管着。
 *
 * **永不删除路径在 allow 行之后另起一行 `deny`**（`neverDeletePaths()`）：seatbelt 后写
 * 的规则覆盖先写的，所以即使某个 allow 根是它的祖先（`PI_SANDBOX_EXTRA_WRITE=$HOME`、
 * 或白名单里手塞了 `~/.ssh`），这些子树仍被内核 `EPERM` 拦死 —— 这是「无任何放行
 * 选项」的内核级强制，与 `classifyOutsidePaths` 的 `blocked` 档出自同一张表。
 *
 * 一个例外：**项目目录（`boundary.cwd`）落在某个永不删除路径之下时，该路径不进 deny
 * 行** —— 否则在 `~/.pi/agent/extensions/x` 这种项目里干活时，删自己的文件会被全部
 * 拦死（项目目录按定义在可删边界内，这是既有口径）。这里不用 SBPL 的嵌套过滤器
 * 表达「deny 整棵但挖掉 cwd」：本 profile 只用已实测可用的构造（`deny default` /
 * `allow` / `deny` / `subpath` / `literal`），不引入无法在本环境验证的语法。
 *
 * 设备文件（`/dev/null` 等）的 `file-write-data` / `file-write-mode` 已被全局 `file-write*`
 * 覆盖，不再单列；`file-ioctl` 不属于 `file-write*`，仍需显式放行（tty 操作要用）。
 */
export function buildSeatbeltProfile(boundary: WriteBoundary, extraUnlinkRoots: readonly string[] = []): string {
	const unlinkSubpaths = [...writableRoots(boundary), ...extraUnlinkRoots]
		.map((root) => stripTrailingSlash(resolvePath(root)))
		.filter((root, index, all) => all.indexOf(root) === index)
		.map((root) => `(subpath ${quoteSb(root)})`);

	// 永不删除：项目目录在其下的那一项跳过（见上面 docstring 的例外说明）。
	// 每项同时发 `literal` 与 `subpath`：`subpath` 对**目录**是确定语义（它与其下一切），
	// 而对**文件**（`~/.zshrc`）是否匹配文件本身没有权威文档，所以补一条 `literal`
	// 把精确路径钉死 —— 两条都是 deny，多写不改变结果，只消除不确定性。
	const cwd = stripTrailingSlash(resolvePath(boundary.cwd));
	const neverDeleteFilters = neverDeletePaths()
		.filter((root) => !(cwd === root || cwd.startsWith(`${root}/`)))
		.map((root) => `(literal ${quoteSb(root)})(subpath ${quoteSb(root)})`);

	const deviceLiterals = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/urandom", "/dev/random", "/dev/dtracehelper"]
		.map((dev) => `(literal ${quoteSb(dev)})`)
		.join("");

	return [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow signal)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix*)",
		"(allow file-read*)",
		"(allow network*)",
		"(allow file-write*)",
		"(deny file-write-unlink)",
		`(allow file-write-unlink ${unlinkSubpaths.join("")})`,
		// 永不删除：allow 行之后收回（seatbelt 后写覆盖先写）。名单为空时不写这行。
		...(neverDeleteFilters.length > 0 ? [`(deny file-write-unlink ${neverDeleteFilters.join("")})`] : []),
		`(allow file-ioctl ${deviceLiterals})`,
	].join("\n");
}

/**
 * 把命令包进沙箱。
 *
 * profile 通过 `-p` 内联传入（不落盘）：临时文件会引入"谁来清理""清理时删哪里"的新问题，
 * 而那正是本扩展要消灭的那类问题。命令与 profile 都用单引号安全转义。
 */
export function wrapWithSandbox(command: string, profile: string, shellPath = "/bin/bash"): string {
	return `sandbox-exec -p ${shellQuote(profile)} ${shellQuote(shellPath)} -c ${shellQuote(command)}`;
}

/** seatbelt profile 里的字符串字面量：双引号包裹，转义 `\` 与 `"`。 */
function quoteSb(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** shell 单引号包裹：内部的 `'` 换成 `'\''`（POSIX 标准做法，不依赖反斜杠转义）。 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripTrailingSlash(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * 沙箱是否可用（平台 + 开关）。
 *
 * `PI_SANDBOX=off` 整体关闭。非 darwin 平台没有 `sandbox-exec`，也关闭 ——
 * 宁可没有这层保护，也不要让命令在 Linux 上因为找不到二进制而全部失败。
 */
export function isSandboxEnabled(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
	if (env.PI_SANDBOX?.trim().toLowerCase() === "off") return false;
	return platform === "darwin";
}

/** 从环境构造边界（`PI_SANDBOX_EXTRA_WRITE` + cwd）。 */
export function boundaryFromEnv(cwd: string, env: NodeJS.ProcessEnv = process.env): WriteBoundary {
	return makeBoundary(cwd, parseExtraWrites(env.PI_SANDBOX_EXTRA_WRITE, cwd));
}
