import { describe, expect, test } from 'bun:test'
import { needsCompletionConfirm } from '../../public/js/lib/completionConfirm.js'

function todo(overrides = {}) {
  return { status: 'open', herdrWorkspaceId: null, ...overrides }
}

describe('needsCompletionConfirm', () => {
  test('herdr セッションが無いTODOは確認しない', () => {
    // 完了を押しても消えるものが無い。毎回一手増やす理由がない。
    expect(needsCompletionConfirm(todo())).toBe(false)
  })

  test('herdr セッションが紐付いていれば確認する', () => {
    // 完了するとペインとスクロールバックが消えうる。取り消せないので聞く。
    expect(needsCompletionConfirm(todo({ herdrWorkspaceId: 'w7' }))).toBe(true)
  })

  test('未完了に戻すときは確認しない', () => {
    // reopen は何も壊さない。同じボタンだが、聞くのは完了side だけ。
    expect(needsCompletionConfirm(todo({ status: 'done', herdrWorkspaceId: 'w7' }))).toBe(false)
  })

  test('欠けたTODOでも落ちない', () => {
    for (const value of [null, undefined, {}]) {
      expect(needsCompletionConfirm(value)).toBe(false)
    }
  })
})
