import type { Context } from 'hono'
import { HerdrCommandError } from '../herdr/herdrClient'
import { logger } from '../logger'
import { BadRequestError, ConflictError, NotFoundError } from '../services/errors'
import { ValidationError } from './validation'

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  return c.json({ success: true, data }, status)
}

export function fail(
  c: Context,
  status: 400 | 404 | 409 | 500 | 502,
  error: string,
  extra?: Record<string, unknown>
): Response {
  return c.json({ success: false, error, ...(extra ?? {}) }, status)
}

export async function handle(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ValidationError || err instanceof BadRequestError) {
      return fail(c, 400, err.message)
    }
    if (err instanceof NotFoundError) {
      return fail(c, 404, err.message)
    }
    if (err instanceof ConflictError) {
      return fail(c, 409, err.message, err.data)
    }
    if (err instanceof SyntaxError) {
      return fail(c, 400, 'Malformed JSON body')
    }
    if (err instanceof HerdrCommandError) {
      // Distinguishable from a generic server error so the UI can tell the
      // user this was herdr's fault, not dot-connect's, and show why.
      logger.error('herdr command failed', { message: err.message })
      return fail(c, 502, `herdrコマンドに失敗しました: ${err.message}`)
    }
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Unhandled route error', { message })
    return fail(c, 500, 'Internal server error')
  }
}
