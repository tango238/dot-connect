// Pure pieces of the "GitHub Issue から取り込み" dialog: repo-input
// validation (a client-side mirror of src/services/githubRepo.ts, so the
// dialog can say "that's not a repository" before a round-trip), matching
// listed issues against TODOs that already came from them, the remembered
// repository list, and the result message. Unit-tested like the other lib/
// modules; the DOM work lives in issueImportDialog.js.

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/

function isValidName(name) {
  return name !== '.' && name !== '..' && NAME_PATTERN.test(name)
}

function fromParts(owner, repo) {
  const bare = repo.endsWith('.git') ? repo.slice(0, -4) : repo
  if (!isValidName(owner) || !isValidName(bare)) return null
  return `${owner}/${bare}`
}

/**
 * "owner/repo", a github.com URL (repository, issue, file, …), or
 * "github.com/owner/repo" → "owner/repo". Anything else → null.
 * @param {string} raw
 * @returns {string | null}
 */
export function parseRepoInput(raw) {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) {
    let url
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null
    const [owner, repo] = url.pathname.split('/').filter(Boolean)
    if (!owner || !repo) return null
    return fromParts(owner, repo)
  }
  const parts = trimmed.replace(/^(www\.)?github\.com\//i, '').split('/')
  if (parts.length !== 2) return null
  return fromParts(parts[0], parts[1])
}

/**
 * Which listed issues already have a TODO. The server puts the issue URL on
 * the description's first line, but a URL pasted anywhere in a description
 * counts too — the point is not to create a second TODO for the same issue.
 * The character after the URL must not be a digit, so ".../issues/1" does
 * not match a TODO for ".../issues/12".
 * @param {Array<{number: number, url: string}>} issues
 * @param {Array<{id: number, status: string, description?: string}>} todos
 * @returns {Map<number, {todoId: number, done: boolean}>} keyed by issue number
 */
export function importedTodosByIssue(issues, todos) {
  const result = new Map()
  for (const issue of issues) {
    const match = todos.find((t) => {
      const desc = t.description ?? ''
      let from = 0
      while (true) {
        const at = desc.indexOf(issue.url, from)
        if (at === -1) return false
        const next = desc[at + issue.url.length]
        if (next === undefined || !/[0-9]/.test(next)) return true
        from = at + 1
      }
    })
    if (match) result.set(issue.number, { todoId: match.id, done: match.status === 'done' })
  }
  return result
}

/**
 * Whether an issue's checkbox can be ticked. An issue whose TODO is still
 * open is locked out (that would be a duplicate); one whose TODO is done may
 * be imported again — the issue may have been reopened.
 * @param {{todoId: number, done: boolean} | undefined} imported
 */
export function isIssueSelectable(imported) {
  return imported === undefined || imported.done
}

export const MAX_REMEMBERED_REPOS = 8

/**
 * Most-recent-first list of repositories the dialog has listed, for the
 * repo field's datalist. Deduplicated, bounded.
 * @param {string[]} remembered
 * @param {string} repo canonical "owner/repo"
 * @returns {string[]}
 */
export function rememberRepo(remembered, repo) {
  return [repo, ...remembered.filter((r) => r !== repo)].slice(0, MAX_REMEMBERED_REPOS)
}

const STORAGE_KEY = 'dot-connect.issueImport.repos'

/** @param {Storage | null | undefined} storage */
export function loadRememberedRepos(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === 'string') : []
  } catch {
    return []
  }
}

/** @param {Storage | null | undefined} storage @param {string[]} repos */
export function saveRememberedRepos(storage, repos) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(repos))
  } catch {
    // Private mode / quota: the list is a convenience, not state.
  }
}

/**
 * gh reports a label's color as bare hex ("d73a4a"); anything else falls
 * back to the neutral chip color so a surprising value never reaches CSS.
 * @param {string} color
 */
export function labelColor(color) {
  return /^[0-9a-fA-F]{6}$/.test(color ?? '') ? `#${color}` : '#8b93a7'
}

/**
 * The toast text after an import, and whether it is a warning (something
 * failed) or plain success.
 * @param {{created: unknown[], failed: Array<{number: number, error: string}>}} result
 * @returns {{message: string, warning: boolean}}
 */
export function importResultMessage(result) {
  const created = result.created.length
  const failed = result.failed
  if (failed.length === 0) {
    return { message: `${created}件の Issue を TODO に取り込みました`, warning: false }
  }
  const numbers = failed.map((f) => `#${f.number}`).join(', ')
  const head = created > 0 ? `${created}件を取り込みました。` : ''
  return { message: `${head}${numbers} は取り込めませんでした: ${failed[0].error}`, warning: true }
}

/** Button label for the import action. @param {number} count */
export function importButtonLabel(count) {
  return count > 0 ? `選択した ${count} 件を取り込む` : '取り込む Issue を選んでください'
}
