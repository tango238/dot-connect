// "Dispatch this todo to herdr" dialog: lets the user edit the prompt text
// before it's sent, insert a saved snippet, or reuse a recent one from
// history — instead of the old one-click dispatch straight from the todo
// row (which always just sent the title verbatim).

import { api } from './api.js'
import { refreshTodos, refreshWorkspaces } from './data.js'
import { appendAttachmentPaths } from './lib/attachment.js'
import { dispatchDisabledReason } from './lib/capabilities.js'
import { wipBlockedReason } from './lib/wipLimit.js'
import { shouldWarnAboutDelivery } from './lib/dispatchResult.js'
import { buildModelDispatchPatch, needsModelResetBeforeDispatch } from './lib/modelPatch.js'
import { buildModelSelectChoices, resolveModelSelectValue } from './lib/modelOptions.js'
import { renderPromptPreview } from './lib/promptPreview.js'
import { appendAtEnd, defaultPromptText, insertAtCursor, resolveInsertionPoint, truncatePreview } from './lib/promptText.js'
import { isSettingsDialogOpen } from './settingsDialog.js'
import { isSnippetManagerOpen, openSnippetManager } from './snippetManager.js'
import { getState } from './state.js'
import { $, escapeHtml, toast, toastError, toastWarning, twoStepConfirm } from './utils.js'
import { isWorkspaceManagerOpen, openWorkspaceManager } from './workspaceManager.js'
import { getWorkspacePathHistory, loadWorkspacePathHistory } from './workspacePathHistory.js'

let dialogTodo = null // the todo being dispatched, or null while closed
let promptValue = ''
// Where herdr should run this dispatch. Prefilled from the todo's saved
// workspacePath (if any) but always editable here — dispatch persists
// whatever the user submits back onto the todo as the new default.
let workspacePathValue = ''
// Which Claude Code model to dispatch with. Prefilled from the todo's
// saved model (blank = default/unspecified), same override-and-persist
// pattern as workspacePathValue above.
let modelValue = ''
let snippetPanelOpen = false
let historyPanelOpen = false
// The workspacePath equivalent of historyPanelOpen/history above: recently
// used working directories, as recorded on past successful dispatches.
let workspaceHistoryPanelOpen = false
let snippets = []
let history = []
let dispatching = false
// Which of dialogTodo.attachments (by id) to append as paths onto the
// dispatched prompt. Resets whenever the dialog opens, same as the other
// dialog state above.
let selectedAttachmentIds = new Set()

function isOpen() {
  return dialogTodo !== null
}

function snippetPanel() {
  if (!snippetPanelOpen) return ''
  const items = snippets.length
    ? snippets
        .map(
          (s) =>
            `<button type="button" class="prompt-item" data-action="insert-snippet" data-id="${s.id}"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(truncatePreview(s.body, 60))}</span></button>`
        )
        .join('')
    : `<p class="prompt-panel-empty">スニペットはまだありません。</p>`
  return `<div class="prompt-panel">
    <div class="prompt-panel-head">
      <span>スニペット</span>
      <button type="button" class="btn btn-ghost" data-action="manage-snippets">スニペットを管理</button>
    </div>
    ${items}
  </div>`
}

function historyPanel() {
  if (!historyPanelOpen) return ''
  const items = history.length
    ? history
        .map(
          (h) =>
            `<button type="button" class="prompt-item" data-action="use-history" data-id="${h.id}">${escapeHtml(truncatePreview(h.body, 70))}</button>`
        )
        .join('')
    : `<p class="prompt-panel-empty">履歴はまだありません。</p>`
  return `<div class="prompt-panel">
    <div class="prompt-panel-head">
      <span>履歴(最大50件)</span>
      <button type="button" class="btn btn-ghost del-btn" data-action="clear-history">履歴をすべて消去</button>
    </div>
    ${items}
  </div>`
}

function workspaceHistoryPanel() {
  if (!workspaceHistoryPanelOpen) return ''
  const entries = getWorkspacePathHistory()
  const items = entries.length
    ? entries
        .map(
          (h) =>
            `<button type="button" class="prompt-item mono" data-action="use-workspace-history" data-id="${h.id}">${escapeHtml(h.path)}</button>`
        )
        .join('')
    : `<p class="prompt-panel-empty">履歴はまだありません。投入に成功した作業ディレクトリがここに残ります。</p>`
  return `<div class="prompt-panel">
    <div class="prompt-panel-head"><span>最近使った作業ディレクトリ(最大50件)</span></div>
    ${items}
  </div>`
}

function modelSelectOptions(selected) {
  return buildModelSelectChoices(getState().models)
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    )
    .join('')
}

function previewValues() {
  return { title: dialogTodo.title, description: dialogTodo.description ?? '' }
}

function selectedAttachmentPaths() {
  return (dialogTodo.attachments ?? [])
    .filter((a) => selectedAttachmentIds.has(a.id))
    .map((a) => a.path)
}

// The single place that assembles the text herdr will actually receive.
// Both the preview and submitDispatch build off this, so a checked
// attachment can never show up in one but not the other.
function assemblePromptText() {
  return appendAttachmentPaths(promptValue, selectedAttachmentPaths())
}

function attachmentsPanel() {
  const attachments = dialogTodo.attachments ?? []
  if (attachments.length === 0) return ''
  const items = attachments
    .map(
      (a) =>
        `<label class="prompt-item">
          <input type="checkbox" data-action="toggle-attachment" data-id="${a.id}" ${selectedAttachmentIds.has(a.id) ? 'checked' : ''}>
          ${escapeHtml(a.originalName)}
        </label>`
    )
    .join('')
  return `<div class="prompt-panel">
    <div class="prompt-panel-head"><span>添付ファイル(投入時に含めるものを選択)</span></div>
    ${items}
  </div>`
}

function placeholderChips() {
  return `<div class="prompt-tools">
    <button type="button" class="btn btn-ghost" data-action="insert-placeholder" data-key="title">{{title}} を挿入</button>
    <button type="button" class="btn btn-ghost" data-action="insert-placeholder" data-key="description">{{description}} を挿入</button>
  </div>
  <p class="prompt-hint">※ {{title}} {{description}} は投入時にこのTODOの値へ置換されます</p>`
}

function previewBlock() {
  return `<div class="prompt-panel">
    <div class="prompt-panel-head"><span>プレビュー(投入時のイメージ)</span></div>
    <pre class="prompt-preview" id="prompt-preview">${escapeHtml(renderPromptPreview(assemblePromptText(), previewValues()))}</pre>
  </div>`
}

// Greyed out with the reason on hover — rather than hidden — when this
// environment can't dispatch at all: the rest of the dialog (prompt text,
// snippets) is still worth reading and editing even where herdr is missing.
function submitButton() {
  const { capabilities, settings, todos } = getState()
  const reason = dispatchDisabledReason(capabilities) ?? wipBlockedReason(settings, todos)
  if (reason) {
    return `<button type="button" class="btn btn-accent" data-action="submit-dispatch" disabled title="${escapeHtml(reason)}">投入する</button>`
  }
  return `<button type="button" class="btn btn-accent" data-action="submit-dispatch" ${dispatching ? 'disabled' : ''}>${dispatching ? '投入中…' : '投入する'}</button>`
}

function renderDialog() {
  const backdrop = $('#prompt-dialog-backdrop')
  if (!isOpen()) {
    backdrop.hidden = true
    return
  }
  backdrop.hidden = false
  $('#prompt-dialog').innerHTML = `
    <div class="modal-head">
      <h2>herdrに投入するプロンプト</h2>
      <button type="button" class="btn btn-ghost" data-action="close-prompt-dialog" aria-label="閉じる">×</button>
    </div>
    <p class="modal-sub">「${escapeHtml(dialogTodo.title)}」を herdr の Claude Code セッションに投入します。</p>
    <div class="form-field grow">
      <label for="prompt-workspace-input">作業ディレクトリ(workspacePath)</label>
      <input id="prompt-workspace-input" type="text" list="workspace-datalist" required value="${escapeHtml(workspacePathValue)}" placeholder="例: /Users/you/projects/my-app (登録済みから選択、または自由入力)">
      <div class="prompt-tools">
        <button type="button" class="btn btn-ghost" data-action="toggle-workspace-history-panel">履歴から選ぶ</button>
        <button type="button" class="btn btn-ghost" data-action="manage-workspaces">作業ディレクトリを管理</button>
      </div>
    </div>
    ${workspaceHistoryPanel()}
    <div class="form-field">
      <label for="prompt-model-select">モデル(任意)</label>
      <select id="prompt-model-select">${modelSelectOptions(modelValue)}</select>
    </div>
    <div class="form-field grow">
      <label for="prompt-textarea">プロンプト</label>
      <textarea id="prompt-textarea" rows="6">${escapeHtml(promptValue)}</textarea>
    </div>
    ${placeholderChips()}
    ${attachmentsPanel()}
    ${previewBlock()}
    <p class="prompt-hint">※ 改行は送信時に空白へ変換されます(herdrの仕様)</p>
    <div class="prompt-tools">
      <button type="button" class="btn btn-ghost" data-action="toggle-snippet-panel">スニペットを挿入</button>
      <button type="button" class="btn btn-ghost" data-action="toggle-history-panel">履歴から選ぶ</button>
    </div>
    ${snippetPanel()}
    ${historyPanel()}
    <div class="form-error" id="prompt-dialog-error" hidden></div>
    <div class="modal-footer">
      ${submitButton()}
      <button type="button" class="btn btn-ghost" data-action="close-prompt-dialog">キャンセル</button>
    </div>`
}

export function openPromptDialog(todo) {
  dialogTodo = todo
  promptValue = defaultPromptText(todo)
  workspacePathValue = todo.workspacePath ?? ''
  modelValue = resolveModelSelectValue(todo.model, getState().models)
  snippetPanelOpen = false
  historyPanelOpen = false
  workspaceHistoryPanelOpen = false
  selectedAttachmentIds = new Set()
  snippets = []
  history = []
  dispatching = false
  renderDialog()
}

function closeDialog() {
  dialogTodo = null
  renderDialog()
}

async function loadSnippets() {
  try {
    snippets = await api.listPromptSnippets()
  } catch (err) {
    toastError(err.message)
  }
}

async function loadHistory() {
  try {
    history = await api.listPromptHistory()
  } catch (err) {
    toastError(err.message)
  }
}

async function toggleSnippetPanel() {
  snippetPanelOpen = !snippetPanelOpen
  if (snippetPanelOpen) {
    // Always fetch fresh on open rather than trusting a cross-module cache
    // (F42: openPromptDialog() resets `snippets` to [] on every open, so a
    // stale "loaded" flag previously meant this fetch — and the snippet
    // panel — silently never ran past the first dialog).
    renderDialog()
    await loadSnippets()
  }
  renderDialog()
}

async function toggleHistoryPanel() {
  historyPanelOpen = !historyPanelOpen
  if (historyPanelOpen) {
    renderDialog()
    await loadHistory()
  }
  renderDialog()
}

// Fetched fresh on every open, for the same reason the prompt panels are:
// a dispatch made since this dialog opened should show up here.
async function toggleWorkspaceHistoryPanel() {
  workspaceHistoryPanelOpen = !workspaceHistoryPanelOpen
  if (workspaceHistoryPanelOpen) {
    renderDialog()
    await loadWorkspacePathHistory()
  }
  renderDialog()
}

function useWorkspaceHistoryEntry(id) {
  const entry = getWorkspacePathHistory().find((h) => h.id === id)
  if (!entry) return
  workspacePathValue = entry.path
  // Collapsed on pick: the panel has served its purpose, and leaving it open
  // pushes the prompt textarea off screen.
  workspaceHistoryPanelOpen = false
  renderDialog()
  $('#prompt-workspace-input')?.focus()
}

function insertSnippet(id) {
  const snippet = snippets.find((s) => s.id === id)
  if (!snippet) return
  // Always appended to the end (not the cursor) — the natural flow is
  // "write the prompt, then tack a snippet on", and cursor position is
  // unreliable here anyway since opening the snippet panel just rebuilt
  // the textarea (see appendAtEnd's comment in lib/promptText.js).
  promptValue = appendAtEnd(promptValue, snippet.body)
  renderDialog()
  const el = $('#prompt-textarea')
  el?.focus()
  el?.setSelectionRange(promptValue.length, promptValue.length)
  if (el) el.scrollTop = el.scrollHeight
}

function useHistoryEntry(id) {
  const entry = history.find((h) => h.id === id)
  if (!entry) return
  promptValue = entry.body
  renderDialog()
  const el = $('#prompt-textarea')
  el?.focus()
  el?.setSelectionRange(promptValue.length, promptValue.length)
}

function insertPlaceholder(key) {
  // Placeholders insert at the cursor (kept as-is — they're meant to be
  // embedded mid-sentence), but a freshly re-rendered textarea reports a
  // stale 0/0 selection that's indistinguishable from a real click at the
  // very start — resolveInsertionPoint falls back to the end in that case
  // rather than silently prepending.
  const textarea = $('#prompt-textarea')
  const rawStart = textarea?.selectionStart ?? promptValue.length
  const rawEnd = textarea?.selectionEnd ?? promptValue.length
  const { start, end } = resolveInsertionPoint(promptValue, rawStart, rawEnd)
  const { newText, newCursorPos } = insertAtCursor(promptValue, start, end, `{{${key}}}`)
  promptValue = newText
  renderDialog()
  const el = $('#prompt-textarea')
  el?.focus()
  el?.setSelectionRange(newCursorPos, newCursorPos)
}

function toggleAttachmentSelection(id) {
  const next = new Set(selectedAttachmentIds)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedAttachmentIds = next
  renderDialog()
}

async function clearHistory() {
  try {
    await api.clearPromptHistory()
    history = []
    toast('プロンプト履歴を消去しました')
    renderDialog()
  } catch (err) {
    toastError(err.message)
  }
}

async function submitDispatch() {
  // Validated against what the user actually typed, not the assembled text
  // below — attachments are a supplement to a written instruction, not a
  // substitute for one.
  const typedPrompt = promptValue.trim()
  const workspacePath = workspacePathValue.trim()
  const errorEl = $('#prompt-dialog-error')
  if (!workspacePath) {
    errorEl.textContent = '作業ディレクトリ(workspacePath)を入力してください'
    errorEl.hidden = false
    return
  }
  if (!typedPrompt) {
    errorEl.textContent = 'プロンプトを入力してください'
    errorEl.hidden = false
    return
  }
  // Same assembly the preview reads from (assemblePromptText), so what's
  // shown is byte-identical to what's sent.
  const prompt = assemblePromptText().trim()
  errorEl.hidden = true
  const todo = dialogTodo
  dispatching = true
  renderDialog()
  try {
    // The dispatch endpoint can only override or omit `model` (no null-clear
    // — same shape as workspacePath), so picking "既定(未指定)" here while
    // the todo already has a saved model can't be expressed in the dispatch
    // request itself: omitting would silently keep dispatching with the old
    // saved model instead of honoring what looks like an explicit reset.
    // Clear it via PATCH first in that one case, then dispatch with no
    // override (falling back to the now-null saved model, i.e. no --model).
    if (needsModelResetBeforeDispatch(modelValue, todo.model)) {
      await api.updateTodo(todo.id, { model: null })
      // Reflect the clear on dialogTodo immediately, not just after
      // refreshTodos() below succeeds (F4): if dispatch itself then fails,
      // the PATCH already went through and there's nothing left to reset,
      // so a retry from this same open dialog must not re-send it. This is
      // deliberately not rolled back if dispatch fails — same "persists
      // regardless of dispatch outcome" convention workspacePath already
      // uses for its own override-and-persist.
      dialogTodo = { ...dialogTodo, model: null }
    }
    const result = await api.dispatchTodo(todo.id, {
      prompt,
      workspacePath,
      ...buildModelDispatchPatch(modelValue),
    })
    if (shouldWarnAboutDelivery(result)) {
      toastWarning(
        `「${todo.title}」を投入しましたが、プロンプトの到達を確認できませんでした。セッションを開いて確認してください。`
      )
    } else {
      toast(`「${escapeHtml(todo.title)}」を herdr に投入しました`)
    }
    closeDialog()
    await refreshTodos()
  } catch (err) {
    // Keep the dialog open on failure so the user doesn't lose their edits.
    dispatching = false
    toastError(err.message)
    renderDialog()
  }
}

function handleDialogClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const id = Number(btn.dataset.id)

  if (action === 'close-prompt-dialog') {
    closeDialog()
  } else if (action === 'toggle-snippet-panel') {
    toggleSnippetPanel()
  } else if (action === 'toggle-history-panel') {
    toggleHistoryPanel()
  } else if (action === 'toggle-workspace-history-panel') {
    toggleWorkspaceHistoryPanel()
  } else if (action === 'use-workspace-history') {
    useWorkspaceHistoryEntry(id)
  } else if (action === 'manage-workspaces') {
    openWorkspaceManager(async () => {
      // The manager can add, rename, or clear entries the panel below is
      // showing — reload if it's still open behind the modal.
      await refreshWorkspaces()
      if (workspaceHistoryPanelOpen) await loadWorkspacePathHistory()
      renderDialog()
    })
  } else if (action === 'insert-snippet') {
    insertSnippet(id)
  } else if (action === 'insert-placeholder') {
    insertPlaceholder(btn.dataset.key)
  } else if (action === 'use-history') {
    useHistoryEntry(id)
  } else if (action === 'clear-history') {
    twoStepConfirm(btn, clearHistory)
  } else if (action === 'toggle-attachment') {
    toggleAttachmentSelection(id)
  } else if (action === 'submit-dispatch') {
    submitDispatch()
  } else if (action === 'manage-snippets') {
    openSnippetManager(async () => {
      // Pick up whatever changed in the manager if the panel is still open
      // behind it.
      if (snippetPanelOpen) {
        await loadSnippets()
        renderDialog()
      }
    })
  }
}

export function initPromptDialog() {
  $('#prompt-dialog-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'prompt-dialog-backdrop') closeDialog()
  })
  $('#prompt-dialog').addEventListener('click', handleDialogClick)
  const handleFieldChange = (ev) => {
    if (ev.target.id === 'prompt-workspace-input') {
      workspacePathValue = ev.target.value
      return
    }
    if (ev.target.id === 'prompt-model-select') {
      modelValue = ev.target.value
      return
    }
    if (ev.target.id !== 'prompt-textarea') return
    promptValue = ev.target.value
    // Update just the preview text, not a full renderDialog() — rebuilding
    // the whole dialog on every keystroke would drop the textarea's cursor
    // position mid-typing.
    const preview = $('#prompt-preview')
    if (preview) preview.textContent = renderPromptPreview(assemblePromptText(), previewValues())
  }
  $('#prompt-dialog').addEventListener('input', handleFieldChange)
  // <select> reliably fires 'change' everywhere; 'input' support for it is
  // newer, so listen for both rather than risk missing the model pick.
  $('#prompt-dialog').addEventListener('change', handleFieldChange)
  // Escape belongs to whichever modal is on top: the snippet manager,
  // workspace manager, and settings can all open over this dialog, so it
  // must not close underneath them.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !isOpen()) return
    if (isSnippetManagerOpen() || isWorkspaceManagerOpen() || isSettingsDialogOpen()) return
    closeDialog()
  })
}
