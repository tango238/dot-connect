import { describe, expect, test } from 'bun:test'
import * as reportRepo from '../../src/db/reportRepo'
import { createFakeClaudeRunner, createTestApp, readJson } from './testApp'

describe('GET /api/reports/weekly', () => {
  test('returns 404 when no report exists for the week', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly?weekStart=2026-07-20')
    expect(res.status).toBe(404)
  })

  test('returns 400 for a malformed weekStart', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly?weekStart=not-a-date')
    expect(res.status).toBe(400)
  })

  test('returns the stored report', async () => {
    const { app, deps } = createTestApp()
    reportRepo.upsert(deps.db, {
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      completedCount: 1,
      milestoneLinkedCount: 1,
      unplannedCount: 0,
      dispatchCount: 1,
      llmAnalysis: { summary: 'ok', warnings: [], suggestions: [] },
    })
    const res = await app.request('/api/reports/weekly?weekStart=2026-07-20')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.completedCount).toBe(1)
  })
})

describe('GET /api/reports/weekly/stats', () => {
  test('returns live statistics for the requested week without touching claude', async () => {
    const { app, deps } = createTestApp()
    deps.db.run(
      `INSERT INTO todos (title, status, created_at, completed_at) VALUES ('t', 'done', '2026-07-21 09:00:00', '2026-07-21 10:00:00')`
    )
    const res = await app.request('/api/reports/weekly/stats?weekStart=2026-07-20')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data.weekStart).toBe('2026-07-20')
    expect(body.data.weekEnd).toBe('2026-07-26')
    expect(body.data.completedCount).toBe(1)
    expect(body.data.createdCount).toBe(1)
    expect(body.data.fastest).toEqual([
      expect.objectContaining({ title: 't', leadMinutes: 60 }),
    ])
    expect(body.data.daily).toHaveLength(7)
    expect(reportRepo.getLatest(deps.db)).toBeNull() // nothing is stored
  })

  test('defaults to the current week (a Monday) when weekStart is omitted', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/stats')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    const monday = new Date(`${body.data.weekStart}T12:00:00`)
    expect(monday.getDay()).toBe(1)
    expect(body.data.completedCount).toBe(0)
  })

  test('returns 400 for a malformed weekStart', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/stats?weekStart=2026-7-1')
    expect(res.status).toBe(400)
  })
})

describe('weekly goal', () => {
  test('GET returns an empty goal (not 404) for a week nobody has written to', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/goal?weekStart=2026-07-20')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ weekStart: '2026-07-20', body: '', updatedAt: null })
  })

  test('POST saves (trimmed) and GET reads it back', async () => {
    const { app } = createTestApp()
    const saved = await app.request('/api/reports/weekly/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weekStart: '2026-07-20', body: '  - 検索を出す\n- CI を速く \n' }),
    })
    const savedBody = await readJson(saved)
    expect(saved.status).toBe(200)
    expect(savedBody.data.body).toBe('- 検索を出す\n- CI を速く')

    const res = await app.request('/api/reports/weekly/goal?weekStart=2026-07-20')
    expect((await readJson(res)).data.body).toBe('- 検索を出す\n- CI を速く')
  })

  test('POST rejects a malformed week and an over-long body', async () => {
    const { app } = createTestApp()
    const bad = await app.request('/api/reports/weekly/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weekStart: '2026-7-20', body: 'x' }),
    })
    expect(bad.status).toBe(400)
    const long = await app.request('/api/reports/weekly/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weekStart: '2026-07-20', body: 'x'.repeat(4001) }),
    })
    expect(long.status).toBe(400)
  })

  test('POST /tidy returns the tidied text without saving anything', async () => {
    const { app, deps } = createTestApp()
    const res = await app.request('/api/reports/weekly/goal/tidy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '検索を出す。CIを速く。' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ body: '整理済み: 検索を出す。CIを速く。' })
    expect(deps.db.query(`SELECT COUNT(*) AS n FROM weekly_goals`).get()).toEqual({ n: 0 })
  })

  test('POST /tidy rejects an empty goal', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/goal/tidy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '   ' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/reports/weekly/latest', () => {
  test('returns 404 when there are no reports', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/latest')
    expect(res.status).toBe(404)
  })

  test('returns the most recent report', async () => {
    const { app, deps } = createTestApp()
    reportRepo.upsert(deps.db, {
      weekStart: '2026-07-13',
      weekEnd: '2026-07-19',
      completedCount: 1,
      milestoneLinkedCount: 0,
      unplannedCount: 1,
      dispatchCount: 0,
      llmAnalysis: null,
    })
    reportRepo.upsert(deps.db, {
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
      completedCount: 2,
      milestoneLinkedCount: 1,
      unplannedCount: 1,
      dispatchCount: 2,
      llmAnalysis: null,
    })
    const res = await app.request('/api/reports/weekly/latest')
    const body = await readJson(res)
    expect(body.data.weekStart).toBe('2026-07-20')
  })
})

describe('POST /api/reports/weekly/generate', () => {
  test('generates and persists a report for an explicit weekStart', async () => {
    const claudeRunner = createFakeClaudeRunner({
      summary: 'good',
      warnings: [],
      suggestions: ['keep it up'],
    })
    const { app, deps } = createTestApp({ claudeRunner })

    const res = await app.request('/api/reports/weekly/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weekStart: '2026-07-20' }),
    })
    const body = await readJson(res)
    expect(res.status).toBe(201)
    expect(body.data.weekStart).toBe('2026-07-20')
    expect(body.data.llmAnalysis.summary).toBe('good')
    expect(reportRepo.getByWeekStart(deps.db, '2026-07-20')).not.toBeNull()
  })

  test('works with an empty body, defaulting weekStart', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/generate', { method: 'POST' })
    expect(res.status).toBe(201)
  })

  test('returns 400 for a malformed weekStart in the body', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/reports/weekly/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weekStart: 'nope' }),
    })
    expect(res.status).toBe(400)
  })
})
