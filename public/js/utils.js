// Small shared helpers: HTML escaping, toasts, and the two-step delete confirm.

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes a value for safe insertion into HTML text or attribute contexts. */
export function escapeHtml(value) {
  const str = value === null || value === undefined ? '' : String(value)
  return str.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch])
}

export function $(selector, root = document) {
  return root.querySelector(selector)
}

export function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector))
}

// Tracks the most recent *error* toast so a burst of identical failures
// (e.g. repeated poll errors) flashes the existing toast instead of
// stacking duplicates.
let lastErrorMessage = null
let lastErrorEl = null
let lastErrorRemoveTimer = null

function scheduleRemoval(el, onRemoved) {
  return setTimeout(() => {
    el.remove()
    onRemoved?.()
  }, 4200)
}

function flash(el) {
  el.classList.remove('flash')
  void el.offsetWidth // restart the CSS animation
  el.classList.add('flash')
}

/** Shows a transient toast. `html` is expected to already be escaped where needed. */
export function toast(html, { isError = false, isWarning = false } = {}) {
  const wrap = $('#toasts')
  if (!wrap) return

  if (isError && html === lastErrorMessage && lastErrorEl?.isConnected) {
    flash(lastErrorEl)
    clearTimeout(lastErrorRemoveTimer)
    lastErrorRemoveTimer = scheduleRemoval(lastErrorEl, () => {
      lastErrorMessage = null
      lastErrorEl = null
    })
    return
  }

  const el = document.createElement('div')
  el.className = isError ? 'toast error' : isWarning ? 'toast warn' : 'toast'
  el.innerHTML = html
  wrap.appendChild(el)

  if (isError) {
    lastErrorMessage = html
    lastErrorEl = el
    lastErrorRemoveTimer = scheduleRemoval(el, () => {
      if (el === lastErrorEl) {
        lastErrorMessage = null
        lastErrorEl = null
      }
    })
  } else {
    scheduleRemoval(el)
  }
}

/** Shows a plain-text error toast, escaping the message. */
export function toastError(message) {
  toast(escapeHtml(message), { isError: true })
}

/** Shows a plain-text warning toast, escaping the message — for a success
 * response that still needs the user's attention (e.g. dispatch's
 * promptDelivered: false), distinct from an actual error toast. */
export function toastWarning(message) {
  toast(escapeHtml(message), { isWarning: true })
}

const CONFIRM_WINDOW_MS = 3000

/**
 * Wires a button for a two-step confirm: first click arms it, second click
 * (within the window) invokes `onConfirm`.
 *
 * `armedText`/`restoreText` は文字を差し替えられるボタン向け。丸い ✔ の
 * ように文字を入れ替えられない相手には省略し、`hint` を渡す —— 見た目は
 * .confirm クラスだけが変わるので、何を待たれているのかをトーストで補う。
 */
export function twoStepConfirm(btn, onConfirm, options = {}) {
  const { armedText = '削除する？', restoreText = '🗑', hint = null } = options
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm')
    if (armedText !== null) {
      btn.textContent = armedText
    }
    if (hint) {
      toastWarning(hint)
    }
    btn.dataset.confirmTimer = String(
      setTimeout(() => {
        if (btn.isConnected) {
          btn.classList.remove('confirm')
          if (restoreText !== null) {
            btn.textContent = restoreText
          }
        }
      }, CONFIRM_WINDOW_MS)
    )
    return
  }
  onConfirm()
}

/**
 * 処理が終わるまでボタンを押せなくする。完了のようにサーバ側で外部プロセス
 * (herdr)を待つ操作は、押しっぱなしにすると同じリクエストが二重に飛ぶ。
 * 押せない間が分かるよう aria-busy も立てる。
 *
 * ボタンが再描画で入れ替わることがある(一覧は innerHTML ごと差し替える)ので、
 * 後始末の前に isConnected を確かめる。
 */
export async function withButtonBusy(btn, run) {
  if (btn.disabled) return
  btn.disabled = true
  btn.setAttribute('aria-busy', 'true')
  try {
    await run()
  } finally {
    if (btn.isConnected) {
      btn.disabled = false
      btn.removeAttribute('aria-busy')
    }
  }
}

export function formatMonthDay(dateStr) {
  if (!dateStr) return ''
  return dateStr.slice(5).replace('-', '/')
}

export function todayIso() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
