import type { Context } from 'hono'
import { Hono } from 'hono'
import * as milestoneRepo from '../db/milestoneRepo'
import * as todoRepo from '../db/todoRepo'
import type { Todo } from '../types'
import { BadRequestError } from '../services/errors'
import { createFetchIssue, createListIssues, DEFAULT_LIST_LIMIT } from '../services/githubIssueService'
import type { FetchIssue, ListIssues } from '../services/githubIssueService'
import { parseRepoSpec } from '../services/githubRepo'
import { buildIssueTodoInput } from '../services/issueTodo'
import { assertAllowedModel } from '../services/modelValidation'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { importGithubIssuesSchema, listGithubIssuesQuerySchema } from './schemas'
import { parseOrThrow } from './validation'

// GitHub Issue → TODO. Browser-UI only: neither endpoint is in
// apiTokenAuth.ts's allowlist. The list is read-only; the import creates
// TODOs, which a token could already do through POST /api/todos, but it
// also makes gh reach out to GitHub on the server's behalf, so it stays
// behind the same-origin flow.

const INVALID_REPO_MESSAGE =
  'リポジトリは "owner/repo" か GitHub の URL(https://github.com/owner/repo)で指定してください'

function parseRepoOrThrow(raw: string): string {
  const parsed = parseRepoSpec(raw)
  if (parsed === null) {
    throw new BadRequestError(INVALID_REPO_MESSAGE)
  }
  return parsed.nameWithOwner
}

function listHandler(listIssues: ListIssues) {
  return (c: Context) =>
    handle(c, async () => {
      const query = parseOrThrow(listGithubIssuesQuerySchema, c.req.query())
      const repo = parseRepoOrThrow(query.repo)
      const result = await listIssues(repo, {
        state: query.state ?? 'open',
        limit: query.limit ?? DEFAULT_LIST_LIMIT,
        search: query.search,
      })
      if (!result.ok) {
        // gh's own reason ("not logged in", "could not resolve to a
        // Repository", …) is the useful part, so it is passed through.
        return fail(c, 502, `GitHub Issue の取得に失敗しました: ${result.error}`, { code: 'gh_failed' })
      }
      return ok(c, { repo, issues: result.issues })
    })
}

export interface ImportFailure {
  readonly number: number
  readonly error: string
}

function importHandler(deps: AppDependencies, fetchIssue: FetchIssue) {
  return (c: Context) =>
    handle(c, async () => {
      const input = parseOrThrow(importGithubIssuesSchema, await c.req.json())
      const repo = parseRepoOrThrow(input.repo)
      if (input.milestoneId !== null && input.milestoneId !== undefined) {
        if (milestoneRepo.getById(deps.db, input.milestoneId) === null) {
          return fail(c, 404, 'そのマイルストーンは既に削除されています')
        }
      }
      if (input.model !== undefined && input.model !== null) {
        assertAllowedModel(input.model, deps.allowedModels)
      }

      // 1件の失敗で残りを止めない(refresh-stale と同じ)。取り込めた分は
      // 取り込み、失敗は番号と理由を添えて返す。
      const created: Todo[] = []
      const failed: ImportFailure[] = []
      for (const number of input.numbers) {
        const result = await fetchIssue(repo, number)
        if (!result.ok) {
          failed.push({ number, error: result.error })
          continue
        }
        const todo = todoRepo.create(
          deps.db,
          buildIssueTodoInput(result.issue, {
            milestoneId: input.milestoneId,
            priority: input.priority,
            workspacePath: input.workspacePath,
            model: input.model,
          })
        )
        created.push(todo)
      }
      return ok(c, { repo, created, failed }, created.length > 0 ? 201 : 200)
    })
}

export function createGithubIssuesRoutes(deps: AppDependencies): Hono {
  const app = new Hono()
  app.get('/', listHandler(createListIssues(deps.exec, deps.ghBin)))
  app.post('/import', importHandler(deps, createFetchIssue(deps.exec, deps.ghBin)))
  return app
}
