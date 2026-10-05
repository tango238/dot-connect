import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFn } from './exec'
import { BadRequestError } from '../services/errors'

// Herdr v0.9.3, commit 7b116c05bfda646af39d2524c54e70c751f57ee8:
// src/cli/agent.rs::agent_prompt reads args[0]/args[1] positionally; it
// DOES NOT consume an option separator. Global session/remote parsers run
// first and consume these reserved values anywhere in argv.
export function assertPromptTextSupported(text: string): void {
  if (text.includes('\0')) throw new BadRequestError('依頼文にNUL文字は使用できません')
  if (['--session', '--remote', '--remote-keybindings', '--handoff'].includes(text)
    || ['--session=', '--remote=', '--remote-keybindings='].some(prefix => text.startsWith(prefix))) {
    throw new BadRequestError('この依頼文はHerdr 0.9.3の予約オプションとして解釈されるため送信できません。通常の文章を先頭に加えてください。')
  }
}

export function buildPromptArgs(binary: string, target: string, text: string): string[] {
  assertPromptTextSupported(text)
  return [binary, 'agent', 'prompt', target, text]
}

const PROBE_OPTION = '--dot-connect-parser-probe'

// A deliberately invalid trailing option causes v0.9.3 to stop in its
// parser BEFORE any request. Also isolate the socket path in a fresh private
// directory, so even an unexpected parse cannot reach a live Herdr server.
// Use the SAME argv builder as delivery, otherwise this check could certify
// help while the real call uses a different, broken positional layout.
export async function verifyPromptParser(exec: ExecFn, binary: string, timeoutMs: number): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), 'dc-herdr-parser-'))
  try {
    const env = { HERDR_SOCKET_PATH: join(directory, 'absent.sock') }
    for (const text of ['-日本語 "引用" \'引用\'\n  空白 --wait', '--help', '--']) {
      const result = await exec([...buildPromptArgs(binary, 'wTEST:pTEST', text), PROBE_OPTION], { timeoutMs, env })
      if (result.exitCode !== 2 || result.stderr.trim() !== `unknown option: ${PROBE_OPTION}` || result.stdout.trim()) return false
    }
    return true
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
