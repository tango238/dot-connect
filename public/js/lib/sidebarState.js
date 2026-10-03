// Pure persistence logic for the sidebar collapsed/expanded toggle.
//
// Takes a storage-like object ({ getItem, setItem }) rather than reaching
// for window.localStorage directly, so this is testable without a DOM/
// browser environment. index.html also has a tiny inline <script> that
// reads the same key directly (see the comment there) to apply the
// collapsed class before first paint and avoid a flash of the expanded
// sidebar — that key must be kept in sync with this one by hand.

export const SIDEBAR_STORAGE_KEY = 'dc.sidebarCollapsed'

/** Anything other than the exact persisted "1" reads as expanded (the
 * default) — a missing key (first visit), a cleared key, or a corrupted
 * value should never accidentally collapse the sidebar on the user. */
export function isSidebarCollapsed(storage) {
  return storage.getItem(SIDEBAR_STORAGE_KEY) === '1'
}

export function persistSidebarCollapsed(storage, collapsed) {
  storage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0')
}
