import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { buildApp, buildServeOptions } from '../src/server'
import { createTestApp } from './api/testApp'

describe('buildApp static serving', () => {
  test('絶対パスの staticDir から index.html を配信する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-static-'))
    writeFileSync(join(dir, 'index.html'), '<html>desktop-test</html>')
    const { deps } = createTestApp()
    const app = buildApp(deps, dir)
    const res = await app.request('/index.html')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('desktop-test')
  })

  test('非loopbackでは静的配信しない(既存挙動の維持)', async () => {
    const { deps } = createTestApp({ isLoopback: false })
    const app = buildApp(deps, '/nonexistent')
    const res = await app.request('/index.html')
    expect(res.status).toBe(404)
  })
})

describe('buildServeOptions', () => {
  test('binds to the given hostname', () => {
    const options = buildServeOptions(new Hono(), 5757, '127.0.0.1')
    expect(options.hostname).toBe('127.0.0.1')
  })

  test('honors a non-default hostname (e.g. for LAN binding with a token configured)', () => {
    const options = buildServeOptions(new Hono(), 5757, '0.0.0.0')
    expect(options.hostname).toBe('0.0.0.0')
  })

  test('uses the requested port', () => {
    const options = buildServeOptions(new Hono(), 6001, '127.0.0.1')
    expect(options.port).toBe(6001)
  })

  test('sets idleTimeout to 255s (Bun max), well above dispatch (~15s) and report generation (~120s)', () => {
    const options = buildServeOptions(new Hono(), 5757, '127.0.0.1')
    expect(options.idleTimeout).toBe(255)
  })
})
