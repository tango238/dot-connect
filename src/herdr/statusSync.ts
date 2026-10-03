import type { Database } from 'bun:sqlite'
import * as todoRepo from '../db/todoRepo'
import type { HerdrAgentStatus, HerdrClient } from './herdrClient'
import type { SessionState } from '../types'

export interface SyncResult {
  readonly updatedCount: number
}

// A freshly dispatched todo legitimately reads 'unknown' for a moment:
// dispatchService marks it dispatched right after creating the workspace,
// before claude has actually started inside the pane. Don't treat that
// window as a dead session.
const UNKNOWN_GRACE_PERIOD_MS = 60_000

// SQLite's datetime('now') (used for dispatched_at) produces
// "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker. Feeding that
// straight to `new Date()` has it parsed as *local* time by the JS engine,
// silently corrupting any elapsed-time comparison. Mirrors parseSqliteUtc in
// public/js/lib/todoDetail.js — keep both in sync if the convention changes.
export function parseSqliteUtcMs(value: string | null): number | null {
  if (!value) {
    return null
  }
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
  const ms = new Date(withZone).getTime()
  return Number.isNaN(ms) ? null : ms
}

function toSessionState(status: HerdrAgentStatus): SessionState | undefined {
  if (status === 'unknown') {
    return undefined
  }
  return status
}

// A null/unparseable dispatchedAt can't prove the todo is within the grace
// period, so it fails toward cleaning up stale state rather than pinning the
// todo forever.
function isWithinDispatchGracePeriod(dispatchedAt: string | null, nowMs: number): boolean {
  const dispatchedMs = parseSqliteUtcMs(dispatchedAt)
  if (dispatchedMs === null) {
    return false
  }
  return nowMs - dispatchedMs < UNKNOWN_GRACE_PERIOD_MS
}

export async function syncStatuses(
  db: Database,
  herdr: HerdrClient,
  now: () => number = () => Date.now()
): Promise<SyncResult> {
  const snapshot = await herdr.snapshot()
  const statusByPaneId = new Map(snapshot.panes.map((p) => [p.paneId, p.agentStatus]))
  const nowMs = now()

  let updatedCount = 0
  for (const todo of todoRepo.listAll(db)) {
    if (todo.herdrPaneId === null) {
      continue
    }
    const agentStatus = statusByPaneId.get(todo.herdrPaneId)

    if (agentStatus === undefined) {
      // The pane is gone entirely (workspace closed outside dot-connect):
      // clear the stale session linkage rather than leaving it pointing at
      // nothing.
      todoRepo.clearDispatch(db, todo.id)
      updatedCount += 1
      continue
    }

    if (agentStatus === 'unknown') {
      // The pane is still present but claude has exited inside it. Unless
      // this is the brief post-dispatch startup window, treat it the same
      // as a vanished pane: clear the stale linkage so the UI falls back to
      // offering a fresh dispatch instead of "open session" on a dead pane.
      if (isWithinDispatchGracePeriod(todo.dispatchedAt, nowMs)) {
        continue
      }
      todoRepo.clearDispatch(db, todo.id)
      updatedCount += 1
      continue
    }

    const nextState = toSessionState(agentStatus)
    if (nextState === undefined || nextState === todo.sessionState) {
      continue
    }
    todoRepo.updateSessionState(db, todo.id, nextState)
    updatedCount += 1
  }

  return { updatedCount }
}
