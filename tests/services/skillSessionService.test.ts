import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFn } from '../../src/herdr/exec'
import type { CreatedWorkspace, HerdrClient, HerdrSnapshot } from '../../src/herdr/herdrClient'
import { ConflictError } from '../../src/services/errors'
import { installSkill } from '../../src/services/skillInstallService'
import {
  ADHOC_MARKER_FILE,
  ADHOC_SESSION_LABEL,
  createAdhocDir,
  startAdhocSession,
  SKILL_INVOCATION_TEXT,
  SKILL_SESSION_LABEL,
  type SkillSessionOptions,
  startSkillSession,
} from '../../src/services/skillSessionService'

interface Calls {
  createWorkspace: unknown[]
  runInPane: { paneId: string; command: string }[]
  submitPrompt: { paneId: string; text: string }[]
  sendText: { paneId: string; text: string }[]
  focusTab: string[]
  closeWorkspace: string[]
  exec: string[][]
}

const workspace: CreatedWorkspace = { workspaceId: 'w7', tabId: 'w7:t1', paneId: 'w7:p1' }

function idleSnapshot(): HerdrSnapshot {
  return { panes: [{ ...workspace, agentStatus: 'idle' }] }
}

const TRUST_DIALOG_TEXT = `
 Quick safety check: Is this a project you created or one you trust?

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`

function fakeClient(calls: Calls, snapshot: HerdrSnapshot = idleSnapshot()): HerdrClient {
  return {
    snapshot: async () => snapshot,
    createWorkspace: async (params) => {
      calls.createWorkspace.push(params)
      return workspace
    },
    runInPane: async (paneId, command) => {
      calls.runInPane.push({ paneId, command })
    },
    submitPrompt: async (paneId, text) => {
      calls.submitPrompt.push({ paneId, text })
    },
    sendKeys: async () => undefined,
    sendText: async (paneId, text) => {
      calls.sendText.push({ paneId, text })
    },
    readPane: async () => '',
    focusTab: async (tabId) => {
      calls.focusTab.push(tabId)
    },
    closeWorkspace: async (workspaceId) => {
      calls.closeWorkspace.push(workspaceId)
    },
  }
}

let tmp: string
let calls: Calls
let skillsDir: string
let notesDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dot-connect-skill-session-'))
  skillsDir = join(tmp, 'skills')
  notesDir = join(tmp, 'notes')
  calls = { createWorkspace: [], runInPane: [], submitPrompt: [], sendText: [], focusTab: [], closeWorkspace: [], exec: [] }
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function options(overrides: Partial<SkillSessionOptions> = {}): SkillSessionOptions {
  const exec: ExecFn = async (cmd) => {
    calls.exec.push(cmd)
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  return {
    claudeBin: 'claude',
    claudeSkillsDir: skillsDir,
    notesDir,
    terminalApp: null,
    exec,
    agentReadyTimeoutMs: 50,
    pollIntervalMs: 1,
    sleep: async () => undefined,
    settleMs: 0,
    ...overrides,
  }
}

describe('startSkillSession', () => {
  test('opens claude in the notes dir and types /dot-connect without submitting', async () => {
    installSkill(skillsDir)
    const result = await startSkillSession(fakeClient(calls), options())

    expect(result).toEqual(workspace)
    expect(calls.createWorkspace).toEqual([{ cwd: notesDir, label: SKILL_SESSION_LABEL }])
    expect(existsSync(join(notesDir, 'workspaces.md'))).toBe(true)
    expect(calls.runInPane).toEqual([{ paneId: 'w7:p1', command: 'claude' }])
    expect(calls.sendText).toEqual([{ paneId: 'w7:p1', text: SKILL_INVOCATION_TEXT }])
    expect(SKILL_INVOCATION_TEXT).toBe('/dot-connect ')
    expect(calls.submitPrompt).toHaveLength(0)
    expect(calls.focusTab).toEqual(['w7:t1'])
    expect(calls.closeWorkspace).toHaveLength(0)
  })

  test('activates the terminal app when one is configured', async () => {
    installSkill(skillsDir)
    await startSkillSession(fakeClient(calls), options({ terminalApp: 'Ghostty' }))
    expect(calls.exec).toEqual([['osascript', '-e', 'tell application "Ghostty" to activate']])
  })

  test('refuses with skill_not_installed before touching herdr', async () => {
    const err = await startSkillSession(fakeClient(calls), options()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).data).toMatchObject({ code: 'skill_not_installed' })
    expect(calls.createWorkspace).toHaveLength(0)
    expect(existsSync(notesDir)).toBe(false)
  })

  test('an outdated (hand-edited) skill is still usable', async () => {
    installSkill(skillsDir, '# edited by hand\n')
    await startSkillSession(fakeClient(calls), options())
    expect(calls.sendText).toHaveLength(1)
  })

  test('accepts the first-run trust dialog (Down, Enter) and then types /dot-connect', async () => {
    installSkill(skillsDir)
    const sendKeysCalls: string[][] = []
    const base = fakeClient(calls)
    const client: HerdrClient = {
      ...base,
      // blocked on the trust dialog until it is accepted, idle afterwards
      snapshot: async () => ({
        panes: [{ ...workspace, agentStatus: sendKeysCalls.length ? 'idle' : 'blocked' }],
      }),
      readPane: async () => (sendKeysCalls.length ? '❯ ' : TRUST_DIALOG_TEXT),
      sendKeys: async (_paneId, ...keys) => {
        sendKeysCalls.push(keys)
      },
    }

    await startSkillSession(client, options())

    expect(sendKeysCalls).toEqual([['Down', 'Enter']])
    expect(calls.sendText).toEqual([{ paneId: 'w7:p1', text: SKILL_INVOCATION_TEXT }])
  })

  test('only presses Enter when the dialog already has Yes selected', async () => {
    installSkill(skillsDir)
    const sendKeysCalls: string[][] = []
    const client: HerdrClient = {
      ...fakeClient(calls),
      snapshot: async () => ({
        panes: [{ ...workspace, agentStatus: sendKeysCalls.length ? 'idle' : 'blocked' }],
      }),
      readPane: async () => '   No, exit\n ❯ Yes, I trust this folder\n',
      sendKeys: async (_paneId, ...keys) => {
        sendKeysCalls.push(keys)
      },
    }
    await startSkillSession(client, options())
    expect(sendKeysCalls).toEqual([['Enter']])
  })

  test('leaves any other blocking dialog alone and gives up', async () => {
    installSkill(skillsDir)
    const sendKeysCalls: string[][] = []
    const client: HerdrClient = {
      ...fakeClient(calls, { panes: [{ ...workspace, agentStatus: 'blocked' }] }),
      readPane: async () => 'Do you want to allow Bash(rm -rf)?\n ❯ Yes\n   No',
      sendKeys: async (_paneId, ...keys) => {
        sendKeysCalls.push(keys)
      },
    }
    await expect(startSkillSession(client, options())).rejects.toThrow('起動を確認できませんでした')
    expect(sendKeysCalls).toHaveLength(0)
    expect(calls.closeWorkspace).toEqual(['w7'])
  })

  test('closes the workspace when claude never becomes idle', async () => {
    installSkill(skillsDir)
    const client = fakeClient(calls, { panes: [] })
    await expect(startSkillSession(client, options())).rejects.toThrow('Claude Code の起動を確認できませんでした')
    expect(calls.closeWorkspace).toEqual(['w7'])
    expect(calls.sendText).toHaveLength(0)
  })

  test('a failed focus is not an error: the session is already usable', async () => {
    installSkill(skillsDir)
    const client = { ...fakeClient(calls), focusTab: async () => { throw new Error('no tab') } }
    await expect(startSkillSession(client, options())).resolves.toEqual(workspace)
    expect(calls.closeWorkspace).toHaveLength(0)
  })
})

describe('createAdhocDir', () => {
  test('makes a fresh dir with a marker each time', () => {
    const a = createAdhocDir(tmp, new Date('2026-11-18T01:02:03Z'))
    const b = createAdhocDir(tmp)
    expect(a).not.toBe(b)
    expect(JSON.parse(readFileSync(join(a, ADHOC_MARKER_FILE), 'utf8'))).toEqual({
      kind: 'dot-connect-adhoc',
      createdAt: '2026-11-18T01:02:03.000Z',
    })
  })
})

describe('startAdhocSession', () => {
  test('opens claude in a new temp dir without typing anything', async () => {
    installSkill(skillsDir)
    const result = await startAdhocSession(fakeClient(calls), { ...options(), tempRoot: tmp })

    expect(result.workspaceId).toBe('w7')
    expect(result.cwd.startsWith(join(tmp, 'dot-connect-adhoc-'))).toBe(true)
    expect(existsSync(join(result.cwd, ADHOC_MARKER_FILE))).toBe(true)
    expect(calls.createWorkspace).toEqual([{ cwd: result.cwd, label: ADHOC_SESSION_LABEL }])
    expect(calls.runInPane).toEqual([{ paneId: 'w7:p1', command: 'claude' }])
    expect(calls.sendText).toHaveLength(0)
    expect(calls.submitPrompt).toHaveLength(0)
    expect(calls.focusTab).toEqual(['w7:t1'])
    // 作業セッションなので、スキルの記録ファイル置き場は作らない。
    expect(existsSync(notesDir)).toBe(false)
  })

  test('refuses before creating anything when the skill is missing', async () => {
    await expect(startAdhocSession(fakeClient(calls), { ...options(), tempRoot: tmp })).rejects.toBeInstanceOf(ConflictError)
    expect(calls.createWorkspace).toHaveLength(0)
  })
})
