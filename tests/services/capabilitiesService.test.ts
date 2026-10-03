import { describe, expect, test } from 'bun:test'
import type { ExecFn } from '../../src/herdr/exec'
import { detectCapabilities } from '../../src/services/capabilitiesService'

function fakeWhich(found: string[]): ExecFn {
  return async (cmd) => {
    // 期待呼び出し形: ['which', '<bin>']
    const target = cmd[1] ?? ''
    return found.includes(target)
      ? { stdout: `/usr/local/bin/${target}\n`, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 1 }
  }
}

const base = { herdrBin: 'herdr', claudeBin: 'claude', mcpBinPath: null }

describe('detectCapabilities', () => {
  test('darwin + herdr/claude あり → dispatch/sessionFocus 有効', async () => {
    const caps = await detectCapabilities(fakeWhich(['herdr', 'claude']), { ...base, platform: 'darwin' })
    expect(caps).toEqual({ dispatch: true, sessionFocus: true, mcpBinPath: null })
  })
  test('darwin + claude なし → dispatch 無効、sessionFocus は herdr のみで有効', async () => {
    const caps = await detectCapabilities(fakeWhich(['herdr']), { ...base, platform: 'darwin' })
    expect(caps.dispatch).toBe(false)
    expect(caps.sessionFocus).toBe(true)
  })
  test('darwin + herdr なし → 両方無効', async () => {
    const caps = await detectCapabilities(fakeWhich(['claude']), { ...base, platform: 'darwin' })
    expect(caps).toMatchObject({ dispatch: false, sessionFocus: false })
  })
  test('win32 → which を呼ばずに両方無効', async () => {
    let execCalled = false
    const exec: ExecFn = async () => {
      execCalled = true
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const caps = await detectCapabilities(exec, { ...base, platform: 'win32' })
    expect(caps).toMatchObject({ dispatch: false, sessionFocus: false })
    expect(execCalled).toBe(false)
  })
  test('mcpBinPath はそのまま返す', async () => {
    const caps = await detectCapabilities(fakeWhich([]), { ...base, platform: 'win32', mcpBinPath: '/x/mcp' })
    expect(caps.mcpBinPath).toBe('/x/mcp')
  })
  test('exec が throw しても両方無効で解決する', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn failed')
    }
    const caps = await detectCapabilities(exec, { ...base, platform: 'darwin' })
    expect(caps).toMatchObject({ dispatch: false, sessionFocus: false })
  })
})
