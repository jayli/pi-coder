/**
 * voice/status.ts — 口播流程在 statusline 上的指示（保留 key 与文案）。
 *
 * 不 import pi / pi-tui：这是**跨扩展契约**的两半之一（另一半在 `statusline/line.ts`，
 * 它直接 import 这里的常量，所以两份字面量永不漂移 —— 与 `background-tasks/status.ts`
 * 的 `STATUS_KEY`、`plan-mode/render.ts` 的 `STATUS_KEY` 同一套取舍：同仓库、同目录树、
 * 一起安装）。
 *
 * ## 为什么走 setStatus 而不是 setWorkingMessage
 *
 * 用户要的位置是「thinking 和 bash 等字样显示的地方」= statusline **主行的末段**
 * （`formatStateSegment`）。那个位置由 statusline 扩展渲染，而 voice 扩展不该去抢
 * `setWorkingMessage`（那是 spinner 那一行的文案，由 `working-indicator` 扩展按自己的
 * 状态机驱动，两个扩展写同一处会互相顶掉）。所以：**voice 只发布状态，statusline 决定
 * 它渲染在主行末段**。这样两个扩展各管各的那一半，互不覆写。
 *
 * ## 生命周期（用户 2026-10-04 定）
 *
 * 「对话结束开始发起摘要请求」点亮 → 「口播结束」熄灭。具体由 `voice/index.ts` 在三处发布：
 * 摘要请求发出的那一刻点亮（这是**最早**的时机，早于模型回包）、真正播放时保持点亮
 * （覆盖「摘要关掉 / 摘要失败退回兜底文本」那些路径）、播放结束或被打断时熄灭。
 *
 * 小喇叭 `🔊` 走的是另一个 key（`voice`，注册在 statusline 第二行的扩展 status 区），
 * **本文件与它无关、也不改它** —— 用户 2026-10-04 明确要求「小喇叭的显示逻辑不变」。
 */

/**
 * statusline 主行末段的保留 status key。
 *
 * `line.ts` 的 `formatStateSegment` 读它（命中就显示 `reporting`，压过工具名与 thinking），
 * `formatExtensionStatuses` 则把这个键从第二行的扩展 status 列表里**跳过** —— 否则同一件事
 * 会在两处各显示一遍。键名是跨文件的硬契约，改名要同时改 statusline 与两边的测试。
 */
export const REPORTING_STATUS_KEY = "voice-reporting";

/** 主行末段显示的文案（小写，与 `thinking` / `bash` 同一档：都是小写的状态词）。 */
export const REPORTING_LABEL = "reporting";
