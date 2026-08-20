/** The terminal IO layer: styling, line input, raw single-key reading, and running-mode lifecycle. */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createStyle, createTerminal, toReadlineCompleter } from '../src/terminal.ts'
import type { TerminalIo, TerminalOptions } from '../src/terminal.ts'

/** Escape, the lead byte of the interrupt key and of every arrow sequence. */
const ESC = String.fromCharCode(0x1b)

/** End-of-text, what Ctrl+C sends while the stream is in raw mode. */
const ETX = String.fromCharCode(0x03)

/** A substituted stream pair plus the raw-mode transitions the terminal requested. */
interface Streams {
  input: TerminalOptions['input']
  output: TerminalOptions['output']
  /** Everything written to the output stream, in order. */
  written(): string
  /** Every `setRawMode` argument, in call order. */
  rawModes: boolean[]
  /**
   * Current `data` listener count. readline keeps one of its own, so callers
   * compare against the count observed while no turn runs.
   */
  dataListeners(): number
}

/**
 * Build substituted streams for one terminal.
 * @param tty - whether the input reports a TTY and offers `setRawMode`.
 * @returns the streams plus the observations the assertions read.
 */
function streams(tty: boolean): Streams {
  const input = new PassThrough()
  const output = new PassThrough()
  let out = ''
  output.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
  const rawModes: boolean[] = []
  if (tty) {
    Object.assign(input, { isTTY: true, setRawMode: (mode: boolean) => { rawModes.push(mode) } })
  }
  return {
    input,
    output,
    written: () => out,
    rawModes,
    dataListeners: () => input.listenerCount('data'),
  }
}

/**
 * Yield to the event loop so readline and stream listeners observe a write.
 * @returns a promise settled after the pending macrotask queue drains.
 */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createStyle', () => {
  it('is identity on an unstyled stream', () => {
    const style = createStyle(false)
    expect([style.dim('a'), style.bold('b'), style.accent('c')]).toEqual(['a', 'b', 'c'])
  })

  it('wraps each role in its own escape sequence on a styled stream', () => {
    const style = createStyle(true)
    expect(style.dim('a')).toBe(`${ESC}[2ma${ESC}[0m`)
    expect(style.bold('b')).toBe(`${ESC}[1mb${ESC}[0m`)
    expect(style.accent('c')).toBe(`${ESC}[36mc${ESC}[0m`)
  })
})

describe('createTerminal', () => {
  it('reports a TTY that can switch raw mode as interactive', () => {
    const io = createTerminal(streams(true))
    expect(io.interactive).toBe(true)
    io.close()
  })

  it('installs a completer when one is supplied', async () => {
    const pair = streams(false)
    const io = createTerminal({ ...pair, complete: () => Promise.resolve([[], '']) })
    const line = io.readLine('> ')
    await settle();
    (pair.input as unknown as PassThrough).write('typed\n')
    expect(await line).toBe('typed')
    io.close()
  })

  it('reports a piped stream as non-interactive', () => {
    const io = createTerminal(streams(false))
    expect(io.interactive).toBe(false)
    io.close()
  })

  it('writes rendered text through unchanged', async () => {
    const pair = streams(false)
    const io = createTerminal(pair)
    io.write('hello')
    await settle()
    expect(pair.written()).toContain('hello')
    io.close()
  })

  it('resolves a submitted line', async () => {
    const pair = streams(false)
    const io = createTerminal(pair)
    const line = io.readLine('> ')
    await settle();
    (pair.input as unknown as PassThrough).write('typed\n')
    expect(await line).toBe('typed')
    io.close()
  })

  it('resolves an ended input stream as undefined rather than hanging', async () => {
    const pair = streams(false)
    const io = createTerminal(pair)
    const line = io.readLine('> ')
    await settle();
    (pair.input as unknown as PassThrough).end()
    expect(await line).toBeUndefined()
    io.close()
  })

  it('declines single-key reading outside a running turn', async () => {
    const io = createTerminal(streams(true))
    expect(await io.readKey(['y', 'n'])).toBeUndefined()
    io.close()
  })

  it('declines single-key reading on a stream that cannot report a keypress', async () => {
    const io = createTerminal(streams(false))
    io.beginTurn(() => {})
    expect(await io.readKey(['y', 'n'])).toBeUndefined()
    io.endTurn()
    io.close()
  })

  it('resolves the matched key, lowercased, while a turn runs', async () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    io.beginTurn(() => {})
    const key = io.readKey(['y', 'n'])
    await settle();
    (pair.input as unknown as PassThrough).write('Y')
    expect(await key).toBe('y')
    io.endTurn()
    io.close()
  })

  it('ignores keys outside the offered set and keeps waiting', async () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    io.beginTurn(() => {})
    const key = io.readKey(['y', 'n'])
    let settled = false
    void key.then(() => { settled = true })
    await settle();
    (pair.input as unknown as PassThrough).write('q')
    await settle()
    expect(settled).toBe(false);
    (pair.input as unknown as PassThrough).write('n')
    expect(await key).toBe('n')
    io.endTurn()
    io.close()
  })

  it('reads a key from a stream that emits decoded strings', async () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    io.beginTurn(() => {})
    const key = io.readKey(['y'])
    await settle()
    // A stream with an encoding set delivers strings rather than Buffers; the
    // watcher accepts both, so the decoded form is exercised here.
    ;(pair.input as unknown as PassThrough).emit('data', 'y')
    expect(await key).toBe('y')
    io.endTurn()
    io.close()
  })

  it('interrupts on Esc and on Ctrl+C while running', async () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    let interrupts = 0
    io.beginTurn(() => { interrupts++ })
    await settle();
    (pair.input as unknown as PassThrough).write(ESC)
    await settle();
    (pair.input as unknown as PassThrough).write(ETX)
    await settle()
    expect(interrupts).toBe(2)
    io.endTurn()
    io.close()
  })

  // readline drives raw mode for its own line editing, so these assert the
  // terminal's own watcher and the resulting mode, not the exact call log.
  it('watches raw keys once per turn and stops watching on end', () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    const idle = pair.dataListeners()
    io.beginTurn(() => {})
    io.beginTurn(() => {})
    expect(pair.dataListeners()).toBe(idle + 1)
    expect(pair.rawModes.at(-1)).toBe(true)
    io.endTurn()
    expect(pair.dataListeners()).toBe(idle)
    expect(pair.rawModes.at(-1)).toBe(false)
    io.close()
  })

  it('leaves running mode idempotently', () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    const idle = pair.dataListeners()
    io.endTurn()
    io.beginTurn(() => {})
    io.endTurn()
    io.endTurn()
    expect(pair.dataListeners()).toBe(idle)
    expect(pair.rawModes.at(-1)).toBe(false)
    io.close()
  })

  it('resolves a pending key read as undefined when the turn ends first', async () => {
    const pair = streams(true)
    const io = createTerminal(pair)
    io.beginTurn(() => {})
    const key = io.readKey(['y'])
    io.endTurn()
    expect(await key).toBeUndefined()
    io.close()
  })

  it('does not touch raw mode on a non-TTY turn', () => {
    const pair = streams(false)
    const io = createTerminal(pair)
    io.beginTurn(() => {})
    io.endTurn()
    expect(pair.rawModes).toEqual([])
    io.close()
  })

  it('leaves running mode when closed mid-turn', () => {
    const pair = streams(true)
    const io: TerminalIo = createTerminal(pair)
    const idle = pair.dataListeners()
    io.beginTurn(() => {})
    io.close()
    expect(pair.dataListeners()).toBe(idle)
    expect(pair.rawModes.at(-1)).toBe(false)
  })
})

describe('toReadlineCompleter', () => {
  /**
   * Collect the one result readline's callback receives.
   * @param completer - the adapted completer to drive.
   * @param line - the line being completed.
   * @returns the delivered result.
   */
  const settle = (
    completer: ReturnType<typeof toReadlineCompleter>,
    line: string,
  ): Promise<[string[], string]> => new Promise((resolve) => {
    completer(line, (_error, result) => { resolve(result) })
  })

  it('delivers the completer\'s candidates', async () => {
    const completer = toReadlineCompleter(() => Promise.resolve([['@a.ts'], '@a']))
    expect(await settle(completer, 'read @a')).toEqual([['@a.ts'], '@a'])
  })

  it('delivers no candidates when the listing fails', async () => {
    const completer = toReadlineCompleter(() => Promise.reject(new Error('unreadable')))
    expect(await settle(completer, 'read @a')).toEqual([[], 'read @a'])
  })
})
