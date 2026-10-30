import type { Database } from 'bun:sqlite'
import * as dispatchEventRepo from '../db/dispatchEventRepo'
import type { TodoPriority } from '../types'
import { addDaysLocal } from './localDate'

// 週次レポートの「数値」部分。保存せず毎回 DB から集計するので、画面を開く
// たび・TODO が動くたびに最新になる(保存されるのは LLM 分析だけ —
// reportService.ts)。日付の比較はすべてローカル暦(date(x, 'localtime'))。

export interface DailyStat {
  readonly date: string
  readonly created: number
  readonly completed: number
}

export interface FastTodo {
  readonly id: number
  readonly title: string
  readonly priority: TodoPriority
  readonly milestoneTitle: string | null
  readonly createdAt: string
  readonly completedAt: string
  /** 登録から完了までの分数(負になる壊れたデータは 0 に丸める)。 */
  readonly leadMinutes: number
}

export interface MilestoneStat {
  readonly milestoneId: number | null
  readonly title: string
  readonly color: string | null
  readonly count: number
}

export interface WeeklyStats {
  readonly weekStart: string
  readonly weekEnd: string
  readonly completedCount: number
  readonly createdCount: number
  readonly dispatchCount: number
  readonly milestoneLinkedCount: number
  readonly unplannedCount: number
  /** 前週の同じ数字(増減の表示用)。 */
  readonly previous: {
    readonly completedCount: number
    readonly createdCount: number
    readonly dispatchCount: number
  }
  /** 月曜から日曜の 7 日分、必ず 7 要素。 */
  readonly daily: readonly DailyStat[]
  /** 登録→完了が速かった順に最大 5 件。 */
  readonly fastest: readonly FastTodo[]
  readonly leadTime: {
    readonly averageMinutes: number | null
    readonly medianMinutes: number | null
  }
  /** その週に完了した TODO のうち期日があったもの、うち期日内に完了した数。 */
  readonly onTime: {
    readonly withDueCount: number
    readonly onTimeCount: number
  }
  readonly byPriority: Readonly<Record<TodoPriority, number>>
  /** 完了数の多いマイルストーン順に最大 5 件(完了時点の所属で数える)。 */
  readonly byMilestone: readonly MilestoneStat[]
  /** 集計時点(週ではなく「いま」)の未完了の状況。 */
  readonly backlog: {
    readonly openCount: number
    readonly overdueCount: number
    readonly dueThisWeekCount: number
  }
}

// すべてのクエリが todos を `t` の別名で参照する(milestones と結合する
// ものがあり、status などの列名が両方にあるため)。
const COMPLETED_IN_RANGE = `t.status = 'done' AND t.completed_at IS NOT NULL AND date(t.completed_at, 'localtime') BETWEEN ? AND ?`
const CREATED_IN_RANGE = `date(t.created_at, 'localtime') BETWEEN ? AND ?`

export const UNPLANNED_MILESTONE_TITLE = 'マイルストーンなし'
export const DELETED_MILESTONE_TITLE = '削除済みマイルストーン'
export const FASTEST_LIMIT = 5
export const MILESTONE_LIMIT = 5

function countCompleted(db: Database, start: string, end: string): { completed: number; linked: number } {
  const row = db
    .query(
      `SELECT COUNT(*) AS completed,
              COUNT(CASE WHEN t.completed_milestone_id IS NOT NULL THEN 1 END) AS linked
       FROM todos t WHERE ${COMPLETED_IN_RANGE}`
    )
    .get(start, end) as { completed: number; linked: number }
  return row
}

function countCreated(db: Database, start: string, end: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS count FROM todos t WHERE ${CREATED_IN_RANGE}`)
    .get(start, end) as { count: number }
  return row.count
}

function dailyStats(db: Database, weekStart: string, weekEnd: string): DailyStat[] {
  const created = new Map<string, number>()
  const completed = new Map<string, number>()
  for (const row of db
    .query(
      `SELECT date(t.created_at, 'localtime') AS day, COUNT(*) AS count
       FROM todos t WHERE ${CREATED_IN_RANGE} GROUP BY day`
    )
    .all(weekStart, weekEnd) as { day: string; count: number }[]) {
    created.set(row.day, row.count)
  }
  for (const row of db
    .query(
      `SELECT date(t.completed_at, 'localtime') AS day, COUNT(*) AS count
       FROM todos t WHERE ${COMPLETED_IN_RANGE} GROUP BY day`
    )
    .all(weekStart, weekEnd) as { day: string; count: number }[]) {
    completed.set(row.day, row.count)
  }
  const days: DailyStat[] = []
  for (let i = 0; i < 7; i++) {
    const date = addDaysLocal(weekStart, i)
    days.push({ date, created: created.get(date) ?? 0, completed: completed.get(date) ?? 0 })
  }
  return days
}

function clampLead(minutes: number): number {
  return Math.max(0, Math.round(minutes))
}

interface FastRow {
  id: number
  title: string
  priority: TodoPriority
  milestone_title: string | null
  created_at: string
  completed_at: string
  lead_minutes: number
}

function fastestTodos(db: Database, weekStart: string, weekEnd: string): FastTodo[] {
  const rows = db
    .query(
      `SELECT t.id, t.title, t.priority, m.title AS milestone_title, t.created_at, t.completed_at,
              (julianday(t.completed_at) - julianday(t.created_at)) * 1440 AS lead_minutes
       FROM todos t
       LEFT JOIN milestones m ON m.id = t.completed_milestone_id
       WHERE ${COMPLETED_IN_RANGE}
       ORDER BY lead_minutes ASC, t.id ASC
       LIMIT ${FASTEST_LIMIT}`
    )
    .all(weekStart, weekEnd) as FastRow[]
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    milestoneTitle: row.milestone_title,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    leadMinutes: clampLead(row.lead_minutes),
  }))
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

function leadTimeStats(db: Database, weekStart: string, weekEnd: string): WeeklyStats['leadTime'] {
  const leads = (
    db
      .query(
        `SELECT (julianday(t.completed_at) - julianday(t.created_at)) * 1440 AS lead_minutes
         FROM todos t WHERE ${COMPLETED_IN_RANGE}`
      )
      .all(weekStart, weekEnd) as { lead_minutes: number }[]
  ).map((row) => clampLead(row.lead_minutes))
  if (leads.length === 0) return { averageMinutes: null, medianMinutes: null }
  const total = leads.reduce((sum, value) => sum + value, 0)
  return { averageMinutes: Math.round(total / leads.length), medianMinutes: Math.round(median(leads) as number) }
}

function onTimeStats(db: Database, weekStart: string, weekEnd: string): WeeklyStats['onTime'] {
  const row = db
    .query(
      `SELECT COUNT(*) AS with_due,
              COUNT(CASE WHEN date(t.completed_at, 'localtime') <= t.due_date THEN 1 END) AS on_time
       FROM todos t WHERE ${COMPLETED_IN_RANGE} AND t.due_date IS NOT NULL`
    )
    .get(weekStart, weekEnd) as { with_due: number; on_time: number }
  return { withDueCount: row.with_due, onTimeCount: row.on_time }
}

function byPriorityStats(db: Database, weekStart: string, weekEnd: string): Record<TodoPriority, number> {
  const counts: Record<TodoPriority, number> = { high: 0, low: 0, none: 0 }
  for (const row of db
    .query(`SELECT t.priority, COUNT(*) AS count FROM todos t WHERE ${COMPLETED_IN_RANGE} GROUP BY t.priority`)
    .all(weekStart, weekEnd) as { priority: TodoPriority; count: number }[]) {
    counts[row.priority] = row.count
  }
  return counts
}

function byMilestoneStats(db: Database, weekStart: string, weekEnd: string): MilestoneStat[] {
  const rows = db
    .query(
      `SELECT t.completed_milestone_id AS milestone_id, m.title, m.color, COUNT(*) AS count
       FROM todos t
       LEFT JOIN milestones m ON m.id = t.completed_milestone_id
       WHERE ${COMPLETED_IN_RANGE}
       GROUP BY t.completed_milestone_id
       ORDER BY count DESC, milestone_id ASC
       LIMIT ${MILESTONE_LIMIT}`
    )
    .all(weekStart, weekEnd) as { milestone_id: number | null; title: string | null; color: string | null; count: number }[]
  return rows.map((row) => ({
    milestoneId: row.milestone_id,
    title: row.milestone_id === null ? UNPLANNED_MILESTONE_TITLE : (row.title ?? DELETED_MILESTONE_TITLE),
    color: row.color,
    count: row.count,
  }))
}

function backlogStats(db: Database, today: string, weekStart: string, weekEnd: string): WeeklyStats['backlog'] {
  const row = db
    .query(
      `SELECT COUNT(*) AS open_count,
              COUNT(CASE WHEN t.due_date < ? THEN 1 END) AS overdue_count,
              COUNT(CASE WHEN t.due_date BETWEEN ? AND ? THEN 1 END) AS due_this_week
       FROM todos t WHERE t.status = 'open'`
    )
    .get(today, weekStart, weekEnd) as { open_count: number; overdue_count: number; due_this_week: number }
  return { openCount: row.open_count, overdueCount: row.overdue_count, dueThisWeekCount: row.due_this_week }
}

/**
 * `today` はローカル暦の YYYY-MM-DD。backlog の「期限切れ」の基準にだけ使う
 * (過去の週を見ていても未完了の状況は「いま」のもの)。
 */
export function computeWeeklyStats(db: Database, weekStart: string, today: string): WeeklyStats {
  const weekEnd = addDaysLocal(weekStart, 6)
  const prevStart = addDaysLocal(weekStart, -7)
  const prevEnd = addDaysLocal(weekStart, -1)

  const completed = countCompleted(db, weekStart, weekEnd)
  const previousCompleted = countCompleted(db, prevStart, prevEnd)

  return {
    weekStart,
    weekEnd,
    completedCount: completed.completed,
    createdCount: countCreated(db, weekStart, weekEnd),
    dispatchCount: dispatchEventRepo.countInRange(db, weekStart, weekEnd),
    milestoneLinkedCount: completed.linked,
    unplannedCount: completed.completed - completed.linked,
    previous: {
      completedCount: previousCompleted.completed,
      createdCount: countCreated(db, prevStart, prevEnd),
      dispatchCount: dispatchEventRepo.countInRange(db, prevStart, prevEnd),
    },
    daily: dailyStats(db, weekStart, weekEnd),
    fastest: fastestTodos(db, weekStart, weekEnd),
    leadTime: leadTimeStats(db, weekStart, weekEnd),
    onTime: onTimeStats(db, weekStart, weekEnd),
    byPriority: byPriorityStats(db, weekStart, weekEnd),
    byMilestone: byMilestoneStats(db, weekStart, weekEnd),
    backlog: backlogStats(db, today, weekStart, weekEnd),
  }
}
