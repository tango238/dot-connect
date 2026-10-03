export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ExecOptions {
  readonly timeoutMs?: number
}

export type ExecFn = (cmd: string[], options?: ExecOptions) => Promise<ExecResult>

export class ExecTimeoutError extends Error {
  constructor(cmd: string[], timeoutMs: number) {
    super(`Command '${cmd.join(' ')}' timed out after ${timeoutMs}ms`)
    this.name = 'ExecTimeoutError'
  }
}

// Real process execution, isolated behind ExecFn so callers (and tests) can
// inject a fake instead of spawning real processes. herdr/claude invocations
// must always go through this seam — never call Bun.spawn directly elsewhere.
export const spawnExec: ExecFn = async (cmd, options) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const timeoutMs = options?.timeoutMs

  const resultPromise = (async (): Promise<ExecResult> => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  })()

  if (timeoutMs === undefined) {
    return resultPromise
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill()
      reject(new ExecTimeoutError(cmd, timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([resultPromise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}
