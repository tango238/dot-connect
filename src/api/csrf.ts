import type { Context, Next } from 'hono'

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])
const JSON_BODY_METHODS = new Set(['POST', 'PATCH'])

// Attachment upload is the one body shape that cannot be JSON: the browser
// sets this Content-Type itself (boundary and all) and a file's bytes have no
// JSON representation.
//
// The exemption is scoped to that one route, not granted to any request that
// merely *claims* to be multipart. c.req.json() parses a body regardless of
// what the header says, so an unscoped exemption would let every POST opt out
// of the JSON rule just by relabelling itself — and that rule is the second,
// independent layer against the simple cross-origin form POST that multipart
// makes possible (the Origin check in csrfProtection is the first, and still
// applies here in full).
const MULTIPART_CONTENT_TYPE = 'multipart/form-data'
const UPLOAD_PATH_SUFFIX = '/attachments'

function isAttachmentUpload(c: Context): boolean {
  if (!c.req.path.endsWith(UPLOAD_PATH_SUFFIX)) {
    return false
  }
  // Compare the bare media type, so `multipart/form-data; boundary=…` counts
  // while a lookalike like `multipart/form-data-evil` does not.
  const mediaType = (c.req.header('content-type') ?? '').split(';')[0] ?? ''
  return mediaType.trim().toLowerCase() === MULTIPART_CONTENT_TYPE
}

// Set by apiTokenAuth() once a request's Bearer token has been verified
// against the configured API token, so csrfProtection knows to skip its
// Origin/Sec-Fetch-Site check for this request (see apiTokenAuth.ts for why).
export const API_TOKEN_AUTHENTICATED_KEY = 'apiTokenAuthenticated'

function hasBody(c: Context): boolean {
  // Content-Length is not reliably present on incoming Requests (fetch does
  // not always set it), so check the body stream directly instead.
  return c.req.raw.body !== null
}

// Separate from the Origin check on purpose: this requirement is about the
// body being parseable as what the route expects, not about proving
// same-origin-ness, so passing one never excuses the other.
export function requireJsonContentType(c: Context): Response | null {
  const method = c.req.method.toUpperCase()
  if (!JSON_BODY_METHODS.has(method) || !hasBody(c)) {
    return null
  }
  if (isAttachmentUpload(c)) {
    return null
  }
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return c.json({ success: false, error: 'Content-Type must be application/json' }, 415)
  }
  return null
}

// Same-origin enforcement for a local-only tool. Browsers always send Origin
// on cross-origin mutating requests, so when Origin IS present it must match
// the allowlist — full stop, no fallback. Sec-Fetch-Site: same-origin only
// rescues requests where Origin is entirely absent (same-origin fetches
// sometimes omit it); it must never override a present-but-wrong Origin,
// since unlike a real browser, a non-browser client can set Sec-Fetch-Site to
// whatever it wants.
export function csrfProtection(port: number) {
  const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`])

  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method.toUpperCase()
    if (!MUTATING_METHODS.has(method)) {
      return next()
    }

    // A verified API Bearer token is explicit machine intent, unlike a
    // browser's ambient cookies/session — CSRF exists to stop the latter
    // being ridden by a hostile page, which doesn't apply here.
    if (c.get(API_TOKEN_AUTHENTICATED_KEY) !== true) {
      const origin = c.req.header('origin')
      if (origin !== undefined) {
        if (!allowedOrigins.has(origin)) {
          return c.json({ success: false, error: 'Invalid or missing Origin header' }, 403)
        }
      } else if (c.req.header('sec-fetch-site') !== 'same-origin') {
        return c.json({ success: false, error: 'Invalid or missing Origin header' }, 403)
      }
    }

    const contentTypeError = requireJsonContentType(c)
    if (contentTypeError) {
      return contentTypeError
    }

    return next()
  }
}
