// Pure logic for the detail dialog's 作業ログ panel: no DOM, no state access,
// so it can be unit-tested like the other modules under lib/.

// Mirrors COMMENT_BODY_MAX_LENGTH in src/api/schemas.ts. The server is what
// enforces it; this copy only lets the dialog say why before the round trip.
export const MAX_COMMENT_LENGTH = 4000

const EMPTY_MESSAGE = '作業ログを入力してください'

/**
 * The body as it will be sent: outer whitespace dropped, inner newlines kept
 * (the server trims the same way, so what the preview shows is what lands).
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeCommentBody(raw) {
  return (raw ?? '').trim()
}

/**
 * Why the draft can't be submitted, or null when it can.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function commentDraftError(raw) {
  const body = normalizeCommentBody(raw)
  if (body === '') return EMPTY_MESSAGE
  if (body.length > MAX_COMMENT_LENGTH) {
    return `作業ログは${MAX_COMMENT_LENGTH}文字までです (現在${body.length}文字)`
  }
  return null
}

/**
 * Whether a keydown in the textarea means "submit". A bare Enter inserts a
 * newline — a work log entry is often several lines — so submitting takes
 * ⌘+Enter (mac) or Ctrl+Enter.
 * @param {{ key: string, metaKey: boolean, ctrlKey: boolean }} ev
 * @returns {boolean}
 */
export function isCommentSubmitShortcut(ev) {
  return ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)
}
