import { z } from 'zod'
import type { DotConnectClient } from './dotConnectClient'
import { runTool } from './toolResult'

const workspaceName = z.string().min(1).max(100).describe('作業ディレクトリの表示名(重複不可)')
const workspacePath = z
  .string()
  .min(1)
  .max(500)
  .describe('作業ディレクトリの絶対パス(先頭が "/" である必要がある)')

export const createWorkspaceShape = {
  name: workspaceName,
  path: workspacePath,
}

export const updateWorkspaceShape = {
  id: z.number().int().positive(),
  name: workspaceName.optional(),
  path: workspacePath.optional(),
}

export const idOnlyShape = { id: z.number().int().positive() }

export function listWorkspaces(client: DotConnectClient) {
  return runTool(() => client.request('GET', '/api/workspaces'))
}

export function createWorkspace(client: DotConnectClient, args: { name: string; path: string }) {
  return runTool(() => client.request('POST', '/api/workspaces', args))
}

export function updateWorkspace(
  client: DotConnectClient,
  args: { id: number; name?: string; path?: string }
) {
  const { id, ...body } = args
  return runTool(() => client.request('PATCH', `/api/workspaces/${id}`, body))
}

export function deleteWorkspace(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('DELETE', `/api/workspaces/${args.id}`))
}
