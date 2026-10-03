import type { Context } from 'hono'
import { Hono } from 'hono'
import * as workspacePathHistoryRepo from '../db/workspacePathHistoryRepo'
import * as workspaceRepo from '../db/workspaceRepo'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { createWorkspaceSchema, idParamSchema, updateWorkspaceSchema } from './schemas'
import { parseOrThrow } from './validation'

function listWorkspacesHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, workspaceRepo.listAll(deps.db)))
}

function createWorkspaceHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const input = parseOrThrow(createWorkspaceSchema, await c.req.json())
      const workspace = workspaceRepo.create(deps.db, input)
      return ok(c, workspace, 201)
    })
  }
}

function updateWorkspaceHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const input = parseOrThrow(updateWorkspaceSchema, await c.req.json())
      const updated = workspaceRepo.update(deps.db, id, input)
      if (updated === null) {
        return fail(c, 404, `Workspace ${id} not found`)
      }
      return ok(c, updated)
    })
  }
}

function deleteWorkspaceHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const removed = workspaceRepo.remove(deps.db, id)
      if (!removed) {
        return fail(c, 404, `Workspace ${id} not found`)
      }
      return ok(c, { removed: true })
    })
  }
}

function listHistoryHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, workspacePathHistoryRepo.listAll(deps.db)))
}

function clearHistoryHandler(deps: AppDependencies) {
  return (c: Context) =>
    handle(c, async () => ok(c, { removed: workspacePathHistoryRepo.removeAll(deps.db) }))
}

export function createWorkspacesRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', listWorkspacesHandler(deps))
  app.post('/', createWorkspaceHandler(deps))
  // Registered before '/:id' so "history" is matched as a literal path
  // segment rather than being coerced (and rejected) as a workspace id —
  // same ordering promptsRoutes.ts relies on.
  app.get('/history', listHistoryHandler(deps))
  app.delete('/history', clearHistoryHandler(deps))
  app.patch('/:id', updateWorkspaceHandler(deps))
  app.delete('/:id', deleteWorkspaceHandler(deps))

  return app
}
