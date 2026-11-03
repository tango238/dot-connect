import { describe, expect, test } from 'bun:test'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import * as weekQueueRepo from '../../src/db/weekQueueRepo'
import { addToQueue, listQueue, reorderQueue } from '../../src/services/weekQueueService'
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
  test('addToQueue gives an undated todo the week end as due date and leaves an existing due date alone', () => {
    const db = createDatabase(':memory:')
    const undated = todoRepo.create(db, { title: 'undated' })
    const dated = todoRepo.create(db, { title: 'dated', dueDate: '2026-08-10' })
    expect(addToQueue(db, WEEK, undated.id).dueDate).toBe('2026-07-26')
    expect(addToQueue(db, WEEK, dated.id).dueDate).toBe('2026-08-10')
    expect(() => addToQueue(db, WEEK, 999)).toThrow(/not found/)
    const queue = listQueue(db, WEEK)
    expect(queue).toMatchObject({ weekStart: WEEK, weekEnd: '2026-07-26' })
    expect(queue.todos.map((t) => t.title)).toEqual(['undated', 'dated'])
    expect(reorderQueue(db, WEEK, [dated.id]).todos.map((t) => t.title)).toEqual(['dated', 'undated'])
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
  test('defaults to true, PATCH toggles it per week, and the flag survives reorders', async () => {
    const { app, deps } = createTestApp()
    const a = todoRepo.create(deps.db, { title: 'a' })
    const b = todoRepo.create(deps.db, { title: 'b' })
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: a.id }))
    await app.request('/api/reports/weekly/queue', json('POST', { weekStart: WEEK, todoId: b.id }))
    const res = await app.request(`/api/reports/weekly/queue/${a.id}`, json('PATCH', { weekStart: WEEK, dispatch: false }))
    expect(res.status).toBe(200)
    expect((await readJson(res)).data.todos.map((t: { id: number; dispatch: boolean }) => [t.id, t.dispatch])).toEqual([[a.id, false], [b.id, true]])
    const reordered = await app.request('/api/reports/weekly/queue/order', json('PUT', { weekStart: WEEK, todoIds: [b.id, a.id] }))
    expect((await readJson(reordered)).data.todos.map((t: { id: number; dispatch: boolean }) => [t.id, t.dispatch])).toEqual([[b.id, true], [a.id, false]])
    expect((await app.request(`/api/reports/weekly/queue/999`, json('PATCH', { weekStart: WEEK, dispatch: true }))).status).toBe(404)
    expect((await app.request(`/api/reports/weekly/queue/${a.id}`, json('PATCH', { weekStart: WEEK, dispatch: 'no' }))).status).toBe(400)
  })
})
