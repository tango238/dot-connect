import type { Database } from 'bun:sqlite'

interface AppSettingRow {
  value: string
}

export function get(db: Database, key: string): string | null {
  const row = db.query('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | AppSettingRow
    | null
  return row ? row.value : null
}

export function set(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  )
}
