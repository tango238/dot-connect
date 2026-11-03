import { describe, expect, test } from 'bun:test'
import { sortActiveTodos } from '../../public/js/lib/todoOrder.js'

const TODAY = '2026-08-07'

function todo(id, overrides = {}) {
  return {
    id,
    status: 'open',
    urgency: 1, importance: 1,
    dueDate: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: null,
    ...overrides,
  }
}

const idsOf = (todos) => sortActiveTodos(todos, TODAY).map((t) => t.id)

describe('sortActiveTodos', () => {
  test('期日設定済 > 優先順位あり(高→低) > 期日超過 > 優先順位未設定 の順に並ぶ', () => {
    const noPriority = todo(1)
    const lowPriority = todo(2, { urgency: 3 })
    const highPriority = todo(3, { urgency: 5 })
    const overdue = todo(4, { dueDate: '2026-08-01', urgency: 5 })
    const scheduled = todo(5, { dueDate: '2026-09-01' })
    expect(idsOf([noPriority, lowPriority, highPriority, overdue, scheduled])).toEqual([5, 3, 2, 4, 1])
  })

  test('期日設定済のなかは優先順位(緊急度+重要度)の高い順', () => {
    const none = todo(1, { dueDate: '2026-08-10' })
    const low = todo(2, { dueDate: '2026-08-10', urgency: 3 })
    const high = todo(3, { dueDate: '2026-08-10', urgency: 5 })
    expect(idsOf([none, low, high])).toEqual([3, 2, 1])
  })

  test('優先度が同じ期日設定済は期日の近い順', () => {
    const later = todo(1, { dueDate: '2026-09-01', urgency: 5 })
    const sooner = todo(2, { dueDate: '2026-08-08', urgency: 5 })
    expect(idsOf([later, sooner])).toEqual([2, 1])
  })

  test('今日が期限のTODOは期日設定済(超過ではない)として先頭グループに入る', () => {
    const dueToday = todo(1, { dueDate: TODAY })
    const high = todo(2, { urgency: 5 })
    expect(idsOf([high, dueToday])).toEqual([1, 2])
  })

  test('期日超過は優先度に関係なくまとまり、超過の古い順に並ぶ', () => {
    const lessOverdueHigh = todo(1, { dueDate: '2026-08-06', urgency: 5 })
    const mostOverdueNone = todo(2, { dueDate: '2026-07-01' })
    const lowNoDue = todo(3, { urgency: 3 })
    expect(idsOf([lessOverdueHigh, mostOverdueNone, lowNoDue])).toEqual([3, 2, 1])
  })

  test('合計点が同じなら緊急度の高い方が先、重要度だけでも優先順位ありになる', () => {
    const urgent = todo(1, { urgency: 4, importance: 2 })
    const important = todo(2, { urgency: 2, importance: 4 })
    const onlyImportant = todo(3, { importance: 2 })
    const unset = todo(4)
    expect(idsOf([unset, onlyImportant, important, urgent])).toEqual([1, 2, 3, 4])
  })

  test('同条件は id 昇順で安定する', () => {
    expect(idsOf([todo(9, { urgency: 5 }), todo(4, { urgency: 5 })])).toEqual([4, 9])
  })

  test('不正な期日はバッジと同じく「期日なし」として扱う', () => {
    const broken = todo(1, { dueDate: '2026-8-6', urgency: 5 })
    const scheduled = todo(2, { dueDate: '2026-09-01' })
    expect(idsOf([broken, scheduled])).toEqual([2, 1])
  })

  test('入力配列を書き換えない', () => {
    const input = [todo(1), todo(2, { urgency: 5 })]
    const before = input.map((t) => t.id)
    sortActiveTodos(input, TODAY)
    expect(input.map((t) => t.id)).toEqual(before)
  })

  test('todayIso が無いときも並びを壊さない(期日ありは先頭のまま)', () => {
    const scheduled = todo(1, { dueDate: '2026-08-01' })
    const high = todo(2, { urgency: 5 })
    expect(sortActiveTodos([high, scheduled], '').map((t) => t.id)).toEqual([1, 2])
  })
})
