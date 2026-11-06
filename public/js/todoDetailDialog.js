// "TODO detail" modal, opened by clicking a row's title. The row itself
// truncates the description to one line and shows none of the timestamps, so
// this is where the full record is visible — and where the TODO is edited and
// its linked GitHub Pull Requests are added, refreshed, and removed.
//
// Only the todo's id is held here — never a copy of the todo. Every render
// re-reads it from state, so the 10s herdr poll keeps the open dialog
// current, and a todo deleted underneath us simply closes it. PR mutations
// go through refreshTodos() for the same reason: the dialog re-renders from
// the refreshed state rather than from a local copy of the response.

import { api } from './api.js'
import { refreshBoth, refreshTodos, toggleTodoComplete } from './data.js'
import { needsCompletionConfirm } from './lib/completionConfirm.js'
import { formatFileSize, uploadDisabledReason } from './lib/attachment.js'
import { dueBadge } from './lib/dueBadge.js'
import {
  pullRequestHeadline,
  pullRequestLabel,
  pullRequestNotice,
  pullRequestStateBadge,
} from './lib/pullRequest.js'
import { commentDraftError, isCommentSubmitShortcut, normalizeCommentBody } from './lib/todoComment.js'
import { buildModelEditPatch } from './lib/modelPatch.js'
import { buildSchedulePatch, scheduleFields } from './lib/schedule.js'
import { resolveModelSelectValue } from './lib/modelOptions.js'
import { DEFAULT_MINUTES, MAX_MINUTES, formatRemaining, isActive, remainingMs } from './lib/pomodoro.js'
import { DETAIL_GROUPS, detailRows, formatDateTime } from './lib/todoDetail.js'
import { todoFormFieldIds, todoFormFieldsHtml } from './lib/todoFormFields.js'
import { buildWorkspacePathEditPatch } from './lib/workspacePathPatch.js'
import { currentPomodoro, onPomodoroChange, startPomodoro } from './pomodoro.js'
import { isSettingsDialogOpen } from './settingsDialog.js'
import { getState, subscribe } from './state.js'
import { priorityLevel } from './lib/priority.js'
import { modelOptions, priorityLevelOptions } from './todoFormOptions.js'
import { $, escapeHtml, toast, toastError, todayIso, twoStepConfirm, withButtonBusy } from './utils.js'

let detailTodoId = null
// 閲覧状態の「期限」はその場で変えられる(編集を開かなくてよい)。選ぶと即保存。
const DUE_INPUT_ID = 'detail-due-input'
// Fields whose focus pauses poll-driven re-renders of this dialog — see the
// subscribe() call in initTodoDetailDialog.
const TYPING_FIELD_IDS = new Set(['pr-url-input', 'comment-body-input', 'pomodoro-minutes-input', DUE_INPUT_ID])
// Text in the "add a PR URL" field. Held here rather than read off the DOM
// at submit time because a background poll can re-render the dialog (and
// rebuild the input) while the user is mid-typing.
let pullRequestUrlValue = ''
// The File staged for upload, held here for the same reason: a re-render
// rebuilds the <input type="file">, and a file input's selection cannot be
// restored from script, so a background poll would otherwise silently discard
// what the user picked. The staged name is rendered underneath the input so
// the dialog still says what will be uploaded after such a re-render.
let selectedFile = null
// The 作業ログ draft, held here for the same reason as pullRequestUrlValue: a
// background poll can rebuild the <textarea> while the user is mid-sentence.
let commentDraft = ''
// The ポモドーロ minutes field, held here for the same reason.
let pomodoroMinutesValue = String(DEFAULT_MINUTES)
// The edit form's values while the TODO is being edited, null otherwise. Held
// here for the same reason as the drafts above: a re-render rebuilds the form.
let editDraft = null
// Edit form field id → editDraft key (the ids are todoFormFields.js's,
// prefixed detail-edit-*).
const EDIT_FIELDS = todoFormFieldIds('detail-edit')
// Pull Request / 添付ファイル の折りたたみ状態(開いているパネルのキー)。
// 10 秒ごとの再描画で <details> が閉じ直されないようにここで持つ。
// openTodoDetail() で中身のあるパネルだけ開いた状態に戻す。
const COLLAPSIBLE_PANELS = ['pull-requests', 'attachments']
let openPanels = new Set()
// Set while a PR or attachment request is in flight, to disable the buttons —
// these hit the network twice (DB + `gh`, or DB + disk), so a double click is
// easy to land.
let busy = false

function isOpen() {
  return detailTodoId !== null
}

// Exported so the poll loop can skip background refreshes while the TODO is
// being edited (see todos.js's hasOpenTodoForm).
export function isEditingTodoDetail() {
  return isOpen() && editDraft !== null
}

function currentTodo() {
  return getState().todos.find((t) => t.id === detailTodoId) ?? null
}

function milestoneLine(todo) {
  if (!todo.milestoneId) return ''
  const color = escapeHtml(todo.milestoneColor ?? '#6ca4f8')
  return `<div class="todo-meta"><span class="ms-chip" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)"><span class="ms-dot" style="background:${color}"></span>${escapeHtml(todo.milestoneTitle)}</span></div>`
}

function descriptionBlock(todo) {
  return todo.description
    ? `<div class="detail-desc">${escapeHtml(todo.description)}</div>`
    : `<div class="detail-empty">説明なし</div>`
}

function startEditing(todo) {
  editDraft = {
    title: todo.title,
    description: todo.description ?? '',
    urgency: String(priorityLevel(todo.urgency)),
    importance: String(priorityLevel(todo.importance)),
    dueDate: todo.dueDate ?? '',
    workspacePath: todo.workspacePath ?? '',
    model: resolveModelSelectValue(todo.model, getState().models),
  }
  const schedule = scheduleFields(todo)
  editDraft.schedDate = schedule.date
  editDraft.schedStart = schedule.start
  editDraft.schedEnd = schedule.end
}

function editFormBlock() {
  const fields = todoFormFieldsHtml({
    prefix: 'detail-edit',
    values: editDraft,
    options: { priority: priorityLevelOptions, model: modelOptions },
  })
  return `<div class="inline-form stacked detail-edit-form">
    ${fields}
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-edit-todo" ${busy ? 'disabled' : ''}>保存</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-edit-todo">キャンセル</button>
    </div>
    <div class="form-error" id="detail-edit-error" hidden></div>
  </div>`
}

async function saveEdit() {
  const title = editDraft.title.trim()
  if (!title) {
    showDialogError('#detail-edit-error', 'タイトルは必須です')
    return
  }
  const schedule = buildSchedulePatch({
    date: editDraft.schedDate,
    start: editDraft.schedStart,
    end: editDraft.schedEnd,
  })
  if (schedule.error) {
    showDialogError('#detail-edit-error', schedule.error)
    return
  }
  const todoId = detailTodoId
  const draft = editDraft
  busy = true
  renderDialog()
  try {
    await api.updateTodo(todoId, {
      title,
      description: draft.description.trim(),
      urgency: Number(draft.urgency),
      importance: Number(draft.importance),
      dueDate: draft.dueDate || null,
      ...schedule,
      ...buildWorkspacePathEditPatch(draft.workspacePath),
      ...buildModelEditPatch(draft.model),
    })
    editDraft = null
    // refreshBoth, not refreshTodos: a title change shows up in the
    // milestone cards too.
    await refreshBoth()
    toast('TODOを更新しました')
  } catch (err) {
    toastError(err.message)
    showDialogError('#detail-edit-error', err.message)
  } finally {
    busy = false
    renderDialog()
  }
}

function rowsBlock(todo) {
  // The timezone is left undefined so Intl uses the viewer's own; the due
  // date is compared against the viewer's local today. Rows are shown under
  // the same headings as the edit form's sections, so 編集 keeps every
  // item where the reader just saw it.
  const rows = detailRows(todo, undefined, todayIso())
  const groups = DETAIL_GROUPS.map((group) => {
    const own = rows.filter((row) => row.group === group && row.label !== '期限')
    // 期限は読むだけの行ではなく date 入力(未設定でも出す)。優先度・日程の先頭。
    const due = group === DETAIL_GROUPS[1] ? dueRowHtml(todo) : ''
    if (own.length === 0 && !due) return ''
    const dl = own
      .map(
        (row) =>
          `<dt>${escapeHtml(row.label)}</dt><dd class="${row.mono ? 'mono' : ''}">${escapeHtml(row.value)}</dd>`
      )
      .join('')
    return `<div class="detail-group"><div class="detail-group-title">${escapeHtml(group)}</div><dl class="detail-rows">${due}${dl}</dl></div>`
  })
  return `<div class="detail-groups">${groups.join('')}</div><div class="form-error" id="due-error" hidden></div>`
}

function dueRowHtml(todo) {
  const badge = dueBadge(todo.dueDate, todayIso())
  const badgeHtml = badge ? `<span class="due-badge ${badge.className}">${escapeHtml(badge.label)}</span>` : ''
  return `<dt><label for="${DUE_INPUT_ID}">期限</label></dt><dd class="detail-due">
    <input id="${DUE_INPUT_ID}" type="date" value="${escapeHtml(todo.dueDate ?? '')}" title="変えるとすぐ保存" ${busy ? 'disabled' : ''}>
    ${badgeHtml}
  </dd>`
}

// 期限の即時保存。今週の一覧にある TODO の期日は空にできない(週キューと同じ
// 約束 —— weekQueue.js の changeDue)。
async function changeDue(value) {
  const todo = currentTodo()
  if (!todo || (todo.dueDate ?? '') === value) return
  const inWeek = (getState().weekQueue?.todos ?? []).some((t) => t.id === todo.id)
  if (!value && inWeek) {
    showDialogError('#due-error', '今週の一覧にある TODO の期日は空にできません')
    renderDialog()
    return
  }
  const todoId = todo.id
  await runDialogAction(
    () => api.updateTodo(todoId, { dueDate: value || null }),
    value ? `期限を ${value.slice(5).replace('-', '/')} にしました` : '期限を外しました',
    '#due-error'
  )
}

// Pull Request / 添付ファイル は <details> で畳める。見出しに件数を出すので、
// 畳んだままでも何件あるかは分かる。
function collapsiblePanel(key, title, count, body) {
  const open = openPanels.has(key) ? ' open' : ''
  return `<details class="prompt-panel detail-panel" data-panel="${key}"${open}>
    <summary class="prompt-panel-head"><span>${title} (${count})</span></summary>
    ${body}
  </details>`
}

function stateBadgeHtml(pr) {
  const badge = pullRequestStateBadge(pr)
  if (!badge) return ''
  return `<span class="pr-state ${badge.className}">${escapeHtml(badge.label)}</span>`
}

function noticeHtml(pr) {
  const notice = pullRequestNotice(pr)
  if (!notice) return ''
  return `<p class="pr-notice">${escapeHtml(notice)}</p>`
}

function pullRequestRow(pr) {
  const disabled = busy ? 'disabled' : ''
  const headline = pullRequestHeadline(pr)
  const label = pullRequestLabel(pr)
  // When no title was ever fetched, the headline already *is* the
  // owner/repo#number identity — repeating it underneath reads as a bug.
  const subLine = headline === label ? '' : `<div class="pr-sub">${escapeHtml(label)}</div>`
  // rel="noopener noreferrer" on a target=_blank link to github.com: the
  // opened page must not get a window.opener handle back to this app.
  return `<div class="pr-row">
    <div class="pr-main">
      <div class="pr-head">${stateBadgeHtml(pr)}<a href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(headline)}</a></div>
      ${subLine}
      ${noticeHtml(pr)}
    </div>
    <div class="pr-actions">
      <button type="button" class="btn btn-ghost" data-action="refresh-pull-request" data-id="${pr.id}" ${disabled}>更新</button>
      <button type="button" class="btn btn-ghost del-btn" aria-label="PRの紐付けを削除" title="削除" data-action="delete-pull-request" data-id="${pr.id}" ${disabled}>🗑</button>
    </div>
  </div>`
}

function pullRequestsBlock(todo) {
  const rows = todo.pullRequests?.length
    ? todo.pullRequests.map(pullRequestRow).join('')
    : `<p class="prompt-panel-empty">PRはまだ紐付けられていません。</p>`
  return collapsiblePanel(
    'pull-requests',
    'Pull Request',
    todo.pullRequests?.length ?? 0,
    `${rows}
    <div class="pr-add">
      <input id="pr-url-input" type="url" value="${escapeHtml(pullRequestUrlValue)}" placeholder="https://github.com/owner/repo/pull/123" ${busy ? 'disabled' : ''}>
      <button type="button" class="btn" data-action="add-pull-request" ${busy ? 'disabled' : ''}>${busy ? '処理中…' : '追加'}</button>
    </div>
    <div class="form-error" id="pr-error" hidden></div>`
  )
}

function attachmentRow(attachment) {
  const disabled = busy ? 'disabled' : ''
  // originalName is whatever the uploader's filesystem allowed — arbitrary
  // user text of unbounded length, so it is escaped here and wrapped in CSS.
  return `<div class="attachment-row">
    <div class="attachment-main">
      <div class="attachment-name">${escapeHtml(attachment.originalName)}</div>
      <div class="attachment-size">${escapeHtml(formatFileSize(attachment.sizeBytes))}</div>
    </div>
    <div class="attachment-actions">
      <button type="button" class="btn btn-ghost" data-action="copy-attachment-path" data-id="${attachment.id}" ${disabled}>パスをコピー</button>
      <button type="button" class="btn btn-ghost del-btn" aria-label="添付ファイルを削除" title="削除" data-action="delete-attachment" data-id="${attachment.id}" ${disabled}>🗑</button>
    </div>
  </div>`
}

function attachmentsBlock(todo) {
  const rows = todo.attachments?.length
    ? todo.attachments.map(attachmentRow).join('')
    : `<p class="prompt-panel-empty">添付ファイルはありません。</p>`
  // The cap is the server's to enforce; disabling here only saves the user an
  // upload that would be rejected, and says why.
  const reason = uploadDisabledReason(todo)
  const disabled = busy || reason !== null ? 'disabled' : ''
  const reasonAttr = reason === null ? '' : ` title="${escapeHtml(reason)}"`
  // Always rendered (hidden when nothing is staged), so the change listener
  // has a stable node to patch in place after a pick — see the "change"
  // listener below for why that patch can't just be a re-render.
  const stagedText = selectedFile === null ? '' : `選択中: ${escapeHtml(selectedFile.name)}`
  const staged = `<div id="attachment-selected" class="attachment-selected" ${selectedFile === null ? 'hidden' : ''}>${stagedText}</div>`
  return collapsiblePanel(
    'attachments',
    '添付ファイル',
    todo.attachments?.length ?? 0,
    `${rows}
    <div class="attachment-add">
      <input id="attachment-file-input" type="file" ${disabled}${reasonAttr}>
      <button type="button" class="btn" data-action="upload-attachment" ${disabled}${reasonAttr}>${busy ? '処理中…' : 'アップロード'}</button>
    </div>
    ${staged}
    <div class="form-error" id="attachment-error" hidden></div>`
  )
}

function commentRow(comment) {
  const disabled = busy ? 'disabled' : ''
  // The timezone is left undefined so Intl uses the viewer's own, matching
  // the timestamps in rowsBlock. body is arbitrary user text with newlines,
  // so it is escaped here and rendered pre-wrap by CSS.
  const when = formatDateTime(comment.createdAt) ?? comment.createdAt
  return `<div class="comment-row">
    <div class="comment-main">
      <div class="comment-when">${escapeHtml(when)}</div>
      <div class="comment-body">${escapeHtml(comment.body)}</div>
    </div>
    <div class="comment-actions">
      <button type="button" class="btn btn-ghost del-btn" aria-label="作業ログを削除" title="削除" data-action="delete-comment" data-id="${comment.id}" ${disabled}>🗑</button>
    </div>
  </div>`
}

function commentsBlock(todo) {
  const rows = todo.comments?.length
    ? todo.comments.map(commentRow).join('')
    : `<p class="prompt-panel-empty">作業ログはまだありません。</p>`
  const disabled = busy ? 'disabled' : ''
  return `<div class="prompt-panel">
    <div class="prompt-panel-head"><span>作業ログ</span></div>
    ${rows}
    <div class="comment-add">
      <textarea id="comment-body-input" rows="3" placeholder="進捗や気づきを追記 (⌘/Ctrl+Enter で追記)" ${disabled}>${escapeHtml(commentDraft)}</textarea>
      <button type="button" class="btn" data-action="add-comment" ${disabled}>${busy ? '処理中…' : '追記'}</button>
    </div>
    <div class="form-error" id="comment-error" hidden></div>
  </div>`
}

// Starts the sidebar timer tied to this TODO. Lives in the footer next to
// 編集/完了 — it is an action, not a record, so it does not get a panel of
// its own. While that timer is this TODO's, the control says so instead of
// offering a second start; a timer for another TODO (or a free one) can be
// replaced, behind a two-step confirm.
function pomodoroControl(todo) {
  const timer = currentPomodoro()
  const mine = isActive(timer) && timer.todoId === todo.id
  if (mine) {
    const paused = timer.status === 'paused' ? '・一時停止中' : ''
    return `<span class="pomo-running-note detail-pomo" title="操作は左メニューから">🍅 残り ${formatRemaining(remainingMs(timer, Date.now()))}${paused}</span>`
  }
  return `<div class="pomo-start-row detail-pomo">
    <input id="pomodoro-minutes-input" type="number" min="1" max="${MAX_MINUTES}" step="1" value="${escapeHtml(pomodoroMinutesValue)}" aria-label="ポモドーロの分数">
    <span class="pomo-unit">分</span>
    <button type="button" class="btn" data-action="start-pomodoro">🍅 開始</button>
  </div>`
}

function startTodoPomodoro(btn) {
  const todo = currentTodo()
  if (!todo) return
  const run = () => {
    try {
      startPomodoro({ minutes: pomodoroMinutesValue, todoId: todo.id, todoTitle: todo.title })
      toast(`🍅 ポモドーロを開始しました: ${escapeHtml(todo.title)}`)
    } catch (err) {
      toastError(err.message)
    }
  }
  if (isActive(currentPomodoro())) {
    twoStepConfirm(btn, run, { armedText: 'タイマーを置き換える？', restoreText: '🍅 開始' })
  } else {
    run()
  }
}

function completeButtonHtml(todo) {
  const label = todo.status === 'done' ? '未完了に戻す' : '完了にする'
  return `<button type="button" class="btn btn-accent" data-action="toggle-todo-complete">${label}</button>`
}

function renderDialog() {
  const backdrop = $('#todo-detail-backdrop')
  const todo = isOpen() ? currentTodo() : null
  if (!todo) {
    // Covers both "closed" and "the todo vanished from state" — the latter
    // is a normal outcome of a delete landing during a poll, not an error,
    // so it closes quietly without a toast.
    detailTodoId = null
    editDraft = null
    backdrop.hidden = true
    return
  }
  backdrop.hidden = false
  $('#todo-detail-dialog').innerHTML = `
    <div class="modal-head">
      <h2><span class="todo-id">#${todo.id}</span> ${escapeHtml(todo.title)}</h2>
      <button type="button" class="btn btn-ghost" data-action="close-todo-detail" aria-label="閉じる">×</button>
    </div>
    ${milestoneLine(todo)}
    ${editDraft ? editFormBlock() : `${descriptionBlock(todo)}${rowsBlock(todo)}`}
    ${commentsBlock(todo)}
    ${pullRequestsBlock(todo)}
    ${attachmentsBlock(todo)}
    <div class="modal-footer">
      ${editDraft ? '' : '<button type="button" class="btn" data-action="edit-todo">編集</button>'}
      ${completeButtonHtml(todo)}
      <button type="button" class="btn btn-ghost" data-action="close-todo-detail">閉じる</button>
      ${pomodoroControl(todo)}
    </div>`
}

export function openTodoDetail(todoId) {
  detailTodoId = todoId
  // 中身のあるパネルだけ開いて始める(空のパネルは入力欄だけなので畳む)。
  const todo = getState().todos.find((t) => t.id === todoId)
  openPanels = new Set()
  if (todo?.pullRequests?.length) openPanels.add('pull-requests')
  if (todo?.attachments?.length) openPanels.add('attachments')
  pullRequestUrlValue = ''
  selectedFile = null
  commentDraft = ''
  pomodoroMinutesValue = String(DEFAULT_MINUTES)
  editDraft = null
  busy = false
  renderDialog()
}

function closeDialog() {
  detailTodoId = null
  editDraft = null
  renderDialog()
}

function showDialogError(selector, message) {
  const errorEl = $(selector)
  if (!errorEl) return
  errorEl.textContent = message
  errorEl.hidden = false
}

/**
 * Runs a dialog mutation with the busy state around it, then refreshes todos
 * so the dialog re-renders from the updated state. Failures leave the dialog
 * open (and the typed URL / staged file intact) so the user can correct and
 * retry; `errorSelector` picks the panel the message is reported in.
 */
async function runDialogAction(action, successMessage, errorSelector) {
  if (busy) return
  busy = true
  renderDialog()
  try {
    await action()
    await refreshTodos()
    toast(successMessage)
  } catch (err) {
    toastError(err.message)
    showDialogError(errorSelector, err.message)
  } finally {
    busy = false
    renderDialog()
  }
}

async function addPullRequest() {
  const url = pullRequestUrlValue.trim()
  if (!url) {
    showDialogError('#pr-error', 'PRのURLを入力してください')
    return
  }
  const todoId = detailTodoId
  await runDialogAction(
    async () => {
      await api.addTodoPullRequest(todoId, url)
      pullRequestUrlValue = ''
    },
    'PRを紐付けました',
    '#pr-error'
  )
}

function refreshPullRequest(prId) {
  const todoId = detailTodoId
  return runDialogAction(
    () => api.refreshTodoPullRequest(todoId, prId),
    'PRの情報を更新しました',
    '#pr-error'
  )
}

function deletePullRequest(prId) {
  const todoId = detailTodoId
  return runDialogAction(
    () => api.deleteTodoPullRequest(todoId, prId),
    'PRの紐付けを解除しました',
    '#pr-error'
  )
}

async function uploadAttachment() {
  if (selectedFile === null) {
    showDialogError('#attachment-error', 'ファイルを選択してください')
    return
  }
  const todoId = detailTodoId
  const file = selectedFile
  await runDialogAction(
    async () => {
      await api.uploadTodoAttachment(todoId, file)
      selectedFile = null
    },
    '添付ファイルをアップロードしました',
    '#attachment-error'
  )
}

function deleteAttachment(attachmentId) {
  const todoId = detailTodoId
  return runDialogAction(
    () => api.deleteTodoAttachment(todoId, attachmentId),
    '添付ファイルを削除しました',
    '#attachment-error'
  )
}

// The path is read from state at click time rather than embedded in the row,
// so it is never written into the markup — and so a copy always yields the
// path the server currently reports.
async function copyAttachmentPath(attachmentId) {
  const attachment = currentTodo()?.attachments?.find((a) => a.id === attachmentId)
  if (!attachment) return
  try {
    await navigator.clipboard.writeText(attachment.path)
    toast('パスをコピーしました')
  } catch {
    toastError('クリップボードにコピーできませんでした')
  }
}

async function addComment() {
  const error = commentDraftError(commentDraft)
  if (error !== null) {
    showDialogError('#comment-error', error)
    return
  }
  const todoId = detailTodoId
  const body = normalizeCommentBody(commentDraft)
  await runDialogAction(
    async () => {
      await api.addTodoComment(todoId, body)
      commentDraft = ''
    },
    '作業ログを追記しました',
    '#comment-error'
  )
}

function deleteComment(commentId) {
  const todoId = detailTodoId
  return runDialogAction(
    () => api.deleteTodoComment(todoId, commentId),
    '作業ログを削除しました',
    '#comment-error'
  )
}

function handleDialogClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const id = Number(btn.dataset.id)
  if (action === 'close-todo-detail') {
    closeDialog()
  } else if (action === 'edit-todo') {
    const todo = currentTodo()
    if (!todo) return
    startEditing(todo)
    renderDialog()
    $('#detail-edit-title')?.focus()
  } else if (action === 'cancel-edit-todo') {
    editDraft = null
    renderDialog()
  } else if (action === 'save-edit-todo') {
    if (!busy) saveEdit()
  } else if (action === 'toggle-todo-complete') {
    // 一覧の ✔ と同じ扱い: セッション付きの完了だけ二段階確認を挟む
    // (理由は completionConfirm.js)。
    const todo = currentTodo()
    const run = () => withButtonBusy(btn, () => toggleTodoComplete(detailTodoId))
    if (needsCompletionConfirm(todo)) {
      twoStepConfirm(btn, run, { armedText: '完了する？', restoreText: '完了にする' })
    } else {
      run()
    }
  } else if (action === 'add-pull-request') {
    addPullRequest()
  } else if (action === 'refresh-pull-request') {
    refreshPullRequest(id)
  } else if (action === 'delete-pull-request') {
    twoStepConfirm(btn, () => deletePullRequest(id))
  } else if (action === 'upload-attachment') {
    uploadAttachment()
  } else if (action === 'copy-attachment-path') {
    void copyAttachmentPath(id)
  } else if (action === 'delete-attachment') {
    // Two-step, like PR removal: this one also deletes the stored file, so
    // the more destructive action must not be the easier one to trigger.
    twoStepConfirm(btn, () => deleteAttachment(id))
  } else if (action === 'start-pomodoro') {
    startTodoPomodoro(btn)
  } else if (action === 'add-comment') {
    addComment()
  } else if (action === 'delete-comment') {
    // A log entry can't be re-created with its original timestamp, so its
    // removal gets the same two-step guard as the other sub-resources.
    twoStepConfirm(btn, () => deleteComment(id))
  }
}

export function initTodoDetailDialog() {
  $('#todo-detail-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'todo-detail-backdrop') closeDialog()
  })
  $('#todo-detail-dialog').addEventListener('click', handleDialogClick)
  // <details> の toggle はバブリングしないので capture で拾う。
  $('#todo-detail-dialog').addEventListener(
    'toggle',
    (ev) => {
      const key = ev.target?.dataset?.panel
      if (!key || !COLLAPSIBLE_PANELS.includes(key)) return
      if (ev.target.open) openPanels.add(key)
      else openPanels.delete(key)
    },
    true
  )
  $('#todo-detail-dialog').addEventListener('input', (ev) => {
    if (ev.target.id === 'pr-url-input') pullRequestUrlValue = ev.target.value
    if (ev.target.id === 'comment-body-input') commentDraft = ev.target.value
    if (ev.target.id === 'pomodoro-minutes-input') pomodoroMinutesValue = ev.target.value
    const editKey = EDIT_FIELDS[ev.target.id]
    if (editKey && editDraft) editDraft[editKey] = ev.target.value
  })
  // No re-render here on purpose: while the picked input is still on screen it
  // shows the file name itself, and rebuilding it would blank that label. The
  // "選択中" line then covers exactly the case this doesn't — a later render
  // that replaced the input. But that line is stale DOM from the last render,
  // so a second pick (after a poll already blanked the input once) has to
  // patch it directly here, or it would keep showing the *first* file's name
  // until the next render, up to 10s later, while the upload itself would
  // already be using the second file.
  $('#todo-detail-dialog').addEventListener('change', (ev) => {
    if (ev.target.id === DUE_INPUT_ID) {
      void changeDue(ev.target.value)
      return
    }
    if (ev.target.id !== 'attachment-file-input') return
    selectedFile = ev.target.files?.[0] ?? null
    const stagedEl = $('#attachment-selected')
    if (stagedEl) {
      stagedEl.hidden = selectedFile === null
      stagedEl.textContent = selectedFile === null ? '' : `選択中: ${selectedFile.name}`
    }
  })
  // Enter in the URL field submits, matching what the 追加 button does.
  $('#todo-detail-dialog').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'pr-url-input') {
      ev.preventDefault()
      addPullRequest()
    }
    // ⌘/Ctrl+Enter in the log textarea submits; a bare Enter stays a newline
    // (see isCommentSubmitShortcut).
    if (ev.target.id === 'comment-body-input' && isCommentSubmitShortcut(ev)) {
      ev.preventDefault()
      addComment()
    }
    if (ev.key === 'Enter' && ev.target.id === 'pomodoro-minutes-input') {
      ev.preventDefault()
      const startBtn = $('[data-action="start-pomodoro"]')
      if (startBtn) startTodoPomodoro(startBtn)
    }
  })
  // Escape belongs to whichever modal is on top: settings can be opened
  // (⌘,) over this dialog, so it must not close underneath it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !isOpen()) return
    if (isSettingsDialogOpen()) return
    // While editing, Escape backs out of the edit first rather than
    // discarding it together with the dialog.
    if (editDraft) {
      editDraft = null
      renderDialog()
      return
    }
    closeDialog()
  })
  // Keep an open dialog in step with the poll loop's state updates — except
  // while the URL field or the log textarea has focus. Re-rendering rebuilds
  // that element, which would send the caret to the end mid-typing (the same
  // hazard pollTick skips entire ticks for on the inline TODO forms). Only
  // this dialog's render is skipped, so the rest of the page still updates,
  // and any action-triggered renderDialog() call still runs.
  subscribe(() => {
    const focusedId = document.activeElement?.id
    if (isOpen() && !TYPING_FIELD_IDS.has(focusedId) && !(focusedId in EDIT_FIELDS)) renderDialog()
  })
  // Starting, pausing or finishing the timer flips this dialog's ポモドーロ
  // panel between "start" and "running", so it follows those too.
  onPomodoroChange(() => {
    if (isOpen()) renderDialog()
  })
}
