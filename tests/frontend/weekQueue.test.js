import { describe, expect, test } from 'bun:test'
import { autoRunCapacity, autoRunPlan, dispatchReadiness, moveId, queueModeLabel } from '../../public/js/lib/weekQueue.js'

const ready = (id, extra = {}) => ({ id, title: `t${id}`, status: 'open', sessionState: null, grillDir: null, grilledAt: '2026-11-01 00:00:00', workspacePath: '/w', ...extra })

describe('moveId', () => {
  test('moves within bounds and leaves edges and unknown ids alone', () => {
    expect(moveId([1, 2, 3], 2, -1)).toEqual([2, 1, 3])
    expect(moveId([1, 2, 3], 2, 1)).toEqual([1, 3, 2])
    expect(moveId([1, 2, 3], 1, -1)).toEqual([1, 2, 3])
    expect(moveId([1, 2, 3], 3, 1)).toEqual([1, 2, 3])
    expect(moveId([1, 2, 3], 9, 1)).toEqual([1, 2, 3])
  })
})

describe('autoRunCapacity', () => {
  test('slots = limit − buffer, free = slots − running, never negative', () => {
    const todos = [ready(1, { sessionState: 'working' }), ready(2, { sessionState: 'idle' }), ready(3)]
    expect(autoRunCapacity({ wipLimit: 4, autoRunBuffer: 1 }, todos)).toEqual({ limit: 4, buffer: 1, running: 2, slots: 3, free: 1 })
    expect(autoRunCapacity({ wipLimit: 2, autoRunBuffer: 1 }, todos)).toEqual({ limit: 2, buffer: 1, running: 2, slots: 1, free: 0 })
    expect(autoRunCapacity(null, [])).toEqual({ limit: 10, buffer: 1, running: 0, slots: 9, free: 9 })
  })
})

describe('dispatchReadiness', () => {
  test('requires open, no session, not grilling, grilled, and a workspace', () => {
    expect(dispatchReadiness(ready(1))).toBeNull()
    expect(dispatchReadiness(ready(1, { status: 'done' }))).toBe('完了済み')
    expect(dispatchReadiness(ready(1, { grillDir: '/g' }))).toContain('Grill 中')
    expect(dispatchReadiness(ready(1, { sessionState: 'working' }))).toBe('実行中')
    // Grill は内容を詰める手段で、投入の条件ではない(herdr か自分かは TODO 側の判定)
    expect(dispatchReadiness(ready(1, { grilledAt: null }))).toBeNull()
    expect(dispatchReadiness(ready(1, { queueDispatch: false }))).toContain('自分でやる')
    expect(dispatchReadiness(ready(1, { workspacePath: null }))).toContain('作業ディレクトリ')
    expect(dispatchReadiness(undefined)).toContain('見つかりません')
  })
})

describe('autoRunPlan', () => {
  const settings = { wipLimit: 3, autoRunBuffer: 1 }

  test('proposes the first ready todo in order and lists why the others wait', () => {
    const queue = [ready(1, { workspacePath: null }), ready(2), ready(3), ready(4, { status: 'done' })]
    const plan = autoRunPlan(queue, queue, settings)
    expect(plan.candidate.id).toBe(2)
    expect(plan.canPropose).toBe(true)
    expect(plan.waiting.map((w) => [w.todo.id, w.reason])).toEqual([[1, '作業ディレクトリ未設定']])
    expect(plan.done).toBe(1)
  })

  test('skipped ids are passed over, and running ones are not listed as waiting', () => {
    const queue = [ready(1), ready(2, { sessionState: 'working' }), ready(3)]
    const plan = autoRunPlan(queue, queue, settings, new Set([1]))
    expect(plan.candidate.id).toBe(3)
    expect(plan.running).toBe(1)
    expect(plan.waiting.map((w) => w.todo.id)).toEqual([1])
  })

  test('with no free slot the candidate is still named but not proposed', () => {
    const queue = [ready(1, { sessionState: 'working' }), ready(2, { sessionState: 'idle' }), ready(3)]
    const plan = autoRunPlan(queue, queue, settings)
    expect(plan.capacity.free).toBe(0)
    expect(plan.candidate.id).toBe(3)
    expect(plan.canPropose).toBe(false)
  })

  test('nothing ready → no candidate', () => {
    expect(autoRunPlan([ready(1, { workspacePath: null })], [], settings).candidate).toBeNull()
    expect(autoRunPlan([], [], settings)).toMatchObject({ candidate: null, canPropose: false, waiting: [] })
  })
})

describe('queueModeLabel', () => {
  test('herdr rows and 自分 rows get their label; done rows get none', () => {
    expect(queueModeLabel(ready(1))).toMatchObject({ mode: 'herdr', label: 'herdr' })
    expect(queueModeLabel(ready(1, { queueDispatch: false }))).toMatchObject({ mode: 'self', label: '自分' })
    expect(queueModeLabel(ready(1, { status: 'done' }))).toBeNull()
    expect(queueModeLabel(null)).toBeNull()
  })
})

describe('queueDispatch flag', () => {
  test('a row marked 自分でやる is never a candidate, even when grilled and ready', () => {
    expect(dispatchReadiness(ready(1, { queueDispatch: false }))).toContain('herdr に投入しない')
    const queue = [ready(1, { queueDispatch: false }), ready(2)]
    const plan = autoRunPlan(queue, queue, { wipLimit: 3, autoRunBuffer: 1 })
    expect(plan.candidate.id).toBe(2)
    expect(plan.waiting.map((w) => w.todo.id)).toEqual([1])
  })
})
