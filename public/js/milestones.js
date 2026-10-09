// Milestones page: cards (progress, linked todos), top-down "add todo",
// complete/reopen, delete, and the sidebar's active-milestone list.

import { api } from './api.js'
import { refreshBoth, refreshLabelsAndMilestones } from './data.js'
import { shouldRestoreCapturedForm } from './lib/formCapture.js'
import { hasOpenForm } from './lib/formGuard.js'
import { groupMilestonesByLabel } from './lib/milestoneGrouping.js'
import { activeMilestonesWithProgress } from './lib/milestoneProgress.js'
import { openLabelManager } from './labelManager.js'
import { openLinkMenu } from './linkMenu.js'
import { getState, setState } from './state.js'
import { openTodoDetail } from './todoDetailDialog.js'
import { $, escapeHtml, formatMonthDay, toast, toastError, todayIso, twoStepConfirm } from './utils.js'

// Which milestone card currently has its inline "add todo" form open, and
// which (at most one, and mutually exclusive with the above) has its
// inline "edit" form open.
let openAddFormMsId = null
let editFormMsId = null

// Exported so main.js's poll loop can skip a background refresh while one
// of these is open — see todos.js's hasOpenTodoForm() for why (F43).
//
// The label manager modal and its own inline edit form are deliberately
// NOT included here: openLabelManager() renders into #label-manager-list,
// a container renderActivePage() never touches (it's outside every .page
// section, same as the prompt dialog / snippet manager), so a poll tick
// can't blow it away regardless of whether it's tracked here.
export function hasOpenMilestoneForm() {
  return hasOpenForm(openAddFormMsId, editFormMsId)
}

function linkedTodosFor(milestoneId) {
  return getState().todos.filter((t) => t.milestoneId === milestoneId)
}

function statusIcon(todo) {
  if (todo.status === 'done') return '✔'
  if (todo.sessionState === 'working') return '▶'
  if (todo.sessionState === 'blocked') return '⏸'
  return '○'
}

function msTodoLines(milestoneId) {
  return linkedTodosFor(milestoneId)
    .map(
      (t) =>
        `<div class="ms-todo-line ${t.status === 'done' ? 'd' : ''}"><span class="st">${statusIcon(t)}</span><span class="ms-todo-title" role="button" tabindex="0" data-action="open-todo-detail" data-id="${t.id}" title="クリックで詳細を表示"><span class="todo-id">#${t.id}</span> ${escapeHtml(t.title)}</span></div>`
    )
    .join('')
}

function addTodoForm(milestoneId) {
  if (openAddFormMsId !== milestoneId) return ''
  return `<div class="inline-form ms-card-form" data-add-form="${milestoneId}">
    <div class="form-field grow">
      <label for="ms-add-title-${milestoneId}">タイトル</label>
      <input id="ms-add-title-${milestoneId}" type="text" placeholder="このマイルストーンに追加するTODO">
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="submit-add-todo" data-id="${milestoneId}">追加</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-add-todo">キャンセル</button>
    </div>
  </div>`
}

function msFoot(m, openCount) {
  // Editing is allowed regardless of status — color/title/description/dates
  // are all fine to correct after completion too.
  const editBtn = `<button class="btn btn-ghost" data-action="edit-ms" data-id="${m.id}">編集</button>`
  if (m.status === 'done') {
    return `<div class="ms-foot">
      ${editBtn}
      <button class="btn btn-ghost" data-action="reopen-ms" data-id="${m.id}">完了を取り消す</button>
      <button class="btn btn-ghost del-btn" aria-label="マイルストーンを削除" title="削除" data-action="delete-ms" data-id="${m.id}">🗑</button>
    </div>`
  }
  return `<div class="ms-foot">
    ${editBtn}
    <button class="btn ${openCount === 0 ? 'btn-accent' : ''}" data-action="complete-ms" data-id="${m.id}">✔ 完了にする${openCount ? `(残${openCount}件)` : ''}</button>
    <button class="btn btn-ghost del-btn" aria-label="マイルストーンを削除" title="削除" data-action="delete-ms" data-id="${m.id}">🗑</button>
  </div>`
}

function editMsForm(m) {
  if (editFormMsId !== m.id) return ''
  return `<div class="inline-form ms-card-form" data-edit-form="${m.id}">
    <div class="form-field grow">
      <label for="ms-edit-title-${m.id}">タイトル</label>
      <input id="ms-edit-title-${m.id}" type="text" required value="${escapeHtml(m.title)}">
    </div>
    <div class="form-field grow">
      <label for="ms-edit-desc-${m.id}">説明</label>
      <input id="ms-edit-desc-${m.id}" type="text" value="${escapeHtml(m.description)}">
    </div>
    <div class="form-field">
      <label for="ms-edit-color-${m.id}">色</label>
      <input id="ms-edit-color-${m.id}" type="color" value="${escapeHtml(m.color)}">
    </div>
    <div class="form-field">
      <label for="ms-edit-label-${m.id}">ラベル</label>
      <select id="ms-edit-label-${m.id}">${labelSelectOptions(m.labelId)}</select>
    </div>
    <div class="form-field">
      <label for="ms-edit-start-${m.id}">開始日</label>
      <input id="ms-edit-start-${m.id}" type="date" required value="${escapeHtml(m.startDate.slice(0, 10))}">
    </div>
    <div class="form-field">
      <label for="ms-edit-target-${m.id}">期限</label>
      <input id="ms-edit-target-${m.id}" type="date" required value="${escapeHtml(m.targetDate.slice(0, 10))}">
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-accent" data-action="save-edit-ms" data-id="${m.id}">保存</button>
      <button type="button" class="btn btn-ghost" data-action="cancel-edit-ms">キャンセル</button>
    </div>
    <div class="form-error" id="ms-edit-error-${m.id}" hidden></div>
  </div>`
}

function labelChip(m) {
  if (m.labelId === null) {
    return `<span class="ms-chip label-chip none" role="button" tabindex="0" data-label-chip data-id="${m.id}" title="クリックしてラベルを設定">＋ ラベル未設定</span>`
  }
  const color = escapeHtml(m.labelColor ?? '#6ca4f8')
  return `<span class="ms-chip label-chip" role="button" tabindex="0" data-label-chip data-id="${m.id}" title="クリックして変更/解除" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent)"><span class="ms-dot" style="background:${color}"></span>${escapeHtml(m.labelName)}</span>`
}

function msCard(m) {
  const linked = linkedTodosFor(m.id)
  const dn = m.doneCount
  const total = m.linkedCount
  const open = total - dn
  const pct = total ? Math.round((dn / total) * 100) : 0
  const late = m.status !== 'done' && m.targetDate < todayIso()
  const dueOrDone =
    m.status === 'done'
      ? `<span class="ms-done-badge">完了 ${m.doneAt ? escapeHtml(m.doneAt.slice(0, 10)) : ''}</span>`
      : `<span class="ms-due ${late ? 'late' : ''}">期限 ${formatMonthDay(m.targetDate)}</span>`
  const addBtn =
    m.status === 'done'
      ? ''
      : `<button class="btn ms-add" data-action="toggle-add-todo" data-id="${m.id}">＋ TODOを追加</button>`

  return `<div class="ms-card ${m.status === 'done' ? 'is-done' : ''}" data-ms-id="${m.id}">
    <div class="ms-card-head"><span class="ms-dot" style="background:${escapeHtml(m.color)}"></span><h2>${escapeHtml(m.title)}</h2>${dueOrDone}</div>
    <div class="ms-card-meta">${labelChip(m)}</div>
    <p class="ms-desc">${escapeHtml(m.description)}</p>
    <div class="ms-bar"><div style="width:${pct}%;background:${escapeHtml(m.color)}"></div></div>
    <div class="ms-stats"><span>${dn} / ${total} 完了</span><span>${pct}%</span></div>
    <div class="ms-todos">${msTodoLines(m.id) || '<span class="ms-todo-line">紐付いているTODOはありません</span>'}</div>
    ${addBtn}
    ${addTodoForm(m.id)}
    ${editMsForm(m)}
    ${msFoot(m, open)}
  </div>`
}

// Exported so main.js's state-subscribed renderSidebar() can call it on
// every page, not just while the milestones page happens to be active
// (F40 — this used to only run from renderMilestones() below, so the
// sidebar list stayed empty until the user visited the milestones page).
export function renderSideMilestones() {
  const active = activeMilestonesWithProgress(getState().milestones)
  $('#side-ms-list').innerHTML = active
    .map(
      (m) =>
        `<div class="side-ms" data-action="goto-milestones"><span class="ms-dot" style="background:${escapeHtml(m.color)}"></span><span class="ms-name">${escapeHtml(m.title)}</span><span class="ms-pct">${m.pct}%</span></div>`
    )
    .join('')
}

function groupHeader(g) {
  if (g.labelId === null) {
    return `<div class="ms-group-label">ラベルなし</div>`
  }
  return `<div class="ms-group-label ms-group-label-tagged"><span class="ms-dot" style="background:${escapeHtml(g.labelColor)}"></span>${escapeHtml(g.labelName)}</div>`
}

export function renderMilestones() {
  const { milestones } = getState()
  const active = milestones.filter((m) => m.status !== 'done')
  const done = milestones.filter((m) => m.status === 'done')

  // Only label the groups when there's more than one — a single-group
  // board (nobody using labels yet, or everything under one label) stays
  // exactly as unadorned as before this feature existed.
  const groups = groupMilestonesByLabel(active)
  const showGroupHeaders = groups.length > 1
  const activeHtml = groups
    .map((g) => (showGroupHeaders ? groupHeader(g) : '') + g.milestones.map(msCard).join(''))
    .join('')
  const doneHtml = done.length
    ? `<div class="ms-group-label">完了したマイルストーン — ${done.length}件</div>${done.map(msCard).join('')}`
    : ''
  $('#ms-grid').innerHTML = activeHtml + doneHtml
}

function labelSelectOptions(selectedId) {
  const opts = getState()
    .labels.map(
      (l) => `<option value="${l.id}" ${l.id === selectedId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`
    )
    .join('')
  return `<option value="" ${selectedId === null ? 'selected' : ''}>なし</option>${opts}`
}

function renderNewMsForm() {
  const container = $('#new-ms-form')
  container.innerHTML = `
    <div class="form-field grow">
      <label for="ms-title">タイトル</label>
      <input id="ms-title" type="text" required>
    </div>
    <div class="form-field grow">
      <label for="ms-desc">説明</label>
      <input id="ms-desc" type="text">
    </div>
    <div class="form-field">
      <label for="ms-color">色</label>
      <input id="ms-color" type="color" value="#6ca4f8">
    </div>
    <div class="form-field">
      <label for="ms-label">ラベル</label>
      <select id="ms-label">${labelSelectOptions(null)}</select>
    </div>
    <div class="form-field">
      <label for="ms-start">開始日</label>
      <input id="ms-start" type="date" required>
    </div>
    <div class="form-field">
      <label for="ms-target">期限</label>
      <input id="ms-target" type="date" required>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-accent" id="new-ms-submit">作成</button>
      <button type="button" class="btn btn-ghost" id="new-ms-cancel">キャンセル</button>
    </div>`
}

async function createMilestone() {
  const title = $('#ms-title').value.trim()
  const startDate = $('#ms-start').value
  const targetDate = $('#ms-target').value
  const labelRaw = $('#ms-label').value
  if (!title || !startDate || !targetDate) {
    toastError('タイトル・開始日・期限は必須です')
    return
  }
  try {
    await api.createMilestone({
      title,
      description: $('#ms-desc').value.trim(),
      color: $('#ms-color').value,
      startDate,
      targetDate,
      labelId: labelRaw ? Number(labelRaw) : null,
    })
    toast('マイルストーンを作成しました')
    $('#new-ms-form').hidden = true
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

async function createTodoUnderMilestone(milestoneId) {
  const input = $(`#ms-add-title-${milestoneId}`)
  const title = input?.value.trim()
  if (!title) return
  try {
    await api.createTodo({ title, milestoneId })
    toast('TODOを追加しました')
    openAddFormMsId = null
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

async function completeMilestone(id) {
  const m = getState().milestones.find((x) => x.id === id)
  try {
    await api.completeMilestone(id)
    toast(`マイルストーン「${escapeHtml(m?.title ?? '')}」を完了にしました 🎉`)
    await refreshBoth()
  } catch (err) {
    if (err.status === 409) {
      toast(
        `「${escapeHtml(m?.title ?? '')}」には未完了のTODOが${err.extra.remaining}件あります。先に完了するか、紐付けを外してください`,
        { isError: true }
      )
    } else {
      toastError(err.message)
    }
  }
}

async function reopenMilestone(id) {
  const m = getState().milestones.find((x) => x.id === id)
  try {
    await api.reopenMilestone(id)
    toast(`「${escapeHtml(m?.title ?? '')}」を進行中に戻しました`)
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

async function deleteMilestone(id) {
  const m = getState().milestones.find((x) => x.id === id)
  try {
    const result = await api.deleteMilestone(id)
    const suffix = result.unlinkedCount ? `(TODO ${result.unlinkedCount}件は未紐付けに戻しました)` : ''
    toast(`「${escapeHtml(m?.title ?? '')}」を削除しました${suffix}`)
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

async function saveMilestoneEdit(id) {
  const title = $(`#ms-edit-title-${id}`)?.value.trim()
  const startDate = $(`#ms-edit-start-${id}`)?.value
  const targetDate = $(`#ms-edit-target-${id}`)?.value
  const labelRaw = $(`#ms-edit-label-${id}`)?.value
  const errorEl = $(`#ms-edit-error-${id}`)
  if (!title || !startDate || !targetDate) {
    if (errorEl) {
      errorEl.textContent = 'タイトル・開始日・期限は必須です'
      errorEl.hidden = false
    }
    return
  }
  try {
    await api.updateMilestone(id, {
      title,
      description: $(`#ms-edit-desc-${id}`)?.value.trim() ?? '',
      color: $(`#ms-edit-color-${id}`)?.value,
      startDate,
      targetDate,
      labelId: labelRaw ? Number(labelRaw) : null,
    })
    toast('マイルストーンを更新しました')
    editFormMsId = null
    // refreshBoth() re-fetches todos/milestones — colors and dates on the
    // sidebar list and the plan timeline follow along since both render
    // straight from state.
    await refreshBoth()
  } catch (err) {
    // The backend validates targetDate >= startDate and real calendar
    // dates, so a 400 here surfaces that message as-is.
    toastError(err.message)
  }
}

async function linkLabel(milestoneId, labelId) {
  const m = getState().milestones.find((x) => x.id === milestoneId)
  try {
    await api.updateMilestone(milestoneId, { labelId })
    toast(
      labelId
        ? `「${escapeHtml(m?.title ?? '')}」のラベルを変更しました`
        : `「${escapeHtml(m?.title ?? '')}」のラベルを解除しました`
    )
    // Only the milestone's own labelId/labelName/labelColor JOIN changed —
    // the labels master list itself didn't, so refreshBoth() (not
    // refreshLabelsAndMilestones()) is enough here.
    await refreshBoth()
  } catch (err) {
    toastError(err.message)
  }
}

function handleGridClick(ev) {
  const labelChipEl = ev.target.closest('[data-label-chip]')
  if (labelChipEl) {
    const m = getState().milestones.find((x) => x.id === Number(labelChipEl.dataset.id))
    if (m) {
      openLinkMenu({
        ev,
        headerLabel: 'ラベルを設定',
        options: getState().labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
        selectedId: m.labelId,
        onSelect: (labelId) => linkLabel(m.id, labelId),
      })
    }
    return
  }
  const btn = ev.target.closest('[data-action]')
  if (!btn) return
  const action = btn.dataset.action
  const id = Number(btn.dataset.id)

  if (action === 'toggle-add-todo') {
    openAddFormMsId = openAddFormMsId === id ? null : id
    editFormMsId = null
    renderMilestones()
  } else if (action === 'cancel-add-todo') {
    openAddFormMsId = null
    renderMilestones()
  } else if (action === 'submit-add-todo') {
    createTodoUnderMilestone(id)
  } else if (action === 'edit-ms') {
    editFormMsId = editFormMsId === id ? null : id
    openAddFormMsId = null
    renderMilestones()
  } else if (action === 'cancel-edit-ms') {
    editFormMsId = null
    renderMilestones()
  } else if (action === 'save-edit-ms') {
    saveMilestoneEdit(id)
  } else if (action === 'complete-ms') {
    completeMilestone(id)
  } else if (action === 'reopen-ms') {
    reopenMilestone(id)
  } else if (action === 'delete-ms') {
    twoStepConfirm(btn, () => deleteMilestone(id))
  } else if (action === 'open-todo-detail') {
    openTodoDetail(id)
  } else if (action === 'goto-milestones') {
    document.querySelector('[data-page="milestones"]').click()
  }
}

// Snapshots whichever inline form (edit or top-down add-todo) is open, so
// it can be restored after an async refresh rebuilds the card from state —
// otherwise refreshLabelsAndMilestones() after closing the label manager
// wipes out text the user is mid-typing (F49). The two forms are mutually
// exclusive (see the field declarations above), so at most one is captured.
function captureOpenFormValues() {
  if (editFormMsId !== null) {
    const id = editFormMsId
    return {
      kind: 'edit',
      id,
      title: $(`#ms-edit-title-${id}`)?.value,
      desc: $(`#ms-edit-desc-${id}`)?.value,
      color: $(`#ms-edit-color-${id}`)?.value,
      label: $(`#ms-edit-label-${id}`)?.value,
      startDate: $(`#ms-edit-start-${id}`)?.value,
      targetDate: $(`#ms-edit-target-${id}`)?.value,
    }
  }
  if (openAddFormMsId !== null) {
    return { kind: 'add', id: openAddFormMsId, title: $(`#ms-add-title-${openAddFormMsId}`)?.value }
  }
  return null
}

function setFieldValue(elId, value) {
  const el = $(`#${elId}`)
  if (el && value !== undefined) el.value = value
}

/** Writes a captured snapshot back into the DOM — but only if the same
 * form the snapshot was taken from is still open (F49's core guard: don't
 * resurrect a form the user already closed, or clobber a different one). */
function restoreOpenFormValues(captured) {
  const currentOpenId = captured?.kind === 'add' ? openAddFormMsId : editFormMsId
  if (!shouldRestoreCapturedForm(captured, currentOpenId)) return
  const { id } = captured
  if (captured.kind === 'edit') {
    setFieldValue(`ms-edit-title-${id}`, captured.title)
    setFieldValue(`ms-edit-desc-${id}`, captured.desc)
    setFieldValue(`ms-edit-color-${id}`, captured.color)
    setFieldValue(`ms-edit-label-${id}`, captured.label)
    setFieldValue(`ms-edit-start-${id}`, captured.startDate)
    setFieldValue(`ms-edit-target-${id}`, captured.targetDate)
  } else {
    setFieldValue(`ms-add-title-${id}`, captured.title)
  }
}

export function initMilestones() {
  $('#ms-grid').addEventListener('click', handleGridClick)
  // The todo titles are spans with role="button", so Enter/Space are wired
  // up by hand, as on the TODO page.
  $('#ms-grid').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const title = ev.target.closest('[data-action="open-todo-detail"]')
    if (!title) return
    ev.preventDefault()
    openTodoDetail(Number(title.dataset.id))
  })
  $('#side-ms-list').addEventListener('click', handleGridClick)

  $('#new-ms-toggle').addEventListener('click', () => {
    const form = $('#new-ms-form')
    form.hidden = !form.hidden
    if (!form.hidden) renderNewMsForm()
  })

  $('#new-ms-form').addEventListener('click', (ev) => {
    if (ev.target.id === 'new-ms-submit') {
      ev.preventDefault()
      createMilestone()
    } else if (ev.target.id === 'new-ms-cancel') {
      $('#new-ms-form').hidden = true
    }
  })

  $('#manage-labels-toggle').addEventListener('click', () => {
    openLabelManager(async () => {
      // The label manager can add/rename labels the open edit form's
      // <select> needs to reflect, so we still refetch both labels and
      // milestones — just guard the DOM rebuild that follows (F49).
      const captured = captureOpenFormValues()
      await refreshLabelsAndMilestones()
      restoreOpenFormValues(captured)
    })
  })
}
