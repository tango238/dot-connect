import { describe, expect, test } from 'bun:test'
import { wipBlockedReason, wipCount, wipMeter } from '../../public/js/lib/wipLimit.js'

const running = { sessionState: 'working', status: 'open' }
const idle = { sessionState: 'idle', status: 'open' }
const doneWithSession = { sessionState: 'idle', status: 'done' }
const notDispatched = { sessionState: null, status: 'open' }

describe('wipCount', () => {
  test('セッション付きの未完了TODOだけを数える', () => {
    expect(wipCount([running, idle, doneWithSession, notDispatched])).toBe(2)
  })
})

describe('wipMeter', () => {
  test('使用中を■、空きを□で表す', () => {
    expect(wipMeter(6, 10)).toEqual({ cells: '■■■■■■□□□□', label: '6/10', full: false, over: false })
  })

  test('上限ちょうどは full', () => {
    expect(wipMeter(3, 3)).toEqual({ cells: '■■■', label: '3/3', full: true, over: false })
  })

  test('上限超過はセルを埋め切り、数字は実数', () => {
    expect(wipMeter(5, 3)).toEqual({ cells: '■■■', label: '5/3', full: true, over: true })
  })
})

describe('wipBlockedReason', () => {
  test('無効・未取得なら止めない', () => {
    expect(wipBlockedReason(null, [running])).toBeNull()
    expect(wipBlockedReason({ wipLimitEnabled: false, wipLimit: 1 }, [running])).toBeNull()
  })

  test('有効で空きがあれば止めない', () => {
    expect(wipBlockedReason({ wipLimitEnabled: true, wipLimit: 2 }, [running])).toBeNull()
  })

  test('有効で上限に達していれば理由を返す', () => {
    expect(wipBlockedReason({ wipLimitEnabled: true, wipLimit: 2 }, [running, idle])).toContain('WIP制限(2件)')
  })
})
