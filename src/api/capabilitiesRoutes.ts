import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppDependencies } from './dependencies'
import { handle, ok } from './response'

// Read-only: lets the frontend grey out herdr-dependent features (dispatch,
// session focus) on environments where they can't work — e.g. the Windows
// build of the Tauri desktop shell, which has no herdr binary at all — without
// duplicating the platform/`which` detection logic client-side.
function getCapabilitiesHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, await deps.capabilities()))
}

export function createCapabilitiesRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', getCapabilitiesHandler(deps))

  return app
}
