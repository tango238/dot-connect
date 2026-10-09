import { expect, test } from 'bun:test'
import { createFakeHerdrClient, createTestApp } from './testApp'

// In-memory DB and fake Herdr only; never talks to the installed application.
test('API mutations notify an already-open UI without a Herdr session or reload', async () => {
  const { app } = createTestApp()
  const response = await app.request('/api/events')
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const next = async () => new TextDecoder().decode((await reader.read()).value)
  try {
    expect(await next()).toContain('event: change')
    const mutate = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method, headers: { origin: 'http://localhost:5757', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      expect(res.ok).toBe(true)
      expect(await next()).toContain('event: change')
      return (await res.json()) as any
    }
    const { data: todo } = await mutate('POST', '/api/todos', { title: 'fixture' })
    expect(todo.herdrPaneId).toBeNull()
    await mutate('POST', `/api/todos/${todo.id}/complete`)
    let rows = (await (await app.request('/api/todos')).json() as any).data
    expect(rows[0].status).toBe('done')
    await mutate('POST', `/api/todos/${todo.id}/reopen`)
    await mutate('PATCH', `/api/todos/${todo.id}`, { title: 'edited' })
    rows = (await (await app.request('/api/todos')).json() as any).data
    expect(rows[0]).toMatchObject({ title: 'edited', status: 'open' })
    await mutate('DELETE', `/api/todos/${todo.id}`)
    expect((await (await app.request('/api/todos')).json() as any).data).toEqual([])
  } finally { await reader.cancel() }
})

test('change stream is local UI only and rejects cross-origin requests', async () => {
  const { app } = createTestApp()
  expect((await app.request('/api/events', { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
  const remote = createTestApp({ isLoopback: false, apiToken: 'fixture-token' }).app
  expect((await remote.request('/api/events', { headers: { authorization: 'Bearer fixture-token' } })).status).toBe(403)
})

test('linked working session also notifies without closing its workspace', async () => {
  const herdr = createFakeHerdrClient()
  herdr.nextSnapshot = { panes: [{ paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', agentStatus: 'working' }] }
  const { app, deps } = createTestApp({ herdr })
  const created = await app.request('/api/todos', { method: 'POST', headers: {
    origin: 'http://localhost:5757', 'content-type': 'application/json',
  }, body: JSON.stringify({ title: 'linked fixture' }) })
  const id = (await created.json() as any).data.id
  deps.db.run("UPDATE todos SET herdr_workspace_id = 'w1', herdr_pane_id = 'w1:p1', session_state = 'working' WHERE id = ?", [id])
  const response = await app.request('/api/events')
  const reader = response.body!.getReader()
  try {
    await reader.read()
    const result = await app.request(`/api/todos/${id}`, { method: 'PATCH', headers: {
      origin: 'http://localhost:5757', 'content-type': 'application/json',
    }, body: JSON.stringify({ title: 'linked edited' }) })
    expect(result.ok).toBe(true)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: change')
    expect((await result.json() as any).data.title).toBe('linked edited')
    expect((await app.request(`/api/todos/${id}/complete`, { method: 'POST' })).ok).toBe(true)
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: change')
    expect(herdr.closeWorkspaceCalls).toEqual([])
  } finally { await reader.cancel() }
})

test('reconnecting sends a catch-up invalidation and rejected writes do not notify', async () => {
  const { app } = createTestApp()
  const response = await app.request('/api/events')
  const reader = response.body!.getReader()
  await reader.read()
  const pending = reader.read()
  const bad = await app.request('/api/todos', { method: 'POST', headers: {
    origin: 'http://localhost:5757', 'content-type': 'application/json',
  }, body: JSON.stringify({ title: '' }) })
  expect(bad.status).toBe(400)
  expect(await Promise.race([pending.then(() => 'event'), Bun.sleep(10).then(() => 'quiet')])).toBe('quiet')
  await reader.cancel()
  const reconnected = (await app.request('/api/events')).body!.getReader()
  try { expect(new TextDecoder().decode((await reconnected.read()).value)).toContain('event: change') }
  finally { await reconnected.cancel() }
})
