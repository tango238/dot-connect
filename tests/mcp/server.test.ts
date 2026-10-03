import { describe, expect, test } from 'bun:test'
import { createDotConnectClient } from '../../src/mcp/dotConnectClient'
import { buildMcpServer, readMcpEnvConfig } from '../../src/mcp/server'

describe('readMcpEnvConfig', () => {
  test('defaults to http://127.0.0.1:5757 and no token', () => {
    const config = readMcpEnvConfig({})
    expect(config.baseUrl).toBe('http://127.0.0.1:5757')
    expect(config.apiToken).toBeNull()
  })

  test('honors DOT_CONNECT_URL and DOT_CONNECT_API_TOKEN overrides', () => {
    const config = readMcpEnvConfig({
      DOT_CONNECT_URL: 'http://127.0.0.1:9000',
      DOT_CONNECT_API_TOKEN: 'secret',
    })
    expect(config.baseUrl).toBe('http://127.0.0.1:9000')
    expect(config.apiToken).toBe('secret')
  })

  test('treats an empty/whitespace-only token as unset', () => {
    expect(readMcpEnvConfig({ DOT_CONNECT_API_TOKEN: '   ' }).apiToken).toBeNull()
  })

  test('trims the token', () => {
    expect(readMcpEnvConfig({ DOT_CONNECT_API_TOKEN: '  secret  ' }).apiToken).toBe('secret')
  })
})

describe('buildMcpServer', () => {
  // This is deliberately the only place server.ts's McpServer wiring is
  // exercised: it never connects a transport (no stdio, no real process),
  // just confirms every registerTool() call — and therefore every zod input
  // shape passed to it — is accepted by the SDK without throwing. Tool
  // *behavior* is covered directly against todoTools/milestoneTools/
  // labelTools in their own test files, without going through McpServer at
  // all.
  test('registers all tools without throwing', () => {
    const client = createDotConnectClient({ baseUrl: 'http://127.0.0.1:1', apiToken: null })
    expect(() => buildMcpServer(client)).not.toThrow()
  })
})
