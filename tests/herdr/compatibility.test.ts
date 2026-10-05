import { describe, expect, test } from 'bun:test'
import { createHerdrCompatibilityMonitor, HERDR_OPERATIONS } from '../../src/herdr/compatibility'
import type { ExecFn } from '../../src/herdr/exec'
import { createHerdrClient } from '../../src/herdr/herdrClient'
import { createDatabase } from '../../src/db/database'
import * as todoRepo from '../../src/db/todoRepo'
import { dispatchTodo } from '../../src/services/dispatchService'

const help: Record<string, string> = {
  snapshot: 'Usage: herdr api snapshot',
  create: 'Usage: herdr workspace create [OPTIONS]\n--cwd --label --no-focus',
  run: 'Usage: herdr pane run <PANE_ID> <COMMAND>...',
  prompt: 'Usage: herdr agent prompt <TARGET> <TEXT> [OPTIONS]',
  read: 'Usage: herdr pane read [OPTIONS] <PANE_ID>\n--source visible',
  keys: 'Usage: herdr pane send-keys <PANE_ID> <KEY>...',
  focus: 'Usage: herdr tab focus <tab_id>',
  close: 'Usage: herdr workspace close <workspace_id>',
}
function fixture() {
  let version = '0.9.3'
  let broken: string | null = null
  let error: Error | null = null
  const calls: string[][] = []
  const exec: ExecFn = async (cmd, options) => {
    calls.push(cmd)
    expect(options?.timeoutMs).toBe(3000)
    if (error) throw error
    if (cmd[1] === '--version') return { stdout: `herdr ${version}\n`, stderr: '', exitCode: 0 }
    if (cmd.at(-1) === '--dot-connect-parser-probe') {
      expect(options?.env?.HERDR_SOCKET_PATH).toEndWith('/absent.sock')
      return { stdout: '', stderr: broken === 'parser' ? 'unknown option: misplaced text' : 'unknown option: --dot-connect-parser-probe\n', exitCode: 2 }
    }
    expect(cmd.at(-1)).toBe('--help')
    const op = HERDR_OPERATIONS.find(o => o.command.join(' ') === cmd.slice(1, -1).join(' '))!
    return { stdout: op.id === broken ? 'Usage: herdr [COMMAND]' : help[op.id]!, stderr: '', exitCode: 0 }
  }
  return { exec, calls, version: (v: string) => { version = v }, break: (op: string | null) => { broken = op }, error: (e: Error | null) => { error = e } }
}

describe('Herdr compatibility checks', () => {
  test('known version requires actual command signatures and reports the evidence boundary', async () => {
    const f = fixture()
    const monitor = createHerdrCompatibilityMonitor(f.exec, '/test/herdr')
    const info = await monitor.check()
    expect(info.status).toBe('verified-parser')
    expect(info.dispatchAllowed).toBe(true)
    expect(info.promptParserVerified).toBe(true)
    expect(info.operations).toHaveLength(8)
    expect(info.latestPublishedVersion).toBeNull()
    expect(info.verifiedVersions[0].evidence).toContain('未検証')
    f.break('prompt')
    await expect(monitor.assertDispatchCompatible()).rejects.toThrow(/確認できない/)
    expect((await monitor.check()).adapter).toBeNull()
    expect(f.calls.every(c => ['--help', '--version', '--dot-connect-parser-probe'].includes(c.at(-1)!))).toBe(true)
  })

  test('unknown/prerelease/old versions never fall back to agent send', async () => {
    for (const version of ['0.9.4', '0.9.3-beta.1', '0.8.0']) {
      const f = fixture(); f.version(version)
      const monitor = createHerdrCompatibilityMonitor(f.exec, 'herdr')
      expect((await monitor.check()).status).toBe('unverified')
      await expect(monitor.assertDispatchCompatible()).rejects.toThrow(/未検証版/)
      expect(f.calls.some(c => c.includes('send'))).toBe(false)
    }
  })

  test('caches for 24 hours, coalesces probes, and rechecks on resume/manual refresh', async () => {
    const f = fixture()
    let now = Date.UTC(2026, 9, 5)
    const monitor = createHerdrCompatibilityMonitor(f.exec, 'herdr', { now: () => now })
    const first = monitor.check()
    expect(monitor.check(true)).toBe(first)
    const initial = await first
    const count = f.calls.length
    now += 23 * 3600_000
    await monitor.check()
    expect(f.calls.length).toBe(count)
    now += 2 * 3600_000 // app returns from sleep
    f.version('0.9.4')
    const updated = await monitor.check()
    expect(updated.installedVersion).toBe('0.9.4')
    expect(updated.previousVersion).toBe('0.9.3')
    expect(updated.changedAt).not.toBeNull()
    expect(updated.checkedAt).not.toBe(initial.checkedAt)
    expect(updated.dispatchAllowed).toBe(false)
    await monitor.check(true)
    expect(f.calls.length).toBe(count + 2 * (HERDR_OPERATIONS.length + 1))
  })

  test('missing, timeout/failure and malformed output revoke cached permission and can recover', async () => {
    const f = fixture()
    let now = Date.UTC(2026, 9, 5)
    const monitor = createHerdrCompatibilityMonitor(f.exec, 'herdr', { now: () => now })
    const initial = await monitor.check()
    for (const error of [Object.assign(new Error('missing'), { code: 'ENOENT' }), new Error('timeout')]) {
      f.error(error)
      const failed = await monitor.check(true)
      expect(failed.status).toBe('code' in error ? 'missing' : 'error')
      expect(failed.dispatchAllowed).toBe(false)
      expect(failed.installedVersion).toBeNull()
      expect(failed.lastSuccessfulCheckAt).toBe(initial.lastSuccessfulCheckAt)
      expect(Date.parse(failed.nextCheckAt!)).toBe(now + 60_000)
    }
    f.error(null); f.version('invalid')
    expect((await monitor.check(true)).status).toBe('error')
    now += 60_001; f.version('0.9.3')
    expect((await monitor.check()).dispatchAllowed).toBe(true)
  })

  test('startup performs a check and its timer can be stopped', async () => {
    const f = fixture()
    const monitor = createHerdrCompatibilityMonitor(f.exec, 'herdr')
    const stop = monitor.start()
    expect((await monitor.check()).checkedAt).not.toBeNull()
    stop()
  })

  test('unsupported dispatch stops before workspace creation and before prompt submission after upgrade', async () => {
    const f = fixture(); f.version('0.9.4')
    const monitor = createHerdrCompatibilityMonitor(f.exec, 'herdr')
    const client = createHerdrClient(f.exec, 'herdr', {
      assertDispatchCompatible: () => monitor.assertDispatchCompatible(),
    })
    const db = createDatabase(':memory:')
    try {
      const todo = todoRepo.create(db, { title: 'dummy', workspacePath: '/tmp' })
      await expect(dispatchTodo(db, client, todo.id, { claudeBin: 'mock' })).rejects.toThrow(/未検証版/)
      expect(todoRepo.getById(db, todo.id)?.herdrPaneId).toBeNull()
      f.version('0.9.3')
      await monitor.assertDispatchCompatible()
      f.version('0.9.4')
      await expect(client.submitPrompt('w8:p1', 'never submit')).rejects.toThrow(/未検証版/)
      expect(f.calls.every(c => ['--help', '--version', '--dot-connect-parser-probe'].includes(c.at(-1)!))).toBe(true)
    } finally { db.close() }
  })
})


test('help alone cannot authorize dispatch when the real argv parser check fails', async () => {
  const f = fixture(); f.break('parser')
  const monitor = createHerdrCompatibilityMonitor(f.exec, 'herdr')
  const info = await monitor.check()
  expect(info.operations.every(operation => operation.detected)).toBe(true)
  expect(info.promptParserVerified).toBe(false)
  expect(info.status).toBe('incompatible')
  expect(info.dispatchAllowed).toBe(false)
  await expect(monitor.assertDispatchCompatible()).rejects.toThrow(/実引数パーサー/)
})
