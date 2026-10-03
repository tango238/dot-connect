import { describe, expect, test } from 'bun:test'
import { DotConnectApiError } from '../../src/mcp/dotConnectClient'
import type { DotConnectClient } from '../../src/mcp/dotConnectClient'
import * as labelTools from '../../src/mcp/labelTools'

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

function textOf(result: Awaited<ReturnType<typeof labelTools.listLabels>>): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('labelTools CRUD passthrough', () => {
  test('listLabels GETs /api/labels', async () => {
    const { client, calls } = fakeClient(() => [{ id: 1, name: 'Backend' }])
    await labelTools.listLabels(client)
    expect(calls).toEqual([{ method: 'GET', path: '/api/labels', body: undefined }])
  })

  test('createLabel POSTs to /api/labels with the given args', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, name: 'Backend' }))
    await labelTools.createLabel(client, { name: 'Backend', color: '#123456' })
    expect(calls).toEqual([
      { method: 'POST', path: '/api/labels', body: { name: 'Backend', color: '#123456' } },
    ])
  })

  test('updateLabel PATCHes /api/labels/:id with id excluded from the body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 2, name: 'renamed' }))
    await labelTools.updateLabel(client, { id: 2, name: 'renamed' })
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/labels/2', body: { name: 'renamed' } }])
  })

  test('deleteLabel DELETEs /api/labels/:id', async () => {
    const { client, calls } = fakeClient(() => ({ removed: true, unlinkedMilestones: 1 }))
    await labelTools.deleteLabel(client, { id: 2 })
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/labels/2', body: undefined }])
  })

  test('creating a duplicate-name label surfaces the API 409 message verbatim', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('同じ名前のラベルが既にあります')
      },
    }
    const result = await labelTools.createLabel(client, { name: 'Backend' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('同じ名前のラベルが既にあります')
  })
})
