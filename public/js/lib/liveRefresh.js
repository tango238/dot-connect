// Coalesce invalidations, serialize reads, and recheck the form guard after
// every await. A form opened during a request must not lose its draft.
export function createLiveRefresh({ load, apply, isEditing, schedule = setTimeout, cancel = clearTimeout }) {
  let revision = 0
  let pending = false
  let running = false
  let stopped = false
  let timer = null
  let retryMs = 1000
  function queue(delay = 50) {
    if (stopped || running || timer !== null || !pending) return
    timer = schedule(() => { timer = null; void flush() }, delay)
  }
  async function flush() {
    if (stopped || !pending) return
    if (isEditing()) { queue(250); return }
    running = true
    pending = false
    const started = revision
    let delay = 250
    try {
      const snapshot = await load()
      retryMs = 1000
      if (stopped) return
      if (isEditing() || started !== revision) pending = true
      else apply(snapshot)
    } catch {
      pending = true // A transient failed GET must not lose the only event.
      delay = retryMs
      retryMs = Math.min(retryMs * 2, 30_000)
    } finally {
      running = false
      queue(delay)
    }
  }
  return {
    invalidate() { revision++; pending = true; queue() },
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null },
  }
}
