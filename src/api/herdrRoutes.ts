import { Hono } from 'hono'
import { syncStatuses } from '../herdr/statusSync'
import { logger } from '../logger'
import type { AppDependencies } from './dependencies'
import { handle, ok } from './response'

function logHerdrUnreachable(context: string, err: unknown): void {
  logger.warn(`herdr ${context} failed`, {
    message: err instanceof Error ? err.message : String(err),
  })
}

export function createHerdrRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

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
