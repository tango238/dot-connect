// Parsing and canonicalization of GitHub Pull Request URLs. Pure — no I/O,
// no database, no process spawning — so the messy part (what counts as "the
// same PR") is testable on its own.
//
// Canonicalization matters beyond tidiness: todo_pull_requests enforces
// uniqueness on (todo_id, url), so without it the same PR pasted from the
// browser's "Files changed" tab and from the PR page itself would register
// as two separate links on one TODO.

// github.com only. GitHub Enterprise hosts are deliberately out of scope:
// `gh` would need per-host auth configured, and there is no way to tell a
// GHE hostname from an arbitrary unrelated one without asking the user.
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com'])

// GitHub's own rule for owner and repository names. Checked explicitly (not
// just "any non-slash segment") so a malformed URL fails here rather than
// being handed to `gh` as a nonsense argument.
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/

// Trailing segments the GitHub UI appends (/files, /commits, /checks, …) are
// dropped, as is any query string or fragment (#discussion_r…).
const PULL_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/

export interface ParsedPullRequestUrl {
  readonly url: string
  readonly owner: string
  readonly repo: string
  readonly number: number
}

function isValidName(name: string): boolean {
  // '.' and '..' match NAME_PATTERN but are path traversal, not repo names.
  return name !== '.' && name !== '..' && NAME_PATTERN.test(name)
}

/**
 * Parses a GitHub Pull Request URL into its parts plus a canonical URL, or
 * returns null if it isn't one. http is accepted on input but always
 * canonicalized to https.
 */
export function parsePullRequestUrl(raw: string): ParsedPullRequestUrl | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null
  }
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null
  }

  const match = PULL_PATH_PATTERN.exec(parsed.pathname)
  if (!match) {
    return null
  }
  const owner = match[1]!
  const repo = match[2]!
  const number = Number(match[3]!)
  if (!isValidName(owner) || !isValidName(repo)) {
    return null
  }
  // A PR number of 0 is not a real PR, and Number() on a \d+ match can only
  // lose precision past 2^53 — both are rejected rather than passed on.
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null
  }

  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    owner,
    repo,
    number,
  }
}
