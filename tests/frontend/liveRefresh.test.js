import { expect, test } from 'bun:test'
import { createLiveRefresh } from '../../public/js/lib/liveRefresh.js'

function harness(load = async () => ({ todos: [] })) {
  let editing = false
  const jobs = []
  const applied = []
  let calls = 0
  const live = createLiveRefresh({
    load: async () => { calls++; return load() },
    apply: (value) => applied.push(value),
    isEditing: () => editing,
    schedule: (job) => { jobs.push(job); return job },
    cancel: (job) => { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1) },
  })
  return { live, jobs, applied, edit: (value) => { editing = value }, calls: () => calls,
    tick: async () => { jobs.shift()?.(); for (let i = 0; i < 8; i++) await Promise.resolve() },
  }
}

test('bursts coalesce into one read; no periodic reads after catching up', async () => {
  const h = harness()
  h.live.invalidate(); h.live.invalidate(); h.live.invalidate()
  expect(h.jobs).toHaveLength(1)
  await h.tick()
  expect(h.calls()).toBe(1)
  expect(h.applied).toHaveLength(1)
  expect(h.jobs).toHaveLength(0)
})

test('draft stays intact with no network requests, then catches up on form close', async () => {
  const h = harness()
  h.edit(true); h.live.invalidate()
  await h.tick(); await h.tick()
  expect(h.calls()).toBe(0)
  expect(h.applied).toHaveLength(0)
  h.edit(false); await h.tick()
  expect(h.applied).toHaveLength(1)
})

test('a form opened during a request prevents applying its result', async () => {
  let resolve
  const h = harness(() => new Promise((r) => { resolve = r }))
  h.live.invalidate(); await h.tick()
  h.edit(true); resolve({ todos: ['old'] }); await h.tick()
  expect(h.applied).toHaveLength(0)
  h.live.stop()
})

test('in-flight invalidation discards stale data and fetches the latest once', async () => {
  let resolve
  const h = harness(() => new Promise((r) => { resolve = r }))
  h.live.invalidate(); await h.tick()
  h.live.invalidate(); h.live.invalidate()
  resolve({ todos: ['old'] }); await h.tick()
  expect(h.applied).toHaveLength(0)
  await h.tick(); resolve({ todos: ['new'] }); await h.tick()
  expect(h.applied).toEqual([{ todos: ['new'] }])
  expect(h.calls()).toBe(2)
})

test('failed fetch retries; stopping cancels queued work and late responses', async () => {
  let fail = true
  const h = harness(async () => { if (fail) throw Error('offline'); return { todos: [] } })
  h.live.invalidate(); await h.tick()
  expect(h.applied).toHaveLength(0)
  fail = false; await h.tick()
  expect(h.applied).toHaveLength(1)
  h.live.invalidate(); h.live.stop(); await h.tick()
  expect(h.calls()).toBe(2)
})
