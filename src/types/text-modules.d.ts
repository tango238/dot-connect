// Bun's `import x from './file.md' with { type: 'text' }` — embedded into the
// compiled sidecar, so the desktop build needs no copy of the file on disk.
declare module '*.md' {
  const content: string
  export default content
}
