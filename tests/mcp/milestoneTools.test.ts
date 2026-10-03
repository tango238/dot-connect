import { describe, expect, test } from 'bun:test'
import { DotConnectApiError } from '../../src/mcp/dotConnectClient'
import type { DotConnectClient } from '../../src/mcp/dotConnectClient'
import * as milestoneTools from '../../src/mcp/milestoneTools'

interface RecordedCall {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

function fakeClient(handler: (call: RecordedCall) => unknown): {
  client: DotConnectClient
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  return {
    calls,
    client: {
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const call = { method, path, body }
        calls.push(call)
        return handler(call) as T
      },
    },
  }
}

function textOf(result: Awaited<ReturnType<typeof milestoneTools.listMilestones>>): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('milestoneTools CRUD passthrough', () => {
  test('listMilestones GETs /api/milestones', async () => {
    const { client, calls } = fakeClient(() => [{ id: 1 }])
    await milestoneTools.listMilestones(client)
    expect(calls).toEqual([{ method: 'GET', path: '/api/milestones', body: undefined }])
  })

  test('createMilestone POSTs to /api/milestones with the given args', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1 }))
    await milestoneTools.createMilestone(client, {
      title: 'Q3',
      startDate: '2026-07-01',
      targetDate: '2026-09-30',
      labelId: 5,
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/milestones',
        body: { title: 'Q3', startDate: '2026-07-01', targetDate: '2026-09-30', labelId: 5 },
      },
    ])
  })

  test('updateMilestone PATCHes /api/milestones/:id with id excluded from the body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 3, title: 'renamed' }))
    await milestoneTools.updateMilestone(client, { id: 3, title: 'renamed' })
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/milestones/3', body: { title: 'renamed' } }])
  })

  test('completeMilestone POSTs to /api/milestones/:id/complete', async () => {
    const { client, calls } = fakeClient(() => ({ id: 3, status: 'done' }))
    await milestoneTools.completeMilestone(client, { id: 3 })
    expect(calls).toEqual([{ method: 'POST', path: '/api/milestones/3/complete', body: undefined }])
  })

  test('reopenMilestone POSTs to /api/milestones/:id/reopen', async () => {
    const { client, calls } = fakeClient(() => ({ id: 3, status: 'active' }))
    await milestoneTools.reopenMilestone(client, { id: 3 })
    expect(calls).toEqual([{ method: 'POST', path: '/api/milestones/3/reopen', body: undefined }])
  })

  test('deleteMilestone DELETEs /api/milestones/:id', async () => {
    const { client, calls } = fakeClient(() => ({ removed: true, unlinkedCount: 2 }))
    await milestoneTools.deleteMilestone(client, { id: 3 })
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/milestones/3', body: undefined }])
  })

  test('completing a milestone with unfinished todos surfaces the API message (with the remaining count folded in)', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('Milestone 3 has unfinished todos {"remaining":2}')
      },
    }
    const result = await milestoneTools.completeMilestone(client, { id: 3 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('unfinished todos')
    expect(textOf(result)).toContain('2')
  })

  test('deleting a nonexistent milestone surfaces a 404 as an isError result', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('Milestone 999 not found')
      },
    }
    const result = await milestoneTools.deleteMilestone(client, { id: 999 })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Milestone 999 not found')
  })
})
