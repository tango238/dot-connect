import { Hono } from 'hono'
import * as reportRepo from '../db/reportRepo'
import { generateWeeklyReport } from '../services/reportService'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { generateReportSchema, weekStartQuerySchema } from './schemas'
import { parseOrThrow } from './validation'

export function createReportsRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/weekly', (c) => {
    return handle(c, async () => {
      const { weekStart } = parseOrThrow(weekStartQuerySchema, c.req.query())
      const report = reportRepo.getByWeekStart(deps.db, weekStart)
      if (report === null) {
        return fail(c, 404, `No report for week ${weekStart}`)
      }
      return ok(c, report)
    })
  })

  app.get('/weekly/latest', (c) => {
    return handle(c, async () => {
      const report = reportRepo.getLatest(deps.db)
      if (report === null) {
        return fail(c, 404, 'No weekly reports have been generated yet')
      }
      return ok(c, report)
    })
  })

  app.post('/weekly/generate', async (c) => {
    return handle(c, async () => {
      const rawBody = await c.req.text()
      const body = rawBody.length > 0 ? JSON.parse(rawBody) : {}
      const input = parseOrThrow(generateReportSchema, body)
      const report = await generateWeeklyReport(deps.db, deps.claudeRunner, {
        weekStart: input.weekStart,
      })
      return ok(c, report, 201)
    })
  })

  return app
}
