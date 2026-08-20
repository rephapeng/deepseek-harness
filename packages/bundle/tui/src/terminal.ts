/**
 * The terminal frontend's IO layer: line input while idle, raw single-key
 * reading while a turn runs, and the styling helpers the frontend prints
 * through. It owns no Agent and no Cordis context, so the frontend's wiring
 * can be exercised against a substituted {@link TerminalIo}.
 *
 * Raw mode is entered only for the duration of a running turn, and only on a
 * TTY: a piped stdin cannot report a keypress, so interrupt and inline answers
 * degrade to "unavailable" rather than hanging on input that can never arrive.
 * @module @deepseek-ai/dsh-tui/terminal
 */

import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'

/** Escape, sent by the Esc key and as the lead byte of every arrow sequence. */
const KEY_ESCAPE = String.fromCharCode(0x1b)

/** End-of-text, sent by Ctrl+C while the input stream is in raw mode. */
const KEY_ETX = String.fromCharCode(0x03)

/** The frontend's IO surface; the process implementation is {@link createTerminal}. */
export interface TerminalIo {
  /** Write already-rendered text; no trailing newline is added. */
  write(text: string): void
  /**
   * Read one submitted line while idle.
   * @param prompt - text drawn before the cursor.
   * @returns the line, or `undefined` when the input stream ended.
   */
  readLine(prompt: string): Promise<string | undefined>
  /**
   * Read one key from a fixed set while a turn runs.
   * @param keys - lowercase single characters that settle the read.
   * @returns the matched key, or `undefined` when single-key reading is unavailable.
   */
  readKey(keys: readonly string[]): Promise<string | undefined>
  /**
   * Enter running mode: raw keys are watched and `onInterrupt` fires on Esc or Ctrl+C.
   * @param onInterrupt - called once per interrupt request.
   */
  beginTurn(onInterrupt: () => void): void
  /** Leave running mode and restore line editing. */
  endTurn(): void
  /** Whether this terminal can report a single keypress. */
  readonly interactive: boolean
  /** Release the input stream. */
  close(): void
}

/**
 * Offer completions for the text left of the cursor.
 * @param line - the line up to the cursor.
 * @returns the candidate replacements and the substring they replace.
 */
export type TerminalCompleter = (line: string) => Promise<[string[], string]>

/**
 * Adapt a completer to readline's callback shape.
 *
 * readline treats a thrown or rejected completer as a failure of the keypress,
 * so a failed listing settles as "no candidates" and leaves the typed line
 * exactly as it was.
 * @param complete - the completer to adapt.
 * @returns the callback-shaped completer readline installs.
 */
export function toReadlineCompleter(
  complete: TerminalCompleter,
): (line: string, callback: (error: null, result: [string[], string]) => void) => void {
  return (line, callback) => {
    void complete(line).then(
      (result) => { callback(null, result) },
      () => { callback(null, [[], line]) },
    )
  }
}

/** Streams and flags the terminal is built over; tests substitute all of them. */
export interface TerminalOptions {
  /** The input stream; raw mode is used only when it reports a TTY. */
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => void; isTTY?: boolean }
  /** The output stream every rendered line is written to. */
  output: NodeJS.WritableStream & { isTTY?: boolean }
  /** Tab completion; absent leaves the Tab key inserting whitespace. */
  complete?: TerminalCompleter
}

/** ANSI helpers, resolved once against the output stream. */
export interface TerminalStyle {
  /** De-emphasised text for transcript furniture. */
  dim(text: string): string
  /** Emphasised text for the speaker labels. */
  bold(text: string): string
  /** The one hue used for prompts and questions. */
  accent(text: string): string
}

/**
 * Build the styling helpers for a stream.
 * @param styled - whether to emit escape sequences at all.
 * @returns styling functions that are identity when styling is off.
 */
export function createStyle(styled: boolean): TerminalStyle {
  if (!styled) {
    const plain = (text: string): string => text
    return { dim: plain, bold: plain, accent: plain }
  }
  return {
    dim: text => `${KEY_ESCAPE}[2m${text}${KEY_ESCAPE}[0m`,
    bold: text => `${KEY_ESCAPE}[1m${text}${KEY_ESCAPE}[0m`,
    accent: text => `${KEY_ESCAPE}[36m${text}${KEY_ESCAPE}[0m`,
  }
}

/**
 * Create the process-backed terminal.
 * @param options - the streams this terminal reads and writes.
 * @returns the IO surface the frontend drives.
 */
export function createTerminal(options: TerminalOptions): TerminalIo {
  const { input, output, complete } = options
  const interactive = input.isTTY === true && typeof input.setRawMode === 'function'
  const rl: ReadlineInterface = createInterface({
    input,
    output,
    terminal: input.isTTY === true,
    ...complete === undefined ? {} : { completer: toReadlineCompleter(complete) },
  })

  let running = false
  let interruptHandler: (() => void) | undefined
  let pendingKey: { keys: readonly string[]; resolve: (key: string | undefined) => void } | undefined

  const onData = (data: Buffer | string): void => {
    const text = typeof data === 'string' ? data : data.toString('utf8')
    const waiting = pendingKey
    if (waiting !== undefined) {
      // Offered keys are single characters, so a case-folded containment test
      // settles the read without decomposing the chunk into code points.
      const lowered = text.toLowerCase()
      const match = waiting.keys.find(key => lowered.includes(key))
      if (match !== undefined) {
        pendingKey = undefined
        waiting.resolve(match)
        return
      }
    }
    if (text.includes(KEY_ESCAPE) || text.includes(KEY_ETX)) interruptHandler?.()
  }

  const leaveRunning = (): void => {
    if (!running) return
    running = false
    interruptHandler = undefined
    const waiting = pendingKey
    pendingKey = undefined
    waiting?.resolve(undefined)
    if (!interactive) return
    input.removeListener('data', onData)
    input.setRawMode?.(false)
    rl.resume()
  }

  return {
    interactive,

    write(text: string): void {
      output.write(text)
    },

    async readLine(prompt: string): Promise<string | undefined> {
      // Whichever of the two settles first wins: a second `resolve` on a
      // settled promise is a no-op, so neither path needs its own guard.
      return new Promise((resolve) => {
        const onClose = (): void => { resolve(undefined) }
        rl.once('close', onClose)
        rl.question(prompt, (line) => {
          rl.removeListener('close', onClose)
          resolve(line)
        })
      })
    },

    async readKey(keys: readonly string[]): Promise<string | undefined> {
      // Single-key reading rides the raw-mode stream that running mode owns.
      // Outside it — or on a stream that cannot report a keypress — the caller
      // gets `undefined` and decides, rather than waiting for input that can
      // never arrive.
      if (!interactive || !running) return undefined
      return new Promise((resolve) => {
        pendingKey = { keys, resolve }
      })
    },

    beginTurn(onInterrupt: () => void): void {
      if (running) return
      running = true
      interruptHandler = onInterrupt
      if (!interactive) return
      rl.pause()
      input.setRawMode?.(true)
      input.on('data', onData)
      // `rl.pause()` pauses the input stream itself, and an explicitly paused
      // stream does not re-enter flowing mode when a `data` listener is added.
      // Without this resume no keypress reaches `onData`, so neither the
      // interrupt nor an inline approval answer would ever arrive.
      input.resume()
    },

    endTurn(): void {
      leaveRunning()
    },

    close(): void {
      leaveRunning()
      rl.close()
    },
  }
}
