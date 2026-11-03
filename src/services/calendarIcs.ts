import ICAL from 'ical.js'

// Google カレンダーの「iCal 形式の非公開 URL」から取れる ICS を、スケジュール
// ページのタイムラインに重ねられる形に直す純粋な処理。ネットワークも DB も
// 触らない(取得と保存は calendarSync.ts)。
//
// 時刻の扱いは TODO の予定(scheduledStart/End)に揃える: すべてローカル壁時計
// の "YYYY-MM-DDTHH:MM"(タイムゾーン表記なし)に変換してから持つ。ICS 側は
// TZID 付き・UTC(Z)・浮動の3通りで来るが、ical.js が VTIMEZONE を使って
// 絶対時刻(JS Date)に直し、ここで表示用のゾーン(既定はこのプロセスの
// ローカル)の壁時計に戻す。以降の日付判定は文字列比較だけで済む。
//
// 繰り返し予定(RRULE)はここで展開する。展開は期間を区切って行う ——
// 際限なく続く予定を全部並べることはできないので、呼び出し側(calendarSync)
// が「今日の前後」の窓を渡す。

export interface CalendarOccurrence {
  readonly uid: string
  readonly title: string
  readonly location: string | null
  readonly allDay: boolean
  // 終日: "YYYY-MM-DD"(end は排他的 —— ICS の DTEND;VALUE=DATE と同じ)。
  // 時刻あり: "YYYY-MM-DDTHH:MM"(end は排他的)。
  readonly start: string
  readonly end: string
}

// スケジュールページが描く単位。日をまたぐ予定はその日の分だけに切る。
export interface CalendarDayEvent {
  // 予定(uid + 回)と日で一意。描画の key 用で、永続化はしない。
  readonly id: string
  readonly uid: string
  readonly title: string
  readonly location: string | null
  readonly allDay: boolean
  readonly date: string
  // 終日なら null。時刻ありは "HH:MM"、end はその日で終わらなければ "24:00"。
  readonly start: string | null
  readonly end: string | null
  // 前日から続いている / 翌日へ続く(日をまたぐ予定の一部)。
  readonly continuesBefore: boolean
  readonly continuesAfter: boolean
}

export interface ExpandOptions {
  // 展開する窓(ローカル暦の日付、両端を含む)。
  readonly from: string
  readonly to: string
  // 壁時計に直すときの IANA ゾーン名。省略時はこのプロセスのローカル。
  readonly zone?: string
  // 1 予定あたり・全体の回数の上限。壊れた RRULE や極端に多い予定で
  // 止まらなくなるのを防ぐ。
  readonly maxOccurrencesPerEvent?: number
  readonly maxOccurrences?: number
}

export const DEFAULT_MAX_OCCURRENCES_PER_EVENT = 1000
export const DEFAULT_MAX_OCCURRENCES = 20_000

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    formatterCache.set(zone, fmt)
  }
  return fmt
}

/** 絶対時刻 → ゾーンの壁時計 "YYYY-MM-DDTHH:MM"。 */
export function toLocalDateTime(date: Date, zone: string): string {
  const parts: Record<string, string> = {}
  for (const part of formatterFor(zone).formatToParts(date)) {
    parts[part.type] = part.value
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function isValidZone(zone: string): boolean {
  try {
    formatterFor(zone)
    return true
  } catch {
    return false
  }
}

// ical.js の Time → 壁時計文字列。終日(isDate)はゾーン変換せず日付をそのまま
// 使う —— 「11/6 終日」はどのゾーンで見ても 11/6 なので。
function localOf(time: ICAL.Time, zone: string): string {
  if (time.isDate) {
    return time.toString().slice(0, 10)
  }
  return toLocalDateTime(time.toJSDate(), zone)
}

function stringProp(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export class IcsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IcsParseError'
  }
}

function parseCalendar(text: string): ICAL.Component {
  // Google は UTF-8 BOM を付けないが、他のエクスポートは付けることがある。
  const cleaned = text.replace(/^\uFEFF/, '')
  // ical.js は VCALENDAR の外に行があると内部エラー("designSet" が無い)で
  // 落ちるので、先に形を見る。URL を間違えて HTML や JSON が返ったときに
  // 「iCal 形式ではない」と言えるように。
  if (!/^\s*BEGIN:VCALENDAR\b/i.test(cleaned)) {
    const head = cleaned.trimStart().slice(0, 40).replace(/\s+/g, ' ')
    throw new IcsParseError(`iCal 形式ではありません(BEGIN:VCALENDAR で始まっていません: "${head}…")。URL が「iCal 形式の非公開 URL」か確かめてください`)
  }
  let jcal: unknown
  try {
    jcal = ICAL.parse(cleaned)
  } catch (err) {
    throw new IcsParseError(`iCal 形式として読めませんでした: ${err instanceof Error ? err.message : String(err)}`)
  }
  const component = new ICAL.Component(jcal as unknown[])
  if (component.name !== 'vcalendar') {
    throw new IcsParseError('iCal 形式ではありません(VCALENDAR がありません)')
  }
  return component
}

// 終日は日付だけ、時刻ありは "T" まで含めて比べる。窓は日付なので、時刻あり
// の比較には日付部分を使う。
function dateOf(local: string): string {
  return local.slice(0, 10)
}

/**
 * ICS 文字列を窓の中の回に展開する。窓にかかる回(窓の前に始まって窓の中で
 * 終わる予定を含む)を、開始順に返す。
 * @throws IcsParseError ICS として読めないとき
 */
export function expandIcs(text: string, options: ExpandOptions): CalendarOccurrence[] {
  const zone = options.zone ?? localZone()
  if (!isValidZone(zone)) {
    throw new IcsParseError(`タイムゾーン "${zone}" を解釈できません`)
  }
  const maxPerEvent = options.maxOccurrencesPerEvent ?? DEFAULT_MAX_OCCURRENCES_PER_EVENT
  const maxTotal = options.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES
  const calendar = parseCalendar(text)

  // VTIMEZONE はグローバルに登録する(ical.js の設計)。同じ TZID が来たら
  // 新しい定義で上書きされるだけなので、取得のたびに登録し直してよい。
  for (const tz of calendar.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz)
    } catch {
      // 壊れた VTIMEZONE はその予定が浮動扱いになるだけ —— 全体を落とさない。
    }
  }

  // RECURRENCE-ID を持つ VEVENT は親(同じ UID)の特定の回の差し替え。
  const byUid = new Map<string, ICAL.Component[]>()
  for (const vevent of calendar.getAllSubcomponents('vevent')) {
    const uid = stringProp(vevent, 'uid') ?? `no-uid:${byUid.size}`
    const list = byUid.get(uid)
    if (list) list.push(vevent)
    else byUid.set(uid, [vevent])
  }

  const occurrences: CalendarOccurrence[] = []
  const windowStart = options.from
  const windowEndExclusive = `${options.to}T24:00`

  const push = (uid: string, item: ICAL.Event, start: ICAL.Time, end: ICAL.Time): boolean => {
    const allDay = start.isDate
    const localStart = localOf(start, zone)
    let localEnd = localOf(end, zone)
    // DTEND が無い・開始以前(壊れたデータ)なら、終日は 1 日、時刻ありは
    // 0 分の予定として扱い、描けるものだけ描く。
    if (localEnd <= localStart) {
      localEnd = allDay ? addDays(localStart, 1) : localStart
    }
    // 窓の外(窓の前に終わる / 窓の後に始まる)は捨てる。
    if (dateOf(localStart) > options.to) return false
    if (allDay ? localEnd <= windowStart : localEnd <= `${windowStart}T00:00`) return true
    if (!allDay && localStart >= windowEndExclusive) return false
    const title = (typeof item.summary === 'string' && item.summary.trim()) || '(タイトルなし)'
    occurrences.push({
      uid,
      title,
      location: stringProp(item.component, 'location'),
      allDay,
      start: localStart,
      end: localEnd,
    })
    return true
  }

  for (const [uid, components] of byUid) {
    if (occurrences.length >= maxTotal) break
    const main = components.find((c) => !c.hasProperty('recurrence-id')) ?? components[0]!
    const exceptions = components.filter((c) => c !== main)
    let event: ICAL.Event
    try {
      event = new ICAL.Event(main, { strictExceptions: true, exceptions })
    } catch {
      continue
    }
    // 親の無い例外だけ(主予定が窓の外で削られたエクスポート)は、その回を
    // 単発の予定として扱う。
    if (main.hasProperty('recurrence-id')) {
      push(uid, event, event.startDate, event.endDate)
      continue
    }
    if (!event.isRecurring()) {
      push(uid, event, event.startDate, event.endDate)
      continue
    }
    let count = 0
    try {
      const iterator = event.iterator()
      let next: ICAL.Time | null | undefined
      while ((next = iterator.next()) && count < maxPerEvent && occurrences.length < maxTotal) {
        const details = event.getOccurrenceDetails(next)
        // 差し替えられた回は差し替え先の時刻になる(ical.js が解決する)。
        if (!push(uid, details.item, details.startDate, details.endDate)) break
        count++
      }
    } catch {
      // RRULE が解釈できない予定は、初回だけ置いて先へ進む。
      push(uid, event, event.startDate, event.endDate)
    }
  }

  occurrences.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.uid.localeCompare(b.uid)))
  return occurrences
}

/** "YYYY-MM-DD" に日数を足す(ローカル暦)。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + days))
  return next.toISOString().slice(0, 10)
}

/**
 * その日にかかる回を、その日の分だけに切って返す。終日は上段(期日と同じ
 * 欄)に、時刻ありはタイムラインに置く前提で、終日が先・開始順。
 */
export function eventsOnDate(occurrences: readonly CalendarOccurrence[], date: string): CalendarDayEvent[] {
  const dayStart = `${date}T00:00`
  const dayEnd = `${date}T24:00`
  const events: CalendarDayEvent[] = []
  for (const occ of occurrences) {
    if (occ.allDay) {
      if (occ.start > date || occ.end <= date) continue
      events.push({
        id: `${occ.uid}@${occ.start}@${date}`,
        uid: occ.uid,
        title: occ.title,
        location: occ.location,
        allDay: true,
        date,
        start: null,
        end: null,
        continuesBefore: occ.start < date,
        continuesAfter: occ.end > addDays(date, 1),
      })
      continue
    }
    // その日にかかるか。0 分の予定(start == end)は開始がその日なら拾う。
    const overlaps = occ.start < dayEnd && (occ.end > dayStart || (occ.start === occ.end && occ.start >= dayStart))
    if (!overlaps) continue
    const continuesBefore = occ.start < dayStart
    const continuesAfter = occ.end > dayEnd
    const start = continuesBefore ? '00:00' : occ.start.slice(11, 16)
    const end = continuesAfter ? '24:00' : occ.end.slice(11, 16)
    events.push({
      id: `${occ.uid}@${occ.start}@${date}`,
      uid: occ.uid,
      title: occ.title,
      location: occ.location,
      allDay: false,
      date,
      start,
      end,
      continuesBefore,
      continuesAfter,
    })
  }
  events.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
    const as = a.start ?? ''
    const bs = b.start ?? ''
    return as < bs ? -1 : as > bs ? 1 : a.title.localeCompare(b.title)
  })
  return events
}
