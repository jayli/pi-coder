# unknown-tool-tree

**没有工具定义**的工具调用块的树形展示。模型偶尔会把工具名写错（2026-10-20：把 `codemode`
写成 `codemap`），pi 在 `prepareToolCall` 里找不到它，直接返回
`{ content: [{ type: "text", text: "Tool codemap not found" }], isError: true }` —— 于是这条调用
没有任何 `ToolDefinition`，落到 pi 的通用兜底壳：红底（`toolErrorBg`）、上下各一行空行、
`title` + 多行 JSON 参数平铺。

本扩展把这一类块的观感换成与 bash / read / codemode / mcp / tool_search 同一张列位表。

## 形状

折叠态（默认）：

```
• codemap code="async function main() {\n  const a = await tools.read({ path: \"tests/weapon…"
  └ Tool codemap not found
```

`ctrl+o` 展开态：参数逐行铺开（`code:` + 缩进后的值，保留真实换行），错误句仍在末行的 `└` 上。

| 元素 | 列 |
| --- | --- |
| 圆点 `•` | 0 |
| 工具名 / `│` / `└` | 2 |
| `│ ` `└ ` 之后的正文 | 4 |

- **无底色**、**无上下边界空行**（`renderShell: "self"`，与 bash / memory / plan / mcp 同一手法）。
- **圆点三态**：执行中 `dim`、成功 `toolDiffAdded`（与 bash 成功圆点同槽）、失败 `toolDiffRemoved`。
- **失败正文整段红**（`.pi` 主题是 `removedRed #e27878`）—— 底色没了之后由红色圆点与红字承担结局信号。
- 成功正文走 `toolOutput`：成功路径真会出现（恢复会话时工具所属扩展 / MCP server 还没连上，
  历史里那条成功结果就由本渲染器画）。
- 折叠态标题行**永远单行**：参数压成 `key=value` 并按可用宽度截断（CJK 记 2 列）。
  这是刻意与 pi 兜底壳不同的地方 —— 后者先裁固定 100 字符再交给 pi-tui 折行，块高会随参数漂移。
- 折叠态正文超过 10 视觉行时截断并附 `… (N more lines, ctrl+o to expand)`；`└` 跟着提示行走。

## 判定：只接管「next() 给不出任何渲染器」的块

`pi.registerToolRenderer((toolName, next) => …)` 的解析器链按扩展加载顺序串联，`next()` 先走完
剩下的解析器、最后是**已注册工具的定义**。三种情形：

| 情形 | `next()` 给出 | 谁画 |
| --- | --- | --- |
| 有自带渲染器（bash / read / codemode / mcp__* / tool_search / memory_read …） | 带 `renderCall`/`renderResult` 的对象 | 它自己 —— 本扩展**逐字节原样交下去** |
| 注册了但没自带渲染器（`pi-subagents` 的 `contact_supervisor` 只有 `execute`+`parameters`） | 没有渲染器的 definition | pi 兜底壳 → **本扩展接管** |
| 根本没注册（`codemap` 这种写错的名字） | `undefined` | pi 兜底壳 → **本扩展接管** |

判据是「`next()` 给不出**任何**渲染器」，不是「`next()` 返回 undefined」—— 只看后者会漏掉第二类，
那些块会继续显示 red 底 + 上下空行（用户 2026-10-20 要的是「任何出错的部分都走这个兜底」）。

所以它对**任何**写错的工具名、以及任何交给 pi 兜底壳的工具自动生效；将来别的扩展给某个名字补上
渲染器也不会被盖过（它们排在链上，`next()` 就先拿到）。`index.test.ts` 用 pi 内置 `read` 渲染器
做了逐字节对照。

## 开关

`PI_UNKNOWN_TOOL_TREE=off` 关闭（注册期读一次，与 `PI_CODEMODE_TREE` / `PI_MCP_TREE` 同一约定）。
关闭后这类块回到 pi 的兜底壳 —— **纯回退**，本扩展没动过任何工具注册。

## 测试

```bash
node --test clients/pi/extensions/unknown-tool-tree/{render,index}.test.ts
```

`render.test.ts` 是纯逻辑（列位、参数装配、树前缀）；`index.test.ts` 端到端跑真 pi 加载器 +
真 `ToolExecutionComponent`，fixture 就是用户报的那个 `codemap` 块（含对照组：不接管的红底、
注册过的 `read` 逐字节不变）。
