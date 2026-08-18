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
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { createStyle, createTerminal } from './terminal.ts'
import type { TerminalIo, TerminalStyle } from './terminal.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-frontend'

/** Core services required before the first turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** The line that ends the session. */
const EXIT_COMMAND = '/exit'

/** Keys the approval prompt accepts, in the order they are offered. */
const APPROVAL_KEYS = ['y', 'n'] as const

/** The streams and exit request the frontend drives; tests substitute all of them. */
export interface TuiIo {
  /** The terminal surface input is read from and output is written to. */
  terminal: TerminalIo
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** Process streams the frontend builds its terminal over; tests substitute them. */
export const internals: { input: typeof process.stdin; output: typeof process.stdout } = {
  input: process.stdin,
  output: process.stdout,
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
 * Stream one session's turns to the terminal.
 *
 * Only committed text deltas and tool-call announcements are drawn: reasoning
 * deltas and raw tool arguments are trace data, and a terminal that echoed them
 * would show the model text the transcript does not carry.
 * @param ctx - plugin context carrying the session event stream.
 * @param session - the session whose events are drawn.
 * @param io - the terminal to draw on.
 * @param style - styling helpers for the active stream.
 */
function drawSession(ctx: Context, session: Session, io: TuiIo, style: TerminalStyle): void {
  ctx.on('session/event', (emitted: Session, event: SessionEvent) => {
    if (emitted !== session) return
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') io.terminal.write(chunk.text)
      return
    }
    if (event.type === 'tool/call') {
      io.terminal.write(style.dim(`\n  · ${event.data.name}\n`))
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
 * Read submitted lines until the session ends, driving one turn per line.
 * @param agent - the agent every line is sent to.
 * @param io - the terminal read from and drawn on.
 * @param style - styling helpers for the active stream.
 */
async function converse(agent: Agent, io: TuiIo, style: TerminalStyle): Promise<void> {
  for (;;) {
    const line = await io.terminal.readLine(style.accent('› '))
    // End of input is an ordinary exit: a closed stdin means nobody is left to
    // read the reply, so a queued turn would only burn tokens.
    if (line === undefined) return
    const text = line.trim()
    if (text === '') continue
    if (text === EXIT_COMMAND) return
    await runTurn(agent, text, io, style)
  }
}

/**
 * Create the session's agent, attach the terminal to it, and converse until the
 * user leaves.
 * @param ctx - plugin context carrying the Agent, default model, and Session services.
 * @param io - process-facing effects.
 * @param style - styling helpers for the active stream.
 */
async function start(ctx: Context, io: TuiIo, style: TerminalStyle): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer.
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  drawSession(ctx, agent.session, io, style)
  answerApprovals(ctx, agent, io, style)
  await agent.whenIdle()

  io.terminal.write(style.dim(`dsh: ${selection.model} in ${process.cwd()}\n`))
  io.terminal.write(style.dim(io.terminal.interactive
    ? 'Esc interrupts a running turn. /exit leaves.\n\n'
    : 'Non-interactive input: interrupts and approvals are unavailable.\n\n'))

  await converse(agent, io, style)
  await sessions.flush(agent.session)
  io.terminal.close()
  io.exit(0)
}

/**
 * Mount the terminal frontend.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 */
export function apply(ctx: Context): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-frontend: the launcher must provide ctx.appExit before the tree mounts')
  }
  const terminal = createTerminal({ input: internals.input, output: internals.output })
  const style = createStyle(internals.output.isTTY === true)
  const io: TuiIo = { terminal, exit }
  void start(ctx, io, style).catch((error: unknown) => {
    terminal.close()
    internals.output.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
