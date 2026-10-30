// Parsing of "which GitHub repository" input. Pure — no I/O — so the lenient
// forms a user is likely to paste (owner/repo, a repository URL, the URL of
// an issue inside it) are canonicalized and testable on their own.
//
// github.com only, for the same reason as pullRequestUrl.ts: a GitHub
// Enterprise host would need its own `gh` auth and can't be told apart from
// an unrelated hostname.

const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com'])

// GitHub's own rule for owner and repository names. Checked explicitly so a
// malformed value fails here with a clear message rather than being handed
// to `gh -R` as a nonsense argument.
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/

export interface ParsedRepo {
  readonly owner: string
  readonly repo: string
  // "owner/repo" — the form `gh -R` takes.
  readonly nameWithOwner: string
}

function isValidName(name: string): boolean {
  // '.' and '..' match NAME_PATTERN but are path traversal, not repo names.
  return name !== '.' && name !== '..' && NAME_PATTERN.test(name)
}

function fromParts(owner: string, repo: string): ParsedRepo | null {
  // A pasted clone URL ends in ".git"; the repo itself doesn't.
  const bare = repo.endsWith('.git') ? repo.slice(0, -4) : repo
  if (!isValidName(owner) || !isValidName(bare)) {
    return null
  }
  return { owner, repo: bare, nameWithOwner: `${owner}/${bare}` }
}

function fromUrl(raw: string): ParsedRepo | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null
  }
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null
  }
  // Only the first two path segments matter: /owner/repo/issues/12,
  // /owner/repo/tree/main/... all name the same repository.
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
  const owner = segments[0]
  const repo = segments[1]
  if (owner === undefined || repo === undefined) {
    return null
  }
  return fromParts(owner, repo)
}

/**
 * Accepts "owner/repo", "https://github.com/owner/repo", or any URL under
 * such a repository (an issue, a file, …), and returns the canonical parts.
 * Returns null for anything else.
 */
export function parseRepoSpec(raw: string): ParsedRepo | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return fromUrl(trimmed)
  }
  // Tolerate a pasted "github.com/owner/repo" without a scheme.
  const withoutHost = trimmed.replace(/^(www\.)?github\.com\//i, '')
  const parts = withoutHost.split('/')
  if (parts.length !== 2) {
    return null
  }
  return fromParts(parts[0]!, parts[1]!)
}
