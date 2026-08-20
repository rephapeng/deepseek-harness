/** Frontend wiring: session drawing, turn driving, interrupts, approvals, and exit. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { apply, Config, internals } from '../src/index.ts'
import type { TerminalIo, TerminalOptions } from '../src/terminal.ts'

/** Bounds small enough that a test can drive both the line and character cap. */
const BOUNDS = { maxLines: 4, maxChars: 120 }

/** The deployment options every bench mounts with. */
const OPTIONS: Config = {
  cwd: '/workspace',
  resume: { kind: 'new' },
  maxResumeSessions: 5,
  toolOutput: BOUNDS,
}

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

/** The turn outcome a scripted reply ends with. */
type EndReason = Parameters<Session['append']>[1] extends never ? never : {
  kind: string
  [key: string]: unknown
}

/** A substituted terminal plus the observations the assertions read. */
interface FakeTerminal extends TerminalIo {
  /** Everything the frontend wrote, concatenated. */
  output(): string
  /** `beginTurn`/`endTurn` transitions, in order. */
  readonly turns: string[]
  /** Fire the interrupt the running turn registered. */
  interrupt(): void
  /** Resolves once the frontend has mounted and is asking for its first line. */
  readonly ready: Promise<void>
  /** Resolves once a turn has entered running mode. */
  readonly began: Promise<void>
  /** Let a held first `readLine` return, so the conversation proceeds. */
  release(): void
}

/** What a substituted terminal replays to the frontend. */
interface TerminalScript {
  /** Lines returned by successive `readLine` calls; exhaustion is end of input. */
  lines?: (string | undefined)[]
  /** Keys returned by successive `readKey` calls; exhaustion returns undefined. */
  keys?: (string | undefined)[]
  /** Whether the terminal claims it can report a keypress. */
  interactive?: boolean
  /** Hold the first `readLine` until `release()`, so a test can act mid-session. */
  hold?: boolean
}

/**
 * Build a substituted terminal over a fixed script.
 * @param script - the lines, keys, and interactivity this terminal replays.
 * @returns the terminal plus its observations.
 */
function fakeTerminal(script: TerminalScript): FakeTerminal {
  const lines = [...script.lines ?? []]
  const keys = [...script.keys ?? []]
  const turns: string[] = []
  let out = ''
  let onInterrupt: (() => void) | undefined
  let announceReady: () => void
  const ready = new Promise<void>((resolve) => { announceReady = resolve })
  let announceBegan: () => void
  const began = new Promise<void>((resolve) => { announceBegan = resolve })
  let release: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let firstLine = true
  return {
    interactive: script.interactive ?? true,
    turns,
    ready,
    began,
    release: () => { release() },
    output: () => out,
    interrupt: () => { onInterrupt?.() },
    write: (text: string) => { out += text },
    readLine: async () => {
      if (firstLine) {
        firstLine = false
        announceReady()
        if (script.hold === true) await released
      }
      return lines.length === 0 ? undefined : lines.shift()
    },
    readKey: () => Promise.resolve(keys.length === 0 ? undefined : keys.shift()),
    beginTurn: (handler: () => void) => { turns.push('begin'); onInterrupt = handler; announceBegan() },
    endTurn: () => { turns.push('end'); onInterrupt = undefined },
    close: () => { turns.push('close') },
  }
}

/** How a scripted agent answers one submitted line. */
interface Script {
  /** Tools registered on the real registry before the frontend mounts. */
  tools?: ToolDefinition[]
  /** Commands registered on the real registry before the frontend mounts. */
  commands?: CommandDefinition[]
  /** Substitute a registry whose dispatch rejects, in place of the real one. */
  rejectingCommands?: unknown
  /** Session headers a substituted `sessionQuery` lists; absent composes none. */
  sessions?: { header: SessionHeader; title?: string }[]
  /** Deployment options replacing {@link OPTIONS} for this bench. */
  options?: Partial<Config>
  /** Compose the user-questions seam so the frontend can claim it. */
  userQuestions?: boolean
  /** Append the reply this turn produces; an async reply keeps the turn running. */
  reply?(session: Session, message: UserMessage, turn: number): void | Promise<void>
  /** Called when the frontend cancels the running turn. */
  onCancel?(): void
}

/**
 * Append one complete scripted turn.
 * @param session - the session the turn is appended to.
 * @param turn - the turn ordinal.
 * @param message - the submitted user message.
 * @param reason - the durable turn-end reason.
 */
function endTurn(session: Session, turn: number, message: UserMessage, reason: EndReason): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason } as never)
}

/** A mounted frontend under a scripted agent. */
interface Bench {
  ctx: Context
  terminal: FakeTerminal
  /** The live session, once the agent exists. */
  session(): Session
  /** Resolves with the requested exit code. */
  exited: Promise<number>
  /** The session the frontend resumed, if it resumed one. */
  resumedSession(): SessionId | undefined
  /** The options the frontend built its terminal with. */
  terminalOptions(): TerminalOptions
}

/**
 * Mount the frontend over real Session/Agent registries and a scripted agent.
 * @param script - how the scripted agent answers.
 * @param terminalScript - what the substituted terminal replays.
 * @returns the mounted bench.
 */
async function bench(script: Script, terminalScript: TerminalScript): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (script.tools !== undefined) {
    // The registry injects the system-prompt service, so the seam it
    // contributes schemas to must be composed alongside it.
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const tools = ctx.get('tools')
    if (tools === undefined) throw new Error('tool registry did not mount')
    for (const tool of script.tools) tools.register(tool)
  }
  if (script.rejectingCommands !== undefined) {
    const reason = script.rejectingCommands
    ctx.provide('commands', {
      // Throwing, rather than rejecting, keeps the non-Error reason under test
      // without a lint exemption that only the type-aware pass agrees is used.
      execute: async () => { throw reason },
    } as never)
  }
  if (script.commands !== undefined) {
    await ctx.plugin(CommandRuntime)
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('command registry did not mount')
    for (const command of script.commands) commands.register(command)
  }
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  let live: Session | undefined
  let turn = 0
  let resumed: SessionId | undefined
  const createAgentFor = async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
    const session = ctx.sessions.create(options.sessionId, {
      ...options.meta === undefined ? {} : { meta: options.meta },
    })
    live = session
    let idle = Promise.resolve()
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, {
      id: session.id,
      options: options.agentOptions ?? {},
      session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle',
      ctx: agentCtx,
      cancel: () => { script.onCancel?.() },
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        turn++
        const current = turn
        idle = Promise.resolve().then(() => script.reply?.(session, message, current))
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    } satisfies Partial<Agent>)
    await options.setup?.(agentCtx)
    ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    createAgent: createAgentFor,
    async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
      resumed = options.resumeSessionId
      return createAgentFor(ownerCtx, {
        sessionId: options.resumeSessionId,
        ...options.setup === undefined ? {} : { setup: options.setup },
      })
    },
  })
  if (script.userQuestions === true) await ctx.plugin(UserQuestionService)
  if (script.sessions !== undefined) {
    const listed = script.sessions
    ctx.provide('sessionQuery', {
      listSessions: () => Promise.resolve(listed.map(entry => ({ header: entry.header, live: false, persisted: true }))),
      readTitle: (id: SessionId) => Promise.resolve(
        listed.find(entry => entry.header.id === id)?.title === undefined
          ? undefined
          : { title: listed.find(entry => entry.header.id === id)?.title },
      ),
    } as never)
  }
  const terminal = fakeTerminal(terminalScript)
  let built: TerminalOptions | undefined
  internals.createTerminal = (options: TerminalOptions) => {
    built = options
    return terminal
  }
  internals.output = { isTTY: false, write: () => true } as never
  const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
  apply(ctx, Object.assign({}, OPTIONS, script.options))
  return {
    ctx,
    terminal,
    session: () => live as Session,
    exited,
    resumedSession: () => resumed,
    terminalOptions: () => built as TerminalOptions,
  }
}

describe('tui frontend', () => {
  it('streams committed text and announces each tool call', async () => {
    const test = await bench({
      reply(session, message, turn) {
        session.append('assistant/chunk', {
          turn, step: 1, chunk: { type: 'reasoning-delta', text: 'thinking' },
        } as never)
        session.append('assistant/chunk', {
          turn, step: 1, chunk: { type: 'text-delta', text: 'hello' },
        } as never)
        session.append('tool/call', {
          turn, step: 1, callId: 'c1', name: 'read', arguments: '{}',
        } as never)
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['say hi'] })
    expect(await test.exited).toBe(0)
    const out = test.terminal.output()
    expect(out).toContain('hello')
    expect(out).toContain('· read')
    // Reasoning is trace data the transcript does not carry.
    expect(out).not.toContain('thinking')
    await test.ctx.fiber.dispose()
  })

  it('draws nothing for another session\'s events', async () => {
    const test = await bench({
      reply(session, message, turn) { endTurn(session, turn, message, { kind: 'completed' }) },
    }, { lines: [], hold: true })
    // Only after the frontend asks for its first line is the session listener
    // mounted; appending earlier would not reach the branch under test.
    await test.terminal.ready
    const other = test.ctx.sessions.create('session-other' as never, {})
    other.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', text: 'FOREIGN' },
    } as never)
    test.terminal.release()
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).not.toContain('FOREIGN')
    await test.ctx.fiber.dispose()
  })

  it('drives one turn per submitted line and skips blank input', async () => {
    const seen: string[] = []
    const test = await bench({
      reply(session, message, turn) {
        const [block] = message.content
        seen.push(block?.type === 'text' ? block.text : '')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['first', '   ', 'second'] })
    expect(await test.exited).toBe(0)
    expect(seen).toEqual(['first', 'second'])
    expect(test.terminal.turns.filter(entry => entry === 'begin')).toHaveLength(2)
    await test.ctx.fiber.dispose()
  })

  it('leaves on /exit without driving a turn', async () => {
    let replied = false
    const test = await bench({ reply: () => { replied = true } }, { lines: ['/exit', 'never read'] })
    expect(await test.exited).toBe(0)
    expect(replied).toBe(false)
    await test.ctx.fiber.dispose()
  })

  it('closes the terminal and requests a clean exit at end of input', async () => {
    const test = await bench({}, { lines: [] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.turns).toContain('close')
    await test.ctx.fiber.dispose()
  })

  it('ends running mode even when the turn rejects', async () => {
    const test = await bench({
      reply() { throw new Error('loop exploded') },
    }, { lines: ['boom'] })
    await expect(test.exited).resolves.toBe(1)
    expect(test.terminal.turns).toEqual(['begin', 'end', 'close'])
    await test.ctx.fiber.dispose()
  })

  it('cancels the running turn when the terminal reports an interrupt', async () => {
    let cancelled = 0
    let releaseTurn: () => void
    const held = new Promise<void>((resolve) => { releaseTurn = resolve })
    const test = await bench({
      onCancel() { cancelled++; releaseTurn() },
      async reply(session, message, turn) {
        // The turn stays running until the interrupt arrives, so the handler
        // the frontend registered is fired while it is still installed.
        await held
        endTurn(session, turn, message, { kind: 'aborted', reason: { kind: 'user' } })
      },
    }, { lines: ['work'] })
    await test.terminal.began
    test.terminal.interrupt()
    expect(await test.exited).toBe(0)
    expect(cancelled).toBe(1)
    expect(test.terminal.output()).toContain('(interrupted)')
    await test.ctx.fiber.dispose()
  })

  it.each([
    [{ kind: 'aborted', reason: { kind: 'user' } }, '(interrupted)'],
    [{ kind: 'error', error: { code: 'SERVER', message: 'down' } }, '(SERVER: down)'],
    [{ kind: 'max-tokens' }, '(output limit reached)'],
    [{ kind: 'future-variant' }, '(future-variant)'],
  ])('names the turn-end reason %#', async (reason, expected) => {
    const test = await bench({
      reply(session, message, turn) { endTurn(session, turn, message, reason) },
    }, { lines: ['go'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).toContain(expected)
    await test.ctx.fiber.dispose()
  })

  it('prints no notice for a completed turn', async () => {
    const test = await bench({
      reply(session, message, turn) { endTurn(session, turn, message, { kind: 'completed' }) },
    }, { lines: ['go'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).not.toContain('(')
    await test.ctx.fiber.dispose()
  })

  it('tells the user what this terminal can do', async () => {
    const interactiveRun = await bench({}, { lines: [], interactive: true })
    expect(await interactiveRun.exited).toBe(0)
    expect(interactiveRun.terminal.output()).toContain('Esc interrupts')
    await interactiveRun.ctx.fiber.dispose()

    const pipedRun = await bench({}, { lines: [], interactive: false })
    expect(await pipedRun.exited).toBe(0)
    expect(pipedRun.terminal.output()).toContain('Non-interactive input')
    await pipedRun.ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    internals.createTerminal = () => fakeTerminal({})
    expect(() => { apply(ctx, OPTIONS) }).toThrow('must provide ctx.appExit')
  })

  it('reports a failed start and exits non-zero', async () => {
    const ctx = new Context()
    const terminal = fakeTerminal({})
    internals.createTerminal = () => terminal
    let reported = ''
    internals.output = { isTTY: false, write: (text: string) => { reported += text; return true } } as never
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    apply(ctx, OPTIONS)
    expect(await exited).toBe(1)
    expect(reported).toBe('dsh: factory exploded\n')
    expect(terminal.turns).toContain('close')
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error start failure', async () => {
    const ctx = new Context()
    internals.createTerminal = () => fakeTerminal({})
    let reported = ''
    internals.output = { isTTY: false, write: (text: string) => { reported += text; return true } } as never
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', { flush: () => Promise.resolve(true) } as never)
    const rejected = {
      then(_resolve: (value: never) => void, reject: (reason: unknown) => void): void { reject('nope') },
    }
    ctx.provide('agents', { create: () => rejected } as never)
    apply(ctx, OPTIONS)
    expect(await exited).toBe(1)
    expect(reported).toBe('dsh: nope\n')
    await ctx.fiber.dispose()
  })

  it('abandons the start when the tree is disposed during Loader settlement', async () => {
    const ctx = new Context()
    let exited = false
    internals.createTerminal = () => fakeTerminal({})
    internals.output = { isTTY: false, write: () => true } as never
    ctx.provide('appExit', () => { exited = true })
    const services = ctx.plugin((child: Context) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
      child.provide('sessions', {} as never)
      child.provide('agents', {} as never)
    })
    await services
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settlement } as never)
    apply(ctx, OPTIONS)
    await services.dispose()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('tui approvals', () => {
  /**
   * Ask the mounted answerer one approval question.
   * @param ctx - the context the frontend registered on.
   * @param request - the question to dispatch.
   * @returns the settled outcome, or the unanswered fallback.
   */
  const ask = (ctx: Context, request: ApprovalRequest): Promise<ApprovalOutcome> =>
    ctx.waterfall('approval/request', request, () => Promise.resolve<ApprovalOutcome>('unavailable'))

  it('allows once on y and rejects on n', async () => {
    const test = await bench({
      reply(session, message, turn) { endTurn(session, turn, message, { kind: 'completed' }) },
    }, { lines: [], keys: ['y', 'n'], hold: true })
    await test.terminal.ready
    const agent = test.ctx.agents.roots()[0] as Agent
    expect(await ask(test.ctx, { agent, toolName: 'bash', reason: 'writes files' })).toBe('allowed-once')
    expect(await ask(test.ctx, { agent, toolName: 'bash' })).toBe('rejected')
    expect(test.terminal.output()).toContain('bash needs approval — writes files')
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('declines when this terminal cannot read a keypress', async () => {
    const test = await bench({
      reply(session, message, turn) { endTurn(session, turn, message, { kind: 'completed' }) },
    }, { lines: [], keys: [], hold: true })
    await test.terminal.ready
    const agent = test.ctx.agents.roots()[0] as Agent
    expect(await ask(test.ctx, { agent, toolName: 'bash' })).toBe('rejected')
    expect(test.terminal.output()).toContain('cannot read a keypress')
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('delegates a question owned by another agent', async () => {
    const test = await bench({
      reply(session, message, turn) { endTurn(session, turn, message, { kind: 'completed' }) },
    }, { lines: [], keys: ['y'], hold: true })
    await test.terminal.ready
    const outcome = await ask(test.ctx, { agent: {} as Agent, toolName: 'bash' })
    expect(outcome).toBe('unavailable')
    expect(test.terminal.output()).not.toContain('needs approval')
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })
})

describe('tui tool rendering', () => {
  /**
   * Append one settled tool call and its result to the drawn session.
   * @param session - the session the pair is appended to.
   * @param name - the called tool.
   * @param args - the raw JSON arguments as the log carries them.
   * @param text - the result's model-facing text.
   * @param isError - whether the outcome failed.
   */
  function callAndResult(
    session: Session,
    name: string,
    args: string,
    text: string,
    isError = false,
  ): void {
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name, arguments: args })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text }],
        isError,
      }),
    }, { surfaceOp: 'append' })
  }

  it('draws a call and its result through the tool\'s own render intent', async () => {
    const test = await bench({
      tools: [defineTool({
        name: 'shell',
        description: 'run a command',
        parameters: { command: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ignored'),
        presentCall: args => ({ card: 'terminal', title: args.command }),
        presentResult: () => ({ card: 'terminal', output: 'drawn output', exitCode: 3 }),
      })],
      reply(session, message, turn) {
        callAndResult(session, 'shell', '{"command":"ls -la"}', 'model text')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    const out = test.terminal.output()
    expect(out).toContain('· ls -la')
    expect(out).toContain('exit 3')
    expect(out).toContain('drawn output')
    await test.ctx.fiber.dispose()
  })

  it('hands a result\'s durable presentation metadata to its presenter', async () => {
    let seen: unknown
    const test = await bench({
      tools: [defineTool({
        name: 'meta',
        description: 'carries result metadata',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ignored'),
        presentResult: (_args, result) => {
          seen = result.meta
          return { card: 'generic', title: 'with meta' }
        },
      })],
      reply(session, message, turn) {
        session.append('tool/call', { turn, step: 1, callId: CallId('call-1'), name: 'meta', arguments: '{}' })
        session.append('tool/result', {
          turn,
          step: 1,
          message: createToolResultMessage({
            callId: CallId('call-1'),
            content: [{ type: 'text', text: 'x' }],
            isError: false,
          }),
          meta: { applied: 2 },
        }, { surfaceOp: 'append' })
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    expect(seen).toEqual({ applied: 2 })
    expect(test.terminal.output()).toContain('with meta')
    await test.ctx.fiber.dispose()
  })

  it('falls back to the tool\'s text when it declares no render intent', async () => {
    const test = await bench({
      tools: [defineTool({
        name: 'plain',
        description: 'no presenters',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ignored'),
      })],
      reply(session, message, turn) {
        callAndResult(session, 'plain', '{}', 'raw result text')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).toContain('· plain')
    expect(test.terminal.output()).toContain('raw result text')
    await test.ctx.fiber.dispose()
  })

  it('keeps drawing when a presenter throws', async () => {
    const test = await bench({
      tools: [defineTool({
        name: 'rogue',
        description: 'throwing presenters',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ignored'),
        presentCall: () => { throw new Error('presenter exploded') },
        presentResult: () => { throw new Error('presenter exploded') },
      })],
      reply(session, message, turn) {
        callAndResult(session, 'rogue', '{}', 'survived')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    const out = test.terminal.output()
    expect(out).toContain('· rogue')
    expect(out).toContain('survived')
    await test.ctx.fiber.dispose()
  })

  it('survives arguments the log cannot parse', async () => {
    const test = await bench({
      tools: [defineTool({
        name: 'plain',
        description: 'no presenters',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('ignored'),
      })],
      reply(session, message, turn) {
        callAndResult(session, 'plain', 'not json', 'still drawn')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).toContain('still drawn')
    await test.ctx.fiber.dispose()
  })

  it('draws an unpaired result from its own text', async () => {
    const test = await bench({
      reply(session, message, turn) {
        session.append('tool/result', {
          turn, step: 1,
          message: createToolResultMessage({
            callId: CallId('orphan'),
            content: [{ type: 'text', text: 'orphan output' }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).toContain('orphan output')
    await test.ctx.fiber.dispose()
  })

  it('draws nothing for a result carrying no outcome block', async () => {
    const test = await bench({
      reply(session, message, turn) {
        session.append('tool/result', {
          turn, step: 1,
          message: { role: 'user', id: 'm', content: [], source: { kind: 'tool', callId: 'c' } },
        } as never, { surfaceOp: 'append' })
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['run it'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).not.toContain('failed')
    await test.ctx.fiber.dispose()
  })
})

describe('tui command plane', () => {
  /**
   * One command that records that it ran and reports a fixed outcome.
   * @param name - the registered command name.
   * @param ran - collects each invocation's raw input.
   * @returns the definition.
   */
  const recording = (name: string, ran: string[]): CommandDefinition => ({
    name,
    description: `run ${name}`,
    handler: (invocation) => {
      ran.push(invocation.rawInput)
      return { kind: 'success', text: `${name} ran` }
    },
  })

  it('runs a registered command without spending a model turn', async () => {
    const ran: string[] = []
    let turns = 0
    const test = await bench({
      commands: [recording('compact', ran)],
      reply: () => { turns++ },
    }, { lines: ['/compact now'] })
    expect(await test.exited).toBe(0)
    expect(ran).toEqual([' now'])
    expect(turns).toBe(0)
    expect(test.terminal.output()).toContain('compact ran')
    await test.ctx.fiber.dispose()
  })

  it('lists the roster for /help', async () => {
    const test = await bench({
      commands: [recording('compact', [])],
    }, { lines: ['/help'] })
    expect(await test.exited).toBe(0)
    const out = test.terminal.output()
    expect(out).toContain('/compact')
    expect(out).toContain('/exit')
    expect(out).toContain('/help')
    await test.ctx.fiber.dispose()
  })

  it('lets a registered help command win over the built-in listing', async () => {
    const ran: string[] = []
    const test = await bench({
      commands: [recording('help', ran)],
    }, { lines: ['/help'] })
    expect(await test.exited).toBe(0)
    expect(ran).toEqual([''])
    expect(test.terminal.output()).toContain('help ran')
    await test.ctx.fiber.dispose()
  })

  it('reports an unresolved slash line instead of prompting the model', async () => {
    let turns = 0
    const test = await bench({
      commands: [recording('compact', [])],
      reply: () => { turns++ },
    }, { lines: ['/copmact'] })
    expect(await test.exited).toBe(0)
    expect(turns).toBe(0)
    expect(test.terminal.output()).toContain('unknown command: /copmact')
    await test.ctx.fiber.dispose()
  })

  it('lists only its own names when no command registry is composed', async () => {
    const test = await bench({}, { lines: ['/help'] })
    expect(await test.exited).toBe(0)
    const out = test.terminal.output()
    expect(out).toContain('/exit')
    expect(out).toContain('/help')
    expect(out).not.toContain('/compact')
    await test.ctx.fiber.dispose()
  })

  it('draws a failing command\'s reported reason', async () => {
    const test = await bench({
      commands: [{
        name: 'goal',
        description: 'set the objective',
        handler: () => ({ kind: 'error', text: 'no goal is set' }),
      }],
    }, { lines: ['/goal'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).toContain('no goal is set')
    await test.ctx.fiber.dispose()
  })

  it('leaves on /exit without consulting the registry', async () => {
    const ran: string[] = []
    const test = await bench({ commands: [recording('exit', ran)] }, { lines: ['/exit'] })
    expect(await test.exited).toBe(0)
    expect(ran).toEqual([])
    await test.ctx.fiber.dispose()
  })

  it.each([
    [new Error('registry exploded'), 'registry exploded'],
    ['registry exploded', 'registry exploded'],
  ])('reports a dispatch that rejects %#', async (reason, expected) => {
    const test = await bench({ rejectingCommands: reason }, { lines: ['/anything'] })
    expect(await test.exited).toBe(0)
    expect(test.terminal.output()).toContain(expected)
    await test.ctx.fiber.dispose()
  })

  it('interrupts a running command from the same key', async () => {
    let aborted = false
    const test = await bench({
      commands: [{
        name: 'slow',
        description: 'never settles on its own',
        handler: invocation => new Promise((resolve) => {
          invocation.signal.addEventListener('abort', () => {
            aborted = true
            resolve({ kind: 'error', text: 'cancelled' })
          })
        }),
      }],
    }, { lines: ['/slow'] })
    await test.terminal.began
    test.terminal.interrupt()
    expect(await test.exited).toBe(0)
    expect(aborted).toBe(true)
    await test.ctx.fiber.dispose()
  })
})

describe('tui session selection', () => {
  /**
   * One listed session in the bench's working directory.
   * @param id - the session id.
   * @param createdAt - creation time in epoch milliseconds.
   * @param title - the recorded title, when it has one.
   * @returns the listed entry.
   */
  const listed = (id: string, createdAt: number, title?: string): { header: SessionHeader; title?: string } => ({
    header: { version: 0, id: id as SessionId, createdAt, cwd: '/workspace' },
    ...title === undefined ? {} : { title },
  })

  it('starts a fresh session by default', async () => {
    const test = await bench({ sessions: [listed('old', 1)] }, { lines: [] })
    expect(await test.exited).toBe(0)
    expect(test.resumedSession()).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('attaches to the most recent session for a latest request', async () => {
    const test = await bench({
      sessions: [listed('older', 1), listed('newest', 9)],
      options: { resume: { kind: 'latest' } },
    }, { lines: [] })
    expect(await test.exited).toBe(0)
    expect(test.resumedSession()).toBe('newest')
    expect(test.terminal.output()).toContain('resumed newest')
    await test.ctx.fiber.dispose()
  })

  it('attaches to one named session', async () => {
    const test = await bench({
      sessions: [listed('older', 1), listed('newest', 9)],
      options: { resume: { kind: 'session', sessionId: 'older' } },
    }, { lines: [] })
    expect(await test.exited).toBe(0)
    expect(test.resumedSession()).toBe('older')
    await test.ctx.fiber.dispose()
  })

  it('fails loud when the named session is absent', async () => {
    const test = await bench({
      sessions: [listed('older', 1)],
      options: { resume: { kind: 'session', sessionId: 'ghost' } },
    }, { lines: [] })
    expect(await test.exited).toBe(1)
    expect(test.resumedSession()).toBeUndefined()
    await test.ctx.fiber.dispose()
  })

  it('offers the picker and attaches to the chosen number', async () => {
    const test = await bench({
      sessions: [listed('older', 1, 'Earlier work'), listed('newest', 9, 'Latest work')],
      options: { resume: { kind: 'pick' } },
    }, { lines: ['2'] })
    expect(await test.exited).toBe(0)
    const out = test.terminal.output()
    expect(out).toContain('Resume which session?')
    expect(out).toContain('Latest work')
    expect(out).toContain('Earlier work')
    expect(test.resumedSession()).toBe('older')
    await test.ctx.fiber.dispose()
  })

  it('starts a fresh session when the picker answer selects none', async () => {
    const test = await bench({
      sessions: [listed('older', 1)],
      options: { resume: { kind: 'pick' } },
    }, { lines: ['nope'] })
    expect(await test.exited).toBe(0)
    expect(test.resumedSession()).toBeUndefined()
    expect(test.terminal.output()).toContain('starting a new session')
    await test.ctx.fiber.dispose()
  })

  it('reports that no earlier session exists in this directory', async () => {
    const test = await bench({
      sessions: [],
      options: { resume: { kind: 'latest' } },
    }, { lines: [] })
    expect(await test.exited).toBe(0)
    expect(test.resumedSession()).toBeUndefined()
    expect(test.terminal.output()).toContain('no earlier session in this directory')
    await test.ctx.fiber.dispose()
  })

  it('reports that history is unavailable when no query service is composed', async () => {
    const test = await bench({ options: { resume: { kind: 'latest' } } }, { lines: [] })
    expect(await test.exited).toBe(0)
    expect(test.resumedSession()).toBeUndefined()
    expect(test.terminal.output()).toContain('no session history is available here')
    await test.ctx.fiber.dispose()
  })
})

describe('tui user questions', () => {
  it('asks each question on the terminal and returns the typed answers', async () => {
    // The conversation's own read stays held, so the two answers below are the
    // next lines the provider reads, in order.
    const test = await bench({ userQuestions: true }, { lines: ['2', 'widget'], hold: true })
    await test.terminal.ready
    const questions = test.ctx.get('userQuestions')
    if (questions === undefined) throw new Error('user-questions seam did not mount')
    const asked = questions.ask({
      questions: [
        {
          id: 'db',
          question: 'Which database?',
          options: [{ label: 'Postgres' }, { label: 'Redis' }],
        },
        { id: 'name', question: 'Name it?' },
      ],
    })
    expect(await asked).toEqual({
      answers: [
        { id: 'db', selected: ['Redis'] },
        { id: 'name', selected: [], custom: 'widget' },
      ],
    })
    expect(test.terminal.output()).toContain('Which database?')
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('skips every question when the terminal cannot be read', async () => {
    const test = await bench({ userQuestions: true }, { lines: [], hold: true })
    await test.terminal.ready
    const questions = test.ctx.get('userQuestions')
    if (questions === undefined) throw new Error('user-questions seam did not mount')
    const asked = questions.ask({ questions: [{ id: 'db', question: 'Which database?' }] })
    test.terminal.release()
    expect(await asked).toEqual({ answers: [{ id: 'db', selected: [] }] })
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })
})

describe('tui message composition', () => {
  it('joins backslash-continued lines into one message', async () => {
    const sent: string[] = []
    const test = await bench({
      reply(session, message, turn) {
        const [block] = message.content
        sent.push(block?.type === 'text' ? block.text : '')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['first \\', 'second \\', 'third'] })
    expect(await test.exited).toBe(0)
    expect(sent).toEqual(['first \nsecond \nthird'])
    await test.ctx.fiber.dispose()
  })

  it('submits what was typed when input ends mid-composition', async () => {
    const sent: string[] = []
    const test = await bench({
      reply(session, message, turn) {
        const [block] = message.content
        sent.push(block?.type === 'text' ? block.text : '')
        endTurn(session, turn, message, { kind: 'completed' })
      },
    }, { lines: ['orphaned \\'] })
    expect(await test.exited).toBe(0)
    // The submitted message is trimmed, as every submitted line is.
    expect(sent).toEqual(['orphaned'])
    await test.ctx.fiber.dispose()
  })

  it('completes an @path against the session directory', async () => {
    const test = await bench({}, { lines: [], hold: true })
    await test.terminal.ready
    test.ctx.provide('fs', {
      resolve: (path: string) => Promise.resolve({ path }),
      listDir: () => Promise.resolve([
        { name: 'index.ts', type: 'file' },
        { name: 'nested', type: 'directory' },
      ]),
    } as never)
    const complete = test.terminalOptions().complete
    if (complete === undefined) throw new Error('the frontend installed no completer')
    expect(await complete('read @n')).toEqual([['@nested/'], '@n'])
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('offers nothing when no filesystem provider is composed', async () => {
    const test = await bench({}, { lines: [], hold: true })
    await test.terminal.ready
    const complete = test.terminalOptions().complete
    if (complete === undefined) throw new Error('the frontend installed no completer')
    expect(await complete('read @src/')).toEqual([[], '@src/'])
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('leaves a line carrying no marker untouched', async () => {
    const test = await bench({}, { lines: [], hold: true })
    await test.terminal.ready
    const complete = test.terminalOptions().complete
    if (complete === undefined) throw new Error('the frontend installed no completer')
    expect(await complete('ordinary text')).toEqual([[], 'ordinary text'])
    test.terminal.release()
    expect(await test.exited).toBe(0)
    await test.ctx.fiber.dispose()
  })
})
