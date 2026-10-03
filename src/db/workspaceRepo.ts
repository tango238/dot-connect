import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { ConflictError } from '../services/errors'
import type { Workspace } from '../types'

const DUPLICATE_NAME_MESSAGE = '同じ名前の作業ディレクトリが既にあります'

interface WorkspaceRow {
  id: number
  name: string
  path: string
  created_at: string
  updated_at: string | null
}

function mapRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// bun:sqlite throws a plain Error with a driver-level `code` on constraint
// violations rather than a dedicated exception class, so this is the only
// reliable way to distinguish "name already taken" from any other failure
// (same approach as labelRepo.ts).
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && (err as Error & { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export function listAll(db: Database): Workspace[] {
  const rows = db.query('SELECT * FROM workspaces ORDER BY name ASC').all() as WorkspaceRow[]
  return rows.map(mapRow)
}

export function getById(db: Database, id: number): Workspace | null {
  const row = db.query('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | null
  return row ? mapRow(row) : null
}

export interface CreateWorkspaceInput {
  readonly name: string
  readonly path: string
}

export function create(db: Database, input: CreateWorkspaceInput): Workspace {
  let result: { id: number }
  try {
    result = db
      .query('INSERT INTO workspaces (name, path) VALUES (?, ?) RETURNING id')
      .get(input.name, input.path) as { id: number }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(DUPLICATE_NAME_MESSAGE)
    }
    throw err
  }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load workspace ${result.id} immediately after insert`)
  }
  return created
}

export interface UpdateWorkspaceInput {
  readonly name?: string
  readonly path?: string
}

export function update(db: Database, id: number, input: UpdateWorkspaceInput): Workspace | null {
  if (getById(db, id) === null) {
    return null
  }

  const sets: string[] = []
  const values: SQLQueryBindings[] = []
  if (input.name !== undefined) {
    sets.push('name = ?')
    values.push(input.name)
  }
  if (input.path !== undefined) {
    sets.push('path = ?')
    values.push(input.path)
  }

  if (sets.length > 0) {
    sets.push(`updated_at = datetime('now')`)
    values.push(id)
    try {
      db.run(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`, values)
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictError(DUPLICATE_NAME_MESSAGE)
      }
      throw err
    }
  }

  return getById(db, id)
}

// TODOs never reference a workspace by id — workspace_path is (and stays) a
// plain string copy, taken at the time it was set — so removing a registered
// workspace here has no effect on any TODO that already used its path (see
// types.ts's Workspace doc comment).
export function remove(db: Database, id: number): boolean {
  const result = db.run('DELETE FROM workspaces WHERE id = ?', [id])
  return result.changes > 0
}
