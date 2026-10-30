import type { ExecFn } from '../herdr/exec'
import { logger } from '../logger'

// Lists and reads GitHub issues through the `gh` CLI, like githubPrService:
// gh already holds the user's credentials, so private repositories work
// with no token to configure here, and every invocation goes through the
// ExecFn seam so tests inject a fake instead of spawning a process.

// A list is one network round-trip but can carry up to MAX_LIST_LIMIT issue
// bodies, so it gets more headroom than a single PR lookup.
const LIST_TIMEOUT_MS = 20_000
const VIEW_TIMEOUT_MS = 10_000

// gh's own default is 30; the dialog asks for more so a backlog fits on one
// screen, but the body text of hundreds of issues is not worth shipping to
// a picker — the search box exists for that.
export const DEFAULT_LIST_LIMIT = 50
export const MAX_LIST_LIMIT = 200

// Same reasoning as githubPrService: keep gh's actual complaint intact,
// bound a runaway error page.
const ERROR_MAX_LENGTH = 300

export type IssueStateFilter = 'open' | 'closed' | 'all'

export interface IssueLabel {
  readonly name: string
  readonly color: string
}

export interface IssueSummary {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: 'open' | 'closed'
  readonly url: string
  readonly labels: readonly IssueLabel[]
  readonly updatedAt: string
}

export interface ListIssuesOptions {
  readonly state: IssueStateFilter
  readonly limit: number
  readonly search?: string
}

export type IssueListResult =
  | { readonly ok: true; readonly issues: readonly IssueSummary[] }
  | { readonly ok: false; readonly error: string }

export type IssueFetchResult =
  | { readonly ok: true; readonly issue: IssueSummary }
  | { readonly ok: false; readonly error: string }

export type ListIssues = (nameWithOwner: string, options: ListIssuesOptions) => Promise<IssueListResult>
export type FetchIssue = (nameWithOwner: string, number: number) => Promise<IssueFetchResult>

const JSON_FIELDS = 'number,title,body,state,url,labels,updatedAt'

interface GhIssueJson {
  number?: unknown
  title?: unknown
  body?: unknown
  state?: unknown
  url?: unknown
  labels?: unknown
  updatedAt?: unknown
}

function truncateError(message: string): string {
  const collapsed = message.trim().replace(/\s+/g, ' ')
  return collapsed.length > ERROR_MAX_LENGTH ? `${collapsed.slice(0, ERROR_MAX_LENGTH)}…` : collapsed
}

function parseLabels(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) {
    return []
  }
  const labels: IssueLabel[] = []
  for (const entry of value) {
    if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      const color = (entry as { color?: unknown }).color
      labels.push({ name: (entry as { name: string }).name, color: typeof color === 'string' ? color : '' })
    }
  }
  return labels
}

// gh reports state in upper case (OPEN/CLOSED). Anything else is a shape we
// don't know, so the whole entry is rejected rather than guessed at.
function parseIssue(json: GhIssueJson): IssueSummary | null {
  if (typeof json.number !== 'number' || !Number.isSafeInteger(json.number) || json.number <= 0) {
    return null
  }
  if (typeof json.title !== 'string' || typeof json.url !== 'string' || typeof json.state !== 'string') {
    return null
  }
  const state = json.state.toUpperCase()
  if (state !== 'OPEN' && state !== 'CLOSED') {
    return null
  }
  return {
    number: json.number,
    title: json.title,
    body: typeof json.body === 'string' ? json.body : '',
    state: state === 'OPEN' ? 'open' : 'closed',
    url: json.url,
    labels: parseLabels(json.labels),
    updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : '',
  }
}

const UNPARSEABLE = 'gh の出力を解釈できませんでした'

async function runGh(
  exec: ExecFn,
  cmd: string[],
  timeoutMs: number,
  context: Record<string, unknown>
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  let result
  try {
    result = await exec(cmd, { timeoutMs })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('gh issue command failed to run', { ...context, message })
    return { ok: false, error: truncateError(`gh コマンドを実行できませんでした: ${message}`) }
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
    logger.warn('gh issue command returned a non-zero exit code', { ...context, detail })
    return { ok: false, error: truncateError(detail) }
  }
  return { ok: true, stdout: result.stdout }
}

/**
 * Builds the lister. Failures are returned, never thrown: the dialog shows
 * gh's own reason (not logged in, no such repository, …) in place of the
 * list.
 */
export function createListIssues(exec: ExecFn, ghBin: string): ListIssues {
  return async (nameWithOwner, options) => {
    const limit = Math.min(Math.max(1, Math.trunc(options.limit)), MAX_LIST_LIMIT)
    const cmd = [
      ghBin, 'issue', 'list',
      '-R', nameWithOwner,
      '--state', options.state,
      '--limit', String(limit),
      '--json', JSON_FIELDS,
    ]
    const search = options.search?.trim()
    if (search) {
      cmd.push('--search', search)
    }
    const run = await runGh(exec, cmd, LIST_TIMEOUT_MS, { repo: nameWithOwner })
    if (!run.ok) {
      return run
    }
    let json: unknown
    try {
      json = JSON.parse(run.stdout)
    } catch {
      return { ok: false, error: UNPARSEABLE }
    }
    if (!Array.isArray(json)) {
      return { ok: false, error: UNPARSEABLE }
    }
    const issues: IssueSummary[] = []
    for (const entry of json) {
      const issue = parseIssue((entry ?? {}) as GhIssueJson)
      if (issue) {
        issues.push(issue)
      }
    }
    return { ok: true, issues }
  }
}

/**
 * Reads one issue by number. Used at import time so the TODO is built from
 * the issue as it is now, not from whatever the picker was showing.
 */
export function createFetchIssue(exec: ExecFn, ghBin: string): FetchIssue {
  return async (nameWithOwner, number) => {
    const cmd = [ghBin, 'issue', 'view', String(number), '-R', nameWithOwner, '--json', JSON_FIELDS]
    const run = await runGh(exec, cmd, VIEW_TIMEOUT_MS, { repo: nameWithOwner, number })
    if (!run.ok) {
      return run
    }
    let json: GhIssueJson
    try {
      json = JSON.parse(run.stdout) as GhIssueJson
    } catch {
      return { ok: false, error: UNPARSEABLE }
    }
    const issue = parseIssue(json ?? {})
    if (!issue) {
      return { ok: false, error: 'gh の出力に number/title/url が含まれていませんでした' }
    }
    return { ok: true, issue }
  }
}
