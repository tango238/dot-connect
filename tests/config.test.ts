import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isLoopbackHost, loadConfig } from '../src/config'

// src/config.ts resolves paths relative to its own file location
// (import.meta.dir/..), which is the repo root — computed independently
// here (rather than importing a constant from config.ts) so the test
// actually exercises the same real filesystem anchor.
const PROJECT_ROOT = resolve(import.meta.dir, '..')

describe('loadConfig', () => {
  test('applies defaults when env vars are unset', () => {
    const config = loadConfig({})
    expect(config.port).toBe(5757)
    expect(config.dbPath).toBe(join(PROJECT_ROOT, 'data', 'dot-connect.db'))
    expect(config.herdrBin).toBe('herdr')
    expect(config.claudeBin).toBe('claude')
    expect(config.codexBin).toBe('codex')
    expect(config.terminalApp).toBeNull()
    expect(config.host).toBe('127.0.0.1')
    expect(config.apiToken).toBeNull()
    expect(config.allowedModels).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'codex'])
  })

  test('the default dbPath is absolute and independent of the current working directory', () => {
    const config = loadConfig({})
    expect(isAbsolute(config.dbPath)).toBe(true)
  })

  test('honors an absolute DB_PATH as-is', () => {
    const config = loadConfig({ DB_PATH: '/tmp/x.db' })
    expect(config.dbPath).toBe('/tmp/x.db')
  })

  test('resolves a relative DB_PATH against the project root, not cwd', () => {
    const config = loadConfig({ DB_PATH: 'custom/my.db' })
    expect(config.dbPath).toBe(join(PROJECT_ROOT, 'custom', 'my.db'))
  })

  test('reads overrides from env vars', () => {
    const config = loadConfig({
      PORT: '8080',
      DB_PATH: '/tmp/x.db',
      HERDR_BIN: '/opt/herdr',
      CLAUDE_BIN: '/opt/claude',
      CODEX_BIN: '/opt/codex',
      GH_BIN: '/opt/gh',
      TERMINAL_APP: 'iTerm',
      HOST: '127.0.0.1',
      DOT_CONNECT_API_TOKEN: 'secret-token',
      DOT_CONNECT_NOTES_DIR: '/tmp/notes',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
    })
    expect(config).toEqual({
      port: 8080,
      dbPath: '/tmp/x.db',
      herdrBin: '/opt/herdr',
      herdrCheckIntervalMs: 86400_000,
      claudeBin: '/opt/claude',
      codexBin: '/opt/codex',
      ghBin: '/opt/gh',
      terminalApp: 'iTerm',
      host: '127.0.0.1',
      apiToken: 'secret-token',
      allowedModels: ['opus', 'sonnet', 'haiku', 'fable', 'codex'],
      staticDir: resolve(PROJECT_ROOT, 'public'),
      desktopMode: false,
      mcpBinPath: null,
      notesDir: '/tmp/notes',
      claudeSkillsDir: '/tmp/claude/skills',
    })
  })

  test('notesDir / claudeSkillsDir default under the home directory', () => {
    const config = loadConfig({})
    expect(config.notesDir).toBe(join(homedir(), '.local', 'dot-connect', 'notes'))
    expect(config.claudeSkillsDir).toBe(join(homedir(), '.claude', 'skills'))
  })

  test('throws for a non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'not-a-number' })).toThrow()
  })

  test('throws for a non-positive PORT', () => {
    expect(() => loadConfig({ PORT: '0' })).toThrow()
  })

  test('ignores a TERMINAL_APP value with unsafe characters and treats it as unset', () => {
    const config = loadConfig({ TERMINAL_APP: 'iTerm"; do shell script "rm -rf /' })
    expect(config.terminalApp).toBeNull()
  })

  test('accepts a TERMINAL_APP value with letters, digits, spaces, dots, and hyphens', () => {
    const config = loadConfig({ TERMINAL_APP: 'Warp-Terminal 2.0' })
    expect(config.terminalApp).toBe('Warp-Terminal 2.0')
  })

  test('treats an unset DOT_CONNECT_API_TOKEN as disabled (null)', () => {
    expect(loadConfig({}).apiToken).toBeNull()
  })

  test('treats an empty/whitespace-only DOT_CONNECT_API_TOKEN as disabled (null)', () => {
    expect(loadConfig({ DOT_CONNECT_API_TOKEN: '   ' }).apiToken).toBeNull()
  })

  test('trims a DOT_CONNECT_API_TOKEN value', () => {
    expect(loadConfig({ DOT_CONNECT_API_TOKEN: '  abc123  ' }).apiToken).toBe('abc123')
  })

  test('defaults HOST to 127.0.0.1 and allows localhost/::1 without a token', () => {
    expect(loadConfig({ HOST: 'localhost' }).host).toBe('localhost')
    expect(loadConfig({ HOST: '::1' }).host).toBe('::1')
  })

  test('refuses to start on a non-loopback HOST when no API token is configured', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow()
    expect(() => loadConfig({ HOST: '192.168.1.10' })).toThrow()
  })

  test('the non-loopback refusal error names the problem clearly', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/DOT_CONNECT_API_TOKEN/)
  })

  test('allows a non-loopback HOST when an API token is configured', () => {
    const config = loadConfig({ HOST: '0.0.0.0', DOT_CONNECT_API_TOKEN: 'secret' })
    expect(config.host).toBe('0.0.0.0')
    expect(config.apiToken).toBe('secret')
  })

  test('defaults allowedModels to opus/sonnet/haiku/fable/codex', () => {
    expect(loadConfig({}).allowedModels).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'codex'])
  })

  test('overrides allowedModels from a comma-separated DOT_CONNECT_ALLOWED_MODELS', () => {
    const config = loadConfig({ DOT_CONNECT_ALLOWED_MODELS: 'opus,my-custom-model' })
    expect(config.allowedModels).toEqual(['opus', 'my-custom-model'])
  })

  test('trims whitespace and drops blank entries in DOT_CONNECT_ALLOWED_MODELS', () => {
    const config = loadConfig({ DOT_CONNECT_ALLOWED_MODELS: ' opus , , sonnet ,' })
    expect(config.allowedModels).toEqual(['opus', 'sonnet'])
  })

  test('falls back to the default list when DOT_CONNECT_ALLOWED_MODELS is empty/whitespace-only', () => {
    expect(loadConfig({ DOT_CONNECT_ALLOWED_MODELS: '   ' }).allowedModels).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
      'codex',
    ])
  })
})

describe('staticDir', () => {
  test('デフォルトは <repo>/public', () => {
    const config = loadConfig({})
    expect(config.staticDir.endsWith('/public')).toBe(true)
    expect(isAbsolute(config.staticDir)).toBe(true)
  })
  test('絶対パスの STATIC_DIR はそのまま使う', () => {
    const config = loadConfig({ STATIC_DIR: '/tmp/x/public' })
    expect(config.staticDir).toBe('/tmp/x/public')
  })
  test('相対 STATIC_DIR は PROJECT_ROOT 基準で解決する', () => {
    const config = loadConfig({ STATIC_DIR: 'public' })
    expect(isAbsolute(config.staticDir)).toBe(true)
    expect(config.staticDir.endsWith('/public')).toBe(true)
  })
})

describe('desktopMode', () => {
  test('DOT_CONNECT_DESKTOP=1 で true、それ以外は false', () => {
    expect(loadConfig({ DOT_CONNECT_DESKTOP: '1' }).desktopMode).toBe(true)
    expect(loadConfig({}).desktopMode).toBe(false)
    expect(loadConfig({ DOT_CONNECT_DESKTOP: '0' }).desktopMode).toBe(false)
  })
})

describe('mcpBinPath', () => {
  test('未設定・空文字は null、設定時はその値', () => {
    expect(loadConfig({}).mcpBinPath).toBeNull()
    expect(loadConfig({ DOT_CONNECT_MCP_BIN: '  ' }).mcpBinPath).toBeNull()
    expect(loadConfig({ DOT_CONNECT_MCP_BIN: '/Applications/dot-connect.app/Contents/MacOS/dot-connect-mcp' }).mcpBinPath)
      .toBe('/Applications/dot-connect.app/Contents/MacOS/dot-connect-mcp')
  })
})

describe('isLoopbackHost', () => {
  test('treats 127.0.0.1, localhost, and ::1 as loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  test('treats any other host as non-loopback', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

test('Herdr check interval defaults to 24h and validates overrides', () => {
  expect(loadConfig({}).herdrCheckIntervalMs).toBe(86400_000)
  expect(loadConfig({ DOT_CONNECT_HERDR_CHECK_INTERVAL_MS: '60000' }).herdrCheckIntervalMs).toBe(60000)
  for (const value of ['0', '-1', 'abc', '1.5', '2592000001']) {
    expect(() => loadConfig({ DOT_CONNECT_HERDR_CHECK_INTERVAL_MS: value })).toThrow(/CHECK_INTERVAL/)
  }
})
