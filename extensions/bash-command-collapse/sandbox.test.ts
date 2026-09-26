/**
 * Tests for the seatbelt capability boundary (sandbox.ts) — 纯逻辑单测，不需要 pi。
 *
 * Run with:  node --test clients/pi/extensions/bash-command-collapse/sandbox.test.ts
 *
 * 断言口径（用户 2026-09-24 定，同日收窄到「只管删除」）：
 *   - profile 以 `(deny default)` 打底（fail-closed 的来源）；
 *   - 写入全放行（`file-write*`），删除收窄：`file-write-unlink` 先全局 deny，
 *     再只对可删根 allow —— 可删根 = 项目目录 + /tmp + /private/tmp + /var/folders
 *     + /private/var/folders + /var/tmp + /private/var/tmp + 额外路径；
 *   - 读全放行（file-read*）、网络全放行（network*）；
 *   - isPathInWriteBoundary 是白名单判定：cwd 内/子目录、/tmp、$TMPDIR 在内；
 *     $HOME 下的全局文件、/usr/local 等一律在外；
 *   - 拒绝识别只认 EPERM / Operation not permitted，不认 Permission denied（EACCES）；
 *   - 包裹命令用 sandbox-exec -p，profile 与命令都单引号安全转义。
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import {
	ESCALATION_TITLE,
	MIN_ALLOWLIST_DEPTH,
	NEVER_DELETE_HOME_DIRS,
	NEVER_DELETE_HOME_FILES,
	SAFE_CACHE_HOME_DIRS,
	TEMP_WRITE_ROOTS,
	buildSeatbeltProfile,
	boundaryFromEnv,
	classifyOutsidePaths,
	componentCount,
	dangerousReasonFor,
	dangerousRoots,
	extractDeniedPaths,
	isPathInWriteBoundary,
	isSafeAllowlistRoot,
	isSandboxEnabled,
	looksLikeSandboxDenial,
	makeBoundary,
	maskedDenialPaths,
	memoryScopeFor,
	memoryScopesFor,
	neverDeletePaths,
	neverDeleteReasonFor,
	parseExtraWrites,
	resolveAgainst,
	sessionScopeFor,
	shellQuote,
	wrapWithSandbox,
	writableRoots,
} from "./sandbox.ts";

const CWD = "/Users/someone/project";
const HOME = os.homedir();

test("profile 以 deny default 打底，且放行读写网络与进程能力", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const lines = profile.split("\n");
	assert.equal(lines[0], "(version 1)");
	assert.equal(lines[1], "(deny default)", "fail-closed：没被显式放行的一律拒");
	assert.ok(profile.includes("(allow file-read*)"), "读不限制");
	assert.ok(profile.includes("(allow network*)"), "网络全放行");
	assert.ok(profile.includes("(allow process-fork)"));
	assert.ok(profile.includes("(allow process-exec)"));
	assert.ok(profile.includes("(allow mach-lookup)"));
});

test("profile 写入全放行，删除只对可删根放行（全局 deny + 局部 allow）", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD, ["/Users/someone/.pm2"]));
	const lines = profile.split("\n");
	assert.ok(lines.includes("(allow file-write*)"), "写入不限制（用户 2026-09-24 口径）");
	assert.ok(lines.includes("(deny file-write-unlink)"), "删除先全局收回");
	const unlinkAllow = lines.find((l) => l.startsWith("(allow file-write-unlink "));
	assert.ok(unlinkAllow, "删除再对可删根放行");
	// 顺序：deny 必须在 allow 之前，seatbelt 后写的规则覆盖先写的
	assert.ok(
		lines.indexOf("(deny file-write-unlink)") < lines.indexOf(unlinkAllow),
		"deny 在前、allow 在后，否则全局 deny 会被覆盖失效",
	);
	assert.ok(unlinkAllow.includes(`(subpath "${CWD}")`));
	for (const root of TEMP_WRITE_ROOTS) {
		assert.ok(unlinkAllow.includes(`(subpath "${root}")`), `缺少临时根 ${root}`);
	}
	assert.ok(unlinkAllow.includes('(subpath "/Users/someone/.pm2")'), "额外路径要进 unlink 放行名单");
});

test("isPathInWriteBoundary：cwd 内与子目录在边界内", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary(`${CWD}/src/x.ts`, b), true);
	assert.equal(isPathInWriteBoundary(CWD, b), true, "cwd 本身可写");
	assert.equal(isPathInWriteBoundary("src/x.ts", b), true, "相对路径按 cwd 解析");
	assert.equal(isPathInWriteBoundary(`${CWD}/`, b), true, "尾斜杠不影响");
});

test("isPathInWriteBoundary：临时目录在边界内（含 realpath 形式）", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary("/tmp/a", b), true);
	assert.equal(isPathInWriteBoundary("/private/tmp/a", b), true);
	assert.equal(isPathInWriteBoundary("/var/folders/x/y", b), true);
	assert.equal(isPathInWriteBoundary("/private/var/folders/x/y", b), true);
});

test("isPathInWriteBoundary：/var/tmp 在边界内（bash 3.2 heredoc 临时目录，编译期写死）", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary("/var/tmp/sh-thd-12345", b), true);
	assert.equal(isPathInWriteBoundary("/private/var/tmp/sh-thd-12345", b), true);
	assert.ok(TEMP_WRITE_ROOTS.includes("/var/tmp"), "缺 /var/tmp 则沙箱内任何 heredoc 都 100% 失败");
	assert.ok(TEMP_WRITE_ROOTS.includes("/private/var/tmp"), "realpath 形式也要在表里");
});

test("isPathInWriteBoundary：$HOME 全局文件与系统目录在边界外", () => {
	const b = makeBoundary(CWD);
	assert.equal(isPathInWriteBoundary(`${HOME}/.zshrc`, b), false);
	assert.equal(isPathInWriteBoundary(`${HOME}/.gitconfig`, b), false);
	assert.equal(isPathInWriteBoundary(`${HOME}/.pi/agent/sessions`, b), false);
	assert.equal(isPathInWriteBoundary("/usr/local/bin/tsc", b), false);
	assert.equal(isPathInWriteBoundary("/Users/someone-other/x", b), false, "同名前缀不算子树");
});

test("isPathInWriteBoundary：前缀同名目录不算子树", () => {
	const b = makeBoundary("/Users/someone/project");
	assert.equal(isPathInWriteBoundary("/Users/someone/project-x/f", b), false);
});

test("额外写路径：展开 ~ 与相对路径", () => {
	const b = makeBoundary(CWD, ["~/.pm2", "../shared"]);
	assert.equal(isPathInWriteBoundary(`${HOME}/.pm2/logs/out.log`, b), true);
	assert.equal(isPathInWriteBoundary("/Users/someone/shared/f", b), true);
});

test("parseExtraWrites：冒号分隔、空项丢弃、~ 展开", () => {
	const out = parseExtraWrites("~/.pm2::/opt/data:", CWD);
	assert.deepEqual(out, [`${HOME}/.pm2`, "/opt/data"]);
	assert.deepEqual(parseExtraWrites(undefined, CWD), []);
	assert.deepEqual(parseExtraWrites("", CWD), []);
});

test("resolveAgainst：~ 与 ~/ 展开", () => {
	assert.equal(resolveAgainst("~", CWD), HOME);
	assert.equal(resolveAgainst("~/x", CWD), `${HOME}/x`);
	assert.equal(resolveAgainst("/abs", CWD), "/abs");
	assert.equal(resolveAgainst("rel", CWD), `${CWD}/rel`);
});

test("looksLikeSandboxDenial：只认 EPERM 系，不认 EACCES", () => {
	assert.equal(looksLikeSandboxDenial("rm: /Users/x/.zshrc: Operation not permitted"), true);
	assert.equal(looksLikeSandboxDenial("Error: EPERM: operation not permitted, open '/x'"), true);
	assert.equal(looksLikeSandboxDenial("rm: /x: Permission denied"), false, "EACCES 不是沙箱拒绝");
	assert.equal(looksLikeSandboxDenial("hello world"), false);
	assert.equal(looksLikeSandboxDenial(""), false);
});

test("wrapWithSandbox：sandbox-exec -p 包裹，单引号安全转义", () => {
	const wrapped = wrapWithSandbox("echo 'hi'", "(version 1)", "/bin/bash");
	assert.ok(wrapped.startsWith("sandbox-exec -p '"), "profile 单引号内联，不落盘");
	assert.ok(wrapped.includes("/bin/bash' -c '"));
	// 命令里的单引号必须被 '\'' 转义，不能裸着破坏外层引号
	assert.ok(wrapped.includes("echo '\\''hi'\\''"));
});

test("shellQuote：含单引号的字符串往返安全", () => {
	const tricky = "a'b\"c$d`e";
	assert.equal(shellQuote(tricky), `'a'\\''b"c$d`+"`"+`e'`);
});

test("isSandboxEnabled：PI_SANDBOX=off 关闭；非 darwin 关闭", () => {
	assert.equal(isSandboxEnabled({ PI_SANDBOX: "off" }, "darwin"), false);
	assert.equal(isSandboxEnabled({ PI_SANDBOX: "OFF" }, "darwin"), false);
	assert.equal(isSandboxEnabled({}, "darwin"), true);
	assert.equal(isSandboxEnabled({}, "linux"), false, "没有 sandbox-exec 的平台不开");
});

test("boundaryFromEnv：从 PI_SANDBOX_EXTRA_WRITE 读额外路径", () => {
	const b = boundaryFromEnv(CWD, { PI_SANDBOX_EXTRA_WRITE: "~/.pm2" });
	assert.equal(isPathInWriteBoundary(`${HOME}/.pm2/x`, b), true);
});

test("ESCALATION_TITLE 是固定文案", () => {
	assert.equal(ESCALATION_TITLE, "沙箱拦截了对边界外文件的删除");
});

/* ------------------------------------------------------------------ *
 * 两层授权（用户 2026-09-24 定）：危险目录会话级必问 + 普通目录持久白名单
 * ------------------------------------------------------------------ */

const env = { home: HOME };

test("dangerousReasonFor：系统根、bin、应用安装目录、包管理器前缀都危险", () => {
	assert.ok(dangerousReasonFor("/usr/local/bin/tsc", env));
	assert.ok(dangerousReasonFor("/opt/homebrew/bin/x", env));
	assert.ok(dangerousReasonFor("/Applications/Foo.app", env));
	assert.ok(dangerousReasonFor("/bin/ls", env));
	assert.ok(dangerousReasonFor("/System/Library/x", env));
	assert.ok(dangerousReasonFor("/private/etc/hosts", env));
	assert.ok(dangerousReasonFor("/Volumes/Backup/x", env));
	assert.ok(dangerousReasonFor("/", env), "根本身");
	assert.ok(dangerousReasonFor("/Users", env), "Users 根");
});

test("dangerousReasonFor：$HOME 本身与 ~/Library 危险，但普通子目录不危险", () => {
	assert.ok(dangerousReasonFor(HOME, env), "$HOME 本身危险");
	assert.ok(dangerousReasonFor(`${HOME}/Library/Preferences/x.plist`, env), "~/Library 是危险档（必问可豁免）");
	assert.equal(dangerousReasonFor(`${HOME}/.ssh/id_rsa`, env), undefined, "凭据目录已升入永不删除档，不再是危险档");
	assert.equal(dangerousReasonFor(`${HOME}/Downloads`, env), undefined, "普通目录不危险");
	assert.equal(dangerousReasonFor(`${HOME}/projects/foo`, env), undefined);
});

test("neverDeleteReasonFor：身份/凭据/手写配置命中，项目里的同名文件不命中", () => {
	assert.ok(neverDeleteReasonFor(`${HOME}/.zshrc`, env), "第二次事故删的就是它");
	assert.ok(neverDeleteReasonFor(`${HOME}/.gitconfig`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.ssh/id_rsa`, env), "子树语义");
	assert.ok(neverDeleteReasonFor(`${HOME}/.gnupg/secring`, env));
	assert.equal(neverDeleteReasonFor(`${HOME}/.config/foo`, env), undefined, "用户 2026-09-25：~/.config 移出永不删除档");
	assert.equal(neverDeleteReasonFor(`${HOME}/.pi/agent/extensions`, env), undefined, "用户 2026-09-25：~/.pi 移出永不删除档（自保护降级为弹框）");
	assert.equal(neverDeleteReasonFor(`${HOME}/.claude/x`, env), undefined, "用户 2026-09-25：~/.claude 移出永不删除档");
	assert.equal(neverDeleteReasonFor(`${HOME}/.codex/y`, env), undefined, "用户 2026-09-25：~/.codex 移出永不删除档");
	assert.ok(neverDeleteReasonFor(`${HOME}/.env`, env));
	assert.equal(neverDeleteReasonFor(`${HOME}/projects/.zshrc`, env), undefined, "项目里的 .zshrc 不是全局配置");
	assert.equal(neverDeleteReasonFor(`${HOME}/.zshrc.bak`, env), undefined, "精确名：.bak 后缀不在名单");
	assert.equal(neverDeleteReasonFor(`${HOME}/Downloads`, env), undefined);
	assert.equal(neverDeleteReasonFor(`${HOME}/Library/Caches/x`, env), undefined, "缓存不在永不删除名单");
	// 2026-09-25 补充的通用项（本机未必存在，名单是预防性的）
	assert.ok(neverDeleteReasonFor(`${HOME}/.bash_history`, env), "shell 历史丢了补不回");
	assert.ok(neverDeleteReasonFor(`${HOME}/.envrc`, env), "direnv 常含导出到环境的密钥");
	assert.ok(neverDeleteReasonFor(`${HOME}/.hgrc`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.gitignore`, env), "home 级全局 gitignore");
	assert.ok(neverDeleteReasonFor(`${HOME}/.tool-versions`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.yarnrc`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.yarnrc.yml`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.bunfig.toml`, env));
	assert.ok(neverDeleteReasonFor(`${HOME}/.boto`, env), "gsutil 凭据");
	assert.ok(neverDeleteReasonFor(`${HOME}/.s3cfg`, env), "s3cmd 凭据");
	for (const dir of [".azure", ".gcloud", ".terraform.d", ".helm", ".minikube", ".password-store"]) {
		assert.ok(neverDeleteReasonFor(`${HOME}/${dir}/x`, env), `${dir} 子树语义`);
	}
	// 嵌套条目：凭据下沉到 ~/.config 两级的工具
	assert.ok(neverDeleteReasonFor(`${HOME}/.config/gh/hosts.yml`, env), "gh token 在 hosts.yml");
	assert.ok(neverDeleteReasonFor(`${HOME}/.config/gcloud/credentials.db`, env), "gcloud 凭据");
	assert.equal(neverDeleteReasonFor(`${HOME}/.config`, env), undefined, "嵌套条目不牵连 ~/.config 自身");
	assert.equal(neverDeleteReasonFor(`${HOME}/.config/ghostty/config`, env), undefined, "~/.config 下其他工具仍是普通档");
	assert.equal(neverDeleteReasonFor(`${HOME}/projects/.envrc`, env), undefined, "项目里的 .envrc 不是全局配置");
	assert.equal(neverDeleteReasonFor(`${HOME}/projects/.gitignore`, env), undefined, "项目里的 .gitignore 是项目文件");
});

test("neverDeleteReasonFor：realpath 能看见符号链接逃逸", () => {
	const withRealpath = {
		home: HOME,
		realpath: (p: string) => (p === `${HOME}/link` || p.startsWith(`${HOME}/link/`) ? p.replace(`${HOME}/link`, `${HOME}/.ssh`) : undefined),
	};
	assert.ok(neverDeleteReasonFor(`${HOME}/link/id_rsa`, withRealpath), "链接指向 ~/.ssh 也拦");
	assert.equal(neverDeleteReasonFor(`${HOME}/link/id_rsa`, env), undefined, "不给 realpath 只能词法判（已知缺口）");
});

test("dangerousReasonFor：路径里任何一级是 .git/.hg/.svn 都危险", () => {
	assert.ok(dangerousReasonFor(`${HOME}/projects/x/.git`, env));
	assert.ok(dangerousReasonFor(`${HOME}/projects/x/.git/objects`, env));
	assert.ok(dangerousReasonFor(`/tmp/whatever/.svn/entries`, env), "在临时目录里也算（形状规则优先）");
	assert.equal(dangerousReasonFor(`${HOME}/projects/x/gitignore`, env), undefined, "名字相似但不是 VCS 目录");
});

test("dangerousReasonFor：realpath 能看见符号链接逃逸", () => {
	// ~/link → /etc：词法形态在 home 下（不危险），realpath 形态是 /etc/passwd（危险）。
	// 仿真实 realpathSync：整条路径的前缀被替换，而不是只认链接本身。
	const withRealpath = {
		home: HOME,
		realpath: (p: string) => (p === `${HOME}/link` || p.startsWith(`${HOME}/link/`) ? p.replace(`${HOME}/link`, "/etc") : undefined),
	};
	assert.ok(dangerousReasonFor(`${HOME}/link/passwd`, withRealpath));
	assert.equal(dangerousReasonFor(`${HOME}/link/passwd`, env), undefined, "不给 realpath 就只能词法判（已知缺口）");
});

test("dangerousRoots：分 subtree / exact 两档，$HOME 在 exact 档", () => {
	const tables = dangerousRoots(env);
	assert.ok(tables.exact.includes(HOME), "$HOME 仅自身危险（否则 ~/Downloads 也成危险，白名单就废了）");
	assert.ok(tables.exact.includes("/"));
	assert.ok(tables.exact.includes("/Users"));
	assert.ok(tables.subtree.includes(`${HOME}/Library`), "~/Library 留在危险档");
	assert.ok(!tables.subtree.includes(`${HOME}/.ssh`), "凭据目录已升入永不删除档");
	assert.ok(tables.subtree.includes("/usr"));
	assert.ok(!tables.subtree.includes(HOME), "$HOME 不在子树档");
});

test("neverDeletePaths：home 一级文件 + 目录子树根 + 嵌套条目都解析成绝对路径", () => {
	const paths = neverDeletePaths(HOME);
	assert.ok(paths.includes(`${HOME}/.zshrc`));
	assert.ok(paths.includes(`${HOME}/.ssh`));
	assert.ok(paths.includes(`${HOME}/.bash_history`), "2026-09-25 补充的通用项");
	assert.ok(paths.includes(`${HOME}/.password-store`), "密码库子树");
	assert.ok(paths.includes(`${HOME}/.config/gh`), "嵌套条目：拼到 home 下再 resolvePath");
	assert.ok(paths.includes(`${HOME}/.config/gcloud`), "嵌套条目");
	assert.ok(!paths.includes(`${HOME}/.config`), "用户 2026-09-25：工具状态目录移出名单");
	assert.ok(!paths.includes(`${HOME}/.pi`), "用户 2026-09-25：工具状态目录移出名单");
	assert.ok(paths.includes(`${HOME}/.env`));
	assert.ok(!paths.includes(`${HOME}/.cache`), "缓存不在名单");
	assert.ok(!paths.includes(`${HOME}/Library`), "Library 是危险档不是永不删除");
});

test("memoryScopeFor：文件记父目录，目录记自身", () => {
	const withDir = { home: HOME, isDirectory: (p: string) => p === `${HOME}/Downloads` };
	assert.equal(memoryScopeFor(`${HOME}/Downloads/old.zip`, withDir, CWD), `${HOME}/Downloads`);
	assert.equal(memoryScopeFor(`${HOME}/Downloads`, withDir, CWD), `${HOME}/Downloads`, "目标是目录 → 记自身");
});

test("memoryScopeFor：父目录危险/太浅时降级为精确路径", () => {
	// ~/.zshrc.bak 的父目录是 $HOME（危险根）→ 只能记这个文件本身
	assert.equal(memoryScopeFor(`${HOME}/.zshrc.bak`, env, CWD), `${HOME}/.zshrc.bak`);
	// /Users/x 的父目录是 /Users（危险根），自身又只有 2 层 → 什么都记不了（逐次批准）
	assert.equal(memoryScopeFor("/Users/x", env, CWD), undefined);
	// 目标本身是危险根 → 什么都记不了（只能走会话级豁免）
	assert.equal(memoryScopeFor(`${HOME}/.ssh`, env, CWD), undefined);
	assert.equal(memoryScopeFor("/", env, CWD), undefined);
});

test("memoryScopeFor：MIN_ALLOWLIST_DEPTH 挡住浅目录", () => {
	assert.equal(componentCount("/Users/bachi"), 2);
	assert.equal(componentCount("/Users/bachi/Downloads"), 3);
	assert.ok(MIN_ALLOWLIST_DEPTH >= 3, "卡 3 层：记父目录永远退不到 $HOME");
	// /Users/bachi/Downloads 的父目录 /Users/bachi 只有 2 层 → 降级记精确路径
	assert.equal(memoryScopeFor("/Users/bachi/Downloads", env, CWD), "/Users/bachi/Downloads");
});

test("isSafeAllowlistRoot：拒 `/`、危险根、永不删除路径，以及危险根的祖先", () => {
	assert.equal(isSafeAllowlistRoot("/", env), false);
	assert.equal(isSafeAllowlistRoot(HOME, env), false, "$HOME 是危险根");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.ssh`, env), false, "永不删除路径不能入白名单");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.config/gh`, env), false, "嵌套的永不删除路径同样不能入白名单");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.config`, env), true, "用户 2026-09-25：~/.config 是普通目录，可记住（祖先闸不查永不删除档，否则嵌套条目会把它废掉）");
	assert.equal(isSafeAllowlistRoot(`${HOME}/.pi/agent`, env), true, "用户 2026-09-25：~/.pi 子目录可记住");
	assert.equal(isSafeAllowlistRoot(`${HOME}/Downloads`, env), true);
	assert.equal(isSafeAllowlistRoot("/Users", env), false, "组件数不够");
	assert.equal(isSafeAllowlistRoot("/Users/bachi", env), false, "是 $HOME 危险根的祖先（且组件数不够）");
});

test("sessionScopeFor：危险根之下可以会话豁免，危险根 / 永不删除路径之下不行", () => {
	// ~/Library/Foo/bar 的父目录 ~/Library/Foo 在危险根 ~/Library 之下但自身不是危险根 → 可以
	assert.equal(sessionScopeFor(`${HOME}/Library/Foo/bar`, env, CWD), `${HOME}/Library/Foo`);
	// ~/Library/x.plist 的父目录是 ~/Library（本身是危险根）→ 退回精确路径
	assert.equal(sessionScopeFor(`${HOME}/Library/x.plist`, env, CWD), `${HOME}/Library/x.plist`);
	// ~/.ssh 本身是永不删除路径 → 退回精确路径（blocked 档走不到这里，口径防御）
	assert.equal(sessionScopeFor(`${HOME}/.ssh`, env, CWD), `${HOME}/.ssh`);
	// 用户 2026-09-25：~/.config/foo 不再是永不删除子树 → 记父目录 ~/.config（深度 3 过闸）
	assert.equal(sessionScopeFor(`${HOME}/.config/foo`, env, CWD), `${HOME}/.config`);
});

test("extractDeniedPaths：BSD rm/rmdir 形状", () => {
	assert.deepEqual(extractDeniedPaths("rm: /Users/x/.sbx-probe: Operation not permitted"), ["/Users/x/.sbx-probe"]);
	assert.deepEqual(extractDeniedPaths("rmdir: /Users/x/dir: Operation not permitted"), ["/Users/x/dir"]);
	assert.deepEqual(extractDeniedPaths("node: /Users/x/a: Operation not permitted"), ["/Users/x/a"]);
});

test("extractDeniedPaths：GNU 引号形状", () => {
	assert.deepEqual(extractDeniedPaths("rm: cannot remove '/Users/x/a': Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("unlink: cannot unlink '/Users/x/a': Operation not permitted"), ["/Users/x/a"]);
});

test("extractDeniedPaths：rename 形状取源（mv / sed -i / git 落 ref）", () => {
	assert.deepEqual(extractDeniedPaths("mv: rename /Users/x/a to /Users/x/b: Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("sed: rename(/Users/x/.conf.sedXXXX to /Users/x/.conf): Operation not permitted"), ["/Users/x/.conf.sedXXXX"]);
});

test("extractDeniedPaths：排除 1 —— heredoc 临时文件失败不是删除", () => {
	// bash 3.2 的 heredoc 必须先建 /var/tmp/sh-thd-* 再 unlink；它不是用户数据。
	// 这三条是 2026-09-24 误报「要删 /bin/bash」弹危险目录框的原始输入。
	assert.deepEqual(
		extractDeniedPaths("/bin/bash: cannot create temp file for here document: Operation not permitted"),
		[],
		"旧实现靠兜底扫描抽成 /bin/bash，于是弹了「危险路径 /bin」框",
	);
	assert.deepEqual(
		extractDeniedPaths("/bin/bash: line 5: cannot create temp file for here document: Operation not permitted"),
		[],
		"带行号变体",
	);
	assert.deepEqual(
		extractDeniedPaths("bash: /p: cannot create temp file for here document: Operation not permitted"),
		[],
		"旧实现 BSD 贪婪捕获抽成「/p: cannot create temp file for here document」这种脏路径",
	);
});

test("extractDeniedPaths：排除 2 —— shell / sandbox-exec 自身的 EPERM 是 exec 失败，不是 unlink", () => {
	// /bin/ps、/usr/bin/top 是 setuid / platform binary，沙箱内 exec 直接 EPERM。
	assert.deepEqual(extractDeniedPaths("bash: /bin/ps: Operation not permitted"), [], "旧实现抽成 /bin/ps → 弹危险框");
	assert.deepEqual(extractDeniedPaths("bash: line 0: /usr/bin/top: Operation not permitted"), []);
	assert.deepEqual(extractDeniedPaths("/bin/sh: /usr/bin/top: Operation not permitted"), [], "带路径前缀的 shell 同样认");
	assert.deepEqual(extractDeniedPaths("zsh: /bin/ps: Operation not permitted"), []);
	assert.deepEqual(extractDeniedPaths("sandbox-exec: sandbox_apply: Operation not permitted"), [], "嵌套沙箱不可用");
});

test("extractDeniedPaths：排除是逐行的 —— 混合输出里真删除仍被抽出", () => {
	// `cat <<EOF …; rm /边界外` 这种串联命令：heredoc 行跳过，rm 行照常弹框。
	const out = extractDeniedPaths(
		[
			"/bin/bash: cannot create temp file for here document: Operation not permitted",
			"rm: /Users/x/outside/a: Operation not permitted",
		].join("\n"),
	);
	assert.deepEqual(out, ["/Users/x/outside/a"], "全局闸会吞掉真删除，逐行不会");
});

test("extractDeniedPaths：兜底扫描保留 —— 白名单方案会丢的三类真实删除形状", () => {
	// python3：路径在 EPERM **之后**且无 cannot，prog token 是 PermissionError 不是 python3，
	// BSD / GNU 两条正则都够不着 —— 只有兜底抽得出。这是 2026-09-23 事故①的原型形状。
	assert.deepEqual(
		extractDeniedPaths("PermissionError: [Errno 1] Operation not permitted: '/Users/x/outside/a'"),
		["/Users/x/outside/a"],
	);
	// find -delete / -exec rm
	assert.deepEqual(extractDeniedPaths("find: /Users/x/outside: Operation not permitted"), ["/Users/x/outside"]);
	// ln -sf 覆盖 = unlink 目标
	assert.deepEqual(extractDeniedPaths("ln: /Users/x/outside/link: Operation not permitted"), ["/Users/x/outside/link"]);
});

test("extractDeniedPaths：兜底扫描保留 —— rvm / apply2files / xargs 包装", () => {
	assert.deepEqual(extractDeniedPaths("rvm: /Users/x/a -> errno=1 Operation not permitted"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("ruby: Operation not permitted @ apply2files - /Users/x/a"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("perl: Operation not permitted @ apply2files - /Users/x/a"), ["/Users/x/a"]);
	assert.deepEqual(extractDeniedPaths("xargs: rm: /Users/x/outside/a: Operation not permitted"), ["/Users/x/outside/a"]);
});

test("extractDeniedPaths：兜底扫描新增覆盖 —— node / git 的真实多行格式", () => {
	// 这两条旧实现反而抽不出（node 的没有冒号分隔、git 的尾引号没洗干净）。
	assert.deepEqual(
		extractDeniedPaths("Error: EPERM: operation not permitted, unlink '/Users/x/outside/a'"),
		["/Users/x/outside/a"],
		"node fs.unlinkSync 的真实报错形状",
	);
	assert.deepEqual(
		extractDeniedPaths("warning: unable to unlink '/Users/x/repo/.git/config.lock': Operation not permitted"),
		["/Users/x/repo/.git/config.lock"],
		"git 落 ref 的真实形状；同时钉住 cleanExtractedPath 的尾引号修复（旧实现抽成 …lock'）",
	);
});

test("extractDeniedPaths：BSD 捕获只取单 token，抽不出就落兜底", () => {
	// 旧的 (.+?) 会把中段一起吃进来，抽成脏路径。
	assert.deepEqual(
		extractDeniedPaths("find: /Users/x/outside/a: cannot unlink: Operation not permitted"),
		["/Users/x/outside/a"],
		"旧实现抽成「/Users/x/outside/a: cannot unlink」",
	);
});

test("extractDeniedPaths：多个目标、去重", () => {
	const out = extractDeniedPaths(
		[
			"rm: /Users/x/a: Operation not permitted",
			"rm: /Users/x/b: Operation not permitted",
			"rm: /Users/x/a: Operation not permitted",
		].join("\n"),
	);
	assert.deepEqual(out, ["/Users/x/a", "/Users/x/b"], "去重且保序");
	assert.deepEqual(extractDeniedPaths("hello world"), []);
	assert.deepEqual(extractDeniedPaths(""), []);
	// 含特征串但没有绝对路径 token 的行：兜底扫描也抽不出东西
	assert.deepEqual(extractDeniedPaths("grep: Operation not permitted 只是普通文本"), []);
});

test("extractDeniedPaths：相对路径与无路径行返回空（调用方不弹框、原样报错）", () => {
	assert.deepEqual(extractDeniedPaths("rm: foo.txt: Operation not permitted"), [], "相对路径不认（猜不出绝对目标）");
	assert.deepEqual(extractDeniedPaths("Operation not permitted"), []);
});

test("classifyOutsidePaths：永不删除 / 边界内 / 已授权 / 危险 / 普通五档互斥", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(
		[
			`${CWD}/src/x.ts`, // 边界内
			`${HOME}/Downloads/a.txt`, // 已授权（allowedRoots 里有 ~/Downloads）
			`${HOME}/Downloads/b.txt`, // 已授权（同目录）
			`${HOME}/.zshrc`, // 永不删除
			`${HOME}/.ssh/id_rsa`, // 永不删除（子树）
			`${HOME}/Library/Preferences/x`, // 危险（必问可豁免）
			`${HOME}/projects/foo/y.txt`, // 普通
		],
		{ boundary: b, allowedRoots: [`${HOME}/Downloads`], sessionRoots: [], env },
	);
	assert.deepEqual(result.inside, [`${CWD}/src/x.ts`]);
	assert.deepEqual(result.covered, [`${HOME}/Downloads/a.txt`, `${HOME}/Downloads/b.txt`]);
	assert.deepEqual(result.blocked.map((d) => d.path), [`${HOME}/.zshrc`, `${HOME}/.ssh/id_rsa`]);
	assert.deepEqual(result.dangerous.map((d) => d.path), [`${HOME}/Library/Preferences/x`]);
	assert.deepEqual(result.ordinary, [`${HOME}/projects/foo/y.txt`]);
});

test("classifyOutsidePaths：永不删除先于边界与授权 —— extraWrites / 白名单 / 会话豁免都压不过", () => {
	// extraWrites 把 ~/.ssh 加进可删边界，仍然 blocked
	const b = makeBoundary(CWD, [`${HOME}/.ssh`]);
	const result = classifyOutsidePaths([`${HOME}/.ssh/id_rsa`], {
		boundary: b,
		allowedRoots: [`${HOME}/.ssh`],
		sessionRoots: [`${HOME}/.ssh`],
		env,
	});
	assert.deepEqual(result.blocked.map((d) => d.path), [`${HOME}/.ssh/id_rsa`], "凭据目录不给删");
	assert.equal(result.inside.length, 0, "即使 extraWrites 放行了也不进边界档");
	assert.equal(result.covered.length, 0, "白名单 / 会话豁免也压不过");
});

test("classifyOutsidePaths：项目目录在永不删除路径之下时，删自己的文件不被 blocked", () => {
	// 在 ~/.gnupg/proj/x 这种（假想的）位于永不删除目录里的项目干活：删项目自己的文件应当放行
	const projectDir = `${HOME}/.gnupg/proj/x`;
	const b = makeBoundary(projectDir);
	const result = classifyOutsidePaths([`${projectDir}/src/a.ts`, `${HOME}/.gnupg/private-keys-v1.d`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.inside, [`${projectDir}/src/a.ts`], "项目目录按定义在可删边界内");
	assert.deepEqual(result.blocked.map((d) => d.path), [`${HOME}/.gnupg/private-keys-v1.d`], "项目外的仍拦");
});

test("classifyOutsidePaths：~/.pi、~/.config、~/.claude、~/.codex 是普通边界外档 —— 弹框可记住", () => {
	// 用户 2026-09-25：这四个工具状态目录移出永不删除档（pi 自己清理 stale lock 曾被内核拦死）
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(
		[`${HOME}/.pi/agent/trust.json.lock`, `${HOME}/.config/foo`, `${HOME}/.claude/x`, `${HOME}/.codex/y`],
		{ boundary: b, allowedRoots: [], sessionRoots: [], env },
	);
	assert.deepEqual(
		result.ordinary,
		[`${HOME}/.pi/agent/trust.json.lock`, `${HOME}/.config/foo`, `${HOME}/.claude/x`, `${HOME}/.codex/y`],
	);
	assert.equal(result.blocked.length, 0);
	assert.equal(result.dangerous.length, 0);
	// 白名单记住 ~/.pi/agent 后不再问
	const covered = classifyOutsidePaths([`${HOME}/.pi/agent/trust.json.lock`], {
		boundary: b,
		allowedRoots: [`${HOME}/.pi/agent`],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(covered.covered, [`${HOME}/.pi/agent/trust.json.lock`], "记住后静默放行");
});

test("classifyOutsidePaths：会话豁免优先于危险判定", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/Library/Foo/bar`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [`${HOME}/Library/Foo`],
		env,
	});
	assert.deepEqual(result.covered, [`${HOME}/Library/Foo/bar`], "本会话豁免过就不再问");
	assert.equal(result.dangerous.length, 0);
});

test("classifyOutsidePaths：可再生缓存在边界内 —— ~/.cache 与 ~/Library/Caches 静默放行", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/.cache/foo`, `${HOME}/Library/Caches/x`, `${HOME}/.npm/_cacache/y`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.inside, [`${HOME}/.cache/foo`, `${HOME}/Library/Caches/x`, `${HOME}/.npm/_cacache/y`]);
	assert.equal(result.blocked.length, 0);
	assert.equal(result.dangerous.length, 0, "~/Library/Caches 在边界内，走不到 ~/Library 的危险判定");
});

test("classifyOutsidePaths：边界内优先 —— /private/tmp 在 /private 下但不危险", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths(["/private/tmp/x"], { boundary: b, allowedRoots: [], sessionRoots: [], env });
	assert.deepEqual(result.inside, ["/private/tmp/x"], "先判边界：临时根直接放行");
	assert.equal(result.dangerous.length, 0);
});

test("classifyOutsidePaths：去重", () => {
	const b = makeBoundary(CWD);
	const result = classifyOutsidePaths([`${HOME}/projects/a`, `${HOME}/projects/a/`, `${HOME}/projects/a`], {
		boundary: b,
		allowedRoots: [],
		sessionRoots: [],
		env,
	});
	assert.deepEqual(result.ordinary, [`${HOME}/projects/a`]);
});

test("memoryScopesFor：一批目标折算出去重的范围", () => {
	assert.deepEqual(memoryScopesFor([`${HOME}/Downloads/a`, `${HOME}/Downloads/b`], env, CWD), [`${HOME}/Downloads`]);
});

test("writableRoots 至少含项目目录、全部临时根与可再生缓存根", () => {
	const roots = writableRoots(makeBoundary(CWD));
	assert.ok(roots.includes(CWD));
	for (const root of TEMP_WRITE_ROOTS) assert.ok(roots.includes(root));
	for (const rel of SAFE_CACHE_HOME_DIRS) assert.ok(roots.includes(`${HOME}/${rel}`), `缓存根 ${rel} 在可删边界内`);
});

test("buildSeatbeltProfile：永不删除 deny 行在 allow 行之后，含全部永不删除子树", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const lines = profile.split("\n");
	const allowIdx = lines.findIndex((l) => l.startsWith("(allow file-write-unlink "));
	const denyIdx = lines.findIndex((l) => l.startsWith("(deny file-write-unlink ("));
	assert.ok(allowIdx >= 0, "allow 行存在");
	assert.ok(denyIdx >= 0, "永不删除 deny 行存在");
	assert.ok(denyIdx > allowIdx, "deny 在 allow 之后（seatbelt 后写覆盖先写 → 内核级拦死）");
	const denyLine = lines[denyIdx]!;
	// 每项同时发 literal（钉死文件本身）与 subpath（覆盖目录子树）
	assert.ok(denyLine.includes(`(literal "${HOME}/.zshrc")`), "配置文件有 literal");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.zshrc")`), "配置文件也有 subpath");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.ssh")`), "凭据目录在 deny 行");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.password-store")`), "2026-09-25 补充的密码库在 deny 行");
	// 嵌套条目：两级绝对路径同样进 deny 行（literal + subpath）
	assert.ok(denyLine.includes(`(literal "${HOME}/.config/gh")`), "嵌套条目有 literal");
	assert.ok(denyLine.includes(`(subpath "${HOME}/.config/gcloud")`), "嵌套条目有 subpath");
	assert.ok(!denyLine.includes(`"${HOME}/.cache"`), "缓存不在 deny 行");
	// 缓存根在 allow 行
	assert.ok(lines[allowIdx]!.includes(`(subpath "${HOME}/.cache")`), "缓存根在 allow 行");
});

test("buildSeatbeltProfile：项目目录在永不删除路径之下时，该路径不进 deny 行", () => {
	const projectDir = `${HOME}/.gnupg/proj/x`;
	const profile = buildSeatbeltProfile(makeBoundary(projectDir));
	const denyLine = profile.split("\n").find((l) => l.startsWith("(deny file-write-unlink ("));
	assert.ok(denyLine, "deny 行仍存在");
	assert.ok(!denyLine!.includes(`"${HOME}/.gnupg"`), "项目所在的永不删除根被挖掉，否则删自己的文件全被拦");
	assert.ok(denyLine!.includes(`(subpath "${HOME}/.ssh")`), "其余永不删除根仍在");
});

test("buildSeatbeltProfile：~/.pi、~/.config、~/.claude、~/.codex 不在 deny 行", () => {
	// 用户 2026-09-25：工具状态目录移出永不删除档，内核不再拦它们的删除
	const profile = buildSeatbeltProfile(makeBoundary(CWD));
	const denyLine = profile.split("\n").find((l) => l.startsWith("(deny file-write-unlink ("));
	assert.ok(denyLine);
	for (const name of [".pi", ".config", ".claude", ".codex"]) {
		assert.ok(!denyLine!.includes(`"${HOME}/${name}"`), `${name} 不在 deny 行`);
	}
	assert.ok(denyLine!.includes(`(subpath "${HOME}/.ssh")`), "凭据目录仍在 deny 行");
	// 嵌套条目不影响上面四条：`~/.config/gh` 在 deny 行，但 `~/.config` 自身不在
	assert.ok(denyLine!.includes(`(subpath "${HOME}/.config/gh")`), "嵌套条目在");
	assert.ok(!denyLine!.includes(`(subpath "${HOME}/.config")`), "~/.config 自身不在（否则工具状态目录又变回永不删除）");
});

test("buildSeatbeltProfile：extraUnlinkRoots 并进同一行 allow，顺序不变", () => {
	const profile = buildSeatbeltProfile(makeBoundary(CWD), [`${HOME}/Downloads`, `${HOME}/Downloads`]);
	const lines = profile.split("\n");
	const unlinkAllow = lines.find((l) => l.startsWith("(allow file-write-unlink "));
	assert.ok(unlinkAllow, "仍只有一行 unlink allow");
	assert.ok(unlinkAllow!.includes(`(subpath "${HOME}/Downloads")`), "白名单根进了放行名单");
	assert.equal(unlinkAllow!.split(`(subpath "${HOME}/Downloads")`).length - 1, 1, "去重");
	assert.ok(
		lines.indexOf("(deny file-write-unlink)") < lines.indexOf(unlinkAllow!),
		"全局 deny 仍在 allow 之前（seatbelt 后写覆盖先写）",
	);
});

test("maskedDenialPaths：真实拒绝形状 + 文件仍在 → 返回被拦路径", () => {
	const output = `rm: ${HOME}/projects/foo/y.txt: Operation not permitted\nok\n`;
	const got = maskedDenialPaths(output, {
		boundary: makeBoundary(CWD),
		allowedRoots: [],
		sessionRoots: [],
		env,
		exists: () => true,
	});
	assert.deepEqual(got, [`${HOME}/projects/foo/y.txt`]);
});

test("maskedDenialPaths：grep 命中同形状但目标不在磁盘 → 空（误报过滤）", () => {
	// 日志行与真实拒绝形状完全相同（连 rm: 前缀都一样），唯一区别是目标不存在
	const output = `rm: ${HOME}/projects/gone.txt: Operation not permitted\n`;
	const got = maskedDenialPaths(output, {
		boundary: makeBoundary(CWD),
		allowedRoots: [],
		sessionRoots: [],
		env,
		exists: () => false,
	});
	assert.deepEqual(got, []);
});

test("maskedDenialPaths：边界内 / 已授权 / 永不删除档都不报，危险档报", () => {
	const output = [
		`rm: ${CWD}/src/x.ts: Operation not permitted`, // 边界内 → 不报
		`rm: ${HOME}/Downloads/a.txt: Operation not permitted`, // 已授权 → 不报
		`rm: ${HOME}/.zshrc: Operation not permitted`, // 永不删除 → 不报（无授权出口）
		`rm: ${HOME}/Library/Preferences/x: Operation not permitted`, // 危险 → 报
	].join("\n");
	const got = maskedDenialPaths(output, {
		boundary: makeBoundary(CWD),
		allowedRoots: [`${HOME}/Downloads`],
		sessionRoots: [],
		env,
		exists: () => true,
	});
	assert.deepEqual(got, [`${HOME}/Library/Preferences/x`]);
});

test("maskedDenialPaths：无拒绝字样 / 抽不出路径 → 空", () => {
	const opts = {
		boundary: makeBoundary(CWD),
		allowedRoots: [],
		sessionRoots: [],
		env,
		exists: () => true,
	};
	assert.deepEqual(maskedDenialPaths("all good\n", opts), []);
	// heredoc 形状被 extractDeniedPaths 排除（非删除），抽不出路径就不报
	assert.deepEqual(
		maskedDenialPaths("bash: cannot create temp file for here document: Operation not permitted\n", opts),
		[],
	);
});
