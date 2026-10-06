# Pi Coding Agent 全局配置模板

pi（`@earendil-works/pi-coding-agent`）的全局配置与扩展脚本快照，作为本机 pi 环境的模板标准。
本机装的是 pi **1.0.3** + `pi-web-access` **0.36.0** + `pi-subagents` **0.76.0**
+ `superpowers` **6.4.2**（git 包，见下文）。

pi 是接入本网关的第四个客户端：它走 `/v1/messages`（Anthropic Messages API），因此和 Claude Code
一样绑定 **claude 路由**的模型。快照里只有一个自定义 provider `litellm-any`，指向本机 996 端口的
adapter（局域网别的机器用则换成网关主机 LAN IP）。

与 `clients/codex`、`clients/opencode` 那几个 profile skill 不同，这里**没有安装脚本**：
只有文件快照和这份说明，装回本机靠手动 `cp`。

## 目录映射与安装

| 本仓库 | 真实路径 |
| --- | --- |
| `AGENTS.md` | `~/.pi/agent/AGENTS.md`（机器全局行为规则） |
| `AGENTS.core.md` | `~/.pi/agent/AGENTS.core.md`（`AGENTS.md` 的蒸馏版核心铁律，约 7.8KB；`extensions/core-rules/` 读它并中途重注入。**缺失则扩展静默跳过**） |
| `config/settings.json` | `~/.pi/agent/settings.json` |
| `config/models.json` | `~/.pi/agent/models.json` |
| `config/mcp.json` | `~/.pi/agent/mcp.json`（MCP 服务器，**pi 内置** `builtin:mcp` 读它；不装就没有 MCP 工具） |
| `config/web-search.json` | `~/.pi/agent/web-search.json`（`pi-web-access` 自己的配置） |
| `config/voice.json` | `~/.pi/agent/voice.json`（语音播报：音色 / 语速 / 字数上限 / 是否播问句 / 口播摘要四项；摘要默认每一轮都做。**阿里云口播的 Key 不在这里** —— 它单独放在 `~/.config/litellm-any/apikey.json` 的 `aliyunKey`，用 `/voice key sk-xxx` 设置，不配就走系统 `say`） |
| `config/pi-statusline.json` | `~/.pi/agent/pi-statusline.json`（**已失效的遗留配置**：旧 npm statusline 包专用，留着只为随时换回那个包） |
| `extensions/*.ts` | `~/.pi/agent/extensions/` |
| `extensions/<name>/` | 同上（子目录形式：`<目录>/index.ts` 作入口，pi 支持 `extensions/*/index.ts`） |
| `extensions/sandbox-boundary/` | 同上（非 shell 工具的删除边界闸：只拦 apply_patch 的 Delete File，write/edit 不拦；与 bash 沙箱同一道白名单与同一套三档授权） |
| `themes/*.json` | `~/.pi/agent/themes/`（pi 全局主题目录） |

在仓库根目录执行：

```bash
cp clients/pi/AGENTS.md                 ~/.pi/agent/AGENTS.md
cp clients/pi/AGENTS.core.md            ~/.pi/agent/AGENTS.core.md      # core-rules 扩展读的蒸馏版核心铁律（不装则该扩展静默不注入）
cp clients/pi/config/settings.json      ~/.pi/agent/settings.json
cp clients/pi/config/models.json        ~/.pi/agent/models.json
cp clients/pi/config/pi-statusline.json ~/.pi/agent/pi-statusline.json   # 可选：只有要回退到 npm statusline 包时才需要
cp clients/pi/config/mcp.json           ~/.pi/agent/mcp.json               # 可选：不装就没有 MCP 工具（见下文）
cp clients/pi/config/web-search.json    ~/.pi/agent/web-search.json
cp clients/pi/config/voice.json         ~/.pi/agent/voice.json           # 语音播报配置（不装则用内置默认：Tingting / 500 字 / 播问句 / 每轮都做口播摘要，模型 deepseek-flash-qd；阿里云音色 aliyunVoice 默认 longanhuan_v3.1，方言靠 aliyunInstruction 控制、默认空。可选：用 /voice key sk-xxx 把阿里云 Key 写进 ~/.config/litellm-any/apikey.json 的 aliyunKey，配了口播就走阿里云，不配就走裸机 say）
cp clients/pi/extensions/*.ts           ~/.pi/agent/extensions/
cp -R clients/pi/extensions/tool-diff          ~/.pi/agent/extensions/   # tool-diff.ts 的纯排版模块（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/prompt-editor     ~/.pi/agent/extensions/   # prompt-editor.ts 的纯逻辑模块（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/simple-task        ~/.pi/agent/extensions/   # 轻量任务清单（与 plan-mode 无耦合，可单独装）
cp -R clients/pi/extensions/recap              ~/.pi/agent/extensions/   # 依赖上一行的 gap.ts（跨目录相对 import）
cp -R clients/pi/extensions/rewind             ~/.pi/agent/extensions/
cp -R clients/pi/extensions/statusline         ~/.pi/agent/extensions/
cp -R clients/pi/extensions/auto-default-model ~/.pi/agent/extensions/
cp -R clients/pi/extensions/startup-logo       ~/.pi/agent/extensions/   # 顶部 pi 印记 logo（**静默 500ms 后做 1 秒对角波入场动画**：自右向左扫过 4×4 格子、从另一色相渐显到 accent；右侧标题行/cwd 跟着本行渐显；落定后与旧的静态 logo 逐字节相同）+ 标题行带模型/推理档位（每行缩进一格、不顶格；**印记下方留一条空行，提示行与说明段之间不留**）+ 说明段尾部是 `pi-coder` 三行字形（`@bachi/` 后面；**字形与句子同色、走 dim 不再用 accent**；< 67 列退回原句）+ 剪掉启动清单全部五段（只留诊断段）
cp -R clients/pi/extensions/ask-user-question  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/subagent-log-guard ~/.pi/agent/extensions/
cp -R clients/pi/extensions/fenceless-code-block ~/.pi/agent/extensions/   # 子目录形式：纯逻辑在 render.ts（不 import pi，可单测）
cp -R clients/pi/extensions/user-message-bar   ~/.pi/agent/extensions/   # 同上：纯逻辑在 bar.ts
cp -R clients/pi/extensions/bash-command-collapse ~/.pi/agent/extensions/  # bash-command-collapse.ts 的伴生模块（sandbox.ts / allowlist.ts / abbrev-path.ts 是 live 代码，不是测试）与端到端渲染测试（无 index.ts，不会被当成扩展）
cp -R clients/pi/extensions/working-indicator  ~/.pi/agent/extensions/
cp -R clients/pi/extensions/plan-mode          ~/.pi/agent/extensions/   # Claude Code 式 plan mode（改绑 shift+tab，见下文）
cp -R clients/pi/extensions/sandbox-boundary   ~/.pi/agent/extensions/   # 删除边界闸（apply_patch 不走 shell，补 bash 沙箱管不到的那部分；write/edit 不拦；与 bash 沙箱共用三档授权与持久白名单）
cp -R clients/pi/extensions/voice              ~/.pi/agent/extensions/   # 语音播报最终结论（macOS say；配了阿里云的 Key 则走 qwen-audio-3.1-tts-flash；结论的 turn_end 立即触发、agent_settled 兜底、单槽后台播、可打断；口播期间在 statusline 主行末段显示 reporting）
cp -R clients/pi/extensions/core-rules         ~/.pi/agent/extensions/   # 全局 AGENTS.md 蒸馏版的中途重注入（纯判定在 decision.ts）
cp -R clients/pi/extensions/verify-loop        ~/.pi/agent/extensions/   # 验证闭环 + /goal 评估器（CC Stop hook / goal 同构；import ../recap/subagents.ts，依赖上一行已装 recap/）
cp -R clients/pi/extensions/memory             ~/.pi/agent/extensions/   # 类 CC auto-memory（索引+正文，索引机械派生；见下文）
cp -R clients/pi/extensions/codemode-tree      ~/.pi/agent/extensions/   # codemode 工具块的树形展示（捕获内置定义换渲染器；settings 需配 `-builtin:codemode`，见下文）
# destructive-guard 已于 2026-09-24 从 live 退役（被 seatbelt 能力边界取代）、2026-09-27 从仓库删除（完整实现在 git 历史里）
mkdir -p ~/.pi/agent/themes && cp clients/pi/themes/*.json ~/.pi/agent/themes/

pi install npm:pi-web-access                # 外部包；装完必须配 web-search.json（见下文）
pi install npm:pi-subagents                 # 同上；默认零配置可用（watchdog 是 opt-in，模板 settings.json 已带配置，见下文 watchdog 一节）
pi install git:github.com/jayli/superpowers # 带扩展的技能包（见下文）；装完由 settings.json 的 packages 字段声明，pi 自己拉到 ~/.pi/agent/git/
```

四个容易踩的点：

- 上面几条 `cp` 会**整体覆盖**目标文件，没有脚本帮你合并。目标机器上有要保留的自定义字段
  （别的 provider、别的模型、别的全局规则）就先手动比对再覆盖。
- `~/.pi/agent/themes/` 是按需目录，新机器上不存在，必须先 `mkdir -p`。
- **`extensions/tool-diff/` 里没有 `index.ts`**：pi 只加载 `extensions/<name>.ts` 与
  `extensions/<name>/index.ts`，找不到入口就跳过整目录 —— 所以它不会被误当成扩展。
  但只装 `extensions/*.ts` 而不装这个目录，`tool-diff.ts` 会 import 失败。
- **`recap/` 必须和 `simple-task/` 一起装**：`recap/index.ts` 里
  `import { widgetGaps } from "../simple-task/gap.ts"` —— 跨扩展相对 import 是刻意的取舍
  （两个扩展同仓库、同目录树、一起安装，省掉一份重复实现）。

生效方式：扩展改完在 pi 里执行 `/reload` 即热加载（`~/.pi/agent/extensions/` 是自动发现目录）；
`settings.json` / `models.json` / `AGENTS.md` 需要**重开 pi**（启动时读一次，`/reload` 也不管用）。
`AGENTS.core.md` 是例外：`core-rules/` 在每次 `before_agent_start` 里现读，改完**下一条 prompt 就生效**，
不用 `/reload` 也不用重开（内容 hash 变了会自动带替换声明重注入）。

## settings.json / models.json 的要紧处

字段的取值和注释直接看那两个文件，这里只记扫不出来、改错了会静默坏掉的东西。

**快照与本机真实配置的已知差异（三处，都是刻意的）**：`models.json` 的 `baseUrl`（快照写
`127.0.0.1` 假定网关在本机，本机那份指向 `192.168.124.1` —— 从局域网别的机器用就换成网关主机
LAN IP）；`settings.json` 的 `defaultModel`（会被 `auto-default-model/` 在换模型时随手改写，
所以真实值只是「上次用的模型」）；以及 `settings.json` 的 `extensions` 字段（见文末）。

**`defaultTools` 是纯白名单，不支持 `+name`**（2026-10-06 实测，改它之前必读）：取值里的每一项都拿去做**按名精确匹配**，匹配不上就丢，不报错也不告警。所以 `["+codemode"]` 的含义是「**哪个内置工具都别开**」而不是「在默认之上追加 codemode」—— 这个坑在本仓存在了很久（`+` 只在 `extensions` / `resources` 这类字段里是 force-include，与工具选择无关，两处语法容易混）。它当时没炸，是因为 `read` / `bash` / `edit` / `write` 都被本机扩展**重新注册**过（`read-path-collapse.ts` 注册 `read`、`bash-command-collapse.ts` 注册 `bash`、`tool-diff.ts` 注册 `edit`/`write`），而扩展工具走 `includeAllExtensionTools` 无条件放行 —— 这些工具当时是以「扩展工具」而非「内置工具」的身份活着的。代价是任何**没被扩展接管**的内置工具（`grep` / `find` / `ls`）即使写进 `defaultTools` 也不生效。现在的值是显式列全：`["read", "bash", "edit", "write", "grep", "find", "ls", "codemode"]`。**改完必须验**：`SettingsManager.getDefaultTools()` 只回显原始字符串，看不出解析结果 —— 要用 `createAgentSession({cwd, agentDir})` 再读 `session.agent.state.tools` 的**名字列表**才算数（`clients/pi/config/settings.json` 与本机 `~/.pi/agent/settings.json` 两份都要同步，见文末快照维护约定）。

**`litellm-any` 登记六个模型**：`qwen3.8-df-qd-claude`、`deepseek-flash`、`qwen3.8-max`、
`qwen3.8-flash`、`deepseek-flash-qd`、`Qwen3.8-Max-DogFooding`。这是**原样快照**：网关的 claude
路由还有三条没登记（`qwen3.8-df-id-claude`、`glm-5.3`、`glm-5.3-flash`），要加别的模型就按同样
形状追加。

- **模型名是路由键**：`model.id` 原样透传给 LiteLLM，必须和 `adapter/adapter.config.json` /
  `gateway/config.yaml` 里注册的名字一致，没有别名或改写。
- **`thinkingLevelMap` 里置 `null` 的档位不会出现在 `/thinking` 选择器里**，值就是发给后端的档位
  字符串。pi 走 adaptive thinking（`output_config.effort`），litellm 的 `/v1/messages` 转换会把它
  映射成 `reasoning_effort`。
  **只有 pi 专属路由 `Qwen3.8-Max-DogFooding` 上的档位真的生效**：config.yaml 给它声明了
  `allowed_openai_params: [reasoning_effort]`（否则 `drop_params: true` 会把客户端档位当不支持
  参数丢掉）加 `model_info.supports_xhigh_reasoning_effort`（否则 litellm 把 xhigh 归一化成 high）。
  `deepseek-flash` 走 pass-through 的 anthropic 原生 provider，pi 的 `output_config.effort` 本来
  就能直接透传（实测：config 的 `extra_body` 在这条路上是惰性的，不进请求体）。
  剩下四个 `qwen3.8-max` / `qwen3.8-flash` / `qwen3.8-df-qd-claude` / `deepseek-flash-qd`
  与 Claude Code 共用 claude 路由（自定义 provider），那些路由的 `extra_body` 仍写死强度
  且最后合并、优先级最高，所以 pi 在这四个上的档位**依旧被网关值覆盖** ——
  好在写死值恰好都是各自最高档，体感无变化。网关侧的透传能力本身已经打通
  （qoder agent 路径会把档位写进请求模板的 `parameters.reasoning_effort`），只是被这几条
  路由的写死值掩住了；要让 pi 完全接管，得先解除 claude 路由的写死。
  别照 `~/.zshrc` 里那句 `CLAUDE_CODE_EFFORT_LEVEL=max` 抄成 `max`：那是 Claude Code 的档位
  体系，qwen 系没有 `max` 档。
- **只有 `qwen3.8-max` / `qwen3.8-flash` / `deepseek-flash-qd` 声明 `input: ["text","image"]`**：
  qoder 目录里 `qmodel_38max` / `qfmodel` / `dfmodel` 三条是 `is_vl: true`，三条都实测过发纯色 PNG
  能被正确识别。注意 `dfmodel` 的识图**依赖网关侧 2026-09-22 的修复**：在那之前 `read` 这类工具返回的图
  会走 tool 消息、被内联成 base64 文本（不是 image part），读进 5 张大图后每次请求都被 qoder 网关
  400 顶回来；修好后 tool 结果的图会另起一条 user 消息按真图片发（详见根目录 `CLAUDE.md` 的
  「tool 结果里的图片」一条）。其余条目别顺手补 image —— idealab 后端吃不下，同一张图发过去是 HTTP 400。
- `settings.json` 的 `modelThinkingLevels` 把 `deepseek-flash` 与 `deepseek-flash-qd` 钉在 `max`
  （这两个的 map 里 `max` 有真值），其余跟随全局 `xhigh`。
- **`subagents.defaultModel: "inherit"`**（2026-09-28 加）：让所有 subagent 显式跟随主会话模型。
  builtin agent 本来就没有 frontmatter model、默认就继承父会话模型（pi-subagents issue #266），
  所以这行对它们是 no-op；写下来的价值是覆盖以后新增的自定义 agent 的 model 声明，
  把「跟随主模型」的意图钉在配置里。它**管不到 watchdog** —— 那是 `subagents.watchdog.main.model`
  独立配置（见下文 watchdog 一节，本机钉在 `deepseek-flash-qd` 取它快）。
- **`subagents.modelScope`（2026-09-29 加；`allow` 于 2026-09-30 扩项）**：把 subagent 能用的模型收成
  白名单。`enforce` 与 `strict` **两个都要**——只写 `enforce` 时越界模型只警告不拦（官方原话：
  "By default, models from agent frontmatter, `subagents.defaultModel`, or the inherited parent session
  model only warn and remain available"），加 `strict: true` 才真拒绝，且**连继承来的模型也一并检查**。
  `allow` 里 `inherit` 是字面量（= 当前父会话模型），其余项对解析后的 `provider/id` 做通配
  （只有 `*` 特殊、大小写不敏感）。本机现在是 `["inherit", "litellm-any/deepseek-flash-qd"]` ——
  第二项是 2026-09-30 加的，给显式指定 `deepseek-flash-qd` 的子代理开一条口子（不写它的话
  `inherit` 仍能跑，但一旦某次调子代理时显式点名 `deepseek-flash-qd`，strict 下会被拦成硬错）。
  **它只管子代理**：检查点在 `src/runs/shared/model-resolution.js`（`enforceModelScopes`），而
  watchdog 走自己的 `src/watchdog/model-selection.js`，不经过这条路径 —— 所以 `watchdog.main.model`
  不用也不该为它加白名单项。
- `doubleEscapeAction: "none"` 是**把内置的双击 Esc 动作关掉**，交给 `rewind/` 接管。
  该扩展会**吃掉第二次 Esc**，所以即使写回 `tree` 也不会弹 pi 的 tree；写成 `none` 只是把意图写明。
  要恢复内置行为：删掉 `rewind/` 再改回 `"tree"`。
- `tuiMode: "regular"`、`steeringMode`、`markdown.mermaid` 三项写的都是 pi 的默认值，
  本机只是显式写了出来。
- `followUpMode: "all"` 是**刻意的非默认值**（pi 默认 `one-at-a-time`）：排队中的 follow-up 消息
  一次性投递成**一轮**，而不是每条各起一轮。动机是后台任务通知：当主 agent 忙于别的事时，
  多条终态通知会被 `deliverAs: "followUp"` 推进队列（`background-tasks/index.ts`），默认模式下
  每条都要单独唤醒一轮模型（2026-09-30 实测：9 条通知连发 38 秒、各起一轮）。代价同源——它也
  批量化**人类**用 `alt+enter` 排队的 follow-up 消息；想要逐条投递就删掉这一项。

### `litellm-any` provider 的两个 compat flag

两个都**只对自定义 provider 能开**（真 Anthropic 会拒绝）：

```jsonc
"compat": {
  "allowEmptySignature": true,     // 上游会发空签名的 thinking 块并要求回放时原样带回；
                                   // 关掉的话 pi 会把这种块降级成纯文本
  "forceAdaptiveThinking": true    // 让 pi 发 thinking.type="adaptive" + output_config.effort，
                                   // 而不是旧的 budget 形状
}
```

### 没有网关别名的两条：`deepseek-flash` 与 `Qwen3.8-Max-DogFooding`

其余四条在 `gateway/config.yaml` 里都是别名（`qwen3.8-max` → `qoder/qmodel_38max`、
`qwen3.8-df-qd-claude` → `qoder/mode-24b28ef…` 这种），名字由网关自己定义。这两条不一样：
**上游认的就是这个名字本身** —— `deepseek-flash` 直连 DeepSeek 自家的 Anthropic API（plain
pass-through），`Qwen3.8-Max-DogFooding` 则对应 `gateway/config.yaml` 里那条刻意只用 litellm
内置设施的对照路由：**不带 `custom_llm_provider`**（即不过 `idealab-openai` 那套自定义 provider，
也就没有 tool_choice 抹除与 `\x01` marker 注入），`adapter/adapter.config.json` 里也**刻意不登记路由**，
于是 `adapterMode` 落回 `pass-through` —— 端到端只是转发，实测 thinking 与工具调用都完整保留
（`thinking` 块 + `tool_use` + `input_json_delta`）。

写这两条时要记住 **`model.id` 会被 pi 原样当成请求体的 `model` 字段发出**（`pi-ai` 的 `buildParams`），
所以 `id` 必须是上游认得的名字，不能起别名；pi 的 `name` 只用于 `--model` 匹配，而 `/model`、
`--list-models` 与 footer 显示的是 `id`。

### 主题文件

`settings.json` 的 `theme` 指向 `~/.pi/agent/themes/<name>.json`，**文件名必须等于 JSON 里的
`name` 字段**（`loadThemeJson()` 拼 `${name}.json` 找文件）—— 改主题名要**同时**改文件名、`name`
和 `settings.json` 的 `theme` 三处，只改一处的话要么选择器显示旧名、要么 `theme` 值落空。

- `pi-coder-catppuccin.json` —— 移植上游 [bacnh85/pi-extensions](https://github.com/bacnh85/pi-extensions)
  的 Catppuccin Mocha 皮肤。与另两套一样全走 `vars`（`bgAnsi()` 对整数会直接发
  `48;5;N`，所以上游遗留的唯一一个 256 色索引 `toolPendingBg: 233` 已先改成 hex 字面量、
  后来按要求整个清空成 `""`，现在三套皮肤都没有整数字面量）。本仓对它的存心 deviation 一处：
  `thinkingXhigh` / `thinkingMax` 不再走调色板的 `blue`，与另两套皮肤统一成中性灰 `#626262`
  （新增 `vars.thinkingGrey`）—— 理由同下面 ayu 的第 2 条。**pi-coder-1337 按你的要求锁到 `#696969`**，
  catppuccin 与 ayu 仍是这个 `#626262`，三套皮肤的最高两档分成了两档：`#626262`（catppuccin / ayu）
  与 `#696969`（1337）。
- `pi-coder-ayu.json` —— 移植 [iodic/pi-ayu-themes](https://github.com/iodic/pi-ayu-themes) 的
  `ayu-dark`（官方 Ayu 调色板），**格式照 `pi-coder-catppuccin.json` 抄**：同样的
  `$schema` / `vars` / `colors` / `export` 四段，`colors` 的 key 与键序照 pi-coder-catppuccin 抄（pi-coder-ayu 多一个
  自定义的 `bashOutput`，所以是 55 个 key），色值全部走 `vars`。上游皮肤已经定义的 51 个 token 里 **48 个逐字节同值** —— 这条可以用代码验：
  用 `loadThemeFromPath()` 同时解析两份文件，对同名 token 比 `getFgAnsi()` / `getBgAnsi()`；
  本仓只补了它没定义的四个：`toolDiffAddedBg` / `toolDiffRemovedBg`（`tool-diff.ts` 要读的行
  底色，上游没有）、`thinkingMax` 与 `bashOutput`（bash 输出正文的独立颜色槽，见下）。自定的
  色值一共五处：两个 diff 行底色、代码字符串的绿、最高两个思考档的边框灰、bash 输出灰（第六处
  原本是按你要求单独调过的 pending 态卡片底色 `toolPendingBg`，现已清空，见下面第 3 条）。两个 diff 行底色是 `#1d241c`（bg 朝 `green` 混 10%）与 `#321d23`（朝 `red` 混 18%）——
  比例是反推出来的：让两侧行底色相对工具盒底色的亮度比都落在 ≈1.15（pi-coder-catppuccin 是 1.15 / 1.14），
  同时 `tool-diff.ts` 那个 30% 行内混色之后正文还有 4.0:1 / 5.6:1。绿侧只能给到 10% 是因为
  Ayu 的绿 `#AAD94C` 很亮，行内混色天然吃掉更多对比度。

  对上游**三条存心 deviation**：

  1. 上游把 `toolDiffAdded`（diff 增加行的前景，行号与 `+` 号跟它同色）与 `syntaxString`
     （代码文本里的字符串）**指向同一个绿 `#AAD94C`**，两边亮得发同一种光；本仓把 `syntaxString`
     拆出去指向自己的 `stringGreen` `#67a567`（更沉的墨绿，差在色相与亮度：代码块底色上 6.2:1，
     原值 `#AAD94C` 是 11.1:1；先定的是 `#73a073`，后按你要求换成 `#67a567` 更纯一点的绿），
     diff 侧保留上游的 `#AAD94C`（行底色上 9.6:1）。副作用：新绿与 `muted`（注释灰 `#6B7385`）
     亮度接近（1.62:1），字符串与注释主要靠色相区分，嫌分不开就往 `#7FAE7F` / `#8CB884` 方向拾一点。
  2. 思考档边框：`thinkingXhigh` 上游是红 `#D95757`，本仓与 `thinkingMax` 一起改成中性灰
     `#626262`（`vars.thinkingGrey`）—— 编辑器边框按当前档位取色，本机 `defaultThinkingLevel`
     正是 xhigh，红边框读着像报错。代价：最高两档不再靠更热的颜色表达，只靠明暗差 —— 这个灰对
     底色 3.12:1，比 `thinkingMinimal` 的 `#6B7385`（4.00:1）暗一档、比 `thinkingOff` 的
     `#515868`（2.67:1）亮一档，与 minimal 相差 1.28:1（看得出但偏淡），要再拉开就继续调深/调浅。
  3. `toolPendingBg`：上游是 `#1b1c1d`（与它的 `userMessageBg` 同一个值），本仓先按你要求改成中性
     `#1f1f1f`、后又调成 `#171717`，**现在三套皮肤统一清空成 `""`**（终端默认底色）—— 只影响 pending 态
     的工具卡片底色，`userMessageBg` / `customMessageBg` 走它们自己那个仍为 `#1b1c1d` 的变量，不受影响；
     它的 `vars` 条目（`#171717` / `#1b1c1d`）与三套皮肤里其他无人引用的变量一起删掉了，文件里已不留痕。

  整体观感是「近黑蓝底 + 高对比亮色」，
  正文在面板上 8.4-9.2:1（pi-coder-catppuccin 12.7）；代价是 Ayu 自己的灰阶偏暗：`muted` `#6B7385`
  在面板上 3.3-3.8:1、`dim` `#515868` 2.2-2.6:1（pi-coder-catppuccin 分别 ≈4.9 / 4.7），注释、
  `Think:` 行、设置页提示因此明显更淡 —— 这是上游皮肤自己的取值（与 `ayu-dark` 逐字节一致），
  嫌淡只需调 `vars.muted` / `vars.dimmed` 两个变量。上游那个包（`iodic/pi-ayu-themes`，自带
  `ayu-dark` / `ayu-mirage` / `ayu-light` 三套变体）**已按你要求卸载**（`pi remove npm:pi-ayu-themes`，
  三份变体文件随之从 `~/.pi/agent/npm/` 消失，`/theme` 里不再有这三个名字），所以本机的 Ayu 皮肤
  只剩本仓这份 `pi-coder-ayu.json` —— 它是同一套 dark 调色板的「可按文件改」版本；要回到上游三套变体只需
  重新 `pi install npm:pi-ayu-themes`。
- `pi-coder-1337.json` —— **当前在用**（`settings.json` 的 `theme` 指向它）。移植 Codex CLI 的**内置语法主题 `1337`**（`~/.codex/config.toml` 的
  `[tui] theme = "1337"` 就是它）。1337 是 Mark Herpich 的 Sublime 配色，被 two-face 打包进
  Codex 二进制的 32 套主题之一。取色方式可复核：从本机那份 codex 可执行文件里解出嵌入的 theme blob
  （`zlib` 解压后是可读的 scope→色值表），再与上游 `1337.tmTheme` 逐条对账 —— 两边 48 个有名 scope
  全部命中，其中 37 个逐字节同值，其余 11 个是 Codex 侧把该 scope 合并成 `None`（不单独着色、
  继承父级）—— 两边都没有出现过「同一 scope 两个不同色值」的情况，所以下面那些值不是「照着观感配的」。
  1337 本身只有**代码语法**一层 —— `background` `#191919` / `foreground` `#f8f8f2` / `caret` `#f8f8f0` /
  `selection` `#515151` / `lineHighlight` `#3D3D3D55` / `invisibles` `#3B3A32`，加 **48 个有名 scope
  条目、28 个不同前景色**，**没有任何 UI 槽位**。所以 pi 那 59 个颜色分两类来源：语法槽位按下表直译，
  UI 槽位在这 28 个色值里挑（挑不到就用 `foreground`），只有 12 个不是 1337 的色（见本节末）。

  语法槽位（`colors` 键 ← 1337 scope，全部取上游字面值；pi 只有 8 个语法槽，所以要合并）：

  | pi 槽位 | 1337 scope | 色值 |
  | --- | --- | --- |
  | `syntaxComment` | `comment` | `#6d6d6d` |
  | `syntaxString` | `string` | `#fbe3bf` |
  | `syntaxNumber` | `constant.numeric` | `#fdb082` |
  | `syntaxVariable` | `variable` | `#e9fdac` |
  | `syntaxKeyword` | `keyword`（`storage` 与 `entity.name.tag` 同值） | `#ff5e5e` |
  | `syntaxFunction`、`syntaxType` | `entity.name.function` / `entity.name.class` / `entity.other.inherited-class`（三者同值） | `#8cdaff` |
  | `syntaxOperator` | **无对应 scope** → 落到 `foreground` | `#f8f8f2` |
  | `syntaxPunctuation` | `punctuation.definition.*` | `#ffffff` |

  两处合并的取舍要交代：① 1337 把「函数名 / 类名 / 继承类」（`#8cdaff`）与 `support.function`
  库函数（`#6699cc`）分成两支，pi 只有一个 `syntaxFunction` —— 取 `#8cdaff`，它是前三者的共同值，
  `syntaxType` 也跟它（在 1337 里类名与函数名本来就同色）；`#6699cc` 没浪费，转手给了 `mdLink`。
  （`support.class` / `support.type` 在 1337 里是另一个米色 `#fbe3bf`，与字符串同值，没有采用 ——
  让 `syntaxType` 跟类名走才合 1337 自己的分工。）② `mdHeading` **没有用** 1337 的 `markup.heading` `#75715e` ——
  那个值在 `#191919` 上只有 3.58:1，而且 pi 的 `mdHeading` 不只画 markdown 标题，还画启动页那份
  「已加载资源」清单的分组标签（`interactive-mode.js` 的 `addLoadedSection` 默认色；整份清单已被
  `startup-logo/` 剪掉，见该扩展文件头 —— 所以这个槽位在启动页上其实已经不出现了，但 markdown 标题仍在用），
  太暗读不清；
  改用 `constant.language` 的橙 `#ff8942`（7.46:1）。

  整体对账（把 `colors` 的值展开 `vars` 后逐一对回 1337 的调色板）：**59 个槽位里 46 个取自 1337、
  12 个不是、1 个是空串** —— 12 个已在本节逐一点名（5 个指定 + 6 个锁死 + 1 个 `error` 统一），
  没有一处「随手拿个相近色」。

  非语法槽位全部从 1337 自己的色板上取（括号里是对 `#191919` 的对比度）：`border` / `selectedBg` ←
  `selection` `#515151`、`borderMuted` ← `invisibles` `#3b3a32`、`warning` ← `constant.numeric` `#fdb082`、
  `success` ← git-gutter 的 `#a6e22e`（1337 自己给「插入」的用色）、`toolTitle` 与
  `syntaxFunction` 共用 `#8cdaff`（11.38:1）、`toolOutput` ← `variable.parameter.function` `#d0d0d0`（11.40:1）、
  `mdListBullet` ← `storage.type` `#fbdfb5`、`bashMode` ← `variable.parameter` `#fc9354`、
  `customMessageLabel` ← PHP 命名空间 `#ffb2f9`。
  思考档走 1337 自己的冷→暖阶梯：`thinkingOff` = `invisibles`、`thinkingMinimal` = `selection`、
  `thinkingLow` ← `support.function` `#6699cc`、`thinkingMedium` ← `entity.other.attribute-name` `#97d8ea`、
  `thinkingHigh` ← `variable.language.*` `#d699ff`，最高两档锁死（见下）。

  **六个锁死槽位是照你指定的值写死的**（不是 1337 的色）：
  `toolDiffAdded` `#8bc391` / `toolDiffRemoved` `#e27878` / `toolDiffAddedBg` `#1c241b` /
  `toolDiffRemovedBg` `#2e1c21`（diff 行前景 + 整行底色四件套）、`thinkingXhigh` / `thinkingMax` `#696969`
  （最高两档思考边框）。锁死时比对过两份 JSON 的解析结果，6/6 全等；现在只剩这份值本身。
  **这里有一个锁死带来的必然后果要交代**：那两个 diff 行底色是**为 `#161616` 卡片挑的**
  （对卡片 1.14 / 1.12:1），换到本皮肤指定的 `#202020` 成功卡片上只剩 **1.02 / 1.01:1** —— 行底色几乎是平的，
  在深色 diff 块里基本看不出来（前景色不受影响，`addedGreen` 对新增行底色仍是 7.83:1）。
  这不是漏改：两侧的锁死要求互相拉扯，行底色要重新可见就得改 `toolSuccessBg` 或这两个底色中的一个。

  另按你要求**把报错色统一到 diff 删除行的前景色**：`error` 不再用 1337 的 `markup.deleted` `#f92672`，
  而是与 `toolDiffRemoved` 共用同一个 `vars.removedRed` `#e27878` —— 共用一个变量而不是两个同值变量，
  这样改一处两边同时变，才叫「统一」。`#f92672`（1337 的 `markup.deleted`）因此彻底退出这份皮肤，
  变量也从 `vars` 里删掉了 —— 连同后面 `mdCode` 换色撤下的 `#ecfdb9`（1337 的 `support.constant`），
  这份皮肤一共放弃了两个 1337 色值。`error` 对 `#191919` 的对比度随之从 4.65:1 变成
  **6.02:1**（在 `toolErrorBg` `#171010` 上是 6.43:1）。新增行侧不动：`toolDiffAdded` / `addedGreen`
  仍是指定值 `#8bc391`。

  四个指定底色：`userMessageBg` / `customMessageBg` `#242424`、`toolSuccessBg` `#202020`、`toolErrorBg` `#171010`、
  `export.cardBg` `#181825`（另配 `export.pageBg` `#111111`，同族推的、比 cardBg 暗一档）；
  `toolPendingBg` 与另三套一样清空成 `""`。
  `accent` / `borderAccent` 按你要求改成了 `#8cdaff` —— 这次**是** 1337 自己的色（函数名 / 类名那个青蓝，
  与 `vars.funcBlue` 同值），但**各立一个 `vars`**（`accent` 与 `funcBlue` 分开，改一个不连带改另一个，
  本仓习惯）—— 所以调 accent 不会顺手把 `syntaxFunction` / `syntaxType` / `toolTitle` 一起改掉。
  对 `#191919` 11.38:1（旧值 `#0d92c1` 是 4.94:1），选中的行 / 光标 / logo 因此明显更亮。

  `mdCode`（行内代码）同时按你要求换成 **`#0d92c1`**，就是 accent 撤下来的那个深青 —— 新开一个
  `vars.mdCodeCyan` 装它，与 accent 解耦。它原来指向的 1337 色 `support.constant` `#ecfdb9` 因此不再被引用，
  变量已从文件里删掉（板页变量表同步换一格，总数仍是 35）。行内代码对 `#191919` 4.94:1
  （代码块底色 `#202020` 上 4.58:1）—— 比注释 / `dim` 的 3.40:1 亮一档、比语法关键字的 5.87:1 弱一档，
  处在语法色阶的下半段，读是够读，嫌淡就往上抬。

  与另三套的一个结构性差别：**它也定义了 `bashOutput`**（`#999999`，bash 输出正文的独立灰 ——
  与它自己的 `muted` 同值但各立一个 `vars`，改一个不连带改另一个），机制同 ayu，catppuccin 没有。

三套皮肤共同的两条硬约束：

- **`colors` 正在引用的 `vars` 变量不能删**：`colors` 的值只要不是 `#` 开头（也不是空串）就会被当变量引用去 `vars` 里查，
  查不到直接抛 `Variable reference not found`，**整个主题加载失败**并回退内置 `dark`。反过来，把某个颜色值清空成
  `""` 之后（三套皮肤的 `toolPendingBg` 都是这个状态），它原来指向的变量变成无人引用，可以留着也可以删，两者都不影响加载。
  **本仓的做法是删**：三套皮肤里的 `vars` 只保留仍被 `colors` / `export` 直接或间接引用的条目（仅 `pi-coder-catppuccin` 的
  `pendingPanel` 按你要求整条保留，留作后续恢复 pending 底色的备选值——它独一无二，未被任何槽位引用）。
  另注意 **空串是合法值**，不是「未定义」：`bgAnsi("")` 发 `\x1b[49m`（终端默认底色）、`fgAnsi("")` 发 `\x1b[39m`，
  token 仍在表里，`theme.bg(token, ...)` 不会报错。
- **缺了主题文件会静默降级**：`initTheme()` 加载失败时是 `catch` 后静默回退内置 `dark`，不报错、
  不启 watcher —— 重装时最容易漏的就是这一行（它不在 `cp config/*.json` 那几行的覆盖范围内）。

三套皮肤里都有 pi 官方 schema 没有的自定义 token：`toolDiffAddedBg` / `toolDiffRemovedBg`
（diff **整行底色**；`toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext` 三个前景色是标准 token），
`bashOutput` 是第三个（ayu / 1337 都有，catppuccin 没有，见下节）。
它们能生效靠三件事凑齐：主题校验实际用的是 TypeBox 的 `Compile().Check()`，**对未知 key 放行**
（`theme-schema.json` 里那句 `additionalProperties: false` 不是执行路径）；`createTheme()` 把不在那 7 个
ThemeBg 名单里的颜色一律收进 `fgColors` 表；而 `getFgAnsi()` 是按 key 查表、不校验 key 是否在联合类型里
—— 拿到前景色 SGR 后把 `38` 换成 `48` 就是合法底色。**pi 一旦改成严格校验，这两个 token 就读不到**，
扩展会静默退回 `toolSuccessBg` / `toolErrorBg`，底色变淡但不报错。

主题文件里的色值选择（pi-coder-catppuccin 的 diff 底色按 OKLab 感知亮度标定、`accent` 取 Macchiato lavender、
`muted` / `toolOutput` / `thinkingText` 指向同一个 `secondaryText`；pi-coder-ayu 的 diff 底色按上面那条
「行内混色 + 两侧行底色亮度比」反推等）都写在 JSON 自己的变量命名与 `tool-diff.ts` 的注释里，
改色时以文件为准。皮肤不会自证对错 —— `toolDiffAddedBg` 之类的自定义 token 写错名字只会静默走兜底，
所以新皮肤落盘后至少用 pi 自己的校验与解析跑一遍：`validateThemeJson()`（`pi-coding-agent/dist/modes/interactive/theme/theme-json.js`）
过 schema、`loadThemeFromPath(path, "truecolor" | "256color")` 后对每个 token 调 `getFgAnsi()` /
`getBgAnsi()`，任一 `vars` 引用不存在都会抛 `Variable reference not found`。移植类皮肤再加一条：
把上游那份皮肤文件一起解析，同名 token 逐个比 ANSI 值 —— 同值才叫「搬运」，不同值要么是漏改，
要么是有意 deviation，得在注释或文档里交代清楚。

### `bashOutput`：bash 输出正文的独立颜色（ayu / 1337 都定义了）

`pi-coder-ayu.json` 多一个 pi 官方 schema 没有的 token `bashOutput`（值 `#6B7385`，与那条
`… (N tokens hidden)` 折叠提示同为 `muted` 灰，但**自己一个 `vars.bashOutput`** —— 改 `muted`
不会连带动它）；`pi-coder-1337.json` 也有一份（`#999999`，等于它的 `muted`，独立 `vars`）。
它买的是「只改 bash 输出正文的颜色，不跟其他颜色混掉」：pi 内置的 bash 渲染器把
输出正文写死成 `toolOutput`，而那是**所有工具输出共用**的槽（read / grep / ls 的正文都吃它），
所以这个 token 只能由 `bash-command-collapse.ts` 生效 —— 机制（在委托给内置渲染器的同步窗口里
临时改主题单例的 `fgColors`）写在该扩展文件头「输出正文的独立颜色」一节。两条行为要知道：

- **别的皮肤不定义它 = 零影响**：扩展先真调一次 `getFgAnsi("bashOutput")` 探测，抛
  `Unknown theme color: …` 就什么都不做，照旧走 `toolOutput`（内置主题与 pi-coder-catppuccin
  现在都是这条路）。反过来，想给某套皮肤也拆出来，就是照 pi-coder-ayu 加一行 `vars` +
  一行 `colors`；删掉那两行等于回到 `toolOutput`，不报错。
- **它不在官方 schema 里，所以不会出现在 `theme-command.ts` 的色卡预览上**：那只预览画的是
  pi 的标准 token 列表。

## 技能包（`superpowers`）

`git:github.com/jayli/superpowers`（**6.4.2**）是一个**pi 包**，通过 `settings.json` 的 `packages`
数组声明，pi 启动时自己拉到 `~/.pi/agent/git/github.com/jayli/superpowers/`（不是 `~/.pi/agent/npm/`，
后者只放 npm 包）。它与 pi 的约定写在包自己的 `package.json` 里：

```json
"pi": { "extensions": ["./.pi/extensions/superpowers.ts"], "skills": ["./skills"] }
```

所以 **pi 包可以同时带扩展和技能**，扩展走 `resources_discover` 把 `skills/` 目录注册进去（15 个技能：
`brainstorming` / `systematic-debugging` / `test-driven-development` / `writing-plans` 等），
不需要往 `~/.agents/skills/` 里拷贝。

> 这**取代了** 2026-09-26 那套手动方式（技能装到 `~/.agents/skills/`、靠 pi 原生扫描发现）。
> 手动那份现在只剩个坏掉的符号链接（`~/.claude/skills/superpowers -> ~/.agents/skills/superpowers`，
> 目标已不存在）—— 那是给 Claude Code 的，与 pi 无关，没去动它。

扩展本身只做一件事：把 `using-superpowers` 的引导文本（含 `<EXTREMELY_IMPORTANT>` 标记）在会话里
**持久注入**一次。走的是 `before_agent_start` 返回 `custom_message`（不是请求时的 `context` 变换）——
后者请求结束就恢复、不进会话文件，下一轮的 history 里找不到，去重门坎就失效了。防重复靠扫
`ctx.sessionManager.buildContextEntries()` 投影；另有一个 `context` 钩子作压缩后的安全网。

**与 plan mode 的关系**：`brainstorming` 技能自带完整的设计流程，与 plan mode 二选一（见下文
plan-mode 一节的「brainstorming 互斥闸」）—— 互斥闸靠扫会话投影里 `read` 过的
`/brainstorming/` 路径来判定，包搬家了也能命中（片段匹配）。

## 联网检索（`pi-web-access`）

给 pi 加 `pi_web_search` / `fetch_content` / `source_check` / `get_search_content` 四个工具。
**零配置可用**（不填 key 时检索走 Exa MCP），本机就是这种状态。

> **`pi_web_search` / `fetch_content` / `get_search_content` 三个工具块的展示形态由本仓库的 `web-search-tree/` 接管**（用户 2026-10-02）：
> 为此 `packages` 里那条 `npm:pi-web-access` 写成了**对象形式 + `"extensions": []`**（包仍在册、
> `pi update` 照常升级，只是它的扩展不再自动加载），细节见上文扩展表里的 `web-search-tree/` 一行。
> 因此**不要把这条改回字符串形式** —— 改回去会变成包与本扩展同时注册同名工具，
> 启动时多出 5 条 `Tool "…" conflicts with …`（写在 `[Extension issues]` 里）。

配置里只有一项，但它是**必须的**：

```json
{ "toolNames": { "webSearch": "pi_web_search" } }
```

pi 默认把该工具注册成 `web_search`，而 litellm 的 Anthropic→OpenAI 转换会按名字把**任何叫
`web_search` 的工具**当成 Anthropic 官方内置的联网检索工具（`_is_web_search_tool`），于是把它从
`tools` 里剔除、换成一个空的 `web_search_options: {}` 参数；qoder 后端不认这个参数，工具就**静默消失**
—— 请求正常返回、没有任何报错，只是模型的 tool schema 里没有它（实测：pi 发 8 个工具，网关日志
`tools=7`；只发 `web_search` 时是 `tools=0`）。改名后同一个请求变成 `tools=8`，检索实测可用。

> 排查这类「工具凭空消失」时不要相信模型的自述（它会照着 system prompt 里残留的 `promptSnippet` 猜），
> 要看网关日志的 `tools=N` 计数：pi 发了几个、网关收到几个，对不上就是中间层吞了。

## 子代理委派（`pi-subagents`）

`scout` / `researcher` / `evidence-auditor` / `worker` / `reviewer` / `oracle` / `delegate` 等内置
agent，加 `workflowScript` 脚本化编排。工具名（`subagent` / `subagent_supervisor` /
`contact_supervisor` / `bg_wait` / `structured_output`）都不撞 litellm 的 `web_search` 特判，
所以**不像 `pi-web-access` 那样需要改名**。

### 委派闸门与 Codex 的对齐（2026-09-25 实测）

`AGENTS.md` 的「非显式不委派」闸门**不是过度抑制，而是与 Codex 默认同档**：从 Codex 0.154.0 二进制
（222MB Mach-O）`strings` 抽出 `spawn_agent` 工具的 prompt 原文——

> Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask
> for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research,
> investigation, or detailed codebase analysis do not count as permission to spawn.

三方同档：Codex 内置 prompt、pi-subagents 的 `SUBAGENT_SAFETY_GUIDANCE`
（0.76.0 在 `src/extension/tool-description.js:13`；那段字符串随版本改行号，按内容 `Direct parent execution is the default` 搜）、本仓库 `AGENTS.md`。issue #12 说的「可检视子线程」指的是
**检视面**（`/agent`、agents 面板、`SubAgentActivity`、`SubagentStart`/`SubagentStop` hooks），
不是主动委派策略。

与 Codex 的两处差异已在 2026-09-25 补齐：

1. **授权来源**：Codex 认「用户显式要求 **或** 适用的 AGENTS.md/skill 指令」，旧规则只认用户原话——
   `dispatching-parallel-agents` 这类技能、项目 AGENTS.md 里写明的委派指令永远无法授权委派。
   现已对齐：项目指令/技能也可授权。
2. **打法**：Codex 闸门后跟着一整套委派打法（先规划再委派、只委派不阻塞下一步的 sidecar 任务、
   写集不相交、子代理直接改文件并汇报路径、不重做已委派的活、`wait_agent` 极少用），旧规则只有
   闸门没有打法。现已补入 `AGENTS.md` 的 `## Delegation`。

Codex 另有 proactive 档（`MultiAgentMode` 枚举：`custom` / `explicit` / `RequestOnly` /
`proactive`，配置键 `features.multi_agent_v2.*`），本仓库**明确不采用**。官方文档
（learn.chatgpt.com/docs/agent-configuration/subagents）也说当前版本「spawn agents after a direct
request or applicable project or skill instruction」。检视面（FleetView / fleet inspector /
async run artifacts）pi-subagents 已自带（`docs/observability.md`），无需自建。

### 补回被压缩掉的「主动找并行」（2026-09-26）

2026-09-25 那次把 Codex 闸门后的 **19 条**打法压成 **5 条**，砍掉的主要是 Codex 鼓励主动寻找并行机会
的那一半。后果实测可见：`workflowScript` 在全部会话日志里**零调用**（按 `toolCall` 精确计数：`subagent`
共 6 次，其中 3 次是 `{agent, task}` 直调派活、3 次是 `list` / `guide` 管理动作，没有一次上升到编排层；
详见下一节）——闸门 + 纪律保留、并行主动性砍掉、proactive 档关闭，三层叠加后模型没有任何理由去碰编排层。

补回两条（`AGENTS.md` 的 `## Delegation`，**闸门一字未动**，只加在「授权之后」的打法段）：

| 补回的条款 | Codex 0.154.0 原文 |
| --- | --- |
| 授权后主动在同一轮里找并行机会：写集不相交就按切片各派一个子代理，独立问题一起发出而不是逐个问 | 「Split implementation into disjoint codebase slices and spawn multiple agents for them in parallel when the write scopes do not overlap.」+「The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round…」 |
| 验证只在能与进行中的实现并行、且可能在最终集成前抓到具体风险时才委派 | 「Delegate verification only when it can run in parallel with ongoing implementation and is likely to catch a concrete risk before final integration.」 |

这是**做法 B（补打法）而不是做法 C（放宽闸门）**：授权来源仍只有「用户当前请求 / 适用的项目指令 / 技能」，
「任务大小、复杂度、工具调用数、想并行」依旧不构成授权，「要深入 / 要调研 / 要详细分析」依旧不算许可。
proactive 档仍不采用。差别只在**授权成立之后**：以前模型拿到授权也不知道该主动切并行，现在会。
`AGENTS.core.md` 的蒸馏版同步加了一句（core-rules 按 hash 检测，下个会话自动带替换声明重注）。

### 编排触发机制：workflowScript 零调用的病根（2026-09-26）

上一节补的是「授权之后要主动找并行」，但**没说用什么机制去并行**。实测后果（按 `toolCall` 精确计数，
63 个会话文件）：`subagent` 工具调用共 **6 次**，其中真派活 **3 次**（全在 2026-09-16，全是直调
`{agent, task}`），`workflowScript` / `workflowScriptPath` **零次**。

与上一节两处口径差异，以本次为准：上一节记的「9 次」含 `guide` / `status` / `list` 等管理动作与
非 `toolCall` 形态的提及，此处只数 `role:"assistant"` 的 `toolCall`（得 6）；上一节说「没有一次真派活」
也不准——那 3 次 `{agent, task}` 直调是真派活，只是全部停在直调层、从未上升到编排层。两节结论一致：
**编排层零调用**。

能力其实全在 pi-subagents 里：`runs.run` / `runs.all` / `runs.lanes` / `runs.steer` /
`outputSchema` / typed gate / worktree 隔离 / 三种预算，`subagent` 工具描述本身也写了 `workflowScript`
（`src/extension/tool-description.js:19`）。缺的是**触发**：`AGENTS.md` 对 workflowScript 零提及，模型拿到
授权也不知道有这层，只会发 N 个临时直调。

补法与上一节同构——**做法 B（补打法），闸门一字未动**。`AGENTS.md` 的 `## Delegation` 加一条
「Pick the orchestration mechanism once authorized」，判据直接取自官方 `docs/workflows.md`：

| 工作形状 | 机制 |
| --- | --- |
| 单个有界子任务 | 直调 `subagent({ agent, task })` |
| 需要稳定键控子代理 / 顺序 / 扇出 / 纠偏 / 重试 / 聚合 | **一次**顶层 `subagent` 调用带 `workflowScript`（或 `workflowScriptPath`），子代理全部在脚本内启动 |
| 形状匹配打包模板 | 优先 `/prompt-workflow <name>`（包内 6 个：`parallel-review` / `review-loop` / `parallel-research` / `parallel-cleanup` / `gather-context-and-clarify` / `council`） |

两条硬约束一并写进条款：**不做第二次顶层编排**（官方原文「make exactly one top-level `subagent`
workflow call … rather than constructing a second top-level orchestration」），复合 workflow 加
`timeoutMs` / `toolBudget` / `usageBudget`。条款末尾明写「这是 how，不是新的授权来源，不动闸门」——
授权来源仍只有用户当前请求 / 适用的项目指令 / 技能。

`AGENTS.core.md` 蒸馏版同步一条（core-rules 按 hash 检测，下个会话自动带替换声明重注），否则长会话里
条款照样衰减。`/council` 不是注册的 slash command（`registerCommand` 全表里没有它，由 `council-mode`
skill 驱动），所以条款里只写 `/prompt-workflow council` 这个真实入口。

### watchdog：开关与配置（2026-09-26 起默认开）

watchdog 是 pi-subagents 的 opt-in 第二模型审查员：每个回合结束且仓库有改动时，把本轮 diff +
用户 scope 喂给一个独立 reviewer 模型，找漏掉的约束 / 正确性风险 / 测试缺口 / 不安全改动 / 跑偏；
干净静默，high 发现推回模型上下文续跑，low/medium 只给用户看；连续 3 次相同警告判僵局停止
（`docs/watchdog.md`）。**配置在 `settings.json` 的 `subagents.watchdog`**（`src/watchdog/settings.js:331`
读的就是 `~/.pi/agent/settings.json`），模板已带：

```json
"watchdog": {
  "enabled": true,
  "main": { "model": "litellm-any/deepseek-flash-qd" }
}
```

- **开关**：改 `enabled` 即可（或会话内 `/subagents-watchdog on|off`、`/subagents-watchdog status` 查状态）。
  settings 是启动时读的，改完**下个会话生效**。
- **模型**：`main.model` 必须 `provider/model` 全限定且在 registry 能认证（`model-selection.js:50-71`）；
  省略则继承当前会话模型。本机选 `deepseek-flash-qd` 是取它快（实测经 996 网关 ~1.4s 返回）；
  注意本网关所有路由 thinking 钉死，审查调用也付 thinking，单次成本与 `/goal` 评估器同级。
- **刻意没开的子项**（都默认关）：`children`（子代理审查，当前不委派子代理）、`clarification`
  （每 prompt 多一次追问审查）、`cadence`（每 N 次工具调用审一次的高频档）。要开再加对应键。
- **超时**：`agentEndTimeoutMs` 默认 30000（`settings.js:9`），审查超时就放弃本次、不拦回合。
- **与 verify-loop 的关系**：watchdog 的 Test Gap 类别与 verify-loop 闸重叠（都抓「声称完成但没验证」），
  但闸是确定性零成本、watchdog 是模型判断付成本；两层并存是有意为之（闸防没跑，watchdog 防跑偏/漏改）。

### `tools:` 是严格白名单，但真正决定成败的是「子会话注册表里有没有这个名字」

白名单本身的过滤规则（`child-tool-plan.ts`）：**核心内建名**（`PI_BUILTIN_TOOL_NAMES` =
`read` / `bash` / `powershell` / `edit` / `write` / `grep` / `find` / `ls`）里宿主没有的会被剔除、
并记进 `unavailableHostBuiltins`（后台 run 的 `runner.stderr.log` 里那条
`host runtime tool availability omitted [...]` 警告就是它）；**非核心名原样放行**，交给子会话自己的
工具注册表去校验。

所以扩展工具被丢掉通常不是白名单的锅，而是**名字对不上**：内置 `researcher` 的 frontmatter 写的是
`web_search`，而本机 `web-search.json` 已经把该工具改名成 `pi_web_search`，于是子会话注册表里没有
`web_search`，它就在那里被丢掉 —— 这类「工具凭空消失」不要相信模型自述，看子会话实际拿到的工具表。

另一条独立规则：只有**后台**子代理才加载父进程的环境扩展（`ambientExtensions = host === "runner" && ...`），
`async: false` 的前台子会话跑在父进程内，只加载内置 + runtime 扩展 —— 所以前台子代理没有联网工具，
除非 agent 自己用 `extensions:` 声明（但那样环境扩展整体被关掉，`simple-task` 的 `task_*` 之类不再有）。

`settings.json` 给三个**可写型**内置代理设 `tools: "inherit"`：`researcher`、`delegate`、`worker`。
`inherit` 的实现就是 `delete target.tools`（`applyToolsOverride`）—— 白名单整个删掉，子代理拿回
子会话注册表里的全部工具，上面那类名字对不上的问题也就绕过去了。实测后台子代理拿到 13 个工具，
`researcher` 与 `delegate` 都真的联网成功。
**只读型内置代理（`scout` / `reviewer` / `oracle`）不能设** —— `inherit` 会把 `write` / `edit` / `bash`
一并给出去，破坏只读契约；`evidence-auditor` 的白名单是同一个坏形状，但给它 `inherit` 等于白送写权限，
所以留原样。交互类工具不用手动排除：`ask_user_question` 自己按 `ctx.hasUI` 判断，子会话里自动摘掉。

## MCP 服务器（pi 内置，仓库不再自带）

MCP 由 **pi 0.99.1 的内置扩展 `builtin:mcp`** 提供：**每个 MCP 工具注册成一个 pi 工具**，名字
`mcp__<server>__<tool>`（Claude Code 同款，skill 与权限规则里的写法可以直接搬过来）。本仓库曾自带一份
自研实现（`clients/pi/extensions/mcp/`，2026-09-18 写），2026-09-30 已退役——原因与恢复路径见本节的
最后一段。

配置按 Claude Code 的 `mcpServers` 形状，读两处：全局 `~/.pi/agent/mcp.json` + 项目根的 `.pi/mcp.json`
（同名 server 项目覆盖全局）。字段：`command` / `args` / `env` / `cwd` 走 stdio，`url` / `headers` 走
streamable HTTP；字符串值支持 `${VAR}` 与 `!command`；`enabled: false` 保留条目但不连。

```bash
pi mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
pi mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
pi mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
pi mcp list          # 连每个启用的 server，打印状态 / 工具 / 错误；有错时 exit 1
```

**三条容易踩的差异**（与退役的自研版相比）：

- **`timeout` 单位是秒**（默认 60；`validateMcpServerConfig` 只接受正数秒）——自研版是毫秒，
  从旧配置抄过来的话 `120000` 会被判非法。
- **项目配置只读 `.pi/mcp.json`**，不再从 cwd 往上找 Claude Code 的 `.mcp.json`。要复用已有的
  `.mcp.json`，在项目里 `ln -s .mcp.json .pi/mcp.json` 即可。
- **不支持旧版 SSE**（`type: "sse"` 会被拒），只做 stdio 与 streamable HTTP；文档建议改用同服务的
  `/mcp` 端点。也没有自研版那个 `headersCommand`（命令式动态头），替代物是 OAuth 或静态 `headers`
  里的 `${VAR}` / `!command`。

**Exposure** 决定工具怎么到达模型（每个 server 一个设置，`toolExposure` 按工具覆盖）：`codemode`（默认，
工具只在 `codemode` 脚本里可调、不进模型工具表）、`codemode-deferred`、`deferred`（模型靠 `tool_search` 加载）、
`direct`（像内建工具一样直接声明）、`hidden`。工具多时默认那档很省 token；`autoEnableCodemode` 设 false
可以阻止 MCP 自动激活 `codemode` 工具。

**管理**：`/mcp` 打开 server 管理界面（状态 / 工具 / 完整错误 / 重连 / 登入登出 / 改 exposure /
启用禁用，改动写回定义它的那份 `mcp.json`）；非交互下 `/mcp` 打印状态，`/mcp login|logout|reconnect <server>`
直接执行。**OAuth** 只要 `url` 不带 `Authorization` 头就走：`/mcp login <server>`（或 `pi mcp login <server>`）
开浏览器授权，token 存 `~/.pi/agent/mcp-auth.json` 并自动刷新，`/mcp logout` 删凭据。

**行为**：会话启动时连接，首个 prompt 最多等 10s（没连上的 server 的工具随后才可用）；HTTP 网络错误与
408/429/5xx 重试两次；断线的 server 下次调用时重连；server 报 `tools/list_changed` 时会增删工具。文本结果超过
20KB 会被截中段（**留头留尾**，完整内容存临时文件并把路径告诉模型），`image` 原样转发，`resource` /
`resource_link` / `audio` 降级成一行说明。server 的日志通知追加到 `~/.pi/agent/mcp.log`（>5MB 轮转）。
MCP 调用走 pi 的 tool pipeline，所以 `tool_call` / `tool_result` 钩子（含权限闸）对它们一视同仁。

**关掉内置 MCP 的两种方式**：`pi config` 的 Built-in 一节，或 settings.json 里
`"extensions": ["-builtin:mcp"]`（`pi mcp` 系列 shell 命令不受影响，仍可用）。

**为什么当年自建、为什么现在退役（2026-09-30）**：pi 0.87 时代没有内置 MCP，为了把 Claude Code 那套
server 接进 pi 工具表，写了 12 个文件的零依赖实现（三种传输、自研 JSON-RPC、`headersCommand`、
`/mcp` 命令、`npm run mcp:probe` 探针，132 个 `node --test` 用例）。pi 0.99.1 把 MCP 做成了内置扩展
并同样注册 `/mcp`，两者按「先注册者赢」冲突，每次启动都报
`Extension …/extensions/mcp/index.ts registers command /mcp, so built-in extension mcp was not loaded`。
改用内置后白得 OAuth、`/mcp` 管理界面、`pi mcp` CLI 与 exposure/codemode 集成，代价就是上面那三条差异。
自研版已移到 `~/.pi/agent/retired-extensions/mcp/`（说明见那里的 `README.md`），仓库里的副本随 2026-09-30
那次提交从工作树删除，**完整实现与测试保留在 git 历史**（提交 `bf3ab71`，需要时 `git show bf3ab71`
或 `git checkout bf3ab71 -- clients/pi/extensions/mcp`）。

## 自写扩展：改之前要知道的

每个扩展的完整理由都写在**它自己的文件头注释**里，这里只列「不在文件里、但改错了会静默坏掉」的约束。
除了下文点名的那些，`extensions/` 下还有一批较小的显示层 / 输入层扩展：

| 扩展 | 作用 |
| --- | --- |
| `thinking-collapse.ts` | thinking 块渲染成**一条连续横向滚动的行**（固定 1 行，不注册命令）：所有换行（模型自己折的行、空行分段、列表项、代码围栏内）全部拼进同一条行 —— 上一段结束后下一段直接接续在上一段的结尾，**不另起一行**，Think 区域从头到尾只有一行不间断的 token 流；**段落接缝（空行处）中文 ↔ 中文补一个逗号**（上段末尾已有标点不重复补，英文/混排仍按空格规则，段内折行不补），行首 `Think: ` 标签（顶格，无竖线 gutter），整行超宽时从头部丢掉溢出字符、行首补 `…`，行尾永远是最新 token，不折行；**没有短段回填补满逻辑**（曾有，会打断流动观感，已移除），短 thinking 行尾留白不补 |
| `fenceless-code-block/` | Markdown 代码块去掉开合围栏（连 `lang` 标签一起），代码正文按 pi 的缩进铺开、语法着色保留，**不加底色**（观感来自 npm `@itc-steve/pi-theme`，但只取去围栏这一半）；`render.ts` 是纯逻辑（量度 / 折行 / Markdown 类都注入），入口只接线。`PI_FENCELESS_CODE=off` 关闭 |
| `user-message-bar/` | 用户消息框**每一行**（含上下两条空白内边距行）行首加一条竖线 `▏`（U+258F，左侧八分之一块），**竖线跟着消息底色**（不抠底 —— 它直接坐在 Box 的 `userMessageBg` 里，与底色块连成一片），竖线后空一格（正文共缩进两格），颜色取 **皮肤的强调色 `accent`**（`PI_USER_MESSAGE_BAR_COLOR` 可换槽位，显式指定 `toolDiffAdded` 则拿回原来的 diff 新增行行号色；兜底顺序 `accent` → `selectedBg` → `toolDiffAdded` → `text`）；`UserMessageComponent.prototype.render` 补丁 —— 竖线占原本那一格左内边距，多空的那一格（`BAR_INDENT`）则从**行尾补白**里等量吃回来，所以底色 / 行宽 / 折行位置全不变（pi-tui 对超宽行直接抛错，多一格都不行；`outputPad = 1` 时 Box 只给孩子 `width - 2` 列，所以正文总能留得下那一格，已在 `index.test.ts` 用长正文折行逐行验宽度）。**别再改成「竖线格无底色」**：那需要在竖线前插 `49m`、画完再还原 `48;…m`，而结果是底色块左边缘被抠出一个缺角，实测观感更差（曾这么做过，已回退）；`bar.ts` 是纯逻辑，入口只接线；取色源在 `session_shutdown` 时摘掉、读皮肤再兜一层 try/catch —— 会话替换（`/clear`、`/new`、`/resume`、`/fork`、`/reload`）时 pi 会作废旧 ctx，而旧消息这时还挂在聊天区里，渲染 tick 里抛出的 stale-ctx 异常没人接得住，会直达 pi 的 `uncaughtException` 把进程带走。`PI_USER_MESSAGE_BAR=off` 关闭，`PI_USER_MESSAGE_BAR_COLOR=<槽位名>` 换色（背景槽如 `selectedBg` 会 48→38 转前景） |
| `bash-command-collapse.ts` | bash 工具块的命令 + 树形输出（**用户 2026-09-21 定的形状**）：命令**首行**行首是一颗状态圆点 `•` **加一个空格**（执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`，**只有首行有**，续行、折叠标记与整棵结果树前面没有；这一列与结果侧的缩进共用同一个 `INDENT_WIDTH`，所以 `Run` / `│` / `└` 同在列 2、正文同在列 4），命令以 `Run ` 起头（pi 内置是 `$ `）、最多 **2 个视觉行**，第 2 行溢出多少都只把行尾换成 `…`，命令更长时再补一行 `… +N lines`；两类续行（折行续行、折叠标记）的正文都对齐 `Run ` 的 `n` 列 —— 执行中是两格缩进，命令一执行完就换成 `│ `。结果挂在同一棵树下：`└ ` **整块只出现一次**、在第一行实质输出上（截断提示行挂 `│ `，`└ ` 之下的输出 / warnings / `Took Xs` 只缩进两格不再画竖线），没有输出时补一行 `(no output)`（`└ ` 挂它前面）；`│ ` / `└ ` 取 `muted`（结构符，`Run ` 取 `toolTitle`；两者**各自是一段独立的前景 SGR**，前缀绝不继承后面 token 的颜色 —— 曾经路径那行的 `│` 跟着 path 色飘过）。只有 `Run` **这一个词**加粗（`bold("Run") + " "`，包住整个前缀会把行尾那格间距也变粗），命令正文一律不加粗（原先是命令名加粗）。**命令失败时** pi 把状态当普通输出拼在结果末尾（`appendStatus` 的 `\n\n` + `Command exited with code N` / `timed out after N seconds` / `aborted`，无输出时正文已被 pi 换成了 `(no output)`）—— 那句 `\n\n` 原本渲染成两行**没有前导符**的空行（用户说的“中间断层两层”），现在 `trimPreviewLines` 把状态与其前的空行一起摘下来、空行不画、状态当作预览必占的一行（否则它会被预览裁掉，只剩一条 `│ … (N earlier lines)`），`└ ` **之上**的空行补 `│ `（用户 2026-09-21 定的：栅栏不能断在空行上；来源是 pi 预览窗口开头的空行与失败状态前面的分隔空行），`└ ` **之下**的空行保持空行（树在那里就落地了，下面那截是缩进对齐的续行 —— 更多输出、`[Full output: …]` 之类的 warnings、`Took`，各自成段；挂竖线反而像还没完），最后按 `error` 槽染红（`isError` + `isFailureStatusLine` 两道判定：只看形态会把 `echo "Command exited with code 2"` 这种正常输出也染红）并放回尾部，展开态（ctrl+o）同样染色（不裁行、不挂树）。整块**既不带底色也不留边界空行**（`Box` 不带 bgFn、`paddingY: 0`：命令就是块的第 1 行、结果就是最后一行；左边距由组件自己画 —— 首行是 `• `、其余行两格空格，结果侧挂同宽的那一列。**只去 bash 的**底色，其他工具照旧）。**长地址缩略**（用户 2026-10-03 定，纯逻辑在 `bash-command-collapse/abbrev-path.ts`）：折叠态里只对**点名命令的地址参数**（`cat` / `cd` / `ls` / `ln`，外加任意位置的 `NAME=<路径>` 赋值 —— 用户样例的 `P=/Users/…` 落在这支）做缩略，其余命令（典型：`import … from "/Users/…"` 那种代码里的地址）与其余参数一字不动；只认字面量地址，含变量 / 反引号 / 通配符 / 花括号 / 引号 / `~` 的词一律跳过（一期不碰需要求值的形态），heredoc 正文也不碰。阈值 = **命令正文可用列**（终端宽 − 左边距 − `Run ` 前缀）的 40%，80 列终端约 29 列；路径可见宽不超阈值就原样。缩略**只动中间**，形态 `<头>…/<尾>`、**尾部层数优先**（先最大化尾部层数，同层时保开头 2 层，放不下退 1 层），所以 `cd <pnpm store 长路径>` 在 80 列上出 `cd /Users/bachi…/pi-coding-agent`、在 120 列上多留一层。**只作用于折叠态**：展开态（ctrl+o）是唯一能看到命令全貌的地方，一个字不缩；发给模型的参数与 session 原文也不受影响（只改渲染）。同时保留：非流式（`onUpdate` 摘掉）、break-all 硬折行 + 行首 `Run ` 语法高亮（`syntax*` 槽）、`/bash-preview` 输出预览行数、`/bash-timeout`、短命令（<2s）不画 `Took` 页脚、`bashOutput` 独立输出色。详见文件头、`bash-command-collapse/abbrev-path.test.ts`（15 条纯逻辑）与 `bash-command-collapse/render.test.ts`（含 3 条缩略端到端） |
| `read-path-collapse.ts` | read 工具块的标题 + 结果（**用户 2026-09-21 定，与 bash 块同一套观感**）：`renderShell: "self"` 让 pi 不再套默认壳，于是整块**没有底色**（pending / 成功 / 失败三色底都不画）、**没有上下边界空行**（默认壳 `Box(1, 1)` 的那两条），只有内容本身；标题行 `• Read <路径>` —— 状态圆点 `•` 在**列 0**、`Read` 的 `R` 在**列 2**（正文整体右移一格），圆点颜色三态：**读的时候（pending / partial）`dim` 灰、成功 `toolDiffAdded` 绿、失败 `toolDiffRemoved` 红**（与 `bash-command-collapse.ts` 的 `stateBarAnsi` 同源，字形也一样）；结果正文每行两格缩进（与 `Read` 同列），pi 那个前导 `\n` 空行被剥掉，所以正文紧贴标题。左边距由孩子自己画（`withHeadBar`），`Box(0, 0)` 的孩子按 `width - MARGIN_WIDTH - RIGHT_PAD` 渲染。**只影响 read**：其他工具仍走 pi 的默认壳（有底色、有边界空行），有专门的对照断言。原有能力一字未动：长路径压缩成一行（`…` 前缀，装得下的短路径走 pi 原生渲染只换 `accent`→`text` 一个色）、工具名首字母大写（`Read`）、`[skill]` / `read docs` / `read resource` 紧凑形态、OSC 8 超链接、`(ctrl+o to expand)` 提示、`app.tools.expand` 从 keybindings.json 读。12 个端到端断言见 `read-path-collapse/render.test.ts`（含一条回归：cwd 之外的资源文件压缩后标签必须是路径而不是 `.`） |
| `explored-group/` | **连续的「只读探查」合并成一个 `Explored` 分组块**（用户 2026-10-06 定；配套 `settings.json` 的 `defaultTools` 打开原生 `grep` / `find` / `ls`）。形态：组头 `• Explored` 顶格（圆点列 0），成员行 `  ` + `└ ` + 一句话短语（`Run` / `│` / `└` 同为列 2，与 bash 块同一张列位表），**块内不输出任何文件内容**：`└ Search "bashOutput" in clients/pi` / `└ **Read** …/ttt/CLAUDE.md, …/ttt/package.json` / `└ List clients/pi/extensions` / `└ Git status` / `└ Tail ~/.vimrc`。**加粗 = 原生 `read` 工具（用户 2026-10-06 第四轮定）**：`cat f` 与原生 `read({path: f})` 的短语都是 `Read f`，屏幕上分不出来 —— 而它们是完全不同的两件事（一个走 bash、一个走原生工具）。所以**只有原生 `read` 工具**那一行的动词 `Read` 加粗，**bash 转义出来的 Read 不加粗**；**只加粗 `Read` 这一个词**，其后的路径 / 行号区间一律不带粗体（`\x1b[1mRead\x1b[22m <路径>`，与 bash 块「只把 `Run` 加粗」同一手法 —— 包住整行会让间距看着变宽）。

**折行续行不重画 `Read`（用户 2026-10-07 报，实测 width=79 复现）**：`cat <77 字文件名>` 这类调用，名字恰好一行装不下时屏幕上成了

```
└ Read pi-session-…-c7ec684628     ← 首块（自带 └ 与 Read）
  Read 7d.html                      ← 续块又冒出一个 Read，看着像读了两个文件
```

根因在 `layoutRows`：`flatMap` 把每个文件的折行块**卷平后丢掉了「它属于哪个文件」**，于是续块与「下一个文件」在循环里长得一模一样，都拿到了 `Read ` 前缀。同因的第二个症状更容易误事：条目 A 的尾部碎块被当成独立条目，与真实的 `b.ts` 用 `, ` 缝成 `Read z, b.ts`（看着像两个文件，实际是 A 被切断 + 凭空多出一个名字）。修法是折行后保留 `startsItem` 位（`wrapReadPiece(...).map((text, index) => ({ text, startsItem: index === 0 }))`），主循环里**只有 `startsItem` 的块会开新行并画 `Read `**，续块一律独占一行、不带前缀、不加粗；续块因为 `hardWrap` 总是填满，天然不可能与别的东西拼在一行。回归用例：`回归：长文件名折行时，续行不重画 Read` 与 `回归：单文件折行后不得与后一个文件用 `, ` 缝在一起` —— 把 `startsItem` 换成恒 `true` 会同时红两条（做过的 A/B）。

**行号区间上色（用户 2026-10-07 定）**：`Read a.ts 100-169` 里的数字用 `warning` 槽、中间那根横线 `-` 用**前景色**（`\x1b[38;2;253;176;130m100\x1b[39m\x1b[38;2;248;248;242m-\x1b[39m\x1b[38;2;253;176;130m169\x1b[39m`，1337 主题的 `warning`=`#fdb082` / 前景=`#f8f8f2`）；**原生与 bash 转义的 Read 一视同仁**（上色说的是「读到哪一段」，与「是不是原生工具」正交，所以只给不给单一来源开特例）。横线的槽名是 **`text` 而不是 `fg`** —— `colors.text` 就是主题的 `fg` 变量，而 `theme.fg("fg", …)` 会抛 `Unknown theme color: fg`（用户最初说的是「fg 前景色」，落到代码上要写 `theme.fg("text", "-")`；原本用 `dim`，改前景色是为了那根横线的亮度与路径正文一致）。三条实作约束：① 上色只在 `paintRow` 里做，`layoutRows` 仍旧只传标志不拼 ANSI —— 折行宽度是按**剥掉颜色后**的可见文本算的，把 ANSI 带进 `visibleWidth` / `hardWrap` 会让宽度算法当场失真（这条与加粗同源，是整个渲染层最容易被写坑的地方）；② 认区间的形状是行尾的` 数字[-数字]`（`phraseForToolCall` 用 `readSpanSuffix` 生成、`paintReadSpans` 与 `wrapReadPiece` 两处用同一形状认），所以 `cat v2`（无空格）不会被误伤、而 `notes 2024` 这种「空格 + 纯数字」的文件名会被当成带区间（多上点色，实测全库 0 例）；③ **折行时区间整体不拆**（`wrapReadPiece`）—— 实测宽度 60 时 `…a.ts 100-169` 会正好劈在数字中间，第二行成了 `Read -169`：区间没了、颜色也只剩半边。做法是路径照旧 break-all、贴不下就给最后一段腾出区间宽度再重折那一段；终端宽到连 `Read 100-169` 都放不下时退回字符级折行。**这条标记之所以不会含混，靠的是行内按来源切段**：**分组不再按家族拆**（用户 2026-10-06 第二轮：原生 read 与 bash 转义的 Read 现在**同组**），所以保证从「不同组」下移到了「不同行」—— 连续 read 合并成一行时**来源一变就另起一行**（`**Read** a, b` 与 `Read c` 各占一行），于是**同一行里不可能两种来源混居**，「这行加粗没有」仍然是「模型调的是不是原生工具」的完整答案。旧口径（家族断组）实现过同一件事但代价是满屏碎块（见下），按类别分族又会让两者同组（实测 **90 个合并行**把原生 read 与 bash 转义 Read 混在一起，那一行加粗就没意义了）—— 两个旧口径都已废弃。**`└ ` 整块只出现一次**（用户 2026-10-06 第三轮定）：只有**第一行**带拐角，其后的行（后续成员行，以及同一个 `read` 合并行折出来的续行）一律**四格缩进**、正文列与首行对齐 —— 与 bash / codemode / web-search 结果树「`└ ` 整块只出现一次」同一条语言（改这条之前是每行各带一个 `└`）。**但「续行重画 `Read `」这条已被推翻（用户 2026-10-07，见下）**：同一**文件**的折行续块不得再画动词，只缩进。**状态只在组头那一颗圆点**（用户 2026-10-06 第二轮定，行内不打勾也不带圆点 —— 与「工具块不打标记」同一条语言）：**还有成员在跑 = 白 `text`、全部结束无错 = 绿 `toolDiffAdded`、任一成员出错 = 红 `toolDiffRemoved`**。三类可折叠成员：`read`（永远，**读 `SKILL.md` 除外**，见下段）、原生 `grep` / `find` / `ls`（永远）、以及**全只读**的 bash 命令 —— 判定按 shell 分段做（剥 heredoc 正文、跳过 `VAR=` 前缀与 `sudo/env/…` 包装），每段首个有效动词都必须在只读白名单里（`grep`/`sed -n`/`ls`/`cat`/`head`/`jq`/`stat`/`git status\|log\|diff`…），且**没有写重定向 / `sed -i`**；**类别取「第一个有效段」**（不是优先级最高的段）—— 屏幕上那行短语取的也是首条短语，同源才不会出现「写着 `Read` 却并进 Search 组」（用户 2026-10-06 报过）；于是 `cd X && grep -rn … \| head` 折叠，而 **`node --test … \| grep -E '^ℹ'` 不折叠**（跑测试是要看输出的真实执行，折了就等于把「我跑了测试」从屏幕上抹掉）。断组规则 = 用户 2026-10-06 第二轮定的四条：`thinking` 块、assistant 的**非空** `text`（旁白）、`user` 消息、任何不可折叠的 tool 调用，任一出现即封口。**不在列表里的一律不断** —— **类别不同不断、工具名不同不断、换了 assistant 消息也不断**（本轮删掉的正是后两条：家族断组 + 消息边界断组）。删它们是因为实测观感：全库 367 个有探查的会话里**连排 ≥2 块的段有 1012 处**（最长连排 8 块），block-proxy 那个会话 99 块里大量是单行碎块；删后 ✓ **连排消失（1012 → 0）**、组数 14199 → 12955、屏上行数 31426 → 30089。**同一行内按来源切段**：连续 read（不分来源）合并到一行、**来源一变就换行**，于是加粗语义不混（见上）。**`read` 的行号后缀对齐 pi 原生 `formatReadLineRange`**（用户 2026-10-06 报「行号信息似乎丢失了」后修）：`start = offset ?? 1`，`offset+limit` → ` 100-169`、**只给 `offset`** → ` 100`、**只给 `limit`** → ` 1-45`、都不给 → 无后缀。**先测再改的结论先说**：行号并没有真丢 —— 会话里 `offset:100,limit:70` 的结果与文件第 100–169 行逐行比对一致（执行层正常），`offset+limit` 也都照常显示；丢的只有「只给一个参数」那两种形态（旧判定是 `offset && limit`，于是整段区间静默消失）。全库 440 个会话统计：`offset+limit` 1176 次 / 只给 `offset` 40 次 / 只给 `limit` 90 次 / 都不给 1287 次。**它是怎么长出来的**（关键机制，改动前必读）：`renderCall` 实测在流式期间就会跑（`updateArgs` → `updateDisplay`）**早于 `tool_call` / `tool_execution_start`**，所以登记走渲染路径（**渲染驱动**，`ensureRegistered`，幂等），断组走事件路径（`message_update` 重放 content、只处理新增那段）；三条 renderer 各问 registry 两个问题 —— `groupOf(id)`（取 0 行隐身）与 `isLeader(id)`（当组长，画整棵树），**组长块的 `renderCall` 把 `context.invalidate()` 登记给 registry**，加成员时由 `index.ts` 叫醒它重渲，所以新行会实时出现在已画出的树上（实测确认：`ui.requestRender` 被调到）。成员块投 0 行靠 `renderShell: "self"`（默认壳常驻 `Spacer(1)`，不 self 就永远多一条空行 —— bash 侧踩过的同一个坑），且 `ToolComponent.render()` 对空容器有 `return []` 守卫。**参数未到齐时既不能渲染、也不能进树（2026-10-06 第二轮 + 2026-10-07 修）**：pi 在 `content_block_start` 时把工具参数播种为 `{}`（`event.content_block.input ?? {}`），之后靠 `input_json_delta` 逐片填 —— 所以一个工具块**刚出现的那一刻参数是空的**。拿空参数去分类，`classifyBash("")` 会回 `null`（「没有有效动词」），于是每个块出现时都触发一次 `beginBreak()`，**把上一块刚开的组关掉**：同一条消息里三个连续只读 bash 就渲染成三个独立 `Explored`（用户报的第三个例子，实测确认）。现在 `classifyToolCall` 返回 `pending: true`（按「必填参数到没到」判：`bash.command` / `read.path` / `grep.pattern` / `find.pattern` 须为非空字符串；`ls.path` 可选所以从不 pending），`replayMessage` 遇到 pending **直接 `continue`**（不断组也不入组），等下一个更新参数齐了再正常入组。**同一条规则在渲染层还要再管一次（用户 2026-10-07 报的「先流一段灰文本再折叠」）**：`ensureRegistered` 在 pending 时返回 `null`，而三个渲染器把 `null` 读作「这块不归我管」→ **退回 pi 内置渲染**，屏幕上就先画出一帧原生块（`grep // in .` / `find  in .` / `• Read ...`），args 齐了才跳成 `Explored`。修法是把 `null` 的两种含义分开：`shouldHideWhilePending(toolName, args, isPartial)` 只在「必填参数没到 **且** 结果还没回」时投 0 行，读 `SKILL.md` 那种**确定**不可折叠的照旧退回内置渲染（它的 `[skill]` 紧凑形态才是对的）。带上 `isPartial` 是必须的：pi 在 `message_end(aborted/error)` 时对未完成的块调 `updateResult(..., false)` 而**不补 args**，只看 pending 会让被 Esc 的块永久隐身、连报错都看不到（与 bash 侧 `!streaming && !argsComplete && isPartial` 同一条口径）。

**「吐完才进树」与它的三个开闸信号（2026-10-07 定）**：用户要求「bash 指令被吐完后（进入执行阶段）直接输出为折叠后的 Search」—— 光拦原生帧不够，行内文字还会跟着 token 一点点长（`└ bash` → `Search "auth"` → …），那仍然是「先看到流式文本」，只是换到了树里。所以成员多一个 `ready` 位，**没 ready 的成员不进树、组头也不画**（一幕都不出，而不是先冒个空壳）。开闸信号三个，缺一不可（实测每一条去掉都会让某类块**永久隐身**）：① 主信号 `message_end` → `markMessageReady`（pi 的时序是「消息流完 → 再执行工具」，这正是「命令吐完」那一刻；不能改在 `renderCall` 里判 `argsComplete` —— 那会把就绪与否绑在「这个块自己渲染过几次」上，而画树的是**组长**，两者不同步）；② `tool_execution_end` → `markMemberReady`（兜底：确有只有它、没有 `message_end` 的路径）；③ 渲染时的 `markReadyIfSettled(id, argsComplete, isPartial)`（兜底 Esc 中断 / 模型报错：`message_end` 到了但那时 args 永不补齐）。`readyIds` 集合专门记住「已经开过闸」的 id，因为**注册与开闸的先后顺序不固定**（实时流里 `message_update` 先注册、`/resume` 里 `hydrateFromHistory` 先开闸），迟注册的成员在 `register()` 里从它补上就绪位。验证方式是一张 5 行的风险矩阵（正常 / 无结果 / 无 `message_end` / 中断 / 同 id 复用）+ 端到端模拟 `message_update` 逐片到 `message_end`：逐片全空、`message_end` 那一刻直接出完整折叠行。 **回放历史必须补断组事件（2026-10-06 第二轮实测，改动前必读）**：断组全靠 `message_*` / `user` 事件，而 **pi 重建历史时一个扩展事件都不发** —— `renderInitialMessages()` → `renderSessionItems()` 只 `new ToolExecutionComponent(...)` 加进容器就渲染（实测确认 `session_start(reason:"resume")` 之后直接走这条），历史里的块只能靠 `renderCall` 的 `ensureRegistered` 登记，于是 **全部并进一块**。HEAD 版因为有家族断组勉强分开了几块，把家族断组删掉后这个隐患被放大：实测 367 个会话里 **319 个会变成「整个会话一个 Explored」**，最大块含 **326 个成员**、屏幕只显示 5 行，历史等于全丢（`--resume` / `/fork` / 树导航 `navigateTree` 都走这条）。修法在 `index.ts` 的 `hydrateFromHistory`：`session_start` 时把 `sessionManager.buildContextEntries()` 按序重放（与流式期间**同一套** `replayMessage` / `noteUserMessage`，断组规则只一份），修后全库回放得 **12984 块**（流式期间 12972），最大块 8 成员，与实时渲染一致。 **打开注册 ≠ 会被用（2026-10-06 实测，光改 `defaultTools` 不够）**：全库 303 个会话、≈20.4k 次 bash 里，原生 `grep` / `find` / `ls` 合计只被调用**四次**（`grep` **零次**），而 bash 里以 `ls` 起头的段 4405 次、`grep` 13003 次、`find` 811 次。病根在 pi 自己的工具描述：`bash` 的 `promptSnippet` 原文是 `Execute bash commands (ls, grep, find, etc.)` —— **工具表里直接替 bash 打了「文件操作」的广告**，而 `grep`/`find`/`ls` 三个内置工具的 `guidelines` 都是**空数组**（只有 `read` 带一条 `Use read to examine files instead of cat or sed.`，且实测同样被无视：≈1200 次单文件读取走的是 `cat`/`head`/`sed -n`）。所以「开注册」只解决了工具**存在**，没解决模型**选它**。补法是提示词侧：`~/.pi/agent/AGENTS.md` 新增 `## Tool choice` 段（`AGENTS.core.md` 蒸馏版同步一条，防会话中途衰减），划清「单一检索/列目录 → 原生工具（含 `cd X && <lookup>` 这种只带导航前缀的形态）；复合探查（一次拿多个答案、管道、`awk`/`sort`/`jq`、任何写操作）留在 bash，不要为了规则把它拆碎」。**`.gitignore` 是唯一会咬人的差异**（实测：原生 `grep`/`find` 跳过 `node_modules/`、`dist/`，shell `grep -r` 不跳；把 `path` 显式指到被忽略的树可以穿透），所以规则里必须写明这条例外，否则「换原生」会变成静默漏搜（2026-10-06 复查：规则里原先还留了「或用 bash 并说明原因」这条出口，而闸门对 `grep -rn foo dist/` 正是**拦**的 —— 两处矛盾会让模型照规则选 bash 后白挨一次拦截，已改成「点 `path` 搜被忽略树；需要原生没有的旗标（`grep -v`/`find -mtime`/计数管道）才回 bash，闸门对这些放行」。同时按闸门已兜底的前提把该段从 2746 压缩到 1784 字符（-35%），删去「303 会话只用 4 次」这类论证性篇幅，七条要点一条未少）。 **但提示词只是概率**（pi 自己那条 `read` guideline 就是被无视的前车之鉴），所以用户 2026-10-06 又追加了一道 **loop 层的硬闸**：`bash-command-collapse.ts` 注册 `tool_call` handler，命中「纯粹单一探查」就 `return { block: true, reason }` —— 拦截语（`renderLookupRedirect`）直接给出照抄的原生调用、原因、以及 `.gitignore` 例外与穿透手法，拦一次模型就改道。判定在 `bash-command-collapse/lookup-redirect.ts`（纯函数 + 17 条单测）。**取向是宁可不拦、不可拦错**：只有整条命令每个 stage 都是「取回内容」类才拦（`grep`/`find`/`ls`/`cat`/`head`/`sed -n`），带变换器（`awk`/`jq`/`wc`/`sort`/`cut`）、执行（`node`/`npm`/`git`/`python3`）、写重定向、`sed -i`、或原生 schema 表达不了的旗标（`grep -v`/`-c`/`-A`、`find -mtime`/`-exec`、`ls -R`、多路径 `grep`）一律放行。`| head -N` 算**截断习语**不算复合（原生有 `limit`），但 `head -20 file` 有文件名时仍归 `read`（`head -n 20 f` 同样拦、并同样给出 `limit` —— 旧版只认 `-20` 那种写法，`-n 20` 会被当成「两个文件」而整个漏拦）。 **2026-10-06 晚修正了四类「拦了反而错」的判定**（判据：照抄拦截语里给的那一行原生调用会不会**真的成功**）：① **shell 展开**（`ls *.md`、`cat *.log`、`grep -n foo *.ts`、`ls -d */`、`grep -rn foo \`pwd\``）—— 原生工具**不做 glob 展开**，`ls({path: "*.md"})` 直接 `Path not found`，所以带 `*` `?` `` ` `` `$(` 的 path 一律放行（方括号不算 —— `grep -n '[a-z]\+' f` 的 `[` 是正则）；② **从 stdin 读的 grep**（`env | grep`、`ls | grep`、裸 `grep pat`）—— 上游是命令时原生 grep 只能搜文件，给不出替代调用（`grep -rn pat` 递归无 path 算例外，GNU grep 搜当前目录，原生能表达；`cat f | grep pat` 理论上可推路径，但 `splitShellSegments` 把 `|` 与 `;` 当同一种分隔符、分不出管道还是换行，拿不准就不拦，实测仅占 0.4%）；③ **多路径 `ls`**（`ls a b`）—— 原生只收一个 path，照抄会静默漏掉其余（与既有的多路径 `grep` / `cat a b c` 同口径）；④ **带引号的空格路径** —— 旧版对 `ls -la "/path/a b/c/"` 给出 `path: "\"/path/a b/c/\""` 这种**带引号且被截断**的建议（模型照抄必失败），新版直接放行。四类合计从 4739 降到 4058 条（19.0% → 16.3%），**没有新增任何一条拦截**。同时修掉一个「照抄建议就错」的 hint bug：`grep -rn foo --include=*.ts .` 原先给出 `ignoreCase: true`（正则 `/^-.*i/` 命中了 `--include` 里的字母 `i`），现在只认短旗标里的 `i`（`^-[^-]*i`，`-rni` 仍认）。 **hint 里的 `path` 必须能解析到命令真正的目标**（这一点是「建议能不能跑通」的全部）：原生工具在**当前 cwd** 下解析 `path`，不是命令里 `cd` 之后那个目录 —— 所以 `cd /p && cat f` 现在给出 `/p/f`（相对路径与 `cd` 落点拼接），而实测 **74% 的拦截都带 `cd` 前缀 + 相对路径**，不拼就是在让模型去读另一个文件（静默指错比报错更坏）。四类无法可靠解析的值一律**不给 path**（或直接放行）：未展开的 shell 变量（`$D/f.ts`，实测 562 条）、`cd` 落点靠 shell 展开（`cd "$DIR"` / `cd /x/*/pkg`）、通配符、以及转义引号把分词切碎的残片。`cd` 落点用**引号感知**的取词（`segmentVerb` 按空白切词会把 `cd "/a b/proj"` 切成 `"/a`，拼出来就是 `path: "\"/Users/…/Application"` 这种跑不通的建议）。修完复核全库 3494 条拦截：畸形 path（通配符/引号/变量/命令替换）**全部降为 0**，`read` 建议的目标 **95.6% 在磁盘上真实存在**（剩下的 4.4% 是会话之后被删的文件 / 被清掉的 `/tmp`，指向本身是对的）。**有意保留**：`ls -la` / `ls -lt` 照旧拦（屏上多数 `ls -la` 只是想看目录里有什么，原生给名字就够；真要元信息时拦截语明说改走 `stat` / `du`，那两条不拦）。全库 20591 次 bash 里命中 3889 次（18.9%，`grep` 1592 / `read` 1769 / `ls` 482 / `find` 46）。`PI_BASH_LOOKUP_GATE=off` 关闭；dangerous 模式（shift+tab）不拦，与沙箱开关同口径。

**读 `SKILL.md` 不折叠（用户 2026-10-06 定，第五轮）**：pi 对 `SKILL.md` 本来有专门的紧凑形态 —— `• [skill] commit (ctrl+o to expand)`（`read.js` 的 `getCompactReadClassification`，标签取**所在目录名**），而分组是在 `renderCall` 里**最先**接手的（命中就投 0 行、由组长画树），它一旦接手那个分支就永远跑不到 —— 于是读 skill 全变成了 `└ Read …/skills/commit/SKILL.md`（用户原话：「这不是我想要的」）。所以豁免必须发生在**「要不要入组」这一层**（`classify.isSkillRead`），不是渲染层改个字。判定只看**最后一段是不是 `SKILL.md`**（`/` `\` 两种分隔符都收，不做路径解析 —— 读一个不存在的文件时行为一致），且**只豁免 `read` 工具**：`grep SKILL.md` 与 `bash` 里的 `cat …/SKILL.md` 照旧折叠。这三种紧凑形态里**只豁免 skill 这一种**（用户定的范围）：`read docs`（pi 自带 README/docs/examples，194 次）与 `read resource`（`AGENTS.md`/`CLAUDE.md`，88 次）仍在折叠范围内 —— 在探索语境里「读了一遍 pi 的文档」与「读了一遍项目文件」没有区别。实测规模：全库 440 会话 2613 次 read 里 `SKILL.md` **332 次**（最多的几个：commit 117、brainstorming 40、reading-dingtalk 31、writing-skills 26、systematic-debugging 24），确实高频。口径上它是**确定的不可折叠**（不是 `pending`）—— 所以像「跑测试」那个块一样：自己原样渲染 + 把上一组封口，读 skill 前后的探查不会被并成一组。

**去重必须用「内容指纹」而不是消息对象（2026-10-06 修，三个用户可见 Bug 的共同病根）**：pi 在每一个 `message_update` 里发的是 `{...partialMessage}` —— **每次都是新对象**。拿消息对象当 `WeakMap` 键永远命中不了，于是第二次更新被当成新消息、从 `content[0]` 重跑，而每个 assistant 消息都以 `thinking` 开头 —— 结果是**每次 token 更新都再断一次组**，同一消息里的工具块全部各自成一个 `Explored`（用户看到「相邻两个 Explored」，实测该会话旧算法 32 块 vs 修后 17 块）。现在用 `content.length + 最后一个块的 id` 作指纹推进游标；判定「同一条消息的追加」用**已处理前缀的最后一个块身份**对账（只比长度不够：新消息若比上一条长会被误判为追加；这条也踩过，回归用例就在 `render.test.ts` 里）。

**另两个 2026-10-06 修的渲染 Bug**：① **组长块也要隐藏输出** —— `renderResult` 原先只隐「成员」，组长那块仍把自己的 `grep` 命中全画出来，屏幕上是短语树下面跟一大片内容；现在折叠态下**整组（含组长）都不画输出**，`ctrl+o` 才放行。② **`args` 必须随流式刷新** —— `renderCall` 在参数还在到达时就会跑，第一次登记常拿到**空 args**；`register` 幂等若「定了就不改」，后面真实的 `path` 永远进不来，短语算不出就回退成工具名，屏幕出现 `└ Read read`。现在已登记时按浅比较刷新 `args`。

**`armed` 闸**：分组靠「按 toolCallId 查表 → 命中就投 0 行」，而那张表是 `globalThis` 单例、跨会话存活；不禁用的话任何拿固定 id 反复渲染组件的代码（其他扩展的渲染测试正是这么写）会撞上曾登记的 id 而静默变 0 行。所以加了一道「见过会话事件（`session_start` / `message_*`）才接管」的闸 —— 真会话里 id 唯一所以碰不到，但那是运气不是设计。**`ctrl+o` 展开态**是唯一能看到内容的地方：成员块不再隐身、各自按原有渲染器展开，组头那张树也不再折 `… +N`。行上限 `GROUP_MAX_ROWS = 5`；路径缩略到**两层目录 + 最后一段**（`PATH_TAIL_DIRS = 2`，更长才前缀 `…/`，cwd 相对优先于 home 相对）。**与 pi 原生渲染的取舍**：不做分组时原生 `grep` 块渲染 5 条匹配要 10 行、封顶 21 行，**比现在的 bash 折叠块（均值 7.1 行、封顶 8 行）还啰嗦** —— 所以「打开原生工具」与「做分组」必须一起上，单开工具反而更难看。33 个 `node --test` 用例：`classify.test.ts`（16，纯函数：可折叠矩阵含 `node --test \| grep` / 写重定向 / `sed -i` / heredoc / `2>/dev/null`、短语表、路径缩略、`-v` 过滤段不冒充检索路径、裸文件名兜底）+ `render.test.ts`（17，走 pi 真加载器三个扩展 + `ToolExecutionComponent`：形态、混合类别、thinking / 旁白 / 用户消息 / 跑测试四种断组、增量增长、圆点三态、行上限与展开、多宽度不超宽、展开态成员显形，外加**六条 2026-10-06 的 Bug 回归** —— 流式反复更新不得拆组（且新消息的 thinking 仍要断）、组长折叠态也不画输出、流式早期空 args 后续必须刷新、参数未到齐不得断组（三块合一棵树）、pending 口径（read/grep 缺必填参数算未到齐、ls 不算）、家族规则（Read 独立、Search/List/Git 同族、Read 夹中间把 Search 切开））。**不做**：不动 `bash-command-collapse` / `read-path-collapse` 既有渲染路径（只在 `renderCall` / `renderResult` 开头各加一个早返回），不动 session 记录与发给模型的内容（纯显示层） |
| `codemode-tree/` | **codemode 工具块的树形展示**（用户 2026-10-01 定，与 bash / read 块同一张列位表）：`• codemode` 顶格 → 代码（语法高亮，`… (N more lines, ctrl+o to expand)` 保留 10 视觉行预算）→ 结果树。列位与 bash 块**逐列对齐**：圆点列 0、`codemode` 与 `│` `└` 列 2、正文列 4；因此**所有子组件都按 `width - 4` 渲染**（命令侧也一样 —— 它在结果没到之前只挂 2 列缩进，那两列刻意空着；预算按最宽前缀算，折行宽度才不会在结果到达那一刻跳变）。`└ ` **整块只出现一次**，挂在结果的第一个实质内容行（嵌套调用清单的第一条）上，其下（后续调用、成本汇总、输出正文、截断提示）全部四格缩进；“执行中 → 结果到达”那一刻续行前缀从两格缩进换成 `│ `（判定看 `state.innerResult` 是否已存在，命令侧与结果侧因此**同帧**切换）。**圆点三态**（用户 2026-10-01 定，与 bash / read 同源，见 `stateDotSlot`）：**执行中白 `text`**、**成功绿 `toolDiffAdded`**（与 bash 成功圆点**逐字节同色**，测试是拿两份扩展同时渲染做对照的）、**失败红 `toolDiffRemoved`** —— 绿槽用的是 `toolDiffAdded` 而非 `success`，因为 bash / read 的绿圆点走的就是前者，两者当前主题里恰好同值、换皮会分叉。底色去掉后圆点是**唯一的结局灯**（pi 默认壳的 `toolErrorBg` 红底那层信号没了），所以它必须携带结局；缓存键里带上了状态，否则执行中的白点会被钉死到结果到达之后。`│` `└` 取 `muted`（结构符，自成一段 SGR）。整块无底色、无上下边界空行（`renderShell: "self"`，同上）。**它怎么拿到 codemode 的执行逻辑**：`codemode` 是 pi 的内置**扩展**（`builtin:codemode`）而不是内置工具，没有 `createCodemodeToolDefinition()` 这种“只给定义”的导出口径，所以这里用 `createCodemodeExtension()` 同一个工厂**捕获**它注册的定义（传一个只拦截 `registerTool` 的 Proxy，其余 `pi.*` 全部转发给真 API —— `getSettings` / `appendEntry` / `getAllTools` 都是工厂闭包里用到的，且要在调用时读实时值），然后展开 + 只覆盖两个渲染器与 `renderShell`。实测（真 CLI，2026-10-01）捕获到的 `parameters` 与 pi 自己那份**是同一个对象引用**，所以 MCP 扩展靠 schema 引用相等认「这是本包的 codemode」的那条 `isCodemodeTool()` 判定照常成立（换成自己写一份 schema 会让 MCP 的 codemode 自动激活静默失效）；A/B 同会话对比也确认**描述与参数 schema 逐字节相同**（5674 字节）。**settings 里配了 `extensions: ["-builtin:codemode"]`（用户 2026-10-01 决定）**：`codemode` 是 pi 声明了 `replaceable: true` 的内置扩展，另一个扩展注册同名工具时 pi 会把内置**整个不加载**并打一条 “built-in extension \`codemode\` was not loaded” 的 warning —— 那是预期的让位行为、不是错误，但 pi 启动时会把它渲染在**两处**（`[Extension issues]` 块 + `Warning: Extension package …` 行）且没有任何开关能压掉（`quietStartup` 只影响资源清单，不影响 diagnostics；扩展 API 也碰不到这两条的渲染）。用户选择显式禁用内置来消掉提示（SDK 实测：warnings 清零、codemode 仍由本扩展提供）。**代价**：`PI_CODEMODE_TREE=off` 的回退不再成立 —— off 时本扩展不注册、内置又被 settings 禁掉，codemode 工具会**整个消失**（此前 off 意味着“内置顶上”）；想恢复内置观感得先把 settings 里那条删掉。**折叠提示行有两种名词**（用户 2026-10-01 在大例子里看出来）：代码 / 输出预览是 `… (N more lines, …)` / `… (N earlier lines, …)`，而**嵌套调用清单**的折叠提示是 `... (N earlier calls, …)` —— 只认 `lines` 会让 `calls` 那行不被识别成提示行，`└ ` 就错挂在它头上（小例子调用数不过 8 条、根本不折叠，所以测不出来；回归断言用了内置渲染器的真实输出串）。`PI_CODEMODE_TREE=off` 关闭（注册期读一次；注意 settings 已禁内置，off 后 codemode 工具整个消失，不再是“恢复内置观感”）。23 个 `node --test` 用例：`render.test.ts`（11，纯逻辑：列位 / 宽度预算 / 连接态 / **圆点三态槽位**（含「执行中优先于 isError」）/ `└ ` 只一次 / 提示行挂 `│ ` / 提示行**两种名词**（`lines` 与 `calls`）全覆盖 / 全空返回空数组）+ `index.test.ts`（12，走 pi 真加载器 + `ToolExecutionComponent`：形状、**圆点三态**（含「成功态与 bash 成功圆点逐字节相同」与「结果到达后换色」）、**无底色**（三态、真彩色背景 SGR 判定）、无上下边界空行、`└ ` 只一次、`│` 列位、结果到达前后切换、截断提示行、语义继承（名字 / exposure / defaultActive / execute / prepareLoadout / parameters / renderShell）、展开态与多宽度不超宽）。**颜色断言刻意不硬编码色值**（bash / read 那 10 个长期失败用例就是写死了 `#666666`、主题一漂就误报），只断「与 bash 相同」这个关系与「三者互不相同」 |
| `prompt-editor.ts` | 输入框 `❯ ` gutter（`!` bash 模式下换成 `!`、正文里输入的 `!` 不再显示）+ 补全列表与 statusline 之间补一行空行；纯逻辑在 `prompt-editor/bash-prompt.ts` |
| `cwd-statusline.ts` | 用 `setStatus` 在 statusline 第二行显示完整 pwd（不经任何路径压缩） |
| `web-search-tree/` | **pi-web-access 三个工具块的树形展示**（用户 2026-10-02 定，覆盖 `pi_web_search` / `fetch_content` / `get_search_content`；与 bash / read / codemode 块同一张列位表）：`• search N queries` 顶格 → 查询列表 → 状态行（`3/3 queries, 18 sources`）→ 逐条预览 → 末行的 `└ ... (N more lines, M total, ctrl+o to expand)`。列位与其它块逐列对齐（圆点列 0、`│` `└` 列 2、正文列 4），子组件一律按 `width - 4` 渲染；**与 bash / codemode 的刻意区别**是 `└ ` 挂**末行**而不是第一个实质内容行 —— 这一块的末行（ctrl+o 提示）是通向完整 sources / 摘要的唯一入口，树要一直延伸到那句话（用户给的样例即如此）；圆点三态：执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`（与 bash / read 同源）。**接管方式**：包 `pi-web-access` 的默认导出就是那个 `ExtensionFactory`（没有「只给定义」的导出口径），所以用与 `codemode-tree/` 同一个手法 —— 只拦截 `registerTool` 的 Proxy 把 5 个工具定义捕获出来，**三个自带渲染器的（`pi_web_search` / `fetch_content` / `get_search_content`）都套上同一套树形外壳**（用户 2026-10-02 定；`fetch_content` 是第二轮扩进来的，用户贴的是它的 pending 进度条），剩下两个 **`source_check` / `web_enable` 没有自带渲染器**（走 pi 通用 fallback），接管等于从零自绘、是另一件事，**原样注册、观感不变**；`execute` / `parameters` / `description` / `promptSnippet` 全部是包自己那份的**同一个对象引用**（路由、存储、curator、模型可见文本一字未动）。**配套的 settings 过滤（关键，否则启动报 5 条 conflict）**：包自己也在 `extensions` 之前加载并注册这 5 个名字，同名注册会被 pi 判为 conflict 并写进 `[Extension issues]`，而 pi **没有**「事后替换已注册工具渲染器」的机制 —— 所以 `packages` 里给 `npm:pi-web-access` 写成**对象形式 + `"extensions": []`**（pi 官方文档 `docs/packages.md`「Select package resources」：`[]` = 该类型一个都不加载）：包本身**仍在册**（`listConfiguredPackages()` 显示 scope `user`、`installedPath` 照常解析、`filtered: true`），所以 `pi update` / `pi update --extensions` 照常提示并升级它 —— 与 `-builtin:codemode` 那种「禁用加载单元但不禁用包」是同一个手法（用户 2026-10-02 明确要求「升级还是正常升级」）。**实测对照**（SDK + 真 `ToolExecutionComponent`，2026-10-02）：加过滤前是 5 条 `Tool "…" conflicts with …` error，加过滤后 `errors: []` / `warnings: []`，包不再自动加载、5 个工具仍全在。**包不在时不注册任何东西**（fail-soft，不抛异常 —— 加载期抛异常同样是静默少工具、更难查）。包路径解析三条候选：`PI_WEB_ACCESS_EXTENSION` env → 裸说明符 `import("pi-web-access")`（jiti 按扩展自身目录向上找 `~/.pi/agent/node_modules/`，本机不存在但命中时最准）→ `~/.pi/agent/npm/node_modules/pi-web-access/dist/index.js` 兜底。`PI_WEB_SEARCH_TREE=off` 关闭，注意关闭后 `pi_web_search` 会**整个消失**（包已被过滤、本扩展又不注册），代价与 `PI_CODEMODE_TREE` 同形。**一个容易看不出的坑**：失败判定必须读 `context.isError` **+** `details.error` **+** 正文里的 `Error:` 行三者之或 —— 包有若干失败分支是**正常返回**一个带 `details.error` 的对象（不是 throw），只看 `context.isError` 会让那些路径一直显示绿点；且这个判定要在 `renderResult` 里**同步**算完存进 `context.state`（圆点由 `renderCall` 画），否则容器渲染时 call 先于 result 取到未置位的标志。44 个 `node --test` 用例：`render.test.ts`（27，纯逻辑）+ `index.test.ts`（17，走 pi 真加载器 + `ToolExecutionComponent`，含**两条对照组** —— 拿未接管的包原版 `pi_web_search` / `fetch_content` 定义渲染，断言它们「有底色 / 无树符」，以此证明形状断言不是空转；另有一条钉住 `source_check` / `web_enable` **未被接管**）。 |
| `folder-history.ts` | 按工作目录持久化命令历史，注入编辑器原生 ↑/↓（**不注册快捷键** —— 上游的 ctrl+↑/↓ 在 macOS 上被 Mission Control 抢走） |
| `clear-command.ts` | `/clear` 别名 → `ctx.newSession()`（先 `waitForIdle`，与内置 `/new` 同一条流程） |
| `exit-command.ts` | 整行 `exit` / `quit` 优雅退出（只在 TUI 模式；`--print` 里仍是普通 prompt） |
| `init-command.ts` | Claude Code 式 `/init`：`CLAUDE.md` → 否则 `AGENTS.md` → 否则新建 `AGENTS.md` |
| `ask-user-question/` | Claude Code `AskUserQuestion` 式的结构化提问工具（子会话里按 `ctx.hasUI` 自动摘掉）。工具块带 `renderShell: "self"`（用户 2026-09-26 定，与 simple-task / bash / read 同一套壳）：**无底色**、**无上下边界空行**，`renderCall` / `renderResult` 用 `new Text(…, 1, 0)` 从前一列起画；形状断言在 `render.test.ts`（4 个用例） |
| ~~`mcp/`~~ | **已退役（2026-09-30）**：MCP 自 pi 0.99.1 起是内置扩展 `builtin:mcp`（同样注册 `/mcp`，两者互斥），本仓库不再自带该扩展；用法与退役理由见上一节 |
| `simple-task/` | 轻量任务清单（`task_set` / `task_update` / `task_get`）。计划批准后模型认为该建清单就自己 `task_set`，扩展不再代它建（2026-09-24 起与 plan-mode 无耦合）。三个工具都带 `renderShell: "self"`（用户 2026-09-26 定，与 bash / read 块同一套壳）：整块**没有底色**（pending / 成功 / 失败三色底都不画）、**没有上下边界空行**（默认壳 `Box(1, 1)` 的上下两条）；标题与结果都从**列 1** 起 —— 每行前置一个空格、不顶格（补回默认壳原本的那一列左边距，由 Text 的 `paddingX = 1` 画）；块上方只剩 pi self 模式固定的那一行留白。形状断言见 `render.test.ts`（3 个端到端用例，含「其他工具底色照旧」的对照）。**视口滚动**（用户 2026-10-02 定）：一帧最多画 **8** 条任务项（超过就开始折叠），但窗口不再固定从 #1 起 —— 执行到第 9 项时列表跟着往下滚，让当前项进视口（前 10 项完成、`#11` 进行中 → `… 3 more` + `#4`..#11 + `… and 2 more`，双侧提示行**不占**那 8 个名额）。三条规则在纯模块 `viewport.ts`：**锚点 = 第一个未完成项**、**最小位移**（锚点已在窗口内就不动）、**全部完成时停在末尾**（不跳回开头）；上行 `… N more` 只在真滚过时出现，8 项以内与改动前逐字节相同。14 个 `node --test` 用例：`viewport.test.ts`（9，纯代数）+ `widget.test.ts`（5，走 pi 真加载器渲染真行，含用户样例的逐字复现与「折叠提示行算有内容、gap 仍补空行」） |
| `plan-mode/` | Claude Code 式 plan mode + **三态权限模式**（`dangerous` / `bypass` / `plan`）。两个弹框（模型进入同意框、计划审批框）的正文走 `text` 槽（fg），标题与高亮选项保留 accent（`consent.ts`，2026-09-30）。`shift+tab` 走固定循环 `dangerous → bypass → plan → dangerous`；`/plan` 只切 plan（永远不落到 dangerous）、`--plan` 启动即进；模型可自行调 `enter_plan_mode` 进入、用 `exit_plan_mode` 提交**一份完整方案文本**等用户批准；批准后模型把方案落成计划文档（`.pi/plans/`），写完自动收尾并回到**进入前的模式**。dangerous 关掉沙箱删除拦截，bypass 开启。两个工具调用块带 `renderShell: "self"` 的树形渲染（用户 2026-09-29 定，与 bash / simple-task 块同一套壳）：**无底色、无下空行**（上方只剩 pi self 模式固定的那一行留白）；标题行 = 状态圆点 + 加粗工具原名 + 结局标记（**从圆点起顶格**，圆点前无空格；几何是 `•` 列 0、`│`/`└` 列 2、正文列 4 —— 树符正好落在工具名首字母正下方，与 bash 块同一张表）—— 成功绿 `•`+`✔`（`success` 槽）/ 被用户否掉或被打回灰 `•`+`✘`（`dim`）/ 真错误红 `•`+`✘`（`error`）/ 执行中灰 `•` 无标记；正文是**结果全文**折行挂树 —— 除末行外 `│ `、**末行 `└ `**（与 bash 块「`└` 只落在第一个实质输出行」刻意分叉，见 `render.ts` 文件头），结构符 `muted` 自成一段 SGR；正文走 `text` 槽（fg 颜色，用户 2026-09-29 定）——计划正文要用户逐字读并据此拍板，不跟 read / grep 输出一样被 `toolOutput` 压暗。结局分类读 `details`（`consented` / `accepted` 严格 true 才算成功，isError 优先），标题标记靠 renderResult 写 `context.state` + renderCall 懒组件读回（同一次 updateDisplay 里 callRenderer 先于 resultRenderer，当场读不到）。形态断言见 `render.test.ts` / `index.test.ts`。详见下文 |
| `core-rules/` | 对抗全局 AGENTS.md 的注意力衰退：把蒸馏版核心铁律（`~/.pi/agent/AGENTS.core.md`，约 7.8KB，仓库镜像 `clients/pi/AGENTS.core.md`）在会话开始 / 压缩后 / 内容变更三个时机持久化注入到上下文末尾（用户消息之后），照 Codex 的 world-state diff 语义（不变不发、变了带替换声明）。判定在 `decision.ts`；`PI_CORE_RULES=off` 关闭 |
| `verify-loop/` | **验证闭环 + 评估器**（补 issue #12 权重最高的一格空白），对齐 CC 的两个原生件，落在 pi 官方的 `agent_before_settle` 边界上（"the final actionable boundary: it can append entries and request one continuation"）。**(1) 闸**（CC 的 `type:"command"` Stop hook）：每次 settle（仅 `outcome==="completed"`，abort / error 不触发 —— CC 的 Stop / StopFailure 分流）检查本次 run（最后一条 user 消息之后）：有文件改动（`edit`/`write`/`apply_patch`/`multiedit`，非文档路径）但**改动之后没跑过任何 bash 命令** → 追加一条 `display:true` 的注入消息（用户可见 = CC 的 "Stop hook feedback"；同时以 user 角色进模型上下文）并 `continue:true` 强制续跑一轮。**拦截次数不用内存计数器，而是数投影里已注入的同类消息** —— `agent_start` 在每次边界续跑时都会再 fire（`runAgentLoopContinue` 里 emit），挂在它上面的复位会在续跑链里把计数清零、上限失效；从投影数则天然分支正确、resume 后仍正确、无可变状态，且注入消息是 `role:"custom"`（不是 user），不会切断 run 窗口 —— 整条续跑链共用一个窗口，正是 CC「同一 turn 内连续 block」的语义。上限默认 2（`PI_VERIFY_LOOP_CAP`；CC 的通用 8 是给任意用户 hook 的）。**verification 口径 = 任何 bash 调用**：2026-09-25 第一次活体冒烟量到误报 —— 模型改完 `probe.js` 跑的是 `node --input-type=module -e "import('./probe.js')…"`，真证据但不匹配任何测试形状，被闸第二次拦下；词法判不了「这条命令是不是*相关的*测试」（那是评估器的活），所以闸只问「改动之后有没有观察过实际状态」。`PI_VERIFY_PATTERN=strict` 恢复只认测试/构建/lint 形状，或给自定义正则。**(2) `/goal`**（CC 的会话级 prompt 评估器，手动设定、之后每轮自动评估）：`/goal <条件>`（≤4000 字符，CC 同限）存 `appendEntry` 并立即以条件为指令起一轮；此后每次 settle 先问子代理在不在跑（在 → 本轮跳过，CC 的 "background work defers evaluation"，复用 `recap/subagents.ts` 的 RPC），再发一次**不带工具**的独立模型调用（条件 + `serializeConversation(convertToLlm(投影))` 截尾，默认 120k 字符），解析三裁决 JSON（`met`/`not_met`/`impossible`，裸 / 包 code fence 都认）：未达成 → 理由注入续跑；达成 / 不可能 → 记录条目并清除。**fail-open**：评估失败 / 超时 / 解析不出 → 放行（CC 的 hook 失败同样不拦回合）。无进展检测（连续 2 轮续跑零工具调用 → 停循环、goal 保留，CC："stops the loop … with the goal still set"）与 8 次续跑上限（`PI_GOAL_CAP`，CC 的数字）同样从投影数。resume 恢复活跃 goal 但重置轮数计时（CC："carries the condition over but resets the turn count"）；已达成 / 已不可能的不恢复。评估模型 `PI_VERIFY_EVALUATOR_MODEL=provider/modelId`，缺省 `litellm-any/qwen3.8-flash`，再退回当前会话模型；已知成本 —— 这些路由的 thinking 是 `gateway/config.yaml` 钉死的，评估调用也付 thinking（实测 3-20s）。**与 CC 的唯一有意偏离**：CC 默认不装任何 hook（用户在 settings.json 配置）；这里没有 hooks 配置层，所以闸**默认 block 开启**、触发条件收得极窄，`PI_VERIFY_LOOP=off|notify|block` 一键切换。2026-09-25 活体验证（隔离 agent dir + SDK 驱动）：闸拦一次后模型补验证放行；`/goal VALUE=42` 驱动模型真改文件到 `met`（证据是命令输出）；只口头声称的一轮被判 `not_met` → 注入理由 → 真干活 → `met`；不可满足条件判 `impossible` 并清除。量到的一个 pi 限制（非本扩展 bug）：会触发回合的扩展命令（`/goal`，以及既有的 `/init`）在 `-p` print 模式下不生效 —— `session.prompt()` 在命令的 `sendUserMessage` 回合开始前就返回。91 个 `node --test` 用例：`gate.test.ts`（24）/ `goal.test.ts`（23）/ `evaluator.test.ts`（23）纯逻辑 + `index.test.ts`（21）走 pi 真加载器（假子代理总线 + 假 model registry） |
| `memory/` | **类 CC auto-memory**（补 issue #13 权重最高的一格空白：记忆 / 跨会话学习）。存储照 CC：`~/.pi/agent/memory/<git根slug>/` 下 `MEMORY.md` 索引 + 一记忆一文件（CC 兼容 frontmatter：`name`/`description`/`metadata.type` 四选一 user/feedback/project/reference /`modified`）。**方案 C：索引由扩展机械派生，模型不手写** —— `memory_write` 写完正文后扫全部正文 frontmatter 自动重建索引（内容一致不落盘，幂等），消除 CC/Qoder 都在搏斗的「忘更新索引 → 写进去却永远召回不到」故障源；手改正文文件后下次 `before_agent_start` 自动纳入索引。注入走 `before_agent_start` 改 `systemPromptOptions.sections.memory`（纪律文本 + 索引，空库不注入）—— section 进 system message、随 transcript 重放、压缩后存活；索引只在写入时变化，字节天然稳定，**不需要 pi-memory 那套 KV 缓存快照机制**。纪律文本 = CC 三道闸（applicable/durable/legible）+ 时态判据（只存过去时观察，不存现在时仓库状态断言 —— 过去时永不过期，现在时必然腐烂）+ 读取端核实义务（记忆是快照不是地面真相，点名文件/函数/flag 的记忆行动前先核实，AGENTS.md `## Verification` 同款）+ 不存密钥。四个工具：`memory_write`（写正文+重建索引，同名=更新）、`memory_read`（读正文/列全部）、`memory_forget`（删除+索引更新）、`memory_search`（零依赖关键词检索，frontmatter 命中权重 3 / 正文 1）；全部文件读写包 `withFileMutationQueue`（工具调用并行执行）。`/memory` 命令（对标 CC 三项）：状态行 + 打开目录 + 显示索引 + 开关（per-project `.disabled` 标记）。`PI_MEMORY=off` 整体关闭，`PI_MEMORY_DIR` 覆盖记忆根（测试隔离）。**v1 刻意不做**：后台 dream 固化（留挂载点）、USER/PROJECT 双 scope（仅 per-project）、qmd 语义搜索、写入机械闸（时态/密钥靠纪律文本）。**四个工具块的展示形态**（用户 2026-09-30 定：与 bash / plan / 后台任务块同族）：都不再走 pi 默认壳（`toolSuccessBg` 底色 + 上下空行 + 平铺正文），改成 `renderShell: "self"` + 树形：标题行 `• 工具名` 顶格（圆点是结局灯：成功绿 `success`、declined 灰 `dim`、错误红 `error`；declined = `details.action` 落在 `rejected` / `blocked` / `not_found`），正文挂 2 列缩进的树（`│` 续行、`└` 末行，结构符 `muted`、正文 `text` 槽），几何与 plan 块同一张表（`•` 列 0、`│`/`└` 列 2、正文列 4 —— 对齐工具名首字母）。**工具块不打任何标记**（同后台任务块那套语言：圆点已是结局灯，记忆工具是一次同步读写、没有「还在跑」的后续，`✔`/`✘` 都是同一件事说两遍）。形态决定（结局分类 / 标题装饰 / 树前缀 / 预览截断）在纯模块 `render.ts`，上色折行在 `index.ts`；预览截断保留 pi 默认壳原有行为：非展开态裁到 10 行 + `… (N more lines, ctrl+o to expand)` 提示，展开态（ctrl+o）不裁 —— 否则 `memory_read` 读长正文或不带 name 列几十条记忆会平铺满屏。46 个 `node --test` 用例：`store.test.ts`（10）/ `context.test.ts`（4）/ `render.test.ts`（11，结局分类 / 标题装饰四态均无标记 / 树前缀 / 几何常量 / 预览提示文案）纯逻辑 + `index.test.ts`（21）走 pi 真加载器（含 issue #13 那个 promptSnippet 被剥 bug 的回归断言，以及**工具块渲染形态 9 例**：self 壳、标题四态含「无任何标记、区分只在点色」（painted 主题断言色槽）、树形正文几何、折行后 `└` 仍只在末行、预览截断 + 展开态、经 pi 真组件渲染无底色无边界空行 + 「其他工具底色照旧」对照、执行中块只有标题行）。设计文档 `docs/superpowers/specs/2026-09-26-pi-memory-design.md` |
| `working-indicator/` | 语义化工作标签（`Tools Calling` / `Editing` / `Writing` / `Reading` / `Thinking`，否则 `Working`）+ 每秒回合计时 + 幻彩 spinner + 长提示词自动摘要 + bash 运行 `●` 指示。**watchdog 提示**：pi-subagents 的 watchdog 在改过仓库的回合的 `agent_end` 里跑一次独立审查模型（实测 7~17s），而 pi 要等所有 `agent_end` handler 跑完才清 spinner —— 那段时间 spinner 一直转却没解释。本扩展在 `agent_end` 后起一个一次性定时器（`PI_WORKING_INDICATOR_WATCHDOG_DELAY_MS`，默认 2s），到点还没 settle 就把文案切成 `Subagent watchdog reviewing`（用户指定，英文，不带时长/token）；`agent_settled` / `agent_before_settle` / `session_before_compact` / `agent_start` / `session_shutdown` 任一到就复位 —— 后两个是为了不把自动压缩与 verify-loop 的 `/goal` 评估（都发生在应用层 agent_end 之后、settled 之前）误标成 watchdog。正常回合 settled 是毫秒级，2s 阈值不误报。`PI_WORKING_INDICATOR_WATCHDOG=off` 关闭。**回合结束符**（用户 2026-10-07 定）：回合跑完（`agent_settled`，仅 `outcome === "completed"`，ESC / 报错不画）在 spinner 原位留一行 `✻ Churned for 3m 37s · done 11:52 PM` —— 十个词（`Churned` / `Spun` / `Thrashed` / `Grinding` / `Chugging` / `Ping-ponging` / `Looping` / `Fizzling` / `Flickering` / `Stalled`）每回合随机一个、时长复用 spinner 读秒的 `formatDuration`（`agent_start`→`agent_settled` 墙钟）、时刻 `en-US` 12 小时制、整行 `dim`（同 recap 的 `Recap:` 标签）—— 纯逻辑在 `turn-marker.ts`。落点是编辑器上方 widget 区：spinner 所在的 `statusContainer` 在回合外没有入口（pi 在应用层 `agent_end` 就清掉，`setWorkingMessage` 只在流式期间有效）；占的行数照抄 spinner（上方 widget 区自带前导空行 + 结束符 + 组件自己补的行尾空行，用户 2026-10-07 要求），所以编辑器不会上移一格。`agent_start` 清掉、让位给新 spinner；`PI_TURN_MARKER=off` 关闭 |
| `background-tasks/` | **最简版 `run_in_background`**（补 pi 0.87.1 的后台执行原语空白：`run_in_background` 在全部 dist 里 0 命中，`ExecOptions` 只有 signal / timeout / cwd，长任务只能前台阻塞到超时）。工具面对齐 CC 三件套：`run_in_background`（= Bash 的 `run_in_background: true`）/ `background_output`（= `BashOutput`，默认增量读，offset 是累计字符绝对值）/ `background_kill`（= `KillShell`），外加 `/background` 命令（= CC 的 `/bashes`：列表 / `<id>` 详情+日志尾部 / `kill <id>`）。**完成即唤醒**：任务进终态时注入一条 `<background-task-notification>` 并 `triggerTurn` 起一轮模型跟进（空闲直接起新一轮，流式中 `deliverAs:"followUp"` 排到本轮结束），所以工具描述里明写「不要 sleep / 不要轮询等它」。**任务随 pi 会话生死**：`session_shutdown` 里 `killAll()`（幂等）；spawn 用 `detached:true` 只为让命令当自己进程组组长，好让 `kill(-pid)` 整组带走（`npm test` 的 worker、管道各段），**不 unref**，因此不需要跨重启恢复逻辑。代价两条已记录：pi 被 SIGKILL 时没机会跑 shutdown，以及 `/reload` 会结束在跑的任务。会话替换（`/clear`、`/new`、`/resume`）也发 `session_shutdown` 但扩展实例不死，所以 `session_start` 一到就把 `disposed` 复位（否则新会话里的任务永远唤醒不了模型），并用 registry 身份闸挡住旧会话被 killAll 的任务的迟到 exit 注入新会话。**后台命令不经过前台 bash 的 seatbelt 删除边界**（扩展直接 spawn，语义等同用户自己 `cmd &`），工具描述与 `/background` 输出里都印了这句提示。输出双写：内存环形缓冲（256KB，超限丢最旧块并如实报 `droppedBefore`）+ 日志文件 `<agentDir>/bg-tasks/<sessionId>/<id>.log`（完整，不受环形上限影响；文件同步 touch 出来，因为工具结果当场就把路径交给了模型）。stdout / stderr 合并成一条流（等价 `2>&1`）。`registry.ts` 是纯逻辑（spawn / now / 上限 / 宽限期全可注入），`index.ts` 只接线。**worktree 隔离**（用户 2026-09-30 定，对齐 CC 的 `isolation: "worktree"`）：默认**每个后台任务在仓库的一份独立 git worktree 里跑** —— 多个并发任务不再共享同一份工作区（起因是 mc-heavy 那次实测：`bg_4` 的 A/B 脚本改写 `minecart-config.js` 时，`bg_3` 声称在测「基线」却读到了处理组的代码，基线数据静默作废；限流解决不了它，因为 8 个并发全在阈值以下而 `cargo test`/`npm install` 这类安全并行反会被误伤）。三个实现选择：**基线是 HEAD**（未提交改动不带进去，起点干净正是「有没有改动」判定可靠的前提；代价是先在前台改完文件再起后台测试会测到旧代码 —— 要验证当前工作区必须 `worktree: false`）、**被 ignore 的 `node_modules` symlink 主仓库那一份**（不链任务根本跑不起来；已被 `lstat` 挡掉链中链）、**worktree 落在 `$TMPDIR`**（`fs.mkdtempSync(os.tmpdir()+"/pi-bg-")`，在 seatbelt 可删边界内所以 `git worktree remove` 不会被拦，且保留态不污染仓库树）。建用 `git worktree add --detach <dir> HEAD`（`--detach` 而非 CC 的 `-B`：不动 `git branch` 列表）。**清理三态照抄 CC**（`worktree.ts` 的 `cleanupWorktree`）：无改动 → `git worktree remove --force` + `prune`，**完全无痕**；有未提交改动或新 commit → **保留**并把路径（有新 commit 还带一个 `pi/bg_<id>-<时间戳>` 分支，否则 detached commit 会被 gc 丢掉）写进终态通知；删除失败 → 保留 + 原始报错（fail-safe）。**通知前先清完**（`finishTask` 里 `await cleanupWorktree` 再 `sendMessage`）：通知是 `triggerTurn` 的，反过来会把「worktree 还在不在」变成竞态；清理**不**受 `disposed` 闸门约束（`session_shutdown` 的 `killAll` 是泄漏最多的一条路，必须照清）。建/删都走 `serializeGit` 进程内队列（只排这几毫秒的元数据操作，任务本身仍并行）。不在 git 仓库 / 建失败 → **静默降级**为不隔离在原 cwd 跑，只把事实告诉模型（`未隔离（不在 git 仓库里）`）—— 隔离是增强不是前提。**有一处实测坑必须记住**：`.gitignore` 的 `node_modules/` 只匹配**目录**，而链进去的是**符号链接**，git 把它当未跟踪文件（`?? node_modules`），不排除的话每个任务都会被判成「有改动」、无改动就删的那一态永远走不到 —— `detectChanges` 因此用 pathspec 排除（`git status --porcelain -- . ':(exclude)node_modules'`），且传进去的必须是**相对路径**（`path.relative` 会把相对项当成相对进程 cwd 的路径、算出爬出 worktree 的 `../..` 然后被过滤掉，实测踩到过）。开关 `PI_BACKGROUND_TASKS_WORKTREE=off` 整体关闭。已知限制：每次调用多 ~100–300ms（`git worktree add` + symlink + 一次 status）；任务往 `node_modules/` 里写（`npm install`、工具缓存）会落到主仓库那份，隔离不完整；`$TMPDIR` 的保留态可能被系统清理；worktree 元数据仍写在主仓库 `.git/worktrees/`（`git worktree add` 机制，删路径时一并 prune），而**当仓库不在沙箱可删边界内时连 `git worktree add` 都会被内核拦下**（`.git/worktrees/<name>/HEAD.lock` 的 unlink）—— mc-heavy 实测如此，报错会如实返回、任务降级为不隔离。**工具块与终态通知的展示形态**（用户 2026-09-30 定：参照 plan 工具调用块）：三个工具（`run_in_background` / `background_output` / `background_kill`）与终态通知都不再走 pi 默认壳（`toolSuccessBg` 底色 + 上下空行 + 平铺正文），改成 `renderShell: "self"` + 树形：标题行 `• 工具名` 顶格（圆点是结局灯：成功绿 `success`、declined 灰 `dim`、错误红 `error`），正文挂 2 列缩进的树（`│` 续行、`└` 末行，结构符 `muted`、正文**结果正文色**（`bashOutput`，主题没定义时退回 `toolOutput` —— 与 bash 工具调用后的输出同色，用户 2026-10-06 定；改成这条之前是 `text` 槽 = fg））。**工具块不打任何标记**（用户 2026-09-30 分两轮定：先去掉成功的 `✔`，再去掉失败的 `✘`）：对号在这套界面语言里的意思是「任务跑完了」，而 `run_in_background` 成功恰恰意味着任务**才刚开始**、还在后台跑，打对号会被读成「已经结束」并与终态通知的 ✔ 撞车；叉号对工具块也是多余的 —— 圆点颜色已经是结局灯，再叠一个叉是同一件事说两遗，而且 `background_kill` 这类调用里「没办成」（找不到任务 / 已终态）是模型自己下一步就能纠正的普通分支、不是需要警示的故障，正文里已经写了原因。代价（已接受）：declined 与 pending 的圆点同为 `dim`，标题行上不可区分 —— 但 pending 没有正文（结果未到）、declined 有，屏幕上仍分得开。正文颜色取**第一个主题里真实存在的槽**（`BODY_TEXT_SLOTS` = `bashOutput` → `toolOutput`）：官方皮肤没有 `bashOutput` 这个扩展 token，`theme.fg()` 会抛 `Unknown theme color`，所以 `pickBodySlot` 真调一次探测、失败即回退 `toolOutput`（那些皮肤下 bash 输出本色也是它，两边自动同色）；两份 renderer（工具块 + 通知）共用，填缓存时每 width 探测一次。终态通知从旧的 `✓ 后台任务 bg_1 结束:`（前缀对号 + `customMessageBg` 底色 + 上下空行）改成 `• 后台任务 bg_1 结束 ✔`（圆点顶格、**对号移行末**、无底色无下空行）—— 通知与工具块不同，**保留标记**：它是会话里唯一一条「任务结局」的权威陈述，而且模型会因为它被叫醒开新一轮；且**只要结束就是 `✔`**（用户 2026-09-30 第三轮定）：`✔` 断言的是「结束」而非「成功」，exit 0、被 kill、非 0 退出都打 `✔`，成败由**圆点颜色**（结局灯：exit 0 绿、killed / 非 0 / 形状认不出 红）与正文措辞（`已成功结束` / `已失败结束（exit=1）`）表达，而不是靠把对号换成叉号 —— 这个二值点色判定与改形前的 `failed` 判定同语义。形态决定（结局分类 / 标题装饰 / 树前缀 / 预览截断）在纯模块 `render.ts`（与 `plan-mode/render.ts` 同形；标题装饰分 `bgToolTitleParts`（工具块，只回点色槽）与 `bgNotificationTitleParts`（终态通知，点 + 行末标记同色）两个函数，后者复用前者取点色），上色折行在 `index.ts`。预览截断保留 pi 默认壳原有的行为：非展开态裁到 10 行 + `… (N more lines, ctrl+o to expand)` 提示，展开态（ctrl+o）不裁 —— 否则 `background_output` 一次 30000 字符的返回会平铺满屏。**statusline 底部的任务 dock**：有任务在跑（或刚进终态）时 footer 最底部多一行 `⚙ bg_1 running 12s · npm run test --silent…` —— 文案与配色在纯模块 `status.ts`（图标 dim / id accent / 状态词按结局着色：running → warning、exit 0 → success、非 0 与 killed → error / 时长 muted / 命令 dim），`index.ts` 只负责发布与节拍：一个 1s 的 `setInterval`（`unref`）重算并 `ctx.ui.setStatus("background-tasks", …)`，没东西可显示时自己停表并清键；永远只显示一行（最新启动的 running 任务优先，没 running 时取驻留窗口内最新的终态任务，同类其余折叠成 `(+N)`），终态行驻留 `TERMINAL_LINGER_MS`（10s）后消失；**`(+N)` 刻意放在命令之前**（超宽时只有行尾命令被截，计数正是多任务时唯一的信息，不能跟着没）；弹窗期间（`ui_prompt_start` → `ui_prompt_end`）**一次都不发布** —— 不只是停掉秒级 tick，连事件驱动的那一下（任务恰好在弹窗里结束时的终态回调）也跳过：pi 主屏渲染每次把视口钉在底部，一次重绘同样会把用户手动上翻的 scrollback 拽回去（与 working-indicator 冻结重绘同一条理由）。弹窗一关，`ui_prompt_end` 按**当前真实状态**重算，所以什么都不丢（时长也是重算的，不会停在旧值）。105 个 `node --test` 用例：`registry.test.ts`（16，假子进程驱动完整状态机；假 pid 取在系统上限之上，组杀路径永远不会误伤真进程）+ `worktree.test.ts`（17，**真 git fixture**：tmpdir 里 `git init` + 一次 commit + 被 ignore 的 `node_modules`；建/路径/runCwd、未提交改动不带进去、symlink 与 pathspec 排除（含“不排除时 git 确实会把它当未跟踪”的反证）、未 ignore 的目录不链、非 git/空仓库降级、三态各一例、detached commit 挂分支、幂等、`serializeGit` 串行与失败不毒化、realpath 归一）+ `status.test.ts`（26，dock 行的四种结局形态 / 任务选取 / 驻留边界 / 命令粗截 / 色槽 / `(+N)` 截断回归，外加结轮第二行的 10 例）+ `render.test.ts`（22，结局分类 / 两套标题装饰（工具块四态均无标记 vs 通知恒 ✔、失败时点与 ✔ 同红）/ 树前缀 / 几何常量 / **正文色槽优先级** / 预览提示文案）+ `index.test.ts`（48，走 pi 真加载器 + **真 spawn**：完成通知、增量读不重复、组杀连孙进程一起带走、shutdown 不留孤儿进程、`/background` 详情不推进模型的增量 offset、会话替换后 disposed 复位、旧 registry 迟到终态不注入新会话、**工具块与终态通知的渲染形态 13 例**（self 壳、标题四态含「工具块无任何标记、区分只在点色」、树形正文、预览截断 + 展开态、无底色、通知「只要结束就是 ✔」与失败点色、色槽），以及 dock 的 11 个：启动即发布、秒级 tick 推进时长、终态驻留后自动清键且停表、弹窗冻结/恢复、**弹窗期间连事件驱动的那一下也不发布**（终态通知落在弹窗里同样不重绘）、shutdown 清键停表、`DOCK=off` 时一次 setStatus 都不调、`agent_settled` 后补第二行且 `agent_start` 清掉、终态任务不被补第二行、两个回合钩子的注册面），外加 **worktree 隔离 5 例**：默认隔离下命令真跑在 `$TMPDIR` 的 worktree 里（会话目录不出现产物、未提交文件不在其中）、无改动终态后目录与 `git worktree list` 都清干净、改文件后保留且通知带路径与改动数、`worktree: false` 落回原 cwd 且看得到未提交改动、非 git 目录静默降级。测试隔离用 `setIsolationEnv`，它把 `PI_BACKGROUND_TASKS_WORKTREE`/`TMPDIR` 记进**单独的待还原列表**并在每次 `loadHarness()` 开头还原 —— 混进全局 `cleanup`（要到文件跑完才执行）会让前一个用例的 `TMPDIR` 把后一个用例的 worktree 落进前一个用例的临时目录、`WORKTREE=off` 也会漏到下一个用例（实测踩到过）。`PI_BACKGROUND_TASKS=off` 关闭，`PI_BACKGROUND_TASKS_DIR` 覆盖日志根（测试隔离），`PI_BACKGROUND_TASKS_DOCK=off` 只关 statusline 那一行（工具与通知照旧），`PI_BACKGROUND_TASKS_WORKTREE=off` 关掉 worktree 隔离，`PI_BACKGROUND_TASKS_DOCK_LINGER_MS` 改终态行驻留时长，`PI_BACKGROUND_TASKS_TURN_NOTE_MS` 改结轮提示的运行时长阈值（默认 5s）。**结轮提示第二行**（用户 2026-09-29，来自 bg_2 那次事故：主任务 05:38 就收工，bg_2/bg_3 一直挂到 05:43，dock 却和正常在跑长得一模一样）：本轮 `agent_settled` 之后、仍在跑且已跑满阈值的任务，下面多一行 `  └ Task is still running`（`└` U+2514 悬在任务 id 下方，自身 muted、文案 warning）。措辞是**事实陈述，不是价值判断** —— 扩展分不出「孤儿残留」（截图早已落盘、进程只是不退出）与「本来就该长跑」（8 分钟的 `npm test` 跨过回合结束完全正常），所以只说能证明的那半句；用户明确否掉了「这些任务已不需要 / 可以删除」的强措辞与另发一条一次性 `[提示]`，dock 行就是全部。文案本身于 2026-10-01 改为英文 `Task is still running`（用户定）：前半句「本轮已结束」不再写 —— dock 出现的位置本身就说明了这件事，复述一遍只会占宽，而 `running` 这类状态词也是英文，句子里外同一种语言。三个条件同时满足才出现：任务 `running`（终态驻留窗口里不需要这句）、本轮已结束、且 `now - startedAt >= TURN_NOTE_THRESHOLD_MS`（默认 5000ms）；`agent_settled` 激活、`agent_start` 清除、`session_start` 也清除（新建会话不能继承上一轮的回合状态）；用 `agent_settled` 而非 `agent_end` 是因为自动压缩与 verify-loop 的 `/goal` 评估都跑在 app 级 `agent_end` 之后、`agent_settled` 之前。`formatBackgroundStatus` 多一个可选的 `turn` 入参，命中时返回值**恰好含一个 `\n`**，不传时与旧单行形状逐字节一致 |
| `bash-command-collapse/sandbox.ts` + `allowlist.ts` | bash 命令的 seatbelt 删除能力边界（`bash-command-collapse.ts` 的 `execute` 里包裹）与**三档授权**（用户 2026-09-24 定）：**永不删除**（身份/凭据/手写配置：`~/.zshrc`、`~/.gitconfig`、`~/.env`、`~/.bash_history`、`~/.envrc`、`~/.tool-versions` 等 home 一级文件（49 项），以及 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.docker`、`~/.azure`、`~/.gcloud`、`~/.terraform.d`、`~/.helm`、`~/.minikube`、`~/.password-store` 等子树（21 项）；**名字里可以带斜杠** —— `~/.config/gh`（`hosts.yml` 存 GitHub token）与 `~/.config/gcloud`（凭据库）是两条嵌套条目，2026-09-25 补，专门把「`~/.config` 整棵移出本档」之后落在两级的真凭据捞回来；代价是 `isSafeAllowlistRoot` / `isSafeSessionRoot` 的**祖先闸改为只查危险档**（用户 2026-09-25 选），否则 `~/.config` 会因「是 `~/.config/gh` 的祖先」而永远记不住 —— 安全上无损失，内核 deny 行在 allow 行之后无条件收回，`classifyOutsidePaths` 也先判 blocked 再判白名单，记住 `~/.config` 交不出 `~/.config/gh`；`~/.config`、`~/.pi`、`~/.claude`、`~/.codex` 于 2026-09-25 移出本档 —— 它们是工具状态目录，含 lock/缓存/会话日志，整棵子树不给删连 pi 自己清理 stale lock 都会被内核拦死，现走普通档弹框可记住）——**不弹框、无任何放行选项**，白名单 / 会话豁免 / `PI_SANDBOX_EXTRA_WRITE` 都压不过（profile 在 allow 行之后另起一行 deny 收回，内核级强制）；**危险目录**（系统根 / bin / 应用安装目录 / `~/Library` / 含 `.git`）每次删除必问、只支持会话级豁免（选项 `Deny` / `Allow once` / `Allow for this session`）；**普通目录**问一次（`Deny` / `Allow for this session（并记住该目录）` / `Allow once`），选中间那项后把目录范围写进持久白名单 `~/.pi/agent/sandbox-allowlist.json`（`PI_SANDBOX_ALLOWLIST` 可改位置），以后含 headless 都不再问。记住一个目录 = 把它并进 seatbelt profile 的 `file-write-unlink` 放行名单，删除在沙箱内直接成功。**profile 的底于 2026-10-01 从 `(deny default)` 改为 `(allow default)`**（用户口径「只拦危险的删除，其他动作一律不拦」）：旧的 fail-closed 底枚举「允许什么」，于是拦截面不是删除而是「没被枚举的每个 seatbelt 操作」，实测 `screencapture` 因缺 `iokit-open` 而以 `Trace/BPT trap: 5` 死掉（沙箱外正常出图），逐条二分证实补这一条即可 —— 缺的是枚举而非权限判定。改成 `(allow default)` 后只枚举「不许删什么」，17 格矩阵实测新旧两种底逐格一致（`file-write-unlink` 是独立 mach 操作，`allow default` 不会替它开口子）。已知且不修：`ps` / `top` / `launchctl list` 在 `(allow default)` 下仍被拦，属 seatbelt 自身限制。代价：沙箱不再兜底「未枚举的未知操作」，除删除外一概不管。同一轮还修了两处：升级弹框链路（pi 0.99.1 起内置 bash 改 `return { isError: true }`，而整段弹框逻辑挂在 `catch` 上，已改为两条投递路径都接）与 `[沙箱]` 备注误报（新增 `looksLikeDeletionCommand` 动词闸：命令里真出现删除动作才注记，挡掉 `echo`/`grep` 一段拒绝文本 + 路径恰好存在的误报；代价是脚本内部删除不再注记，刻意选少报不误报）。可删边界 = 项目目录 + 临时目录（`/tmp`、`/private/tmp`、`/var/folders`、`/private/var/folders`、`/var/tmp`、`/private/var/tmp`）+ **可再生缓存**（`~/.cache`、`~/.npm`、`~/.gradle/caches`、`~/.m2/repository`、`~/.cargo/registry`、`~/.bun/install/cache`、`~/.node-gyp`、`~/.Trash`、`~/Library/Caches`、`~/Library/Developer/Xcode/DerivedData` —— 删了能干净重建，静默放行；`~/Library/pnpm/store`、`~/.deno`、`~/.nvm` 含不可重建内容，**不在**名单）+ `PI_SANDBOX_EXTRA_WRITE`；`/var/tmp` 是 macOS 自带 bash 3.2 的 heredoc 临时目录（编译期写死、`TMPDIR` 改不动），不放行则沙箱内任何 heredoc 都 100% 失败。从失败输出里抽被拦路径用的是**排除法**（保留「行内绝对路径 token」兜底扫描，只排除含 `here document` 的行与行首 prog 是 shell / `sandbox-exec` 的行）而不是程序名白名单 —— 白名单会静默丢掉 python3 `PermissionError`、`find:`、`ln:` 这三类真实删除形状。**抽不出路径就不弹框**，原样报错并追加一行 `[沙箱]` 提示（出口是 `/sandbox-boundary allow <目录>`）；旧的「按整条命令会话级问一次、同意后沙箱外裸跑」降级路径已删。`/sandbox-boundary` 查看边界与白名单，`forget <path>` / `clear` / `allow <path>` 管理条目（`allow` 对永不删除路径直接拒）。同目录的 `sandbox-mode.ts` 是 plan-mode 三态的运行期开关单例（dangerous 关掉整个拦截层，见下文 plan mode 一节）。完整口径与名单见仓库根 `CLAUDE.md` 的 `### Capability boundary` 一节 |
| `sandbox-boundary/` | 同一道删除边界的非 shell 侧：`apply_patch` 的 `*** Delete File:` 行在 `tool_call` 钩子上拦截（write/edit 不拦），与 bash 侧共用同一套 `classifyOutsidePaths` 判定与同一个白名单单例，所以一边记住另一边立刻生效；命中白名单时静默放行但补一行 notify。永不删除路径整份 patch 一起拒（不给「批准其余部分」的机会）。与 bash 侧的区别：它在执行前就能拦、且已知全部目标路径，没有「命令重跑一次」的代价 |
| `voice/` | **语音播报最终结论**（用户 2026-10-03 定，只做 TUI）：**结论那一条 `turn_end` 立即触发**（`isConcludingMessage`：无工具调用的 `stop` 且有文本 —— 用户 2026-10-04 要求「结论输出完立即播报」，不等 pi-subagents 的 watchdog；watchdog 挂在 `agent_end` 处理器里、实测 7~17s，`agent_settled` 必须等它跑完），`agent_settled` 保留为兜底（`length` 截断没续跑、工具 `terminate` 收尾；指纹去重跨两个触发点，正常路径不会念两遍；续跑场景前一条结论会被后一条顶掉，是「立即播报」的代价），从 `ctx.sessionManager.getBranch()` 现取最后一条带文本的 assistant（turn_end 时该消息已落盘；不缓存状态，照 recap 同款倒序扫）。播前把 markdown 精简成能听的话（代码块整块丢、表格行丢、URL 丢、链接只留文字、**文件路径丢**、标记剥离、emoji 去掉、超 `maxChars` 断在句边界），`aborted` / `error` 轮次与过短内容不播，**问句默认播**（2026-10-04 改：此前默认跳过，但用户实测「对话结束没口播」时，真实原因正是那句反问被静默跳过 —— 模型回一句反问是最常见的收尾形态，不出声看起来完全像坏了）。发声走 macOS `say`（`-v <音色> -r <语速> -- <文本>`，`--` 建在正文前防「- 开头」被当选项）；单槽后台播不阻塞回合，`agent_start` / 交互式 `input` / `session_shutdown` **三处 SIGTERM 打断**（实测 `say` 收 SIGTERM 立即退出、不留残留进程），**第四处是按 ESC**（用户 2026-10-03 要求：「念的时候按 ESC 停声」，且**这一下按键要吞掉**，不传给 pi 的中断 —— 所以若此刻真有流式输出在跑，需再按一次才中断智能体）。ESC 走 `ctx.ui.onTerminalInput`（唯一能在按键到达编辑器之前拦下的通道）：`pi.registerShortcut("escape", …)` 行不通，ESC 在 pi 的 `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` 里（`app.interrupt`），扩展注册会被直接拒掉并打 warning。**匹配 ESC 必须用 pi-tui 的 `matchesKey`**，手写 `data === "\x1b"` 在启用了 Kitty 键盘协议的终端上会完全失效（同 shift+tab 的三种编码，实测三种都过）。只在 `speaker.speaking` 为真时返回 `{consume:true}`，其余一律返回 undefined 放行（没在念时 ESC 照旧中断流式输出 / `!` bash / 弹窗）；监听器在 `session_start` 装、**装前先退上一次**（`/reload`、`/new`、`/resume` 都会重跑，不防重入会一次按键停两遍），`session_shutdown` 退订，非 TUI 模式不装。模块划分按本仓约定：`controller.ts`（配置读写 / 结论选取 / 播不播的状态机）**不 import pi / pi-tui**，`node --test` 直接跑；只有 `index.ts` 接线并 import pi-tui —— 所以 `index.test.ts` 对纯逻辑静态 import，对 ESC 编码走真加载器 + `feedInput` 端到端广播（复刻 pi-tui「所有监听器依次收到、任一 consume 就短路」的语义）。`/voice` 看状态 / on / off / summary / test / voices / stop；配置 `~/.pi/agent/voice.json`（每次播报现读，改完立即生效），`PI_VOICE=off` 整体关。**statusline 的 `reporting` 指示（2026-10-04 加）**：口播流程进行中时，在 statusline **主行末段**（`thinking` / `bash` 那个位置）显示 `reporting` —— **「对话结束开始发起摘要请求」点亮 → 「口播结束」熄灭**。两个阶段取或：摘要在途或正在发声（只算前者会漏掉「摘要关掉 / 摘要失败退兜底文本」，只算后者会漏掉摘要那段 —— 那正是沉默最久、最需要解释的窗口）。实现分两半：voice 只**发布**（`setStatus(REPORTING_STATUS_KEY, …)`，常量在新增的 `voice/status.ts`），渲染在 `statusline/line.ts` 的 `formatStateSegment` —— 它在那里**优先级最高**（摘要跑在结论那一条 `turn_end` 之后、`agent_settled` 之前，那段时间 `streaming` 仍为真、还可能带着末轮工具，排后面就会被 `thinking`/工具名盖掉；实测确认摘要确实跑在回合 settle 之前）。同一个键会被 `formatExtensionStatuses` 从第二行跳过（否则同一件事显示两遍）。**不走 `setWorkingMessage`**：那是 spinner 那一行的文案、由 `working-indicator` 扩展驱动，两个扩展写同一处会互相顶掉。小喇叭 `🔊` 仍走它自己的 `voice` 键、注册在第二行 —— 用户明确要求这条逻辑不变。两个已踩的坑：① **摘要用代数（`latestSummary` / `summaryGeneration`）记账而不是 boolean** —— 被打断的摘要会**晚归**（`controller.interrupt()` 只能 abort，下游不保证立即 settle），boolean 会让晚归的 A 把正在跑的 B 的指示误清（有回归用例真驱动扩展、算好 A/B 重叠时间线钉住；该用例先写成 vacuous 的版本，实测发现断言时刻早于 A 的 `finally`，改成真实重叠才压到）；② **四处打断走 `interruptSpeech()` 直接清标志**，不能指望在途那次的 `finally` —— abort 后下游可能很久不 settle，那段窗口里指示会一直挂着。后台子代理进程靠 `PI_SUBAGENT_PARENT_SESSION` 环境变量退让（前台子代理不加载环境扩展，这是第二道保险）。**口播摘要（默认每一轮都念摘要）**：本地精简能剥掉代码 / 路径 / 表格，却**剥不掉内容本身** —— 一段 800 字的结论精简完还有 600 字，念完要两分钟。所以精简后达到 `summaryThreshold` 的文本再调一次模型，把它改写成 1~3 句口播稿（提示词 `buildSummaryPrompt` / 清洗 `cleanSummaryText`，都在 `text.ts`）。**阈值默认 = 可播最低字数（`MIN_SPEAKABLE_CHARS` = 6），即「只播报摘要」**（用户 2026-10-03 定）：凡是通过 `decideSpeak`（已过滤过短 / 装饰 / 问句）的文本一律过一遍口播稿，不再分长短 —— 否则「搞定了，重启即可生效。」这类短句会绕过人设直接念原文，同一个会话里两种口吻（有时是秘书、有时是模型原话）。把 `summaryThreshold` 调高就退回「短结论念原文」的旧行为（省一次 1~5s 请求）。**口吻（2026-10-04 修订）**：中文机器人秘书助手，简洁专业地汇报、**不使用任何称呼 / 昵称**（此前用「伙计」称呼用户，听感不自然，已去掉），最多两三句、必须准确（不美化、不编造）；**在不影响准确性的前提下允许一点点感性的、亲切的表达**，有明确下一步时可以给一句建议。**说事不念编号（2026-10-04 用户实测反馈后加，两层）**：提交 / 推送类结论原本会把 `commit e752224`、`push fa90a4d..e752224`、`+232/−57` 原样念出来 —— 口播是秘书旁白，只说「改了什么 / 推到哪 / 成没成功」。① **提示词**（`buildSummaryPrompt`）新增两条：说事不念编号（commit 编号 / hash / 推送范围 / 增删行数 / 文件清单 / 行号 / 文件数不念），密码 / API Key / token **任何情况下不念**（这条连例外也没有；编号则在「我这一轮问的就是它」时可以照实回答）；② **机械过滤**（`stripSpokenNoise`，`toSpeakable` 与 `cleanSummaryText` 共用）保证模型不守约也念不出來 —— 摘要失败 / 超时走的是**本地兜底文本**那条路，根本不过模型，只有机械层盖得到（`index.test.ts` 有一条「摘要模型不可用 → 兜底文本也不含编号」的端到端用例）。机械层剥什么、不剥什么全部拿真实语料定（本机全会话目录 1134 条结论里 864 个被摘 token 逐个看过）：凭据（`Bearer …` / `sk-…` / `密码：…` / `apiKey=…`；弱标签 `token:` 只在值不像普数字时才收 —— 「输入 token 5000」是量不是密码）；8 位以上裸的 hex / 纯数字编号与 `a..b` 推送范围；diff 增删量（只在同行出现一对或带「N 个文件」时才当统计，不然「温度 -5 度」会被误伤）；连字符型号（`qwen3.8-max` / `qwen3-tts-flash` / `claude-opus-4-6`，首段须带数字且不能是纯数字 —— 日期前缀的 `2026-09-30-minecart`、枚举 `2-as-written`、量段 `19000-char`/`1.5-2KB`、行号区段 `L72-73`、短型号 `GPT-4` 都保住）。**两档强度是反引号分开的**（负载性设计 + 实测）：模型写编号的习惯是包进反引号（`78908fd`、uid `140024`），而**裸字同形的短串大多是量**（`120000`、`300000` 是毫秒数）—— 所以反引号里 6 位起就收，裸字要 8 位以上；这个分档要求**过滤必须跑在反引号剥离之前**（`toSpeakable` 与 `cleanSummaryText` 两处管线都是这个顺序，反了短编号就漏 —— 实测复现过）。**字数上有两条硬要求（用户 2026-10-04）**：① 上限 **100 字**（`summaryMaxChars` 可调，从 150 收紧而来）；② **摘要绝不能比原文长，只能更短** —— 所以真实预算是 `min(100, 原文长度)`，`createSummarizer` 把这个数字写进提示词（告诉模型多少字、原文就在同一个提示词里），`resolveSpeech` 再对模型返回的结果夹一刀（不守约的模型在那里被兜住；假摘要器返回超长的回归用例验的就是这道夹取）。**模型改用固定的快模型**（`text.ts` 的 `DEFAULT_SUMMARY_MODEL` = `deepseek-flash-qd`，low 推理档；用户 2026-10-03 定「速度为先」），不再用会话模型 —— 摘要只在结论说完后开口，快慢直接决定沉默多久，而会话模型可能是 qwen3.8-max 这类重模型（2026-10-03 实测同一段 130 字结论：固定模型 1.3~5.4s（10 次 p50 1.8s） vs qwen3.8-max 14.2~16.4s）。目录里找不到固定模型、或它恰好没配 key，就退回会话模型（仍带 low 与同一套提示词）—— 摘要只是增强，不该因为目录少一个模型就变哑或退回原文口吻。一次独立的 `ctx.modelRegistry.complete()`（recap / verify-loop / working-indicator 同款调用式），无工具、不进上下文、不落 session、**不上屏** —— 摘要只进 `say` 的 argv，屏幕上除状态栏 🔊 外无变化（用户 2026-10-03 明确要求「摘要不要显示，只播报」）。**`extra_body` 那个坑必须知道（2026-10-03 实测，两层）**：① **pi 的 anthropic-messages 适配器不认 `extra_body` 选项** —— 它按自己的字段列表组装请求体，不认识的键直接丢掉，唯一能把自定义字段送上网关的通道是官方钩子 `onPayload`（回归用例「摘要的 low 推理强度真能落到 HTTP body」拿真适配器拦 HTTP 请求体验的就是这个；只断言“选项里有 extra_body”是假绿）；② 就算送到了，**请求级 `extra_body` 会整体覆盖** config 里那条路由的 `extra_body`，所以传 `reasoning_effort: "low"` 时必须把 `qoder_protocol: "agent"` 一起带上，否则上游退回 openai 路径并 404（实测网关日志出现 `effort=-` + `HTTP 404`；带上后日志为 `effort=low protocol=agent`、200）。也不走 `effort`/`thinkingEnabled` 那套 typed 选项：本机 provider 声明了 `forceAdaptiveThinking`，那条路只把 `output_config.effort` 写进 body，而网关侧 `drop_params` + 配置里的 `extra_body.reasoning_effort` 会让它落不到 agent 模板的 `parameters` 上（实测：body 里 `output_config.effort=low`，网关日志仍 `effort=max`）。三条与 recap 同源的纪律：**不阻塞回合**（`turn_end` 主触发与 `agent_settled` 兜底两个处理器都不 await `onSettled`，fire-and-forget）、**可取消**（`agent_start` / 交互式 `input` / 按 ESC / `session_shutdown` 四处都 abort 在途请求 —— 用户问下一句时，上一轮的摘要既不出声也不白花钱）、**fail-open**（模型不可用 / 认证失败 / 超时 / 报错 / 返回空一律退回本地精简文本并压到 `summaryMaxChars`）。**超时默认 15s 是实测定的**（同一批 10 次采样：首字 0.8~3.2s、整句 1.3~5.4s，取最大观察值约 3 倍余量）—— 旧的 30s 是为了不漏掉会话语义里的重模型（qwen3.8-max 14.2~16.4s），固定模型后这个前提没有了；超时不是无声而是立即退兜底，比沉默安全。**超时必须 race 收场，不能只 abort（ 2026-10-04 线上事故）**：旧实现超时时只调 `controller.abort()` 就继续 `await` 下游的 promise，但 abort 只是「尽力通知」，下游**不保证**因此 settle —— qoder 网关卡住时实测就是「不 settle 也不理 abort」，于是 `await` 永远挂住，fail-open 的兜底文本永远走不到，整场播报彻底沉默（网关日志里那条 `effort=low` 的 `request start` 没有对应的 `done`，且之后没有任何合成临时目录）。现在 `controller.ts` 的 `resolveSpeech` 把摘要调用与超时 promise 一起 `Promise.race`：无论下游行为如何，超时都自己把 await 收场并退兜底文本；回归用例钉的是「promise 永不 settle 且无视 abort」这个具体失败形态，「被新一句顶掉 / 按 ESC」仍然走静默退场（靠 `aborted && !timedOut` 区分）。**注意 low 档在这条路由上几乎不改变延迟**（实测 low 与默认档同量级，都是 1.2~2.4s）—— 真正的提速来自「不用重会话模型」，low 是用户点名要的档位、也是防止上游偶发长思考的保险。`/voice summary` 可开关摘要；配置四个字段 `summarize` / `summaryThreshold` / `summaryMaxChars` / `summaryTimeoutMs`（缺省仍全部可用，旧配置无需改）；**全部字段与默认值见下节「voice 配置速查」**。**精简规则全部从真实语料反推、不是拍脑袋**：拿本仓 12 个会话的 301 条播报样本逐条看过（路径判定规则是拿 238 个含斜杠 token 反推的，误伤高危的四类 —— 比率 `32/32`、单词对 `A/B`、git ref `origin/main`、斜杠命令 `/reload` —— 都有回归用例钉住；行号只在紧跟路径时收，裸的「上限：4」与时间 `00:11` 不收；路径连带定位短语一起收，否则会拼出「文件在里。」这种病句）。管线里**四处**顺序是**负载性的**、改一处就会静默坏掉其它：行内代码必须在 URL 之前（否则 `` `https://x.y` `` 的闭合反引号被 URL 正则吃掉，剩下孤立反引号会跟后文配对、把中间正文误当行内代码 —— 真实数据回归）、图片必须在链接之前（否则 `![](url)` 被链接规则吃成一个 `!`）、方位词的双字形式必须排在单字之前（否则「里面」被「里」吃掉一半、剩下一个「面」）、**编号过滤必须在反引号剥离之前**（反引号是「代码形态」信号，见上段）。有三类残骸是刻意**不收**的：`\s+的\s*` 不能写成全局规则（会毁掉「apikey.json 的 proxy」这种正常中英混排）；「路径 下面」整句在实测语料里 0~1 次，宁可丢掉一个泛指也不冒险拼病句。**阿里云口播（可选，需要额外配阿里云的 Key；不配就完全是上面这套 macOS say，不联网）**：能力是从 `~/jaylli/chat-client` 那套语音播报搬过来的，但现在用的是更高一档的模型 —— **阿里云百炼（DashScope）的 `qwen-audio-3.1-tts-flash`**（旧模型是 `qwen3-tts-flash`，2026-10-04 换掉）：`POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer` + `Authorization: Bearer sk-…` + `{model:"qwen-audio-3.1-tts-flash", input:{text, voice, language_type:"Chinese"}}`，响应里的 `output.audio.url` 是预签名 OSS 链接（24h 有效、匿名可下载），所以是两步：先合成拿 URL、再下载。**端点与模型是绑死的**（实测）：`qwen-audio-*` 系模型只认上面这条 `…/services/audio/tts/SpeechSynthesizer` 路径，发到旧的 `services/aigc/multimodal-generation/generation` 一律 `InvalidParameter url error`；反过来旧模型也不认新音色 `longanhuan_v3.1`（`Invalid voice specified`）。代码里 `TTS_ENDPOINT` 与 `TTS_MODEL`（`aliyun.ts`）是一对常量，换一个必须同时换另一个；`voice.json` 的 `aliyunVoice` 默认值 `longanhuan_v3.1` 也属于 `qwen-audio-3.1-tts-flash` 专有（旧模型会以 `Invalid voice specified` 直接拒掉它，而这个模型也不认旧的 `Cherry`（`Engine error [411]`）—— 所以模型与默认音色必须一起改）。百炼另推荐北京地域专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`（同路径、性能更好，需真实 Workspace ID），暂未迁移。Key **不在** `voice.json` 里，而是单独写在 `~/.config/litellm-any/apikey.json` 的 `aliyunKey` 字段（与网关的 `apiKeys` 里的 key 无关，也不是同一个）：`/voice key sk-xxx` 设置 / 更新、`/voice key` 看状态（掩码 `sk-e08…9c1b`）、`/voice key clear` 清除；`/voice` 状态行会写明当前引擎（`引擎：阿里云 qwen-audio-3.1-tts-flash（音色 longanhuan_v3.1）· key sk-e08…9c1b` vs `引擎：系统 say（音色 Tingting）· 未配 aliyunKey`，模型名从 `TTS_MODEL` 常量拼出，不写死）。**分流在每次播报时现读 Key**，所以写完立即生效、不用重启或 reload；音色取 `voice.json` 的 `aliyunVoice`（默认 `longanhuan_v3.1`），say 的 `voice` / `rate` 只在本地路径生效。**方言 / 情感靠 `aliyunInstruction` 控制（2026-10-04 加，用户要求重庆话口播）**：它就是请求体 `input.instruction`，自然语言描述即可（如 `请用重庆话口音播报。`）—— `qwen-audio-3.1-tts-flash` 的系统音色**可输入任意指令**（阿里云文档原文），实测同一段文本带不带指令产出的音频字节数与哈希都不同、听感确为重庆口音；**空串则不发送该字段**，请求体与加这个功能之前逐字节一致（回归用例钉住）；`instruction` 与已有的 `language_type: "Chinese"` 不冲突，两个都发正常（实测 200）。注意指令文本有长度限制（阿里云文档：不超过 100 字符，汉字按 2 字符算）。**新模型其实支持语速**（`rate` 0.5~2.0 浮点倍率，另有 `pitch` / `volume`，均已实测被接受），但代码目前**没有透传** —— say 的 `rate` 是整数语速（词/分），云端 `rate` 是倍率，两者语义不同，怎么映射是另一个决定，不在换模型的范围内。播放器用系统自带的 `afplay`（它只吃文件路径、连 `--` 都不认 —— 实测报 `unknown argument: --`），所以音频先下载到 `os.tmpdir()` 的一次性目录、用绝对路径播、播完连目录一起删（临时目录本来就在沙箱的可删边界里）。三条纪律与上面同源：**单槽跨两个引擎**（每次 speak 先把两边都停掉，不会云端那句还在念、本地这句又开始；`speaking` 两边取或，所以 ESC 在「合成中」也能停声 —— 会 abort 在途请求并 SIGTERM 掉 afplay）、**不阻塞回合**（`speak` 只启动，合成+下载+播放都在后台）、**fail-open**（云端失败 / 20s 超时 / 鉴权失败 → 提示一次 `voice: 阿里云口播失败：…（退回系统 say）`，然后把**同一段文本**交给 say；但若这一句已经被下一句顶掉、或用户按了 ESC，pending 已清掉，就不再补一声）。**改 keystore 时容易踩的坑**：`adapter/admin/keystore.js` 的 `normalize()` 是整份对象重建，那里特意保留了 `aliyunKey`、并把它加进 `RESERVED_KEYS`（legacy 平铺格式迁移时不会被当成 gateway 的 key 收进 apiKeys）—— 否则从 admin UI（:996）保存任何配置都会把它静默清掉；回归用例在 `adapter/tests/keystore.test.js`。调试开关：`PI_VOICE_TTS_ENDPOINT` 换端点（测试指向本地 http 服务）、`PI_VOICE_AFPLAY_BIN` 换播放器、`LITELLM_ANY_APIKEY_PATH` 换 keystore 路径。测试在 `aliyun.test.ts`（keystore 读写与保留其它字段 / 掩码 / 请求形状 / 下载落盘 / 播放器状态机与打断 / 分流与兜底，假 fetch + 假 spawn + 一条真 spawn 的假 afplay 脚本），接线与端到端（真 http 合成 + 假 afplay 播放、`say` 不响）在 `index.test.ts` |

### voice 配置速查（`voice/`）

配置文件 `~/.pi/agent/voice.json`（`PI_VOICE_CONFIG` 可换路径）；**每次播报现读**，所以改完立即生效 —— 不需要 `/reload`（那是扩展代码变更才要的）。字段缺省 / 类型不对时各自退回默认值，旧配置不用改就能用。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（等价于 `/voice on` / `/voice off`；`PI_VOICE=off` 优先级更高） |
| `voice` | `"Tingting"` | 本地 `say` 的音色 —— **只对 say 路径生效** |
| `rate` | 无 | 本地 `say` 的语速（词/分钟）；**云端没有语速参数，配了也不生效** |
| `aliyunVoice` | `"longanhuan_v3.1"` | 阿里云 `qwen-audio-3.1-tts-flash` 的音色（龙安欢）—— 只对云端路径生效 |
| `aliyunInstruction` | `""` | 指令控制（`input.instruction`）：用自然语言控方言 / 情感 / 角色，如 `"请用重庆话口音播报。"`；**空串 = 不带该字段**（行为与没有这个功能时一致）。`qwen-audio-3.1-tts-flash` 的系统音色可输入任意指令，实测重庆话真的生效 |
| `maxChars` | `500` | 本地精简后的播报上限（按句子边界截断；精简后不足 6 字不播） |
| `speakQuestions` | `true` | 结论以问句结尾时要不要播（**用户 2026-10-04 改为默认播**：模型回一句反问是最常见的收尾，静默跳过会让人以为播报坏了；设 `false` 退回旧行为） |
| `summarize` | `true` | 是否把结论改写成口播稿（关掉就直接念本地精简文本） |
| `summaryThreshold` | `6` | 精简后达到这个字数才调摘要模型；默认 = 可播下限，即「只播报摘要」 |
| `summaryMaxChars` | `100` | 口播稿字数上限（也是摘要失败时兜底文本的压缩目标）；**实际预算是 `min(100, 原文长度)` —— 摘要绝不能比原文长** |
| `summaryTimeoutMs` | `15000` | 摘要调用超时（毫秒），超时立即退回兜底文本（不是无声） |

**阿里云 Key 不在这份配置里**：它单独放在 `~/.config/litellm-any/apikey.json` 的 **`aliyunKey`**（与网关 `apiKeys` 里的 key 无关，也不是同一个 Key）—— `/voice key sk-xxx` 写入 / 更新、`/voice key` 看状态（掩码）、`/voice key clear` 清除。不配就走系统 `say`（不联网）；配了但云端失败 / 超时：提示一次后退回 `say` 念同一段文本。

**环境变量**：`PI_VOICE=off` 整体关（优先于 `enabled`）；`PI_VOICE_CONFIG` 换配置文件路径；`PI_VOICE_TTS_ENDPOINT` / `PI_VOICE_AFPLAY_BIN` / `LITELLM_ANY_APIKEY_PATH` / `PI_VOICE_SAY_BIN` 分别换 TTS 端点 / 播放器 / keystore 路径 / `say` 可执行文件（后四个主要是调试与测试用）。

### plan mode（`plan-mode/`）

**三态权限模式（用户 2026-09-27 定）**，`shift+tab` 走固定循环：

```
dangerous ──shift+tab──▶ bypass ──shift+tab──▶ plan ──shift+tab──▶ dangerous
```

| 模式 | 图标 / 颜色 | 权限含义 |
| --- | --- | --- |
| `dangerous` | `☢` / `error`（红） | pi 原生的任意权限形态 —— **沙箱删除拦截整体关闭** |
| `bypass`（默认） | `⏵` / `success`（绿） | **沙箱删除拦截开启**（启动、`/resume`、认不出的历史值都收敛到这里） |
| `plan` | `⏸` / `warning`（橙） | 只读探索 —— 工具收拢 + bash 写拦截，比沙箱的「只拦删除」更严 |

**dangerous 只能由 `shift+tab` 切到**：没有 `/dangerous` 命令，`/plan` 也永远不把你带进
dangerous（它只切 plan，离开 plan 时回 bypass），模型路径（`enter_plan_mode`）同样只能进 plan。
所以「关掉保护」永远是用户自己按出来的决定，不会由任何自动路径到达。

**plan 有三条出口，落点不同**（这是三态化里唯一需要记住来路的地方）：

| 出口 | 落到哪 | 为什么 |
| --- | --- | --- |
| `shift+tab` | **dangerous**（固定循环的下一态） | 按循环走，不是原路返回 —— 否则从 bypass 进的 plan 按一次看起来像没切动 |
| `/plan` | **bypass**（安全默认） | 一条命令不该把用户悄悄送进沙箱关闭的态 |
| 计划文档写完、进入实施阶段 | **returnPhase**（从哪来回哪去，可能是 dangerous） | 用户批准了方案，实施就该在他原本选定的权限姿态下进行 |

`returnPhase` 由 `enterPlan` 记下（进 plan 之前的那一态），只有第三条出口用它。回到
dangerous 时 notify 会明说「沙箱删除拦截已关闭」，不能让用户以为还在保护下。

**沙箱开关怎么传过去。** plan-mode 与两层删除拦截（bash 的 seatbelt 包裹在
`bash-command-collapse.ts`、`apply_patch` 的 `tool_call` 检查在 `sandbox-boundary/index.ts`）
分属三个扩展文件，中间只有一个 `globalThis` 单例：`bash-command-collapse/sandbox-mode.ts`
的 `getSandboxMode()` / `setSandboxMode()`（与 `allowlist.ts` 的 store 缓存同一套做法 ——
pi 的加载器不保证给两个扩展同一个模块实例，挂 globalThis 则读到的必然是同一份状态）。
两个沙箱消费方都在**执行期**读它，与注册期读的 env 总闸（`PI_SANDBOX` + 平台）取与：
任何一道说关就关。plan-mode 没装、或被 `PI_PLAN_MODE=off` 关掉时单例永远是默认的
`bypass`，拦截照旧生效（fail-safe）。

**没有 execute 态** —— 与 Claude Code 对齐：批准后写权限恢复、状态直接回 returnPhase，
「按计划文档实施」是一次性交给模型的指令，进度也交还给模型（它认为该建任务清单就自己
`task_set`，扩展不再镜像步骤、不再记进度）。

2026-09-24 之前是三态（bypass → plan → execute，批准即把步骤镜像进 simple-task 清单、
按序号记 `[DONE:n]`、状态行报 `▶ n/N`）。那套「扩展持有进度」的机制整个删除：镜像契约
（`simple-task/plan-mirror.ts`）、`[DONE:n]` 标记、步骤 widget、execute 态的每轮注入全部
随之消失。起因是用户要求高度对齐 cc 的 plan mode：cc 的 `ExitPlanMode(plan)` 参数就是
一份完整方案文本，批准后产出物是计划文档，任务清单由模型自决。2026-09-27 重新变成三态，
但第三个态是**权限模式**（dangerous）而不是进度态（execute）—— 两者毫无关系。

计划状态存会话（`appendEntry("plan-mode")`，不进模型上下文）；计划文档写进工作区的
`.pi/plans/`（被 `.gitignore` 排除 —— 计划是过程产物，不该进仓库）。

四个入口：`shift+tab`（三态循环）、`/plan`（只切 plan）、`--plan`（启动即进）、模型调
`enter_plan_mode`。`/plan-status` 看当前模式。`PI_PLAN_MODE=off` 整体关闭，
`PI_PLAN_MODE_AUTO=off` 只关模型自动进入，`PI_PLAN_MODE_CONSENT=off` 只关下面这道同意弹框。

**模型自动进入要过一道同意弹框（CC 同构）。** 模型调 `enter_plan_mode` 时不再直接进，而是先弹
`select` 两选一：`进 plan mode（只读探索）`（默认选中，直接回车即接受模型的请求）/ `直接实施`。
选后者或按 esc 都不进 plan，工具结果是「用户选择直接实施……不要再调用 `enter_plan_mode`」，模型
当轮就照用户指令动手。三个刻意点：① esc 当作否决，与 CC 的 “must consent to entering plan mode”
一致，也让「嫌烦想跳过」这条最常见路径只需一个键；② 弹框**只在模型路径**——`shift+tab` / `/plan` /
`--plan` 走 `enterPlanMode(ctx, "user")` 不经过它，那已经是用户自己的决定；③ 无 UI（`pi -p`）不弹框、直接进，
保持既有 headless 行为（那边没有人会被打扰）。这正是 CC 敢把判据写松的原因：它的 `EnterPlanMode`
是 `shouldDefer: true`，误判的代价被弹框吸收成「用户按一次键」，而不是被迫走完「进 plan → 出方案 →
审批 → 写文档」一整圈。

**两个弹框的正文用 fg，标题与高亮选项保留 accent（用户 2026-09-30 定）。** 同意弹框与审批弹框都走
`ctx.ui.select()`（pi 的 `ExtensionSelectorComponent`，没有 message 参数，正文只能塞进 title），
而那个组件把**整个 title 包成一段 `theme.fg("accent", …)`** —— 于是模型给的理由、`批准这个计划？`
下的计划全文原先整段都是 accent（本机三套皮肤里是浅蓝）。改法在 `consent.ts`：title 里给正文
**逐行**套一层 `fg("text", line)`（空行跳过），内层显式颜色覆盖外层，正文就变回皮肤的主前景色，
而标题行、`→ ` 光标与选项行各自的包裹不受影响。逐行而非整块是因为 pi-tui 的 `Text` 按行切分并
逐行重置样式 —— 整块只加一次开头色码，第二行起就会丢掉颜色退回 accent。已用真主题 + 真组件 +
真 `Text` 验证：上色前后**可见文本逐字节相同**（宽度 24 / 40 / 64 / 100 下的折行与留白都不变，
只多了颜色码），正文渲染为 `#f8f8f2`、标题与高亮选项仍是 accent。代价：行尾多一次重复的
SGR 重置码，显示无影响。测试见 `consent.test.ts`（10 例，断言色槽归属与「纯文本主题下与原实现
逐字一致」）。

**brainstorming 互斥闸（二选一，用户 2026-09-26 定）。** superpowers 的 `brainstorming` 技能自带
「澄清 → 2-3 方案 → 批准 → 设计文档 → writing-plans 实施计划」全流程，与 plan mode 完全重叠。
模型调 `enter_plan_mode` 时，execute 在同意弹框**之前**先扫会话分支（`getBranch()` 的原始条目里
`type:"message"` 那层）：**本次 run**（最后一条 `role:"user"` 消息之后）内若有 assistant 的
`toolCall` 块是 `read` 且路径含 `/brainstorming/`（片段匹配，兼容技能库搬家；判定在 `brainstorm.ts`，
13 个纯用例），就**不进 plan、也不弹框**，直接回一段「二选一」说明（按技能流程走、别再调本工具、
用户想进 plan 请自己 shift+tab / `/plan`）。只拦模型路径：用户手动进入不经过这道闸。判定异常一律
fail-open（照常弹框）——误判成「没加载」只是回到旧行为，误判成「加载了」会静默剥夺 plan mode，
代价不对称。已知边界（写进 `brainstorm.ts` 头注释）：用 bash `cat` 读 SKILL.md 不算加载（只认
`read` 工具，与 verify-loop 的词法口径同级）；豁免仅本次 run，下一条新 prompt 不继承。

**路由判据只在工具描述里（CC 同构）。** `enter_plan_mode` 的 `description` 承载全部判据：7 条正面条件
（新功能 / 多种可行方案 / 改既有行为 / 架构取舍 / **>2-3 个文件** / 需求不清 / 用户偏好决定走向，最后
一条明写「如果你正打算用 `ask_user_question` 问方案，就改用这个工具」）+ 5 条豁免（一两行小修 / 需求
明确的单个函数 / **用户已给具体详细指令** / **纯调研探索审阅** / **本次 run 已加载 brainstorming 技能**）
+ GOOD/BAD 示例。全局 `AGENTS.md` 的
`## Uncertainty` 只留一条指针（判据与豁免在该工具的描述里），不再重复一份——CC 的系统提示词里同样
一句 plan 规则都没有。判据放在工具描述里，模型在决定要不要调这个工具的那一刻正好读到它，也不会与
`AGENTS.md` 漂移。

**提交与审批（三选一）。** `exit_plan_mode` 的参数是 `plan`（给用户看的完整方案 markdown）
+ **必填 `slug`**（计划文档的文件名短名：小写英文 + 数字 + 连字符，3~5 个词，如
`m5-entity-runtime`；最终文档名 `<日期>-<slug>.md`）+ 可选 `summary`（一句话总结，仅用于
写文档指令与 `/plan-status` 展示）。文档名规则（`plan-doc.ts`）：slug 清洗成**纯英文
kebab-case** —— CJK 与标点一律折掉（纯中文退化成 `plan`），路径分隔符与 `..` 进不了
文件名；撞名追加 `-2` / `-3` 绝不覆盖。审批对话框是 `select` 三选一：

| 选项 | 之后发生什么 |
| --- | --- |
| 写计划文档并实施 | 进写文档子态 → 模型 write 文档 → 自动收尾回 **returnPhase**（从哪来回哪去），收尾指令是「按文档实施」 |
| 只写计划文档 | 同上，但收尾指令是「报告路径就停，不要动手」 |
| 打回（或按 esc） | 留在 plan 态（只读），等用户反馈后重新提交 |

非交互运行（`pi -p`）没有对话框：自动按推荐路线（写文档并实施）走，不死锁。

**写文档子态（`docWriting`）。** 两条批准路线都经过它：phase 仍是 `plan`（bash 写拦截、
工具收拢全部照常），唯一的区别是 `write` 被单独放回工具表（`planModeToolSet(active, true)`），
并由 `tool_call` 钩子限死只能写计划文档那一个路径（`.pi/plans/YYYY-MM-DD-<slug>.md`，
路径在用户选路线的那一刻算好并钉死 —— 撞名判定问的是文件系统，`/resume` 后重算可能得到
不同的 `-2` 后缀）。每轮注入的上下文从只读探索换成写文档指令（带钉死的路径与计划全文）。
模型用 write 把文档写成功的那一刻，`tool_result` 钩子自动收尾：状态回 returnPhase、工具表还原、
收尾指令（实施 / 只报告路径）**替换**掉 write 的普通成功文本 —— 模型在同一轮里就能看到
接下来该做什么，不需要再调任何工具。write 失败（isError）不收尾，模型自己会看到错误并重试。

**模式指示的显示位：statusline 第二行的行首**（那个区也叫「扩展 status 区」）。
三个态**都有文案**，所以「当前在哪个模式」永远有一个固定的显示位：

| 态 | 显示 |
| --- | --- |
| dangerous | `☢ dangerous`（**`error`**，红 —— 沙箱已关，最醒目） |
| bypass | `⏵ bypass`（**`success`**，绿 —— 2026-09-27 之前是红色 `toolDiffRemoved`，三态化后红色让给 dangerous） |
| plan 等待模型出方案 | `⏸ plan`（`warning`） |
| plan 已提交、等批准 | `⏸ plan · 待批准` |
| plan 写文档子态 | `⏸ plan · 写文档中`（尾巴走 `accent`） |

这一格原先归 `simple-task`（那里显示 `✔ 7/7 done`），但**与它自己在输入框上方的 widget 重复**
（widget 是完整版：`● N tasks (…)` + 逐条清单 + spinner），那个缩略版已删除，格子让给模式指示。
注意 `simple-task` 的 widget 行**不吃这一格**，所以两者不会再抢显示位。

**模式指示固定在第二行行首**（`statusline/line.ts` 的 `STATUS_PRIORITY`）。不要改回「按注册顺序」：
第二行是超长只截断不折行，而路径 / checkpoint 计数会越长越长 —— 放尾部时一条长路径就能把它挤到
看不见（这正是改到行首的原因）。注册顺序还取决于 pi 加载扩展的顺序（目录字母序），改个文件名就会变。
优先级表之外的 key 仍按注册顺序跟在后面。

**约束是两道独立的闸，别以为只有一道：**

1. **工具集**：进 plan 时把 `edit` / `write` / `powershell` 从活动工具里摘掉，退出时按**进入前的快照
   原样还原**。本机 pi 的工具表里有二十多个扩展动态注册的工具（`mcp__*`、`ask_user_question`、
   `task_set` …），官方示例那种硬编码白名单会把它们全吃掉 —— 所以必须是快照-还原。
   写文档子态单独放回 `write`（路径仍被第二道闸限死）。
2. **`tool_call` 钩子**：`bash` 还在工具表里，所以写类命令（重定向、`rm` / `mv` / `sed -i` /
   `git commit` / `npm install` / `sudo` …）靠这道钩子拦，拒绝原因作为工具错误结果回给模型。
   判定按**简单命令**粒度切开（`cat a.txt && rm -rf b` 会拦下 rm 那段），heredoc 正文先剥掉，
   fd 复制（`2>&1`）与 `/dev/null` 这类黑洞目标放行。写文档子态里 `write` 只许写钉死的那个
   路径（写别处会被拒，拒绝原因里给出正确路径）。实现与全部边界在 `plan.ts` 的上半部分与
   `plan.test.ts`。

**这是给配合的模型用的护栏，不是沙箱。** 两个刻意放行的形状：双引号内的 `$(...)` 命令替换、
以及 `npm run <script>` 这类由脚本内容决定副作用的命令 —— 宁可放行也不要把正常探索全部拦死。
要真防住恶意写入得靠操作系统级沙箱。实测证据（`pi --plan -p "别规划，立刻用 bash 执行：echo hacked > proof.txt"`）：
模型拒绝了命令，原话是「我没法照做 —— plan mode 在拦 …… 换个写法绕过去也不行」，然后把它作为计划
提交走审批，文件是**批准之后**才创建的。

**`shift+tab` 是从 pi 内置的 `app.thinking.cycle` 手里抢来的。** 内置键位扩展抢不到
（`registerShortcut` 与内置冲突时会被 runner skip），所以走 `ctx.ui.onTerminalInput` 在按键到达编辑器
**之前**拦下并 `consume`。代价是思考等级循环键被占，因此扩展首次启动时会把
`~/.pi/agent/keybindings.json` 里的 `app.thinking.cycle` 改绑到 **`ctrl+shift+t`**。改绑的边界（`keybinding.ts`）：
只有**该键完全没有任何绑定**时才写；用户自己配过就一个字不动、也不提示（`needsAttention` 区分
「已有绑定，正常」与「配置坏了，需要你手动处理」—— 前者每次启动都提醒会变成噪音，实测踩过）。

抢键的三个条件（`index.ts` 的 `attachInputListener`）：TUI 模式 + 空闲 + 没有扩展弹窗。
**匹配 shift+tab 必须用 pi-tui 的 `matchesKey`**，不能手写 `data === "\x1b[Z"`：
shift+tab 有三种编码 —— 裸 CSI（`\x1b[Z`）、Kitty 键盘协议的 CSI-u（`\x1b[9;2u`）与 xterm
modifyOtherKeys。而 pi **启动时会主动启用 Kitty 协议**（`pi-tui` 的 `terminal.js` 发
`\x1b[>{flags}u\x1b[?u\x1b[c` 并等终端回复），一旦启用，真实终端（Ghostty / kitty / WezTerm）发的
就不再是 `\x1b[Z`。实测踩到过：pty 假终端（不回协议查询）里 shift+tab 能切，真实 Ghostty 里
完全没反应 —— 本地复现必须**让 pty 回一个 `\x1b[?1u`** 才是真实终端行为。
**流式中按 `shift+tab` 仍是切思考等级**（不空闲就不抢）—— 这是刻意的：plan mode 只在你停下来的时候才切。
弹窗打开时不抢，否则 `/model`、`/sessions` 这些 picker 里的 `shift+tab` 会跳出选择器。

### 跨扩展 / 跨文件

- **plan-mode 的三态模式 → 两层删除拦截**（`bash-command-collapse/sandbox-mode.ts`，2026-09-27）：
  plan-mode 持有 dangerous / bypass / plan 三态，而删除拦截分属另两个文件（bash 的 seatbelt
  包裹在 `bash-command-collapse.ts`、`apply_patch` 的 `tool_call` 检查在 `sandbox-boundary/index.ts`），
  所以中间放一个 `globalThis` 单例传递信号（与 `allowlist.ts` 的 store 缓存、`getSessionScopes()`
  同一套做法 —— pi 的加载器不保证给两个扩展同一个模块实例，挂 globalThis 则读到的必然是
  同一份状态）。**两个消费方都在执行期读**，与注册期读的 env 总闸（`PI_SANDBOX` + 平台）取与；
  注册期读一次就永远切不动了。单例默认 `bypass`，认不出的写入值也收敛到 `bypass` ——
  plan-mode 没装 / 被 `PI_PLAN_MODE=off` 关掉 / 还没切过态时，拦截一律照旧生效（fail-safe）。
  改这个契约时记住三件事：① dangerous 是唯一会关掉拦截的态，只能由用户 shift+tab 到达；
  ② plan 态不靠沙箱（它自己的两道闸更严），记下来只是为了状态永远与 plan-mode 一致；
  ③ 单例的键名 `pi-sandbox-mode` 是跨文件的硬契约，改名要同时改测试里那个「换一个模块实例
  读到同一份状态」的断言。
- **plan-mode 与 simple-task 不再耦合**（2026-09-24 删掉了镜像契约）：两者都能单独装、
  单独 `/reload`，互不 import、互不通信。计划批准后进度归模型自己 —— 它要建清单就调
  `task_set`，那是 simple-task 的普通工具调用，没有任何特殊路径。`simple-task/gap.ts`
  仍被 `recap/` 跨目录 import（那是另一个契约：widget 之间的空行判定，与任务清单无关）。
  `recap/subagents.ts` 被 `verify-loop/` 跨目录 import（第三个契约：「现在有子代理在跑吗」
  的 pi-subagents 进程内 RPC 探测 —— `/goal` 评估在子代理未结束时跳过本轮，CC 的
  "background work defers evaluation"；探测 fail-open，recap 不装时 verify-loop 也不该装）。
- **statusline 第二行（扩展 status 区）的显示位分配**：顺序由 `statusline/line.ts` 的
  `STATUS_PRIORITY` 决定 —— `plan-mode`（模式指示）**强制行首**，其余按注册顺序跟在后面：
  `cwd-statusline`（完整路径）、`rewind`（`◆ N checkpoints`），限 5 条。
  把模式指示放行首是因为第二行超长只截断不折行，它跟在会变长的路径后面会被挤掉；
  而注册顺序取决于目录字母序，太脆。
  **两个保留键不从这一行走**（它们由别处渲染，所以 `formatExtensionStatuses` 里被跳过）：
  后台任务的 `background-tasks` 独占 footer **最后一行**（见下一条），口播流程的
  `voice-reporting` 则显示在主行**末段**（`thinking` / `bash` 那个位置，见 voice 那一节）。
  漏跳过就会同一件事在两处各显示一遍。
  `simple-task` **不再占**这个区（它曾经在这里显示 `✔ n/N`，与自己在输入框上方的 widget 重复，
  已删除）—— 改回去之前先想想是不是又造了一份重复信息。状态行里 `▶ n/N` 的 N 与数字来自
  simple-task（见上文），所以这个区与那份清单是**两个不重复的口径**：一个说模式与进度比，
  一个逐条列步骤。`verify-loop` 的 `◎ /goal active`（key `verify-goal`，仅在 goal 活跃时挂）
  也走这个区，注册顺序在字母序里排很后，被截断时先丢 —— 可接受：goal 活跃时输入框上方
  的注入消息本身就在提醒。
- **后台任务 dock 是 footer 的保留键，独占最后一行**：`background-tasks` 扩展用
  `setStatus("background-tasks", …)` 发布任务行（`⚙ bg_1 running 12s · 命令…`），
  `statusline/line.ts` 的 `composeFooterLines` 把这个键从拼接的第二行里**抽出来**、单独渲染成
  footer 的**最后一行**（`formatExtensionStatuses` 里跳过它）—— 所以它既不占上面 5 条的预算，
  也不会与长 cwd 同行被截断。键名由 line.ts 直接 import `background-tasks/status.ts` 的
  `STATUS_KEY`（与 plan-mode 的 `STATUS_KEY` 同一套跨目录 import 取舍）：两份字面量一旦漂移，
  dock 行会静默退回拼接的第二行，没有任何报错。dock 行自带 ANSI（发布侧逐段着色），
  line.ts 原样渲染；终端宽度收口在 `truncateToWidth`，所以 id / 状态 / 时长永不被截，
  只截行尾的命令。没有后台任务时 footer 输出与以前逐字节一致。
  **值可以带一个 `\n`**（「本轮已结束」的结轮提示第二行）：line.ts 按 `\r?\n` 拆成
  连续多个 footer 行，每行各自参与截断；**不做 `trim()`** —— 第二行的行内缩进就是
  `└` 悬在任务 id 下方的那两格，trim 掉会静默破坏对齐（只跳过纯空行）。
- **`simple-task/gap.ts` 的「看邻居」是靠*渲染邻居*实现的**：它没有枚举别人 widget 的接口，
  只能从 TUI 根往下找到装着自己的 Container，再看紧邻兄弟面向自己那一侧的渲染结果。于是
  `recap` 反过来渲染 `simple-task` 时就是**互递归**（无保护时实测递归到 depth 61+ 才被栈拦住）——
  **重入标记必须留在 recap 这一侧**（`inspectingNeighbours`，粒度是组件实例）：放在 `gap.ts` 里的话，
  嵌套那次 walk 一律返回「无间隔」，两边各补一次空行、**变成两行**。
- **`below-editor-after-statusline.ts` 靠对象身份找容器，不猜下标**：先注册一个 render 返回空数组的
  探针 widget，遍历 `tui.children` 找到「子树里装着这个探针」的顶层 child，再把它移到末尾。
  探针本身必须**显式传 `placement: "belowEditor"`**：漏写（默认落到 `aboveEditor`）会把「上方」那个容器
  整块搬走，而且没有任何运行时报错（实测踩到过，代码里只有一行注释提醒）。找不到容器就什么都不做。
- **「内置 statusline 露出来」有两个窗口，用了两套办法**：① **启动窗口**（进程刚起来 → `session_start` 轮到我们。
  实测：内置 footer 在 ~470ms 出首帧，我们的 statusline 到 ~1.2s 才装上）没有上一帧可重放，由
  `statusline/footer-suppress.ts` 在**扩展工厂**里（此时 TUI 还没 new 出来）接管 `FooterComponent.prototype.render`，
  窗口内渲染 0 行 —— 底部留白，而不是先画一个马上要变的默认状态行；我们的 footer 挂上的一刻交还，
  30s 兜底（因为 `Runner.emit()` 串行 await，字母序在前的 `mcp` 排在前面，它连 MCP server 的时间也在这个窗口里）。
  ② **换会话窗口**由 `footer-guard.ts` 重放上一帧压住（有旧状态可留，比留白更好）。两个开关独立：
  `PI_STATUSLINE_BOOT_SUPPRESS=off` / `PI_STATUSLINE_FREEZE=off`。
  补丁打的是包根导出的 `FooterComponent` —— 实测（0.87.1 bundle 形态，A/B pty 捕获，两次只差这一处）
  它**就是** pi 自己 `new` 出来那个类：临时改成返回 `["PROBE-FOOTER-MARKER"]` 时屏幕上真的出现这一行，
  关掉开关后内置 footer 照旧。
- **`statusline/footer-guard.ts` 与 `startup-logo/header-guard.ts` 是同一套机制的两份**（接管容器的
  `render`、重放上一帧的行），互不依赖、符号键不同。原因是 pi 换会话时 `resetExtensionUI()` 会
  **无条件**把内置 footer / header 装回去并清空所有 `setStatus`，而扩展侧没有比 `session_start`
  更早的钩子 —— 所以保证只能挪到「出帧那一刻」。`PI_STATUSLINE_FREEZE=off` 关掉冻结。
  （启动窗口那个留白补丁**也可以**这样扩到 header 上，`startup-logo/` 目前没做：启动那一段顶部
  仍会先闪一下内置 header 再换成 logo。）
- **「渐变」在 OKLCH 里插值，不在 sRGB 里**（`startup-logo/animation-frames.ts` 的实测账）：
  橙压暗（`#180600`）→ 青 accent（`#8cdaff`）在 sRGB 里线性混合会**穿过灰** —— 相位 0.15 处
  实测 `rgb(41,38,38)`，饱和度 0.05、色相 9°，看上去就是一段不动声色的灰；同一个行程换成
  `mixColors(a, b, t, "oklch")` 给出的是一条真色相弧（51°→105°→158°→212°→230°，饱和度全程 > 0.4）。
  代价是 pi-tui 的 `mixColors` 在 `t >= 1` 时**不返回同一个对象**（实测 `===` 为 false），
  所以代码里显式短路过 `amount >= 1`，不把「落定帧逐字节等于静态 logo」寄托在依赖内部实现上。
- **别拿「离得最远的那个」当渐变的另一端**：`startup-logo` 的起点色相白名单初版取最大距离，
  1337 皮肤因此选中橙（离 accent 178°），色相弧中段穿过**纯绿** `#507351` —— 绿是本套皮肤
  「新增行」的语义色，出现在启动画面上很不对味。现改为瞄一个 70° 的目标距离（三套皮肤分别落在
  83°/62°/70°），中段是青绿 / 黄绿 / 蓝紫，都是各自配色里本来就有的过渡带。

### pi 平台的坑

- **`shift+tab` 不能用字符串比对，要用 `matchesKey("shift+tab")`**：它有三种编码 —— 裸 CSI
  `\x1b[Z`、Kitty 键盘协议的 CSI-u `\x1b[9;2u`、xterm modifyOtherKeys `\x1b[27;2;9~`。
  pi 启动时会**主动启用 Kitty 协议**（`pi-tui/terminal.js` 发 `\x1b[>{flags}u\x1b[?u\x1b[c`），
  真实终端一旦同意，发的就不是 `\x1b[Z` 了。同一坑对任何手写的“按了哪个键”判断都成立。
  推论：**pty 假终端默认不回协议查询，所以只能复现那种编码** —— 用 pty 验证这类交互时
  得主动回一个 `\x1b[?1u`，否则测出来的“通过”在真实终端里不成立（plan-mode 实测踩到：
  pty 里 shift+tab 能切，Ghostty 里完全没反应）。
- **扩展必须真起一次 pi 验证，不能只跑 `node --test`**：pi 直接加载 `.ts`，而 `node --test` 的类型
  擦除**不做语法/类型校验**。实测一个非法标注（`readonly (readonly 0 | 1)[][]`）22 条单测全绿，
  pi 却在加载时 `ParseError`、**整个扩展根本不加载**。最低验证是 `cp` 到 `~/.pi/agent/extensions/`
  后用 tmux 真起一次 pi，在 `capture-pane` 里搜 `Failed to load extension` / `ParseError`。
- **tmux 里真验证「启动那一秒」的姿势**：`tmux new-session -d -s x -x 100 -y 30 'cd … && exec pi'`
  （命令当成 `new-session` 的参数直接跑；先开好会话再 `send-keys` 会多一层 shell 回显与竞态），
  紧接着 `for i in $(seq 1 20); do sleep 0.12; tmux capture-pane -t x -p > f$i.txt; done`
  —— 20 帧 × 120ms 正好盖住入场动画，实测在 f7/f8/f9 捕到「一格 → 四格 → 完整印记」。
  `capture-pane -p -e` 才带颜色，颜色是 `\x1b[38;2;R;G;Bm` 真彩。**三个坑**：`sed` / `cut` 在这些
  文件上会报 `illegal byte sequence`（块字符是 UTF-8 多字节，先 `LC_ALL=C python3` 解码再处理）；
  `capture-pane` 只给**当前视口**，行数少于终端高度时会捕不到，必要时把 `-y` 开大；
  **tmux 轮询测不准毫秒级时序**（轮询本身要 `spawn` 一个进程 + 连一次 socket，实测把 1220ms 的
  动画量成 580ms）—— 那种断言要么在代码层量（直接 `await sessionStart()` 然后按 `process.hrtime`
  轮询 `render()`，实测得到 668ms / 1231ms，与设计的 500+720 对得上），要么只当「动没动」的
  粗验证。
- **纯逻辑模块的 import 面要按「谁在什么时候跑」分开**：`node --test` 在仓库根跑，那里没有
  `node_modules`，所以 `import "@earendil-works/pi-tui"` 的模块**不能在仓库根直接单测**。
  `startup-logo/` 的做法是纯逻辑（`animation.ts` / `animation-frames.ts`）只声明结构化的最小接口、
  真函数由 `index.ts` 注入（`ColorOps`）——两边都能单测，且运行时只有一份真实现。
- **捕获的 `ctx` 在会话结束后会 stale，读 `ctx.ui` 会抛**（`"This extension ctx is stale after
  session replacement or reload"`），而抛出发生在读的那一刻 —— 比 widget 的 `render()` 更早，
  所以 `render()` 里的 try/catch 拦不住。**一个活过会话的定时器会直接把宿主进程带崩**（实测 exit=1）。
  `simple-task/` 与 `working-indicator/` 因此都有三层防护：回调自己 try/catch 并停表、所有 `ctx.ui`
  访问包 try/catch、`session_shutdown` 里立刻停表。
- **`renderCall` 抛异常会被 pi 静默 catch 并回退到 `createCallFallback()`** —— 界面上只少点东西，
  日志里什么都没有。`read-path-collapse.ts` / `bash-command-collapse.ts` 都踩过这一条。
- **跨扩展同名工具注册是 first registration per name wins**，所以 `bash` 的开关必须住在
  `bash-command-collapse.ts` 里，不能另开一个同样注册 `bash` 的文件（后者会被静默忽略）。
- **重新注册内置工具必须用 `createXToolDefinition()`，不能用 `createXTool()`**：后者是
  `wrapToolDefinition(createXToolDefinition(…))`，而 `wrapToolDefinition` 只保留 8 个字段
  （name / label / description / parameters / constrainedSampling / prepareArguments /
  executionMode / execute），`promptSnippet` 与 `promptGuidelines` 被静默剥掉 —— 于是 system
  prompt 的 `<tools>` 段里该工具整行消失（`visibleTools` 按 `!!toolSnippets[name]` 过滤），
  `<rules>` 段里它的 guidance 也全部缺席。**全程无任何报错**：工具照样能调、`description`
  照样进 tool schema、渲染照样正常，唯一的症状是模型看不到那几行。`tool-diff.ts` 实测踩过
  （edit / write 两行 + 5 条 guidance 全丢，70 条 system prompt 命中 0 次），修复是每处一行
  换成 `createEditToolDefinition` / `createWriteToolDefinition`（与 read 侧 `read-path-collapse.ts`
  同形）；回归测试在 `tool-diff/prompt-metadata.test.ts`（走 pi 真加载器，含「包装器确实剥掉
  元数据」的反例断言）。pi 官方示例 `examples/extensions/built-in-tool-renderer.ts` 用的正是
  `createEditTool()`，**它自己就带这个 bug**，「照着官方示例抄」不构成保护。
- **`promptSnippet` 不只影响「工具会不会消失」，它决定模型选不选这个工具**（2026-10-06 实测）：
  内置 `bash` 的 snippet 原文是 `Execute bash commands (ls, grep, find, etc.)` —— 助手工具清单里
  直接替 bash 打了「文件操作」的广告；而 `grep` / `find` / `ls` 三个内置工具的 `guidelines` 在 pi 里
  **全是空数组**（只有 `read` 带一条 `Use read to examine files instead of cat or sed.`）。后果：
  全库 303 个会话、≈20.4k 次 bash 里原生三件套合计只被调用 **4 次**（`grep` 零次）。
  `bash-command-collapse.ts` 重新注册 bash 时把 snippet 显式改成
  `Execute a shell command (pipelines, builds, scripts, anything writing or compounding several steps;
  prefer grep/find/ls/read for single lookups)`。**改动只在提示词层**：`execute` 委托内置实现、
  loop 与渲染一行未动（bash 照旧能跑 `ls`/`grep`/`find`）。隔离实测（把 `AGENTS.md` 换成空文件、
  只留新 snippet）：单一检索 → `grep({pattern, path})`；复合探查（一次要三个答案）→ 仍是单条
  bash `;` 串联，没被拆碎。注意它是**全局扩展**，所以这一行会影响本机所有项目 —— 改措辞前先想清这点。
- **扩展 import 的 `@earendil-works/pi-tui` 与 pi 自己渲染用的**是不是同一份，取决于启动形态，
  **不能靠推测**：`pi` 命令跑的是 `dist/bundle/cli.js`，pi-tui **内联**在 chunk 里，而加载器在
  这个形态下走的是 `virtualModules` 分支（bundle 里 `isBundledNode=!0`，见
  `core/extensions/loader.js:421`），把扩展的 `@earendil-works/pi-tui` 指向**加载器那份 bundle 自己的
  命名空间** —— 与内联副本是同一个类，所以在扩展里打 `Markdown.prototype` 这类**原型补丁是有效的**
  （`fenceless-code-block/` 就这么实现，`index.test.ts` 用 pi 自己的 `AssistantMessageComponent` 渲染
  一条 assistant 消息来断言）。反过来，patch `node_modules` 里那份**毫无效果且没有任何报错**（实测）。
  同一个原因的另一面：`@earendil-works/pi-coding-agent` 在 bundle 形态下被 alias 到 `dist/index.js`
  （未打包的那套模块图），所以包根的状态型 API（`keyHint` / `keyText`）拿到的是另一个副本 ——
  即上面那条“绝不能 import”的由来。**这一条对「类」不成立（实测）**：`statusline/footer-suppress.ts`
  从包根 import `FooterComponent` 打原型，A/B 捕获证明补丁落在 pi 自己 new 的那个实例上（见「跨扩展」一节），
  而 `dist/bundle/index.js` 确实是从 `./chunks/chunk-*.js` re-export 的。`keyHint` / `keyText` 的现象仍是事实，
  但按「别在模块顶层读 pi 的状态」理解即可：打类方法没事，**读状态**别放在模块顶层。
- **`keyHint` / `keyText` 绝不能 import**（`bash-command-collapse.ts` 与 `read-path-collapse.ts`
  都踩过：扩展拿到的是 npm/dist 副本，前者抛 `Theme not initialized`、后者返回空串）。要从
  `~/.pi/agent/keybindings.json` 读键名。`startup-logo` 的提示行是唯一从包根 import 的，它整行包了 try/catch。
- **照抄 pi 的函数时，参数序也要照抄**：pi 的 `resolvePath(input, baseDir)`（`utils/paths.js`）与 node 的
  `resolve(base, target)` **正好相反**。`read-path-collapse.ts` 把 node 的 `resolve` 别名成了 `resolvePath`
  再照抄源码，于是 `resolvePath(filePath, cwd)` 看着一模一样、实际是 node 语义：绝对路径进来时 node
  直接返回 `cwd`，文件被丢掉 → `relative(cwd, cwd)` = `""` → “在 cwd 内”判定通过 → 标签退化成 `"."`。
  症状：读 `~/.pi/agent/AGENTS.md` 在窄终端上显示 `Read resource .:67-80`（实测复现，宽度 ≤ 66 触发）。
  **cwd 之内的文件碰巧正确**，所以这类坑只能用 cwd 之外的路径才测得出来（回归断言已钉）。
  现在那两行走 `resolveLikePi(input, baseDir)` —— 复刻 pi 的函数就复刻它的**签名**，别复刻它的名字。
- **扩展里没有 `toolcall_checkpoint` 事件**（pi-ai 的事件联合里只有 start / text_* / thinking_* /
  toolcall_{start,delta,end} / done / error），它是 TUI / session 编码器内部用的 `MessageFrame`。
  所以每个参数 delta 都会以 `toolcall_delta` 到达扩展，段级计数本身就是完整的。
- `usage.output` 在**流式期间恒为 0**，token 数只能从流式字符估算；`toolcall_start` 的
  `partial.content[i].name` 已经带工具名，但缺块时拿不到，所以 `tool_execution_start` 仍是权威兜底。

### 几个「看起来可以简化、其实不行」

- **`bash-command-collapse.ts` 的命令行形状是「`• Run ` + 2 行 + 行尾 `…` + `… +N lines`」**（用户 2026-09-21 定）：
  续行 / 折叠标记的正文列对齐 `Run ` 的 `n` 列（2 列前缀：执行中是空格、出结果后是 `│ `），命令溢出多少都只
  吃最后 1 行。结果侧的 `└ ` **在整块里只出现一次**、挂在第一行实质输出上（截断提示行之上都挂 `│ `，之下只缩进），
  所以它必须在**所有 child 的行都走完后统一上**（`prefixTreeLines` 接在 `withPreviewLimit` 的末尾调一次）——
  逐 child 各画一棵树会在 warnings / `Took` 段再长出一个 `└ `。没有输出时补一行 `(no output)`（`└ ` 挂它前面），
  流式 partial 期间不补（那时“还没输出”不等于“没有输出”）。整块**没有任何底色**（`Box` 不带 bgFn：pending 的
  `toolPendingBg` / 成功的 `toolSuccessBg` / 失败的 `toolErrorBg` 三种底都不画，用户 2026-09-21 定）—— 状态改由
  命令**首行**行首那颗圆点 `•`（执行中 `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`，续行、折叠标记与
  整棵结果树前面都没有）表达，**着色逻辑与早先的 `▎` 一字未变**；圆点后面接一格空格，即「正文整体右移一格」，
  `Run` / `│` / `└` 同在列 2、所有正文同在列 4（用户 2026-09-21 第二轮定；命令行与结果侧必须同时移，否则两截会
  错开，`INDENT_WIDTH` 就是这一格）。左边距全由扩展自己画（`Box` 的 `paddingX` 在命令侧是 0：`withHeadBar`
  首行 `• `、其余两格空格；结果侧留 1 格再由 `withPreviewLimit` / `prefixTreeLines` 挂 `INDENT_WIDTH` 那一列），
  两边各自把用掉的列从 `wrapWidth` / `contentWidth` 里扣回来。**整块上下也没有空行**（`paddingY: 0`：命令就是块的
  第 1 行、结果就是最后一行）。底色只去 bash 这一个工具 —— 其他工具（read / grep / edit / write …）走 pi 自己的
  `contentBox` + bgFn 渲染路径，完全不受影响（有专门的回归断言盯着这条）。形状与 28 个端到端断言见
  `bash-command-collapse/render.test.ts`（过 pi 自己的加载器 + `ToolExecutionComponent`，断言的是渲染出来的行）。
  `PI_BASH_TREE` 已废弃（前缀固定用树形）。
- **命令行里的长地址缩略只作用于折叠态，且只认点名命令**（用户 2026-10-03 定，纯逻辑在 `abbrev-path.ts`）：
  一期只缩 `cat` / `cd` / `ls` / `ln` 的地址参数与 `NAME=<路径>` 赋值，其余命令（含 `import … from "/Users/…"`
  那种代码里的地址）一字不动 —— 用户明确要求。阈值是**命令正文可用列**的 40%（80 列终端 ≈ 29 列），缩略只动
  中间（`<头>…/<尾>`，尾部层数优先）。两个容易踩的点：① 展开态（ctrl+o）**绝不缩**，它是唯一能看到命令全貌的
  地方；② 折行/几何类用例的 fixture 不能用 `cd <长地址>`（会被缩成一行、续行与 `… +N lines` 全消失），
  所以 `LONG_COMMAND` 用等宽的 `cp`，缩略专用 fixture 是 `LONG_COMMAND_FOR_ABBREV`。
- **read 块与 bash 块共用同一套壳的约定**（用户 2026-09-21 定）：两者都用 `renderShell: "self"` + 「自己不去画底色」（不是画上再擦）得到**无底色、无上下边界空行**的块，左边距都是**两列**（首行 `• ` + 一格，其余行两格空格），圆点颜色都是 pending `dim` / 成功 `toolDiffAdded` / 失败 `toolDiffRemoved`。`read-path-collapse.ts` 的 `MARGIN_WIDTH = 2` 与 `bash-command-collapse.ts` 的 `GUTTER_WIDTH + INDENT_WIDTH = 3` 是**两条独立的算式**（bash 那边还要算树形 gutter），但左边缘必须对齐 ——**改一个必须看另一个**，否则两个工具的块会错开一列。宽度预算也一样：`Box` 的 `paddingX` 是 0 时，孩子拿到整宽，壳自己得按「左边距 + 末尾留白」扣回来。
- **read 的折叠态在成功时没有结果正文**：pi 的 `formatReadResult` 开头是 `if (!options.expanded && !isError) return ""` —— 读成功且没展开就只有一个标题行。所以测结果正文的列位要用**失败**那一次（`read-path-collapse/render.test.ts` 里就是这么写的），别以为正文丢了。
- **`bash-command-collapse.ts` 判定「参数还在流」是 `!streaming && !argsComplete && isPartial === true`**
  （`streaming` = 用户开了 `PI_BASH_STREAM=on` 走 pi 原生流式，此时整条压命令的路径直接跳过）。
  后两个阈值**缺一不可**：只用 `isPartial` 会把命令压到结果之后（退化成「全等结果才一次性出」）；
  只用 `argsComplete` 则 `/resume` 重建历史时它永远是 `false`（`renderSessionItems` 从不调
  `setArgsComplete`），恢复出来的 bash 块**只剩输出、命令行整行消失**。
- **`renderResult` 里 `isError` 必须从 `context` 读，不能从 `result` 读**：pi 调 resultRenderer 时传的是
  `{ content, details }`，**没有 `isError` 字段** —— 读 `result.isError` 永远拿到 undefined，
  于是失败的命令也会染成 success 底色。
- **pi 的 bash 渲染器不看传给 `renderResult` 的 theme 参数**：`renderers/bash.js` 的签名是
  `renderResult(result, options, _theme, context)`，输出正文用的是**模块级 `theme` 单例**
  （`Proxy` → `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`）。想让 bash 输出单独
  一色（扩展 token `bashOutput`）只能改那个单例的 `fgColors` 表 —— `bash-command-collapse.ts` 在
  委托内置渲染器的**同步窗口**里换进换出（`withBashOutputColor`）。代价与前提：那只 map 是全局的，
  所以窗口必须同步、只能换 `toolOutput` 一个 key，且 `fgColors` 哪天被 pi 藏起来就会静默退回原色。
- **simple-task 的三个工具也带 `renderShell: "self"`**（用户 2026-09-26 定）：与 bash / read 块同一套观感 ——
  整块没有底色、没有上下边界空行。它不需要 bash / read 那套自绘左边距（`withHeadBar`）：
  `renderCall` / `renderResult` 返回的是 `new Text(…, 1, 0)` —— **`paddingX = 1`** 补回默认壳
  `Box(1, 1)` 原本提供的那一列左边距（每行前置一个空格、不顶格，用户同日补定），
  **`paddingY = 0`** 保持上下不留空行，无 bgFn，所以不用再包 Box。`render.test.ts` 的 3 个用例
  过 pi 自己的加载器 + `ToolExecutionComponent` 钉住形状（含「其他工具底色照旧」的对照断言）。
- **`ask_user_question` 走的是同一套壳**（2026-09-26 定，与 simple-task 同日同口径）：
  工具块原来走 pi 默认的 `Box(1, 1, bgFn)`，于是成功态染绿底、上下各留一行空行；现在声明
  `renderShell: "self"` + 两个 renderer 返回 `new Text(…, 1, 0)`，只留标题行与结果行。
  注意这**只管工具块**：`ctx.ui.custom()` 弹出的问卷本体（`view.ts` 画的 `─` 边框那条路）
  不经过 `ToolExecutionComponent`，与本节无关。`render.test.ts` 的 4 个用例钉住形状。
- **两个覆盖内置 bash / edit / write 的扩展都用 `renderShell: "self"`**，动机不同：
  `tool-diff.ts` 是为了逐行拼 `\x1b[48;2;…m` 画整行 diff 底色（走 `selfRenderContainer` 就绕开了
  `tool-execution.js` 里按状态整块染色的 `bgFn`，否则逐行底色会被整块绿底盖掉；它**不用 Box**）；
  `bash-command-collapse.ts` 是为了让「流式接命令字符时屏幕上一行都不出」成为可能 —— 它把这个副作用
  **当成需求用**：pi 不再套 bgFn，而扩展自己也**故意不套**，于是 bash 块没有任何底色（别的工具照旧）。
  **`paddingY` 必须置 0**（否则两个 Box 的 padding 会叠出**三个空行**；上下外边界也一并不留）。
  命令侧 `paddingX: 0` —— 左边距（首行 `• `、其余两格空格）由 `withHeadBar` 自己画；结果侧留 1 格，
  再由 `withPreviewLimit` / `prefixTreeLines` 挂共用的 `INDENT_WIDTH`，命令行与结果树因此始终同列。
- **`prompt-editor.ts` 的 `!` bash 模式只改渲染层，正文一个字符都不动**：判定照抄 pi 的
  `interactive-mode.js`（`text.trimStart().startsWith("!")` —— 边框颜色 `updateEditorBorderColor`
  用的就是同一个标志），所以 gutter 和输入框颜色永远一致；正文里那个 `!` 只是「摘掉第一个可见字符
  + 行尾补一列空格」，Enter 提交（`text.startsWith("!")`）、↑ 历史、Esc 清空全都不用配合。
  代价是隐藏列会变成可落点，所以 `handleInput` / `handleMouse` 之后都要把光标从 (0,0) 挡回 (0,1)
  （调 Editor private 的 `setCursorCol`，没有公开 setter），点选坐标也要多算 1 列 —— 正文在视觉上
  整体左移了一列。放进那一列的话，反显光标会落在空列上（看起来光标消失），而且在那儿打字会把
  `x!ls` 写进正文、pi 当场判定退出 bash 模式。
- **`theme-command.ts` 的预览/落盘/取消三条路径全靠 `ctx.ui.setTheme()` 的两条路径语义区分**：
  传 **Theme 对象** → `setThemeInstance()`（只换色、不写 `settings.json`）；传**名字** →
  `setThemeName()`（应用**且立刻写盘**）。所以预览必须走对象路径，只有回车才走名字路径。
  选择器里主题列表与色卡区之间有一个 `Spacer(1)`：两者都是多行块，紧贴在一起分不清边界。
- **`rewind/` 的 esc esc 第二次按键必须吃掉**（`{ consume: true }`）：`/rewind` 派发后选择器是
  **同步**获得焦点的，而 pi 的输入管线是「先跑扩展 input listener、再交给聚焦组件」—— 不吃掉的话
  这次 esc 会直接落到刚打开的选择器上（`tui.select.cancel`），菜单刚弹出就被自己取消（实测就这么失败的）。
  吃掉它还顺带保证：即使 `doubleEscapeAction` 写回 `tree`，pi 内置逻辑也看不到第二次按压。
  第一次 esc **原样放行**，所以单个 esc 仍能中断流式回复。

### 存储与副作用边界

- `rewind/` 的快照存在**影子 git 仓库**里（`~/.pi/agent/rewind/<项目哈希>/git`，`GIT_DIR` 指过去、
  `GIT_WORK_TREE` 指向项目），**从不碰用户仓库的 HEAD / index / refs / status**，目录不是 git 仓库时也能用；
  根外与 `.gitignore` 挡掉的文件靠 `tool_call` 事件里的**惰性预镜像**兜底（blob 按内容寻址）。
  已知限制：只跟踪 `edit` / `write` 两个工具（`bash` 写到根外无法解析），大于 8MB 的文件不拷。
- `simple-task/` 的状态用 `pi.appendEntry` 骑在 session 日志里（**不往工作仓库写**），重建时必须读
  `ctx.sessionManager.getBranch()` 而不是 `getEntries()`，否则分支导航会把已丢弃分支上的状态复活。
- `verify-loop/` 分两种存储，别混：**goal 本身**（条件 / 状态 / 已评估轮数 / 最近裁决）用
  `pi.appendEntry("verify-loop-goal")` 骑 session 日志，`session_start` 从 `getBranch()` 重建 ——
  所以 resume 自然恢复、新会话自然清除；而**计数器**（闸拦了几次、/goal 续跑几次、连续几轮无进展）
  **不落盘也不进内存**，全部从模型可见投影（`event.context.contextMessages`）里数已注入的
  `verify-loop` 消息得出 —— 理由见上面扩展表里那一行（`agent_start` 在每次边界续跑都会重发，
  内存计数器会被清零）。注入消息本身是 `display:true` 的 `custom_message`，**会进模型上下文**
  （这正是闸的作用机制），与 recap 的「不落盘不进上下文」是两种刻意不同的选择。
- `recap/` **刻意不落盘、不进上下文**：不调 `appendEntry`，摘要只活在内存里，`/new` 或 `/resume`
  后不恢复（**刻意的，不是 bug**）。它探测子代理是否在跑走的是 pi-subagents 的进程内事件总线 RPC
  （`subagents:rpc:v1:request`），**不 import 它的任何文件** —— 独立安装的 npm 包，换台机器可能根本没装，
  探测失败一律当「没有子代理」。
  **`/recap` 是幂等的**：同一轮对话（最后一对 user+assistant 与模型都相同）已经生成过摘要、且它还挂在
  屏幕上时，再执行直接返回 —— 不重跑模型、不清 widget、也不发通知（一次失败的重复生成会用「没能生成
  recap」的提示把刚生成的摘要顶掉，这正是要避免的）。指纹只在一个地方算：`latestExchange()`，`generate()`
  的去重与命令的闸门共用它；有新对话（指纹变化，或 `input` 事件先清了状态）时闸门自动放开。
- `auto-default-model/` 会写 `~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`
  （pi 的 `/model` 只改当前会话，本机把那次 Ctrl+S 自动化掉了）。
- 删除边界的持久白名单 `~/.pi/agent/sandbox-allowlist.json` 是**机器本地状态**（见下表）：
  它记的是「哪个目录被用户确认过安全」的授权决定，不是配置，不进快照；`PI_SANDBOX_ALLOWLIST`
  可改位置（测试靠它隔离）。写入是原子的（临时文件 + rename），损坏 / 版本不认识降级为空不抛；
  危险范围（`/`、`$HOME`、含 `.git` 的路径）与**永不删除路径**（`~/.ssh`、`~/.gnupg`、`~/.zshrc` 等）
  在写入前与加载时**两道过滤**，手改的 JSON 也塞不进去。
  会话级豁免（危险目录的 `Allow for this session`）与单次豁免（`Allow once`）不落盘，只活在进程内存里（globalThis 单例，
  bash 侧与 apply_patch 侧共享）。

## 刻意不入库的机器本地文件

| 文件 | 为什么不入库 |
| --- | --- |
| `~/.pi/agent/auth.json` | 凭证 |
| `~/.pi/agent/trust.json` | 各机器自己的项目信任决定（按绝对路径记录） |
| `~/.pi/agent/models-store.json` | pi 内置模型目录的缓存 |
| `~/.pi/agent/settings.json.bak*` | 手工备份 |
| `~/.pi/agent/sessions/` | 会话记录 |
| `~/.pi/agent/missions/`、`run-history.jsonl` | `pi-subagents` 的 mission / 运行历史，换机器没有迁移价值 |
| `~/.pi/agent/rewind/` | `rewind/` 的影子快照仓库 |
| `~/.pi/agent/sandbox-allowlist.json` | 删除边界的持久白名单（哪个目录被用户确认过安全），是授权决定不是配置，换机器不该跟着走 |
| `~/.pi/agent/plans/` | 机器本地的计划与一次性脚本 |
| `~/.pi/agent/npm/`、`bin/` | pnpm 装的包（靠 `pi install` 重拉）与 pi 自带的 `fd` / `rg` |
| `~/.pi/agent/git/` | `pi install git:…` 拉下来的 git 包（靠 `settings.json` 的 `packages` 重拉；里面自带 `.gitignore` 把内容全忽略，只留 `.gitignore`） |
| `~/.pi/agent/web-search-cache/`、`~/.pi/folder-history/*.jsonl` | 运行时缓存 / 历史数据 |

另外，`settings.json` 的 `extensions` 字段是本快照与本机真实配置**唯一刻意保留的差异**：真实文件里它指向
`~/.loongsuite-pilot/plugins/pi-coding-agent/index.mjs`（另一个工具装的遥测扩展，本机版本已被置空成 no-op；
机器专属绝对路径、不属于 pi 自身配置），模板里置为 `[]`，只保留 `extensions/` 目录的自动发现。

（另有一个**格式性**差异：`~/.pi/agent/settings.json` 末尾没有换行、快照里补上了。这不是语义差异，
用 `diff` 对比时会多出一行 `\ No newline at end of file`，别当成漏镜。）

## 快照维护约定

没有安装脚本，所以同步是**双向手动**的：

- **改了本机全局配置 / 扩展** → 手动把 `~/.pi/agent/` 下的 `AGENTS.md` / `settings.json` / `models.json` /
  `mcp.json` / `pi-statusline.json` / `web-search.json` / `extensions/*` / `themes/*.json` 拷回本目录，
  保持模板与实际环境一致 —— 只有上文列的那三处是刻意差异，其余应当逐字节相同。
  （`mcp.json` 里是**本机 MCP 可执行文件的绝对路径**，与 `models.json` 的 `baseUrl` 同类：入库作模板，
  换机器照着改 `command`。）
- **换机器 / 重装** → 按前面的 `cp` 装回去，再 `pi install npm:pi-web-access`、
  `pi install npm:pi-subagents` 与 `pi install git:github.com/jayli/superpowers`。
- **外部包升级** → `pi update --extension npm:<pkg>` 在 `~/.pi/agent/npm` 里跑的是
  `pnpm install <pkg>@latest`。pnpm 11 的**发布年龄策略**（`minimumReleaseAge`；实测把发布约 50 分钟
  的版本判为「未成熟」而跳过）会让它静默不升级：锁文件里仍留旧版，输出只有
  `pi-web-access 0.33.0 (0.34.0 is available)` 和一句 `Updated …`——**看起来成功，其实没动**。
  旁证是本机 `pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 清单：每落后一次就多一条手工补的
  `pkg@version`（`pi-subagents@0.73.1` / `0.74.0` / `0.75.0` / `0.76.0`，`pi-web-access@0.33.0` /
  `0.34.0` / `0.35.0`）。
  当时的记录是「把目标版本加进该清单，再指定版本安装」：
  `pnpm install pi-web-access@0.36.0 --prefix ~/.pi/agent/npm --config.auto-install-peers=false`
  （`--prefix` 与各 `--config.*` 是 pi 自己用的同一组参数；它会把版本写进 `package.json` 与锁文件。
  只给 `@latest` 不行：旧 range 仍满足时 pnpm 会原地不动）。
  **2026-10-01 补一条实测坑**：exclude 清单漏了 `package.json` 里声明的某个新版本（当时漏了
  `pi-subagents@0.74.0`）会让下一次 `pnpm install --frozen-lockfile` 直接
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：pnpm 11 的锁文件校验会拿**锁文件里已有的每一版**
  去撞 24h 发布年龄，而校验阶段**不认** `minimumReleaseAgeExclude`。
  **2026-10-05 把这条查清楚了（上段「当时的记录」里的前提是错的，如上）**：拿临时工程 + 同一份
  workspace.yaml 实测 —— ① 用**一份没含 0.76.0 的** exclude 清单、显式
  `pnpm install pi-subagents@0.76.0`，**能装上**，且 pnpm 11 自己往清单里补了一条
  （`Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml`）；② 同一份清单下
  `@latest` 在 0.76.0 已发布（2.4 小时，仍在策略窗口内）的情况下依旧只解析到 0.75.0，**exclude 也救不了**；
  ③ 所以「静默不升」的成因是 `@latest` 这个请求本身（exclude 里没有目标版本号，pnpm 也就无从豁免），
  **升级成功靠的是「给出确切版本号」**，而不是先手工往清单里加一条。
  与 `pi update --extension` 的关系：pi 走 `getNpmCommand()`（本机 `pnpm --config.node-linker=hoisted`）
  自己拼 `install <pkg>@latest`，升级路径上**既没有** `@<确切版本>` **也没有**
  `--config.minimumReleaseAge=0`，所以它必然撞上②（`@latest` 静默不升；① 只说明「加不加 exclude
  都不影响能否升级」）。真正的手工升级姿势因此是**给出确切版本号**：
  `pnpm install pi-subagents@0.76.0 --prefix ~/.pi/agent/npm --config.auto-install-peers=false`
  （`--config.minimumReleaseAge=0` 可以带但不是成功的前提 —— 它只影响同一次命令里的 `@latest` 解析；
  带上就等于对策略免疫）。exclude 清单此后只影响**锁文件校验**：
  `pnpm install --frozen-lockfile` 不认它、只认 `--config.minimumReleaseAge=0`（2026-10-05 实测两种
  都会 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，报的就是锁文件里那个新版本）；
  `pi update --extension` 不带 `--frozen-lockfile`，所以漏补清单只卡手工那条命令，不卡 pi 的升级。
  升级失败时 pnpm 会把旧目录挪进 `node_modules/.ignored/`（约 29MB 死数据，之后再没被引用），
  重跑一次成功的 install 不会删它；该目录受内核 deny 保护，要清理只能走 dangerous 模式或
  `PI_SANDBOX=off` 的裸终端。
  验证：`node -p "require('$HOME/.pi/agent/npm/node_modules/pi-web-access/package.json').version"`，
  然后**新起一个 pi 进程**才算数——当前会话里扩展不会热重载。

  **2026-10-05 升级 0.36.0 时发现并修掉的第二个坑（与升级本身无关，0.35.0 起就坏）**：
  `fetch_content` 全坏，报 `Cannot find module '…/.pnpm/linkedom@0.16.0/…/esm/interface/cdata-section'`；
  同时 `pi_web_search` / `get_search_content` 正常，所以很容易被当成「更新引入的回归」。
  根因在上游依赖而非升级：`pi-web-access` 声明 `linkedom: ^0.16.0`，而 pnpm 在**本机 registry
  （npmmirror）**下把该 range 解析成 **0.16.0**，从**官方 registry** 却解析成 0.16.11；
  0.16.0 的 `esm/` 里有 extensionless import（`import … from '../interface/cdata-section'`，0.16.1
  起才带 `.js`），Node ESM 因此 `ERR_MODULE_NOT_FOUND`，而 `import('linkedom')` 在
  pnpm 的 `.pnpm` 布局下按包自己的 realpath 解析 → 命中那份坏的 0.16.0。
  实测排除：干净目录用 pi 同款参数（`--config.node-linker=hoisted`）装 0.36.0 同样复现；
  `node_modules/linkedom`（hoisted 根，0.18.13）与 `defuddle` 那条 0.18.13 都正常。
  修法：`~/.pi/agent/npm/pnpm-workspace.yaml` 加 `overrides: { linkedom@0.16.0: 0.16.11 }`
  （overrides 在 pnpm 11 是**读 workspace.yaml**，写在 `package.json` 的 `pnpm` 字段会被忽略并告警），
  然后 `pnpm install pi-web-access@0.36.0 --config.auto-install-peers=false --config.minimumReleaseAge=0`。
  验证：`fetch_content` 拉 `https://nodejs.org/en/blog` 真拿到 12KB 正文（修前是 linkedom 那条报错）。
  注意修好后 `pnpm install --frozen-lockfile` 仍需 `--config.minimumReleaseAge=0`，否则
  0.76.0 / 0.36.0 两条较新的锁文件条目会被 supply-chain 校验拦下。

- **pi 自身升级** → `pi update --self`，它跑的是
  `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @earendil-works/pi-coding-agent@<ver>`
  （自带 `minimumReleaseAge=0`，所以不受上面那条坑影响）。**该命令在 pi 会话里会被沙箱拦死**：
  pnpm 写全局 bin 目录要用 `_tmp_*` + rename，而 `~/Library/pnpm/bin` 在可删边界之外，
  报 `[ERROR] The CLI has no write access to the global bin directory`（文案误导，实际是 EPERM）。
  `~/Library` 属**危险档**，`/sandbox-boundary allow` 会拒，所以本地升级只能由用户自己
  切 shift+tab dangerous 模式（或直接在裸终端跑）。装完 `pi --version` 在沙箱内即可验证。
- **改完扩展的最低验证**是真起一次 pi（见上文「pi 平台的坑」——`node --test` 不校验语法）。
- **面向本机 pi 的写法约定**：纯逻辑模块刻意**不 import pi / pi-tui**（鸭子类型 + 结构化最小接口），
  这样 `node --test` 能直接跑；`tool-diff/`、`statusline/`、`recap/`、`rewind/`、`simple-task/`、
  `working-indicator/`、`startup-logo/`、`thinking-collapse/`、`fenceless-code-block/`、`prompt-editor/`、`user-message-bar/`、`codemode-tree/`
  都按这个约定拆出了可单测的伴生模块
  （`thinking-collapse/window.ts` 只注入一个 `widthOf`，`node --test clients/pi/extensions/thinking-collapse/window.test.ts`）。
  `simple-task/viewport.ts` 同理（不 import pi / pi-tui，只管滚动代数）；要断言**真实渲染行**
  则走 pi 真加载器的 `widget.test.ts` —— 那里面 import 了 `widget.ts`，而 `widget.ts` 又 import
  `@earendil-works/pi-tui`，在仓库根目录（无 node_modules）直接 `node --test` 会 `ERR_MODULE_NOT_FOUND`，
  必须由 `findPiLibraryEntry()` 找到本机 pi 的库入口后再让 jiti 解析。
  `mcp/` 更进一步：`protocol.ts` / `config.ts` / `client.ts` / `tools.ts` / `headers-command.ts` **全部不 import pi**，
  只有 `index.ts` 接线 —— 所以整条 MCP 链路（含真实 spawn 子进程）都能 `node --test` 覆盖。
- **`AGENTS.md` 自设 19000 字符预算**（当前 **28017 字符** ≈ 7004 tokens，**已超预算 9017 字符**）：
  pi 本身没有上限 —— 0.87.1 的 `system-prompt.js` 是原样拼接 context files、无截断，实测把标记放在
  9500 字符处仍被模型逐字读回；这条上限是自设的每请求固定开销预算，一路放宽：7400 → 8000（skill 优先级
  与 shell 卫生）→ 9600（issue #8 的 `## Uncertainty` 节）→ 18000（2026-09-23 删除安全 / 爆炸半径重写）
  → **19000（2026-09-23 审议式/门控式升级，issue #10）**。最后一档把执行风格从「直接式/精益式」改成
  「CC 式审议/门控」：`## Uncertainty` 的 plan 触发从「会分叉才进」改为**默认准入**（多文件、任何设计/
  结构/接口/数据形状取舍、文档重写或重构、方案未定都先进 plan，仅极简单单文件小改豁免），并新增
  「实质取舍先问」一条；新增 `## Delegation` 节（subagent 仅用户明确点名才调、调查默认内联、被授权的
  委派仍守全部纪律）；`## Verification` 加两条（写文档前逐条对权威来源核事实、报告须写明跑了哪些验证）。
  同一次改动里压缩了现有节腾空间（Git↔Shell 的交互式禁令去重、secrets/staging 三条合并、Destructive
  actions 措辞瘦身），所以抬上限是买新规则而非灌水。下次再加规则前仍须先压缩或再抬上限。
  **2026-09-30 修掉一条自相矛盾的等待规则**（mc-heavy 会话 `01a0f113` 归因）：`## Shell commands`
  原写「Do not block on `sleep` or any wait longer than 60 seconds — **poll**, or split the work」——
  全文唯一提到等待的地方，说的却是「轮询」，而该文件与 `AGENTS.core.md` **一处都没提**
  `run_in_background` 的通知唤醒机制，于是模型照着写下的规则一遍遍 `sleep` 轮询后台任务日志
  （那次会话实测：崩坏窗口 08:52:37→08:59:00 内零通知到达，只有 `sleep 150 / 120 / 90`；全会话 38 次
  sleep 共 56.6 分钟，直到用户插话才停）。工具描述里明写「never sleep or poll」但拗不过全局规则。
  现改为「Never wait by blocking: no `sleep`-poll loops, nothing over 60s in one call. For a long
  command, `run_in_background` is the answer — start it, end the turn; its terminal notification wakes
  you」，`AGENTS.core.md` 同步加一条（否则会被 `core-rules` 中途重注入压过）。字符账：+162。
  同一次归因还定下 `settings.json` 的 `followUpMode: "all"`（见上文 settings 一节）。
  **2026-09-24 把 plan 门控回摆了一档**（上面那档「默认准入」的修正，不改写历史记录）：实测本机
  23 个 session / 97 条用户指令里模型主动进了 **15 次** plan（15.5% 的指令、61% 的 session），且误报
  集中在两类——纯调研/写报告（CC 明列 “Pure research/exploration tasks” 不进 plan）和用户已给具体
  详细指令的小改（CC 的 BAD 清单正是这一条）。照 CC 的做法改了两处：① **判据搬进 `enter_plan_mode`
  的工具描述**（7 条正面 + 4 条豁免 + GOOD/BAD 示例），`AGENTS.md` 的 `## Uncertainty` 只留一条指针
  ——CC 的系统提示词里同样一句 plan 规则都没有，判据在模型决定要不要调工具那一刻才被读到；
  ② **模型主动进入前加用户同意弹框**（见上文 plan mode 一节）——CC 的 `EnterPlanMode` 是
  `shouldDefer: true` + “must consent”，正因为每次进入都要用户点头，它才敢把判据写松并保留
  “err on the side of planning”。本次「拿不准就调」也保留了，误判代价从「被迫绕一圈」降为「按一次键」。
  字符账：工具描述 +761、`AGENTS.md` 那条 −87，**每请求净增 ~674 字符**（tools 数组同样每轮发送，
  所以搬过去不省开销）——买的是去重（两处不再漂移）与判据的读取时机，不是体积。
  **2026-09-25 又做了一次同向去重（+63 字符）**：「何时必须停下来问」原先在 `## Uncertainty` /
  `## Authorization` / `## Destructive actions` 三处各写了一遍且条件互不相同（改一处忘两处就漂移），
  现在规范定义收敛到 `## Blast radius` 的 **Ask-triggers** 一条（(a) 表格的两个 confirm 类；(b) 不属于
  模型的判断：请求有实质歧义 / 要求互斥 / 超出请求范围 / 删除目标不清），其余三节只留指针；同一次改动
  把「授权跨轮持续」与「批准不外溢」的字面矛盾显式调和为**持续的是作用域、不是逐次批准**（两侧各加一句
  互指），并合并 `## Authorization` 里因此重复的两条。蒸馏版 `AGENTS.core.md` 同步（Ask-triggers 进 Blast
  radius 节、Authorization 节改成 scope-vs-approval 那句），字符数 2909 → 3327。
  它是每个会话、每一轮请求都带的固定开销，改完要重开会话才生效（context files 只在 pi 启动时读一次）。
  它装的是行为规则与安全闸（Authorization / Delegation / Destructive actions / Blast radius /
  Shell commands / Git 六节是硬闸，项目级 AGENTS.md/CLAUDE.md 只能赢过其余的工作流/风格规则，
  赢不过这六节 —— 文件开头就是这么声明的），并刻意剔除全部
  Codex 机制耦合内容（`apply_patch` / `update_plan` / `multi_tool_use` 等十个词一个都不能出现），
  工具名一律用 pi 的真实工具（`read` / `bash` / `edit` / `write`，任务清单写作 `task_set` / `task_update`）。
  本机另有一份 4 断言 gate 脚本 `~/.pi/agent/plans/verify-global-agents.mjs`（机器本地，不入库）。
