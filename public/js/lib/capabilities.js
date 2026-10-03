// Pure reads of GET /api/capabilities: no DOM, no state access, so the
// "can this environment do X?" rules stay unit-testable like the other
// modules under lib/.

// The API reports only *whether* a capability is available, never why — a
// missing herdr binary and an unsupported OS both arrive as `false`. So one
// message covers both cases rather than guessing at a cause we can't see.
const UNAVAILABLE = 'この環境では herdr/claude が見つからないため利用できません'

/**
 * Why the dispatch action is unavailable, or null when it's usable.
 * `caps === null` means the capabilities fetch hasn't landed (or failed):
 * treated as usable so a hiccup never greys out a working environment.
 * @returns {string | null}
 */
export function dispatchDisabledReason(caps) {
  if (caps === null || caps === undefined) return null
  return caps.dispatch ? null : UNAVAILABLE
}

/** Same contract as dispatchDisabledReason, for focusing a herdr session. */
export function sessionFocusDisabledReason(caps) {
  if (caps === null || caps === undefined) return null
  return caps.sessionFocus ? null : UNAVAILABLE
}

/**
 * The `claude mcp add` command registering this running instance as an MCP
 * server, or null when no MCP binary ships with this build (the plain
 * `bun run` server) and there is nothing to register.
 * @returns {string | null}
 */
export function mcpAddCommand(caps, origin) {
  const binPath = caps?.mcpBinPath
  if (!binPath) return null
  // Quoted because the bundled path can contain spaces (C:\Program Files\…);
  // double quotes are the one form both zsh and PowerShell read the same way.
  return `claude mcp add dot-connect --env DOT_CONNECT_URL=${origin} -- "${binPath}"`
}
