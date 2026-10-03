import { describe, expect, test } from 'bun:test'
import { createDotConnectClient } from '../../src/mcp/dotConnectClient'
import { createRawTestApp } from './testApp'

// C1 regression coverage. The desktop app registers the MCP server against a
// local dot-connect with NO API token, so every write tool goes through the
// CSRF path — and Bun's server-side fetch sends neither Origin nor
// Sec-Fetch-Site on its own. Before the fix that meant a 403 on every
// mutating tool call. These tests run against the RAW route table on purpose:
// createTestApp's wrapper injects a same-origin Origin, which would hide
// exactly the header shape under test.

const BASE_URL = 'http://127.0.0.1:5757'

function clientAgainst(app: ReturnType<typeof createRawTestApp>['app']) {
  const fetchFn = ((input: string | URL, init?: RequestInit) =>
    app.request(input.toString(), init)) as unknown as typeof fetch
  return createDotConnectClient({ baseUrl: BASE_URL, apiToken: null, fetchFn })
}

describe('the MCP client against the real route table (no API token)', () => {
  test('create_todo-style POST succeeds on the headers the client actually sends', async () => {
    const { app } = createRawTestApp()
    const client = clientAgainst(app)

    const created = await client.request<{ id: number; title: string }>('POST', '/api/todos', {
      title: 'Created over MCP',
    })

    expect(created.title).toBe('Created over MCP')
  })

  test('PATCH and DELETE go through too, not just POST', async () => {
    const { app } = createRawTestApp()
    const client = clientAgainst(app)
    const created = await client.request<{ id: number }>('POST', '/api/todos', { title: 'x' })

    const updated = await client.request<{ title: string }>('PATCH', `/api/todos/${created.id}`, {
      title: 'renamed',
    })
    expect(updated.title).toBe('renamed')

    await client.request('DELETE', `/api/todos/${created.id}`)
  })

  test('a raw POST with an allowed Origin and no Sec-Fetch-Site is accepted', async () => {
    const { app } = createRawTestApp()

    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: BASE_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })

    expect(res.status).toBe(201)
  })

  // The other half of the pin: the CSRF rule C1 collided with is still in
  // force, so this fix can't be mistaken for "CSRF was turned off".
  test('a raw POST with neither Origin nor Sec-Fetch-Site is still rejected', async () => {
    const { app } = createRawTestApp()

    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })

    expect(res.status).toBe(403)
  })
})
