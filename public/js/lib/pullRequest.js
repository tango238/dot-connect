// Pure display logic for a TODO's linked Pull Requests: no DOM, no state
// access, so it can be unit-tested like the other modules under lib/.

// A merged PR is shown as its own state rather than folded into "closed" —
// "did this actually land?" is the question the badge exists to answer.
const STATE_BADGE = {
  open: { label: 'Open', className: 'pr-open' },
  merged: { label: 'Merged', className: 'pr-merged' },
  closed: { label: 'Closed', className: 'pr-closed' },
}

const DRAFT_BADGE = { label: 'Draft', className: 'pr-draft' }

/** Short human-readable identity for a PR: `owner/repo#123`. */
export function pullRequestLabel(pr) {
  return `${pr.owner}/${pr.repo}#${pr.number}`
}

/**
 * The state chip to show, or null when nothing is known yet (the metadata
 * fetch never succeeded — the row falls back to showing the reason instead).
 * Draft wins over open: a draft PR is not waiting on anyone.
 * @returns {{label: string, className: string} | null}
 */
export function pullRequestStateBadge(pr) {
  if (!pr.state) return null
  if (pr.state === 'open' && pr.isDraft === true) return DRAFT_BADGE
  return STATE_BADGE[pr.state] ?? null
}

/**
 * What to show as the PR's headline. Falls back to the `owner/repo#123`
 * identity when no title was ever fetched, so a row is never blank.
 */
export function pullRequestHeadline(pr) {
  return pr.title ?? pullRequestLabel(pr)
}

/**
 * The warning to show under a row, or null when there's nothing wrong.
 * A stored fetchError alongside an existing title means a *refresh* failed
 * and the visible title is stale, which is worth saying differently from
 * "never fetched at all".
 */
export function pullRequestNotice(pr) {
  if (!pr.fetchError) return null
  return pr.fetchedAt
    ? `最新の状態を取得できませんでした(表示は前回取得時点): ${pr.fetchError}`
    : `PR情報を取得できませんでした: ${pr.fetchError}`
}

/** Count shown on the TODO row; 0 means the row shows no PR chip at all. */
export function pullRequestCount(todo) {
  return todo.pullRequests?.length ?? 0
}
