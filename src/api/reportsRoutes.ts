import { Hono } from 'hono'
import * as reportRepo from '../db/reportRepo'
import * as weeklyGoalRepo from '../db/weeklyGoalRepo'
import { formatLocalDate, mostRecentMonday } from '../services/localDate'
import { generateWeeklyReport } from '../services/reportService'
import { computeWeeklyStats } from '../services/reportStatsService'
import { addToQueue, listQueue, removeFromQueue, reorderQueue, setQueueDispatch } from '../services/weekQueueService'
import { buildWeeklyGoalDraft } from '../services/weeklyGoalDraftService'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import {
  generateGoalSchema,
  generateReportSchema,
  idParamSchema,
  optionalWeekStartQuerySchema,
  queueAddSchema,
  queueDispatchSchema,
  queueReorderSchema,
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

  // 「目標を生成」: その週に期限のあるマイルストーン・TODO と優先度の高い
  // ものから Markdown の下書きを作って返す。保存はしない(tidy と同じく、
  // 画面側が入力欄に入れてから POST /weekly/goal する)。
  // 下書きに載せた TODO は「今週終わらせるタスク」の並びにも足す(既にある
  // ものは動かさない)。期日の無い TODO には週末の期日が付く。
  app.post('/weekly/goal/generate', async (c) => {
    return handle(c, async () => {
      const { weekStart } = parseOrThrow(generateGoalSchema, await c.req.json())
      const draft = buildWeeklyGoalDraft(deps.db, weekStart, formatLocalDate(new Date()))
      let queued = 0
      for (const todoId of draft.todoIds) {
        const before = listQueue(deps.db, weekStart).todos.length
        addToQueue(deps.db, weekStart, todoId)
        if (listQueue(deps.db, weekStart).todos.length > before) queued++
      }
      return ok(c, { body: draft.body, queued, queue: listQueue(deps.db, weekStart) })
    })
  })

  // 「今週終わらせるタスク」の並び。ブラウザ UI 専用(apiTokenAuth.ts の
  // 許可リストには入れていない)。
  app.get('/weekly/queue', (c) => {
    return handle(c, async () => {
      const { weekStart } = parseOrThrow(weekStartQuerySchema, c.req.query())
      return ok(c, listQueue(deps.db, weekStart))
    })
  })

  app.post('/weekly/queue', async (c) => {
    return handle(c, async () => {
      const { weekStart, todoId } = parseOrThrow(queueAddSchema, await c.req.json())
      addToQueue(deps.db, weekStart, todoId)
      return ok(c, listQueue(deps.db, weekStart), 201)
    })
  })

  app.put('/weekly/queue/order', async (c) => {
    return handle(c, async () => {
      const { weekStart, todoIds } = parseOrThrow(queueReorderSchema, await c.req.json())
      return ok(c, reorderQueue(deps.db, weekStart, todoIds))
    })
  })

  // 行の「herdr」切り替え: 投入する対象か、自分でやるタスクか。
  app.patch('/weekly/queue/:id', async (c) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const { weekStart, dispatch } = parseOrThrow(queueDispatchSchema, await c.req.json())
      if (!setQueueDispatch(deps.db, weekStart, id, dispatch)) {
        return fail(c, 404, 'そのTODOは今週の一覧にありません')
      }
      return ok(c, listQueue(deps.db, weekStart))
    })
  })

  app.delete('/weekly/queue/:id', (c) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const { weekStart } = parseOrThrow(weekStartQuerySchema, c.req.query())
      if (!removeFromQueue(deps.db, weekStart, id)) {
        return fail(c, 404, 'そのTODOは今週の一覧にありません')
      }
      return ok(c, listQueue(deps.db, weekStart))
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
