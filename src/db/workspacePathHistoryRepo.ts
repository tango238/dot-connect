import type { Database } from 'bun:sqlite'
import type { WorkspacePathHistory } from '../types'
import { createRecencyHistory } from './recencyHistory'

const HISTORY_LIMIT = 50

// The workspacePath counterpart to promptHistoryRepo — same dedup/cap/
// ordering rules, from the same shared helper (see recencyHistory.ts).
//
// Distinct from the `workspaces` table, which is a hand-curated list of
// named directories (the "snippet" side): this one is written automatically
// on every successful dispatch and holds bare paths with no name.
const history = createRecencyHistory({
  table: 'workspace_path_history',
  valueColumn: 'path',
  limit: HISTORY_LIMIT,
})

export function listAll(db: Database): WorkspacePathHistory[] {
  return history.listAll(db).map((entry) => ({
    id: entry.id,
    path: entry.value,
    usedAt: entry.usedAt,
  }))
}

export function recordUse(db: Database, path: string): void {
  history.recordUse(db, path)
}

export function removeAll(db: Database): number {
  return history.removeAll(db)
}
