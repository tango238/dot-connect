// 目標ページの「今週終わらせるタスク」: 目標の下に並ぶ、その週に片付ける
// TODO の実行順。目標の生成で拾われた TODO が足され、手でも足す・外す・
// 並べ替える。各行で期日を直せる(週に入れた TODO には必ず期日が付く)。
//
// 並び(todoIds)はサーバー(week_queue)が正で、行の中身は state.todos から
// 引く —— 10 秒ポーリングや SSE で状態が動けば、そのまま行に反映される。
// 自動投入(autoRun.js)はここと同じ並びを、今週分だけ自分で読む。

import { api } from './api.js'
import { refreshTodos } from './data.js'
import { dispatchDisabledReason } from './lib/capabilities.js'
import { dueBadge } from './lib/dueBadge.js'
import { priorityBadge } from './lib/priority.js'
import { SESSION_LABEL } from './lib/todoDetail.js'
import { mondayOf } from './lib/week.js'
import { autoRunPlan, dispatchReadiness, moveId, queueModeLabel } from './lib/weekQueue.js'
import { wipBlockedReason } from './lib/wipLimit.js'
import { openPromptDialog } from './promptDialog.js'
import { getState, setState } from './state.js'
import { openTodoDetail } from './todoDetailDialog.js'
import { $, escapeHtml, toast, toastError, todayIso } from './utils.js'

let queue = { weekStart: null, weekEnd: null, todoIds: [], fetched: new Map(), dispatch: new Map(), loaded: false, busy: false }
// 画面の描き直しで消えないよう、追加セレクトの選択は別に持つ。
let addDraft = ''

export const QUEUE_CHANGED_EVENT = 'dotconnect:queue-changed'

/** 今日の属する週(月曜)。todayIso はローカル壁時計の日付(UTC だと JST の深夜にずれる)。 */
export function currentWeekStart() {
  return mondayOf(todayIso())
}

function notifyChanged() {
  document.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT, { detail: { weekStart: queue.weekStart } }))
}

// 今週の並びは state にも置く(TODO 一覧の「目標に登録」と autoRun.js が読む)。
function publishIfCurrent(data) {
  if (data.weekStart === currentWeekStart()) {
    setState({ weekQueue: { weekStart: data.weekStart, weekEnd: data.weekEnd, todos: data.todos } })
  }
}

function applyQueue(data) {
  queue = {
    ...queue,
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    todoIds: data.todos.map((t) => t.id),
    fetched: new Map(data.todos.map((t) => [t.id, t])),
    dispatch: new Map(data.todos.map((t) => [t.id, t.dispatch !== false])),
    loaded: true,
  }
  publishIfCurrent(data)
}

/** 今週の並びを読み直して state.weekQueue に置く(表示中の週とは別)。 */
export async function refreshCurrentWeekQueue() {
  const weekStart = currentWeekStart()
  try {
    const data = await api.getWeekQueue(weekStart)
    publishIfCurrent(data)
    if (queue.weekStart === weekStart) applyQueue(data)
  } catch {
    // 次の tick でまた試す。
  }
}

/** TODO 一覧の「目標に登録」: 今週の並びの末尾に足す(期日が無ければ週末が付く)。 */
export async function addTodoToCurrentWeek(todoId) {
  const weekStart = currentWeekStart()
  const data = await api.addToWeekQueue(weekStart, todoId)
  publishIfCurrent(data)
  if (queue.weekStart === weekStart) {
    applyQueue(data)
    renderWeekQueue()
  }
  await refreshTodos()
  notifyChanged()
  return data
}

/** 並びの TODO を、state にあれば最新のそれで、無ければ取得時のもので返す。
 * 各要素に queueDispatch(herdr に投入する対象か)を付ける。 */
export function queueTodos() {
  const byId = new Map(getState().todos.map((t) => [t.id, t]))
  return queue.todoIds
    .map((id) => {
      const todo = byId.get(id) ?? queue.fetched.get(id)
      return todo ? { ...todo, queueDispatch: queue.dispatch.get(id) !== false } : null
    })
    .filter(Boolean)
}

export async function loadQueue(weekStart) {
  queue = { ...queue, weekStart, loaded: false }
  try {
    const data = await api.getWeekQueue(weekStart)
    if (queue.weekStart !== weekStart) return
    applyQueue(data)
  } catch (err) {
    if (queue.weekStart !== weekStart) return
    toastError(`今週のタスク一覧を取得できませんでした: ${err.message}`)
  }
  renderWeekQueue()
}

async function mutate(run) {
  if (queue.busy) return
  queue = { ...queue, busy: true }
  renderWeekQueue()
  try {
    const data = await run()
    if (data) applyQueue(data)
  } catch (err) {
    toastError(err.message)
  } finally {
    queue = { ...queue, busy: false }
    renderWeekQueue()
    notifyChanged()
  }
}

function statusIcon(todo) {
  if (todo.status === 'done') return '✔'
  if (todo.grillDir) return '🔥'
  if (todo.sessionState === 'working') return '▶'
  if (todo.sessionState === 'blocked') return '⏸'
  return '○'
}

function sessionBadge(todo) {
  if (!todo.sessionState) return ''
  const label = SESSION_LABEL[todo.sessionState] ?? todo.sessionState
  return `<span class="sess ${escapeHtml(todo.sessionState)}"><span class="s-dot"></span>${escapeHtml(label)}</span>`
}

// herdr / 自分 の印(表示だけ。切り替えは TODO 側 —— lib/weekQueue.js の queueModeLabel)。
function modeBadge(todo) {
  const mode = queueModeLabel(todo)
  if (!mode) return ''
  return `<span class="queue-mode ${mode.mode}" title="${escapeHtml(mode.title)}">${escapeHtml(mode.label)}</span>`
}

function readinessBadge(todo) {
  if (todo.status === 'done' || todo.queueDispatch === false) return ''
  const reason = dispatchReadiness(todo)
  if (reason === null) return `<span class="queue-ready" title="Grilled 済み・作業ディレクトリあり。自動投入の候補になります">投入可</span>`
  if (todo.sessionState && !todo.grillDir) return ''
  return `<span class="queue-wait" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>`
}

// 手動投入: 自動投入が空けておくバッファぶんも使える(上限は WIP可能数)。
// herdr が無い環境や WIP 上限では押せない(理由をホバーで)。
function dispatchButton(todo) {
  if (todo.status === 'done' || dispatchReadiness(todo) !== null) return ''
  const { capabilities, settings, todos } = getState()
  const reason = dispatchDisabledReason(capabilities) ?? wipBlockedReason(settings, todos)
  return reason
    ? `<button type="button" class="btn btn-accent queue-dispatch" data-action="queue-dispatch" data-id="${todo.id}" disabled title="${escapeHtml(reason)}">▶ 投入</button>`
    : `<button type="button" class="btn btn-accent queue-dispatch" data-action="queue-dispatch" data-id="${todo.id}" title="herdr に投入します(プロンプト・作業ディレクトリ・モデルを確認してから)">▶ 投入</button>`
}

function rowHtml(todo, index, count) {
  const done = todo.status === 'done'
  const prio = priorityBadge(todo)
  const due = dueBadge(todo.dueDate, todayIso())
  const disabled = queue.busy ? 'disabled' : ''
  return `<div class="queue-row ${done ? 'd' : ''}" data-id="${todo.id}">
    <div class="queue-order">
      <button type="button" class="btn btn-ghost" data-action="queue-up" data-id="${todo.id}" title="上へ" ${index === 0 || disabled ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-ghost" data-action="queue-down" data-id="${todo.id}" title="下へ" ${index === count - 1 || disabled ? 'disabled' : ''}>↓</button>
    </div>
    <span class="queue-no">${index + 1}</span>
    <span class="st">${statusIcon(todo)}</span>
    <button type="button" class="queue-title" data-action="open-todo-detail" data-id="${todo.id}" title="クリックで詳細を表示"><span class="todo-id">#${todo.id}</span> ${escapeHtml(todo.title)}</button>
    ${prio ? `<span class="prio-badge ${prio.className}" title="${prio.title}">${prio.label}</span>` : ''}
    ${modeBadge(todo)}${sessionBadge(todo)}${readinessBadge(todo)}${dispatchButton(todo)}
    <label class="queue-due ${due?.className ?? ''}" title="期日(変えるとすぐ保存)">期日
      <input type="date" data-action="queue-due" data-id="${todo.id}" value="${escapeHtml(todo.dueDate ?? '')}" ${disabled}>
    </label>
    <button type="button" class="btn btn-ghost queue-remove" data-action="queue-remove" data-id="${todo.id}" title="今週の一覧から外す(TODO は消えません)" ${disabled}>✕</button>
  </div>`
}

function addOptionsHtml() {
  const inQueue = new Set(queue.todoIds)
  const candidates = getState()
    .todos.filter((t) => t.status !== 'done' && !inQueue.has(t.id))
    .sort((a, b) => a.id - b.id)
  return (
    `<option value="">＋ TODO を今週の一覧に足す…</option>` +
    candidates.map((t) => `<option value="${t.id}" ${String(t.id) === addDraft ? 'selected' : ''}>#${t.id} ${escapeHtml(t.title)}</option>`).join('')
  )
}

function autoHtml(todos) {
  const { settings } = getState()
  const plan = autoRunPlan(todos, getState().todos, settings)
  const { capacity } = plan
  const enabled = settings?.autoRunEnabled ?? false
  const disabled = settings === null ? 'disabled' : ''
  const next = plan.candidate
    ? `次の候補: <button type="button" class="queue-title inline" data-action="open-todo-detail" data-id="${plan.candidate.id}">#${plan.candidate.id} ${escapeHtml(plan.candidate.title)}</button>${capacity.free > 0 ? '' : '(空きが出たら提案します)'}`
    : plan.waiting.length
      ? `投入できる候補がありません。${escapeHtml(plan.waiting[0].reason)}: #${plan.waiting[0].todo.id}`
      : todos.length
        ? '残りの候補はありません'
        : ''
  return `<label class="settings-check"><input type="checkbox" data-action="auto-toggle" ${enabled ? 'checked' : ''} ${disabled}> 自動投入</label>
    <span class="queue-cap" title="同時に走らせる上限 = WIP可能数 − バッファ">同時 ${capacity.slots} 枠 = WIP可能数 ${capacity.limit} − バッファ
      <input type="number" class="settings-number queue-buffer" data-action="auto-buffer" min="0" max="29" step="1" value="${capacity.buffer}" aria-label="バッファ" ${disabled}>
    </span>
    <span class="queue-cap" title="自動投入が使う空き。手動の「投入」はバッファぶんも使えます(WIP可能数 ${capacity.limit} まで)">実行中 ${capacity.running} · 自動の空き ${capacity.free}</span>
    <span class="queue-next ${enabled ? '' : 'dim'}">${next}</span>`
}

export function renderWeekQueue() {
  const section = $('#report-week-queue')
  if (!section || section.hidden) return
  const todos = queueTodos()
  const open = todos.filter((t) => t.status !== 'done').length
  $('#queue-count').textContent = queue.loaded ? `${open}件${todos.length !== open ? ` / 完了 ${todos.length - open}` : ''}` : ''
  $('#queue-week').textContent = queue.weekEnd ? `期日の既定 ${queue.weekEnd.slice(5).replace('-', '/')}(週末)` : ''
  $('#queue-auto').innerHTML = autoHtml(todos)
  const list = $('#queue-list')
  if (!queue.loaded) {
    list.innerHTML = `<p class="queue-empty">読み込み中…</p>`
  } else if (todos.length === 0) {
    list.innerHTML = `<p class="queue-empty">まだありません。「目標を生成」で期限・優先度から拾うか、下から足してください。</p>`
  } else {
    list.innerHTML = todos.map((t, i) => rowHtml(t, i, todos.length)).join('')
  }
  const select = $('#queue-add-select')
  const keep = select?.value ?? addDraft
  $('#queue-add').innerHTML = `<select id="queue-add-select" aria-label="足す TODO" ${queue.busy || !queue.loaded ? 'disabled' : ''}>${addOptionsHtml()}</select>
    <button type="button" class="btn" data-action="queue-add" ${queue.busy || !queue.loaded ? 'disabled' : ''}>追加</button>`
  if (keep) $('#queue-add-select').value = keep
}

function reorder(nextIds) {
  void mutate(() => api.reorderWeekQueue(queue.weekStart, nextIds))
}

async function changeDue(id, value) {
  const todo = queueTodos().find((t) => t.id === id)
  if (!todo) return
  if (!value) {
    toastError('今週の一覧にある TODO の期日は空にできません')
    renderWeekQueue()
    return
  }
  try {
    await api.updateTodo(id, { dueDate: value })
    await refreshTodos()
    toast(`#${id} の期日を ${value.slice(5).replace('-', '/')} にしました`)
  } catch (err) {
    toastError(err.message)
    renderWeekQueue()
  }
}

async function saveAutoRun(patch) {
  try {
    const settings = await api.updateSettings(patch)
    setState({ settings })
    if (patch.autoRunEnabled !== undefined) {
      toast(patch.autoRunEnabled ? '自動投入を有効にしました。投入のたびに確認します' : '自動投入を止めました')
    }
  } catch (err) {
    toastError(err.message)
    renderWeekQueue()
  }
}

function handleClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn || btn.tagName === 'INPUT') return
  const action = btn.dataset.action
  const id = Number(btn.dataset.id)
  if (action === 'open-todo-detail') openTodoDetail(id)
  else if (action === 'queue-dispatch') {
    const todo = queueTodos().find((t) => t.id === id)
    if (todo) openPromptDialog(todo)
  } else if (action === 'queue-up') reorder(moveId(queue.todoIds, id, -1))
  else if (action === 'queue-down') reorder(moveId(queue.todoIds, id, 1))
  else if (action === 'queue-remove') void mutate(() => api.removeFromWeekQueue(queue.weekStart, id))
  else if (action === 'queue-add') {
    const raw = $('#queue-add-select')?.value
    if (!raw) {
      toastError('足す TODO を選んでください')
      return
    }
    addDraft = ''
    void mutate(async () => {
      const data = await api.addToWeekQueue(queue.weekStart, Number(raw))
      await refreshTodos() // 期日が自動で付いたぶんを一覧にも反映
      return data
    })
  }
}

function handleChange(ev) {
  const el = ev.target
  const action = el.dataset?.action
  if (el.id === 'queue-add-select') addDraft = el.value
  else if (action === 'queue-due') void changeDue(Number(el.dataset.id), el.value)
  else if (action === 'auto-toggle') void saveAutoRun({ autoRunEnabled: el.checked })
  else if (action === 'auto-buffer') {
    const buffer = Number(el.value)
    if (!Number.isInteger(buffer) || buffer < 0 || buffer > 29) {
      toastError('バッファは 0〜29 の整数で指定してください')
      renderWeekQueue()
      return
    }
    void saveAutoRun({ autoRunBuffer: buffer })
  }
}

export function initWeekQueue() {
  const section = $('#report-week-queue')
  section.addEventListener('click', handleClick)
  section.addEventListener('change', handleChange)
}
