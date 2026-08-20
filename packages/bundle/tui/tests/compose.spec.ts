/** Composing one message from typed lines: continuation, joining, and `@path` completion. */

import { describe, expect, it } from 'vitest'
import { completionRequest, completionsFor, continuationOf, joinComposed } from '../src/compose.ts'
import type { CompletionEntry } from '../src/compose.ts'

describe('continuationOf', () => {
  it('continues a line ending in one backslash', () => {
    expect(continuationOf('first \\')).toBe('first ')
  })

  it.each([
    ['plain line'],
    [''],
    ['ends in slash /'],
  ])('ends the message at %s', (line) => {
    expect(continuationOf(line)).toBeUndefined()
  })

  it('ends the message when the trailing backslash is escaped', () => {
    expect(continuationOf('literal \\\\')).toBeUndefined()
  })

  it('continues again when an escaped pair is followed by a marker', () => {
    expect(continuationOf('literal \\\\\\')).toBe('literal \\\\')
  })
})

describe('joinComposed', () => {
  it('joins the lines with newlines', () => {
    expect(joinComposed(['one', 'two', 'three'])).toBe('one\ntwo\nthree')
  })

  it('returns a single line unchanged', () => {
    expect(joinComposed(['only'])).toBe('only')
  })

  it('collapses an escaped trailing backslash to the literal character', () => {
    expect(joinComposed(['path C:\\\\'])).toBe('path C:\\')
  })
})

describe('completionRequest', () => {
  it('lists the working directory for a bare marker', () => {
    expect(completionRequest('read @')).toEqual({ dir: '.', partial: '', token: '@' })
  })

  it('completes a basename in the working directory', () => {
    expect(completionRequest('read @pack')).toEqual({ dir: '.', partial: 'pack', token: '@pack' })
  })

  it('completes inside a nested directory', () => {
    expect(completionRequest('see @src/lib/te'))
      .toEqual({ dir: 'src/lib', partial: 'te', token: '@src/lib/te' })
  })

  it('completes at the filesystem root', () => {
    expect(completionRequest('@/et')).toEqual({ dir: '/', partial: 'et', token: '@/et' })
  })

  it('completes a marker that opens the line', () => {
    expect(completionRequest('@a')).toEqual({ dir: '.', partial: 'a', token: '@a' })
  })

  it.each([
    ['no marker here'],
    ['mail me@example.com'],
    ['read @src/a.ts then'],
    [''],
  ])('offers nothing for %s', (line) => {
    expect(completionRequest(line)).toBeUndefined()
  })
})

describe('completionsFor', () => {
  const entries: CompletionEntry[] = [
    { name: 'index.ts', type: 'file' },
    { name: 'invariant.ts', type: 'file' },
    { name: 'inner', type: 'directory' },
    { name: 'other.ts', type: 'file' },
    { name: 'socket', type: 'other' },
  ]

  it('offers directories first, each ready to descend', () => {
    expect(completionsFor({ dir: '.', partial: 'in', token: '@in' }, entries))
      .toEqual(['@inner/', '@index.ts', '@invariant.ts'])
  })

  it('keeps the typed directory on every candidate', () => {
    expect(completionsFor({ dir: 'src/lib', partial: 'o', token: '@src/lib/o' }, entries))
      .toEqual(['@src/lib/other.ts'])
  })

  it('normalizes a directory the user typed with a trailing separator', () => {
    expect(completionsFor({ dir: 'src/', partial: 'o', token: '@src/o' }, entries))
      .toEqual(['@src/other.ts'])
  })

  it('offers every child for an empty partial', () => {
    expect(completionsFor({ dir: '.', partial: '', token: '@' }, entries))
      .toEqual(['@inner/', '@index.ts', '@invariant.ts', '@other.ts', '@socket'])
  })

  it.each([
    [[{ name: 'dir', type: 'directory' }, { name: 'file.ts', type: 'file' }] as CompletionEntry[]],
    [[{ name: 'file.ts', type: 'file' }, { name: 'dir', type: 'directory' }] as CompletionEntry[]],
  ])('puts the directory first whichever order it was listed in %#', (listed) => {
    expect(completionsFor({ dir: '.', partial: '', token: '@' }, listed))
      .toEqual(['@dir/', '@file.ts'])
  })

  it('offers nothing when no child matches', () => {
    expect(completionsFor({ dir: '.', partial: 'zzz', token: '@zzz' }, entries)).toEqual([])
  })
})
