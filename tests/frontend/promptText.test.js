import { describe, expect, test } from 'bun:test'
import {
  appendAtEnd,
  defaultPromptText,
  insertAtCursor,
  resolveInsertionPoint,
  truncatePreview,
} from '../../public/js/lib/promptText.js'

describe('truncatePreview', () => {
  test('returns short text unchanged', () => {
    expect(truncatePreview('short prompt')).toBe('short prompt')
  })

  test('truncates and appends an ellipsis past the max length', () => {
    const text = 'a'.repeat(60)
    const result = truncatePreview(text, 50)
    expect(result).toBe(`${'a'.repeat(50)}…`)
  })

  test('collapses newlines and repeated whitespace to single spaces', () => {
    expect(truncatePreview('line one\n\n  line two\tline three')).toBe('line one line two line three')
  })

  test('trims leading/trailing whitespace before measuring length', () => {
    expect(truncatePreview('   padded   ')).toBe('padded')
  })

  test('respects a custom maxLen', () => {
    expect(truncatePreview('abcdefghij', 5)).toBe('abcde…')
  })
})

describe('insertAtCursor', () => {
  test('inserts at the cursor position in the middle of text', () => {
    const { newText, newCursorPos } = insertAtCursor('hello world', 6, 6, 'brave new')
    expect(newText).toBe('hello brave new world')
    expect(newCursorPos).toBe(16)
  })

  test('inserts at the very end when the cursor is at the end', () => {
    const { newText, newCursorPos } = insertAtCursor('hello', 5, 5, 'world')
    expect(newText).toBe('hello world')
    expect(newCursorPos).toBe(11)
  })

  test('inserts into empty text with no padding', () => {
    const { newText, newCursorPos } = insertAtCursor('', 0, 0, 'snippet body')
    expect(newText).toBe('snippet body')
    expect(newCursorPos).toBe(12)
  })

  test('does not add a leading space when already preceded by whitespace', () => {
    const { newText } = insertAtCursor('hello \nworld', 7, 7, 'inserted')
    expect(newText).toBe('hello \ninserted world')
  })

  test('replaces a selection rather than inserting inside it', () => {
    const { newText, newCursorPos } = insertAtCursor('hello world', 0, 5, 'goodbye')
    expect(newText).toBe('goodbye world')
    expect(newCursorPos).toBe(7)
  })
})

describe('appendAtEnd', () => {
  test('appends directly with no leading newline when text is empty', () => {
    expect(appendAtEnd('', 'snippet body')).toBe('snippet body')
  })

  test('adds a separating newline when text does not end with one', () => {
    expect(appendAtEnd('write the fix', 'snippet body')).toBe('write the fix\nsnippet body')
  })

  test('does not double the newline when text already ends with one', () => {
    expect(appendAtEnd('write the fix\n', 'snippet body')).toBe('write the fix\nsnippet body')
  })
})

describe('resolveInsertionPoint', () => {
  test('falls back to the end when selection is 0/0 on non-empty text', () => {
    expect(resolveInsertionPoint('existing prompt', 0, 0)).toEqual({ start: 15, end: 15 })
  })

  test('keeps 0/0 as-is when the text is empty (nothing to fall back past)', () => {
    expect(resolveInsertionPoint('', 0, 0)).toEqual({ start: 0, end: 0 })
  })

  test('leaves a genuine non-zero cursor position untouched', () => {
    expect(resolveInsertionPoint('hello world', 5, 5)).toEqual({ start: 5, end: 5 })
  })

  test('leaves a genuine non-zero selection range untouched', () => {
    expect(resolveInsertionPoint('hello world', 0, 5)).toEqual({ start: 0, end: 5 })
  })
})

describe('defaultPromptText', () => {
  test('タイトル、空行、詳細の順', () => {
    expect(defaultPromptText({ title: 'T', description: '  詳細\n' })).toBe('T\n\n詳細')
  })

  test('詳細が空ならタイトルだけ', () => {
    expect(defaultPromptText({ title: 'T', description: '  ' })).toBe('T')
    expect(defaultPromptText({ title: 'T', description: null })).toBe('T')
  })
})
