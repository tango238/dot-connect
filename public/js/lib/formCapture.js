// Pure predicate for whether a captured inline-form snapshot should still
// be restored after an async refresh completes (F49).
//
// Some user-triggered refreshes (e.g. closing the label manager) rebuild
// the whole page from state, which would otherwise wipe out text the user
// is mid-typing into an open inline form. The fix is to snapshot the open
// form's values before the refresh and write them back after — but only if
// the *same* form is still open when the refresh resolves. If the user
// closed it (or switched to editing something else) while the request was
// in flight, restoring the stale snapshot would just resurrect a form they
// already dismissed, or clobber a different one they opened instead.

/**
 * @param {{ id: number } | null} captured snapshot taken before the async
 *   refresh, or null if nothing was open to capture
 * @param {number | null} currentOpenId whichever form (if any) is open now
 */
export function shouldRestoreCapturedForm(captured, currentOpenId) {
  return captured !== null && captured.id === currentOpenId
}
