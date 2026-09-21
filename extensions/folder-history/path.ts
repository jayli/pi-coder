/**
 * path.ts — folder-history 历史文件名的纯逻辑。
 *
 * 从 `folder-history.ts` 抽出来：本模块不 import pi，所以 `node --test` 能直接跑。
 *
 * 目录与 `folder-history.ts` 同名且没有 index.ts：pi 只认 `extensions/<name>.ts` 与
 * `extensions/<name>/index.ts`，这个目录不会被当成扩展加载（与 `thinking-collapse/` 同一套）。
 *
 * Windows 的 cwd 是 `D:\Program Files\tty7` 这种带盘符和反斜杠的路径。只把 `/` 换成 `-`
 * 会得到 `D:\Program Files\tty7.jsonl`，`path.join(HISTORY_DIR, name)` 拼出
 * `~\.pi\folder-history\D:\Program Files\tty7.jsonl`，`appendFileSync` 以 ENOENT 失败。
 * 上游 `pi-command-history` 已经用下面这套规则处理过，这里对齐：
 *   - `/` 和 `\` 都换成 `-`
 *   - 去掉 `:`（盘符）
 * 于是 `D:\Program Files\tty7` → `D-Program Files-tty7.jsonl`，落在 HISTORY_DIR 下面。
 */

/** Turn a working directory into a single filename segment (no separators, no drive letter). */
export function historyFileName(cwd: string): string {
	return cwd.replace(/[\\/]+/g, "-").replace(/:/g, "");
}
