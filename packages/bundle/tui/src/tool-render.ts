/**
 * Terminal rendering for tool cards. A tool declares its render intent through
 * `presentCall`/`presentResult`; this module is the one place that turns those
 * `card`-tagged views into lines for this surface.
 *
 * Rendering is a pure function of the view plus the deployment's output bounds:
 * it reads no session state and performs no IO, so a redraw and a replay
 * produce the same lines. Every result is bounded before it reaches the
 * terminal, because a tool result carries no size promise of its own.
 * @module @deepseek-ai/dsh-tui/tool-render
 */

import { assertNever } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { TerminalStyle } from './terminal.ts'

/** How much of one tool result this terminal draws. */
export interface OutputBounds {
  /** Maximum drawn lines; further lines are replaced by a count notice. */
  maxLines: number
  /** Maximum drawn characters, applied after the line bound. */
  maxChars: number
}

/** The completed outcome a result view is rendered against. */
export interface RenderedResult {
  /** Model-facing content the tool returned. */
  content: readonly ContentBlock[]
  /** Whether the registry classified this outcome as a failure. */
  isError: boolean
}

/** Lines a bounded render kept, plus what it dropped. */
interface Bounded {
  text: string
  droppedLines: number
  truncatedChars: boolean
}

/**
 * Join the text blocks of one content list, ignoring non-text blocks that this
 * surface has no cell for.
 * @param content - the tool's model-facing content.
 * @returns the concatenated text, which may be empty.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * Bound one rendered body to the deployment's limits.
 * @param body - the unbounded text.
 * @param bounds - the deployment's output limits.
 * @returns the kept text and what the bound removed.
 */
function bound(body: string, bounds: OutputBounds): Bounded {
  const lines = body.split('\n')
  const kept = lines.slice(0, bounds.maxLines)
  const droppedLines = lines.length - kept.length
  let text = kept.join('\n')
  const truncatedChars = text.length > bounds.maxChars
  if (truncatedChars) text = text.slice(0, bounds.maxChars)
  return { text, droppedLines, truncatedChars }
}

/**
 * Indent every line of a body so it reads as belonging to its call.
 * @param body - the text to indent.
 * @returns the indented text, without a trailing newline.
 */
function indent(body: string): string {
  return body.split('\n').map(line => `    ${line}`).join('\n')
}

/**
 * Render one bounded body under its heading.
 * @param heading - the already-styled first line, without a newline.
 * @param body - the unbounded body, which may be empty.
 * @param bounds - the deployment's output limits.
 * @param style - styling helpers for the active stream.
 * @returns the complete block, newline-terminated.
 */
function block(heading: string, body: string, bounds: OutputBounds, style: TerminalStyle): string {
  if (body === '') return `${heading}\n`
  const { text, droppedLines, truncatedChars } = bound(body, bounds)
  const notices: string[] = []
  if (droppedLines > 0) notices.push(`+${droppedLines} more line${droppedLines === 1 ? '' : 's'}`)
  if (truncatedChars) notices.push('truncated')
  const tail = notices.length === 0 ? '' : `\n${indent(style.dim(`… ${notices.join(', ')}`))}`
  return `${heading}\n${indent(text)}${tail}\n`
}

/**
 * Summarise one file change without computing a diff: the line counts either
 * side of the change are derivable from the view and enough to orient a reader.
 * @param path - the changed file.
 * @param oldText - the prior content, or null for a created file.
 * @param newText - the content after the change.
 * @returns the one-line summary.
 */
function diffLine(path: string, oldText: string | null, newText: string): string {
  const after = newText.split('\n').length
  if (oldText === null) return `+ ${path} (${after} lines)`
  return `~ ${path} (${oldText.split('\n').length} → ${after} lines)`
}

/**
 * Render the pending line for one tool call.
 * @param view - the tool's declared call intent, if it has one.
 * @param name - the registered tool name, used when no view names the call.
 * @param style - styling helpers for the active stream.
 * @returns the announcement line, newline-terminated.
 */
export function formatCall(view: ToolCallView | undefined, name: string, style: TerminalStyle): string {
  if (view === undefined) return style.dim(`  · ${name}\n`)
  switch (view.card) {
    case 'terminal': {
      const where = view.cwd === undefined ? '' : ` (in ${view.cwd})`
      return style.dim(`  · ${view.title}${where}\n`)
    }
    case 'diff': {
      const paths = view.diffs.map(diff => diff.path).join(', ')
      return style.dim(`  · ${view.title}${paths === '' ? '' : ` — ${paths}`}\n`)
    }
    case 'generic':
      return style.dim(`  · ${view.title}\n`)
    default:
      return assertNever(view, 'formatCall')
  }
}

/**
 * Render one search result view.
 * @param view - the search view.
 * @param bounds - the deployment's output limits.
 * @param style - styling helpers for the active stream.
 * @returns the complete block, newline-terminated.
 */
function formatSearch(
  view: Extract<ToolResultView, { card: 'search' }>,
  bounds: OutputBounds,
  style: TerminalStyle,
): string {
  const capped = view.truncated ? ' (capped)' : ''
  if (view.shape === 'paths') {
    const heading = style.dim(`    ${view.total} path${view.total === 1 ? '' : 's'}${capped}`)
    return block(heading, view.paths.join('\n'), bounds, style)
  }
  const heading = style.dim(
    `    ${view.total} match${view.total === 1 ? '' : 'es'} in ${view.files.length} file${view.files.length === 1 ? '' : 's'}${capped}`,
  )
  const body = view.files
    .flatMap(file => file.matches.map(match => `${file.path}:${match.lineNumber}: ${match.line}`))
    .join('\n')
  return block(heading, body, bounds, style)
}

/**
 * Render one web result view.
 * @param view - the web view.
 * @param bounds - the deployment's output limits.
 * @param style - styling helpers for the active stream.
 * @returns the complete block, newline-terminated.
 */
function formatWeb(
  view: Extract<ToolResultView, { card: 'web' }>,
  bounds: OutputBounds,
  style: TerminalStyle,
): string {
  if (view.kind === 'fetch') {
    return style.dim(`    ${view.url} (${view.statusCode})${view.truncated ? ' — truncated' : ''}\n`)
  }
  const heading = style.dim(`    ${view.sources.length} source${view.sources.length === 1 ? '' : 's'}${view.truncated ? ' (capped)' : ''}`)
  const body = view.sources.map(source => `${source.title ?? source.url}\n  ${source.url}`).join('\n')
  return block(heading, body, bounds, style)
}

/**
 * Render the completed block for one tool result.
 *
 * A tool that declares no result intent falls back to its model-facing text, so
 * every call this terminal announced also shows what it produced.
 * @param view - the tool's declared result intent, if it has one.
 * @param result - the completed outcome the registry normalized.
 * @param bounds - the deployment's output limits.
 * @param style - styling helpers for the active stream.
 * @returns the complete block, newline-terminated, or the empty string when there is nothing to draw.
 */
export function formatResult(
  view: ToolResultView | undefined,
  result: RenderedResult,
  bounds: OutputBounds,
  style: TerminalStyle,
): string {
  /**
   * Compose one result heading from its optional label.
   * @param label - what this outcome is, or the empty string for an unlabelled one.
   * @returns the styled heading line.
   */
  const heading = (label: string): string =>
    result.isError ? style.accent(`    failed${label === '' ? '' : `: ${label}`}`) : style.dim(`    ${label}`)

  if (view === undefined) {
    const body = textOf(result.content)
    // A silent success has nothing a reader needs; a silent failure still does.
    if (body === '' && !result.isError) return ''
    return block(heading(''), body, bounds, style)
  }
  switch (view.card) {
    case 'terminal': {
      const exit = view.exitCode === undefined || view.exitCode === 0 ? '' : `exit ${view.exitCode}`
      const signal = view.signal === undefined ? '' : `signal ${view.signal}`
      return block(heading([exit, signal].filter(part => part !== '').join(', ')), view.output ?? '', bounds, style)
    }
    case 'diff': {
      const body = view.diffs.map(diff => diffLine(diff.path, diff.oldText, diff.newText)).join('\n')
      return block(heading(view.title ?? 'changed'), body, bounds, style)
    }
    case 'read': {
      const last = view.offset + view.lines.length
      return `${heading(`${view.path} (lines ${view.offset + 1}\u2013${last} of ${view.totalLines})`)}\n`
    }
    case 'search':
      return formatSearch(view, bounds, style)
    case 'web':
      return formatWeb(view, bounds, style)
    case 'generic': {
      // A generic card may carry only a title; its tool's own text is then the
      // only body there is, and dropping it would hide a failure's explanation.
      const body = view.content === undefined ? textOf(result.content) : textOf(view.content)
      return block(heading(view.title ?? ''), body, bounds, style)
    }
    default:
      return assertNever(view, 'formatResult')
  }
}
