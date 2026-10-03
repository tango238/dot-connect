import type { Context } from 'hono'
import { Hono } from 'hono'
import * as milestoneRepo from '../db/milestoneRepo'
import * as todoRepo from '../db/todoRepo'
import { resolveUploadDir } from '../db/uploadDirLocation'
import { removeStoredFilesForTodo } from '../services/attachmentFiles'
import { assertAllowedModel } from '../services/modelValidation'
import { completeTodo } from '../services/todoCompletionService'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { createTodoSchema, idParamSchema, updateTodoSchema } from './schemas'
import { parseOrThrow } from './validation'

const MILESTONE_GONE_MESSAGE = 'そのマイルストーンは既に削除されています'

function milestoneExists(deps: AppDependencies, milestoneId: number | null | undefined): boolean {
  if (milestoneId === null || milestoneId === undefined) {
    return true
  }
  return milestoneRepo.getById(deps.db, milestoneId) !== null
}

function listTodosHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, todoRepo.listAll(deps.db)))
}

// undefined (not provided) and null (explicitly cleared) both skip the
// allowlist check — only an actual model name needs validating.
function checkModel(deps: AppDependencies, model: string | null | undefined): void {
  if (model !== undefined && model !== null) {
    assertAllowedModel(model, deps.allowedModels)
  }
}

function createTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const input = parseOrThrow(createTodoSchema, await c.req.json())
      if (!milestoneExists(deps, input.milestoneId)) {
        return fail(c, 404, MILESTONE_GONE_MESSAGE)
      }
      checkModel(deps, input.model)
      const todo = todoRepo.create(deps.db, input)
      return ok(c, todo, 201)
    })
  }
}

function updateTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const input = parseOrThrow(updateTodoSchema, await c.req.json())
      if (!milestoneExists(deps, input.milestoneId)) {
        return fail(c, 404, MILESTONE_GONE_MESSAGE)
      }
      checkModel(deps, input.model)
      const updated = todoRepo.update(deps.db, id, input)
      if (updated === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      return ok(c, updated)
    })
  }
}

function completeTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      // 完了と、その仕事のために開いた herdr ワークスペースの後片付けは
      // ひとつの操作。条件と失敗時の扱いは todoCompletionService を参照。
      const completed = await completeTodo(deps.db, deps.herdr, id)
      if (completed === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      return ok(c, completed)
    })
  }
}

function reopenTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const reopened = todoRepo.reopen(deps.db, id)
      if (reopened === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      return ok(c, reopened)
    })
  }
}

function deleteTodoHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      // Before the row goes: ON DELETE CASCADE clears todo_attachments but
      // not the files those rows name, and once they're gone nothing can.
      removeStoredFilesForTodo(deps.db, id, resolveUploadDir(deps.db, deps.dbPath).path)
      const removed = todoRepo.remove(deps.db, id)
      if (!removed) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      return ok(c, { removed: true })
    })
  }
}

export function createTodosRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', listTodosHandler(deps))
  app.post('/', createTodoHandler(deps))
  app.patch('/:id', updateTodoHandler(deps))
  app.post('/:id/complete', completeTodoHandler(deps))
  app.post('/:id/reopen', reopenTodoHandler(deps))
  app.delete('/:id', deleteTodoHandler(deps))

  return app
}
