/**
 * @deepseek-ai/dsh-tui — interactive terminal frontend. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this plugin creates one
 * Agent through the core registry, streams each turn's assistant text to the
 * terminal as it arrives, lets Esc interrupt the running turn, and answers
 * approval questions from the same keyboard.
 *
 * The frontend owns no policy. It renders what the session log already carries
 * and returns an {@link ApprovalOutcome} the approval service audits — a
 * question it cannot ask (a piped stdin) is declined rather than assumed.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentRegistry, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tools'
import {
  EXIT_COMMAND,
  formatCommandList,
  formatCommandResult,
  formatUnknownCommand,
  HELP_COMMAND,
  isCommandLine,
} from './commands.ts'
import { completionRequest, completionsFor, continuationOf, joinComposed } from './compose.ts'
import { formatQuestion, formatQuestionPrompt, parseAnswer } from './questions.ts'
import {
  formatPicker,
  parseChoice,
  ResumeRequestSchema,
  selectResumable,
} from './resume.ts'
import type { ResumeCandidate, ResumeRequest } from './resume.ts'
import { createStyle, createTerminal } from './terminal.ts'
import type { TerminalCompleter, TerminalIo, TerminalStyle } from './terminal.ts'
import { formatCall, formatResult } from './tool-render.ts'
import type { OutputBounds } from './tool-render.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-frontend'

/** Core services required before the first turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Terminal frontend configuration. */
export interface Config {
  /** The working directory this session is rooted at. */
  cwd: string
  /** Which session this invocation attaches to. */
  resume: ResumeRequest
  /** How many recent sessions the picker offers. */
  maxResumeSessions: number
  /**
   * How much of one tool result this terminal draws. Required because no bound
   * suits every deployment: a wide review terminal and a narrow CI log want
   * different answers, and an unbounded result would flood the transcript.
   */
  toolOutput: OutputBounds
}

/** Schemastery configuration for the terminal frontend. */
export const Config: z<Config> = z.object({
  cwd: z.string().required(),
  resume: ResumeRequestSchema.required(),
  maxResumeSessions: z.natural().required(),
  toolOutput: z.object({
    maxLines: z.natural().required(),
    maxChars: z.natural().required(),
  }).required(),
})

/** Keys the approval prompt accepts, in the order they are offered. */
const APPROVAL_KEYS = ['y', 'n'] as const

/** The streams and exit request the frontend drives; tests substitute all of them. */
export interface TuiIo {
  /** The terminal surface input is read from and output is written to. */
  terminal: TerminalIo
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/**
 * Process-facing construction the frontend builds its terminal over; tests
 * substitute all of it. `createTerminal` is a member so a test can drive the
 * frontend's wiring against a substituted {@link TerminalIo} without a TTY.
 */
export const internals: {
  input: typeof process.stdin
  output: typeof process.stdout
  createTerminal: typeof createTerminal
} = {
  input: process.stdin,
  output: process.stdout,
  createTerminal,
}

/**
 * Render one turn-end reason as the line shown after the reply.
 * @param reason - the durable reason carried by `turn/end`.
 * @param style - styling helpers for the active stream.
 * @returns the line to print, or `undefined` when the turn ended normally.
 */
function turnNotice(
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined,
  style: TerminalStyle,
): string | undefined {
  if (reason === undefined || reason.kind === 'completed') return undefined
  if (reason.kind === 'aborted') return style.dim('  (interrupted)\n')
  if (reason.kind === 'error') return style.dim(`  (${reason.error.code}: ${reason.error.message})\n`)
  if (reason.kind === 'max-tokens') return style.dim('  (output limit reached)\n')
  // Merge-extensible union: a variant this build does not know still ended the
  // turn, so name it rather than reporting a clean finish.
  return style.dim(`  (${reason.kind})\n`)
}

/**
 * Resolve one tool's declared render intent, soft-falling to none.
 *
 * A presenter runs on live output and on replay, so a throwing presenter or
 * unparseable logged arguments must cost the reader a card, never the session.
 * @param render - the presenter call to attempt.
 * @returns the view, or undefined when none could be derived.
 */
function viewOrNone<V>(render: () => V | undefined): V | undefined {
  try {
    return render()
  } catch {
    // Contains only presenter and JSON failures; the caller draws the tool's
    // own text instead, which is the documented fallback for a missing card.
    return undefined
  }
}

/**
 * Stream one session's turns to the terminal.
 *
 * Committed text, tool calls, and tool results are drawn: reasoning deltas and
 * raw tool arguments stay off the terminal because they are trace data the
 * transcript does not carry. A result is rendered through the calling tool's
 * declared intent, so the pairing of call and result is kept per session.
 * @param ctx - plugin context carrying the session event stream and tool registry.
 * @param agent - the agent whose session is drawn; also the presenter scope.
 * @param io - the terminal to draw on.
 * @param style - styling helpers for the active stream.
 * @param bounds - the deployment's tool-output limits.
 */
function drawSession(
  ctx: Context,
  agent: Agent,
  io: TuiIo,
  style: TerminalStyle,
  bounds: OutputBounds,
): void {
  const session = agent.session
  // The call a result belongs to supplies the args its presenter needs. Only
  // this session's live calls are held, and each is released when it settles.
  const pending = new Map<string, { name: string; args: unknown }>()
  ctx.on('session/event', (emitted: Session, event: SessionEvent) => {
    if (emitted !== session) return
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') io.terminal.write(chunk.text)
      return
    }
    const tools = ctx.get('tools')
    if (event.type === 'tool/call') {
      const { callId, name, arguments: raw } = event.data
      const args = viewOrNone(() => JSON.parse(raw) as unknown)
      pending.set(callId, { name, args })
      const view = viewOrNone(() => tools?.get(name, agent)?.presentCall?.(args))
      io.terminal.write(`\n${formatCall(view, name, style)}`)
      return
    }
    if (event.type === 'tool/result') {
      const { message, meta } = event.data
      const [outcome] = message.content
      const call = pending.get(message.source.callId)
      pending.delete(message.source.callId)
      // `isError` is optional on the logged block; the render contract is a
      // definite boolean, so an absent flag means the call succeeded.
      const result = { content: outcome.content, isError: outcome.isError === true }
      const presented = { ...result, ...meta === undefined ? {} : { meta } }
      const view = call === undefined
        ? undefined
        : viewOrNone(() => tools?.get(call.name, agent)?.presentResult?.(call.args, presented))
      io.terminal.write(formatResult(view, result, bounds, style))
    }
  })
}

/**
 * Answer approval questions from the terminal for this frontend's agent only.
 *
 * A non-interactive stream cannot report the keypress, so the question is
 * declined rather than left pending: the approval service records a real
 * outcome and the tool fails closed.
 * @param ctx - plugin context the answerer registers on.
 * @param agent - the agent whose questions this terminal owns.
 * @param io - the terminal the question is asked on.
 * @param style - styling helpers for the active stream.
 */
function answerApprovals(ctx: Context, agent: Agent, io: TuiIo, style: TerminalStyle): void {
  ctx.on('approval/request', async (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    if (request.agent !== agent) return next()
    const why = request.reason === undefined ? '' : ` — ${request.reason}`
    io.terminal.write(style.accent(`\n  ${request.toolName} needs approval${why}\n  allow once? [y/n] `))
    const key = await io.terminal.readKey(APPROVAL_KEYS)
    if (key === undefined) {
      io.terminal.write(style.dim('\n  declined: this terminal cannot read a keypress\n'))
      return 'rejected'
    }
    io.terminal.write(style.dim(`${key}\n`))
    return key === 'y' ? 'allowed-once' : 'rejected'
  })
}

/**
 * Answer this terminal's user questions.
 *
 * The service admits one provider per context, and this surface drives one
 * agent, so registering here claims the question plane for this terminal. A
 * stream that cannot be read leaves every question skipped rather than
 * inventing a choice the human never made.
 * @param ctx - plugin context carrying the optional user-questions service.
 * @param io - the terminal the questions are asked on.
 * @param style - styling helpers for the active stream.
 */
function answerQuestions(ctx: Context, io: TuiIo, style: TerminalStyle): void {
  const questions = ctx.get('userQuestions')
  if (questions === undefined) return
  ctx.effect(() => questions.registerProvider({
    async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
      const answers = []
      for (const item of request.questions) {
        io.terminal.write(formatQuestion(item, style))
        answers.push(parseAnswer(item, await io.terminal.readLine(formatQuestionPrompt(item, style))))
      }
      return { answers }
    },
  }))
}

/**
 * Drive one turn to quiescence with the terminal in running mode.
 * @param agent - the agent the message is sent to.
 * @param text - the submitted user text.
 * @param io - the terminal drawn on and interrupted through.
 * @param style - styling helpers for the active stream.
 */
async function runTurn(agent: Agent, text: string, io: TuiIo, style: TerminalStyle): Promise<void> {
  const firstSeq = agent.session.seq
  io.terminal.beginTurn(() => { agent.cancel({ kind: 'user' }) })
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    io.terminal.endTurn()
  }
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of agent.session.events) {
    if (event.seq >= firstSeq && event.type === 'turn/end') reason = event.data.reason
  }
  io.terminal.write('\n')
  const notice = turnNotice(reason, style)
  if (notice !== undefined) io.terminal.write(notice)
}

/**
 * Complete an `@path` token against the session's working directory.
 *
 * The filesystem provider is read on each keystroke rather than captured,
 * because completion is offered from the moment the terminal attaches while
 * `ctx.fs` mounts with the rest of the application. A tree composing no
 * provider, an unreadable directory, and a cursor outside an `@`-token all
 * offer nothing, which is what the Tab key did before.
 * @param ctx - plugin context carrying the optional filesystem provider.
 * @param cwd - the directory relative paths resolve against.
 * @returns the completer the terminal installs.
 */
function fileCompleter(ctx: Context, cwd: string): TerminalCompleter {
  return async (line: string): Promise<[string[], string]> => {
    const request = completionRequest(line)
    if (request === undefined) return [[], line]
    const fs = ctx.get('fs')
    if (fs === undefined) return [[], request.token]
    const entries = await fs.listDir(await fs.resolve(request.dir, { cwd }))
    return [completionsFor(request, entries), request.token]
  }
}

/**
 * Read one submitted message, joining backslash-continued lines.
 * @param io - the terminal read from.
 * @param style - styling helpers for the active stream.
 * @returns the complete message, or undefined when input ended before any line.
 */
async function readMessage(io: TuiIo, style: TerminalStyle): Promise<string | undefined> {
  const parts: string[] = []
  for (;;) {
    const line = await io.terminal.readLine(parts.length === 0 ? style.accent('› ') : style.dim('… '))
    // Input ending mid-composition submits what was already typed; discarding
    // it would lose lines the user had entered.
    if (line === undefined) return parts.length === 0 ? undefined : joinComposed(parts)
    const continued = continuationOf(line)
    if (continued === undefined) {
      parts.push(line)
      return joinComposed(parts)
    }
    parts.push(continued)
  }
}

/**
 * Run one slash line against the command plane and draw its outcome.
 *
 * Esc aborts the running command through the signal the registry races the
 * handler against, so a slow command is interruptible like a turn is.
 * @param ctx - plugin context carrying the optional command registry.
 * @param agent - the agent receiving the command.
 * @param io - the terminal drawn on and interrupted through.
 * @param style - styling helpers for the active stream.
 * @param line - the complete submitted line.
 */
async function runCommand(
  ctx: Context,
  agent: Agent,
  io: TuiIo,
  style: TerminalStyle,
  line: string,
): Promise<void> {
  const commands = ctx.get('commands')
  const controller = new AbortController()
  io.terminal.beginTurn(() => { controller.abort() })
  try {
    // This surface has no composer, so a command never carries image
    // attachments; the empty list is the whole of what it can admit.
    const execution = await commands?.execute(agent, line, [], controller.signal)
    if (execution !== undefined) {
      io.terminal.write(formatCommandResult(execution.result, style))
      return
    }
    // The registry resolved nothing. `/help` is this surface's own, and every
    // other unresolved line is reported rather than spent on a model turn.
    if (line.slice(1).trim() === HELP_COMMAND) {
      io.terminal.write(formatCommandList(commands?.list(agent) ?? [], style))
      return
    }
    io.terminal.write(formatUnknownCommand(line, style))
  } catch (error: unknown) {
    io.terminal.write(style.accent(`  ${error instanceof Error ? error.message : String(error)}\n`))
  } finally {
    io.terminal.endTurn()
  }
}

/**
 * Read submitted lines until the session ends, driving one turn per line.
 * @param ctx - plugin context carrying the optional command registry.
 * @param agent - the agent every line is sent to.
 * @param io - the terminal read from and drawn on.
 * @param style - styling helpers for the active stream.
 */
async function converse(ctx: Context, agent: Agent, io: TuiIo, style: TerminalStyle): Promise<void> {
  for (;;) {
    const line = await readMessage(io, style)
    // End of input is an ordinary exit: a closed stdin means nobody is left to
    // read the reply, so a queued turn would only burn tokens.
    if (line === undefined) return
    const text = line.trim()
    if (text === '') continue
    if (text === `/${EXIT_COMMAND}`) return
    if (isCommandLine(text)) {
      await runCommand(ctx, agent, io, style, text)
      continue
    }
    await runTurn(agent, text, io, style)
  }
}

/**
 * Resolve which persisted session this invocation attaches to.
 *
 * A named session that the corpus does not hold is a hard error: the user asked
 * for one specific conversation, and quietly opening a different (or empty) one
 * would hide that. Every other miss — no history, no picked answer, no query
 * service — reports itself and falls through to a fresh session, which is what
 * the invocation would have produced anyway.
 * @param ctx - plugin context carrying the optional session-query service.
 * @param io - the terminal the picker is drawn on.
 * @param style - styling helpers for the active stream.
 * @param config - the deployment's terminal options.
 * @returns the session to resume, or undefined to start a fresh one.
 * @throws when a named session is absent from the corpus.
 */
async function chooseSession(
  ctx: Context,
  io: TuiIo,
  style: TerminalStyle,
  config: Config,
): Promise<SessionIdBrand | undefined> {
  const request = config.resume
  if (request.kind === 'new') return undefined
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    io.terminal.write(style.dim('  no session history is available here; starting a new session\n'))
    return undefined
  }
  const records = await query.listSessions()
  if (request.kind === 'session') {
    const named = records.find(record => record.header.id === request.sessionId)
    if (named === undefined) throw new Error(`no such session: ${request.sessionId}`)
    return named.header.id
  }
  const eligible = selectResumable(records.map(record => record.header), config.cwd, config.maxResumeSessions)
  const [latest] = eligible
  if (latest === undefined) {
    io.terminal.write(style.dim('  no earlier session in this directory; starting a new one\n'))
    return undefined
  }
  if (request.kind === 'latest') return latest.id
  const candidates: ResumeCandidate[] = await Promise.all(eligible.map(async header => ({
    id: header.id,
    createdAt: header.createdAt,
    ...await query.readTitle(header.id).then(found => found === undefined ? {} : { title: found.title }),
  })))
  io.terminal.write(formatPicker(candidates, Date.now(), style))
  const chosen = parseChoice(await io.terminal.readLine(style.accent('  number (blank starts a new session) › ')), candidates.length)
  if (chosen === undefined) {
    io.terminal.write(style.dim('  starting a new session\n'))
    return undefined
  }
  return candidates[chosen]?.id
}

/**
 * Create or resume the session's agent and attach the terminal to it.
 * @param ctx - plugin context carrying the Agent registry.
 * @param agents - the live agent registry.
 * @param selection - the model selection every request routes through.
 * @param config - the deployment's terminal options.
 * @param resumeSessionId - the session to resume, or undefined for a fresh one.
 * @returns the created or resumed agent.
 */
async function openAgent(
  agents: AgentRegistry,
  selection: ModelSelection,
  config: Config,
  resumeSessionId: SessionIdBrand | undefined,
): Promise<Agent> {
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  if (resumeSessionId !== undefined) {
    const { agent } = await agents.resume({ resumeSessionId, setup })
    return agent
  }
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: config.cwd },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup,
  })
  return agent
}

/**
 * Create the session's agent, attach the terminal to it, and converse until the
 * user leaves.
 * @param ctx - plugin context carrying the Agent, default model, and Session services.
 * @param io - process-facing effects.
 * @param style - styling helpers for the active stream.
 * @param config - the deployment's terminal options.
 */
async function start(ctx: Context, io: TuiIo, style: TerminalStyle, config: Config): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const resumeSessionId = await chooseSession(ctx, io, style, config)
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer.
  const agent = await openAgent(agents, selection, config, resumeSessionId)
  drawSession(ctx, agent, io, style, config.toolOutput)
  answerApprovals(ctx, agent, io, style)
  answerQuestions(ctx, io, style)
  await agent.whenIdle()

  const where = resumeSessionId === undefined ? '' : ` — resumed ${resumeSessionId}`
  io.terminal.write(style.dim(`dsh: ${selection.model} in ${config.cwd}${where}\n`))
  io.terminal.write(style.dim(io.terminal.interactive
    ? 'Esc interrupts a running turn. /help lists commands, /exit leaves.\n\n'
    : 'Non-interactive input: interrupts and approvals are unavailable.\n\n'))

  await converse(ctx, agent, io, style)
  await sessions.flush(agent.session)
  io.terminal.close()
  io.exit(0)
}

/**
 * Mount the terminal frontend.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - the deployment's terminal options.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-frontend: the launcher must provide ctx.appExit before the tree mounts')
  }
  const terminal = internals.createTerminal({
    input: internals.input,
    output: internals.output,
    complete: fileCompleter(ctx, config.cwd),
  })
  const style = createStyle(internals.output.isTTY)
  const io: TuiIo = { terminal, exit }
  void start(ctx, io, style, config).catch((error: unknown) => {
    terminal.close()
    internals.output.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
