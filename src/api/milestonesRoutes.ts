import type { Context } from 'hono'
import { Hono } from 'hono'
import * as labelRepo from '../db/labelRepo'
import * as milestoneRepo from '../db/milestoneRepo'
import type { UpdateMilestoneInput } from '../db/milestoneRepo'
import type { Milestone } from '../types'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { createMilestoneSchema, idParamSchema, updateMilestoneSchema } from './schemas'
import { parseOrThrow, ValidationError } from './validation'

const LABEL_GONE_MESSAGE = 'そのラベルは存在しません'

function assertDateOrderAgainstExisting(existing: Milestone, input: UpdateMilestoneInput): void {
  const startDate = input.startDate ?? existing.startDate
  const targetDate = input.targetDate ?? existing.targetDate
  if (targetDate < startDate) {
    throw new ValidationError('targetDate: targetDate must be on or after startDate')
  }
}

function labelExists(deps: AppDependencies, labelId: number | null | undefined): boolean {
  if (labelId === null || labelId === undefined) {
    return true
  }
  return labelRepo.getById(deps.db, labelId) !== null
}

function listMilestonesHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, milestoneRepo.listAll(deps.db)))
}

function createMilestoneHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const input = parseOrThrow(createMilestoneSchema, await c.req.json())
      if (!labelExists(deps, input.labelId)) {
        return fail(c, 404, LABEL_GONE_MESSAGE)
      }
      const milestone = milestoneRepo.create(deps.db, input)
      return ok(c, milestone, 201)
    })
  }
}

function updateMilestoneHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const input = parseOrThrow(updateMilestoneSchema, await c.req.json())
      const existing = milestoneRepo.getById(deps.db, id)
      if (existing === null) {
        return fail(c, 404, `Milestone ${id} not found`)
      }
      if (!labelExists(deps, input.labelId)) {
        return fail(c, 404, LABEL_GONE_MESSAGE)
      }
      assertDateOrderAgainstExisting(existing, input)
      const updated = milestoneRepo.update(deps.db, id, input)
      return ok(c, updated)
    })
  }
}

function completeMilestoneHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      if (milestoneRepo.getById(deps.db, id) === null) {
        return fail(c, 404, `Milestone ${id} not found`)
      }
      const remaining = milestoneRepo.countOpenTodos(deps.db, id)
      if (remaining > 0) {
        return fail(c, 409, `Milestone ${id} has unfinished todos`, { remaining })
      }
      const completed = milestoneRepo.complete(deps.db, id)
      return ok(c, completed)
    })
  }
}

function reopenMilestoneHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const reopened = milestoneRepo.reopen(deps.db, id)
      if (reopened === null) {
        return fail(c, 404, `Milestone ${id} not found`)
      }
      return ok(c, reopened)
    })
  }
}

function deleteMilestoneHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const result = milestoneRepo.remove(deps.db, id)
      if (!result.removed) {
        return fail(c, 404, `Milestone ${id} not found`)
      }
      return ok(c, result)
    })
  }
}

export function createMilestonesRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', listMilestonesHandler(deps))
  app.post('/', createMilestoneHandler(deps))
  app.patch('/:id', updateMilestoneHandler(deps))
  app.post('/:id/complete', completeMilestoneHandler(deps))
  app.post('/:id/reopen', reopenMilestoneHandler(deps))
  app.delete('/:id', deleteMilestoneHandler(deps))

  return app
}
