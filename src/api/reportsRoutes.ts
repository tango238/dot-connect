import { Hono } from 'hono'
import * as reportRepo from '../db/reportRepo'
import * as weeklyGoalRepo from '../db/weeklyGoalRepo'
import { formatLocalDate, mostRecentMonday } from '../services/localDate'
import { generateWeeklyReport } from '../services/reportService'
import { computeWeeklyStats } from '../services/reportStatsService'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import {
  generateReportSchema,
  optionalWeekStartQuerySchema,
  saveGoalSchema,
  tidyGoalSchema,
  weekStartQuerySchema,
} from './schemas'
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

  // 保存された週次レポート(LLM 分析)とは別に、数値は毎回 DB から集計して
  // 返す。claude を呼ばないので何度呼んでもコストは無い。
  app.get('/weekly/stats', (c) => {
    return handle(c, async () => {
      const { weekStart } = parseOrThrow(optionalWeekStartQuerySchema, c.req.query())
      const now = new Date()
      return ok(c, computeWeeklyStats(deps.db, weekStart ?? mostRecentMonday(now), formatLocalDate(now)))
    })
  })

  // 週の目標。無ければ空の本文を返す(404 にしない: 画面は常に入力欄を出す)。
  app.get('/weekly/goal', (c) => {
    return handle(c, async () => {
      const { weekStart } = parseOrThrow(weekStartQuerySchema, c.req.query())
      const goal = weeklyGoalRepo.getByWeekStart(deps.db, weekStart)
      return ok(c, goal ?? { weekStart, body: '', updatedAt: null })
    })
  })

  app.post('/weekly/goal', async (c) => {
    return handle(c, async () => {
      const input = parseOrThrow(saveGoalSchema, await c.req.json())
      return ok(c, weeklyGoalRepo.upsert(deps.db, input.weekStart, input.body.trim()))
    })
  })

  // 「整理する」: claude -p で読みやすく整えた本文を返すだけで保存はしない
  // (保存は画面側が結果を見せたうえで POST /weekly/goal する)。
  app.post('/weekly/goal/tidy', async (c) => {
    return handle(c, async () => {
      const input = parseOrThrow(tidyGoalSchema, await c.req.json())
      const body = await deps.claudeRunner.tidyGoal(input.body)
      return ok(c, { body })
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
