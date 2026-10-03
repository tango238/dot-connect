import type { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import * as todoAttachmentRepo from '../db/todoAttachmentRepo'
import { logger } from '../logger'

/**
 * Deletes one stored file, never throwing. Every caller is part-way through a
 * database deletion that has to go through regardless: a file that can't be
 * removed (permissions, the upload dir moved out from under us) costs some
 * bytes on disk, whereas aborting would leave a row pointing at a file the
 * user just asked to be rid of. `force` covers the already-gone case, which
 * is not worth a log line.
 */
export function removeStoredFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (err) {
    logger.warn('Failed to delete attachment file', {
      path,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Deletes the files of every attachment on a todo. Must be called *before*
 * the todo row goes away: `ON DELETE CASCADE` removes the todo_attachments
 * rows but knows nothing about the disk, so once the rows are gone there is
 * nothing left naming the files and they are orphaned forever.
 *
 * Takes the resolved upload dir rather than resolving its own, so it deletes
 * from exactly the directory the routes uploaded into. Resolving twice by
 * different routes (deps.dbPath here, db.filename there) would agree in
 * production but can diverge in a harness — and `rmSync(force)` would then
 * miss silently, which is the orphan this function exists to prevent.
 */
export function removeStoredFilesForTodo(db: Database, todoId: number, uploadDir: string): void {
  for (const attachment of todoAttachmentRepo.listByTodoId(db, todoId, uploadDir)) {
    removeStoredFile(attachment.path)
  }
}
