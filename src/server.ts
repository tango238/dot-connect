import { createHerdrCompatibilityMonitor } from './herdr/compatibility'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config, isLoopbackHost } from './config'
import { createDatabase } from './db/database'
import { watchStdinEof } from './desktopLifecycle'
import { spawnExec } from './herdr/exec'
import { createHerdrClient } from './herdr/herdrClient'
import { logger } from './logger'
import { createApiRoutes } from './api/routes'
import type { AppDependencies } from './api/dependencies'
import { detectCapabilities } from './services/capabilitiesService'
import { createClaudeRunner } from './services/claudeRunner'

export function buildDependencies(): AppDependencies {
  // Memoized so the `which herdr`/`which claude` probes run at most once per
  // process — every request after the first reuses the same resolved
  // promise rather than re-detecting.
  let cachedCapabilities: ReturnType<typeof detectCapabilities> | null = null

  const herdrCompatibility = createHerdrCompatibilityMonitor(spawnExec, config.herdrBin, {
    intervalMs: config.herdrCheckIntervalMs,
  })
  return {
    herdrCompatibility,
    db: createDatabase(config.dbPath),
    dbPath: config.dbPath,
    herdr: createHerdrClient(spawnExec, config.herdrBin, {
      assertDispatchCompatible: () => herdrCompatibility.assertDispatchCompatible(),
    }),
    claudeRunner: createClaudeRunner(spawnExec, config.claudeBin),
    exec: spawnExec,
    platform: process.platform,
    herdrBin: config.herdrBin,
    claudeBin: config.claudeBin,
    codexBin: config.codexBin,
    ghBin: config.ghBin,
    terminalApp: config.terminalApp,
    port: config.port,
    apiToken: config.apiToken,
    isLoopback: isLoopbackHost(config.host),
    allowedModels: config.allowedModels,
    mcpBinPath: config.mcpBinPath,
    capabilities: () =>
      (cachedCapabilities ??= detectCapabilities(spawnExec, {
        platform: process.platform,
        herdrBin: config.herdrBin,
        claudeBin: config.claudeBin,
        mcpBinPath: config.mcpBinPath,
      })),
  }
}

// The static UI can't hold an API token (no safe way to embed one
// client-side, and today's frontend JS relies on same-origin/CSRF trust
// rather than sending Authorization headers), so once the server is
// reachable beyond this machine it stops serving the UI entirely — serving
// an SPA that can't actually call any endpoint would just be confusing, and
// the alternative (serving it unauthenticated) defeats the whole point of
// requiring a token off loopback.
export function buildApp(deps: AppDependencies, staticDir: string = config.staticDir): Hono {
  const app = new Hono()
  app.route('/api', createApiRoutes(deps))
  if (deps.isLoopback) {
    // staticDir is absolute (see config.ts): the desktop shell passes its own
    // bundle path here, which has no relationship to this process's cwd.
    app.use('/*', serveStatic({ root: staticDir }))
  } else {
    app.get('/*', (c) =>
      c.json({ success: false, error: 'ブラウザUIは非loopbackバインドでは配信されません' }, 404)
    )
  }
  return app
}

export function buildServeOptions(
  app: Hono,
  port: number,
  hostname: string
): Bun.ServeOptions & { fetch: Hono['fetch'] } {
  return {
    port,
    hostname,
    // Bun's default idle timeout (10s) is shorter than dispatch's own
    // readiness wait (up to ~15s) and weekly report generation's claude -p
    // call (up to 120s), which would otherwise get its connection dropped
    // mid-request. 255s is Bun's own maximum.
    idleTimeout: 255,
    fetch: app.fetch,
  }
}

if (import.meta.main) {
  const deps = buildDependencies()
  deps.herdrCompatibility?.start()
  const app = buildApp(deps)

  const server = Bun.serve(buildServeOptions(app, config.port, config.host))
  // The desktop shell (Tauri) spawns this process and waits on this line to
  // learn that the server is up and which port it actually bound to, so its
  // format is a contract with that caller, not just a log line — hence
  // process.stdout.write with a fixed prefix rather than going through logger
  // (which writes to stderr).
  process.stdout.write(`LISTENING ${server.port}\n`)

  logger.info(`Using database at ${config.dbPath}`)
  logger.info(`dot-connect listening on ${config.host}:${config.port}`)
  // config.ts already refuses to start non-loopback without a token, so
  // this warning only ever fires alongside a token actually being set.
  if (!deps.isLoopback) {
    logger.warn(`Binding to a non-loopback host (${config.host}) — reachable beyond this machine`)
  }
  logger.info(`APIトークン認証: ${config.apiToken !== null ? '有効' : '無効'}`)

  if (config.desktopMode) {
    // See desktopLifecycle.ts: exits this process once the desktop shell's
    // stdin pipe closes, so a crashed/killed parent doesn't leave this
    // server running as an orphan.
    void watchStdinEof(Bun.stdin.stream(), () => process.exit(0))
  }
}
