import type { Context } from 'hono'
import { Hono } from 'hono'
import * as todoPullRequestRepo from '../db/todoPullRequestRepo'
import * as todoRepo from '../db/todoRepo'
import { createFetchPullRequest, type FetchPullRequest } from '../services/githubPrService'
import { parsePullRequestUrl } from '../services/pullRequestUrl'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { addPullRequestSchema, idParamSchema, todoPullRequestParamsSchema } from './schemas'
import { parseOrThrow } from './validation'

const INVALID_URL_MESSAGE =
  'GitHubのPull RequestのURLを指定してください (例: https://github.com/owner/repo/pull/123)'

// Mounted under /todos alongside todosRoutes/todoSessionRoutes rather than
// as its own top-level resource: a PR link only exists in the context of the
// todo it belongs to, and every response here is the updated todo (see
// respondWithTodo below).
function respondWithTodo(c: Context, deps: AppDependencies, todoId: number): Response {
  const todo = todoRepo.getById(deps.db, todoId)
  if (todo === null) {
    return fail(c, 404, `Todo ${todoId} not found`)
  }
  return ok(c, todo)
}

/**
 * Loads a PR link, but only if it belongs to the todo in the path. A PR id
 * that exists under some *other* todo is reported as not found rather than
 * being acted on, so a wrong-but-valid id can't delete or refresh a link on
 * an unrelated todo.
 */
function findOwnedPullRequest(deps: AppDependencies, todoId: number, prId: number) {
  const pullRequest = todoPullRequestRepo.getById(deps.db, prId)
  return pullRequest !== null && pullRequest.todoId === todoId ? pullRequest : null
}

// Applies a fetch result to a stored link. A failure is recorded, never
// propagated: the link itself is still valid and worth keeping, and the
// stored reason is what the UI shows in place of a title.
async function applyFetch(
  deps: AppDependencies,
  fetchPullRequest: FetchPullRequest,
  prId: number,
  url: string
): Promise<void> {
  const result = await fetchPullRequest(url)
  if (result.ok) {
    todoPullRequestRepo.recordFetchSuccess(deps.db, prId, result.snapshot)
  } else {
    todoPullRequestRepo.recordFetchError(deps.db, prId, result.error)
  }
}

function addPullRequestHandler(deps: AppDependencies, fetchPullRequest: FetchPullRequest) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      const { url } = parseOrThrow(addPullRequestSchema, await c.req.json())
      if (todoRepo.getById(deps.db, id) === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      const parsed = parsePullRequestUrl(url)
      if (parsed === null) {
        return fail(c, 400, INVALID_URL_MESSAGE)
      }
      // Throws ConflictError (409) if this PR is already linked here.
      const created = todoPullRequestRepo.create(deps.db, { todoId: id, ...parsed })
      await applyFetch(deps, fetchPullRequest, created.id, created.url)
      const todo = todoRepo.getById(deps.db, id)
      if (todo === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      return ok(c, todo, 201)
    })
  }
}

function refreshPullRequestHandler(deps: AppDependencies, fetchPullRequest: FetchPullRequest) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id, prId } = parseOrThrow(todoPullRequestParamsSchema, c.req.param())
      const pullRequest = findOwnedPullRequest(deps, id, prId)
      if (pullRequest === null) {
        return fail(c, 404, `Pull request ${prId} not found`)
      }
      await applyFetch(deps, fetchPullRequest, pullRequest.id, pullRequest.url)
      return respondWithTodo(c, deps, id)
    })
  }
}

function removePullRequestHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id, prId } = parseOrThrow(todoPullRequestParamsSchema, c.req.param())
      if (findOwnedPullRequest(deps, id, prId) === null) {
        return fail(c, 404, `Pull request ${prId} not found`)
      }
      todoPullRequestRepo.remove(deps.db, prId)
      return respondWithTodo(c, deps, id)
    })
  }
}

export function createTodoPullRequestRoutes(deps: AppDependencies): Hono {
  const app = new Hono()
  const fetchPullRequest = createFetchPullRequest(deps.exec, deps.ghBin)

  app.post('/:id/pull-requests', addPullRequestHandler(deps, fetchPullRequest))
  app.post('/:id/pull-requests/:prId/refresh', refreshPullRequestHandler(deps, fetchPullRequest))
  app.delete('/:id/pull-requests/:prId', removePullRequestHandler(deps))

  return app
}
