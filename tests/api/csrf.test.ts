import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { csrfProtection } from '../../src/api/csrf'

function buildApp(port: number): Hono {
  const app = new Hono()
  app.use('*', csrfProtection(port))
  app.get('/x', (c) => c.json({ ok: true }))
  app.post('/x', (c) => c.json({ ok: true }))
  app.patch('/x', (c) => c.json({ ok: true }))
  app.delete('/x', (c) => c.json({ ok: true }))
  // The attachment upload route is the only path exempt from the JSON
  // Content-Type rule, so the scoping of that exemption needs a path that
  // looks like it and one that doesn't.
  app.post('/api/todos/1/attachments', (c) => c.json({ ok: true }))
  return app
}

const LOCAL_ORIGIN = { origin: 'http://localhost:5757' }

describe('csrfProtection', () => {
  test('allows GET requests through with no Origin header at all', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x')
    expect(res.status).toBe(200)
  })

  test('rejects POST with a missing Origin and no Sec-Fetch-Site', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(false)
  })

  test('rejects POST from a foreign Origin', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  test('allows POST with a matching localhost Origin', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757' },
    })
    expect(res.status).toBe(200)
  })

  test('allows POST with a matching 127.0.0.1 Origin', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5757' },
    })
    expect(res.status).toBe(200)
  })

  test('allows POST with no Origin but Sec-Fetch-Site: same-origin', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(200)
  })

  test('rejects a foreign Origin even with a spoofed Sec-Fetch-Site: same-origin', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://evil.example.com', 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(403)
  })

  test('rejects PATCH and DELETE the same way as POST', async () => {
    const app = buildApp(5757)
    const patchRes = await app.request('/x', { method: 'PATCH' })
    const deleteRes = await app.request('/x', { method: 'DELETE' })
    expect(patchRes.status).toBe(403)
    expect(deleteRes.status).toBe(403)
  })

  test('rejects a POST body with a non-JSON Content-Type', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757', 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(res.status).toBe(415)
  })

  test('allows a POST body with application/json Content-Type', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
  })

  test('does not require a Content-Type when there is no body', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757' },
    })
    expect(res.status).toBe(200)
  })

  test('allows a multipart body on the attachment upload route', async () => {
    const app = buildApp(5757)
    const form = new FormData()
    form.set('file', new File(['bytes'], 'a.txt'))
    const res = await app.request('/api/todos/1/attachments', {
      method: 'POST',
      headers: LOCAL_ORIGIN,
      body: form,
    })
    expect(res.status).toBe(200)
  })

  // c.req.json() parses a body whatever the header claims, so an exemption
  // granted on Content-Type alone would let any POST opt out of the JSON rule
  // by relabelling itself multipart. It is scoped to the upload route instead.
  test('still rejects a body labelled multipart on a non-upload route', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'POST',
      headers: { ...LOCAL_ORIGIN, 'content-type': 'multipart/form-data; boundary=x' },
      body: JSON.stringify({ smuggled: true }),
    })
    expect(res.status).toBe(415)
  })

  test('does not treat a lookalike Content-Type as multipart', async () => {
    const app = buildApp(5757)
    const res = await app.request('/api/todos/1/attachments', {
      method: 'POST',
      headers: { ...LOCAL_ORIGIN, 'content-type': 'multipart/form-data-evil' },
      body: JSON.stringify({ smuggled: true }),
    })
    expect(res.status).toBe(415)
  })

  test('does not enforce Content-Type on DELETE', async () => {
    const app = buildApp(5757)
    const res = await app.request('/x', {
      method: 'DELETE',
      headers: { origin: 'http://localhost:5757' },
    })
    expect(res.status).toBe(200)
  })
})
