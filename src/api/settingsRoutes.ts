import type { Context } from 'hono'
import { Hono } from 'hono'
import * as appSettingsRepo from '../db/appSettingsRepo'
import { IDLE_RECAP_MINUTES_KEY, resolveIdleRecapMinutes } from '../services/idleRecapService'
import { UPLOAD_DIR_KEY, resolveUploadDir, validateUploadDir } from '../services/uploadDirService'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { updateSettingsSchema } from './schemas'
import { parseOrThrow } from './validation'

interface SettingsResponse {
  uploadDir: string
  uploadDirIsDefault: boolean
  idleRecapMinutes: number
}

function settingsResponse(deps: AppDependencies): SettingsResponse {
  const { path, isDefault } = resolveUploadDir(deps.db, deps.dbPath)
  return {
    uploadDir: path,
    uploadDirIsDefault: isDefault,
    idleRecapMinutes: resolveIdleRecapMinutes(deps.db),
  }
}

function getSettingsHandler(deps: AppDependencies) {
  return (c: Context) => handle(c, async () => ok(c, settingsResponse(deps)))
}

function updateSettingsHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { uploadDir, idleRecapMinutes } = parseOrThrow(updateSettingsSchema, await c.req.json())
      // 両方来たら先に検証を済ませてから書く —— 片方だけ保存されて 400 が返る
      // 中途半端な状態を避ける。
      if (uploadDir !== undefined) {
        const validationError = validateUploadDir(uploadDir)
        if (validationError !== null) {
          return fail(c, 400, validationError)
        }
      }
      if (uploadDir !== undefined) {
        appSettingsRepo.set(deps.db, UPLOAD_DIR_KEY, uploadDir)
      }
      if (idleRecapMinutes !== undefined) {
        appSettingsRepo.set(deps.db, IDLE_RECAP_MINUTES_KEY, String(idleRecapMinutes))
      }
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
