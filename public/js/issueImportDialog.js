// "GitHub Issue から取り込み" modal: name a repository, list its issues
// (through `gh` on the server), tick the ones to turn into TODOs, and give
// them a shared milestone / work directory / model. Self-contained like
// workspaceManager.js — owns its fetch + render; the TODO list refreshes
// through refreshBoth() once the import lands.
//
// Issues that already have a TODO (the issue URL sits in its description)
// are shown but locked, so listing the same repo twice never doubles up.
// The matching itself is in lib/issueImport.js.

import { api } from './api.js'
import { refreshBoth } from './data.js'
import {
  importButtonLabel,
  importResultMessage,
  importedTodosByIssue,
  isIssueSelectable,
  labelColor,
  loadRememberedRepos,
  parseRepoInput,
  rememberRepo,
  saveRememberedRepos,
} from './lib/issueImport.js'
import { buildModelCreatePatch } from './lib/modelPatch.js'
import { buildWorkspacePathCreatePatch } from './lib/workspacePathPatch.js'
import { isSettingsDialogOpen } from './settingsDialog.js'
import { activeMilestones, getState } from './state.js'
import { modelOptions, priorityOptions } from './todoFormOptions.js'
import { $, $all, escapeHtml, toast, toastError, toastWarning, withButtonBusy } from './utils.js'

const STATE_LABEL = { open: 'Open', closed: 'Closed' }

let repo = null // canonical "owner/repo" of the list on screen, or null
let issues = []
let selected = new Set() // issue numbers
let listStatus = 'idle' // 'idle' | 'loading' | 'ready' | 'error'
let listError = ''

function showError(message) {
  const el = $('#ii-error')
  el.textContent = message
  el.hidden = !message
}

function renderRepoDatalist() {
  $('#issue-repo-datalist').innerHTML = loadRememberedRepos(window.localStorage)
    .map((r) => `<option value="${escapeHtml(r)}"></option>`)
    .join('')
}

function labelChips(issue) {
  return issue.labels
    .map((l) => {
      return `<span class="issue-label" style="--chip-color:${labelColor(l.color)}">${escapeHtml(l.name)}</span>`
    })
    .join('')
}

function importedNote(imported) {
  if (!imported) return ''
  return imported.done
    ? `<span class="issue-imported" title="このIssueから作ったTODOは完了済み。もう一度取り込めます">取り込み済み · TODO #${imported.todoId}(完了)</span>`
    : `<span class="issue-imported" title="このIssueのTODOがまだ開いています">取り込み済み · TODO #${imported.todoId}</span>`
}

function issueRow(issue, imported) {
  const selectable = isIssueSelectable(imported)
  const checked = selected.has(issue.number) ? ' checked' : ''
  const disabled = selectable ? '' : ' disabled'
  const updated = issue.updatedAt ? issue.updatedAt.slice(0, 10) : ''
  return `<label class="issue-row${selectable ? '' : ' is-imported'}">
    <input type="checkbox" data-issue-number="${issue.number}"${checked}${disabled}>
    <div class="issue-row-main">
      <div class="issue-row-title"><span class="todo-id">#${issue.number}</span> ${escapeHtml(issue.title)}</div>
      <div class="issue-row-meta"><span>${STATE_LABEL[issue.state] ?? escapeHtml(issue.state)}</span>${updated ? `<span>更新 ${escapeHtml(updated)}</span>` : ''}${labelChips(issue)}${importedNote(imported)}<a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener" class="issue-link" title="GitHubで開く">↗</a></div>
    </div>
  </label>`
}

function renderList() {
  const head = $('#issue-import-list-head')
  const list = $('#issue-import-list')
  if (listStatus === 'idle') {
    head.innerHTML = ''
    list.innerHTML = `<p class="prompt-panel-empty">リポジトリを指定して「一覧を取得」を押してください。</p>`
    return
  }
  if (listStatus === 'loading') {
    head.innerHTML = ''
    list.innerHTML = `<p class="prompt-panel-empty">Issue を取得中…</p>`
    return
  }
  if (listStatus === 'error') {
    head.innerHTML = ''
    list.innerHTML = `<p class="prompt-panel-empty form-error">${escapeHtml(listError)}</p>`
    return
  }
  const imported = importedTodosByIssue(issues, getState().todos)
  // A refresh may have closed/created TODOs under us; drop selections that
  // are no longer tickable so the count and the request agree.
  selected = new Set([...selected].filter((n) => issues.some((i) => i.number === n && isIssueSelectable(imported.get(n)))))
  const selectableCount = issues.filter((i) => isIssueSelectable(imported.get(i.number))).length
  const allSelected = selectableCount > 0 && selected.size === selectableCount
  head.innerHTML = `<span>${escapeHtml(repo)} — ${issues.length}件</span>
    <button type="button" class="btn btn-ghost" data-action="toggle-all-issues"${selectableCount === 0 ? ' disabled' : ''}>${allSelected ? 'すべて解除' : 'すべて選択'}</button>`
  list.innerHTML = issues.length
    ? issues.map((i) => issueRow(i, imported.get(i.number))).join('')
    : `<p class="prompt-panel-empty">該当する Issue はありません。</p>`
}

function renderOptions() {
  const ms = $('#ii-milestone')
  const keepMs = ms?.value ?? ''
  ms.innerHTML = `<option value="">未紐付け</option>${activeMilestones()
    .map((m) => `<option value="${m.id}" ${String(m.id) === keepMs ? 'selected' : ''}>${escapeHtml(m.title)}</option>`)
    .join('')}`
  const model = $('#ii-model')
  const keepModel = model.value ?? ''
  model.innerHTML = modelOptions(keepModel)
  const prio = $('#ii-priority')
  if (!prio.options.length) prio.innerHTML = priorityOptions('none')
}

function renderImportButton() {
  const btn = $('#ii-import')
  btn.textContent = importButtonLabel(selected.size)
  btn.disabled = selected.size === 0
}

function render() {
  renderList()
  renderImportButton()
}

async function loadIssues() {
  const parsed = parseRepoInput($('#ii-repo').value)
  if (!parsed) {
    showError('リポジトリは "owner/repo" か GitHub の URL で指定してください')
    return
  }
  showError('')
  listStatus = 'loading'
  selected = new Set()
  render()
  try {
    const data = await api.listGithubIssues({
      repo: parsed,
      state: $('#ii-state').value,
      search: $('#ii-search').value.trim(),
    })
    repo = data.repo
    issues = data.issues
    listStatus = 'ready'
    saveRememberedRepos(window.localStorage, rememberRepo(loadRememberedRepos(window.localStorage), repo))
    renderRepoDatalist()
  } catch (err) {
    listStatus = 'error'
    listError = err.message
  }
  render()
}

async function importSelected() {
  if (!repo || selected.size === 0) return
  const msRaw = $('#ii-milestone').value
  try {
    const result = await api.importGithubIssues({
      repo,
      numbers: [...selected],
      milestoneId: msRaw ? Number(msRaw) : null,
      priority: $('#ii-priority').value,
      ...buildWorkspacePathCreatePatch($('#ii-ws').value),
      ...buildModelCreatePatch($('#ii-model').value),
    })
    const { message, warning } = importResultMessage(result)
    if (warning) toastWarning(message)
    else toast(message)
    await refreshBoth()
    if (result.failed.length === 0) {
      closeIssueImportDialog()
      return
    }
    // Keep what failed ticked so a retry is one click; what landed is now
    // locked by the refreshed TODO list.
    selected = new Set(result.failed.map((f) => f.number))
    render()
  } catch (err) {
    toastError(err.message)
  }
}

function handleClick(ev) {
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  if (action === 'close-issue-import') {
    closeIssueImportDialog()
  } else if (action === 'toggle-all-issues') {
    const imported = importedTodosByIssue(issues, getState().todos)
    const selectable = issues.filter((i) => isIssueSelectable(imported.get(i.number))).map((i) => i.number)
    selected = selected.size === selectable.length ? new Set() : new Set(selectable)
    render()
  } else if (action === 'import-issues') {
    void withButtonBusy(btn, importSelected)
  }
}

function handleChange(ev) {
  const box = ev.target.closest('input[data-issue-number]')
  if (!box) return
  const number = Number(box.dataset.issueNumber)
  if (box.checked) selected.add(number)
  else selected.delete(number)
  // Only the count and the head's toggle label change; leave the rows alone
  // so the checkbox the user just clicked keeps focus.
  renderImportButton()
  const toggle = $('[data-action="toggle-all-issues"]')
  if (toggle) {
    const boxes = $all('#issue-import-list input[data-issue-number]:not(:disabled)')
    toggle.textContent = boxes.length > 0 && boxes.every((b) => b.checked) ? 'すべて解除' : 'すべて選択'
  }
}

export function isIssueImportDialogOpen() {
  return !$('#issue-import-backdrop').hidden
}

/** Opens the modal. The repo field keeps the last listed repository so a
 * second import from the same project is one click. */
export function openIssueImportDialog() {
  $('#issue-import-backdrop').hidden = false
  renderRepoDatalist()
  renderOptions()
  if (!$('#ii-repo').value) {
    $('#ii-repo').value = loadRememberedRepos(window.localStorage)[0] ?? ''
  }
  showError('')
  render()
  $('#ii-repo').focus()
}

export function closeIssueImportDialog() {
  $('#issue-import-backdrop').hidden = true
}

export function initIssueImportDialog() {
  $('#issue-import-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'issue-import-backdrop') closeIssueImportDialog()
  })
  $('#issue-import-modal').addEventListener('click', handleClick)
  $('#issue-import-modal').addEventListener('change', handleChange)
  $('#issue-import-search').addEventListener('submit', (ev) => {
    ev.preventDefault()
    void withButtonBusy($('#ii-load'), loadIssues)
  })
  // Escape belongs to whichever modal is on top (settings can open over this).
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !isIssueImportDialogOpen()) return
    if (isSettingsDialogOpen()) return
    closeIssueImportDialog()
  })
}
