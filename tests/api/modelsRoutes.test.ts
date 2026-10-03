import { describe, expect, test } from 'bun:test'
import { createTestApp, readJson } from './testApp'

describe('GET /api/models', () => {
  test('returns the configured allowlist', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/models')
    const body = await readJson(res)
    expect(res.status).toBe(200)
    expect(body.data).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'codex'])
  })

  test('reflects a custom allowedModels list from deps', async () => {
    const { app } = createTestApp({ allowedModels: ['opus', 'my-custom-model'] })
    const res = await app.request('/api/models')
    const body = await readJson(res)
    expect(body.data).toEqual(['opus', 'my-custom-model'])
  })
})
