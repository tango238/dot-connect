// A small Markdown → HTML renderer for user-written text such as the weekly
// goal. Covers the everyday subset (headings, lists incl. nested and task
// lists, bold/italic/strike/code, links, quotes, fenced code, rules); the
// input is HTML-escaped before any markup is applied, so untrusted text can
// never inject tags. Pure, so it is unit-tested under tests/frontend.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const FENCE = /^\s*```/
const QUOTE = /^\s*>\s?(.*)$/

/** Inline markup on one line of already-plain text. */
export function renderInline(text) {
  let html = escapeHtml(text)
  // Code spans first, so nothing inside them is treated as markup.
  const codes = []
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
  html = html.replace(/(^|[^_\w])_([^_\n]+?)_(?=[^_\w]|$)/g, '$1<em>$2</em>')
  html = html.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
  return html
}

function indentWidth(ws) {
  return ws.replace(/\t/g, '  ').length
}

function listItemHtml(content) {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(content)
  if (task) {
    const checked = task[1] !== ' '
    return `<li class="task${checked ? ' done' : ''}"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${renderInline(task[2])}</li>`
  }
  return `<li>${renderInline(content)}</li>`
}

// Parses the list that starts at lines[start] (which must match LIST_LINE),
// nesting deeper-indented items under the item before them.
function parseList(lines, start, indent) {
  const first = LIST_LINE.exec(lines[start])
  const ordered = /\d/.test(first[2])
  const tag = ordered ? 'ol' : 'ul'
  const items = []
  let i = start
  while (i < lines.length) {
    const m = LIST_LINE.exec(lines[i])
    if (!m) {
      // A more-indented plain line continues the current item's text.
      if (items.length > 0 && /^\s*$/.test(lines[i]) === false && indentWidth(/^\s*/.exec(lines[i])[0]) > indent) {
        items[items.length - 1].text += ` ${lines[i].trim()}`
        i++
        continue
      }
      break
    }
    const width = indentWidth(m[1])
    if (width < indent) break
    if (width > indent) {
      if (items.length === 0) break
      const child = parseList(lines, i, width)
      items[items.length - 1].children += child.html
      i = child.next
      continue
    }
    items.push({ text: m[3], children: '' })
    i++
  }
  const html = `<${tag}>${items.map((item) => listItemHtml(item.text).replace(/<\/li>$/, `${item.children}</li>`)).join('')}</${tag}>`
  return { html, next: i }
}

function isBlockStart(line) {
  return HEADING.test(line) || LIST_LINE.test(line) || RULE.test(line) || FENCE.test(line) || QUOTE.test(line)
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    if (FENCE.test(line)) {
      const body = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // closing fence (or end of input)
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }
    if (RULE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const inner = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])[1])
        i++
      }
      out.push(`<blockquote>${renderMarkdown(inner.join('\n'))}</blockquote>`)
      continue
    }
    const listMatch = LIST_LINE.exec(line)
    if (listMatch) {
      const list = parseList(lines, i, indentWidth(listMatch[1]))
      out.push(list.html)
      i = list.next
      continue
    }
    const para = []
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      para.push(lines[i].trim())
      i++
    }
    out.push(`<p>${para.map(renderInline).join('<br>')}</p>`)
  }
  return out.join('')
}
