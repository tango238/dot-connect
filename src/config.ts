import { isAbsolute, resolve } from 'node:path'
import { DEFAULT_HERDR_CHECK_INTERVAL_MS } from './herdr/compatibility'
import { logger } from './logger'
import { parseAllowedModels } from './services/modelValidation'

export interface Config {
  readonly port: number
  readonly dbPath: string
  readonly herdrBin: string
  readonly herdrCheckIntervalMs: number
  readonly claudeBin: string
  // Launched instead of claudeBin when a TODO's model is "codex".
  readonly codexBin: string
  // GitHub CLI, used read-only to look up a linked PR's title and state.
  // Nothing breaks when it is missing or unauthenticated — the lookup fails
  // and the reason is stored alongside the link (see githubPrService.ts).
  readonly ghBin: string
  readonly terminalApp: string | null
  readonly host: string
  readonly apiToken: string | null
  readonly allowedModels: readonly string[]
  // The Tauri desktop shell serves these static assets from its own bundle,
  // not from this repo's checkout, so it needs to override the default via
  // env — a compiled binary has no `import.meta.dir` to fall back on.
  readonly staticDir: string
  readonly desktopMode: boolean
  readonly mcpBinPath: string | null
}

// This file lives at <repo root>/src/config.ts, so its own directory is a
// stable, cwd-independent anchor for resolving the default (and any
// relative) DB_PATH. Using a cwd-relative default here previously caused
// data loss: starting the server from a different working directory would
// silently point at (and create) a different, empty database file.
const PROJECT_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, 'data', 'dot-connect.db')
const DEFAULT_STATIC_DIR = resolve(PROJECT_ROOT, 'public')

// osascript embeds this value inside a double-quoted AppleScript string
// (`tell application "<terminalApp>" to activate`), so it is restricted to a
// safe character set to rule out any injection through the env var.
const TERMINAL_APP_PATTERN = /^[A-Za-z0-9 .-]+$/

function readTerminalApp(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null
  }
  if (!TERMINAL_APP_PATTERN.test(raw)) {
    logger.warn('Ignoring invalid TERMINAL_APP value', { value: raw })
    return null
  }
  return raw
}

// A DB_PATH the caller sets is always honored, but a relative one is
// resolved against the project root rather than cwd, for the same
// cwd-independence reason as the default.
function resolveDbPath(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_DB_PATH
  }
  return isAbsolute(raw) ? raw : resolve(PROJECT_ROOT, raw)
}

// Same cwd-independence reasoning as resolveDbPath: a relative STATIC_DIR is
// resolved against the project root, not cwd.
function resolveStaticDir(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_STATIC_DIR
  }
  return isAbsolute(raw) ? raw : resolve(PROJECT_ROOT, raw)
}

// Loopback-only is the safe default this tool has always run with. HOST
// lets it bind elsewhere (e.g. for LAN access), but only together with an
// API token — otherwise every todos/milestones/labels endpoint would be
// reachable by anyone on the network with zero authentication.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

// Exported: server.ts uses this to decide what to bind/log, and
// apiTokenAuth.ts uses it (via AppDependencies.isLoopback) to decide whether
// a missing API token can fall back to the CSRF/Origin flow at all — see
// the F50 fix in apiTokenAuth.ts for why that fallback is only safe here.
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

// Empty/whitespace-only is treated the same as unset, so an accidentally
// blank env var doesn't "successfully" enable an unusable, unguessable-empty
// value. Shared by DOT_CONNECT_API_TOKEN and DOT_CONNECT_MCP_BIN, which have
// identical trim-or-null semantics.
function readOptionalString(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const herdrCheckIntervalMs = Number(env.DOT_CONNECT_HERDR_CHECK_INTERVAL_MS ?? DEFAULT_HERDR_CHECK_INTERVAL_MS)
  if (!Number.isSafeInteger(herdrCheckIntervalMs) || herdrCheckIntervalMs < 60_000 || herdrCheckIntervalMs > 30 * 86400_000) {
    throw new Error('DOT_CONNECT_HERDR_CHECK_INTERVAL_MS must be between 60000 and 2592000000')
  }
  const port = Number(env.PORT ?? '5757')
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`)
  }

  const host = env.HOST ?? '127.0.0.1'
  const apiToken = readOptionalString(env.DOT_CONNECT_API_TOKEN)
  if (!isLoopbackHost(host) && apiToken === null) {
    throw new Error(
      `HOST=${host} は loopback (127.0.0.1/localhost/::1) ではありませんが、` +
        'DOT_CONNECT_API_TOKEN が設定されていません。認証なしでLAN/外部に公開されるのを防ぐため、' +
        '起動を拒否します。DOT_CONNECT_API_TOKEN を設定するか、HOST を loopback に戻してください。'
    )
  }

  return {
    port,
    dbPath: resolveDbPath(env.DB_PATH),
    herdrBin: env.HERDR_BIN ?? 'herdr',
    herdrCheckIntervalMs,
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    codexBin: env.CODEX_BIN ?? 'codex',
    ghBin: env.GH_BIN ?? 'gh',
    terminalApp: readTerminalApp(env.TERMINAL_APP),
    host,
    apiToken,
    allowedModels: parseAllowedModels(env.DOT_CONNECT_ALLOWED_MODELS),
    staticDir: resolveStaticDir(env.STATIC_DIR),
    desktopMode: env.DOT_CONNECT_DESKTOP === '1',
    mcpBinPath: readOptionalString(env.DOT_CONNECT_MCP_BIN),
  }
}

export const config: Config = readConfig(process.env)

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return readConfig(env)
}
