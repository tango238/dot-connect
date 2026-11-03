import type { Database } from 'bun:sqlite'
import * as milestoneRepo from '../db/milestoneRepo'
import * as todoRepo from '../db/todoRepo'
import type { MilestoneWithProgress, Todo } from '../types'
import { addDaysLocal } from './localDate'
import { comparePriority, type Prioritized } from './priority'

// 週次レポートの「目標を生成」: その週に期限のあるマイルストーン・TODO と、
// 緊急度か重要度の高いものを DB から拾って、目標欄に入れる Markdown の
// 下書きを作る。LLM は使わない —— 何が拾われたかが決定的で、すぐ出る方が
// 目標の叩き台として使いやすい。整えたければ既存の「整理する」で。
//
// 「高い」の線引き: 緊急度か重要度のどちらかが 4 以上。旧 priority の「高」
// は緊急度 5 に移行しているので、そのまま拾われる。

export const HIGH_PRIORITY_THRESHOLD = 4
// 期限のない高優先度の候補は多くなりがちなので、上から数件に絞る。
export const MAX_PRIORITY_PICKS = 8

function isHighPriority(item: Prioritized): boolean {
  return item.urgency >= HIGH_PRIORITY_THRESHOLD || item.importance >= HIGH_PRIORITY_THRESHOLD
}

function md(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${m}/${d}`
}

function priorityNote(item: Prioritized): string {
  return item.urgency === 1 && item.importance === 1 ? '' : `、緊${item.urgency} 重${item.importance}`
}

function milestoneLine(m: MilestoneWithProgress): string {
  const pct = m.linkedCount ? Math.round((m.doneCount / m.linkedCount) * 100) : 0
  return `- [ ] ${m.title}(期限 ${md(m.targetDate)}、進捗 ${pct}%${priorityNote(m)})`
}

function todoLine(t: Todo): string {
  const due = t.dueDate ? `期日 ${md(t.dueDate)}` : '期日なし'
  const ms = t.milestoneTitle ? ` / ${t.milestoneTitle}` : ''
  return `- [ ] #${t.id} ${t.title}(${due}${ms}${priorityNote(t)})`
}

function byDateThenPriority<T extends Prioritized & { id: number }>(date: (item: T) => string) {
  return (a: T, b: T) => (date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : comparePriority(a, b) || a.id - b.id)
}

function section(heading: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return []
  return [`### ${heading}`, ...lines, '']
}

export interface WeeklyGoalDraft {
  readonly body: string
  // 下書きに載せた未完了 TODO の id(載せた順)。「今週終わらせるタスク」の
  // 並びに足すのに使う。
  readonly todoIds: readonly number[]
}

/**
 * weekStart(月曜)からの 1 週間の目標の下書き。today はローカル暦の今日
 * (期限超過の判定にだけ使う)。
 */
export function buildWeeklyGoalDraft(db: Database, weekStart: string, today: string): WeeklyGoalDraft {
  const weekEnd = addDaysLocal(weekStart, 6)
  const inWeek = (date: string | null): date is string => date !== null && date >= weekStart && date <= weekEnd
  const overdueBeforeWeek = (date: string | null): date is string => date !== null && date < weekStart && date < today

  const milestones = milestoneRepo.listAll(db).filter((m) => m.status !== 'done')
  const todos = todoRepo.listAll(db).filter((t) => t.status !== 'done')

  const dueMilestones = milestones.filter((m) => inWeek(m.targetDate)).sort(byDateThenPriority((m) => m.targetDate))
  const overdueMilestones = milestones
    .filter((m) => overdueBeforeWeek(m.targetDate))
    .sort(byDateThenPriority((m) => m.targetDate))
  const pickedMilestones = new Set([...dueMilestones, ...overdueMilestones].map((m) => m.id))
  const priorityMilestones = milestones
    .filter((m) => !pickedMilestones.has(m.id) && isHighPriority(m))
    .sort((a, b) => comparePriority(a, b) || (a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.id - b.id))

  const dueTodos = todos.filter((t) => inWeek(t.dueDate)).sort(byDateThenPriority((t) => t.dueDate as string))
  const overdueTodos = todos.filter((t) => overdueBeforeWeek(t.dueDate)).sort(byDateThenPriority((t) => t.dueDate as string))
  const pickedTodos = new Set([...dueTodos, ...overdueTodos].map((t) => t.id))
  const priorityTodos = todos
    .filter((t) => !pickedTodos.has(t.id) && isHighPriority(t))
    .sort((a, b) => comparePriority(a, b) || a.id - b.id)
    .slice(0, MAX_PRIORITY_PICKS)

  const lines: string[] = [`## 今週の目標(${md(weekStart)}〜${md(weekEnd)})`, '']
  lines.push(...section('期限が今週のマイルストーン', dueMilestones.map(milestoneLine)))
  lines.push(...section('期限超過のマイルストーン', overdueMilestones.map(milestoneLine)))
  lines.push(...section('優先度の高いマイルストーン', priorityMilestones.map(milestoneLine)))
  lines.push(...section('今週が期日のTODO', dueTodos.map(todoLine)))
  lines.push(...section('期限超過のTODO', overdueTodos.map(todoLine)))
  lines.push(...section('優先度の高いTODO', priorityTodos.map(todoLine)))
  if (lines.length === 2) {
    lines.push('- 今週に期限のあるマイルストーン・TODO、緊急度・重要度の高いものはありません。', '')
  }
  return {
    body: lines.join('\n').trimEnd(),
    todoIds: [...dueTodos, ...overdueTodos, ...priorityTodos].map((t) => t.id),
  }
}
