import type { Database, SQLQueryBindings } from 'bun:sqlite'
import * as appSettingsRepo from './appSettingsRepo'

// 同期する Google カレンダー(iCal 非公開 URL)の一覧と、取得した ICS の
// キャッシュ。URL は実質的な認証情報(知っていれば誰でも予定を読める)なので、
// 返す先は同一オリジンのブラウザ UI だけ(calendarRoutes.ts)。
//
// キャッシュ(calendar_cache)は起動直後やオフラインでも前回の予定を出すため。
// カレンダーを消せば CASCADE で一緒に消える。

export interface CalendarSource {
  readonly id: number
  readonly name: string
  readonly url: string
  readonly color: string
  readonly createdAt: string
}

export interface CalendarCache {
  readonly ics: string
  readonly fetchedAt: string
}

interface CalendarRow {
  id: number
  name: string
  url: string
  color: string
  created_at: string
}

// 追加順に回す既定色。マイルストーンの既定色とは別系統にして、タイムライン
// 上で TODO(マイルストーン色)と混ざらないようにする。
export const CALENDAR_PALETTE: readonly string[] = ['#8b96a5', '#6ca4f8', '#d29af5', '#f0a35e', '#4ac26b', '#e3b341', '#f85149']

function mapRow(row: CalendarRow): CalendarSource {
  return { id: row.id, name: row.name, url: row.url, color: row.color, createdAt: row.created_at }
}

export function listAll(db: Database): CalendarSource[] {
  const rows = db.query(`SELECT * FROM calendars ORDER BY id ASC`).all() as CalendarRow[]
  return rows.map(mapRow)
}

export function getById(db: Database, id: number): CalendarSource | null {
  const row = db.query(`SELECT * FROM calendars WHERE id = ?`).get(id) as CalendarRow | null
  return row ? mapRow(row) : null
}

/** 次に追加するカレンダーに割り当てる色(パレットを追加順に回す)。 */
export function nextColor(db: Database): string {
  const { n } = db.query(`SELECT COUNT(*) AS n FROM calendars`).get() as { n: number }
  return CALENDAR_PALETTE[n % CALENDAR_PALETTE.length] as string
}

export interface CreateCalendarInput {
  readonly name: string
  readonly url: string
  readonly color?: string
}

export function create(db: Database, input: CreateCalendarInput): CalendarSource {
  const row = db
    .query(`INSERT INTO calendars (name, url, color) VALUES (?, ?, ?) RETURNING *`)
    .get(input.name, input.url, input.color ?? nextColor(db)) as CalendarRow
  return mapRow(row)
}

export interface UpdateCalendarInput {
  readonly name?: string
  readonly url?: string
  readonly color?: string
}

export function update(db: Database, id: number, input: UpdateCalendarInput): CalendarSource | null {
  if (getById(db, id) === null) return null
  const sets: string[] = []
  const values: SQLQueryBindings[] = []
  for (const key of ['name', 'url', 'color'] as const) {
    const value = input[key]
    if (value !== undefined) {
      sets.push(`${key} = ?`)
      values.push(value)
    }
  }
  if (sets.length > 0) {
    values.push(id)
    db.run(`UPDATE calendars SET ${sets.join(', ')} WHERE id = ?`, values)
  }
  return getById(db, id)
}

export function remove(db: Database, id: number): boolean {
  if (getById(db, id) === null) return false
  db.run(`DELETE FROM calendars WHERE id = ?`, [id])
  return true
}

export function getCache(db: Database, calendarId: number): CalendarCache | null {
  const row = db.query(`SELECT ics, fetched_at FROM calendar_cache WHERE calendar_id = ?`).get(calendarId) as
    | { ics: string; fetched_at: string }
    | null
  return row ? { ics: row.ics, fetchedAt: row.fetched_at } : null
}

export function setCache(db: Database, calendarId: number, cache: CalendarCache): void {
  db.run(
    `INSERT INTO calendar_cache (calendar_id, ics, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(calendar_id) DO UPDATE SET ics = excluded.ics, fetched_at = excluded.fetched_at`,
    [calendarId, cache.ics, cache.fetchedAt]
  )
}

export function clearCache(db: Database, calendarId: number): void {
  db.run(`DELETE FROM calendar_cache WHERE calendar_id = ?`, [calendarId])
}

// 最初の版は URL を 1 本だけ app_settings に持っていた。calendars テーブルが
// 空で、その設定が残っていれば 1 件目のカレンダーとして移し、キャッシュも
// 引き継ぐ。移したら旧キーは消す(二度と動かない)。
const LEGACY_URL_KEY = 'calendar_ics_url'
const LEGACY_CACHE_KEY = 'calendar_ics_cache'
const LEGACY_FETCHED_AT_KEY = 'calendar_ics_fetched_at'

export function migrateLegacySingleCalendar(db: Database): void {
  const url = appSettingsRepo.get(db, LEGACY_URL_KEY)
  if (!url || url.trim() === '') return
  const { n } = db.query(`SELECT COUNT(*) AS n FROM calendars`).get() as { n: number }
  db.transaction(() => {
    if (n === 0) {
      const created = create(db, { name: 'Google カレンダー', url })
      const ics = appSettingsRepo.get(db, LEGACY_CACHE_KEY)
      const fetchedAt = appSettingsRepo.get(db, LEGACY_FETCHED_AT_KEY)
      if (ics && fetchedAt) setCache(db, created.id, { ics, fetchedAt })
    }
    for (const key of [LEGACY_URL_KEY, LEGACY_CACHE_KEY, LEGACY_FETCHED_AT_KEY]) {
      db.run(`DELETE FROM app_settings WHERE key = ?`, [key])
    }
  })()
}
