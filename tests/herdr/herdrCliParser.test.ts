import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnExec } from '../../src/herdr/exec'
import { createHerdrClient } from '../../src/herdr/herdrClient'
import { verifyPromptParser } from '../../src/herdr/promptArgs'

// Opt-in: HERDR_CLI_TEST_BIN=/absolute/path/to/herdr bun test this-file
// Uses the actual CLI with ONLY a fresh /tmp Unix mock. Never a real server,
// pane, agent, or user prompt. Upstream's v0.9.3 CLI tests use this same
// HERDR_SOCKET_PATH override; the pinned source is documented in README.
const binary = process.env.HERDR_CLI_TEST_BIN

test.skipIf(!binary)('actual v0.9.3 parser preserves the wire payload and rejects the old separator form', async () => {
  const version = await spawnExec([binary!, '--version'], { timeoutMs: 3000 })
  expect(version.stdout.trim()).toBe('herdr 0.9.3')
  expect(await verifyPromptParser(spawnExec, binary!, 3000)).toBe(true)
  const directory = await mkdtemp('/tmp/dc-herdr-wire-')
  const socketPath = join(directory, 'mock.sock')
  const requests: { id: string; method: string; params: { target?: string; text?: string } }[] = []
  const server = createServer(socket => {
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      data += chunk
      if (!data.includes('\n')) return
      const request = JSON.parse(data.slice(0, data.indexOf('\n')))
      requests.push(request)
      const response = request.method === 'ping'
        ? { id: request.id, result: { type: 'pong', version: '0.9.3', protocol: 22 } }
        : { id: request.id, result: { type: 'mock_success' } }
      socket.end(JSON.stringify(response) + '\n')
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    const exec = (cmd: string[]) => spawnExec(cmd, { timeoutMs: 3000, env: { HERDR_SOCKET_PATH: socketPath } })
    const client = createHerdrClient(exec, binary!)
    for (const text of ['日本語 "引用" \'引用\'\n  空白 - --wait $(echo NEVER) `never`', '-先頭ハイフン', '--wait', '--help', '--', '--session literal text']) {
      const before = requests.length
      await client.submitPrompt('wTEST:pTEST', text)
      expect(requests.slice(before).map(r => r.method)).toEqual(['ping', 'agent.prompt'])
      expect(requests.at(-1)?.params).toMatchObject({ target: 'wTEST:pTEST', text })
    }
    const before = requests.length
    const result = await exec([binary!, 'agent', 'prompt', '--', 'wTEST:pTEST', '日本語検証'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('unknown option: 日本語検証')
    expect(requests).toHaveLength(before)
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
