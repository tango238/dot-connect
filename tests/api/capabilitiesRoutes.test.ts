import { describe, expect, test } from 'bun:test'
import { createTestApp, readJson } from './testApp'

describe('GET /api/capabilities', () => {
  test('deps.capabilities の結果を返す', async () => {
    const { app } = createTestApp({
      capabilities: async () => ({ dispatch: true, sessionFocus: false, mcpBinPath: '/x/mcp' }),
    })
    const res = await app.request('/api/capabilities')
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body).toEqual({ success: true, data: { dispatch: true, sessionFocus: false, mcpBinPath: '/x/mcp' } })
  })
})
