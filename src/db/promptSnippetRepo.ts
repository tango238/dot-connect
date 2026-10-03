import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { PromptSnippet } from '../types'

interface PromptSnippetRow {
  id: number
  title: string
  body: string
  created_at: string
  updated_at: string | null
}

function mapRow(row: PromptSnippetRow): PromptSnippet {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listAll(db: Database): PromptSnippet[] {
  const rows = db
    .query('SELECT * FROM prompt_snippets ORDER BY created_at ASC, id ASC')
    .all() as PromptSnippetRow[]
  return rows.map(mapRow)
}

export function getById(db: Database, id: number): PromptSnippet | null {
  const row = db.query('SELECT * FROM prompt_snippets WHERE id = ?').get(id) as PromptSnippetRow | null
  return row ? mapRow(row) : null
}

export interface CreateSnippetInput {
  readonly title: string
  readonly body: string
}

export function create(db: Database, input: CreateSnippetInput): PromptSnippet {
  const result = db
    .query('INSERT INTO prompt_snippets (title, body) VALUES (?, ?) RETURNING id')
    .get(input.title, input.body) as { id: number }
  const created = getById(db, result.id)
  if (!created) {
    throw new Error(`Failed to load prompt snippet ${result.id} immediately after insert`)
  }
  return created
}

export interface UpdateSnippetInput {
  readonly title?: string
  readonly body?: string
}

export function update(db: Database, id: number, input: UpdateSnippetInput): PromptSnippet | null {
  if (getById(db, id) === null) {
    return null
  }

  const sets: string[] = []
  const values: SQLQueryBindings[] = []

  if (input.title !== undefined) {
    sets.push('title = ?')
    values.push(input.title)
  }
  if (input.body !== undefined) {
    sets.push('body = ?')
    values.push(input.body)
  }

  if (sets.length > 0) {
    sets.push(`updated_at = datetime('now')`)
    values.push(id)
    db.run(`UPDATE prompt_snippets SET ${sets.join(', ')} WHERE id = ?`, values)
  }

  return getById(db, id)
}

export function remove(db: Database, id: number): boolean {
  const result = db.run('DELETE FROM prompt_snippets WHERE id = ?', [id])
  return result.changes > 0
}
