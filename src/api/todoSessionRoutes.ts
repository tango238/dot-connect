import type { Context } from 'hono'
import { Hono } from 'hono'
import { dispatchTodo } from '../services/dispatchService'
import { BadRequestError } from '../services/errors'
import { finishGrill, type GrillOptions, grillRootFor, startGrill } from '../services/grillService'
import { openSession } from '../services/sessionService'
import type { AppDependencies } from './dependencies'
import { handle, ok } from './response'
import { dispatchRequestSchema, idParamSchema } from './schemas'
import { parseOrThrow } from './validation'

const MACOS_ONLY_MESSAGE = 'この機能は macOS でのみ利用できます'

// Split out from todosRoutes.ts: these two routes talk to herdr (a live
// external process) rather than just the database, so they carry different
// concerns (dispatch rollback, session focus) worth keeping separate.

function dispatchTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      if (deps.platform !== 'darwin') {
        throw new BadRequestError(MACOS_ONLY_MESSAGE)
      }
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const rawBody = await c.req.text()
      const body = rawBody.length > 0 ? JSON.parse(rawBody) : {}
      const { prompt, workspacePath, model } = parseOrThrow(dispatchRequestSchema, body)
      const result = await dispatchTodo(deps.db, deps.herdr, id, {
        claudeBin: deps.claudeBin,
        codexBin: deps.codexBin,
        agentReadyTimeoutMs: deps.dispatchAgentReadyTimeoutMs,
        pollIntervalMs: deps.dispatchPollIntervalMs,
        sleep: deps.dispatchSleep,
        promptBody: prompt,
        workspacePath,
        model,
        allowedModels: deps.allowedModels,
        settleMs: deps.dispatchSettleMs,
        deliveryConfirmTimeoutMs: deps.dispatchDeliveryConfirmTimeoutMs,
      })
      // result includes promptDelivered: false when claude started fine but
      // we could not confirm it received the task prompt — the
      // frontend should surface that as a "please check the session" warning
      // rather than treating this as a dispatch failure (it's HTTP 200).
      return ok(c, result)
    })
  }
}

function grillOptions(deps: AppDependencies): GrillOptions {
  return {
    claudeBin: deps.claudeBin,
    allowedModels: deps.allowedModels,
    grillRoot: deps.grillRoot ?? grillRootFor(deps.dbPath),
    agentReadyTimeoutMs: deps.dispatchAgentReadyTimeoutMs,
    pollIntervalMs: deps.dispatchPollIntervalMs,
    sleep: deps.dispatchSleep,
    settleMs: deps.dispatchSettleMs,
    deliveryConfirmTimeoutMs: deps.dispatchDeliveryConfirmTimeoutMs,
    resultTimeoutMs: deps.grillResultTimeoutMs,
  }
}

// Grill: TODO を herdr 上の claude との対話で詰める(grillService.ts 参照)。
// セッションは dispatch と同じく herdr を使うので macOS 限定。
function grillTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      if (deps.platform !== 'darwin') {
        throw new BadRequestError(MACOS_ONLY_MESSAGE)
      }
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const result = await startGrill(deps.db, deps.herdr, id, grillOptions(deps))
      return ok(c, result)
    })
  }
}

function grilledTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      if (deps.platform !== 'darwin') {
        throw new BadRequestError(MACOS_ONLY_MESSAGE)
      }
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const todo = await finishGrill(deps.db, deps.herdr, id, grillOptions(deps))
      return ok(c, todo)
    })
  }
}

function openSessionHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      if (deps.platform !== 'darwin') {
        throw new BadRequestError(MACOS_ONLY_MESSAGE)
      }
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const todo = await openSession(deps.db, deps.herdr, id, {
        terminalApp: deps.terminalApp,
        exec: deps.exec,
      })
      return ok(c, todo)
    })
  }
}

export function createTodoSessionRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.post('/:id/dispatch', dispatchTodoHandler(deps))
  app.post('/:id/open-session', openSessionHandler(deps))
  app.post('/:id/grill', grillTodoHandler(deps))
  app.post('/:id/grilled', grilledTodoHandler(deps))

  return app
}
