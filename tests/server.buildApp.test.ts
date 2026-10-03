import { describe, expect, test } from 'bun:test'
import { buildApp } from '../src/server'
import { createTestApp } from './api/testApp'

// The browser UI can't hold an API token (no safe client-side place to put
// one), so once the server is reachable beyond loopback, serving it would
// just be an unauthenticated SPA that can't call any endpoint anyway —
// buildApp stops serving it entirely instead (see server.ts).
describe('buildApp static UI serving policy', () => {
  test('serves the static UI when isLoopback is true (the default, unchanged behavior)', async () => {
    const { deps } = createTestApp({ isLoopback: true })
    const app = buildApp(deps)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!')
  })

  test('does NOT serve the static UI when isLoopback is false, returning a clear 404 instead', async () => {
    const { deps } = createTestApp({ isLoopback: false, apiToken: 'secret' })
    const app = buildApp(deps)
    const res = await app.request('/')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('ブラウザUIは非loopbackバインドでは配信されません')
  })

  test('the non-loopback UI block applies to any static-looking path, not just "/"', async () => {
    const { deps } = createTestApp({ isLoopback: false, apiToken: 'secret' })
    const app = buildApp(deps)
    const res = await app.request('/js/app.js')
    expect(res.status).toBe(404)
  })

  test('the /api routes are unaffected by the static-serving policy either way', async () => {
    const loopback = createTestApp({ isLoopback: true })
    const nonLoopback = createTestApp({ isLoopback: false, apiToken: 'secret' })

    const loopbackApp = buildApp(loopback.deps)
    const nonLoopbackApp = buildApp(nonLoopback.deps)

    const loopbackRes = await loopbackApp.request('/api/todos', {
      headers: { origin: 'http://localhost:5757' },
    })
    const nonLoopbackRes = await nonLoopbackApp.request('/api/todos', {
      headers: { authorization: 'Bearer secret' },
    })
    expect(loopbackRes.status).toBe(200)
    expect(nonLoopbackRes.status).toBe(200)
  })
})
