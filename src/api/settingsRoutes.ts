import type { Context } from 'hono'
import { Hono } from 'hono'
import * as appSettingsRepo from '../db/appSettingsRepo'
import { UPLOAD_DIR_KEY, resolveUploadDir, validateUploadDir } from '../services/uploadDirService'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { updateSettingsSchema } from './schemas'
import { parseOrThrow } from './validation'

function settingsResponse(deps: AppDependencies): { uploadDir: string; uploadDirIsDefault: boolean } {
  const { path, isDefault } = resolveUploadDir(deps.db, deps.dbPath)
  return { uploadDir: path, uploadDirIsDefault: isDefault }
}

function getSettingsHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, settingsResponse(deps)))
}

function updateSettingsHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { uploadDir } = parseOrThrow(updateSettingsSchema, await c.req.json())
      const validationError = validateUploadDir(uploadDir)
      if (validationError !== null) {
        return fail(c, 400, validationError)
      }
      appSettingsRepo.set(deps.db, UPLOAD_DIR_KEY, uploadDir)
      return ok(c, settingsResponse(deps))
    })
  }
}

export function createSettingsRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.get('/', getSettingsHandler(deps))
  app.patch('/', updateSettingsHandler(deps))

  return app
}
