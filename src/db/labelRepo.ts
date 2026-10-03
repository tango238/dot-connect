import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { ConflictError } from '../services/errors'
import type { Label } from '../types'

const DEFAULT_COLOR = '#8b96a5'
const DUPLICATE_NAME_MESSAGE = '同じ名前のラベルが既にあります'

interface LabelRow {
  id: number
  name: string
  color: string
  created_at: string
  updated_at: string | null
}

function mapRow(row: LabelRow): Label {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// bun:sqlite throws a plain Error with a driver-level `code` on constraint
// violations rather than a dedicated exception class, so this is the only
// reliable way to distinguish "name already taken" from any other failure.
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export function listAll(db: Database): Label[] {
  const rows = db.query('SELECT * FROM labels ORDER BY name ASC').all() as LabelRow[]
  return rows.map(mapRow)
}

export function getById(db: Database, id: number): Label | null {
  const row = db.query('SELECT * FROM labels WHERE id = ?').get(id) as LabelRow | null
  return row ? mapRow(row) : null
}

export interface CreateLabelInput {
  readonly name: string
  readonly color?: string
}

export function create(db: Database, input: CreateLabelInput): Label {
  let result: { id: number }
  try {
    result = db
      .query('INSERT INTO labels (name, color) VALUES (?, ?) RETURNING id')
      .get(input.name, input.color ?? DEFAULT_COLOR) as { id: number }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(DUPLICATE_NAME_MESSAGE)
    }
    throw err
  }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load label ${result.id} immediately after insert`)
  }
  return created
}

export interface UpdateLabelInput {
  readonly name?: string
  readonly color?: string
}

export function update(db: Database, id: number, input: UpdateLabelInput): Label | null {
  if (getById(db, id) === null) {
    return null
  }

  const sets: string[] = []
  const values: SQLQueryBindings[] = []
  if (input.name !== undefined) {
    sets.push('name = ?')
    values.push(input.name)
  }
  if (input.color !== undefined) {
    sets.push('color = ?')
    values.push(input.color)
  }

  if (sets.length > 0) {
    sets.push(`updated_at = datetime('now')`)
    values.push(id)
    try {
      db.run(`UPDATE labels SET ${sets.join(', ')} WHERE id = ?`, values)
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(DUPLICATE_NAME_MESSAGE)
      }
      throw err
    }
  }

  return getById(db, id)
}

export interface RemoveLabelResult {
  readonly removed: boolean
  readonly unlinkedMilestones: number
}

export function remove(db: Database, id: number): RemoveLabelResult {
  if (getById(db, id) === null) {
    return { removed: false, unlinkedMilestones: 0 }
  }
  const countRow = db
    .query('SELECT COUNT(*) AS count FROM milestones WHERE label_id = ?')
    .get(id) as { count: number }
  db.run('DELETE FROM labels WHERE id = ?', [id])
  return { removed: true, unlinkedMilestones: countRow.count }
}
