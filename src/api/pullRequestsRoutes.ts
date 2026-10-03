import type { Context } from 'hono'
import { Hono } from 'hono'
import * as todoPullRequestRepo from '../db/todoPullRequestRepo'
import { createFetchPullRequest } from '../services/githubPrService'
import type { FetchPullRequest } from '../services/githubPrService'
import type { AppDependencies } from './dependencies'
import { handle, ok } from './response'

// 5分より古い open PR だけを、1回あたり最大20件まで再取得する。GitHub 側で
// マージされた PR が「レビュー待ち」に居座り続けるのを防ぐのが目的なので、
// 分単位の鮮度で十分——そのぶん gh の呼び出し回数を抑える。
const STALE_AFTER_MS = 5 * 60 * 1000
const MAX_REFRESH_PER_CALL = 20

// SQLite の datetime('now') と同じ 'YYYY-MM-DD HH:MM:SS'(UTC)に揃える。
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function refreshStaleHandler(deps: AppDependencies, fetchPullRequest: FetchPullRequest) {
  return (c: Context) =>
    handle(c, async () => {
      const cutoff = sqliteUtc(Date.now() - STALE_AFTER_MS)
      const stale = todoPullRequestRepo.listStaleOpen(deps.db, cutoff, MAX_REFRESH_PER_CALL)

      let refreshed = 0
      let failed = 0
      for (const pr of stale) {
        // 1件の失敗で残りを止めない。理由は既存の add/refresh と同じで、
        // リンク自体は有効なまま残す価値があるから。
        const result = await fetchPullRequest(pr.url)
        if (result.ok) {
          todoPullRequestRepo.recordFetchSuccess(deps.db, pr.id, result.snapshot)
          refreshed += 1
        } else {
          todoPullRequestRepo.recordFetchError(deps.db, pr.id, result.error)
          failed += 1
        }
      }
      return ok(c, { refreshed, failed })
    })
}

export function createPullRequestsRoutes(deps: AppDependencies): Hono {
  const app = new Hono()
  app.post('/refresh-stale', refreshStaleHandler(deps, createFetchPullRequest(deps.exec, deps.ghBin)))
  return app
}
