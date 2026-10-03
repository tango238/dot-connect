import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context, Next } from 'hono'
import { logger } from '../logger'
import { API_TOKEN_AUTHENTICATED_KEY } from './csrf'

// RFC 7235: auth scheme names are case-insensitive ("bearer", "Bearer",
// "BEARER" are all the same scheme). \s+ requires at least one space, so
// "Bearer<token>" (no space) is correctly rejected as unparseable rather
// than accidentally matched (see F51).
const BEARER_PATTERN = /^bearer\s+(.*)$/i

// Hashing both sides to a fixed-length (32-byte) digest before comparing
// means timingSafeEqual never sees inputs of different lengths (it throws
// if given two buffers of different lengths, which would otherwise leak the
// real token's length through which branch the caller has to take).
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected))
}

// Three distinct outcomes, not two — collapsing "no header" and "header
// present but not Bearer" into the same "undefined" was F51: a malformed
// Authorization header would silently fall through as if none had been
// sent at all, instead of failing loudly.
// - undefined: no Authorization header on this request at all.
// - null: an Authorization header IS present but doesn't parse as
//   "Bearer <token>" (wrong scheme, or no space before the token).
// - string: the token value following a valid "Bearer " prefix (may be "").
function extractBearerToken(c: Context): string | null | undefined {
  const header = c.req.header('authorization')
  if (header === undefined) {
    return undefined
  }
  const match = BEARER_PATTERN.exec(header)
  return match ? match[1]! : null
}

interface AllowedEndpoint {
  readonly method: string
  readonly pattern: RegExp
}

const ID = '\\d+'

// Allowlist, not blocklist: an external API token may only reach
// todos/milestones/labels CRUD. Anything added to the API later (new
// routes, new sub-resources) is unreachable via a token until explicitly
// added here — the opposite of what a blocklist would do.
//
// One entry below is not pure CRUD: `complete` also closes the todo's herdr
// workspace (see todoCompletionService.ts). It cannot start anything, and it
// refuses to close a pane it has not just confirmed to be idle or done, but
// it is the one endpoint here that reaches herdr at all — keep that in mind
// before widening this list.
const ALLOWED_ENDPOINTS: readonly AllowedEndpoint[] = [
  { method: 'GET', pattern: /^\/api\/todos\/?$/ },
  { method: 'POST', pattern: /^\/api\/todos\/?$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/todos/${ID}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/todos/${ID}/complete$`) },
  { method: 'POST', pattern: new RegExp(`^/api/todos/${ID}/reopen$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/todos/${ID}$`) },

  // PR links are plain metadata on a todo (no code execution, unlike
  // dispatch), so the MCP server is allowed to manage them.
  { method: 'POST', pattern: new RegExp(`^/api/todos/${ID}/pull-requests$`) },
  { method: 'POST', pattern: new RegExp(`^/api/todos/${ID}/pull-requests/${ID}/refresh$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/todos/${ID}/pull-requests/${ID}$`) },

  { method: 'GET', pattern: /^\/api\/milestones\/?$/ },
  { method: 'POST', pattern: /^\/api\/milestones\/?$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/milestones/${ID}$`) },
  { method: 'POST', pattern: new RegExp(`^/api/milestones/${ID}/complete$`) },
  { method: 'POST', pattern: new RegExp(`^/api/milestones/${ID}/reopen$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/milestones/${ID}$`) },

  { method: 'GET', pattern: /^\/api\/labels\/?$/ },
  { method: 'POST', pattern: /^\/api\/labels\/?$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/labels/${ID}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/labels/${ID}$`) },

  { method: 'GET', pattern: /^\/api\/workspaces\/?$/ },
  { method: 'POST', pattern: /^\/api\/workspaces\/?$/ },
  { method: 'PATCH', pattern: new RegExp(`^/api/workspaces/${ID}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/api/workspaces/${ID}$`) },

  { method: 'GET', pattern: /^\/api\/models\/?$/ },
]

export function isAllowedForApiToken(method: string, path: string): boolean {
  return ALLOWED_ENDPOINTS.some((e) => e.method === method && e.pattern.test(path))
}

// Runs before csrfProtection.
//
// F50: csrfProtection's fallback for "no token" is Origin/Sec-Fetch-Site —
// both freely forgeable by any non-browser client. That fallback is only a
// safe stand-in for auth when the server can ONLY be reached by a trusted
// local process in the first place (the loopback threat model this tool has
// always run under). The instant HOST binds beyond loopback, "no token" +
// forged headers must NOT reach csrfProtection at all: every request,
// including GETs, requires a valid token. On a loopback bind, "no token at
// all" still defers to csrfProtection exactly as before (no behavior
// change for the existing, still-trusted local case).
//
// F53: config.ts already refuses to start with apiToken === null on a
// non-loopback host, so today apiToken === null implies isLoopback === true
// in practice. But that invariant lives ENTIRELY in config.ts — any future
// entry point that builds AppDependencies without going through
// buildDependencies()/readConfig() (a CLI, a test harness, an embedding)
// could construct {apiToken: null, isLoopback: false} and get a fully
// unauthenticated non-loopback server. This middleware enforces the same
// invariant itself, independent of config.ts, rather than trusting it was
// already checked upstream (defense in depth, not a replacement for the
// config.ts check — that check stays).
export function apiTokenAuth(apiToken: string | null, isLoopback: boolean) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (apiToken === null) {
      if (!isLoopback) {
        logger.error(
          '非loopbackバインドなのにAPIトークンが未設定です。設定ミスとしてリクエストを拒否します。'
        )
        return c.json({ success: false, error: 'Server misconfigured: API token required' }, 500)
      }
      return next()
    }

    const provided = extractBearerToken(c)

    if (provided === undefined) {
      if (!isLoopback) {
        return c.json({ success: false, error: 'API token required' }, 401)
      }
      return next()
    }

    // Malformed/wrong-scheme Authorization (null) and a well-formed but
    // incorrect token both fail the same way: presenting SOME credential
    // that doesn't check out is always a 401, on any bind (F51 — this must
    // not silently fall through as if nothing had been sent).
    if (provided === null || !tokensMatch(provided, apiToken)) {
      return c.json({ success: false, error: 'Invalid API token' }, 401)
    }

    if (!isAllowedForApiToken(c.req.method.toUpperCase(), c.req.path)) {
      return c.json(
        { success: false, error: 'このエンドポイントはAPIトークンからは利用できません' },
        403
      )
    }

    c.set(API_TOKEN_AUTHENTICATED_KEY, true)
    return next()
  }
}
