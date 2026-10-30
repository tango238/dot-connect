import type { Database } from 'bun:sqlite'
import * as dispatchEventRepo from '../db/dispatchEventRepo'
import * as reportRepo from '../db/reportRepo'
import * as weeklyGoalRepo from '../db/weeklyGoalRepo'
import { logger } from '../logger'
import type { ClaudeRunner, WeeklyAggregateDetails } from './claudeRunner'
import type { WeeklyReport } from '../types'
import { addDaysLocal, formatLocalDate, mostRecentMonday } from './localDate'
import { computeWeeklyStats, type WeeklyStats } from './reportStatsService'

// Calendar math is deliberately done in local time throughout (matching
// SQLite's date(x, 'localtime') used in aggregateWeek/countInRange below):
// "the most recent Monday" and week boundaries are a human, local-calendar
// concept, while storage (datetime('now')) stays UTC. The helpers live in
// localDate.ts; mostRecentMonday is re-exported because callers and tests
// reach it through this module.
export { mostRecentMonday }

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

// LLM に渡す追加の材料。画面の統計(reportStatsService)から、文章で意味を
// 持つものだけを抜く —— 日別の山谷、速かった TODO、期日内率、前週比。
export function aggregateDetails(stats: WeeklyStats, goal: string | null): WeeklyAggregateDetails {
  return {
    goal,
    createdCount: stats.createdCount,
    previousWeek: stats.previous,
    daily: stats.daily,
    fastestCompleted: stats.fastest.map((todo) => ({
      title: todo.title,
      leadMinutes: todo.leadMinutes,
      milestone: todo.milestoneTitle,
    })),
    leadTime: stats.leadTime,
    onTime: stats.onTime,
    byPriority: stats.byPriority,
    byMilestone: stats.byMilestone.map((entry) => ({ title: entry.title, count: entry.count })),
    backlog: stats.backlog,
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
  const now = options.now ?? new Date()
  const weekStart = options.weekStart ?? mostRecentMonday(now)
  const weekEnd = addDaysLocal(weekStart, 6)
  const counts = aggregateWeek(db, weekStart, weekEnd)
  const goal = weeklyGoalRepo.getByWeekStart(db, weekStart)?.body.trim() || null
  const details = aggregateDetails(computeWeeklyStats(db, weekStart, formatLocalDate(now)), goal)

  // The numeric aggregates are always meaningful and must always be saved,
  // even if the LLM analysis fails or times out (F6): surface the failure
  // via llmError instead of losing the whole report.
  let llmAnalysis = null
  let llmError: string | null = null
  try {
    llmAnalysis = await claudeRunner.analyze({ weekStart, weekEnd, ...counts, details })
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err)
    logger.warn('Weekly report LLM analysis failed; saving counts without it', {
      weekStart,
      message: llmError,
    })
  }

  return reportRepo.upsert(db, { weekStart, weekEnd, ...counts, llmAnalysis, llmError })
}
