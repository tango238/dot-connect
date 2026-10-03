import { describe, expect, test } from 'bun:test'
import { DotConnectApiError } from '../../src/mcp/dotConnectClient'
import type { DotConnectClient } from '../../src/mcp/dotConnectClient'
import * as todoTools from '../../src/mcp/todoTools'

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

function textOf(result: Awaited<ReturnType<typeof todoTools.listTodos>>): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('todoTools.listTodos', () => {
  const allTodos = [
    { id: 1, title: 'a', status: 'open', milestoneId: 5 },
    { id: 2, title: 'b', status: 'done', milestoneId: 5 },
    { id: 3, title: 'c', status: 'open', milestoneId: null },
  ]

  test('fetches GET /api/todos and returns everything when no filter is given', async () => {
    const { client, calls } = fakeClient(() => allTodos)
    const result = await todoTools.listTodos(client, {})
    expect(calls).toEqual([{ method: 'GET', path: '/api/todos', body: undefined }])
    expect(JSON.parse(textOf(result))).toHaveLength(3)
  })

  test('filters by status client-side', async () => {
    const { client } = fakeClient(() => allTodos)
    const result = await todoTools.listTodos(client, { status: 'open' })
    const data = JSON.parse(textOf(result)) as { id: number }[]
    expect(data.map((t) => t.id)).toEqual([1, 3])
  })

  test('filters by milestoneId client-side', async () => {
    const { client } = fakeClient(() => allTodos)
    const result = await todoTools.listTodos(client, { milestoneId: 5 })
    const data = JSON.parse(textOf(result)) as { id: number }[]
    expect(data.map((t) => t.id)).toEqual([1, 2])
  })

  test('combines both filters', async () => {
    const { client } = fakeClient(() => allTodos)
    const result = await todoTools.listTodos(client, { status: 'open', milestoneId: 5 })
    const data = JSON.parse(textOf(result)) as { id: number }[]
    expect(data.map((t) => t.id)).toEqual([1])
  })

  test('turns a thrown DotConnectApiError into an isError tool result carrying its exact message', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('dot-connect API request failed (HTTP 500)')
      },
    }
    const result = await todoTools.listTodos(client, {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('dot-connect API request failed (HTTP 500)')
  })
})

describe('todoTools CRUD passthrough', () => {
  test('createTodo POSTs to /api/todos with the given args', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, title: 'x' }))
    await todoTools.createTodo(client, { title: 'x', milestoneId: 5 })
    expect(calls).toEqual([{ method: 'POST', path: '/api/todos', body: { title: 'x', milestoneId: 5 } }])
  })

  test('updateTodo PATCHes /api/todos/:id with id excluded from the body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, title: 'renamed' }))
    await todoTools.updateTodo(client, { id: 7, title: 'renamed' })
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/todos/7', body: { title: 'renamed' } }])
  })

  test('completeTodo POSTs to /api/todos/:id/complete', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, status: 'done' }))
    await todoTools.completeTodo(client, { id: 7 })
    expect(calls).toEqual([{ method: 'POST', path: '/api/todos/7/complete', body: undefined }])
  })

  test('reopenTodo POSTs to /api/todos/:id/reopen', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, status: 'open' }))
    await todoTools.reopenTodo(client, { id: 7 })
    expect(calls).toEqual([{ method: 'POST', path: '/api/todos/7/reopen', body: undefined }])
  })

  test('deleteTodo DELETEs /api/todos/:id', async () => {
    const { client, calls } = fakeClient(() => ({ removed: true }))
    await todoTools.deleteTodo(client, { id: 7 })
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/todos/7', body: undefined }])
  })

  test('a 404 from update surfaces the API message verbatim as an isError result', async () => {
    const client: DotConnectClient = {
      async request() {
        throw new DotConnectApiError('Todo 999 not found')
      },
    }
    const result = await todoTools.updateTodo(client, { id: 999, title: 'x' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Todo 999 not found')
  })
})

describe('todoTools workspacePath', () => {
  test('createTodo forwards workspacePath as-is', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, title: 'x', workspacePath: '/tmp/proj' }))
    await todoTools.createTodo(client, { title: 'x', workspacePath: '/tmp/proj' })
    expect(calls).toEqual([
      { method: 'POST', path: '/api/todos', body: { title: 'x', workspacePath: '/tmp/proj' } },
    ])
  })

  test('createTodo without workspacePath omits it from the request body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, title: 'x' }))
    await todoTools.createTodo(client, { title: 'x' })
    expect(calls).toEqual([{ method: 'POST', path: '/api/todos', body: { title: 'x' } }])
  })

  test('updateTodo forwards a new workspacePath', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, workspacePath: '/tmp/new' }))
    await todoTools.updateTodo(client, { id: 7, workspacePath: '/tmp/new' })
    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/todos/7', body: { workspacePath: '/tmp/new' } },
    ])
  })

  test('updateTodo forwards workspacePath: null to clear it', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, workspacePath: null }))
    await todoTools.updateTodo(client, { id: 7, workspacePath: null })
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/todos/7', body: { workspacePath: null } }])
  })

  test('listTodos results include workspacePath as returned by the API (pass-through)', async () => {
    const { client } = fakeClient(() => [
      { id: 1, title: 'a', status: 'open', milestoneId: null, workspacePath: '/tmp/proj' },
      { id: 2, title: 'b', status: 'open', milestoneId: null, workspacePath: null },
    ])
    const result = await todoTools.listTodos(client, {})
    const data = JSON.parse(textOf(result)) as { id: number; workspacePath: string | null }[]
    expect(data.find((t) => t.id === 1)?.workspacePath).toBe('/tmp/proj')
    expect(data.find((t) => t.id === 2)?.workspacePath).toBeNull()
  })
})

describe('todoTools model', () => {
  test('createTodo forwards model as-is', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, title: 'x', model: 'opus' }))
    await todoTools.createTodo(client, { title: 'x', model: 'opus' })
    expect(calls).toEqual([{ method: 'POST', path: '/api/todos', body: { title: 'x', model: 'opus' } }])
  })

  test('createTodo without model omits it from the request body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, title: 'x' }))
    await todoTools.createTodo(client, { title: 'x' })
    expect(calls).toEqual([{ method: 'POST', path: '/api/todos', body: { title: 'x' } }])
  })

  test('updateTodo forwards a new model', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, model: 'sonnet' }))
    await todoTools.updateTodo(client, { id: 7, model: 'sonnet' })
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/todos/7', body: { model: 'sonnet' } }])
  })

  test('updateTodo forwards model: null to clear it', async () => {
    const { client, calls } = fakeClient(() => ({ id: 7, model: null }))
    await todoTools.updateTodo(client, { id: 7, model: null })
    expect(calls).toEqual([{ method: 'PATCH', path: '/api/todos/7', body: { model: null } }])
  })

  test('listTodos results include model as returned by the API (pass-through)', async () => {
    const { client } = fakeClient(() => [
      { id: 1, title: 'a', status: 'open', milestoneId: null, model: 'haiku' },
      { id: 2, title: 'b', status: 'open', milestoneId: null, model: null },
    ])
    const result = await todoTools.listTodos(client, {})
    const data = JSON.parse(textOf(result)) as { id: number; model: string | null }[]
    expect(data.find((t) => t.id === 1)?.model).toBe('haiku')
    expect(data.find((t) => t.id === 2)?.model).toBeNull()
  })
})

describe('pull request tools', () => {
  test('addTodoPullRequest posts the URL under the todo', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, pullRequests: [] }))
    await todoTools.addTodoPullRequest(client, {
      id: 42,
      url: 'https://github.com/o/r/pull/7',
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/todos/42/pull-requests',
        body: { url: 'https://github.com/o/r/pull/7' },
      },
    ])
  })

  test('refreshTodoPullRequest posts to the refresh sub-path with no body', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, pullRequests: [] }))
    await todoTools.refreshTodoPullRequest(client, { id: 42, pullRequestId: 7 })
    expect(calls).toEqual([
      { method: 'POST', path: '/api/todos/42/pull-requests/7/refresh', body: undefined },
    ])
  })

  test('removeTodoPullRequest deletes the link, not the todo', async () => {
    const { client, calls } = fakeClient(() => ({ id: 1, pullRequests: [] }))
    await todoTools.removeTodoPullRequest(client, { id: 42, pullRequestId: 7 })
    expect(calls).toEqual([
      { method: 'DELETE', path: '/api/todos/42/pull-requests/7', body: undefined },
    ])
  })
})
