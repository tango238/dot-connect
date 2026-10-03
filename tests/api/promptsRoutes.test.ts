import { describe, expect, test } from 'bun:test'
import * as promptHistoryRepo from '../../src/db/promptHistoryRepo'
import * as promptSnippetRepo from '../../src/db/promptSnippetRepo'
import { createTestApp, readJson } from './testApp'

describe('GET /api/prompts/history', () => {
  test('returns an empty array when there is no history', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/history')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
  })

  test('returns history most-recently-used first', async () => {
    const { app, deps } = createTestApp()
    promptHistoryRepo.recordUse(deps.db, 'first')
    promptHistoryRepo.recordUse(deps.db, 'second')
    const res = await app.request('/api/prompts/history')
    const body = await readJson(res)
    expect(body.data.map((h: { body: string }) => h.body)).toEqual(['second', 'first'])
  })
})

describe('DELETE /api/prompts/history', () => {
  test('clears history and returns the removed count', async () => {
    const { app, deps } = createTestApp()
    promptHistoryRepo.recordUse(deps.db, 'a')
    promptHistoryRepo.recordUse(deps.db, 'b')

    const res = await app.request('/api/prompts/history', { method: 'DELETE' })
    const body = await readJson(res)

    expect(res.status).toBe(200)
    expect(body.data).toEqual({ removed: 2 })
    expect(promptHistoryRepo.listAll(deps.db)).toEqual([])
  })

  test('returns removed: 0 when history is already empty', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/history', { method: 'DELETE' })
    const body = await readJson(res)
    expect(body.data).toEqual({ removed: 0 })
  })
})

describe('GET /api/prompts/snippets', () => {
  test('returns an empty array when there are none', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets')
    const body = await readJson(res)
    expect(body.data).toEqual([])
  })

  test('returns created snippets', async () => {
    const { app, deps } = createTestApp()
    promptSnippetRepo.create(deps.db, { title: 'Bug fix', body: 'Fix the bug' })
    const res = await app.request('/api/prompts/snippets')
    const body = await readJson(res)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].title).toBe('Bug fix')
  })
})

describe('POST /api/prompts/snippets', () => {
  test('creates a snippet', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New', body: 'Do the thing' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.title).toBe('New')
    expect(body.data.body).toBe('Do the thing')
    expect(body.data.updatedAt).toBeNull()
  })

  test('trims title and body before validating', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  Spaced  ', body: '  padded body  ' }),
    })
    const body = await readJson(res)
    expect(body.data.title).toBe('Spaced')
    expect(body.data.body).toBe('padded body')
  })

  test('returns 400 for an empty title', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ', body: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 for an empty body', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', body: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when body exceeds 4000 characters', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', body: 'a'.repeat(4001) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/prompts/snippets/:id', () => {
  test('updates title and body', async () => {
    const { app, deps } = createTestApp()
    const snippet = promptSnippetRepo.create(deps.db, { title: 'old', body: 'old body' })
    const res = await app.request(`/api/prompts/snippets/${snippet.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.title).toBe('new')
    expect(body.data.body).toBe('old body')
    expect(body.data.updatedAt).not.toBeNull()
  })

  test('returns 404 for a missing snippet', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets/999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/prompts/snippets/:id', () => {
  test('deletes an existing snippet', async () => {
    const { app, deps } = createTestApp()
    const snippet = promptSnippetRepo.create(deps.db, { title: 'x', body: 'y' })
    const res = await app.request(`/api/prompts/snippets/${snippet.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(promptSnippetRepo.getById(deps.db, snippet.id)).toBeNull()
  })

  test('returns 404 for a missing snippet', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/prompts/snippets/999', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
