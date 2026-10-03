import { z } from 'zod'
import type { DotConnectClient } from './dotConnectClient'
import { runTool } from './toolResult'

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD形式で指定してください')
const colorString = z.string().regex(/^#[0-9a-fA-F]{6}$/, '#RRGGBB形式で指定してください').optional()

export const createMilestoneShape = {
  title: z.string().min(1),
  description: z.string().optional(),
  color: colorString,
  startDate: dateString.describe('開始日 (YYYY-MM-DD)'),
  targetDate: dateString.describe('終了予定日 (YYYY-MM-DD、startDate以降)'),
  labelId: z.number().int().positive().nullable().optional().describe('紐づけるラベルID'),
}

export const updateMilestoneShape = {
  id: z.number().int().positive(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  color: colorString,
  startDate: dateString.optional(),
  targetDate: dateString.optional(),
  labelId: z.number().int().positive().nullable().optional().describe('null で紐付け解除'),
}

export const idOnlyShape = { id: z.number().int().positive() }

export function listMilestones(client: DotConnectClient) {
  return runTool(() => client.request('GET', '/api/milestones'))
}

export function createMilestone(
  client: DotConnectClient,
  args: {
    title: string
    description?: string
    color?: string
    startDate: string
    targetDate: string
    labelId?: number | null
  }
) {
  return runTool(() => client.request('POST', '/api/milestones', args))
}

export function updateMilestone(
  client: DotConnectClient,
  args: {
    id: number
    title?: string
    description?: string
    color?: string
    startDate?: string
    targetDate?: string
    labelId?: number | null
  }
) {
  const { id, ...body } = args
  return runTool(() => client.request('PATCH', `/api/milestones/${id}`, body))
}

// A 409 here (unfinished todos still linked) comes back from
// dotConnectClient with the API's `remaining` count folded into the error
// message, so the caller sees e.g. `... has unfinished todos {"remaining":3}`
// rather than just a bare "conflict".
export function completeMilestone(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('POST', `/api/milestones/${args.id}/complete`))
}

export function reopenMilestone(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('POST', `/api/milestones/${args.id}/reopen`))
}

export function deleteMilestone(client: DotConnectClient, args: { id: number }) {
  return runTool(() => client.request('DELETE', `/api/milestones/${args.id}`))
}
