# `@deepseek-ai/dsh-tui`

The dsh terminal bundle: an interactive line-oriented Agent frontend over `dsh-base`, with no Host, HTTP server, Web runtime, or browser plugin. `dsh --profile tui` starts one session in the current working directory, streams each turn's assistant text as it arrives, interrupts the running turn on Esc, and answers approval questions from the same keyboard.

The bundle is `dsh-base` plus three rows: `code-runtime` (a core execution capability, not a Web component), `tui-startup` (this app's command line), and `tui-frontend` (the driver). The frontend injects the startup service, so `dsh --profile tui --help` provides nothing, attaches no terminal, and creates no Agent.

## Composition

```yaml
- insert:
    - id: tui-startup
      name: '@deepseek-ai/dsh-tui/startup'
    - id: tui-frontend
      name: '@deepseek-ai/dsh-tui'
      inject: [tuiStartup]
```

`tui-frontend` takes no config. The persona, the tool roster, the sandbox policy, and the approval policy all come from `dsh-base` and the profile's own patch layers; this bundle restates only the persona and the Code Mode opt-in the other surfaces also state.

## Keys and commands

| Input | Effect |
|---|---|
| Enter | send the typed line as one user message |
| Esc | interrupt the running turn (`agent.cancel({ kind: 'user' })`) |
| Ctrl+C | interrupt while a turn runs; end the session while idle |
| `y` / `n` | answer the approval question the running turn asked |
| `/exit` | leave the session |
| End of input | leave the session — a closed stdin means nobody is left to read the reply |

Raw mode is entered only while a turn runs, and only when stdin reports a TTY. On a piped stdin the session still works, but interrupts and approvals are unavailable: an approval question is **declined** rather than left pending, so the tool fails closed and the approval service records a real outcome.

## Model Experience

The frontend contributes **no prompt section, no tool, and no session event**. It is a renderer over the session log and an answerer for `approval/request`, so a turn driven from this terminal is byte-identical at the model boundary to the same turn driven from any other surface. Token cost, KV-cache reuse, and compaction behaviour are exactly those of the composed base.

What it draws is a strict subset of what the log already carries: committed `text-delta` chunks, and one dim line per `tool/call` naming the tool. Reasoning deltas and raw tool arguments stay off the terminal — they are trace data, and drawing them would show text the transcript does not carry.

Approval answers reach the model only as the approval service already reports them: an allowed call proceeds, a declined one fails closed with the service's own message.

## Known Limitations and Deferred Work

- **No resume, no session picker.** Every start creates a fresh session. The persisted log is written as usual, but nothing reads it back yet; `--resume <session>` needs `agents.resume()` and a picker that this milestone does not ship.
- **No tool-result rendering.** A tool call is announced by name; its result is not drawn. The model sees the result as always, but the human sees only that the call happened.
- **No user-questions provider.** `ask_user_question` has no answerer here, so a composition that mounts it will find the question unanswered. Only `approval/request` is answered.
- **No slash commands beyond `/exit`.** The `commands` registry is not consumed, so `/compact`, plan mode, and goal commands are unreachable from this surface.
- **Line editing is `node:readline`'s.** No multi-line composition, no `@file` completion, no history search beyond what readline provides.
- **One agent, one session, no subagent view.** Delegated children run as usual and their work reaches the parent transcript, but the terminal shows no per-child pane.
