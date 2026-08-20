# `@deepseek-ai/dsh-tui`

[English](README.md) | 中文

dsh 终端组合包：架设在 `dsh-base` 之上、以行为单位交互的 agent（智能体）前端，不含 Host、HTTP 服务器、Web 运行时，也不含浏览器插件。`dsh --profile tui` 在当前工作目录开启一个会话，边到达边流式输出每个轮次的助手文本，绘制每次工具调用及其工具结果，按 Esc 中断正在运行的轮次，并从同一副键盘回答审批问题。

该组合包等于 `dsh-base` 再加三项配置：`code-runtime`（一项核心执行能力，而非 Web 组件）、`tui-startup`（本应用的命令行）与 `tui-frontend`（驱动方）。前端注入启动服务，因此 `dsh --profile tui --help` 不提供任何服务、不接管终端，也不创建 agent。

## 组合方式

```yaml
- insert:
    - id: tui-startup
      name: '@deepseek-ai/dsh-tui/startup'
    - id: tui-frontend
      name: '@deepseek-ai/dsh-tui'
      inject: [tuiStartup]
```

人格设定、工具清单、沙箱策略与审批策略全部来自 `dsh-base` 及各 profile 自己的补丁层；本组合包只重述人格设定，以及其他界面同样声明的 Code Mode 开关。

## 配置

| 字段 | 含义 |
|---|---|
| `cwd` | 会话所扎根的工作目录，由启动项提供。 |
| `resume` | 本次调用接入哪个会话，由启动项从命令行解析得出。 |
| `maxResumeSessions` | 选择器在截断列表前最多列出多少个近期会话。 |
| `toolOutput.maxLines` | 单个工具结果最多绘制多少行，其余折为一条 `+N more lines` 提示。 |
| `toolOutput.maxChars` | 单个工具结果最多绘制多少字符，在行数上限之后生效。 |

每个字段都是必填的。工具结果本身不承诺任何体积上限，因此由本界面声明自己的绘制边界；满屏审阅终端与窄幅 CI 日志也不可能共用同一个答案。该边界只作用于显示：模型收到的仍是完整结果。

## 选择会话

`--continue` 重新打开本目录下最近开启的会话，`--resume` 则把近期会话列成带编号的清单供选择。`--resume <session-id>` 直接打开指定的一个；同时给出两个标志属于用法错误，而不是悄悄偏向其中之一。

只有在当前工作目录创建的根会话才会被列出：subagent 子会话不是可继续的对话，而其他目录的会话一旦恢复，面对的工作区与它的历史并不相符。语料中不存在的具名会话会**显式失败**——用户要的是某一段特定对话，悄悄打开另一段只会掩盖问题。其余各种落空（本目录没有历史、未组合 `ctx.sessionQuery`、没有选中编号）都会自报情况并开启新会话，而这本就是该次调用原本会得到的结果。

## 编写消息

以单个反斜杠结尾的行会续接到下一行，因此多行消息无需离开提示符即可输入；双反斜杠转义该标记并结束消息，使真正以该字符结尾的行仍可写出。输入在编写途中结束时，提交已经键入的内容，而不是丢弃它。

Tab 经 `ctx.fs` 针对会话工作目录补全 `@path` token，目录优先并带上尾部分隔符，使下一次击键即可向下进入。补全只作用于位于词首的 `@`，因此电子邮件地址不受影响。未组合文件系统提供方的树、不可读的目录，以及不在 token 内的光标，都不提供任何候选——Tab 键的行为与此前一致。

## 命令

以 `/` 开头的行进入[命令层](../../interaction/commands/README.md)，而不进入模型。`/exit` 与 `/help` 归本界面所有；其余名称一律经 `ctx.commands` 解析，因此只要相应插件已组合，`/compact`、`/goal` 与计划模式都可直达。`/help` 列出本会话真正能运行的清单。

未能解析的斜杠行只作报告，绝不提交：为 `/copmact` 花掉一个模型轮次对谁都没好处。Esc 通过注册表用于竞速其处理函数的那个信号中止运行中的命令，与它中断轮次的方式完全一致。

## 提问

前端注册了 [user-questions](../../interaction/user-questions/README.md) 提供方，因此 `ask_user_question` 会在此处得到回答，而不是悬而未决。选项绘制为带编号的菜单；回答既可以给出编号（多选题用逗号分隔），也可以自由输入，后者成为自定义答案。空行表示跳过该题，保留 seam 约定的 `{ id, selected: [] }` 形态，而不是替人类编造一个他从未做出的选择。

## 工具渲染

工具通过 `presentCall`／`presentResult` 声明自己的调用与结果应如何呈现，本组合包把这些带 `card` 标签的视图转成终端文本行。渲染是视图与已配置边界的纯函数，因此同一事件永远绘制出同样的文本行。

| Card | 绘制为 |
|---|---|
| `terminal` | 调用行上是该命令；结果上是原始输出，外加非零退出码与信号（若有）。 |
| `diff` | 调用行上是所触及的路径；结果上是逐文件的 `+ created`／`~ before → after` 行数统计。 |
| `read` | 文件，以及所读行范围在总行数中的位置。 |
| `search` | 命中数或路径数、截断标记，以及命中项本身。 |
| `web` | 所抓取的 URL 与状态码，或来源数量及每个来源的标题与 URL。 |
| `generic` | 已声明的标题与已声明的内容——若该 card 未携带内容，则取工具自身的文本。 |

未声明结果意图的工具回退到它面向模型的文本，因此每一次已通告的调用都会同时显示它产出了什么。展示转换器抛错、或记录下来的参数无法解析，代价仅仅是读者少一张 card：改为绘制纯文本。调用不在实时配对表中的结果，也按同样方式绘制。

## 按键与命令

| 输入 | 效果 |
|---|---|
| Enter | 把输入行作为一条用户消息发出 |
| Esc | 中断正在运行的轮次（`agent.cancel({ kind: 'user' })`），或中止正在运行的命令 |
| Ctrl+C | 轮次运行时中断；空闲时结束会话 |
| `y`／`n` | 回答当前轮次提出的审批问题 |
| `/help` | 列出本会话能运行的命令 |
| `/<name>` | 运行一个已注册命令；未知名称只作报告，不发给模型 |
| `/exit` | 离开会话 |
| 输入结束 | 离开会话——stdin 已关闭意味着没人还会读回复 |

只有在轮次运行期间、且 stdin 报告自己是 TTY 时才进入 raw 模式。stdin 被管道接入时会话依然可用，但中断与审批不可用：审批问题会被**拒绝**而非悬置，于是工具以失败关闭，审批服务也记录到一个真实结果。

## 本界面绘制什么

它绘制的内容严格是事件日志已经承载的一个子集：已提交的 `text-delta` 分片、每个 `tool/call` 一行、每个 `tool/result` 一块。推理（reasoning）增量与原始工具参数不进入终端——它们属于跟踪数据，绘制它们等于展示 transcript（文本记录）并不承载的文本。`toolOutput` 边界只作用于所绘制的这一块，绝不作用于模型收到的结果。

审批答复只以审批服务既有的报告方式抵达模型：被允许的调用继续执行，被拒绝的以该服务自己的消息失败关闭。

## Model Experience

None, as the frontend renders the session log and answers approval questions; every prompt, schema, and result belongs to the composed base rows.

#### KV Cache effect

None; the frontend adds nothing to any request prefix, so a turn driven from this terminal is byte-identical at the model boundary to the same turn driven from any other surface.

## Known Limitations and Deferred Work

- **变更只作概述，不作 diff。** `diff` card 绘制为逐文件行数统计而非 hunk：渲染意图携带了变更前后的文本，而计算并着色 hunk 属于本里程碑未交付的显示工作。
- **历史沿用 `node:readline`。** 上下键可召回本会话已提交的行；没有反向搜索，也没有比进程更长寿的历史。
- **选择器按创建时间排序，而非最后活动时间。** 一个持续很久的旧会话会排在更新但闲置的会话之后，因为所列的 header 只带创建时间，若要按最后活动排序就得为每个候选各读一次日志。
- **命令不携带附件。** 本界面没有编写器，因此声明了 `input.images` 的命令收到的是空列表；接收图片的命令虽可触达，却无法在此获得图片。
- **一个 agent、一个会话，无 subagent 视图。** 被委派的子级照常运行，其工作也会进入父级 transcript，但终端不显示每个子级的独立面板。
