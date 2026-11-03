// スケジュール page: Google カレンダーの「日」表示のように、1日分だけを
// 描く。上段はその日が期日の TODO の一覧(カレンダーの「終日」欄に相当し、
// タイムラインとは別に並べる)、下段は 0〜24 時のタイムラインで、予定
// (scheduledStart/End)を持つ TODO をブロックとして置く。
//
// 時間帯のセルをクリックすると、その時刻から始まる予定を入れる小さなフォーム
// (#day-quick-form)が開く。フォームはタイムラインの外側に置いてあり、
// renderDay() はそこを触らない —— ポーリングでの再描画が入力中の値を消さ
// ないため(todos.js の新規フォームと同じ理由)。
//
// 「今日」の線は 1 分おきに引き直す。選んでいる日が今日のときだけ出る。
//
// Google カレンダーの予定(設定で iCal 非公開 URL を登録したとき)は、
// GET /api/calendar/events から選んでいる日の分だけ読み、終日は上段に、
// 時刻ありはタイムラインに TODO と一緒に並べる。読み取り専用なので、
// ブロックは押せない。日を変えたとき・1 分おきの tick で読み直す ——
// サーバー側が 15 分ごとに取り直しているので、画面もそれに追随する。

import { api } from './api.js'
import { refreshBoth } from './data.js'
import {
  buildSchedulePatch,
  dueTodosOn,
  formatDayHeading,
  formatTimeRange,
  hasSchedule,
  MINUTES_PER_DAY,
  timelineEntries,
  timeOfMinutes,
  DEFAULT_DURATION_MINUTES,
} from './lib/schedule.js'
import { shiftIsoDate } from './lib/isoDate.js'
import { priorityBadge } from './lib/priority.js'
import { openSettingsDialog } from './settingsDialog.js'
import { getState } from './state.js'
import { openTodoDetail } from './todoDetailDialog.js'
import { $, escapeHtml, toast, toastError, todayIso } from './utils.js'

const NOW_TICK_MS = 60_000

let selectedDate = todayIso()
// Google カレンダーの予定。date は最後に読みに行った日(読み込み中も含む)
// で、renderDay() はこれが selectedDate と違うときだけ読みに行く —— 描画の
// たびに fetch しないため。status は null なら未取得。
let calendar = { date: null, events: [], status: null, error: null, loading: false, refreshing: false }
// null while closed; otherwise the clicked hour's draft. Field values live
// in the DOM (the form is never re-rendered while open), so this only has
// to remember that it is open and whether a save is in flight.
let quickForm = null

function isPageActive() {
  return $('#page-day')?.classList.contains('active') ?? false
}

function statusIcon(todo) {
  if (todo.status === 'done') return '✔'
  if (todo.sessionState === 'working') return '▶'
  if (todo.sessionState === 'blocked') return '⏸'
  return '○'
}

function prioBadge(todo) {
  const badge = priorityBadge(todo)
  if (!badge) return ''
  return `<span class="prio-badge ${badge.className}" title="${badge.title}">${badge.label}</span>`
}

// 一覧の ms-chip と同じ見た目だが、ここでは紐付けの変更はしないので
// data-ms-chip を付けず、クリックは行ごと詳細を開く。
function msChip(todo) {
  if (!todo.milestoneId) return ''
  const color = escapeHtml(todo.milestoneColor ?? '#6ca4f8')
  return `<span class="ms-chip" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)"><span class="ms-dot" style="background:${color}"></span>${escapeHtml(todo.milestoneTitle)}</span>`
}

function calendarTag(name, color) {
  return `<span class="cal-tag" style="--cal-color:${escapeHtml(color)}"><span class="cal-dot"></span>${escapeHtml(name)}</span>`
}

function calendarAllDayItem(event) {
  const span = event.continuesBefore || event.continuesAfter ? '(複数日)' : ''
  const location = event.location ? `<span class="loc" title="${escapeHtml(event.location)}">📍${escapeHtml(event.location)}</span>` : ''
  return `<div class="day-due-item cal" style="--cal-color:${escapeHtml(event.color)}" title="${escapeHtml(event.calendarName)} の終日予定${span}">
    <span class="st">▦</span>
    <span class="ttl">${escapeHtml(event.title)}${span ? ` <span class="day-due-time">${span}</span>` : ''}</span>
    ${location}${calendarTag(event.calendarName, event.color)}
  </div>`
}

function dueItem(todo) {
  const done = todo.status === 'done'
  const scheduled = hasSchedule(todo) && todo.scheduledStart.slice(0, 10) === selectedDate
    ? `<span class="day-due-time" title="この日の予定">${escapeHtml(formatTimeRange(todo))}</span>`
    : ''
  return `<div class="day-due-item ${done ? 'd' : ''}" role="button" tabindex="0" data-action="open-todo-detail" data-id="${todo.id}" title="クリックで詳細を表示">
    <span class="st">${statusIcon(todo)}</span>
    <span class="ttl"><span class="todo-id">#${todo.id}</span> ${escapeHtml(todo.title)}</span>
    ${prioBadge(todo)}${msChip(todo)}${scheduled}
  </div>`
}

function renderDueList(todos) {
  const due = dueTodosOn(todos, selectedDate)
  const allDay = calendar.date === selectedDate ? calendar.events.filter((e) => e.allDay) : []
  $('#day-due-count').textContent = due.length ? `${due.length}件` : ''
  const items = allDay.map(calendarAllDayItem).join('') + due.map(dueItem).join('')
  $('#day-due-list').innerHTML = items || `<p class="day-due-empty">この日が期日のTODOはありません。</p>`
}

function hourLabels() {
  const labels = []
  for (let h = 0; h < 24; h++) {
    labels.push(`<span style="top:${(h / 24) * 100}%">${h}:00</span>`)
  }
  return labels.join('')
}

function hourCells() {
  const cells = []
  for (let h = 0; h < 24; h++) {
    cells.push(`<div class="day-cell" data-action="quick-add" data-hour="${h}" style="top:${(h / 24) * 100}%" title="クリックして ${h}:00 からの予定を入れる"></div>`)
  }
  return cells.join('')
}

function blockGeometry({ startMin, endMin, col, cols }, color = '') {
  const top = (startMin / MINUTES_PER_DAY) * 100
  const height = ((endMin - startMin) / MINUTES_PER_DAY) * 100
  const left = (col / cols) * 100
  const width = 100 / cols
  return {
    // 45 分未満(--hour-h: 44px で 33px 弱)は 2 行入らないので、時刻を
    // タイトルの前に畳んで 1 行にする。
    short: endMin - startMin < 45,
    style: `top:${top}%;height:${height}%;left:${left}%;width:calc(${width}% - 3px);${color ? `--block-color:${color}` : ''}`,
  }
}

function todoBlockHtml(block) {
  const { todo } = block
  const done = todo.status === 'done'
  const { short, style } = blockGeometry(block, escapeHtml(todo.milestoneColor ?? ''))
  const range = escapeHtml(formatTimeRange(todo))
  return `<button type="button" class="day-block ${done ? 'd' : ''} ${short ? 'short' : ''}" data-action="open-todo-detail" data-id="${todo.id}" style="${style}" title="#${todo.id} ${escapeHtml(todo.title)} (${range})">
    <span class="tm">${range}</span><span class="ttl">${short ? `<span class="tm-inline">${range}</span> ` : ''}${escapeHtml(todo.title)}</span>
  </button>`
}

// カレンダーの予定は押せない(詳細は Google カレンダー側)。日をまたぐ分は
// 00:00 / 24:00 で切られて来るので、時刻の表示はそのまま出せばよい。
function calendarBlockHtml(block) {
  const { event } = block
  const { short, style } = blockGeometry(block, escapeHtml(event.color))
  const range = `${event.start}–${event.end}`
  const tip = [event.title, range, event.location].filter(Boolean).join(' / ')
  const location = event.location && !short ? `<span class="loc">📍${escapeHtml(event.location)}</span>` : ''
  return `<div class="day-block cal ${short ? 'short' : ''}" style="${style}" title="${escapeHtml(event.calendarName)}: ${escapeHtml(tip)}">
    <span class="tm">${range}</span><span class="ttl">${short ? `<span class="tm-inline">${range}</span> ` : ''}${escapeHtml(event.title)}</span>${location}
  </div>`
}

function blockHtml(block) {
  return block.kind === 'calendar' ? calendarBlockHtml(block) : todoBlockHtml(block)
}

function formatFetchedAt(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const sameDay = at.toDateString() === new Date().toDateString()
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return sameDay ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`
}

// タイムラインの上の 1 行: 未設定なら設定への誘導、設定済みならカレンダー
// ごとの色付きタグ(その日の件数・最終取得・エラー)と「更新」ボタン。
function renderCalendarStatus() {
  const host = $('#day-cal-status')
  if (!host) return
  const { status, error, refreshing } = calendar
  if (status === null) {
    host.innerHTML = error ? `<span class="warn">Google カレンダーの予定を読めませんでした: ${escapeHtml(error)}</span>` : ''
    return
  }
  if (!status.configured) {
    host.innerHTML = `<span class="cal-tag"><span class="cal-dot"></span>カレンダー</span><span>Google カレンダーの予定を重ねるには、<button type="button" class="btn btn-ghost" data-action="open-settings">設定</button>で iCal 形式の非公開 URL を登録します。</span>`
    return
  }
  const events = calendar.date === selectedDate ? calendar.events : []
  const parts = status.calendars.map((cal) => {
    const count = events.filter((e) => e.calendarId === cal.id).length
    const detail = cal.error
      ? `<span class="warn" title="${escapeHtml(cal.error)}">⚠ ${escapeHtml(cal.error)}</span>`
      : `<span title="${cal.fetchedAt ? `${escapeHtml(formatFetchedAt(cal.fetchedAt))} 取得` : '未取得'}">${count ? `${count}件` : '予定なし'}</span>`
    return `<span class="day-cal-item">${calendarTag(cal.name, cal.color)}${detail}</span>`
  })
  if (error) parts.push(`<span class="warn">⚠ ${escapeHtml(error)}</span>`)
  if (status.windowFrom && (selectedDate < status.windowFrom || selectedDate > status.windowTo)) {
    parts.push(`<span class="warn">この日は同期の範囲外(${escapeHtml(status.windowFrom)}〜${escapeHtml(status.windowTo)})です</span>`)
  }
  parts.push(`<button type="button" class="btn btn-ghost" data-action="refresh-calendar" ${refreshing || status.refreshing ? 'disabled' : ''}>${refreshing || status.refreshing ? '取得中…' : '更新'}</button>`)
  host.innerHTML = parts.join('')
}

async function loadCalendar(date) {
  // 日が変わったら前の日の予定は消す(新しい日に一瞬出さないため)。
  calendar = { ...calendar, date, loading: true, events: calendar.date === date ? calendar.events : [] }
  try {
    const { status, events } = await api.calendarEvents(date)
    // 読んでいる間に日を変えていたら、その結果は捨てる(新しい日の分が来る)。
    if (calendar.date !== date) return
    calendar = { ...calendar, events, status, error: null, loading: false }
  } catch (err) {
    if (calendar.date !== date) return
    calendar = { ...calendar, error: err.message, loading: false }
  }
  if (isPageActive()) renderDay()
}

async function refreshCalendarNow() {
  if (calendar.refreshing) return
  calendar = { ...calendar, refreshing: true }
  renderCalendarStatus()
  try {
    const { status } = await api.refreshCalendar()
    calendar = { ...calendar, status, refreshing: false }
    const failed = status.calendars.filter((c) => c.error)
    if (failed.length) toastError(`取得に失敗したカレンダーがあります: ${failed.map((c) => `${c.name}(${c.error})`).join(' / ')}`)
    else toast(`カレンダーの予定を取り直しました(${status.calendars.reduce((n, c) => n + c.eventCount, 0)}件)`)
  } catch (err) {
    calendar = { ...calendar, refreshing: false }
    toastError(err.message)
  }
  await loadCalendar(selectedDate)
}

function nowLineHtml() {
  if (selectedDate !== todayIso()) return ''
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  return `<div class="day-now" style="top:${(minutes / MINUTES_PER_DAY) * 100}%" aria-hidden="true"></div>`
}

function renderTimeline(todos) {
  const events = calendar.date === selectedDate ? calendar.events : []
  const blocks = timelineEntries(todos, events, selectedDate)
  $('#day-hours').innerHTML = hourLabels()
  $('#day-canvas').innerHTML = hourCells() + blocks.map(blockHtml).join('') + nowLineHtml()
  $('#day-timeline-note').textContent = blocks.some((b) => b.kind === 'todo')
    ? ''
    : '予定の入ったTODOはまだありません。時間帯をクリックするか、TODOの編集で「予定」を設定すると、ここに並びます。'
}

export function renderDay() {
  const { todos } = getState()
  const today = todayIso()
  $('#day-heading').textContent = formatDayHeading(selectedDate)
  $('#day-today-badge').hidden = selectedDate !== today
  const picker = $('#day-picker')
  if (picker.value !== selectedDate) picker.value = selectedDate
  // 初めて開いたとき・日を変えたときだけ読みに行く(描画は 10 秒ポーリング
  // でも走るので、ここで毎回 fetch はしない)。
  if (calendar.date !== selectedDate && !calendar.loading) void loadCalendar(selectedDate)
  renderDueList(todos)
  renderTimeline(todos)
  renderCalendarStatus()
}

// ---------- quick form ----------

function openTodoOptions(todos) {
  const open = todos.filter((t) => t.status !== 'done')
  const option = (t) => `<option value="${t.id}">#${t.id} ${escapeHtml(t.title)}</option>`
  const unscheduled = open.filter((t) => !hasSchedule(t))
  const scheduled = open.filter((t) => hasSchedule(t))
  return (
    `<option value="">＋ 新しいTODOを作って予定に入れる</option>` +
    (unscheduled.length ? `<optgroup label="予定のない未完了TODO">${unscheduled.map(option).join('')}</optgroup>` : '') +
    (scheduled.length ? `<optgroup label="予定を移す(すでに予定のあるTODO)">${scheduled.map(option).join('')}</optgroup>` : '')
  )
}

function renderQuickForm() {
  const container = $('#day-quick-form')
  if (quickForm === null) {
    container.hidden = true
    container.innerHTML = ''
    return
  }
  const [, mm, dd] = selectedDate.split('-').map(Number)
  container.hidden = false
  container.innerHTML = `
    <div class="form-field grow">
      <label for="day-quick-todo">${mm}/${dd} に予定を入れるTODO</label>
      <select id="day-quick-todo">${openTodoOptions(getState().todos)}</select>
    </div>
    <div class="form-field grow" id="day-quick-title-field">
      <label for="day-quick-title">タイトル</label>
      <input id="day-quick-title" type="text" placeholder="例: 検索APIのレビュー">
    </div>
    <div class="form-field">
      <label for="day-quick-start">開始</label>
      <input id="day-quick-start" type="time" step="300" value="${escapeHtml(quickForm.start)}">
    </div>
    <div class="form-field">
      <label for="day-quick-end">終了</label>
      <input id="day-quick-end" type="time" step="300" value="${escapeHtml(quickForm.end)}">
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-quick" ${quickForm.busy ? 'disabled' : ''}>予定に入れる</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-quick">キャンセル</button>
    </div>
    <div class="form-error" id="day-quick-error" hidden></div>`
  $('#day-quick-title').focus()
}

function openQuickForm(hour) {
  const startMin = hour * 60
  quickForm = {
    start: timeOfMinutes(startMin),
    end: timeOfMinutes(Math.min(startMin + DEFAULT_DURATION_MINUTES, MINUTES_PER_DAY - 1)),
    busy: false,
  }
  renderQuickForm()
  $('#day-quick-form').scrollIntoView({ block: 'nearest' })
}

function closeQuickForm() {
  quickForm = null
  renderQuickForm()
}

function showQuickError(message) {
  const el = $('#day-quick-error')
  if (!el) return
  el.hidden = !message
  el.textContent = message ?? ''
}

// 選んだ TODO があればその予定を書き換え、無ければタイトルから新しい TODO を
// 作る。どちらも予定は選んでいる日に入る。
async function saveQuickForm() {
  if (!quickForm || quickForm.busy) return
  const todoId = $('#day-quick-todo').value
  const title = $('#day-quick-title').value.trim()
  const patch = buildSchedulePatch({
    date: selectedDate,
    start: $('#day-quick-start').value,
    end: $('#day-quick-end').value,
  })
  if (patch.error) {
    showQuickError(patch.error)
    return
  }
  if (!todoId && !title) {
    showQuickError('TODOを選ぶか、新しいTODOのタイトルを入力してください')
    return
  }
  quickForm.busy = true
  $('[data-action="save-quick"]').disabled = true
  try {
    if (todoId) {
      await api.updateTodo(Number(todoId), patch)
    } else {
      await api.createTodo({ title, ...patch })
    }
    quickForm = null
    await refreshBoth()
    renderQuickForm()
    toast(`${patch.scheduledStart.slice(11)}–${patch.scheduledEnd.slice(11)} の予定を入れました`)
  } catch (err) {
    quickForm.busy = false
    const btn = $('[data-action="save-quick"]')
    if (btn) btn.disabled = false
    showQuickError(err.message)
    toastError(err.message)
  }
}

// ---------- navigation ----------

function selectDate(date) {
  if (!date) return
  selectedDate = date
  closeQuickForm()
  renderDay()
}

export function initDay() {
  $('#day-prev').addEventListener('click', () => selectDate(shiftIsoDate(selectedDate, -1)))
  $('#day-next').addEventListener('click', () => selectDate(shiftIsoDate(selectedDate, 1)))
  $('#day-today').addEventListener('click', () => selectDate(todayIso()))
  $('#day-picker').addEventListener('change', (ev) => selectDate(ev.target.value))

  $('#page-day').addEventListener('click', (ev) => {
    const detail = ev.target.closest('[data-action="open-todo-detail"]')
    if (detail) {
      openTodoDetail(Number(detail.dataset.id))
      return
    }
    const cell = ev.target.closest('[data-action="quick-add"]')
    if (cell) {
      openQuickForm(Number(cell.dataset.hour))
      return
    }
    if (ev.target.closest('[data-action="save-quick"]')) {
      void saveQuickForm()
      return
    }
    if (ev.target.closest('[data-action="cancel-quick"]')) {
      closeQuickForm()
      return
    }
    if (ev.target.closest('[data-action="refresh-calendar"]')) {
      void refreshCalendarNow()
      return
    }
    if (ev.target.closest('[data-action="open-settings"]')) {
      openSettingsDialog()
    }
  })
  $('#page-day').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.closest('.day-due-item')) {
      ev.preventDefault()
      openTodoDetail(Number(ev.target.closest('.day-due-item').dataset.id))
      return
    }
    if (ev.key === 'Enter' && quickForm && ev.target.closest('#day-quick-form') && ev.target.tagName !== 'BUTTON') {
      ev.preventDefault()
      void saveQuickForm()
    }
    if (ev.key === 'Escape' && quickForm) {
      closeQuickForm()
    }
  })
  // 「新しいTODOを作る」を選んでいるときだけタイトル欄を出す。
  $('#day-quick-form').addEventListener('change', (ev) => {
    if (ev.target.id !== 'day-quick-todo') return
    $('#day-quick-title-field').hidden = ev.target.value !== ''
    showQuickError(null)
  })

  setInterval(() => {
    if (!isPageActive()) return
    // 現在時刻の線と一緒に、サーバーが取り直したカレンダーの予定も拾う。
    if (!calendar.loading) void loadCalendar(selectedDate)
    renderDay()
  }, NOW_TICK_MS)
}
