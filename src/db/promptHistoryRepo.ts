import type { Database } from 'bun:sqlite'
import type { PromptHistory } from '../types'
import { createRecencyHistory } from './recencyHistory'

const HISTORY_LIMIT = 50

// Dedup/cap/ordering all live in the shared helper — see recencyHistory.ts.
// This module only owns the table it maps to and the field name the API
// exposes it under (`body`).
const history = createRecencyHistory({
  table: 'prompt_history',
  valueColumn: 'body',
  limit: HISTORY_LIMIT,
})

export function listAll(db: Database): PromptHistory[] {
  return history.listAll(db).map((entry) => ({
    id: entry.id,
    body: entry.value,
    usedAt: entry.usedAt,
  }))
}

// Records a prompt body as just-used: re-using an existing prompt bumps it
// to the top rather than creating a second entry, and the table is capped at
// HISTORY_LIMIT rows.
export function recordUse(db: Database, body: string): void {
  history.recordUse(db, body)
}

export function removeAll(db: Database): number {
  return history.removeAll(db)
}
