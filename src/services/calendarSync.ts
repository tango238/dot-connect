import type { Database } from 'bun:sqlite'
import * as calendarRepo from '../db/calendarRepo'
import type { CalendarSource } from '../db/calendarRepo'
import { logger } from '../logger'
import {
  addDays,
  eventsOnDate,
  expandIcs,
  localZone,
  toLocalDateTime,
  type CalendarDayEvent,
  type CalendarOccurrence,
} from './calendarIcs'

// 登録された Google カレンダー(iCal 形式の非公開 URL)を定期的に取りに行き、
// 展開した予定をカレンダーごとにメモリに持つ。スケジュールページはここから
// 日ごとの予定を読む(どのカレンダーの予定かと、その色付き)。
//
// URL は実質的な認証情報(URL を知っていれば誰でも予定を読める)なので、
// ログにもエラーメッセージにも出さない。設定画面(同一オリジンのブラウザ
// UI だけが読める)には編集用に返す。
//
// 取れた ICS の本文は calendar_cache に残す。起動直後やオフラインのときも
// 前回の予定が出せるようにするためで、起動時はまずそれを展開し、その後
// 裏で取り直す。Google 側のフィード更新には数分〜数時間の遅れがあるので、
// 取得間隔を縮めても「いま入れた予定がすぐ出る」とは限らない。

export const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000
export const FETCH_TIMEOUT_MS = 20_000
export const MAX_ICS_BYTES = 20 * 1024 * 1024
export const MAX_ICS_URL_LENGTH = 2000
export const MAX_CALENDAR_NAME_LENGTH = 50
// 繰り返し予定を展開する窓: 今日からこの日数だけ前後。窓の外の日は予定が
// 無いように見えるので、status に窓を含めて UI が「範囲外」と言えるようにする。
export const WINDOW_DAYS_BEFORE = 90
export const WINDOW_DAYS_AFTER = 365

export interface CalendarSourceStatus {
  readonly id: number
  readonly name: string
  readonly color: string
  // 最後に取得に成功した時刻(ISO 8601、UTC)。まだなら null。
  readonly fetchedAt: string | null
  // 最後の取得・解釈の失敗。成功すると消える。
  readonly error: string | null
  readonly eventCount: number
  readonly refreshing: boolean
}

export interface CalendarStatus {
  // 1 件以上登録されているか。
  readonly configured: boolean
  readonly calendars: readonly CalendarSourceStatus[]
  readonly refreshing: boolean
  readonly windowFrom: string | null
  readonly windowTo: string | null
}

// スケジュールページに返す予定: どのカレンダーのものかと、その色。
export interface CalendarEvent extends CalendarDayEvent {
  readonly calendarId: number
  readonly calendarName: string
  readonly color: string
}

export interface CalendarSync {
  status(): CalendarStatus
  /** 設定画面向け: 登録一覧(URL 込み)と状態。 */
  sources(): (CalendarSource & { readonly status: CalendarSourceStatus })[]
  eventsOn(date: string): CalendarEvent[]
  /** いま取りに行く(id を省けば全部)。実行中ならそれを待つ。 */
  refresh(id?: number): Promise<CalendarStatus>
  addCalendar(input: { name: string; url: string; color?: string }): Promise<CalendarSourceStatus>
  /** null は「そのカレンダーは無い」。URL が変われば取り直す。 */
  updateCalendar(id: number, patch: { name?: string; url?: string; color?: string }): Promise<CalendarSourceStatus | null>
  removeCalendar(id: number): Promise<boolean>
  start(): void
  stop(): void
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface CalendarSyncDeps {
  readonly db: Database
  readonly fetch?: FetchFn
}

export interface CalendarSyncOptions {
  readonly intervalMs?: number
  readonly now?: () => Date
  readonly zone?: string
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
}

export type NormalizedIcsUrl = { readonly url: string } | { readonly error: string }

const INVALID_URL_MESSAGE =
  'iCal の URL は https:// または webcal:// で始まるものを指定してください(Google カレンダーの設定「iCal 形式の非公開 URL」)'

/**
 * 設定画面から来た文字列を保存する形に整える。webcal:// は https:// に
 * 読み替える(Google が配るのは https だが、他のカレンダーアプリからコピー
 * すると webcal になっていることがある)。
 */
export function normalizeIcsUrl(raw: string): NormalizedIcsUrl {
  const trimmed = raw.trim()
  if (trimmed === '') return { error: 'iCal の URL を入力してください' }
  if (trimmed.length > MAX_ICS_URL_LENGTH) return { error: 'iCal の URL が長すぎます' }
  const candidate = trimmed.replace(/^webcal:\/\//i, 'https://')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { error: INVALID_URL_MESSAGE }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: INVALID_URL_MESSAGE }
  }
  return { url: parsed.toString() }
}

// URL がエラーメッセージに混ざらないように消す。fetch の失敗メッセージには
// 通常 URL は入らないが、念のため。
function scrub(message: string, url: string): string {
  return message.split(url).join('<url>')
}

interface SourceState {
  occurrences: CalendarOccurrence[]
  fetchedAt: string | null
  error: string | null
  inFlight: Promise<void> | null
}

export function createCalendarSync(deps: CalendarSyncDeps, options: CalendarSyncOptions = {}): CalendarSync {
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init))
  const intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  const zone = options.zone ?? localZone()
  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))

  const states = new Map<number, SourceState>()
  let windowFrom: string | null = null
  let windowTo: string | null = null
  let timer: unknown = null

  function stateOf(id: number): SourceState {
    let state = states.get(id)
    if (!state) {
      state = { occurrences: [], fetchedAt: null, error: null, inFlight: null }
      states.set(id, state)
    }
    return state
  }

  // 展開は「今日」を基準にした窓で行うので、同じ ICS でも日が変われば結果が
  // 変わる。定期取得のたびに展開し直すから、窓は自然に進む。
  function expand(text: string): CalendarOccurrence[] {
    const today = toLocalDateTime(now(), zone).slice(0, 10)
    const from = addDays(today, -WINDOW_DAYS_BEFORE)
    const to = addDays(today, WINDOW_DAYS_AFTER)
    const occurrences = expandIcs(text, { from, to, zone })
    windowFrom = from
    windowTo = to
    return occurrences
  }

  function sourceStatus(source: CalendarSource): CalendarSourceStatus {
    const state = stateOf(source.id)
    return {
      id: source.id,
      name: source.name,
      color: source.color,
      fetchedAt: state.fetchedAt,
      error: state.error,
      eventCount: state.occurrences.length,
      refreshing: state.inFlight !== null,
    }
  }

  function status(): CalendarStatus {
    const calendars = calendarRepo.listAll(deps.db).map(sourceStatus)
    return {
      configured: calendars.length > 0,
      calendars,
      refreshing: calendars.some((c) => c.refreshing),
      windowFrom,
      windowTo,
    }
  }

  function loadCache(source: CalendarSource): void {
    const state = stateOf(source.id)
    const cache = calendarRepo.getCache(deps.db, source.id)
    if (!cache) return
    try {
      state.occurrences = expand(cache.ics)
      state.fetchedAt = cache.fetchedAt
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
    }
  }

  async function download(target: string): Promise<string> {
    let res: Response
    try {
      res = await fetchFn(target, {
        redirect: 'follow',
        headers: { accept: 'text/calendar, */*;q=0.5' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`取得がタイムアウトしました(${FETCH_TIMEOUT_MS / 1000}秒)`)
      }
      throw new Error(`取得に失敗しました: ${scrub(err instanceof Error ? err.message : String(err), target)}`)
    }
    if (!res.ok) {
      throw new Error(`取得に失敗しました (HTTP ${res.status})`)
    }
    const body = await res.arrayBuffer()
    if (body.byteLength > MAX_ICS_BYTES) {
      throw new Error(`ICS が大きすぎます(${Math.round(MAX_ICS_BYTES / 1024 / 1024)}MB 超)`)
    }
    return new TextDecoder('utf-8').decode(body)
  }

  async function doRefresh(source: CalendarSource): Promise<void> {
    const state = stateOf(source.id)
    try {
      const text = await download(source.url)
      state.occurrences = expand(text)
      state.fetchedAt = now().toISOString()
      state.error = null
      // 取得中に消されたカレンダーのキャッシュは書かない(FK で落ちる)。
      if (calendarRepo.getById(deps.db, source.id) !== null) {
        calendarRepo.setCache(deps.db, source.id, { ics: text, fetchedAt: state.fetchedAt })
      }
      logger.info('カレンダー(iCal)を取得しました', { calendarId: source.id, name: source.name, eventCount: state.occurrences.length })
    } catch (err) {
      // 失敗しても前回の予定は残す —— 一時的なネットワーク断で画面が空に
      // なるより、古い予定が出ているほうがよい。
      state.error = err instanceof Error ? err.message : String(err)
      logger.warn('カレンダー(iCal)の取得に失敗しました', { calendarId: source.id, name: source.name, message: state.error })
    }
  }

  function refreshOne(source: CalendarSource): Promise<void> {
    const state = stateOf(source.id)
    if (state.inFlight === null) {
      state.inFlight = doRefresh(source).finally(() => {
        state.inFlight = null
      })
    }
    return state.inFlight
  }

  async function refresh(id?: number): Promise<CalendarStatus> {
    const sources = calendarRepo.listAll(deps.db).filter((s) => id === undefined || s.id === id)
    await Promise.all(sources.map(refreshOne))
    return status()
  }

  function eventsOn(date: string): CalendarEvent[] {
    const events: CalendarEvent[] = []
    for (const source of calendarRepo.listAll(deps.db)) {
      for (const event of eventsOnDate(stateOf(source.id).occurrences, date)) {
        events.push({ ...event, id: `${source.id}:${event.id}`, calendarId: source.id, calendarName: source.name, color: source.color })
      }
    }
    events.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
      const as = a.start ?? ''
      const bs = b.start ?? ''
      return as < bs ? -1 : as > bs ? 1 : a.calendarId - b.calendarId || a.title.localeCompare(b.title)
    })
    return events
  }

  async function addCalendar(input: { name: string; url: string; color?: string }): Promise<CalendarSourceStatus> {
    const created = calendarRepo.create(deps.db, input)
    logger.info('カレンダー(iCal)を追加しました', { calendarId: created.id, name: created.name })
    await refreshOne(created)
    return sourceStatus(created)
  }

  async function updateCalendar(
    id: number,
    patch: { name?: string; url?: string; color?: string }
  ): Promise<CalendarSourceStatus | null> {
    const before = calendarRepo.getById(deps.db, id)
    if (before === null) return null
    const urlChanged = patch.url !== undefined && patch.url !== before.url
    if (urlChanged) {
      // 取得中の結果が古い URL のものとして残らないよう、先に待つ。
      await stateOf(id).inFlight?.catch(() => undefined)
    }
    const updated = calendarRepo.update(deps.db, id, patch)
    if (updated === null) return null
    if (urlChanged) {
      calendarRepo.clearCache(deps.db, id)
      states.set(id, { occurrences: [], fetchedAt: null, error: null, inFlight: null })
      await refreshOne(updated)
    }
    return sourceStatus(updated)
  }

  async function removeCalendar(id: number): Promise<boolean> {
    await stateOf(id).inFlight?.catch(() => undefined)
    const removed = calendarRepo.remove(deps.db, id)
    states.delete(id)
    if (removed) logger.info('カレンダー(iCal)を削除しました', { calendarId: id })
    return removed
  }

  for (const source of calendarRepo.listAll(deps.db)) loadCache(source)

  return {
    status,
    sources: () => calendarRepo.listAll(deps.db).map((source) => ({ ...source, status: sourceStatus(source) })),
    eventsOn,
    refresh,
    addCalendar,
    updateCalendar,
    removeCalendar,
    start() {
      if (timer !== null) return
      void refresh()
      timer = schedule(() => void refresh(), intervalMs)
    },
    stop() {
      if (timer === null) return
      cancel(timer)
      timer = null
    },
  }
}
