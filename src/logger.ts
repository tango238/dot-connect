// console.log is disallowed project-wide; all logging goes through stderr here.
type LogLevel = 'info' | 'warn' | 'error'

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
}
