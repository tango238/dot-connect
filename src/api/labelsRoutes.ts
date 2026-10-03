import type { Context } from 'hono'
import { Hono } from 'hono'
import * as labelRepo from '../db/labelRepo'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { createLabelSchema, idParamSchema, updateLabelSchema } from './schemas'
import { parseOrThrow } from './validation'

function listLabelsHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, labelRepo.listAll(deps.db)))
}

function createLabelHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const input = parseOrThrow(createLabelSchema, await c.req.json())
      const label = labelRepo.create(deps.db, input)
      return ok(c, label, 201)
    })
  }
}

function updateLabelHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const input = parseOrThrow(updateLabelSchema, await c.req.json())
      const updated = labelRepo.update(deps.db, id, input)
      if (updated === null) {
        return fail(c, 404, `Label ${id} not found`)
      }
      return ok(c, updated)
    })
  }
}

function deleteLabelHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const result = labelRepo.remove(deps.db, id)
      if (!result.removed) {
        return fail(c, 404, `Label ${id} not found`)
      }
      return ok(c, result)
    })
  }
}

export function createLabelsRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', listLabelsHandler(deps))
  app.post('/', createLabelHandler(deps))
  app.patch('/:id', updateLabelHandler(deps))
  app.delete('/:id', deleteLabelHandler(deps))

  return app
}
