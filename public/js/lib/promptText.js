// Pure text helpers for the prompt-dispatch dialog — no DOM.

/** The dispatch dialog's initial prompt: the title, then the description
 * (when there is one) after a blank line. Mirrors defaultTaskPrompt in
 * dispatchService.ts, which a dispatch without a prompt falls back to. */
export function defaultPromptText(todo) {
  const description = (todo.description ?? '').trim()
  return description ? `${todo.title}\n\n${description}` : todo.title
}

/** Collapses whitespace/newlines to single spaces and truncates for a
 * one-line list preview (history entries, snippet bodies). */
export function truncatePreview(text, maxLen = 50) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxLen) return collapsed
  return `${collapsed.slice(0, maxLen)}…`
}

/**
 * Inserts `insertText` into `text` at the given selection, adding a
 * separating space on either side when the adjacent character isn't already
 * whitespace (so pasting a snippet mid-sentence doesn't glue words
 * together). Returns the new text and where the cursor should land.
 */
export function insertAtCursor(text, selectionStart, selectionEnd, insertText) {
  const before = text.slice(0, selectionStart)
  const after = text.slice(selectionEnd)
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
  const insert = `${needsLeadingSpace ? ' ' : ''}${insertText}${needsTrailingSpace ? ' ' : ''}`
  return { newText: before + insert + after, newCursorPos: before.length + insert.length }
}

/**
 * Appends `insertText` to the end of `text` on its own line, rather than
 * at the cursor — used for snippet insertion, where the natural flow is
 * "write the prompt, then tack a snippet on" (not mid-sentence, which is
 * what {{placeholder}} chips are for). A separating newline is added so
 * the snippet doesn't run into the end of the last line, but only when
 * `text` is non-empty and doesn't already end with one — an empty prompt
 * shouldn't get a leading blank line, and repeated appends shouldn't pile
 * up newlines beyond the one separator each needs.
 */
export function appendAtEnd(text, insertText) {
  if (!text) return insertText
  const needsNewline = !text.endsWith('\n')
  return `${text}${needsNewline ? '\n' : ''}${insertText}`
}

/**
 * Cursor-based insertion (placeholder chips) needs a real cursor position
 * to make sense, but a freshly re-rendered textarea (e.g. after opening
 * the snippet/history panel rebuilds the dialog's DOM) always reports
 * selectionStart/selectionEnd as 0 on its new element, indistinguishable
 * from the user genuinely having clicked at the very start of their text.
 * Since text-start is a much rarer place to want a mid-sentence
 * placeholder than "wherever I was", treat 0/0 on non-empty text as "no
 * meaningful cursor" and fall back to the end instead of the start.
 */
export function resolveInsertionPoint(text, start, end) {
  if (start === 0 && end === 0 && text.length > 0) {
    return { start: text.length, end: text.length }
  }
  return { start, end }
}
