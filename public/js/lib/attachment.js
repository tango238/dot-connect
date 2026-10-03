// Pure display logic for attachments: no DOM, no state access, so it can be
// unit-tested like the other modules under lib/.

// Maximum number of attachments allowed per TODO
const MAX_ATTACHMENTS = 3

/**
 * Format file size in bytes to a human-readable string with appropriate units.
 * Uses 1024 as the divisor (binary units). Bytes shown with no decimals;
 * KB and MB shown with 1 decimal place.
 *
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted size like "820 B", "12.4 KB", or "3.5 MB"
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Whether the attachment limit has been reached for this TODO.
 *
 * @param {object} todo - The TODO object (may lack attachments property)
 * @returns {boolean} True if the TODO has 3 or more attachments
 */
export function attachmentLimitReached(todo) {
  const count = todo.attachments?.length ?? 0
  return count >= MAX_ATTACHMENTS
}

/**
 * Get the reason why uploads are disabled for this TODO, or null if uploads
 * are still allowed.
 *
 * @param {object} todo - The TODO object (may lack attachments property)
 * @returns {string | null} Reason string if limit is reached, null otherwise
 */
export function uploadDisabledReason(todo) {
  if (attachmentLimitReached(todo)) {
    return `最大${MAX_ATTACHMENTS}個まで添付できます`
  }
  return null
}

/**
 * Append attachment file paths to a prompt body, building the result as a
 * single line with no newlines. This is crucial because the dispatch pipeline
 * flattens newlines to spaces during submission; building the single-line form
 * up front ensures the dialog's preview matches what is actually sent to the server.
 *
 * Each path is individually quoted: the default upload directory sits under
 * "Application Support", and any user-chosen folder can contain spaces too,
 * so an unquoted join would make paths indistinguishable from each other.
 * Stored names are UUID-based and can never contain a quote themselves.
 *
 * @param {string} promptBody - The original prompt/TODO text
 * @param {string[]} paths - Array of file paths to append (empty = no change)
 * @returns {string} The prompt body, optionally with "添付ファイル: ..." appended
 */
export function appendAttachmentPaths(promptBody, paths) {
  if (paths.length === 0) {
    return promptBody
  }

  const pathsStr = paths.map((p) => `"${p}"`).join(' ')
  const attachmentLine = `添付ファイル: ${pathsStr}`

  if (promptBody === '') {
    return attachmentLine
  }

  return `${promptBody} ${attachmentLine}`
}
