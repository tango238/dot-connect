import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { Milestone, MilestoneStatus, MilestoneWithProgress } from '../types'
import { touchTodo } from './todoTouch'

interface MilestoneRow {
  id: number
  title: string
  description: string
  color: string
  start_date: string
  target_date: string
  status: MilestoneStatus
  done_at: string | null
  label_id: number | null
  label_name: string | null
  label_color: string | null
  created_at: string
}

interface MilestoneWithProgressRow extends MilestoneRow {
  linked_count: number
  done_count: number
}

// Shared column list (not `m.*`): label_name/label_color come from the
// joined labels table, and listing every milestone column explicitly keeps
// this and listAll's own SELECT from drifting apart.
const MILESTONE_COLUMNS = `
  m.id, m.title, m.description, m.color, m.start_date, m.target_date,
  m.status, m.done_at, m.label_id, l.name AS label_name, l.color AS label_color,
  m.created_at
`
const FROM_WITH_LABEL = `FROM milestones m LEFT JOIN labels l ON l.id = m.label_id`

function mapRow(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    color: row.color,
    startDate: row.start_date,
    targetDate: row.target_date,
    status: row.status,
    doneAt: row.done_at,
    labelId: row.label_id,
    labelName: row.label_name,
    labelColor: row.label_color,
    createdAt: row.created_at,
  }
}

function mapProgressRow(row: MilestoneWithProgressRow): MilestoneWithProgress {
  return {
    ...mapRow(row),
    linkedCount: row.linked_count,
    doneCount: row.done_count,
  }
}

export function listAll(db: Database): MilestoneWithProgress[] {
  const rows = db
    .query(
      `SELECT
         ${MILESTONE_COLUMNS},
         COUNT(t.id) AS linked_count,
         COUNT(CASE WHEN t.status = 'done' THEN 1 END) AS done_count
       ${FROM_WITH_LABEL}
       LEFT JOIN todos t ON t.milestone_id = m.id
       GROUP BY m.id
       ORDER BY m.id ASC`
    )
    .all() as MilestoneWithProgressRow[]
  return rows.map(mapProgressRow)
}

export function getById(db: Database, id: number): Milestone | null {
  const row = db
    .query(`SELECT ${MILESTONE_COLUMNS} ${FROM_WITH_LABEL} WHERE m.id = ?`)
    .get(id) as MilestoneRow | null
  return row ? mapRow(row) : null
}

export interface CreateMilestoneInput {
  readonly title: string
  readonly description?: string
  readonly color?: string
  readonly startDate: string
  readonly targetDate: string
  readonly labelId?: number | null
}

export function create(db: Database, input: CreateMilestoneInput): Milestone {
  const result = db
    .query(
      `INSERT INTO milestones (title, description, color, start_date, target_date, label_id)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      input.title,
      input.description ?? '',
      input.color ?? '#6ca4f8',
      input.startDate,
      input.targetDate,
      input.labelId ?? null
    ) as { id: number }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load milestone ${result.id} immediately after insert`)
  }
  return created
}

export interface UpdateMilestoneInput {
  readonly title?: string
  readonly description?: string
  readonly color?: string
  readonly startDate?: string
  readonly targetDate?: string
  // undefined leaves the label untouched; null explicitly unlinks it (same
  // convention as todos' milestoneId).
  readonly labelId?: number | null
}

const UPDATABLE_COLUMNS: Record<keyof UpdateMilestoneInput, string> = {
  title: 'title',
  description: 'description',
  color: 'color',
  startDate: 'start_date',
  targetDate: 'target_date',
  labelId: 'label_id',
}

export function update(db: Database, id: number, input: UpdateMilestoneInput): Milestone | null {
  if (getById(db, id) === null) {
    return null
  }

  const sets: string[] = []
  const values: SQLQueryBindings[] = []
  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS) as [
    keyof UpdateMilestoneInput,
    string,
  ][]) {
    const value = input[key]
    if (value !== undefined) {
      sets.push(`${column} = ?`)
      values.push(value)
    }
  }

  if (sets.length > 0) {
    values.push(id)
    db.run(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  return getById(db, id)
}

export function countOpenTodos(db: Database, milestoneId: number): number {
  const row = db
    .query(`SELECT COUNT(*) AS count FROM todos WHERE milestone_id = ? AND status != 'done'`)
    .get(milestoneId) as { count: number }
  return row.count
}

export function complete(db: Database, id: number): Milestone | null {
  if (getById(db, id) === null) {
    return null
  }
  db.run(`UPDATE milestones SET status = 'done', done_at = datetime('now') WHERE id = ?`, [id])
  return getById(db, id)
}

export function reopen(db: Database, id: number): Milestone | null {
  if (getById(db, id) === null) {
    return null
  }
  db.run(`UPDATE milestones SET status = 'active', done_at = NULL WHERE id = ?`, [id])
  return getById(db, id)
}

export interface RemoveMilestoneResult {
  readonly removed: boolean
  readonly unlinkedCount: number
}

export function remove(db: Database, id: number): RemoveMilestoneResult {
  if (getById(db, id) === null) {
    return { removed: false, unlinkedCount: 0 }
  }
  // 件数ではなくidを控えるのは、削除後に紐付けを解かれたTODOを touch する
  // ため。カスケード(ON DELETE SET NULL)は SQLite 側で起きるので、削除して
  // からでは milestone_id を辿って対象を見つけ直せない。
  //
  // TODOの最終更新に数える理由: 画面のマイルストーンチップが消える、目に
  // 見える編集だから(方針は todoTouch.ts)。
  const unlinked = db.query(`SELECT id FROM todos WHERE milestone_id = ?`).all(id) as {
    id: number
  }[]
  db.transaction(() => {
    db.run(`DELETE FROM milestones WHERE id = ?`, [id])
    for (const todo of unlinked) {
      touchTodo(db, todo.id)
    }
  })()
  return { removed: true, unlinkedCount: unlinked.length }
}
