import { describe, expect, test } from 'bun:test'
import { buildSettingsRows } from '../../public/js/lib/settingsInfo.js'

const ORIGIN = 'http://127.0.0.1:5757'
const DESKTOP_CAPS = {
  dispatch: true,
  sessionFocus: true,
  mcpBinPath: '/Applications/dot-connect.app/Contents/MacOS/dot-connect-mcp',
}
const BROWSER_CAPS = { dispatch: true, sessionFocus: true, mcpBinPath: null }

describe('buildSettingsRows', () => {
  test('ベースURLの行を必ず先頭に返す', () => {
    const rows = buildSettingsRows(BROWSER_CAPS, ORIGIN)
    expect(rows[0]).toEqual({ label: 'APIのベースURL', value: ORIGIN, copyable: true })
  })

  test('MCPパスが無ければベースURLだけ', () => {
    expect(buildSettingsRows(BROWSER_CAPS, ORIGIN).length).toBe(1)
  })

  test('MCPパスがあればコマンド行を足す', () => {
    const rows = buildSettingsRows(DESKTOP_CAPS, ORIGIN)
    expect(rows.length).toBe(2)
    expect(rows[1].label).toBe('MCP登録コマンド')
    expect(rows[1].value).toContain('claude mcp add dot-connect')
    expect(rows[1].value).toContain(ORIGIN)
    expect(rows[1].copyable).toBe(true)
  })

  test('capabilities 未取得(null)でも落ちない', () => {
    const rows = buildSettingsRows(null, ORIGIN)
    expect(rows).toEqual([{ label: 'APIのベースURL', value: ORIGIN, copyable: true }])
  })
})
