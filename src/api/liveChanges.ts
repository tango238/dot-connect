import type { Handler, MiddlewareHandler } from 'hono'
import type { AppDependencies } from './dependencies'

// One feed per API instance/database. Only invalidations cross the stream;
// clients reload through the existing validated read endpoints.
export function createLiveChanges(deps: AppDependencies): { events: Handler; mutations: MiddlewareHandler } {
  const listeners = new Set<() => void>()
  const changes = () => (deps.db.query('SELECT total_changes() AS n').get() as { n: number }).n
  return {
    mutations: async (c, next) => {
      if (!['POST', 'PATCH', 'DELETE'].includes(c.req.method)) return next()
      const before = changes()
      try { await next() } finally {
        // Also invalidate if an operation wrote before returning an error.
        // Concurrent requests can cause a harmless extra invalidation.
        if (changes() !== before) for (const notify of listeners) notify()
      }
    },
    events: (c) => {
      const origin = c.req.header('origin')
      const allowed = [`http://localhost:${deps.port}`, `http://127.0.0.1:${deps.port}`]
      if (!deps.isLoopback || (origin !== undefined && !allowed.includes(origin)) ||
          ['cross-site', 'same-site'].includes(c.req.header('sec-fetch-site') ?? '')) {
        return c.json({ success: false, error: 'Local same-origin UI only' }, 403)
      }
      const encoder = new TextEncoder()
      let cleanup = () => {}
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false
          const send = (message: string) => {
            if (closed) return
            try { controller.enqueue(encoder.encode(message)) } catch { cleanup() }
          }
          const notify = () => send('event: change\ndata: {}\n\n')
          const heartbeat = setInterval(() => send(': keepalive\n\n'), 25_000)
          cleanup = () => {
            if (closed) return
            closed = true
            clearInterval(heartbeat)
            listeners.delete(notify)
            c.req.raw.signal.removeEventListener('abort', cleanup)
            try { controller.close() } catch { /* already cancelled */ }
          }
          listeners.add(notify)
          c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
          if (c.req.raw.signal.aborted) cleanup()
          else notify() // Initial/reconnected clients catch up after missed events.
        },
        cancel() { cleanup() },
      })
      return new Response(body, { headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      } })
    },
  }
}
