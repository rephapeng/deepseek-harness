# Agent Note: agent memory 能力 seam

Status: proposed

[English](2026-08-20-agent-memory-capability-seam.md) | 中文

## 问题

harness 在会话之间会忘掉一切。`dsh-agent-instructions` 会加载 `AGENTS.md` 文件，`ctx.sessionQuery` 也能检索过往 transcript（文本记录），但没有任何机制把上一个会话*学到*的东西——某个决定及其理由、用户偏好、某次修复的根因——带到下一个会话。每个会话都在重新推导上一个会话已经付过费的上下文。

外部记忆层如今已有数家（TencentDB MemoryCore、mem0、SelfMem），各自有自己的检索模型、存储介质与抽取流水线。把 harness 绑定到其中一家，等于把某个厂商的词汇搬到面向模型的界面上——那是最难更换的一层。一家都不绑，缺口则一直敞着。

绝不能被隐式决定的，是某个部署到底用哪个记忆层。那是一个组合决策，和 shell 执行器或 web 搜索提供方同类，应当落在 `cordis.yml` 里。

## 提案

为 agent（智能体）记忆新增一个完整的能力 seam，并把 MemoryCore 作为它第一个非本地提供方落地。

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-memory` | Service Definition：`ctx.memories`、recall／remember 请求词汇、提供方注册表与选择策略、`MemoryError` 分类体系 |
| `@deepseek-ai/dsh-memory-local` | Service Provider：基于 `ctx.storageDomain` 的持久记录，不联网，不依赖 LLM |
| `@deepseek-ai/dsh-memory-core` | Service Provider：经 HTTP 网关接入 TencentDB MemoryCore |
| `@deepseek-ai/dsh-tool-memory` | Consumer：面向模型的 remember／recall／forget 工具 |
| `@deepseek-ai/dsh-memory-context` | Consumer：在步骤边界自动召回并注入 |

选择策略完全照搬 [`dsh-web`](../../../../packages/web/web/README.md)：配置中给出显式 `provider` id；恰好只注册了一个可用提供方时自动选中；其余情形一律返回结构化的 `MemoryError`。提供方的 `available()` 只做廉价的本地检查——凭据是否存在、endpoint 能否解析——绝不发起网络调用。

### 记忆提供方拥有什么，不拥有什么

该 seam 承载 `recall(request)`、`remember(request)` 与 `forget(request)`，**不**承载 embedding、层级命名、排序策略或抽取提示词：那些是提供方各自的做法，两家提供方不可能就此达成一致。把原始笔记蒸馏成更高层级的提供方，与只存扁平记录的提供方，都必须满足同样这三个方法。

`recall()` 返回记录以及一个 `grounded` 判定——最佳命中是否强到可以依赖。这个字段放在 seam 而非某一个提供方里，是因为消费方必须能决定要不要注入，而任何检索系统都答得出这个问题（纯关键词提供方用自己的分数来答）。

### 接入 MemoryCore

MemoryCore 是一个独立的 TypeScript 网关，监听 `127.0.0.1:8420`，以 SQLite 为底，在未配置任何 embedding 提供方之前就可用 BM25 检索。它自己的 README 把适配器约定写成三步，而每一步都对应到 harness 已有文档的一个扩展点：

| MemoryCore 适配器职责 | harness 扩展点 |
|---|---|
| 把已完成的轮次或会话写入 L0 | 观察持久的 `turn/end`，随后 `addConversation()` |
| 在构造下一个提示词前召回 L1／L2／L3 | `agent/pre-step`，随后 `searchAtomic()`／`readScenario()`／`readCore()` |
| 把召回结果作为有界且清晰标注的上下文注入 | 一条置于 `<system-reminder>` 框架内、按字节计预算的持久 `user/message` |

第三行正是 `dsh-memory-context` 单独成包的理由：注入又是 `dsh-agent-instructions` 那个问题——仅追加的落位、按摘要值抑制未变内容、显式字节预算——而这套机制归 Consumer 所有，不归任何提供方。

MemoryCore 的每次数据面调用都要求一组 isolation 三元组。映射如下：

| MemoryCore 字段 | harness 来源 |
|---|---|
| `teamId` | 部署配置；harness 中没有对应概念 |
| `agentId` | 已组合的 preset id，使两个 preset 的记忆彼此分离 |
| `userId` | [`dsh-anonymous-user-id`](../../../../packages/identity/anonymous-user-id/README.md) |
| `sessionId` | 写入时用 `SessionId`；**召回时省略** |

召回时省略 `sessionId` 正是这次集成的要害：该字段缺席时 MemoryCore 会把 L0／L1 跨会话聚合，而这恰好就是 harness 所缺的跨会话记忆。写入仍限定在会话范围内，以保住来源可追溯。

## 曾考虑的替代方案

**用 `dsh-mcp-client` 挂上 MemoryCore，到此为止。** 今天就能跑，一个新包都不用加：一行 `streamable-http` 配置，模型就能调用那些记忆工具。作为终点被否决，但作为过渡步骤仍然成立——MCP 给模型的是「叫它才用」的工具，这也正是每份 MemoryCore 适配指南都要附带一段「CRITICAL RULE — MEMORY RECALL」提示词的原因。harness 本就有真实的步骤边界；每轮花提示词 token 去模拟它们，在成本和可靠性上都更差。在这一切动工之前，用 MCP 路线评估记忆是否真的有用，依然是有效做法。

**用一个包直接绑定 MemoryCore。** 少写四个包，却在最要紧的那一层出错：`mcp__memorycore__*` 这样的名字或一个 `ctx.memoryCore` 键，会把厂商摆到面向模型的界面和组合词汇里，日后想更换就得动提示词和 transcript，而不是改一行配置。

**把记忆做成一种压缩（compaction）策略。** `ctx.compaction` 本就在决定一段对话里什么该留下，把记忆并进去可以避免两套系统概括同样的轮次。之所以否决：压缩的产物是一段更短的*当前*对话，而记忆的产物是供*日后*使用的持久记录；一个概括完就丢弃输入的提供方无法服务后者。这种重叠确实存在，改由「风险」一节处理。

**直接把 `ctx.sessionQuery` 当记忆后端。** 过往 transcript 已经能用 FTS5 检索。之所以否决：transcript 是证据，不是知识；召回会把整段对话丢回给模型重读，代价恰恰是记忆层存在的意义所要省下的 token。

## 验收标准

- `ctx.memories` 能按显式 id 解析提供方、在只有一个可用提供方时自动选中，并对缺失、不可用与歧义三种情形返回既定的 `MemoryError`；`available()` 不发起网络调用。
- 仅组合 `dsh-memory-local` 的部署，在不联网、未配置 LLM 的前提下完成跨两个会话的存取。
- 组合 `dsh-memory-core` 并对接运行中的网关时，在 `turn/end` 写入 L0，并在省略 `sessionId` 的情况下跨会话召回，由一项无凭据即自动跳过的真实 API e2e 证明。
- 每一条进入模型请求的召回记录，都能仅凭会话日志重建。
- 召回失败、超时或返回 `grounded: false` 时，轮次照常继续且不注入任何内容；只有配置错误才在加载时失败。
- 注入的上下文仅追加在请求尾部，由必填配置限定字节上限，并在摘要值未变时被抑制。
- 通过一个可运行示例提供无凭据快照覆盖；若新增 `SessionEventMap` 成员，则同时更新两个 SDK 的预期输出。

## 风险

- **与压缩重叠。** 两者都在决定一段对话里什么值得留下。若不加协调，同时启用两者的部署会付两遍费用，还可能把同一个事实以两种措辞呈现给模型。写入触发点必须挑在压缩边界上——那里已经识别出即将离开可见面的区间——而不是每轮各自触发。这是最大的待解问题，应当在动手写 `dsh-memory-context` 之前先定下来。
- **第二条模型依赖。** MemoryCore 的抽取与聚合走它自己的 OpenAI 兼容 LLM 凭据，配置在 MemoryCore 内部而非经由 `ctx.llm`。于是一个部署要配两条模型路径，且记忆模型的开销对 `ctx.tokenMeter` 不可见。把 `TDAI_LLM_BASE_URL` 指向同一个 OpenAI 兼容 endpoint 能收窄这一点，但并不能消除。
- **召回落在热路径上。** 自动召回给每次请求增加一次网络往返。若没有必填的超时与「降级为空」的回答，网关一旦故障就会卡死每一个轮次，而不只是损失一项功能。
- **KV Cache 复用。** 召回结果随查询而变。一旦注入到请求尾部以外的位置，就会在每一轮令可复用前缀失效——而这正是该注入设计要避免的代价。
- **对话内容离开本进程。** 把轮次写入任何记忆层，都等于把它们发布到那个存储。这必须是一个显式的组合选择，凭据经 `ctx.credentials` 解析，绝不能作为隐式默认；网关自身的鉴权（`Authorization: Bearer`、`x-tdai-service-id`）在任何非回环绑定下都是必需的。
- **提供方成熟度。** MemoryCore 目前是非默认分支上的 `2.0.0-beta.1`，且其数据面已经从 `/v2/*` 迁到 `/v3/*`。提供方包锁定版本并承担这份变动；seam 不随之移动。
- **subagent 范围尚未确定。** 被委派的子级是共享父级记忆还是自持一份，本 Agent Note 不作决定。MemoryCore 提供了 `agentId` 供切分，但其 SDK 明确写着该字段只是 isolation 便利，并非安全边界。
