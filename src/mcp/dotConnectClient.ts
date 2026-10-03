// The MCP server deliberately talks to dot-connect over HTTP rather than
// touching bun:sqlite directly: zod validation, milestone-existence checks,
// label-name-uniqueness detection, etc. all already live in the HTTP API
// layer, and re-implementing any of it here would be a second copy of the
// same business logic to keep in sync.

export class DotConnectApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DotConnectApiError'
  }
}

interface ApiEnvelope {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
  readonly [key: string]: unknown
}

export interface DotConnectClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>
}

export interface CreateDotConnectClientOptions {
  readonly baseUrl: string
  readonly apiToken: string | null
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch
}

// Trailing slashes have to go before baseUrl is used: it is concatenated with
// a leading-slash path, and it doubles as the Origin header value, which must
// be a bare scheme://host:port to match the server's allowlist.
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

// The Origin header is mandatory, not optional: Bun's server-side fetch sends
// neither Origin nor Sec-Fetch-Site, so every mutating tool call would be
// rejected by the API's CSRF check (src/api/csrf.ts) without it. Declaring it
// here weakens nothing — only browsers are bound by Origin, and a non-browser
// local process could always have set it to whatever it liked.
function buildHeaders(
  baseUrl: string,
  apiToken: string | null,
  hasBody: boolean
): Record<string, string> {
  const headers: Record<string, string> = { origin: baseUrl }
  if (apiToken !== null) {
    headers.authorization = `Bearer ${apiToken}`
  }
  if (hasBody) {
    headers['content-type'] = 'application/json'
  }
  return headers
}

// Any envelope field besides success/data/error (e.g. milestone-complete's
// `remaining` open-todo count) is folded into the thrown message, so a tool
// error like "has unfinished todos" still surfaces the number to the caller
// instead of being silently dropped.
function describeFailure(envelope: ApiEnvelope, status: number): string {
  const message = envelope.error ?? `dot-connect API request failed (HTTP ${status})`
  const extra = Object.fromEntries(
    Object.entries(envelope).filter(([key]) => !['success', 'data', 'error'].includes(key))
  )
  return Object.keys(extra).length > 0 ? `${message} ${JSON.stringify(extra)}` : message
}

// Connection failures (server not running, DNS failure, etc.) reject the
// fetch promise itself rather than producing a Response at all, so they need
// their own try/catch — otherwise a tool call would surface a raw,
// un-actionable "fetch failed" instead of naming what went wrong.
async function fetchResponse(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchFn(url, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DotConnectApiError(`dot-connectサーバーに接続できませんでした: ${message}`)
  }
}

// A non-JSON body (a proxy's HTML error page, a plain-text 404, etc.) makes
// res.json() throw its own SyntaxError, which — left uncaught — would leak
// straight through as an opaque parse error instead of naming dot-connect
// as the source and including the HTTP status that actually came back.
async function parseEnvelope(res: Response): Promise<ApiEnvelope> {
  try {
    return (await res.json()) as ApiEnvelope
  } catch {
    throw new DotConnectApiError(`dot-connect から不正なレスポンス (HTTP ${res.status})`)
  }
}

export function createDotConnectClient(options: CreateDotConnectClientOptions): DotConnectClient {
  const fetchFn = options.fetchFn ?? fetch
  const baseUrl = normalizeBaseUrl(options.baseUrl)

  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetchResponse(fetchFn, `${baseUrl}${path}`, {
        method,
        headers: buildHeaders(baseUrl, options.apiToken, body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const envelope = await parseEnvelope(res)
      if (!envelope.success) {
        throw new DotConnectApiError(describeFailure(envelope, res.status))
      }
      return envelope.data as T
    },
  }
}
