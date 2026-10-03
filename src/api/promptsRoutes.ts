import type { Context } from 'hono'
import { Hono } from 'hono'
import * as promptHistoryRepo from '../db/promptHistoryRepo'
import * as promptSnippetRepo from '../db/promptSnippetRepo'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { createPromptSnippetSchema, idParamSchema, updatePromptSnippetSchema } from './schemas'
import { parseOrThrow } from './validation'

function listHistoryHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, promptHistoryRepo.listAll(deps.db)))
}

function deleteHistoryHandler(deps: AppDependencies) {
  return (c: Context) => {
    return handle(c, async () => {
      const removed = promptHistoryRepo.removeAll(deps.db)
      return ok(c, { removed })
    })
  }
}

function listSnippetsHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, promptSnippetRepo.listAll(deps.db)))
}

function createSnippetHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const input = parseOrThrow(createPromptSnippetSchema, await c.req.json())
      const snippet = promptSnippetRepo.create(deps.db, input)
      return ok(c, snippet, 201)
    })
  }
}

function updateSnippetHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const input = parseOrThrow(updatePromptSnippetSchema, await c.req.json())
      const updated = promptSnippetRepo.update(deps.db, id, input)
      if (updated === null) {
        return fail(c, 404, `Prompt snippet ${id} not found`)
      }
      return ok(c, updated)
    })
  }
}

function deleteSnippetHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const removed = promptSnippetRepo.remove(deps.db, id)
      if (!removed) {
        return fail(c, 404, `Prompt snippet ${id} not found`)
      }
      return ok(c, { removed: true })
    })
  }
}

export function createPromptsRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/history', listHistoryHandler(deps))
  app.delete('/history', deleteHistoryHandler(deps))

  app.get('/snippets', listSnippetsHandler(deps))
  app.post('/snippets', createSnippetHandler(deps))
  app.patch('/snippets/:id', updateSnippetHandler(deps))
  app.delete('/snippets/:id', deleteSnippetHandler(deps))

  return app
}
