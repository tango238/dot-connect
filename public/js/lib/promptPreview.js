// Pure client-side preview of {{title}}/{{description}} placeholder
// substitution — for showing the user what will be sent, not the actual
// substitution (the server does the real replacement, plus newline
// flattening, at dispatch time).

// Matches {{key}} and {{ key }} (inner whitespace allowed); leaves anything
// that isn't a recognized key untouched so unknown placeholders are visible
// rather than silently eaten.
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g

/**
 * @param {string} template raw prompt text, possibly containing placeholders
 * @param {Record<string, string>} values e.g. { title, description }
 */
export function renderPromptPreview(template, values) {
  return template.replace(PLACEHOLDER_RE, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match
    return values[key]
  })
}
