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

import { api } from './api.js'
import { refreshBoth } from './data.js'
import {
  buildSchedulePatch,
  dueTodosOn,
  formatDayHeading,
  formatTimeRange,
  hasSchedule,
  layoutBlocks,
  MINUTES_PER_DAY,
  minutesOfTime,
  scheduledTodosOn,
  timeOfMinutes,
  DEFAULT_DURATION_MINUTES,
} from './lib/schedule.js'
import { shiftIsoDate } from './lib/isoDate.js'
import { priorityBadge } from './lib/priorityBadge.js'
import { getState } from './state.js'
import { openTodoDetail } from './todoDetailDialog.js'
import { $, escapeHtml, toast, toastError, todayIso } from './utils.js'

const NOW_TICK_MS = 60_000

let selectedDate = todayIso()
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
  const badge = priorityBadge(todo.priority)
  if (!badge) return ''
  return `<span class="prio-badge ${badge.className}">${badge.label}</span>`
}

// 一覧の ms-chip と同じ見た目だが、ここでは紐付けの変更はしないので
// data-ms-chip を付けず、クリックは行ごと詳細を開く。
function msChip(todo) {
  if (!todo.milestoneId) return ''
  const color = escapeHtml(todo.milestoneColor ?? '#6ca4f8')
  return `<span class="ms-chip" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)"><span class="ms-dot" style="background:${color}"></span>${escapeHtml(todo.milestoneTitle)}</span>`
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
  $('#day-due-count').textContent = due.length ? `${due.length}件` : ''
  $('#day-due-list').innerHTML = due.length
    ? due.map(dueItem).join('')
    : `<p class="day-due-empty">この日が期日のTODOはありません。</p>`
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

function blockHtml(block) {
  const { todo, startMin, endMin, col, cols } = block
  const done = todo.status === 'done'
  const color = escapeHtml(todo.milestoneColor ?? '')
  const top = (startMin / MINUTES_PER_DAY) * 100
  const height = ((endMin - startMin) / MINUTES_PER_DAY) * 100
  const left = (col / cols) * 100
  const width = 100 / cols
  // 45 分未満(--hour-h: 44px で 33px 弱)は 2 行入らないので、時刻を
  // タイトルの前に畳んで 1 行にする。
  const short = endMin - startMin < 45
  const range = escapeHtml(formatTimeRange(todo))
  const style = `top:${top}%;height:${height}%;left:${left}%;width:calc(${width}% - 3px);${color ? `--block-color:${color}` : ''}`
  return `<button type="button" class="day-block ${done ? 'd' : ''} ${short ? 'short' : ''}" data-action="open-todo-detail" data-id="${todo.id}" style="${style}" title="#${todo.id} ${escapeHtml(todo.title)} (${range})">
    <span class="tm">${range}</span><span class="ttl">${short ? `<span class="tm-inline">${range}</span> ` : ''}${escapeHtml(todo.title)}</span>
  </button>`
}

function nowLineHtml() {
  if (selectedDate !== todayIso()) return ''
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  return `<div class="day-now" style="top:${(minutes / MINUTES_PER_DAY) * 100}%" aria-hidden="true"></div>`
}

function renderTimeline(todos) {
  const blocks = layoutBlocks(scheduledTodosOn(todos, selectedDate))
  $('#day-hours').innerHTML = hourLabels()
  $('#day-canvas').innerHTML = hourCells() + blocks.map(blockHtml).join('') + nowLineHtml()
  $('#day-timeline-note').textContent = blocks.length
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
  renderDueList(todos)
  renderTimeline(todos)
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
    if (isPageActive()) renderDay()
  }, NOW_TICK_MS)
}
