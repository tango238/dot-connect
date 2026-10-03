import { z } from 'zod'
import type { DotConnectClient } from './dotConnectClient'
import { runTool } from './toolResult'

const colorString = z.string().regex(/^#[0-9a-fA-F]{6}$/, '#RRGGBB形式で指定してください').optional()

export const createLabelShape = {
  name: z.string().min(1).max(50).describe('ラベル名(重複不可)'),
  color: colorString,
}

export const updateLabelShape = {
  id: z.number().int().positive(),
  name: z.string().min(1).max(50).optional(),
  color: colorString,
}

export const idOnlyShape = { id: z.number().int().positive() }

export function listLabels(client: DotConnectClient) {
  return runTool(() => client.request('GET', '/api/labels'))
}

export function createLabel(client: DotConnectClient, args: { name: string; color?: string }) {
  return runTool(() => client.request('POST', '/api/labels', args))
}

export function updateLabel(
  client: DotConnectClient,
  args: { id: number; name?: string; color?: string }
) {
  const { id, ...body } = args
  return runTool(() => client.request('PATCH', `/api/labels/${id}`, body))
}

export function deleteLabel(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('DELETE', `/api/labels/${args.id}`))
}
