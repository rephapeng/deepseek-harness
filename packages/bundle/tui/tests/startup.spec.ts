/**
 * The terminal app's command-line provider over a real Loader tree: an accepted
 * invocation publishes the startup service its consumer injects, while help and
 * usage errors leave that consumer pending so no terminal is ever attached.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, TUI_STARTUP_SERVICE } from '../src/startup.ts'
import type { TuiStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  /** Config the downstream consumer row received, proving the injection resolved. */
  frontendConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider under a Loader beneath a frontend stand-in.
 * @param args - the invocation's inner arguments.
 * @returns the published service value and the observed process effects.
 */
async function bootStartup(args: string[]): Promise<{ startup: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.frontendConfig = config }\n')
  // The Loader imports through Node's resolver, so this fixture delegates to
  // the source-plane plugin the test already imported.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-frontend',
    `  name: ${rowUrl}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    cwd: !!js ctx.tuiStartup.cwd',
    '    resume: !!js ctx.tuiStartup.resume',
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    startup: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('tui command-line provider', () => {
  it('publishes the working directory and a fresh-session request by default', async () => {
    const { startup, observed } = await bootStartup([])
    expect(startup).toEqual({ cwd: process.cwd(), resume: { kind: 'new' } })
    expect(observed.frontendConfig).toEqual({ cwd: process.cwd(), resume: { kind: 'new' } })
    expect(observed.exits).toEqual([])
  })

  it.each([
    [['--continue'], { kind: 'latest' }],
    [['--resume'], { kind: 'pick' }],
    [['--resume', 'session-7'], { kind: 'session', sessionId: 'session-7' }],
    [['-c'], { kind: 'latest' }],
  ])('resolves %s into a session request', async (args, resume) => {
    const { startup, observed } = await bootStartup(args)
    expect(startup).toEqual({ cwd: process.cwd(), resume })
    expect(observed.exits).toEqual([])
  })

  it('refuses an invocation naming both selection flags', async () => {
    const { startup, observed } = await bootStartup(['--resume', '--continue'])
    expect(startup).toBeUndefined()
    expect(observed.out).toContain('use one')
    expect(observed.exits).toEqual([1])
  })

  it('prints its own help and leaves the frontend pending', async () => {
    const { startup, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile tui')
    expect(observed.out).toContain('interrupt the running turn')
    expect(startup).toBeUndefined()
    expect(observed.frontendConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects an unknown flag without mounting the frontend', async () => {
    const { startup, observed } = await bootStartup(['--nope'])
    expect(observed.out).toContain('--nope')
    expect(startup).toBeUndefined()
    expect(observed.frontendConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
