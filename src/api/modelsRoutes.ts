import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppDependencies } from './dependencies'
import { handle, ok } from './response'

// Read-only: the frontend uses this to populate the model <select> shown
// alongside a TODO's workspace picker, without duplicating the allowlist
// (deps.allowedModels — see modelValidation.ts / DOT_CONNECT_ALLOWED_MODELS)
// on the client. No mutation here, so it carries the same auth policy as
// every other GET (see apiTokenAuth.ts's allowlist for the token case).
function listModelsHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, deps.allowedModels))
}

export function createModelsRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', listModelsHandler(deps))

  return app
}
