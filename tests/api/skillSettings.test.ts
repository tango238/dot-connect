import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFn } from '../../src/herdr/exec'
import skillSource from '../../skills/dot-connect/SKILL.md' with { type: 'text' }
import { createTestApp, readJson } from './testApp'

function post(app: ReturnType<typeof createTestApp>['app'], path: string) {
  return app.request(path, { method: 'POST' })
}

describe('dot-connect スキルのインストール', () => {
  test('未インストール → インストールで同梱版が書き出され installed になる', async () => {
    const claudeSkillsDir = join(mkdtempSync(join(tmpdir(), 'skills-')), 'skills')
    const { app } = createTestApp({ claudeSkillsDir })
    const path = join(claudeSkillsDir, 'dot-connect', 'SKILL.md')

    const before = await readJson(await app.request('/api/settings'))
    expect(before.data.skill).toEqual({ path, state: 'not_installed' })

    const res = await post(app, '/api/settings/skill/install')
    expect(res.status).toBe(200)
    expect((await readJson(res)).data).toEqual({ path, state: 'installed' })
    expect(readFileSync(path, 'utf8')).toBe(skillSource)
  })

  test('中身が違えば outdated、再インストールで同梱版に戻る', async () => {
    const claudeSkillsDir = join(mkdtempSync(join(tmpdir(), 'skills-')), 'skills')
    const { app } = createTestApp({ claudeSkillsDir })
    await post(app, '/api/settings/skill/install')
    writeFileSync(join(claudeSkillsDir, 'dot-connect', 'SKILL.md'), 'old')

    expect((await readJson(await app.request('/api/settings'))).data.skill.state).toBe('outdated')
    await post(app, '/api/settings/skill/install')
    expect((await readJson(await app.request('/api/settings'))).data.skill.state).toBe('installed')
  })

  test('同梱スキルは name: dot-connect の frontmatter を持つ', () => {
    expect(skillSource.startsWith('---\nname: dot-connect\ndescription: ')).toBe(true)
  })
})

describe('記録ディレクトリを Finder で開く', () => {
  test('テンプレートを用意してから open を呼ぶ(既存ファイルは上書きしない)', async () => {
    const notesDir = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes')
    const calls: string[][] = []
    const exec: ExecFn = async (argv) => {
      calls.push([...argv])
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const { app } = createTestApp({ notesDir, exec })

    const first = await post(app, '/api/settings/notes-dir/open')
    expect(first.status).toBe(200)
    expect(calls).toEqual([['open', notesDir]])
    for (const name of ['workspaces.md', 'models.md', 'history.md']) {
      expect(existsSync(join(notesDir, name))).toBe(true)
    }

    writeFileSync(join(notesDir, 'models.md'), 'mine')
    await post(app, '/api/settings/notes-dir/open')
    expect(readFileSync(join(notesDir, 'models.md'), 'utf8')).toBe('mine')
  })

  test('macOS 以外は400', async () => {
    const notesDir = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes')
    const { app } = createTestApp({ notesDir, platform: 'linux' })
    expect((await post(app, '/api/settings/notes-dir/open')).status).toBe(400)
  })

  test('GET /api/settings が notesDir を返す', async () => {
    const { app } = createTestApp({ notesDir: '/x/notes' })
    expect((await readJson(await app.request('/api/settings'))).data.notesDir).toBe('/x/notes')
  })
})
