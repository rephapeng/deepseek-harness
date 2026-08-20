/**
 * Composing one submitted message from typed lines: backslash continuation and
 * `@path` completion. Both are pure functions of the typed text, so the editor's
 * behaviour is exercised without a terminal and without a filesystem.
 *
 * Continuation is a trailing backslash rather than a paired fence because a
 * terminal reads one line at a time: the reader must decide whether to keep
 * reading from the line it already has, with no lookahead available.
 * @module @deepseek-ai/dsh-tui/compose
 */

/** What the caller must list to answer one `@path` completion. */
export interface CompletionRequest {
  /** Directory to list, exactly as typed, relative to the session's cwd. */
  readonly dir: string
  /** Partial basename being completed; the empty string lists the directory. */
  readonly partial: string
  /** The complete `@`-token as typed, which a candidate replaces. */
  readonly token: string
}

/** A directory child, reduced to what completion needs. */
export interface CompletionEntry {
  /** Basename inside the listed directory. */
  readonly name: string
  /** Whether the child can be descended into. */
  readonly type: 'file' | 'directory' | 'other'
}

/**
 * Decide whether a typed line continues into the next one.
 *
 * One trailing backslash continues; a doubled backslash is the escape for a
 * literal trailing backslash and ends the message, so a line can still end in
 * that character.
 * @param line - the submitted line.
 * @returns the line's content without its continuation marker, or undefined when the message ends here.
 */
export function continuationOf(line: string): string | undefined {
  const trailing = /\\+$/u.exec(line)
  if (trailing === null || trailing[0].length % 2 === 0) return undefined
  return line.slice(0, -1)
}

/**
 * Join the composed lines into the submitted message.
 *
 * A doubled trailing backslash collapses to the single literal character it
 * escaped, which is the only place composition rewrites what was typed.
 * @param parts - the lines in submission order.
 * @returns the complete message.
 */
export function joinComposed(parts: readonly string[]): string {
  return parts.map(part => part.replace(/\\\\$/u, '\\')).join('\n')
}

/**
 * Locate the `@path` token the cursor sits in, if any.
 *
 * Completion applies only to an `@` that opens a word, so an email address or a
 * decorator inside a word is left alone.
 * @param line - the line up to the cursor.
 * @returns what to list, or undefined when the cursor is not inside an `@path` token.
 */
export function completionRequest(line: string): CompletionRequest | undefined {
  const match = /(?:^|\s)@\S*$/u.exec(line)
  if (match === null) return undefined
  // The match starts at the line start or at the separating whitespace, so the
  // first `@` at or after it opens the token.
  const whole = line.slice(line.indexOf('@', match.index))
  const typed = whole.slice(1)
  const cut = typed.lastIndexOf('/')
  return cut === -1
    ? { dir: '.', partial: typed, token: whole }
    : {
      dir: typed.slice(0, cut) === '' ? '/' : typed.slice(0, cut),
      partial: typed.slice(cut + 1),
      token: whole,
    }
}

/**
 * Build the replacements one listing offers, directories first and trailing `/`
 * so the next keystroke descends without retyping the separator.
 * @param request - what was listed.
 * @param entries - the directory's children.
 * @returns the candidate token texts, in offer order.
 */
export function completionsFor(
  request: CompletionRequest,
  entries: readonly CompletionEntry[],
): string[] {
  const prefix = request.dir === '.' ? '' : `${request.dir.replace(/\/$/u, '')}/`
  return entries
    .filter(entry => entry.name.startsWith(request.partial))
    .sort((left, right) => {
      if ((left.type === 'directory') !== (right.type === 'directory')) return left.type === 'directory' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    .map(entry => `@${prefix}${entry.name}${entry.type === 'directory' ? '/' : ''}`)
}
