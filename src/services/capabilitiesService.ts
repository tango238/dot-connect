import type { ExecFn } from '../herdr/exec'

export interface Capabilities {
  readonly dispatch: boolean
  readonly sessionFocus: boolean
  readonly mcpBinPath: string | null
}

export interface DetectCapabilitiesOptions {
  readonly platform: string
  readonly herdrBin: string
  readonly claudeBin: string
  readonly mcpBinPath: string | null
}

// herdr (and thus dispatch/session focus) only ships a macOS build today, so
// non-darwin platforms skip the `which` probes entirely rather than reporting
// a false negative from a command that doesn't exist on that OS at all.
async function which(exec: ExecFn, bin: string): Promise<boolean> {
  try {
    const result = await exec(['which', bin], { timeoutMs: 3000 })
    return result.exitCode === 0
  } catch {
    return false
  }
}

// Session focus only needs herdr (to find/focus the pane); dispatch also
// needs claude itself, since it types a prompt into a `claude` invocation.
export async function detectCapabilities(
  exec: ExecFn,
  opts: DetectCapabilitiesOptions
): Promise<Capabilities> {
  if (opts.platform !== 'darwin') {
    return { dispatch: false, sessionFocus: false, mcpBinPath: opts.mcpBinPath }
  }

  const herdrFound = await which(exec, opts.herdrBin)
  const sessionFocus = herdrFound
  const dispatch = sessionFocus && (await which(exec, opts.claudeBin))

  return { dispatch, sessionFocus, mcpBinPath: opts.mcpBinPath }
}
