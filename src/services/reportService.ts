import type { Database } from 'bun:sqlite'
import * as dispatchEventRepo from '../db/dispatchEventRepo'
import * as reportRepo from '../db/reportRepo'
import { logger } from '../logger'
import type { ClaudeRunner } from './claudeRunner'
import type { WeeklyReport } from '../types'

// Calendar math is deliberately done in local time throughout (matching
// SQLite's date(x, 'localtime') used in aggregateWeek/countInRange below):
// "the most recent Monday" and week boundaries are a human, local-calendar
// concept, while storage (datetime('now')) stays UTC.
function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDaysLocal(dateStr: string, days: number): string {
  const parts = dateStr.split('-').map(Number)
  const date = new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1)
  date.setDate(date.getDate() + days)
  return formatLocalDate(date)
}

export function mostRecentMonday(now: Date): string {
  const day = now.getDay() // 0 = Sunday .. 6 = Saturday, local time
  const diffToMonday = day === 0 ? 6 : day - 1
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday)
  return formatLocalDate(monday)
}

export interface WeeklyCounts {
  readonly completedCount: number
  readonly milestoneLinkedCount: number
  readonly unplannedCount: number
  readonly dispatchCount: number
}

interface AggregateRow {
  completed_count: number
  milestone_linked_count: number
}

export function aggregateWeek(db: Database, weekStart: string, weekEnd: string): WeeklyCounts {
  const row = db
    .query(
      `SELECT
         COUNT(*) AS completed_count,
         COUNT(CASE WHEN completed_milestone_id IS NOT NULL THEN 1 END) AS milestone_linked_count
       FROM todos
       WHERE status = 'done' AND completed_at IS NOT NULL
         AND date(completed_at, 'localtime') BETWEEN ? AND ?`
    )
    .get(weekStart, weekEnd) as AggregateRow

  const dispatchCount = dispatchEventRepo.countInRange(db, weekStart, weekEnd)

  return {
    completedCount: row.completed_count,
    milestoneLinkedCount: row.milestone_linked_count,
    unplannedCount: row.completed_count - row.milestone_linked_count,
    dispatchCount,
  }
}

export interface GenerateWeeklyReportOptions {
  readonly weekStart?: string
  readonly now?: Date
}

export async function generateWeeklyReport(
  db: Database,
  claudeRunner: ClaudeRunner,
  options: GenerateWeeklyReportOptions = {}
): Promise<WeeklyReport> {
  const weekStart = options.weekStart ?? mostRecentMonday(options.now ?? new Date())
  const weekEnd = addDaysLocal(weekStart, 6)
  const counts = aggregateWeek(db, weekStart, weekEnd)

  // The numeric aggregates are always meaningful and must always be saved,
  // even if the LLM analysis fails or times out (F6): surface the failure
  // via llmError instead of losing the whole report.
  let llmAnalysis = null
  let llmError: string | null = null
  try {
    llmAnalysis = await claudeRunner.analyze({ weekStart, weekEnd, ...counts })
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err)
    logger.warn('Weekly report LLM analysis failed; saving counts without it', {
      weekStart,
      message: llmError,
    })
  }

  return reportRepo.upsert(db, { weekStart, weekEnd, ...counts, llmAnalysis, llmError })
}
