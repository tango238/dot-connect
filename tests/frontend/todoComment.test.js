import { describe, expect, test } from 'bun:test'
import {
  MAX_COMMENT_LENGTH,
  commentDraftError,
  isCommentSubmitShortcut,
  normalizeCommentBody,
} from '../../public/js/lib/todoComment.js'

describe('normalizeCommentBody', () => {
  test('前後の空白と改行を落とす', () => {
    expect(normalizeCommentBody('  メモ \n')).toBe('メモ')
  })
  test('本文中の改行は保つ', () => {
    expect(normalizeCommentBody('1行目\n2行目')).toBe('1行目\n2行目')
  })
  test('null / undefined は空文字', () => {
    expect(normalizeCommentBody(null)).toBe('')
    expect(normalizeCommentBody(undefined)).toBe('')
  })
})

describe('commentDraftError', () => {
  test('空や空白だけならエラー', () => {
    expect(commentDraftError('')).toBe('作業ログを入力してください')
    expect(commentDraftError('   \n')).toBe('作業ログを入力してください')
  })
  test('上限ちょうどは通り、超えるとエラー', () => {
    expect(commentDraftError('x'.repeat(MAX_COMMENT_LENGTH))).toBeNull()
    expect(commentDraftError('x'.repeat(MAX_COMMENT_LENGTH + 1))).toContain(
      String(MAX_COMMENT_LENGTH)
    )
  })
  test('上限は前後の空白を落としてから数える', () => {
    expect(commentDraftError(`  ${'x'.repeat(MAX_COMMENT_LENGTH)}  `)).toBeNull()
  })
  test('通常の本文は null', () => {
    expect(commentDraftError('調査を開始した')).toBeNull()
  })
})

// Enter だけでは送らない(複数行の作業ログを書けるように)。⌘/Ctrl+Enter が送信。
describe('isCommentSubmitShortcut', () => {
  test('⌘+Enter と Ctrl+Enter は送信', () => {
    expect(isCommentSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isCommentSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
  })
  test('素の Enter は改行のまま', () => {
    expect(isCommentSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
  })
  test('Enter 以外は無視', () => {
    expect(isCommentSubmitShortcut({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false)
  })
})
