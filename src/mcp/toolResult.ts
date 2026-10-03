import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResult(err: unknown): CallToolResult {
  // DotConnectApiError's message IS the dot-connect API's own error string
  // (e.g. "そのマイルストーンは既に削除されています") — passed through
  // verbatim, not reworded, so the user sees exactly what the API said.
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: message }], isError: true }
}

// Every tool handler follows the same shape: call the API, return its data
// as a tool result, or turn a thrown DotConnectApiError (or anything else)
// into an isError tool result instead of letting it become a protocol-level
// failure.
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await fn())
  } catch (err) {
    return errorResult(err)
  }
}
