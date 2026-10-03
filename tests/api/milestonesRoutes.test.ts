import { describe, expect, test } from 'bun:test'
import * as labelRepo from '../../src/db/labelRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import * as todoRepo from '../../src/db/todoRepo'
import { createTestApp, readJson } from './testApp'

describe('GET /api/milestones', () => {
  test('returns milestones with linked/done counts', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const t1 = todoRepo.create(deps.db, { title: 't1', milestoneId: milestone.id })
    todoRepo.complete(deps.db, t1.id)
    todoRepo.create(deps.db, { title: 't2', milestoneId: milestone.id })

    const res = await app.request('/api/milestones')
    const body = await readJson(res)
    expect(body.data[0].linkedCount).toBe(2)
    expect(body.data[0].doneCount).toBe(1)
  })

  test('joins labelId/labelName/labelColor when a label is set, and null when it is not', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'Backend', color: '#123456' })
    milestoneRepo.create(deps.db, {
      title: 'labeled',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
      labelId: label.id,
    })
    milestoneRepo.create(deps.db, {
      title: 'unlabeled',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })

    const res = await app.request('/api/milestones')
    const body = await readJson(res)
    const labeled = body.data.find((m: { title: string }) => m.title === 'labeled')
    const unlabeled = body.data.find((m: { title: string }) => m.title === 'unlabeled')
    expect(labeled.labelId).toBe(label.id)
    expect(labeled.labelName).toBe('Backend')
    expect(labeled.labelColor).toBe('#123456')
    expect(unlabeled.labelId).toBeNull()
    expect(unlabeled.labelName).toBeNull()
    expect(unlabeled.labelColor).toBeNull()
  })
})

describe('POST /api/milestones', () => {
  test('creates a milestone', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Q3', startDate: '2026-07-01', targetDate: '2026-09-30' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.title).toBe('Q3')
  })

  test('returns 400 for missing required fields', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Q3' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when title exceeds 200 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'a'.repeat(201),
        startDate: '2026-07-01',
        targetDate: '2026-09-30',
      }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for a malformed date', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Q3', startDate: '07/01/2026', targetDate: '2026-09-30' }),
    })
    expect(res.status).toBe(400)
  })

  test('creates a milestone with a labelId, joined back in the response', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'Backend' })
    const res = await app.request('/api/milestones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Q3',
        startDate: '2026-07-01',
        targetDate: '2026-09-30',
        labelId: label.id,
      }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.labelId).toBe(label.id)
    expect(body.data.labelName).toBe('Backend')
  })

  test('returns 404 when labelId does not reference an existing label', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Q3',
        startDate: '2026-07-01',
        targetDate: '2026-09-30',
        labelId: 999,
      }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(404)
    expect(body.error).toBe('そのラベルは存在しません')
  })
})

describe('PATCH /api/milestones/:id', () => {
  test('updates fields', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'old',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    })
    const body = await readJson(res)
    expect(body.data.title).toBe('new')
  })

  test('returns 404 for a missing milestone', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones/999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 400 when PATCHing title to exceed 200 characters', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'old',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(201) }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects a lone startDate PATCH that would move it after the existing targetDate', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-03-01' }),
    })
    expect(res.status).toBe(400)
  })

  test('rejects a lone targetDate PATCH that would move it before the existing startDate', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDate: '2025-12-01' }),
    })
    expect(res.status).toBe(400)
  })

  test('allows a lone startDate PATCH that stays before the existing targetDate', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-01-15' }),
    })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.data.startDate).toBe('2026-01-15')
  })

  test('PATCHes labelId to attach a label', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'Backend' })
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labelId: label.id }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.labelId).toBe(label.id)
    expect(body.data.labelName).toBe('Backend')
  })

  test('PATCHes labelId: null to detach a label', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'Backend' })
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
      labelId: label.id,
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labelId: null }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.labelId).toBeNull()
    expect(body.data.labelName).toBeNull()
  })

  test('returns 404 when PATCHing labelId to a nonexistent label', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const res = await app.request(`/api/milestones/${milestone.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labelId: 999 }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(404)
    expect(body.error).toBe('そのラベルは存在しません')
  })
})

describe('POST /api/milestones/:id/complete', () => {
  test('returns 409 with remaining count when open todos are linked', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    todoRepo.create(deps.db, { title: 'open', milestoneId: milestone.id })

    const res = await app.request(`/api/milestones/${milestone.id}/complete`, { method: 'POST' })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.remaining).toBe(1)
  })

  test('completes when all linked todos are done', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    const t1 = todoRepo.create(deps.db, { title: 'done', milestoneId: milestone.id })
    todoRepo.complete(deps.db, t1.id)

    const res = await app.request(`/api/milestones/${milestone.id}/complete`, { method: 'POST' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.status).toBe('done')
  })

  test('returns 404 for a missing milestone', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones/999/complete', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/milestones/:id/reopen', () => {
  test('reopens a completed milestone', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    milestoneRepo.complete(deps.db, milestone.id)
    const res = await app.request(`/api/milestones/${milestone.id}/reopen`, { method: 'POST' })
    const body = await readJson(res)
    expect(body.data.status).toBe('active')
  })
})

describe('DELETE /api/milestones/:id', () => {
  test('deletes and unlinks todos, returning the unlinked count', async () => {
    const { app, deps } = createTestApp()
    const milestone = milestoneRepo.create(deps.db, {
      title: 'M',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
    })
    todoRepo.create(deps.db, { title: 't1', milestoneId: milestone.id })

    const res = await app.request(`/api/milestones/${milestone.id}`, { method: 'DELETE' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.unlinkedCount).toBe(1)
  })

  test('returns 404 for a missing milestone', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/milestones/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
