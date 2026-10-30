// 1日スケジュール(「スケジュール」ページ)の純粋ロジック。DOM も state も
// 触らないので、plan の planRange/planTodos と同じくテストが直接叩ける。
//
// 予定は scheduledStart / scheduledEnd の "YYYY-MM-DDTHH:MM"(ローカル壁時計
// 時刻、タイムゾーン無し)のペア。期日(dueDate)とは独立で、期日は締切、
// 予定は「いつ取り組むか」。両方の判定で UTC 変換を挟まないのは dueBadge と
// 同じ理由 —— 日付が1日ずれる。

import { isIsoDate } from './isoDate.js'

const LOCAL_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/
const TIME_PATTERN = /^\d{2}:\d{2}$/
export const MINUTES_PER_DAY = 24 * 60
// 開始だけ入れて終了を空にしたときの既定の長さ(Google カレンダーと同じ 1 時間)。
export const DEFAULT_DURATION_MINUTES = 60

// isIsoDate は形だけ見る。予定の日付は <input type="date"> 由来でほぼ正しいが、
// 保存前に実在する日か(2026-02-30 でないか)も確かめておく —— サーバーも
// 同じ検査で 400 を返すので、ここで先に分かりやすく止める。
function isRealIsoDate(value) {
  if (!isIsoDate(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

/** @param {unknown} value @returns {boolean} */
export function isLocalDateTime(value) {
  if (typeof value !== 'string') return false
  const m = LOCAL_DATETIME_PATTERN.exec(value)
  if (!m) return false
  return isRealIsoDate(m[1]) && Number(m[2]) <= 23 && Number(m[3]) <= 59
}

/** "YYYY-MM-DDTHH:MM" → { date: 'YYYY-MM-DD', time: 'HH:MM' }。不正なら null。 */
export function splitLocalDateTime(value) {
  if (!isLocalDateTime(value)) return null
  return { date: value.slice(0, 10), time: value.slice(11, 16) }
}

/** 'HH:MM' → 0〜1439 の分。不正なら null。 */
export function minutesOfTime(time) {
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) return null
  const [h, m] = time.split(':').map(Number)
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/** 0〜1440 の分 → 'HH:MM'(1440 は '24:00')。 */
export function timeOfMinutes(minutes) {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minutes)))
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`
}

/** 予定を持つ(両方が正しい形の)TODO か。 */
export function hasSchedule(todo) {
  return isLocalDateTime(todo?.scheduledStart) && isLocalDateTime(todo?.scheduledEnd)
}

/** 行バッジ・詳細行用: "10/30 10:00–11:30"。予定が無ければ null。 */
export function formatSchedule(todo) {
  if (!hasSchedule(todo)) return null
  const start = splitLocalDateTime(todo.scheduledStart)
  const end = splitLocalDateTime(todo.scheduledEnd)
  const [, mm, dd] = start.date.split('-').map(Number)
  return `${mm}/${dd} ${start.time}–${end.time}`
}

/** 時刻だけ: "10:00–11:30"。 */
export function formatTimeRange(todo) {
  if (!hasSchedule(todo)) return null
  return `${todo.scheduledStart.slice(11, 16)}–${todo.scheduledEnd.slice(11, 16)}`
}

/**
 * その日に予定が入っている TODO を開始時刻順(同時刻は id 順)で返す。
 * 開始日で判定する: 予定は同じ日に収まる(API が保証)。
 */
export function scheduledTodosOn(todos, date) {
  return todos
    .filter((t) => hasSchedule(t) && t.scheduledStart.slice(0, 10) === date)
    .sort((a, b) => (a.scheduledStart < b.scheduledStart ? -1 : a.scheduledStart > b.scheduledStart ? 1 : a.id - b.id))
}

/**
 * その日が期日の TODO。未完了が先、同じ側は優先度(high→low→none)、id 順。
 * Google カレンダーの「終日」欄に相当し、タイムラインとは別に一覧する。
 */
export function dueTodosOn(todos, date) {
  const rank = { high: 0, low: 1 }
  return todos
    .filter((t) => isIsoDate(t.dueDate) && t.dueDate === date)
    .sort(
      (a, b) =>
        Number(a.status === 'done') - Number(b.status === 'done') ||
        (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) ||
        a.id - b.id
    )
}

/**
 * タイムラインに置くブロックの座標。重なる予定は Google カレンダーのように
 * 横に並べる: 重なり合う塊(cluster)ごとに貪欲に列を割り当て、塊の列数で幅を
 * 割る。
 *
 * @param {object[]} todos scheduledTodosOn() の戻り(開始順)
 * @returns {Array<{ todo: object, startMin: number, endMin: number, col: number, cols: number }>}
 */
export function layoutBlocks(todos) {
  const blocks = todos.map((todo) => ({
    todo,
    startMin: minutesOfTime(todo.scheduledStart.slice(11, 16)),
    endMin: minutesOfTime(todo.scheduledEnd.slice(11, 16)),
    col: 0,
    cols: 1,
  }))
  // 塊: 直前までの最大終了時刻より前に始まるブロックは同じ塊。
  let cluster = []
  let clusterEnd = -1
  const columnEnds = []
  const flush = () => {
    const cols = columnEnds.length || 1
    for (const b of cluster) b.cols = cols
    cluster = []
    columnEnds.length = 0
  }
  for (const b of blocks) {
    if (cluster.length > 0 && b.startMin >= clusterEnd) flush()
    let col = columnEnds.findIndex((end) => end <= b.startMin)
    if (col === -1) {
      col = columnEnds.length
      columnEnds.push(b.endMin)
    } else {
      columnEnds[col] = b.endMin
    }
    b.col = col
    cluster.push(b)
    clusterEnd = Math.max(clusterEnd, b.endMin)
  }
  flush()
  return blocks
}

/**
 * フォームの3欄(日付・開始・終了)から API に送る patch を作る。
 * - 3つとも空 → { scheduledStart: null, scheduledEnd: null }(予定なし/解除)
 * - 日付+開始、終了が空 → 終了は開始+60分(同じ日に収まるよう 24:00 で止め、
 *   開始が 23:59 なら 24:00 は表せないので誤りにする)
 * - それ以外の欠けや前後関係の誤り → { error }
 * @returns {{ scheduledStart: string|null, scheduledEnd: string|null } | { error: string }}
 */
export function buildSchedulePatch({ date, start, end }) {
  const d = (date ?? '').trim()
  const s = (start ?? '').trim()
  const e = (end ?? '').trim()
  if (!d && !s && !e) return { scheduledStart: null, scheduledEnd: null }
  if (!d) return { error: '予定の日付を入力してください' }
  if (!isRealIsoDate(d)) return { error: '予定の日付が不正です' }
  if (!s) return { error: '予定の開始時刻を入力してください' }
  const startMin = minutesOfTime(s)
  if (startMin === null) return { error: '予定の開始時刻の形式が不正です' }
  let endMin
  if (e) {
    endMin = minutesOfTime(e)
    if (endMin === null) return { error: '予定の終了時刻の形式が不正です' }
  } else {
    endMin = Math.min(startMin + DEFAULT_DURATION_MINUTES, MINUTES_PER_DAY - 1)
  }
  if (endMin <= startMin) return { error: '予定の終了は開始より後にしてください' }
  return { scheduledStart: `${d}T${timeOfMinutes(startMin)}`, scheduledEnd: `${d}T${timeOfMinutes(endMin)}` }
}

/** フォームの3欄の初期値を TODO から起こす(予定が無ければ全部空)。 */
export function scheduleFields(todo) {
  if (!hasSchedule(todo)) return { date: '', start: '', end: '' }
  return {
    date: todo.scheduledStart.slice(0, 10),
    start: todo.scheduledStart.slice(11, 16),
    end: todo.scheduledEnd.slice(11, 16),
  }
}

/** 日表示の見出し: "2026年10月30日(金)"。 */
export function formatDayHeading(date) {
  const [y, m, d] = date.split('-').map(Number)
  const weekday = '日月火水木金土'[new Date(y, m - 1, d).getDay()]
  return `${y}年${m}月${d}日(${weekday})`
}
