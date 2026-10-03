import type { Context } from 'hono'
import { Hono } from 'hono'
import * as todoCommentRepo from '../db/todoCommentRepo'
import * as todoRepo from '../db/todoRepo'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { addCommentSchema, idParamSchema, todoCommentParamsSchema } from './schemas'
import { parseOrThrow } from './validation'

// Mounted under /todos for the same reason as todoPullRequestRoutes and
// todoAttachmentRoutes: a comment only exists in the context of its todo,
// and every response here is the updated todo so the dialog redraws from it
// without a second fetch.
function respondWithTodo(
  c: Context,
  deps: AppDependencies,
  todoId: number,
  status: 200 | 201 = 200
): Response {
  const todo = todoRepo.getById(deps.db, todoId)
  if (todo === null) {
    return fail(c, 404, `Todo ${todoId} not found`)
  }
  return ok(c, todo, status)
}

/**
 * Loads a comment, but only if it belongs to the todo in the path. An id that
 * exists under some *other* todo is reported as not found rather than acted
 * on, so a wrong-but-valid id can't delete an unrelated todo's log entry.
 */
function findOwnedComment(deps: AppDependencies, todoId: number, commentId: number) {
  const comment = todoCommentRepo.getById(deps.db, commentId)
  return comment !== null && comment.todoId === todoId ? comment : null
}

function addCommentHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const { body } = parseOrThrow(addCommentSchema, await c.req.json())
      if (todoRepo.getById(deps.db, id) === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      todoCommentRepo.create(deps.db, { todoId: id, body })
      return respondWithTodo(c, deps, id, 201)
    })
  }
}

function removeCommentHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id, commentId } = parseOrThrow(todoCommentParamsSchema, c.req.param())
      if (findOwnedComment(deps, id, commentId) === null) {
        return fail(c, 404, `Comment ${commentId} not found`)
      }
      todoCommentRepo.remove(deps.db, commentId)
      return respondWithTodo(c, deps, id)
    })
  }
}

export function createTodoCommentRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.post('/:id/comments', addCommentHandler(deps))
  app.delete('/:id/comments/:commentId', removeCommentHandler(deps))

  return app
}
