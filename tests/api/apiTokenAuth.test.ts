import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { apiTokenAuth, isAllowedForApiToken } from '../../src/api/apiTokenAuth'
import { API_TOKEN_AUTHENTICATED_KEY, csrfProtection } from '../../src/api/csrf'

function buildApp(token: string | null, isLoopback = true, port = 5757): Hono {
  const app = new Hono()
  app.use('*', apiTokenAuth(token, isLoopback))
  app.use('*', csrfProtection(port))
  app.get('/api/todos', (c) => c.json({ ok: true }))
  app.post('/api/todos', (c) => c.json({ ok: true }))
  app.patch('/api/todos/1', (c) => c.json({ ok: true }))
  app.delete('/api/todos/1', (c) => c.json({ ok: true }))
  app.post('/api/todos/1/dispatch', (c) => c.json({ ok: true }))
  return app
}

describe('apiTokenAuth (loopback bind — existing legacy behavior)', () => {
  test('when no token is configured, a Bearer header is ignored and normal CSRF rules apply', async () => {
    const app = buildApp(null)
    const withBadOrigin = await app.request('/api/todos', {
      method: 'POST',
      headers: { authorization: 'Bearer whatever', origin: 'http://evil.example.com' },
    })
    expect(withBadOrigin.status).toBe(403) // CSRF still governs; token auth is fully off

    const sameOrigin = await app.request('/api/todos', {
      method: 'GET',
      headers: { authorization: 'Bearer whatever' },
    })
    expect(sameOrigin.status).toBe(200)
  })

  test('no Authorization header at all: falls through to normal CSRF handling unaffected', async () => {
    const app = buildApp('secret-token', true)
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757' },
    })
    expect(res.status).toBe(200)
  })

  test('a correct token on an allowed endpoint succeeds even with a bad/missing Origin', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-token',
        origin: 'http://evil.example.com',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(res.status).toBe(200)
  })

  test('an incorrect token returns 401 regardless of Origin', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token', origin: 'http://evil.example.com' },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('Invalid API token')
  })

  test('an incorrect token of a completely different length also returns 401 (no length-based branch)', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos', {
      method: 'GET',
      headers: { authorization: 'Bearer x' },
    })
    expect(res.status).toBe(401)
  })

  test('a token that is a prefix of the real token still fails (no partial match)', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos', {
      method: 'GET',
      headers: { authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(401)
  })

  test('a valid token on a disallowed endpoint (e.g. dispatch) returns 403 with the Japanese message', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos/1/dispatch', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('このエンドポイントはAPIトークンからは利用できません')
  })

  test('no Origin/Sec-Fetch-Site at all + no token configured: still 403 (unchanged legacy behavior)', async () => {
    const app = buildApp(null)
    const res = await app.request('/api/todos', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('sets the apiTokenAuthenticated context flag only once the token is verified', async () => {
    const app = new Hono<{ Variables: { [API_TOKEN_AUTHENTICATED_KEY]?: boolean } }>()
    app.use('*', apiTokenAuth('secret-token', true))
    app.get('/api/todos', (c) => c.json({ authenticated: c.get(API_TOKEN_AUTHENTICATED_KEY) === true }))

    const authed = await app.request('/api/todos', { headers: { authorization: 'Bearer secret-token' } })
    const authedBody = (await authed.json()) as { authenticated: boolean }
    expect(authedBody.authenticated).toBe(true)

    const unauthed = await app.request('/api/todos')
    const unauthedBody = (await unauthed.json()) as { authenticated: boolean }
    expect(unauthedBody.authenticated).toBe(false)
  })
})

// F50: on a non-loopback bind, Origin/Sec-Fetch-Site are attacker-controlled
// (any non-browser client sets them freely), so "no token -> fall back to
// CSRF" is not a safe substitute for authentication once the server is
// reachable beyond this machine. Every request must carry a valid token.
describe('apiTokenAuth (non-loopback bind — F50)', () => {
  test('no Authorization header at all -> 401 on GET (previously fell through and succeeded)', async () => {
    const app = buildApp('secret-token', false)
    const res = await app.request('/api/todos')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toBe('API token required')
  })

  test('no Authorization header -> 401 on POST/PATCH/DELETE too', async () => {
    const app = buildApp('secret-token', false)
    const post = await app.request('/api/todos', { method: 'POST' })
    const patch = await app.request('/api/todos/1', { method: 'PATCH' })
    const del = await app.request('/api/todos/1', { method: 'DELETE' })
    expect(post.status).toBe(401)
    expect(patch.status).toBe(401)
    expect(del.status).toBe(401)
  })

  test('a forged same-origin Origin/Sec-Fetch-Site with no token still gets 401, not through to CSRF', async () => {
    const app = buildApp('secret-token', false)
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757', 'sec-fetch-site': 'same-origin' },
    })
    expect(res.status).toBe(401)
  })

  test('a valid token still works and is still bound by the endpoint allowlist', async () => {
    const app = buildApp('secret-token', false)
    const allowed = await app.request('/api/todos', {
      headers: { authorization: 'Bearer secret-token' },
    })
    expect(allowed.status).toBe(200)

    const disallowed = await app.request('/api/todos/1/dispatch', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
    })
    expect(disallowed.status).toBe(403)
  })

  test('an invalid token still gets 401 (not a behavior change from the loopback case)', async () => {
    const app = buildApp('secret-token', false)
    const res = await app.request('/api/todos', { headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
  })
})

// F51: a present-but-unparseable Authorization header must fail loudly
// (401), not be silently treated as "no header at all".
describe('apiTokenAuth (F51: malformed/wrong-scheme Authorization)', () => {
  test('the Bearer scheme name is matched case-insensitively (RFC 7235)', async () => {
    const app = buildApp('secret-token')
    const lower = await app.request('/api/todos', { headers: { authorization: 'bearer secret-token' } })
    const upper = await app.request('/api/todos', { headers: { authorization: 'BEARER secret-token' } })
    expect(lower.status).toBe(200)
    expect(upper.status).toBe(200)
  })

  test('a non-Bearer scheme (e.g. Basic) is a failed auth attempt, not "no attempt" -> 401', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(res.status).toBe(401)
  })

  test('"Bearer" with no space before the token is unparseable -> 401, not pass-through', async () => {
    const app = buildApp('secret-token')
    const res = await app.request('/api/todos', {
      headers: { authorization: 'Bearersecret-token' },
    })
    expect(res.status).toBe(401)
  })

  test('this also closes F50 on a non-loopback bind: a malformed header does not fall through to CSRF', async () => {
    const app = buildApp('secret-token', false)
    const res = await app.request('/api/todos', {
      headers: { authorization: 'NotBearer whatever', origin: 'http://localhost:5757' },
    })
    expect(res.status).toBe(401)
  })
})

// F53: config.ts already refuses to start with {apiToken: null, isLoopback:
// false} (non-loopback HOST with no token configured), so this combination
// should be unreachable in the real app. This suite constructs it directly
// against the middleware anyway, bypassing config.ts entirely, to confirm
// the middleware enforces the same invariant itself rather than depending
// solely on the config-layer check (defense in depth).
describe('apiTokenAuth (F53: fail-closed even if config.ts is bypassed)', () => {
  test('apiToken: null + isLoopback: false blocks every method, even with a forged same-origin Origin', async () => {
    const app = buildApp(null, false)
    const get = await app.request('/api/todos')
    const post = await app.request('/api/todos', {
      method: 'POST',
      headers: { origin: 'http://localhost:5757' },
    })
    const patch = await app.request('/api/todos/1', {
      method: 'PATCH',
      headers: { origin: 'http://localhost:5757', 'sec-fetch-site': 'same-origin' },
    })
    const del = await app.request('/api/todos/1', { method: 'DELETE' })

    for (const res of [get, post, patch, del]) {
      expect(res.status).not.toBe(200)
      expect(res.status).not.toBe(201)
    }
  })

  test('apiToken: null + isLoopback: false returns a clear server-misconfiguration response, not a silent pass-through', async () => {
    const app = buildApp(null, false)
    const res = await app.request('/api/todos')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('API token required')
  })

  test('apiToken: null + isLoopback: true is unaffected — still the normal loopback/CSRF flow', async () => {
    const app = buildApp(null, true)
    const res = await app.request('/api/todos', { headers: { origin: 'http://localhost:5757' } })
    expect(res.status).toBe(200)
  })
})

describe('isAllowedForApiToken', () => {
  test('allows todos CRUD', () => {
    expect(isAllowedForApiToken('GET', '/api/todos')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/todos')).toBe(true)
    expect(isAllowedForApiToken('PATCH', '/api/todos/42')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/todos/42/complete')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/todos/42/reopen')).toBe(true)
    expect(isAllowedForApiToken('DELETE', '/api/todos/42')).toBe(true)
  })

  // PR links carry no code-execution risk (unlike dispatch), so the MCP
  // server is allowed to manage them.
  test('allows managing a todo’s pull request links', () => {
    expect(isAllowedForApiToken('POST', '/api/todos/42/pull-requests')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/todos/42/pull-requests/7/refresh')).toBe(true)
    expect(isAllowedForApiToken('DELETE', '/api/todos/42/pull-requests/7')).toBe(true)
  })

  test('does not accidentally widen the todos patterns to arbitrary sub-paths', () => {
    expect(isAllowedForApiToken('DELETE', '/api/todos/42/pull-requests')).toBe(false)
    expect(isAllowedForApiToken('POST', '/api/todos/42/pull-requests/7')).toBe(false)
    expect(isAllowedForApiToken('POST', '/api/todos/42/pull-requests/x/refresh')).toBe(false)
  })

  // 作業ログは今のところブラウザUIからしか書かない。allowlist は opt-in なので、
  // MCP から書けるようにするならここを意図して広げる(黙って通らない)。
  test('blocks the todo comment endpoints until they are deliberately added', () => {
    expect(isAllowedForApiToken('POST', '/api/todos/42/comments')).toBe(false)
    expect(isAllowedForApiToken('DELETE', '/api/todos/42/comments/7')).toBe(false)
  })

  // The workspacePath history is browser-UI-only; nothing in MCP reads it,
  // so it stays off the allowlist (deny by default).
  test('blocks the workspace path history endpoints', () => {
    expect(isAllowedForApiToken('GET', '/api/workspaces/history')).toBe(false)
    expect(isAllowedForApiToken('DELETE', '/api/workspaces/history')).toBe(false)
  })

  test('allows milestones CRUD', () => {
    expect(isAllowedForApiToken('GET', '/api/milestones')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/milestones')).toBe(true)
    expect(isAllowedForApiToken('PATCH', '/api/milestones/7')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/milestones/7/complete')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/milestones/7/reopen')).toBe(true)
    expect(isAllowedForApiToken('DELETE', '/api/milestones/7')).toBe(true)
  })

  test('allows labels CRUD', () => {
    expect(isAllowedForApiToken('GET', '/api/labels')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/labels')).toBe(true)
    expect(isAllowedForApiToken('PATCH', '/api/labels/3')).toBe(true)
    expect(isAllowedForApiToken('DELETE', '/api/labels/3')).toBe(true)
  })

  test('allows workspaces CRUD', () => {
    expect(isAllowedForApiToken('GET', '/api/workspaces')).toBe(true)
    expect(isAllowedForApiToken('POST', '/api/workspaces')).toBe(true)
    expect(isAllowedForApiToken('PATCH', '/api/workspaces/3')).toBe(true)
    expect(isAllowedForApiToken('DELETE', '/api/workspaces/3')).toBe(true)
  })

  test('allows reading /api/models', () => {
    expect(isAllowedForApiToken('GET', '/api/models')).toBe(true)
  })

  test('blocks mutating /api/models (there is no such route, but the allowlist should not match it anyway)', () => {
    expect(isAllowedForApiToken('POST', '/api/models')).toBe(false)
  })

  test('blocks dispatch and open-session', () => {
    expect(isAllowedForApiToken('POST', '/api/todos/1/dispatch')).toBe(false)
    expect(isAllowedForApiToken('POST', '/api/todos/1/open-session')).toBe(false)
  })

  test('blocks weekly report generation (but allowlist has no report reads either)', () => {
    expect(isAllowedForApiToken('POST', '/api/reports/weekly/generate')).toBe(false)
    expect(isAllowedForApiToken('GET', '/api/reports/weekly')).toBe(false)
    expect(isAllowedForApiToken('GET', '/api/reports/weekly/latest')).toBe(false)
  })

  test('blocks herdr sync/status', () => {
    expect(isAllowedForApiToken('POST', '/api/herdr/sync')).toBe(false)
    expect(isAllowedForApiToken('GET', '/api/herdr/status')).toBe(false)
  })

  test('blocks prompts endpoints (not in the explicit CRUD allowlist)', () => {
    expect(isAllowedForApiToken('GET', '/api/prompts/history')).toBe(false)
    expect(isAllowedForApiToken('GET', '/api/prompts/snippets')).toBe(false)
  })

  test('a future/unknown endpoint is blocked by default (allowlist, not blocklist)', () => {
    expect(isAllowedForApiToken('POST', '/api/something-added-later')).toBe(false)
    expect(isAllowedForApiToken('GET', '/api/todos/1/some-new-subroute')).toBe(false)
  })
})
