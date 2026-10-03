import { describe, expect, test } from 'bun:test'
import * as labelRepo from '../../src/db/labelRepo'
import * as milestoneRepo from '../../src/db/milestoneRepo'
import { createTestApp, readJson } from './testApp'

describe('GET /api/labels', () => {
  test('returns an empty array when there are none', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
  })

  test('returns labels ordered by name ascending', async () => {
    const { app, deps } = createTestApp()
    labelRepo.create(deps.db, { name: 'Zeta' })
    labelRepo.create(deps.db, { name: 'Alpha' })
    const res = await app.request('/api/labels')
    const body = await readJson(res)
    expect(body.data.map((l: { name: string }) => l.name)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('POST /api/labels', () => {
  test('creates a label with a default color', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Backend' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.name).toBe('Backend')
    expect(body.data.color).toBe('#8b96a5')
  })

  test('creates a label with a given color', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Backend', color: '#123456' }),
    })
    const body = await readJson(res)
    expect(body.data.color).toBe('#123456')
  })

  test('trims the name before validating', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Spaced  ' }),
    })
    const body = await readJson(res)
    expect(body.data.name).toBe('Spaced')
  })

  test('returns 400 for an empty (whitespace-only) name', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when name exceeds 50 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(51) }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for a malformed color', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Backend', color: 'red' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 409 for a duplicate name', async () => {
    const { app, deps } = createTestApp()
    labelRepo.create(deps.db, { name: 'Backend' })
    const res = await app.request('/api/labels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Backend' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.error).toBe('同じ名前のラベルが既にあります')
  })
})

describe('PATCH /api/labels/:id', () => {
  test('updates name and color', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'old', color: '#111111' })
    const res = await app.request(`/api/labels/${label.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new', color: '#222222' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.name).toBe('new')
    expect(body.data.color).toBe('#222222')
    expect(body.data.updatedAt).not.toBeNull()
  })

  test('returns 404 for a missing label', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels/999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  test('returns 409 when renaming to a name already used by another label', async () => {
    const { app, deps } = createTestApp()
    labelRepo.create(deps.db, { name: 'Backend' })
    const other = labelRepo.create(deps.db, { name: 'Frontend' })
    const res = await app.request(`/api/labels/${other.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Backend' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(409)
    expect(body.error).toBe('同じ名前のラベルが既にあります')
  })

  test('returns 400 for a malformed color', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'Backend' })
    const res = await app.request(`/api/labels/${label.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: 'not-a-color' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/labels/:id', () => {
  test('deletes a label and unlinks milestones, returning the unlinked count', async () => {
    const { app, deps } = createTestApp()
    const label = labelRepo.create(deps.db, { name: 'Backend' })
    milestoneRepo.create(deps.db, {
      title: 'M1',
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
      labelId: label.id,
    })

    const res = await app.request(`/api/labels/${label.id}`, { method: 'DELETE' })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ removed: true, unlinkedMilestones: 1 })
    expect(labelRepo.getById(deps.db, label.id)).toBeNull()

    const milestone = milestoneRepo.listAll(deps.db)[0]
    expect(milestone?.labelId).toBeNull()
  })

  test('returns 404 for a missing label', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/labels/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
