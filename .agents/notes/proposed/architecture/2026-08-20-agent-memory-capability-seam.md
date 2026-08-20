# Agent Note: agent memory capability seam

Status: proposed

English | [中文](2026-08-20-agent-memory-capability-seam.zh.md)

## Problem

The harness forgets everything between sessions. `dsh-agent-instructions` loads `AGENTS.md` files, and `ctx.sessionQuery` can search past transcripts, but nothing carries what an earlier session *learned* — a decision and its reason, a user preference, the root cause of a fix — into the next one. Every session re-derives context the previous one already paid for.

Several external memory layers now exist (TencentDB MemoryCore, mem0, SelfMem), each with its own retrieval model, storage medium, and extraction pipeline. Binding the harness to one of them would put a vendor's vocabulary on the model-facing surface, where it is most expensive to change. Binding to none leaves the gap open.

The choice that must not be made implicitly is *which* memory a deployment uses. That is a composition decision, like the shell executor or the web search provider, and it belongs in `cordis.yml`.

## Proposal

Add a complete capability seam for agent memory, and land MemoryCore as its first non-local provider.

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-memory` | Service Definition: `ctx.memories`, the recall/remember request vocabulary, provider registry and selection policy, the `MemoryError` taxonomy |
| `@deepseek-ai/dsh-memory-local` | Service Provider: durable records over `ctx.storageDomain`, no network, no LLM |
| `@deepseek-ai/dsh-memory-core` | Service Provider: TencentDB MemoryCore over its HTTP gateway |
| `@deepseek-ai/dsh-tool-memory` | Consumer: the model-facing remember/recall/forget tools |
| `@deepseek-ai/dsh-memory-context` | Consumer: auto-recall injection at the step boundary |

Selection follows [`dsh-web`](../../../../packages/web/web/README.md) exactly: an explicit `provider` id in config, auto-selection when exactly one usable provider is registered, and a structured `MemoryError` for every other case. A provider's `available()` is a cheap local check — credential presence, parseable endpoint — and makes no network call.

### What a memory provider owns, and what it does not

The seam carries `recall(request)`, `remember(request)`, and `forget(request)`. It does **not** carry embeddings, layer names, ranking strategy, or extraction prompts: those are how a provider does its job, and two providers will not agree on them. A provider that distills raw notes into higher tiers and one that stores flat records must both satisfy the same three methods.

`recall()` returns records plus a `grounded` verdict — whether the best match was strong enough to rely on. That field is in the seam rather than in one provider because a consumer must be able to decide whether to inject at all, and every retrieval system can answer it (a keyword-only provider answers it from its own score).

### Binding MemoryCore

MemoryCore is a standalone TypeScript gateway on `127.0.0.1:8420` backed by SQLite, with BM25 retrieval available before any embedding provider is configured. Its own README states the adapter contract in three steps, and each maps onto an extension point the harness already documents:

| MemoryCore adapter responsibility | Harness extension point |
|---|---|
| Write completed turns or sessions to L0 | observe durable `turn/end`, then `addConversation()` |
| Recall L1/L2/L3 before constructing the next prompt | `agent/pre-step`, then `searchAtomic()` / `readScenario()` / `readCore()` |
| Inject recalled results as bounded, clearly labeled context | one durable `user/message` under a `<system-reminder>` frame, budgeted in bytes |

The third row is why `dsh-memory-context` is a separate package: injection is the `dsh-agent-instructions` problem again — append-only placement, digest-based suppression of unchanged content, and an explicit byte budget — and that machinery belongs to a Consumer, not to any provider.

MemoryCore requires an isolation triple on every data-plane call. The mapping is:

| MemoryCore field | Harness source |
|---|---|
| `teamId` | deployment config; no harness concept corresponds to it |
| `agentId` | the composed preset id, so two presets keep separate memory |
| `userId` | [`dsh-anonymous-user-id`](../../../../packages/identity/anonymous-user-id/README.md) |
| `sessionId` | the `SessionId` on write; **omitted on recall** |

Omitting `sessionId` on recall is the whole point of the integration: MemoryCore aggregates L0/L1 across sessions when the field is absent, which is exactly the cross-session memory the harness lacks. Writes stay session-scoped so provenance survives.

## Alternatives considered

**Mount MemoryCore through `dsh-mcp-client` and stop.** It works today with no new package: one `streamable-http` row and the model can call the memory tools. Rejected as the destination, not as a step — MCP gives the model tools it only calls when told to, which is why every MemoryCore adapter guide ships a "CRITICAL RULE — MEMORY RECALL" prompt fragment. The harness has real step boundaries; spending prompt tokens per turn to simulate them is worse on both cost and reliability. The MCP route stays valid for evaluating whether memory helps before any of this is built.

**One package binding MemoryCore directly.** Cheaper by four packages, and wrong at the layer that matters: `mcp__memorycore__*` or a `ctx.memoryCore` key puts the vendor on the model-facing surface and in the composition vocabulary, where replacing it later means touching prompts and transcripts rather than one config row.

**Make memory a compaction strategy.** `ctx.compaction` already decides what survives from a conversation, and folding memory into it would avoid two systems summarizing the same turns. Rejected because compaction's product is a shorter *current* conversation while memory's product is a durable record for *later* ones; a provider that discards its input after summarizing cannot serve the second. The overlap is real and is handled under Risks instead.

**Reuse `ctx.sessionQuery` as the memory backend.** Past transcripts are already searchable with FTS5. Rejected because a transcript is evidence, not knowledge: recall would return whole conversations for the model to re-read, at the token cost the memory layer exists to avoid.

## Acceptance criteria

- `ctx.memories` resolves a provider by explicit id, auto-selects a single usable one, and returns the documented `MemoryError` for missing, unavailable, and ambiguous cases; `available()` makes no network call.
- A composition with `dsh-memory-local` alone stores and recalls across two sessions with no network and no LLM configured.
- A composition with `dsh-memory-core` against a running gateway writes L0 on `turn/end` and recalls across sessions with `sessionId` absent, proven by a real-API e2e that self-skips without credentials.
- Every recalled record that reaches a model request is reconstructable from the session log alone.
- A recall that fails, times out, or returns `grounded: false` leaves the turn running and injects nothing; only misconfiguration fails at load.
- Injected context is append-only at the request tail, byte-bounded by required config, and suppressed when its digest is unchanged.
- Keyless snapshot coverage through a runnable example, plus updated expected outputs for both SDKs if a new `SessionEventMap` member lands.

## Risks

- **Overlap with compaction.** Both decide what is worth keeping from a conversation. Left uncoordinated, a deployment running both pays twice and may show the model the same fact in two wordings. The write trigger must be chosen against the compaction boundary — where the range about to leave the visible surface is already identified — rather than firing independently every turn. This is the largest open question and should be settled before `dsh-memory-context` is built.
- **A second model dependency.** MemoryCore performs extraction and aggregation through its own OpenAI-compatible LLM credentials, configured inside MemoryCore rather than through `ctx.llm`. A deployment therefore configures two model paths, and the memory model's cost is invisible to `ctx.tokenMeter`. Pointing `TDAI_LLM_BASE_URL` at the same OpenAI-compatible endpoint narrows this but does not close it.
- **Recall on the hot path.** Auto-recall adds a network hop per request. Without a required timeout and a degrade-to-empty answer, a gateway outage stops every turn rather than costing one feature.
- **KV-cache reuse.** Recall results vary per query. Injected anywhere but the request tail, they invalidate the reusable prefix on every turn — the cost the injection design exists to avoid.
- **Conversation content leaves the process.** Writing turns to any memory layer publishes them to that store. This must be an explicit composition choice with credentials resolved through `ctx.credentials`, never an implicit default, and the gateway's own auth (`Authorization: Bearer`, `x-tdai-service-id`) is required for any non-loopback bind.
- **Provider maturity.** MemoryCore is `2.0.0-beta.1` on a non-default branch, and it has already migrated its data plane from `/v2/*` to `/v3/*`. The provider package pins a version and owns that churn; the seam does not move with it.
- **Subagent scope is unsettled.** Whether a delegated child shares its parent's memory or keeps its own is a decision this note does not make. MemoryCore offers `agentId` for the split, but its SDK documents that field as isolation convenience rather than a security boundary.
