/**
 * Terminal presentation and answer parsing for `ctx.userQuestions`. The service
 * owns when a question is asked and who may ask it; this module owns only how
 * one question reads on this surface and how a typed line becomes an answer.
 *
 * Both halves are pure functions, so the drawn menu and the parsed answer can be
 * exercised without a terminal.
 * @module @deepseek-ai/dsh-tui/questions
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { TerminalStyle } from './terminal.ts'

/**
 * Render one question with its numbered options.
 * @param item - the question to draw.
 * @param style - styling helpers for the active stream.
 * @returns the question block, newline-terminated.
 */
export function formatQuestion(item: AskUserQuestionItem, style: TerminalStyle): string {
  const heading = item.header === undefined ? '' : `${style.dim(`  [${item.header}]`)}\n`
  const detail = item.detail === undefined ? '' : `${style.dim(`  ${item.detail}`)}\n`
  const options = item.options ?? []
  const rows = options.map((option, index) => {
    const description = option.description === undefined ? '' : ` ${style.dim(`— ${option.description}`)}`
    return `  ${String(index + 1).padStart(2)}. ${option.label}${description}`
  })
  const menu = rows.length === 0 ? '' : `${rows.join('\n')}\n`
  return `\n${heading}${style.bold(`  ${item.question}`)}\n${detail}${menu}`
}

/**
 * The prompt drawn under one question, naming what an answer may be.
 * @param item - the question being answered.
 * @param style - styling helpers for the active stream.
 * @returns the prompt text, without a newline.
 */
export function formatQuestionPrompt(item: AskUserQuestionItem, style: TerminalStyle): string {
  const options = item.options ?? []
  if (options.length === 0) return style.accent('  answer › ')
  const shape = item.multiSelect === true ? 'numbers, comma-separated' : 'number'
  return style.accent(`  ${shape}, or type your own › `)
}

/**
 * Turn one typed line into this question's answer.
 *
 * A line naming valid option numbers selects those labels; anything else is
 * kept verbatim as the custom answer, which is how a human says something the
 * option list did not anticipate. An empty line skips the question, preserving
 * the seam's `{ id, selected: [] }` shape rather than inventing a choice.
 * @param item - the question being answered.
 * @param line - the submitted line, or undefined when input ended.
 * @returns the answer item for this question.
 */
export function parseAnswer(item: AskUserQuestionItem, line: string | undefined): AskUserQuestionAnswerItem {
  const trimmed = line?.trim() ?? ''
  if (trimmed === '') return { id: item.id, selected: [] }
  const options = item.options ?? []
  const parts = trimmed.split(',').map(part => part.trim())
  const numbered = parts.every(part => /^[0-9]+$/u.test(part))
  const picks = numbered
    ? parts.map(part => Number.parseInt(part, 10)).filter(pick => pick >= 1 && pick <= options.length)
    : []
  // A numeric line that names no valid option is a mistyped selection, not a
  // free-text answer; treating it as custom would submit "7" as the reply.
  if (numbered && picks.length === 0) return { id: item.id, selected: [] }
  if (picks.length === 0) return { id: item.id, selected: [], custom: trimmed }
  const chosen = item.multiSelect === true ? picks : picks.slice(0, 1)
  const labels = [...new Set(chosen)].map(pick => options[pick - 1]?.label).filter(label => label !== undefined)
  return { id: item.id, selected: labels }
}
