// Pure predicate for the dispatch endpoint's success-response flag.
//
// POST /api/todos/:id/dispatch returns HTTP 200 with { ...Todo,
// promptDelivered }. `promptDelivered: false` means claude started and the
// session is usable, but the server couldn't confirm the prompt actually
// reached the pane (it already retried once) — worth a warning toast
// instead of the plain success one, even though this isn't an error
// response at all.

/** @param {{ promptDelivered?: boolean } | null | undefined} dispatchResult */
export function shouldWarnAboutDelivery(dispatchResult) {
  return dispatchResult?.promptDelivered === false
}
