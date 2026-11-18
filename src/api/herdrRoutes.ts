import { Hono } from 'hono'
import { syncStatuses } from '../herdr/statusSync'
import { logger } from '../logger'
import { BadRequestError } from '../services/errors'
import { startAdhocSession, startSkillSession } from '../services/skillSessionService'
import type { AppDependencies } from './dependencies'
import { handle, ok, fail } from './response'

function logHerdrUnreachable(context: string, err: unknown): void {
  logger.warn(`herdr ${context} failed`, {
    message: err instanceof Error ? err.message : String(err),
  })
}

export function createHerdrRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/compatibility', (c) => handle(c, async () => {
    if (!deps.herdrCompatibility) return fail(c, 500, 'Herdr確認機能が初期化されていません')
    return ok(c, await deps.herdrCompatibility.check())
  }))
  app.post('/compatibility/check', (c) => handle(c, async () => {
    if (!deps.herdrCompatibility) return fail(c, 500, 'Herdr確認機能が初期化されていません')
    return ok(c, await deps.herdrCompatibility.check(true))
  }))

  app.post('/sync', (c) => {
    return handle(c, async () => {
      try {
        const result = await syncStatuses(deps.db, deps.herdr)
        return ok(c, { updatedCount: result.updatedCount, connected: true })
      } catch (err) {
        logHerdrUnreachable('sync', err)
        return ok(c, { updatedCount: 0, connected: false })
      }
    })
  })

  // 「プロンプトから複数登録」: /dot-connect を打ち込んだ Claude Code の
  // セッションを開く。「対応してから登録」: テンポラリディレクトリで素の
  // Claude Code を開く(どちらも skillSessionService.ts)。TODO に属さないので
  // /todos ではなくここ。herdr を使うので macOS 限定。
  const sessionOptions = () => {
    if (deps.platform !== 'darwin') {
      throw new BadRequestError('この機能は macOS でのみ利用できます')
    }
    return {
      claudeBin: deps.claudeBin,
      claudeSkillsDir: deps.claudeSkillsDir,
      notesDir: deps.notesDir,
      terminalApp: deps.terminalApp,
      exec: deps.exec,
      agentReadyTimeoutMs: deps.dispatchAgentReadyTimeoutMs,
      pollIntervalMs: deps.dispatchPollIntervalMs,
      sleep: deps.dispatchSleep,
      settleMs: deps.dispatchSettleMs,
    }
  }
  app.post('/skill-session', (c) => handle(c, async () => {
    return ok(c, await startSkillSession(deps.herdr, sessionOptions()))
  }))
  app.post('/adhoc-session', (c) => handle(c, async () => {
    return ok(c, await startAdhocSession(deps.herdr, { ...sessionOptions(), tempRoot: deps.adhocTempRoot }))
  }))

  app.get('/status', (c) => {
    return handle(c, async () => {
      try {
        const snapshot = await deps.herdr.snapshot()
        return ok(c, { connected: true, totalPanes: snapshot.panes.length })
      } catch (err) {
        logHerdrUnreachable('status check', err)
        return ok(c, { connected: false, totalPanes: 0 })
      }
    })
  })

  return app
}
