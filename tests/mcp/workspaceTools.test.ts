import { describe, expect, test } from 'bun:test'
import { DotConnectApiError } from '../../src/mcp/dotConnectClient'
import type { DotConnectClient } from '../../src/mcp/dotConnectClient'
import * as workspaceTools from '../../src/mcp/workspaceTools'

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

function textOf(result: Awaited<ReturnType<typeof workspaceTools.listWorkspaces>>): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('workspaceTools.listWorkspaces', () => {
  test('fetches GET /api/workspaces', async () => {
    const { client, calls } = fakeClient(() => [{ id: 1, name: 'my-app', path: '/a' }])
    const result = await workspaceTools.listWorkspaces(client)
    expect(calls).toEqual([{ method: 'GET', path: '/api/workspaces', body: undefined }])
    expect(JSON.parse(textOf(result))).toHaveLength(1)
  })
})

describe('workspaceTools CRUD passthrough', () => {
  test('createWorkspace POSTs to /api/workspaces with the given args', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, name: 'my-app', path: '/a' }))
    await workspaceTools.createWorkspace(client, { name: 'my-app', path: '/a' })
    expect(calls).toEqual([
      { method: 'POST', path: '/api/workspaces', body: { name: 'my-app', path: '/a' } },
    ])
  })

  test('updateWorkspace PATCHes /api/workspaces/:id with id excluded from the body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, name: 'renamed' }))
    await workspaceTools.updateWorkspace(client, { id: 7, name: 'renamed' })
    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/workspaces/7', body: { name: 'renamed' } },
    ])
  })

  test('deleteWorkspace DELETEs /api/workspaces/:id', async () => {
    const { client, calls } = fakeClient(() => ({ removed: true }))
    await workspaceTools.deleteWorkspace(client, { id: 7 })
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/workspaces/7', body: undefined }])
  })

  test('a 409 from create surfaces the API message verbatim as an isError result', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('同じ名前の作業ディレクトリが既にあります')
      },
    }
    const result = await workspaceTools.createWorkspace(client, { name: 'x', path: '/a' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('同じ名前の作業ディレクトリが既にあります')
  })

  test('a 404 from update surfaces the API message verbatim as an isError result', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('Workspace 999 not found')
      },
    }
    const result = await workspaceTools.updateWorkspace(client, { id: 999, name: 'x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Workspace 999 not found')
  })
})
