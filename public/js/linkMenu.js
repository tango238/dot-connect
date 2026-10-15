// Generic "link this to one of these, or unlink" popover, anchored to a
// clicked chip. Originally built for the TODO row's milestone chip; also
// used by the milestone card's label chip — same look (.ms-menu), same
// interaction, just a different set of options/labels/callback.

import { escapeHtml } from './utils.js'

let currentMenu = null

function closeMenu() {
  currentMenu?.remove()
  currentMenu = null
}

document.addEventListener('click', closeMenu)

/**
 * @param {object} params
 * @param {MouseEvent} params.ev - click event on the chip; used to close
 *   any already-open menu, and to position/anchor the new one
 * @param {string} params.headerLabel - e.g. "マイルストーンに紐付け"
 * @param {Array<{id: number, name: string, color: string}>} params.options
 * @param {number|null} params.selectedId - currently linked option's id, or null
 * @param {(id: number|null) => void} params.onSelect
 */
export function openLinkMenu({ ev, headerLabel, options, selectedId, onSelect }) {
  ev.stopPropagation()
  const wasOpen = currentMenu !== null
  closeMenu()
  if (wasOpen) return

  const menu = document.createElement('div')
  menu.className = 'ms-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())

  const items = options
    .map((o) => {
      const checked = selectedId === o.id ? '<span class="mm-check">✔</span>' : ''
      return `<button type="button" data-link-id="${o.id}">
        <span class="ms-dot" style="width:8px;height:8px;border-radius:3px;background:${escapeHtml(o.color)}"></span>
        ${escapeHtml(o.name)}${checked}</button>`
    })
    .join('')
  const unlink =
    selectedId !== null ? `<button type="button" class="mm-unlink" data-link-id="">× 紐付けを解除</button>` : ''

  menu.innerHTML = `<div class="mm-label">${escapeHtml(headerLabel)}</div>${items}${unlink}`
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-link-id]')
    if (!btn) return
    const raw = btn.dataset.linkId
    onSelect(raw === '' ? null : Number(raw))
    closeMenu()
  })

  showMenu(menu, ev.target.closest('.ms-chip, .label-chip'))
}

/**
 * Same popover, but a plain list of actions (no linked/unlinked state):
 * used by the TODO page's 新規TODO button to choose how to create one.
 * @param {object} params
 * @param {MouseEvent} params.ev - click event on the anchor button
 * @param {string} params.headerLabel
 * @param {Array<{action: string, label: string, hint?: string, disabled?: boolean, title?: string}>} params.items
 * @param {(action: string) => void} params.onSelect
 */
export function openActionMenu({ ev, headerLabel, items, onSelect }) {
  ev.stopPropagation()
  const wasOpen = currentMenu !== null
  closeMenu()
  if (wasOpen) return

  const menu = document.createElement('div')
  menu.className = 'ms-menu'
  menu.addEventListener('click', (e) => e.stopPropagation())

  const buttons = items
    .map((item) => {
      const hint = item.hint ? `<span class="mm-hint">${escapeHtml(item.hint)}</span>` : ''
      const title = item.title ? ` title="${escapeHtml(item.title)}"` : ''
      return `<button type="button" data-menu-action="${escapeHtml(item.action)}"${item.disabled ? ' disabled' : ''}${title}>
        <span class="mm-text">${escapeHtml(item.label)}${hint}</span></button>`
    })
    .join('')
  menu.innerHTML = `<div class="mm-label">${escapeHtml(headerLabel)}</div>${buttons}`
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu-action]')
    if (!btn || btn.disabled) return
    onSelect(btn.dataset.menuAction)
    closeMenu()
  })

  showMenu(menu, ev.currentTarget ?? ev.target)
}

// Attaches the menu to the document and places it under the anchor, or
// above it when it would run off the bottom of the window.
function showMenu(menu, anchor) {
  document.body.appendChild(menu)
  currentMenu = menu

  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  menu.style.left = `${Math.min(r.left, window.innerWidth - mw - 12)}px`
  menu.style.top = `${r.bottom + mh + 12 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6}px`
}
