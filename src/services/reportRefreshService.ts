import type { Database } from 'bun:sqlite'
import * as reportRepo from '../db/reportRepo'
import { logger } from '../logger'
import type { ClaudeRunner } from './claudeRunner'
import type { WeeklyReport } from '../types'
import { formatLocalDate, mostRecentMonday, sqliteUtcToLocalDate } from './localDate'
import { generateWeeklyReport } from './reportService'

// 週次レポートを「毎日更新」する仕組み。今週のレポートが無いか、最後に
// 生成したのが今日(ローカル暦)より前なら生成し直す。生成は claude -p を
// 伴うので、1日に1回だけ —— 同じ日に何度確認しても2回目は走らない。
// 手動の「再生成」(POST /generate、ネイティブメニュー)とは独立で、手動で
// 生成した日はその日の自動分も済んだ扱いになる(generated_at が今日なので)。

export const DEFAULT_CHECK_INTERVAL_MS = 60 * 60_000

export function needsDailyRefresh(report: WeeklyReport | null, now: Date): boolean {
  if (report === null) return true
  return sqliteUtcToLocalDate(report.generatedAt) < formatLocalDate(now)
}

export interface DailyReportRefresherDeps {
  readonly db: Database
  readonly claudeRunner: ClaudeRunner
}

export interface DailyReportRefresherOptions {
  readonly intervalMs?: number
  readonly now?: () => Date
  // タイマーの差し替え口(テスト用)。既定は setInterval / clearInterval。
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancel?: (handle: unknown) => void
}

export interface DailyReportRefresher {
  /** 必要なら今週分を生成する。生成したら true。多重起動はしない。 */
  tick(): Promise<boolean>
  start(): void
  stop(): void
}

export function createDailyReportRefresher(
  deps: DailyReportRefresherDeps,
  options: DailyReportRefresherOptions = {}
): DailyReportRefresher {
  const intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
  let handle: unknown = null
  let inFlight: Promise<boolean> | null = null

  async function refresh(): Promise<boolean> {
    const current = now()
    const weekStart = mostRecentMonday(current)
    const existing = reportRepo.getByWeekStart(deps.db, weekStart)
    if (!needsDailyRefresh(existing, current)) return false
    logger.info('週次レポートを自動生成します', { weekStart, previousGeneratedAt: existing?.generatedAt ?? null })
    try {
      const report = await generateWeeklyReport(deps.db, deps.claudeRunner, { weekStart, now: current })
      logger.info('週次レポートを自動生成しました', { weekStart, llmError: report.llmError })
      return true
    } catch (err) {
      // generateWeeklyReport は LLM の失敗を飲み込んで数値だけ保存するので、
      // ここに来るのは DB 側の失敗。次の確認でまた試す。
      logger.warn('週次レポートの自動生成に失敗しました', {
        weekStart,
        message: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  function tick(): Promise<boolean> {
    if (inFlight === null) {
      inFlight = refresh().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }

  return {
    tick,
    start() {
      if (handle !== null) return
      void tick()
      handle = schedule(() => void tick(), intervalMs)
    },
    stop() {
      if (handle === null) return
      cancel(handle)
      handle = null
    },
  }
}
