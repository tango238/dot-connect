import type { Database } from 'bun:sqlite'

// Shared implementation of the "recently used values" list that both the
// prompt history and the workspacePath history are: a single-value log,
// newest first, deduplicated by bumping an existing value back to the top
// rather than appending a second row, and capped at a fixed size.
//
// Table and column names are interpolated into the SQL here, so every caller
// MUST pass compile-time literals — these names are never derived from
// request input (the two callers below are the only ones, and both pass
// constants).

export interface RecencyEntry {
  readonly id: number
  readonly value: string
  readonly usedAt: string
}

export interface RecencyHistory {
  listAll(db: Database): RecencyEntry[]
  recordUse(db: Database, value: string): void
  removeAll(db: Database): number
}

export interface RecencyHistoryOptions {
  readonly table: string
  readonly valueColumn: string
  readonly limit: number
}

interface RecencyRow {
  id: number
  value: string
  used_at: string
}

export function createRecencyHistory(options: RecencyHistoryOptions): RecencyHistory {
  const { table, valueColumn, limit } = options
  // `used_at` has only second-level resolution (SQLite's datetime('now')),
  // so ties are broken by id — recordUse always inserts a fresh (higher) id
  // even when deduplicating an existing value, so `id DESC` reflects true
  // recency.
  const orderByRecency = 'ORDER BY used_at DESC, id DESC'

  return {
    listAll(db) {
      const rows = db
        .query(
          `SELECT id, ${valueColumn} AS value, used_at FROM ${table} ${orderByRecency} LIMIT ${limit}`
        )
        .all() as RecencyRow[]
      return rows.map((row) => ({ id: row.id, value: row.value, usedAt: row.used_at }))
    },

    // Wrapped in a transaction so a failure partway through can't leave a
    // duplicate, or a table left over the cap, behind.
    recordUse(db, value) {
      const record = db.transaction(() => {
        db.run(`DELETE FROM ${table} WHERE ${valueColumn} = ?`, [value])
        db.run(`INSERT INTO ${table} (${valueColumn}, used_at) VALUES (?, datetime('now'))`, [value])
        db.run(
          `DELETE FROM ${table} WHERE id NOT IN (
             SELECT id FROM ${table} ${orderByRecency} LIMIT ${limit}
           )`
        )
      })
      record()
    },

    removeAll(db) {
      return db.run(`DELETE FROM ${table}`).changes
    },
  }
}
