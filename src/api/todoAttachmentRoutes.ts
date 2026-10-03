import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import { Hono } from 'hono'
import * as todoAttachmentRepo from '../db/todoAttachmentRepo'
import * as todoRepo from '../db/todoRepo'
import { resolveUploadDir } from '../db/uploadDirLocation'
import { logger } from '../logger'
import { removeStoredFile } from '../services/attachmentFiles'
import { buildStoredName } from '../services/attachmentStorage'
import type { TodoAttachment } from '../types'
import type { AppDependencies } from './dependencies'
import { fail, handle, ok } from './response'
import { idParamSchema, todoAttachmentParamsSchema } from './schemas'
import { parseOrThrow } from './validation'

// Both limits are enforced here and nowhere else that matters: the dialog's
// own gating is a courtesy to the user, not a defence — a request built by
// hand never goes near it.
const MAX_ATTACHMENTS_PER_TODO = 3
const MAX_FILE_MEGABYTES = 20
const MAX_FILE_BYTES = MAX_FILE_MEGABYTES * 1024 * 1024

const TOO_MANY_MESSAGE = `添付は${MAX_ATTACHMENTS_PER_TODO}件までです`
const TOO_LARGE_MESSAGE = `ファイルは${MAX_FILE_MEGABYTES}MBまでです`
const NO_FILE_MESSAGE = 'ファイルを選択してください'
const FIELD_NAME = 'file'

// Mounted under /todos for the same reason as todoPullRequestRoutes: an
// attachment only exists in the context of its todo, and every response here
// is the updated todo so the caller never has to re-fetch to redraw.
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

function uploadDirOf(deps: AppDependencies): string {
  return resolveUploadDir(deps.db, deps.dbPath).path
}

/**
 * Loads an attachment, but only if it belongs to the todo in the path. An id
 * that exists under some *other* todo is reported as not found rather than
 * acted on, so a wrong-but-valid id can't delete an unrelated todo's file.
 */
function findOwnedAttachment(deps: AppDependencies, todoId: number, attachmentId: number) {
  const attachment = todoAttachmentRepo.getById(deps.db, attachmentId, uploadDirOf(deps))
  return attachment !== null && attachment.todoId === todoId ? attachment : null
}

/**
 * The uploaded file, or null when the request carries none. A body that isn't
 * parseable as multipart at all (no body, wrong shape) lands here too: from
 * the caller's side that is the same mistake as omitting the field, and it
 * deserves the same 400 rather than a 500.
 */
async function readUploadedFile(c: Context): Promise<File | null> {
  try {
    const value = (await c.req.formData()).get(FIELD_NAME)
    return value instanceof File ? value : null
  } catch {
    return null
  }
}

/**
 * Registers the attachment, or returns null when the todo is already at the
 * cap. The count is re-checked *here* rather than trusted from before the
 * upload: two awaits (reading the body, writing the file) sit in between, and
 * the event loop is free to run other uploads for the same todo across them —
 * so without this, N concurrent requests all see the same pre-upload count and
 * all insert. Re-count and insert share one synchronous transaction, which
 * nothing can interleave with, so concurrent uploads serialise and the ones
 * past the cap lose.
 */
function registerAttachment(
  deps: AppDependencies,
  input: todoAttachmentRepo.CreateTodoAttachmentInput,
  uploadDir: string
): TodoAttachment | null {
  return deps.db.transaction(() => {
    if (todoAttachmentRepo.countByTodoId(deps.db, input.todoId) >= MAX_ATTACHMENTS_PER_TODO) {
      return null
    }
    return todoAttachmentRepo.create(deps.db, input, uploadDir)
  })()
}

// The order of the checks below is deliberate: everything that can reject the
// request is settled before anything touches the filesystem, so a rejected
// upload never leaves behind a file — though a 400 from the mkdir/write step
// itself can still leave behind an empty directory (mkdir succeeded, write
// didn't).
function uploadAttachmentHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id } = parseOrThrow(idParamSchema, c.req.param())
      if (todoRepo.getById(deps.db, id) === null) {
        return fail(c, 404, `Todo ${id} not found`)
      }
      // Cheap early rejection so an over-cap upload doesn't read a 20MB body
      // to no purpose. registerAttachment below is what actually enforces it.
      if (todoAttachmentRepo.countByTodoId(deps.db, id) >= MAX_ATTACHMENTS_PER_TODO) {
        return fail(c, 400, TOO_MANY_MESSAGE)
      }
      const file = await readUploadedFile(c)
      if (file === null) {
        return fail(c, 400, NO_FILE_MESSAGE)
      }
      if (file.size > MAX_FILE_BYTES) {
        return fail(c, 400, TOO_LARGE_MESSAGE)
      }

      const uploadDir = uploadDirOf(deps)
      const storedName = buildStoredName(file.name)
      const storedPath = join(uploadDir, storedName)
      try {
        // The configured directory existed when it was configured, but it can
        // have been moved or deleted since, and the default one has never
        // been created at all until the first upload.
        mkdirSync(uploadDir, { recursive: true })
        await Bun.write(storedPath, file)
      } catch (err) {
        // A read-only directory (or one replaced by a file) lets mkdirSync
        // succeed while Bun.write throws EACCES/ENOTDIR — surface that as a
        // 400 naming the directory rather than letting it fall through to a
        // generic 500 that gives the user no way to know what to fix. The
        // message names the directory either way, but it's only accurate for
        // EACCES-shaped failures; the log line is what keeps ENOSPC/EIO from
        // being silently mistaken for a permissions problem later. Bun.write
        // can fail after partially creating the file (ENOSPC, EDQUOT, EIO on
        // a network mount), so clean that up too — removeStoredFile is a
        // no-op when nothing was written.
        removeStoredFile(storedPath)
        logger.warn('Failed to write attachment file', {
          uploadDir,
          message: err instanceof Error ? err.message : String(err),
        })
        return fail(c, 400, `アップロード先フォルダに書き込めません: ${uploadDir}`)
      }

      let registered: TodoAttachment | null
      try {
        registered = registerAttachment(
          deps,
          { todoId: id, storedName, originalName: file.name, sizeBytes: file.size },
          uploadDir
        )
      } catch (err) {
        // The file exists but nothing references it — take it back out before
        // rethrowing, or it stays on disk with no row that could ever delete it.
        removeStoredFile(storedPath)
        throw err
      }
      if (registered === null) {
        // Lost the race for the last slot. Same cleanup: the bytes are on disk
        // but no row will ever name them.
        removeStoredFile(storedPath)
        return fail(c, 400, TOO_MANY_MESSAGE)
      }
      return respondWithTodo(c, deps, id, 201)
    })
  }
}

function removeAttachmentHandler(deps: AppDependencies) {
  return async (c: Context) => {
    return handle(c, async () => {
      const { id, attachmentId } = parseOrThrow(todoAttachmentParamsSchema, c.req.param())
      const attachment = findOwnedAttachment(deps, id, attachmentId)
      if (attachment === null) {
        return fail(c, 404, `Attachment ${attachmentId} not found`)
      }
      // File first: the row is what tells us the path, so a failure here still
      // leaves something to retry with. removeStoredFile never throws, so a
      // file that refuses to go doesn't strand the row the user wanted gone.
      removeStoredFile(attachment.path)
      todoAttachmentRepo.remove(deps.db, attachmentId)
      return respondWithTodo(c, deps, id)
    })
  }
}

export function createTodoAttachmentRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.post('/:id/attachments', uploadAttachmentHandler(deps))
  app.delete('/:id/attachments/:attachmentId', removeAttachmentHandler(deps))

  return app
}
