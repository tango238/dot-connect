import { describe, expect, test } from 'bun:test'
import { dispatchDisabledReason, mcpAddCommand, sessionFocusDisabledReason } from '../../public/js/lib/capabilities.js'

describe('dispatchDisabledReason', () => {
  test('caps 未取得(null)は有効扱い', () => {
    expect(dispatchDisabledReason(null)).toBeNull()
  })
  test('dispatch: true は null', () => {
    expect(dispatchDisabledReason({ dispatch: true, sessionFocus: true, mcpBinPath: null })).toBeNull()
  })
  test('dispatch: false は理由文字列', () => {
    const reason = dispatchDisabledReason({ dispatch: false, sessionFocus: false, mcpBinPath: null })
    expect(typeof reason).toBe('string')
    expect(reason.length).toBeGreaterThan(0)
  })
})

describe('sessionFocusDisabledReason', () => {
  test('sessionFocus: false は理由文字列、true は null', () => {
    expect(sessionFocusDisabledReason({ dispatch: false, sessionFocus: true, mcpBinPath: null })).toBeNull()
    expect(sessionFocusDisabledReason({ dispatch: false, sessionFocus: false, mcpBinPath: null })).not.toBeNull()
  })
})

describe('mcpAddCommand', () => {
  test('mcpBinPath null → null', () => {
    expect(mcpAddCommand({ dispatch: false, sessionFocus: false, mcpBinPath: null }, 'http://127.0.0.1:5757')).toBeNull()
  })
  test('パスあり → claude mcp add コマンド文字列', () => {
    const cmd = mcpAddCommand(
      { dispatch: false, sessionFocus: false, mcpBinPath: '/Applications/dot-connect.app/Contents/MacOS/dot-connect-mcp' },
      'http://127.0.0.1:5757'
    )
    expect(cmd).toBe(
      'claude mcp add dot-connect --env DOT_CONNECT_URL=http://127.0.0.1:5757 -- "/Applications/dot-connect.app/Contents/MacOS/dot-connect-mcp"'
    )
  })

  test('スペースを含むパスは引用され、そのままコピペできる', () => {
    const cmd = mcpAddCommand(
      { dispatch: false, sessionFocus: false, mcpBinPath: 'C:\\Program Files\\dot-connect\\dot-connect-mcp.exe' },
      'http://127.0.0.1:5757'
    )
    expect(cmd).toContain('-- "C:\\Program Files\\dot-connect\\dot-connect-mcp.exe"')
  })
})
