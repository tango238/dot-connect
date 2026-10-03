// Pure predicate for whether the polling loop should sync with herdr —
// shared by main.js's pollTick and its tests.

/**
 * A todo still needs polling as long as it's linked to a herdr pane and not
 * yet done — regardless of its current sessionState. herdr is the only
 * source of truth for pane state transitions (e.g. blocked -> working), so
 * gating on sessionState === 'working' alone self-locks: once every pane
 * settles to 'blocked' or 'idle', nothing ever polls again to discover a
 * pane went back to 'working' (see f2d45ae's original — buggy — wiring).
 *
 * @param {{ herdrPaneId: string|null, status: 'open'|'done' }[]} todos
 */
export function hasLinkedSession(todos) {
  return todos.some((t) => t.herdrPaneId !== null && t.status !== 'done')
}
