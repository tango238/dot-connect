import { describe, expect, test } from 'bun:test'
import { sortActiveTodos } from '../../public/js/lib/todoOrder.js'

const TODAY = '2026-08-07'

function todo(id, overrides = {}) {
  return {
    id,
    status: 'open',
    priority: 'none',
    dueDate: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: null,
    ...overrides,
  }
}

const idsOf = (todos) => sortActiveTodos(todos, TODAY).map((t) => t.id)

describe('sortActiveTodos', () => {
  test('期日設定済 > 優先度高 > 優先度低 > 期日超過 > 優先度未設定 の順に並ぶ', () => {
    const noPriority = todo(1)
    const lowPriority = todo(2, { priority: 'low' })
    const highPriority = todo(3, { priority: 'high' })
    const overdue = todo(4, { dueDate: '2026-08-01', priority: 'high' })
    const scheduled = todo(5, { dueDate: '2026-09-01' })
    expect(idsOf([noPriority, lowPriority, highPriority, overdue, scheduled])).toEqual([5, 3, 2, 4, 1])
  })

  test('期日設定済のなかは優先度 高 > 低 > なし の順', () => {
    const none = todo(1, { dueDate: '2026-08-10' })
    const low = todo(2, { dueDate: '2026-08-10', priority: 'low' })
    const high = todo(3, { dueDate: '2026-08-10', priority: 'high' })
    expect(idsOf([none, low, high])).toEqual([3, 2, 1])
  })

  test('優先度が同じ期日設定済は期日の近い順', () => {
    const later = todo(1, { dueDate: '2026-09-01', priority: 'high' })
    const sooner = todo(2, { dueDate: '2026-08-08', priority: 'high' })
    expect(idsOf([later, sooner])).toEqual([2, 1])
  })

  test('今日が期限のTODOは期日設定済(超過ではない)として先頭グループに入る', () => {
    const dueToday = todo(1, { dueDate: TODAY })
    const high = todo(2, { priority: 'high' })
    expect(idsOf([high, dueToday])).toEqual([1, 2])
  })

  test('期日超過は優先度に関係なくまとまり、超過の古い順に並ぶ', () => {
    const lessOverdueHigh = todo(1, { dueDate: '2026-08-06', priority: 'high' })
    const mostOverdueNone = todo(2, { dueDate: '2026-07-01' })
    const lowNoDue = todo(3, { priority: 'low' })
    expect(idsOf([lessOverdueHigh, mostOverdueNone, lowNoDue])).toEqual([3, 2, 1])
  })

  test('同条件は id 昇順で安定する', () => {
    expect(idsOf([todo(9, { priority: 'high' }), todo(4, { priority: 'high' })])).toEqual([4, 9])
  })

  test('不正な期日はバッジと同じく「期日なし」として扱う', () => {
    const broken = todo(1, { dueDate: '2026-8-6', priority: 'high' })
    const scheduled = todo(2, { dueDate: '2026-09-01' })
    expect(idsOf([broken, scheduled])).toEqual([2, 1])
  })

  test('入力配列を書き換えない', () => {
    const input = [todo(1), todo(2, { priority: 'high' })]
    const before = input.map((t) => t.id)
    sortActiveTodos(input, TODAY)
    expect(input.map((t) => t.id)).toEqual(before)
  })

  test('todayIso が無いときも並びを壊さない(期日ありは先頭のまま)', () => {
    const scheduled = todo(1, { dueDate: '2026-08-01' })
    const high = todo(2, { priority: 'high' })
    expect(sortActiveTodos([high, scheduled], '').map((t) => t.id)).toEqual([1, 2])
  })
})
