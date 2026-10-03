// Detects the parent process (the Tauri desktop shell) going away. When
// launched as a child process, this server has no other reliable signal that
// its parent has crashed or been killed — stdin closing (EOF) is the one
// thing the OS guarantees when the process that owns the pipe exits. Without
// this, a crashed Tauri shell would leave this server running forever as an
// orphan.
export async function watchStdinEof(stream: ReadableStream<Uint8Array>, onEof: () => void): Promise<void> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done } = await reader.read()
      if (done) {
        onEof()
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
