import { expect, test } from 'bun:test'
import { createHerdrRoutes } from '../../src/api/herdrRoutes'
import { createTestApp, readJson } from './testApp'
import { createHerdrCompatibilityMonitor } from '../../src/herdr/compatibility'

test('compatibility endpoints expose a cached failure and manually recheck without agent actions', async () => {
  const { deps } = createTestApp()
  const calls: string[][] = []
  const monitor = createHerdrCompatibilityMonitor(async cmd => {
    calls.push(cmd)
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }, 'herdr')
  const app = createHerdrRoutes({ ...deps, herdrCompatibility: monitor })
  for (let i = 0; i < 2; i++) {
    const result = await readJson(await app.request('/compatibility'))
    expect(result.data.status).toBe('missing')
    expect(result.data.dispatchAllowed).toBe(false)
  }
  expect(calls).toHaveLength(1)
  const result = await readJson(await app.request('/compatibility/check', { method: 'POST' }))
  expect(result.data.status).toBe('missing')
  expect(calls).toEqual([['herdr', '--version'], ['herdr', '--version']])
})
