import type { ExecFn } from '../herdr/exec'
import { logger } from '../logger'
import type { PullRequestState } from '../types'

// Fetches a PR's title and state through the `gh` CLI rather than the GitHub
// REST API directly: gh already holds the user's credentials, so private
// repositories work with no token to configure, store, or rotate here.
//
// Every invocation goes through the same ExecFn seam herdr and claude use,
// so tests inject a fake instead of spawning a real process.

const FETCH_TIMEOUT_MS = 10_000

// Long enough to keep gh's actual complaint ("could not resolve to a
// PullRequest", "gh auth login required", …) intact, short enough that a
// runaway error page can't be stored wholesale.
const ERROR_MAX_LENGTH = 300

export interface PullRequestSnapshot {
  readonly title: string
  readonly state: PullRequestState
  readonly isDraft: boolean
}

export type PullRequestFetchResult =
  | { readonly ok: true; readonly snapshot: PullRequestSnapshot }
  | { readonly ok: false; readonly error: string }

export type FetchPullRequest = (url: string) => Promise<PullRequestFetchResult>

// gh reports state in upper case, and reports a merged PR as MERGED rather
// than CLOSED — which is exactly the distinction worth showing, so it is
// preserved instead of being folded into "closed".
const STATE_BY_GH_VALUE: Readonly<Record<string, PullRequestState>> = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
}

interface GhPullRequestJson {
  title?: unknown
  state?: unknown
  isDraft?: unknown
}

function truncateError(message: string): string {
  const collapsed = message.trim().replace(/\s+/g, ' ')
  return collapsed.length > ERROR_MAX_LENGTH
    ? `${collapsed.slice(0, ERROR_MAX_LENGTH)}…`
    : collapsed
}

function failure(message: string): PullRequestFetchResult {
  return { ok: false, error: truncateError(message) }
}

function parseSnapshot(stdout: string): PullRequestFetchResult {
  let json: GhPullRequestJson
  try {
    json = JSON.parse(stdout) as GhPullRequestJson
  } catch {
    return failure('gh の出力を解釈できませんでした')
  }
  const state = typeof json.state === 'string' ? STATE_BY_GH_VALUE[json.state.toUpperCase()] : undefined
  if (typeof json.title !== 'string' || state === undefined) {
    return failure('gh の出力に title/state が含まれていませんでした')
  }
  return {
    ok: true,
    snapshot: { title: json.title, state, isDraft: json.isDraft === true },
  }
}

/**
 * Builds the fetcher. Failures are returned, never thrown: a PR URL is worth
 * keeping even when its metadata can't be read (gh missing, not logged in,
 * no access to a private repo), and the caller records the reason alongside
 * the link instead of rejecting the registration.
 */
export function createFetchPullRequest(exec: ExecFn, ghBin: string): FetchPullRequest {
  return async (url) => {
    const cmd = [ghBin, 'pr', 'view', url, '--json', 'title,state,isDraft']
    let result
    try {
      result = await exec(cmd, { timeoutMs: FETCH_TIMEOUT_MS })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('gh pr view failed to run', { url, message })
      return failure(`gh コマンドを実行できませんでした: ${message}`)
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
      logger.warn('gh pr view returned a non-zero exit code', { url, detail })
      return failure(detail)
    }
    return parseSnapshot(result.stdout)
  }
}
