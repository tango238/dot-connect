// TODO page: filtering, row rendering, and all todo-level actions.

import { api } from './api.js'
import { refreshBoth, refreshTodos, refreshWorkspaces, toggleTodoComplete } from './data.js'
import { dispatchDisabledReason, sessionFocusDisabledReason } from './lib/capabilities.js'
import { wipBlockedReason } from './lib/wipLimit.js'
import { dueBadge } from './lib/dueBadge.js'
import { shouldRestoreCapturedForm } from './lib/formCapture.js'
import { hasOpenForm } from './lib/formGuard.js'
import { modelBadge } from './lib/modelBadge.js'
import { buildModelCreatePatch, buildModelEditPatch } from './lib/modelPatch.js'
import { buildModelSelectChoices, resolveModelSelectValue } from './lib/modelOptions.js'
import { priorityBadge } from './lib/priorityBadge.js'
import { pullRequestCount } from './lib/pullRequest.js'
import { SESSION_LABEL } from './lib/todoDetail.js'
import { BUCKET_LABEL, isRecentlyCompleted, matchesFilter, todoBucket } from './lib/todoFilter.js'
import { needsCompletionConfirm } from './lib/completionConfirm.js'
import { groupByRecentActivity } from './lib/todoActivity.js'
import { sortActiveTodos } from './lib/todoOrder.js'
import { buildWorkspaceDatalistOptions } from './lib/workspaceOptions.js'
import { buildWorkspacePathCreatePatch, buildWorkspacePathEditPatch } from './lib/workspacePathPatch.js'
import { openLinkMenu } from './linkMenu.js'
import { openPromptDialog } from './promptDialog.js'
import { openWorkspaceManager } from './workspaceManager.js'
import { activeMilestones, getState, setState } from './state.js'
import { openTodoDetail } from './todoDetailDialog.js'
import { $, $all, escapeHtml, toast, toastError, toastWarning, todayIso, twoStepConfirm, withButtonBusy } from './utils.js'

// Which todo currently has its inline title/description edit form open.
let editFormTodoId = null

// Synthetic id for the new-todo form in captureOpenFormValues/
// restoreOpenFormValues below — it has no todo id of its own yet.
const NEW_FORM_ID = 'new'

// Exported so main.js's poll loop can skip a background refresh while this
// is open — otherwise the poll-triggered re-render rebuilds the row from
// state and wipes out whatever the user is mid-typing (F43).
export function hasOpenTodoForm() {
  return hasOpenForm(editFormTodoId)
}

function sessBadge(todo) {
  if (!todo.sessionState) return ''
  const label = SESSION_LABEL[todo.sessionState] ?? todo.sessionState
  const pane = todo.herdrPaneId ? `${escapeHtml(todo.herdrPaneId)} · ` : ''
  return `<span class="sess ${todo.sessionState}"><span class="s-dot"></span>${pane}${label}</span>`
}

// Silent when no due date is set, like the priority/model badges below.
// Also silent once the todo is done — the row already shows its completion
// date, so a red "overdue" badge on finished work would be misleading.
function dueBadgeHtml(todo) {
  if (todo.status === 'done') return ''
  const badge = dueBadge(todo.dueDate, todayIso())
  if (!badge) return ''
  return `<span class="due-badge ${badge.className}" title="期限">${escapeHtml(badge.label)}</span>`
}

function prioBadge(todo) {
  const badge = priorityBadge(todo.priority)
  if (!badge) return ''
  return `<span class="prio-badge ${badge.className}">${badge.label}</span>`
}

// Only shown when a todo overrides the default model — the common case
// (unspecified) stays silent so the row list isn't noisy.
function modelBadgeHtml(todo) {
  const badge = modelBadge(todo.model)
  if (!badge) return ''
  return `<span class="model-badge" title="投入モデル">${escapeHtml(badge.label)}</span>`
}

// PR待ちであることは行から分かる必要がある——PRだけあってセッションが無い
// TODOには、これが無いとバッジが1つも出ない。
function reviewBadge(todo) {
  if (todoBucket(todo) !== 'pr-review') return ''
  return `<span class="review-badge">${BUCKET_LABEL['pr-review']}</span>`
}

// Only a count, not the PRs themselves — the row has no space for URLs, and
// the detail dialog is where they're actually read and managed. Silent when
// none are linked, like the priority/model badges above.
function prCountBadge(todo) {
  const count = pullRequestCount(todo)
  if (count === 0) return ''
  return `<span class="pr-count-badge" title="紐付けられたPR">PR ${count}</span>`
}

function priorityOptions(selected) {
  const options = [
    { value: 'none', label: 'なし' },
    { value: 'low', label: '低' },
    { value: 'high', label: '高' },
  ]
  return options
    .map((o) => `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`)
    .join('')
}

function modelOptions(selected) {
  return buildModelSelectChoices(getState().models)
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    )
    .join('')
}

/** Rebuilds the shared #workspace-datalist from state.workspaces. Exported
 * so main.js can call it on every state change alongside renderSidebar()/
 * renderActivePage() — unlike those, this never touches a form's own
 * <input>, so it's always safe to re-run regardless of which page is
 * active or which inline form (if any) is open (see index.html's comment
 * on the <datalist> element). */
export function renderWorkspaceDatalist() {
  const el = $('#workspace-datalist')
  if (!el) return
  el.innerHTML = buildWorkspaceDatalistOptions(getState().workspaces)
    .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
    .join('')
}

function msChip(todo) {
  if (!todo.milestoneId) {
    return `<span class="ms-chip none" role="button" tabindex="0" data-ms-chip data-id="${todo.id}" title="クリックして紐付け">＋ マイルストーン未紐付け</span>`
  }
  const color = escapeHtml(todo.milestoneColor ?? '#6ca4f8')
  return `<span class="ms-chip" role="button" tabindex="0" data-ms-chip data-id="${todo.id}" title="クリックして変更/解除" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)"><span class="ms-dot" style="background:${color}"></span>${escapeHtml(todo.milestoneTitle)}</span>`
}

function todoActions(todo) {
  // Editing title/description is allowed regardless of status/session, same
  // as milestone editing — so it's built once and prepended everywhere.
  const editBtn = `<button class="btn btn-ghost" data-action="toggle-edit-todo" data-id="${todo.id}">編集</button>`
  const del = `<button class="btn btn-ghost del-btn" aria-label="TODOを削除" title="削除" data-action="delete" data-id="${todo.id}">🗑</button>`
  if (todo.status === 'done') {
    const date = todo.completedAt ? escapeHtml(todo.completedAt.slice(0, 10)) : ''
    return `<span class="todo-date">✔ ${date}</span>${editBtn}${del}`
  }
  if (todo.sessionState) {
    // Focusing a pane needs herdr on this machine. Where it's missing the
    // button is greyed out with the reason on hover rather than dropped —
    // the row still has a session worth showing, just no way to jump to it.
    const focusReason = sessionFocusDisabledReason(getState().capabilities)
    const openBtn = focusReason
      ? `<button class="btn" data-action="open-session" data-id="${todo.id}" disabled title="${escapeHtml(focusReason)}">セッションを開く</button>`
      : `<button class="btn" data-action="open-session" data-id="${todo.id}">セッションを開く</button>`
    const completeBtn =
      todo.sessionState !== 'working'
        ? `<button class="btn btn-ghost" data-action="toggle-complete" data-id="${todo.id}">完了にする</button>`
        : ''
    return `${openBtn}${completeBtn}${editBtn}${del}`
  }
  // workspacePath is now chosen in the dispatch dialog itself (prefilled
  // from the todo, editable there), so the dispatch button is always
  // available regardless of whether one is saved yet — the one thing that
  // does gate it is an environment that can't dispatch at all, where it's
  // greyed out here (the entry point) as well as inside the dialog.
  // A full WIP limit greys it out the same way: the slot frees up only by
  // completing or deleting a running todo (the server refuses either way).
  const { capabilities, settings, todos } = getState()
  const dispatchReason = dispatchDisabledReason(capabilities) ?? wipBlockedReason(settings, todos)
  const dispatchBtn = dispatchReason
    ? `<button class="btn btn-accent" data-action="dispatch" data-id="${todo.id}" disabled title="${escapeHtml(dispatchReason)}">▶ herdrに投入</button>`
    : `<button class="btn btn-accent" data-action="dispatch" data-id="${todo.id}">▶ herdrに投入</button>`
  return `${dispatchBtn}${editBtn}${del}`
}

function editTodoForm(todo) {
  if (editFormTodoId !== todo.id) return ''
  return `<div class="inline-form stacked todo-inline-form" data-edit-todo-form="${todo.id}">
    <div class="form-field grow">
      <label for="todo-edit-title-${todo.id}">タイトル</label>
      <input id="todo-edit-title-${todo.id}" type="text" required value="${escapeHtml(todo.title)}">
    </div>
    <div class="form-field grow">
      <label for="todo-edit-desc-${todo.id}">説明</label>
      <textarea id="todo-edit-desc-${todo.id}" rows="3">${escapeHtml(todo.description ?? '')}</textarea>
    </div>
    <div class="form-field">
      <label for="todo-edit-priority-${todo.id}">優先度</label>
      <select id="todo-edit-priority-${todo.id}">${priorityOptions(todo.priority ?? 'none')}</select>
    </div>
    <div class="form-field">
      <label for="todo-edit-due-${todo.id}">期限(任意)</label>
      <input id="todo-edit-due-${todo.id}" type="date" value="${escapeHtml(todo.dueDate ?? '')}">
    </div>
    <div class="form-field grow">
      <label for="todo-edit-ws-${todo.id}">作業ディレクトリ(任意)</label>
      <input id="todo-edit-ws-${todo.id}" type="text" list="workspace-datalist" value="${escapeHtml(todo.workspacePath ?? '')}" placeholder="例: /Users/you/projects/my-app (登録済みから選択、または自由入力)">
      <p class="field-hint">herdr投入時に必須。ここで設定しておくと投入時に引き継がれます。</p>
    </div>
    <div class="form-field">
      <label for="todo-edit-model-${todo.id}">モデル(任意)</label>
      <select id="todo-edit-model-${todo.id}">${modelOptions(resolveModelSelectValue(todo.model, getState().models))}</select>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-edit-todo" data-id="${todo.id}">保存</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-edit-todo">キャンセル</button>
    </div>
    <div class="form-error" id="todo-edit-error-${todo.id}" hidden></div>
  </div>`
}

function todoRow(todo) {
  const done = todo.status === 'done'
  const descLine = todo.description
    ? `<div class="todo-desc">${escapeHtml(todo.description)}</div>`
    : ''
  return `<div class="todo ${done ? 'is-done' : ''}" data-todo-id="${todo.id}">
    <button class="todo-check" aria-label="完了切り替え" data-action="toggle-complete" data-id="${todo.id}">✔</button>
    <div class="todo-main">
      <div class="todo-title" role="button" tabindex="0" data-action="open-todo-detail" data-id="${todo.id}" title="クリックで詳細を表示"><span class="todo-id">#${todo.id}</span> ${escapeHtml(todo.title)}</div>
      ${descLine}
      <div class="todo-meta">${dueBadgeHtml(todo)}${prioBadge(todo)}${reviewBadge(todo)}${modelBadgeHtml(todo)}${prCountBadge(todo)}${msChip(todo)}${sessBadge(todo)}<span class="todo-date">${escapeHtml(todo.workspacePath ?? '')}</span></div>
    </div>
    <div class="todo-actions">${todoActions(todo)}</div>
    ${editTodoForm(todo)}
  </div>`
}

// 未完了を上、直近7日の完了を下のグループに分けた既定のレイアウト。
function groupedTodoListHtml(list, today) {
  // サーバの並び(期限昇順)ではなく、今日を知っている画面側で並べ直す
  // ——順序の根拠は todoOrder.js を参照。
  const active = sortActiveTodos(
    list.filter((t) => t.status !== 'done'),
    today
  )
  // 完了は直近7日ぶんだけ。件数ラベルも同じ配列から出すので、表示と件数が
  // ずれない。sort は filter が返した新しい配列に対して行うので state は
  // 壊さない。
  const done = list
    .filter((t) => t.status === 'done' && isRecentlyCompleted(t, today))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
  const html = active.map(todoRow).join('')
  if (!done.length) {
    return html
  }
  return `${html}<div class="todo-group-label">完了 — ${done.length}件</div>${done.map(todoRow).join('')}`
}

// 「最近の更新」の中身。直近1/3/7/14/30日の区切りで見出しを立てる——同じ
// 30日の一列にすると「昨日触ったもの」と「3週間前に触ったもの」が地続きに
// 見えてしまい、鮮度が読み取れない。該当の無い区切りは見出しごと出さない。
function recentActivityHtml(list, today) {
  return groupByRecentActivity(list, today)
    .map(
      (group) =>
        `<div class="todo-group-label">${group.label} — ${group.todos.length}件</div>` +
        group.todos.map(todoRow).join('')
    )
    .join('')
}

// 空表示。既定が「最近の更新」なので、しばらくぶりに開くと30日の足切りで
// 1件も出ないことがある——そのとき「該当なし」とだけ出すと、TODOが消えたのか
// 絞り込まれているのかが分からない。既定のときだけ逃げ道を添える。
function emptyMessage(filter) {
  if (filter === 'recent') {
    return `<p class="page-sub">直近30日に動いたTODOはありません。「すべて」で全件を表示できます。</p>`
  }
  return `<p class="page-sub">該当するTODOはありません。</p>`
}

function renderTodoList() {
  const { todos, filter } = getState()
  const today = todayIso()
  const list = todos.filter((t) => matchesFilter(t, filter, today))
  // 「最近の更新」だけは形が違う: 未完了/完了のグループ分けも優先度の並べ替え
  // もせず、最終更新の新しさで区切ってまとめる(理由は todoActivity.js)。
  const html =
    filter === 'recent' ? recentActivityHtml(list, today) : groupedTodoListHtml(list, today)
  $('#todo-list').innerHTML = html || emptyMessage(filter)
}

function milestoneOptions(selectedId) {
  return activeMilestones()
    .map(
      (m) =>
        `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${escapeHtml(m.title)}</option>`
    )
    .join('')
}

function renderNewTodoForm() {
  const container = $('#new-todo-form')
  if (container.hidden) return
  container.innerHTML = `
    <div class="form-field grow">
      <label for="new-todo-title">タイトル</label>
      <input id="new-todo-title" type="text" required placeholder="例: ログイン画面のエラーハンドリングを追加">
    </div>
    <div class="form-field grow">
      <label for="new-todo-desc">説明(任意)</label>
      <textarea id="new-todo-desc" rows="10" placeholder="補足があれば"></textarea>
    </div>
    <div class="form-field">
      <label for="new-todo-ms">マイルストーン</label>
      <select id="new-todo-ms"><option value="">未紐付け</option>${milestoneOptions(null)}</select>
    </div>
    <div class="form-field">
      <label for="new-todo-priority">優先度</label>
      <select id="new-todo-priority">${priorityOptions('none')}</select>
    </div>
    <div class="form-field">
      <label for="new-todo-due">期限(任意)</label>
      <input id="new-todo-due" type="date">
    </div>
    <div class="form-field grow">
      <label for="new-todo-ws">作業ディレクトリ(任意)</label>
      <input id="new-todo-ws" type="text" list="workspace-datalist" placeholder="例: /Users/you/projects/my-app (登録済みから選択、または自由入力)">
      <p class="field-hint">herdr投入時に必須。ここで設定しておくと投入時に引き継がれます。</p>
    </div>
    <div class="form-field">
      <label for="new-todo-model">モデル(任意)</label>
      <select id="new-todo-model">${modelOptions('')}</select>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-accent" id="new-todo-submit">作成</button>
      <button type="button" class="btn btn-ghost" id="new-todo-cancel">キャンセル</button>
    </div>`
}

// Note: the new-todo form is only (re)built when it is opened (see initTodos),
// not on every state-driven render — otherwise a background poll refresh
// would wipe out whatever the user is currently typing.
export function renderTodos() {
  renderTodoList()
}

async function openSession(id) {
  try {
    await api.openTodoSession(id)
    toast('herdr セッションを前面化しました')
    await refreshTodos()
  } catch (err) {
    toastError(err.message)
  }
}

async function deleteTodo(id) {
  const todo = getState().todos.find((t) => t.id === id)
  try {
    await api.deleteTodo(id)
    toast(`「${escapeHtml(todo?.title ?? '')}」を削除しました`)
    await refreshBoth()
  } catch (err) {
    // A live herdr session blocks deletion (409): not a failure, a request
    // to end the session first — the message says so.
    if (err.extra?.code === 'session_alive' || err.extra?.code === 'session_unverified') {
      toastWarning(err.message)
    } else {
      toastError(err.message)
    }
  }
}

async function linkMilestone(todoId, milestoneId) {
  const todo = getState().todos.find((t) => t.id === todoId)
  try {
    await api.updateTodo(todoId, { milestoneId })
    toast(milestoneId ? `「${escapeHtml(todo?.title ?? '')}」の紐付けを変更しました` : '紐付けを解除しました')
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

async function createTodo() {
  const title = $('#new-todo-title').value.trim()
  if (!title) return
  const description = $('#new-todo-desc').value.trim()
  const msRaw = $('#new-todo-ms').value
  const priority = $('#new-todo-priority').value
  // 空欄は「期限なし」。作成時は null を送っても省略しても同じだが、更新と
  // 同じ形にしておく。
  const dueRaw = $('#new-todo-due').value
  const wsRaw = $('#new-todo-ws').value
  const modelRaw = $('#new-todo-model').value
  try {
    await api.createTodo({
      title,
      description,
      milestoneId: msRaw ? Number(msRaw) : null,
      priority,
      dueDate: dueRaw || null,
      ...buildWorkspacePathCreatePatch(wsRaw),
      ...buildModelCreatePatch(modelRaw),
    })
    toast('TODOを作成しました')
    $('#new-todo-form').hidden = true
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

async function saveEditTodo(id) {
  const title = $(`#todo-edit-title-${id}`)?.value.trim()
  const description = $(`#todo-edit-desc-${id}`)?.value.trim() ?? ''
  const priority = $(`#todo-edit-priority-${id}`)?.value
  const dueRaw = $(`#todo-edit-due-${id}`)?.value ?? ''
  const wsRaw = $(`#todo-edit-ws-${id}`)?.value ?? ''
  const modelRaw = $(`#todo-edit-model-${id}`)?.value ?? ''
  const errorEl = $(`#todo-edit-error-${id}`)
  if (!title) {
    if (errorEl) {
      errorEl.textContent = 'タイトルは必須です'
      errorEl.hidden = false
    }
    return
  }
  try {
    await api.updateTodo(id, {
      title,
      description,
      priority,
      dueDate: dueRaw || null,
      ...buildWorkspacePathEditPatch(wsRaw),
      ...buildModelEditPatch(modelRaw),
    })
    toast('TODOを更新しました')
    editFormTodoId = null
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

function handleListClick(ev) {
  const chip = ev.target.closest('[data-ms-chip]')
  if (chip) {
    const todo = getState().todos.find((t) => t.id === Number(chip.dataset.id))
    if (todo) {
      openLinkMenu({
        ev,
        headerLabel: 'マイルストーンに紐付け',
        options: activeMilestones().map((m) => ({ id: m.id, name: m.title, color: m.color })),
        selectedId: todo.milestoneId,
        onSelect: (milestoneId) => linkMilestone(todo.id, milestoneId),
      })
    }
    return
  }
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const id = Number(btn.dataset.id)
  const action = btn.dataset.action
  if (action === 'delete') {
    twoStepConfirm(btn, () => deleteTodo(id))
  } else if (action === 'toggle-complete') {
    // complete は herdr のワークスペースを畳むので、最大10秒ブロックしうる。
    // 押しっぱなしにすると二重送信になり、2回目は「元は走っていた」を判別
    // できないまま走る(todoCompletionService の done ガードが最後の砦だが、
    // そこに頼らせない)。
    const run = () => withButtonBusy(btn, () => toggleTodoComplete(id))
    const todo = getState().todos.find((t) => t.id === id)
    if (!needsCompletionConfirm(todo)) {
      run()
      return
    }
    // 丸い ✔ は文字を入れ替えられないので、色の変化だけでは何を待たれて
    // いるか分からない——そちらはトーストで補う。
    const isCheck = btn.classList.contains('todo-check')
    twoStepConfirm(btn, run, {
      armedText: isCheck ? null : '完了する？',
      restoreText: isCheck ? null : '完了にする',
      hint: isCheck ? 'もう一度クリックで完了します（herdrセッションも閉じます）' : null,
    })
  } else if (action === 'dispatch') {
    const todo = getState().todos.find((t) => t.id === id)
    if (todo) openPromptDialog(todo)
  } else if (action === 'open-session') {
    openSession(id)
  } else if (action === 'toggle-edit-todo') {
    editFormTodoId = editFormTodoId === id ? null : id
    renderTodoList()
  } else if (action === 'cancel-edit-todo') {
    editFormTodoId = null
    renderTodoList()
  } else if (action === 'save-edit-todo') {
    saveEditTodo(id)
  } else if (action === 'open-todo-detail') {
    openTodoDetail(id)
  }
}

function isNewFormOpen() {
  return !$('#new-todo-form').hidden
}

// Snapshots whichever inline form(s) are open — the new-todo form and an
// existing todo's edit form aren't mutually exclusive here (unlike
// milestones.js's add/edit pair), so both are captured independently.
// Used to survive refreshWorkspaces() after closing the workspace manager,
// which (like refreshLabelsAndMilestones() in milestones.js) triggers a
// full re-render that would otherwise wipe out whatever the user is
// mid-typing (F49).
function captureOpenFormValues() {
  const forms = []
  if (isNewFormOpen()) {
    forms.push({
      id: NEW_FORM_ID,
      title: $('#new-todo-title')?.value,
      desc: $('#new-todo-desc')?.value,
      ms: $('#new-todo-ms')?.value,
      priority: $('#new-todo-priority')?.value,
      due: $('#new-todo-due')?.value,
      ws: $('#new-todo-ws')?.value,
      model: $('#new-todo-model')?.value,
    })
  }
  if (editFormTodoId !== null) {
    const id = editFormTodoId
    forms.push({
      id,
      title: $(`#todo-edit-title-${id}`)?.value,
      desc: $(`#todo-edit-desc-${id}`)?.value,
      priority: $(`#todo-edit-priority-${id}`)?.value,
      due: $(`#todo-edit-due-${id}`)?.value,
      ws: $(`#todo-edit-ws-${id}`)?.value,
      model: $(`#todo-edit-model-${id}`)?.value,
    })
  }
  return forms
}

function currentOpenIdFor(entryId) {
  return entryId === NEW_FORM_ID ? (isNewFormOpen() ? NEW_FORM_ID : null) : editFormTodoId
}

function setFieldValue(elId, value) {
  const el = $(`#${elId}`)
  if (el && value !== undefined) el.value = value
}

/** Writes each captured snapshot back into the DOM — but only if that same
 * form is still open (the user may have closed or switched forms while the
 * refresh was in flight). */
function restoreOpenFormValues(captured) {
  for (const entry of captured) {
    if (!shouldRestoreCapturedForm(entry, currentOpenIdFor(entry.id))) continue
    if (entry.id === NEW_FORM_ID) {
      setFieldValue('new-todo-title', entry.title)
      setFieldValue('new-todo-desc', entry.desc)
      setFieldValue('new-todo-ms', entry.ms)
      setFieldValue('new-todo-priority', entry.priority)
      setFieldValue('new-todo-due', entry.due)
      setFieldValue('new-todo-ws', entry.ws)
      setFieldValue('new-todo-model', entry.model)
    } else {
      setFieldValue(`todo-edit-title-${entry.id}`, entry.title)
      setFieldValue(`todo-edit-desc-${entry.id}`, entry.desc)
      setFieldValue(`todo-edit-priority-${entry.id}`, entry.priority)
      setFieldValue(`todo-edit-due-${entry.id}`, entry.due)
      setFieldValue(`todo-edit-ws-${entry.id}`, entry.ws)
      setFieldValue(`todo-edit-model-${entry.id}`, entry.model)
    }
  }
}

export function initTodos() {
  $('#todo-list').addEventListener('click', handleListClick)

  // The title is a div with role="button", so Enter/Space have to be wired
  // up by hand to match what a real <button> would do.
  $('#todo-list').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const title = ev.target.closest('[data-action="open-todo-detail"]')
    if (!title) return
    ev.preventDefault()
    openTodoDetail(Number(title.dataset.id))
  })

  $all('.chip', document).forEach((chip) => {
    chip.addEventListener('click', () => {
      $all('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'))
      chip.setAttribute('aria-pressed', 'true')
      setState({ filter: chip.dataset.filter })
    })
  })

  $('#new-todo-toggle').addEventListener('click', () => {
    const form = $('#new-todo-form')
    form.hidden = !form.hidden
    if (!form.hidden) renderNewTodoForm()
  })

  $('#new-todo-form').addEventListener('click', (ev) => {
    if (ev.target.id === 'new-todo-submit') {
      ev.preventDefault()
      createTodo()
    } else if (ev.target.id === 'new-todo-cancel') {
      $('#new-todo-form').hidden = true
    }
  })

  $('#manage-workspaces-toggle').addEventListener('click', () => {
    openWorkspaceManager(async () => {
      const captured = captureOpenFormValues()
      await refreshWorkspaces()
      restoreOpenFormValues(captured)
    })
  })
}
