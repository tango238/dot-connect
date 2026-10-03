import { describe, expect, test } from 'bun:test'
import { createDotConnectClient, DotConnectApiError } from '../../src/mcp/dotConnectClient'

interface FakeCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

function fakeFetch(respond: (call: FakeCall) => { status?: number; body: unknown }) {
  const calls: FakeCall[] = []
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: FakeCall = {
      url: input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('createDotConnectClient', () => {
  test('sends GET with no body and no Content-Type header', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { success: true, data: [1, 2, 3] } }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    const data = await client.request('GET', '/api/todos')

    expect(data).toEqual([1, 2, 3])
    expect(calls[0]?.url).toBe('http://x/api/todos')
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['content-type']).toBeUndefined()
    expect(calls[0]?.body).toBeUndefined()
  })

  test('sends a JSON body and Content-Type: application/json for POST', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { success: true, data: { id: 1 } } }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    await client.request('POST', '/api/todos', { title: 'x' })

    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(calls[0]?.body).toBe(JSON.stringify({ title: 'x' }))
  })

  test('includes an Authorization: Bearer header when a token is configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { success: true, data: [] } }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: 'secret', fetchFn })

    await client.request('GET', '/api/todos')

    expect(calls[0]?.headers.authorization).toBe('Bearer secret')
  })

  test('omits the Authorization header entirely when no token is configured', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { success: true, data: [] } }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    await client.request('GET', '/api/todos')

    expect(calls[0]?.headers.authorization).toBeUndefined()
  })

  // C1: Bun's server-side fetch adds no Origin/Sec-Fetch-Site of its own, so
  // the client must declare the Origin itself or the API's CSRF check rejects
  // every write tool with a 403 (see tests/api/mcpClientIntegration.test.ts).
  test('always sends an Origin header matching the configured base URL', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { success: true, data: { id: 1 } } }))
    const client = createDotConnectClient({
      baseUrl: 'http://127.0.0.1:5757',
      apiToken: null,
      fetchFn,
    })

    await client.request('POST', '/api/todos', { title: 'x' })
    await client.request('GET', '/api/todos')

    expect(calls[0]?.headers.origin).toBe('http://127.0.0.1:5757')
    expect(calls[1]?.headers.origin).toBe('http://127.0.0.1:5757')
  })

  test('strips a trailing slash from the base URL in both the URL and the Origin', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: { success: true, data: [] } }))
    const client = createDotConnectClient({
      baseUrl: 'http://127.0.0.1:5757/',
      apiToken: null,
      fetchFn,
    })

    await client.request('GET', '/api/todos')

    expect(calls[0]?.url).toBe('http://127.0.0.1:5757/api/todos')
    expect(calls[0]?.headers.origin).toBe('http://127.0.0.1:5757')
  })

  test('throws DotConnectApiError with the API error message on success:false', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 404,
      body: { success: false, error: 'そのマイルストーンは既に削除されています' },
    }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    await expect(client.request('GET', '/api/milestones/999')).rejects.toThrow(DotConnectApiError)
    await expect(client.request('GET', '/api/milestones/999')).rejects.toThrow(
      'そのマイルストーンは既に削除されています'
    )
  })

  test('folds extra envelope fields (e.g. remaining) into the thrown message', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 409,
      body: { success: false, error: 'Milestone 5 has unfinished todos', remaining: 3 },
    }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    await expect(client.request('POST', '/api/milestones/5/complete')).rejects.toThrow(/remaining/)
    await expect(client.request('POST', '/api/milestones/5/complete')).rejects.toThrow(/3/)
  })

  test('falls back to a generic message when success:false has no error field', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 500, body: { success: false } }))
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    await expect(client.request('GET', '/api/todos')).rejects.toThrow(/500/)
  })

  // F52: a non-JSON response body (a proxy's HTML error page, a plain-text
  // 404, dot-connect not actually running behind that URL, etc.) must not
  // surface as a raw, uncaught SyntaxError from res.json().
  test('throws a readable DotConnectApiError (not a raw SyntaxError) on a non-JSON response', async () => {
    const fetchFn = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch
    const client = createDotConnectClient({ baseUrl: 'http://x', apiToken: null, fetchFn })

    await expect(client.request('GET', '/api/todos')).rejects.toThrow(DotConnectApiError)
    await expect(client.request('GET', '/api/todos')).rejects.toThrow(/502/)
  })

  // F52: fetchFn itself rejecting (connection refused — the server isn't
  // running) must also become a readable DotConnectApiError, not an opaque
  // "fetch failed" bubbling straight out of a tool call.
  test('throws a readable DotConnectApiError when the underlying fetch rejects (connection refused)', async () => {
    const fetchFn = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5757')
    }) as unknown as typeof fetch
    const client = createDotConnectClient({ baseUrl: 'http://127.0.0.1:5757', apiToken: null, fetchFn })

    await expect(client.request('GET', '/api/todos')).rejects.toThrow(DotConnectApiError)
    await expect(client.request('GET', '/api/todos')).rejects.toThrow(/ECONNREFUSED/)
  })
})
