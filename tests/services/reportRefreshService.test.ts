import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { createDatabase } from '../../src/db/database'
import * as reportRepo from '../../src/db/reportRepo'
import type { ClaudeRunner } from '../../src/services/claudeRunner'
import { createDailyReportRefresher, needsDailyRefresh } from '../../src/services/reportRefreshService'
import { sqliteUtcToLocalDate } from '../../src/services/localDate'

let db: Database

beforeEach(() => {
  db = createDatabase(':memory:')
})

function sqliteNowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace('T', ' ')
}

function report(generatedAt: string) {
  return {
    id: 1,
    weekStart: '2026-07-20',
    weekEnd: '2026-07-26',
    completedCount: 0,
    milestoneLinkedCount: 0,
    unplannedCount: 0,
    dispatchCount: 0,
    llmAnalysis: null,
    llmError: null,
    generatedAt,
  }
}

describe('needsDailyRefresh', () => {
  test('a missing report always needs generating', () => {
    expect(needsDailyRefresh(null, new Date())).toBe(true)
  })

  test('a report generated today (local calendar) does not', () => {
    const now = new Date()
    expect(needsDailyRefresh(report(sqliteNowMinus(0)), now)).toBe(false)
  })

  test('a report generated on an earlier local day does', () => {
    const now = new Date()
    const twoDaysAgo = sqliteNowMinus(2 * 24 * 60 * 60_000)
    expect(sqliteUtcToLocalDate(twoDaysAgo) < sqliteUtcToLocalDate(sqliteNowMinus(0))).toBe(true)
    expect(needsDailyRefresh(report(twoDaysAgo), now)).toBe(true)
  })
})

function countingRunner(): { runner: ClaudeRunner; calls: number } {
  const state = { calls: 0 }
  const runner: ClaudeRunner = {
    analyze: async () => {
      state.calls += 1
      return { summary: 'auto', warnings: [], suggestions: [] }
    },
    tidyGoal: async (body) => body,
  }
  return { runner, get calls() { return state.calls } }
}

describe('createDailyReportRefresher', () => {
  test('tick generates this week once, then stays quiet for the rest of the day', async () => {
    const counting = countingRunner()
    const refresher = createDailyReportRefresher({ db, claudeRunner: counting.runner })
    expect(await refresher.tick()).toBe(true)
    expect(counting.calls).toBe(1)
    const saved = reportRepo.getLatest(db)
    expect(saved?.llmAnalysis?.summary).toBe('auto')

    expect(await refresher.tick()).toBe(false)
    expect(counting.calls).toBe(1)
  })

  test('a report left over from yesterday is regenerated', async () => {
    const counting = countingRunner()
    const refresher = createDailyReportRefresher({ db, claudeRunner: counting.runner })
    await refresher.tick()
    db.run(`UPDATE weekly_reports SET generated_at = ?`, [sqliteNowMinus(36 * 60 * 60_000)])
    expect(await refresher.tick()).toBe(true)
    expect(counting.calls).toBe(2)
  })

  test('concurrent ticks share one generation', async () => {
    const counting = countingRunner()
    const refresher = createDailyReportRefresher({ db, claudeRunner: counting.runner })
    const [a, b] = await Promise.all([refresher.tick(), refresher.tick()])
    expect([a, b]).toEqual([true, true])
    expect(counting.calls).toBe(1)
  })

  test('start runs a tick immediately and schedules the periodic check; stop cancels it', async () => {
    const counting = countingRunner()
    const scheduled: { fn: () => void; ms: number }[] = []
    const cancelled: unknown[] = []
    const refresher = createDailyReportRefresher(
      { db, claudeRunner: counting.runner },
      {
        intervalMs: 1234,
        schedule: (fn, ms) => {
          scheduled.push({ fn, ms })
          return 'handle'
        },
        cancel: (handle) => cancelled.push(handle),
      }
    )
    refresher.start()
    refresher.start() // idempotent
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.ms).toBe(1234)
    await refresher.tick() // waits for the in-flight tick started by start()
    expect(counting.calls).toBe(1)

    scheduled[0]?.fn()
    await refresher.tick()
    expect(counting.calls).toBe(1) // same day → nothing new

    refresher.stop()
    refresher.stop()
    expect(cancelled).toEqual(['handle'])
  })

  test('an LLM failure still saves the counts and does not throw out of tick', async () => {
    const runner: ClaudeRunner = {
      analyze: async () => {
        throw new Error('claude down')
      },
      tidyGoal: async (body) => body,
    }
    const refresher = createDailyReportRefresher({ db, claudeRunner: runner })
    expect(await refresher.tick()).toBe(true)
    expect(reportRepo.getLatest(db)?.llmError).toBe('claude down')
  })
})
