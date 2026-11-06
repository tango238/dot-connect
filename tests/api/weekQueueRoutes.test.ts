import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import * as weekQueueRepo from '../../src/db/weekQueueRepo'
import { addToQueue, listQueue, queueDispatchFor, reorderQueue, syncQueueDispatch } from '../../src/services/weekQueueService'
import { createTestApp, readJson } from './testApp'

const WEEK = '2026-07-20'

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('weekQueueRepo', () => {
  test('add appends in order and is idempotent; reorder keeps unlisted ids at the end and ignores unknown ids', () => {
    const db = createDatabase(':memory:')
    const ids = [1, 2, 3, 4].map((i) => todoRepo.create(db, { title: `t${i}` }).id)
    expect(ids.map((id) => weekQueueRepo.add(db, WEEK, id))).toEqual([true, true, true, true])
    expect(weekQueueRepo.add(db, WEEK, ids[0]!)).toBe(false)
    expect(weekQueueRepo.listTodoIds(db, WEEK)).toEqual(ids)
    expect(weekQueueRepo.reorder(db, WEEK, [ids[2]!, 999, ids[0]!])).toEqual([ids[2]!, ids[0]!, ids[1]!, ids[3]!])
    expect(weekQueueRepo.listTodoIds(db, WEEK)).toEqual([ids[2]!, ids[0]!, ids[1]!, ids[3]!])
    expect(weekQueueRepo.listTodoIds(db, '2026-07-27')).toEqual([])
    expect(weekQueueRepo.remove(db, WEEK, ids[1]!)).toBe(true)
    expect(weekQueueRepo.remove(db, WEEK, ids[1]!)).toBe(false)
  })

  test('deleting the todo drops it from every week', () => {
    const db = createDatabase(':memory:')
    const id = todoRepo.create(db, { title: 'x' }).id
    weekQueueRepo.add(db, WEEK, id)
    weekQueueRepo.add(db, '2026-07-27', id)
    todoRepo.remove(db, id)
    expect(weekQueueRepo.listTodoIds(db, WEEK)).toEqual([])
    expect(weekQueueRepo.listTodoIds(db, '2026-07-27')).toEqual([])
  })
})

describe('weekQueueService', () => {
  test('addToQueue gives an undated todo the week end as due date, leaves an existing due date alone, and marks ungrilled todos as self-done', () => {
    const db = createDatabase(':memory:')
    const undated = todoRepo.create(db, { title: 'undated' })
    const dated = todoRepo.create(db, { title: 'dated', dueDate: '2026-08-10' })
    todoRepo.markGrilled(db, dated.id)
    expect(addToQueue(db, WEEK, undated.id).dueDate).toBe('2026-07-26')
    expect(addToQueue(db, WEEK, dated.id).dueDate).toBe('2026-08-10')
    expect(() => addToQueue(db, WEEK, 999)).toThrow(/not found/)
    const queue = listQueue(db, WEEK)
    expect(queue).toMatchObject({ weekStart: WEEK, weekEnd: '2026-07-26' })
    expect(queue.todos.map((t) => [t.title, t.dispatch])).toEqual([['undated', false], ['dated', true]])
    // 既に入っているものを足し直しても印は変わらない
    addToQueue(db, WEEK, undated.id, true)
    expect(listQueue(db, WEEK).todos[0]!.dispatch).toBe(false)
    expect(reorderQueue(db, WEEK, [dated.id]).todos.map((t) => t.title)).toEqual(['dated', 'undated'])
  })

  test('queueDispatchFor: explicit mode wins, otherwise a workspace or Grilled means herdr', () => {
    const t = (over: Partial<{ dispatchMode: 'herdr' | 'self' | null; workspacePath: string | null; grilledAt: string | null }>) => ({
      dispatchMode: null, workspacePath: null, grilledAt: null, ...over,
    })
    expect(queueDispatchFor(t({}))).toBe(false)
    expect(queueDispatchFor(t({ workspacePath: '/w' }))).toBe(true)
    expect(queueDispatchFor(t({ grilledAt: '2026-11-01 00:00:00' }))).toBe(true)
    expect(queueDispatchFor(t({ workspacePath: '/w', grilledAt: '2026-11-01 00:00:00', dispatchMode: 'self' }))).toBe(false)
    expect(queueDispatchFor(t({ dispatchMode: 'herdr' }))).toBe(true)
  })

  test('addToQueue uses the TODO-side decision, and syncQueueDispatch realigns every week the todo is in', () => {
    const db = createDatabase(':memory:')
    const withWs = todoRepo.create(db, { title: 'ws', workspacePath: '/w' })
    const plain = todoRepo.create(db, { title: 'plain' })
    addToQueue(db, WEEK, withWs.id)
    addToQueue(db, WEEK, plain.id)
    addToQueue(db, '2026-07-27', plain.id)
    expect(listQueue(db, WEEK).todos.map((t) => [t.title, t.dispatch])).toEqual([['ws', true], ['plain', false]])

    // 自分でやる → 作業ディレクトリを付けたら両方の週で herdr に
    const updated = todoRepo.update(db, plain.id, { workspacePath: '/p' })!
    expect(syncQueueDispatch(db, updated)).toBe(2)
    expect(listQueue(db, WEEK).todos.find((t) => t.id === plain.id)!.dispatch).toBe(true)
    expect(listQueue(db, '2026-07-27').todos[0]!.dispatch).toBe(true)

    // 明示の「自分でやる」は作業ディレクトリがあっても自分
    const self = todoRepo.update(db, withWs.id, { dispatchMode: 'self' })!
    expect(self.dispatchMode).toBe('self')
    expect(syncQueueDispatch(db, self)).toBe(1)
    expect(listQueue(db, WEEK).todos.find((t) => t.id === withWs.id)!.dispatch).toBe(false)
    // 何も変わらなければ 0 行
    expect(syncQueueDispatch(db, self)).toBe(0)
  })
})

describe('/api/reports/weekly/queue', () => {
  test('GET is empty for a fresh week; POST adds (with the due date), PUT reorders, DELETE removes', async () => {
    const { app, deps } = createTestApp()
    const a = todoRepo.create(deps.db, { title: 'a' })
    const b = todoRepo.create(deps.db, { title: 'b', dueDate: '2026-07-22' })

    const empty = await app.request(`/api/reports/weekly/queue?weekStart=${WEEK}`)
    expect((await readJson(empty)).data).toEqual({ weekStart: WEEK, weekEnd: '2026-07-26', todos: [] })

    const added = await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: a.id }))
    expect(added.status).toBe(201)
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: b.id }))
    const list = await app.request(`/api/reports/weekly/queue?weekStart=${WEEK}`)
    expect((await readJson(list)).data.todos.map((t: { title: string; dueDate: string }) => [t.title, t.dueDate])).toEqual([
      ['a', '2026-07-26'],
      ['b', '2026-07-22'],
    ])

    const reordered = await app.request('/api/reports/weekly/queue/order', json('PUT', { weekStart: WEEK, todoIds: [b.id, a.id] }))
    expect((await readJson(reordered)).data.todos.map((t: { title: string }) => t.title)).toEqual(['b', 'a'])

    const removed = await app.request(`/api/reports/weekly/queue/${a.id}?weekStart=${WEEK}`, { method: 'DELETE' })
    expect((await readJson(removed)).data.todos.map((t: { title: string }) => t.title)).toEqual(['b'])
    expect((await app.request(`/api/reports/weekly/queue/${a.id}?weekStart=${WEEK}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: 999 }))).status).toBe(404)
    expect((await app.request('/api/reports/weekly/queue', json('POST', { weekStart: '2026-7-20', todoId: a.id }))).status).toBe(400)
  })

  test('POST /goal/generate also queues the picked todos, without duplicating ones already there', async () => {
    const { app, deps } = createTestApp()
    const due = todoRepo.create(deps.db, { title: '今週', dueDate: '2026-07-22' })
    const urgent = todoRepo.create(deps.db, { title: '急ぎ', urgency: 5 })
    const manual = todoRepo.create(deps.db, { title: '手で入れた' })
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: manual.id }))
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: due.id }))

    const res = await app.request('/api/reports/weekly/goal/generate', json('POST', { weekStart: WEEK }))
    const data = (await readJson(res)).data
    expect(data.queued).toBe(1)
    expect(data.queue.todos.map((t: { id: number }) => t.id)).toEqual([manual.id, due.id, urgent.id])
    // 期日の無かった急ぎの TODO には週末が入る
    expect(todoRepo.getById(deps.db, urgent.id)?.dueDate).toBe('2026-07-26')
  })

  test('is browser-only (rejected with an API token)', async () => {
    const { app } = createTestApp({ apiToken: 'secret-token' })
    const res = await app.request(`/api/reports/weekly/queue?weekStart=${WEEK}`, { headers: { authorization: 'Bearer secret-token' } })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/settings autoRun', () => {
  test('saves the flag and buffer and validates the range', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/settings', json('PATCH', { autoRunEnabled: true, autoRunBuffer: 2 }))
    expect((await readJson(res)).data).toMatchObject({ autoRunEnabled: true, autoRunBuffer: 2 })
    expect((await app.request('/api/settings', json('PATCH', { autoRunBuffer: 30 }))).status).toBe(400)
    expect((await app.request('/api/settings', json('PATCH', { autoRunBuffer: -1 }))).status).toBe(400)
    const get = await app.request('/api/settings')
    expect((await readJson(get)).data).toMatchObject({ autoRunEnabled: true, autoRunBuffer: 2 })
  })
})

describe('queue dispatch flag', () => {
  test('defaults to Grilled-ness (or the explicit flag), PATCH toggles it per week, and the flag survives reorders', async () => {
    const { app, deps } = createTestApp()
    const a = todoRepo.create(deps.db, { title: 'a' })
    const b = todoRepo.create(deps.db, { title: 'b' })
    const c = todoRepo.create(deps.db, { title: 'c' })
    todoRepo.markGrilled(deps.db, a.id)
    todoRepo.markGrilled(deps.db, b.id)
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: a.id }))
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: b.id }))
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: c.id, dispatch: true }))
    const first = await app.request(`/api/reports/weekly/queue?weekStart=${WEEK}`)
    expect((await readJson(first)).data.todos.map((t: { id: number; dispatch: boolean }) => [t.id, t.dispatch])).toEqual([[a.id, true], [b.id, true], [c.id, true]])
    await app.request(`/api/reports/weekly/queue/${c.id}?weekStart=${WEEK}`, { method: 'DELETE' })
    const res = await app.request(`/api/reports/weekly/queue/${a.id}`, json('PATCH', { weekStart: WEEK, dispatch: false }))
    expect(res.status).toBe(200)
    expect((await readJson(res)).data.todos.map((t: { id: number; dispatch: boolean }) => [t.id, t.dispatch])).toEqual([[a.id, false], [b.id, true]])
    const reordered = await app.request('/api/reports/weekly/queue/order', json('PUT', { weekStart: WEEK, todoIds: [b.id, a.id] }))
    expect((await readJson(reordered)).data.todos.map((t: { id: number; dispatch: boolean }) => [t.id, t.dispatch])).toEqual([[b.id, true], [a.id, false]])
    expect((await app.request(`/api/reports/weekly/queue/999`, json('PATCH', { weekStart: WEEK, dispatch: true }))).status).toBe(404)
    expect((await app.request(`/api/reports/weekly/queue/${a.id}`, json('PATCH', { weekStart: WEEK, dispatch: 'no' }))).status).toBe(400)
  })
})
