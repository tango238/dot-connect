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
