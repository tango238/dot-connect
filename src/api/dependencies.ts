import type { HerdrCompatibilityMonitor } from '../herdr/compatibility'
import type { Database } from 'bun:sqlite'
import type { ExecFn } from '../herdr/exec'
import type { HerdrClient } from '../herdr/herdrClient'
import type { Capabilities } from '../services/capabilitiesService'
import type { ClaudeRunner } from '../services/claudeRunner'

export interface AppDependencies {
  readonly db: Database
  // Absolute path to the sqlite database file — used by uploadDirService to
  // derive the default attachments directory (a sibling of the db file)
  // when no upload_dir setting has been explicitly configured.
  readonly dbPath: string
  readonly herdr: HerdrClient
  readonly herdrCompatibility?: HerdrCompatibilityMonitor
  readonly claudeRunner: ClaudeRunner
  readonly exec: ExecFn
  // process.platform, injected so capabilities detection (and anything else
  // gating herdr-dependent behavior) stays testable rather than reading the
  // global directly.
  readonly platform: string
  readonly herdrBin: string
  readonly claudeBin: string
  // Launched instead of claudeBin when a dispatch's model is "codex".
  readonly codexBin: string
  // GitHub CLI binary used to look up linked PRs' titles/states.
  readonly ghBin: string
  readonly terminalApp: string | null
  readonly port: number
  // Absolute path to a bundled MCP server binary (DOT_CONNECT_MCP_BIN), or
  // null when none is configured — surfaced read-only via GET /api/capabilities
  // so the frontend can show the right MCP registration command.
  readonly mcpBinPath: string | null
  // See Config.notesDir / Config.claudeSkillsDir.
  readonly notesDir: string
  readonly claudeSkillsDir: string
  // Detects herdr/claude availability for the current platform. Called
  // lazily and cached by the caller (see server.ts's buildDependencies) so
  // the `which` probes only ever run once per process.
  readonly capabilities: () => Promise<Capabilities>
  // null disables API token auth entirely (the current, browser-only
  // behavior). When set, requests bearing a matching Bearer token bypass
  // CSRF but are restricted to the endpoint allowlist (see apiTokenAuth.ts).
  readonly apiToken: string | null
  // Whether the server is bound to a loopback address. Governs whether a
  // request with NO Authorization header may still fall back to the
  // Origin/Sec-Fetch-Site-based CSRF flow (loopback only — see the F50 fix
  // in apiTokenAuth.ts) and whether the browser UI is served at all
  // (server.ts's buildApp).
  readonly isLoopback: boolean
  // Claude Code model aliases a TODO's `model` field (and dispatch's model
  // override) may be set to — see modelValidation.ts. Checked on create/
  // update/dispatch; also exposed read-only via GET /api/models for the
  // frontend's select.
  readonly allowedModels: readonly string[]
  readonly dispatchAgentReadyTimeoutMs?: number
  readonly dispatchPollIntervalMs?: number
  readonly dispatchSleep?: (ms: number) => Promise<void>
  readonly dispatchSettleMs?: number
  readonly dispatchDeliveryConfirmTimeoutMs?: number
}
