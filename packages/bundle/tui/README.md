# `@deepseek-ai/dsh-tui`

English | [中文](README.zh.md)

The dsh terminal bundle: an interactive line-oriented Agent frontend over `dsh-base`, with no Host, HTTP server, Web runtime, or browser plugin. `dsh --profile tui` starts one session in the current working directory, streams each turn's assistant text as it arrives, draws each tool call and its result, interrupts the running turn on Esc, and answers approval questions from the same keyboard.

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

The persona, the tool roster, the sandbox policy, and the approval policy all come from `dsh-base` and the profile's own patch layers; this bundle restates only the persona and the Code Mode opt-in the other surfaces also state.

## Config

| Field | Meaning |
|---|---|
| `cwd` | The working directory the session is rooted at; the startup row supplies it. |
| `resume` | Which session this invocation attaches to; the startup row resolves it from the command line. |
| `maxResumeSessions` | How many recent sessions the picker offers before the list is capped. |
| `toolOutput.maxLines` | Maximum lines drawn for one tool result; the rest become a `+N more lines` notice. |
| `toolOutput.maxChars` | Maximum characters drawn for one tool result, applied after the line bound. |

Every field is required. A tool result carries no size promise of its own, so this surface states the bound it draws within, and no single answer suits both a full-height review terminal and a narrow CI log. That bound is display-only: the model still receives the complete result.

## Choosing a session

`--continue` reopens the most recent session started in this directory, and `--resume` offers the recent ones as a numbered list to choose from. `--resume <session-id>` reopens one outright; naming both flags is a usage error rather than a silently preferred one.

Only root sessions created in this working directory are offered: a subagent child is not a continuable conversation, and a session from another directory would resume against a workspace its history does not describe. A named session the corpus does not hold **fails loud** — the user asked for one specific conversation, and quietly opening a different one would hide that. Every other miss (no history here, no composed `ctx.sessionQuery`, no chosen number) reports itself and starts a fresh session, which is what the invocation would otherwise have produced.

## Composing a message

A line ending in a single backslash continues into the next one, so a multi-line message is typed without leaving the prompt; a doubled backslash escapes that marker and ends the message, keeping a line that genuinely ends in that character reachable. Input that ends mid-composition submits what was already typed rather than discarding it.

Tab completes an `@path` token against the session's working directory through `ctx.fs`, offering directories first with a trailing separator so the next keystroke descends. Completion applies only to an `@` that opens a word, so an email address is left alone. A tree composing no filesystem provider, an unreadable directory, and a cursor outside a token all offer nothing — the Tab key behaves as it did before.

## Commands

A line beginning with `/` reaches the [command plane](../../interaction/commands/README.md) rather than the model. `/exit` and `/help` belong to this surface; every other name is resolved through `ctx.commands`, so `/compact`, `/goal`, and plan mode are reachable wherever their plugins are composed. `/help` lists the roster this session can actually run.

An unresolved slash line is reported, never submitted: spending a model turn on `/copmact` helps nobody. Esc aborts a running command through the signal the registry races its handler against, exactly as it interrupts a turn.

## Questions

The frontend registers the [user-questions](../../interaction/user-questions/README.md) provider, so `ask_user_question` is answered here rather than left pending. Options are drawn as a numbered menu; an answer may name numbers (comma-separated when the question is multi-select) or be typed freely, which becomes the custom answer. An empty line skips the question, preserving the seam's `{ id, selected: [] }` shape rather than inventing a choice the human never made.

## Tool rendering

A tool declares how its calls and results should be presented through `presentCall`/`presentResult`, and this bundle turns those `card`-tagged views into terminal lines. Rendering is a pure function of the view and the configured bounds, so the same event always draws the same lines.

| Card | Drawn as |
|---|---|
| `terminal` | The command on the call line; the raw output, plus any non-zero exit code and signal, on the result. |
| `diff` | The touched paths on the call line; per-file `+ created` / `~ before → after` line counts on the result. |
| `read` | The file and the line range within its total. |
| `search` | The match or path count, capped-set marker, and the matches themselves. |
| `web` | The fetched URL and status, or the source count with each source's title and URL. |
| `generic` | The declared title, and the declared content — or the tool's own text when the card carries none. |

A tool that declares no result intent falls back to its model-facing text, so every announced call also shows what it produced. A presenter that throws, or logged arguments that do not parse, cost the reader a card and nothing more: the plain text is drawn instead. A result whose call is not in the live pairing table is drawn the same way.

## Keys and commands

| Input | Effect |
|---|---|
| Enter | send the typed line as one user message |
| Esc | interrupt the running turn (`agent.cancel({ kind: 'user' })`) or abort a running command |
| Ctrl+C | interrupt while a turn runs; end the session while idle |
| `y` / `n` | answer the approval question the running turn asked |
| `/help` | list the commands this session can run |
| `/<name>` | run a registered command; an unknown name is reported, not sent to the model |
| `/exit` | leave the session |
| End of input | leave the session — a closed stdin means nobody is left to read the reply |

Raw mode is entered only while a turn runs, and only when stdin reports a TTY. On a piped stdin the session still works, but interrupts and approvals are unavailable: an approval question is **declined** rather than left pending, so the tool fails closed and the approval service records a real outcome.

## What this surface draws

What it draws is a strict subset of what the log already carries: committed `text-delta` chunks, one line per `tool/call`, and one block per `tool/result`. Reasoning deltas and raw tool arguments stay off the terminal — they are trace data, and drawing them would show text the transcript does not carry. The `toolOutput` bounds apply to the drawn block alone and never to the result the model receives.

Approval answers reach the model only as the approval service already reports them: an allowed call proceeds, a declined one fails closed with the service's own message.

## Model Experience

None, as the frontend renders the session log and answers approval questions; every prompt, schema, and result belongs to the composed base rows.

#### KV Cache effect

None; the frontend adds nothing to any request prefix, so a turn driven from this terminal is byte-identical at the model boundary to the same turn driven from any other surface.

## Known Limitations and Deferred Work

- **A change is summarised, not diffed.** A `diff` card is drawn as per-file line counts rather than hunks: the render intent carries the before and after text, and computing and colouring hunks is display work this milestone does not ship.
- **History is `node:readline`'s.** Up and down recall this session's submitted lines; there is no reverse search and no history that outlives the process.
- **The picker orders by creation time, not last activity.** A long-running older session sorts below a newer idle one, because the listed header carries creation time and reading each log's last event to sort by it would cost a read per candidate.
- **Commands carry no attachments.** This surface has no composer, so a command declaring `input.images` receives the empty list; an image-taking command is reachable but cannot be given one here.
- **One agent, one session, no subagent view.** Delegated children run as usual and their work reaches the parent transcript, but the terminal shows no per-child pane.
