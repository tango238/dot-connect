import type { Database } from 'bun:sqlite'
import type { LlmAnalysis, WeeklyReport } from '../types'

interface WeeklyReportRow {
  id: number
  week_start: string
  week_end: string
  completed_count: number
  milestone_linked_count: number
  unplanned_count: number
  dispatch_count: number
  llm_analysis: string | null
  llm_error: string | null
  generated_at: string
}

function mapRow(row: WeeklyReportRow): WeeklyReport {
  return {
    id: row.id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    completedCount: row.completed_count,
    milestoneLinkedCount: row.milestone_linked_count,
    unplannedCount: row.unplanned_count,
    dispatchCount: row.dispatch_count,
    llmAnalysis: row.llm_analysis ? (JSON.parse(row.llm_analysis) as LlmAnalysis) : null,
    llmError: row.llm_error,
    generatedAt: row.generated_at,
  }
}

export function getByWeekStart(db: Database, weekStart: string): WeeklyReport | null {
  const row = db
    .query(`SELECT * FROM weekly_reports WHERE week_start = ?`)
    .get(weekStart) as WeeklyReportRow | null
  return row ? mapRow(row) : null
}

export function getLatest(db: Database): WeeklyReport | null {
  const row = db
    .query(`SELECT * FROM weekly_reports ORDER BY week_start DESC LIMIT 1`)
    .get() as WeeklyReportRow | null
  return row ? mapRow(row) : null
}

export interface UpsertWeeklyReportInput {
  readonly weekStart: string
  readonly weekEnd: string
  readonly completedCount: number
  readonly milestoneLinkedCount: number
  readonly unplannedCount: number
  readonly dispatchCount: number
  readonly llmAnalysis: LlmAnalysis | null
  readonly llmError?: string | null
}

export function upsert(db: Database, input: UpsertWeeklyReportInput): WeeklyReport {
  const llmAnalysisJson = input.llmAnalysis ? JSON.stringify(input.llmAnalysis) : null
  const llmError = input.llmError ?? null
  const row = db
    .query(
      `INSERT INTO weekly_reports (
         week_start, week_end, completed_count, milestone_linked_count,
         unplanned_count, dispatch_count, llm_analysis, llm_error, generated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(week_start) DO UPDATE SET
         week_end = excluded.week_end,
         completed_count = excluded.completed_count,
         milestone_linked_count = excluded.milestone_linked_count,
         unplanned_count = excluded.unplanned_count,
         dispatch_count = excluded.dispatch_count,
         llm_analysis = excluded.llm_analysis,
         llm_error = excluded.llm_error,
         generated_at = datetime('now')
       RETURNING *`
    )
    .get(
      input.weekStart,
      input.weekEnd,
      input.completedCount,
      input.milestoneLinkedCount,
      input.unplannedCount,
      input.dispatchCount,
      llmAnalysisJson,
      llmError
    ) as WeeklyReportRow
  return mapRow(row)
}
