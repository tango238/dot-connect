import { describe, expect, test } from 'bun:test'
import { watchStdinEof } from '../src/desktopLifecycle'

describe('watchStdinEof', () => {
  test('ストリームが閉じたら onEof を呼ぶ', async () => {
    let called = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })
    await watchStdinEof(stream, () => {
      called = true
    })
    expect(called).toBe(true)
  })

  test('ストリームが開いている間は onEof を呼ばない', async () => {
    let called = false
    const stream = new ReadableStream<Uint8Array>({ start() {} })
    const watching = watchStdinEof(stream, () => {
      called = true
    })
    await Bun.sleep(20)
    expect(called).toBe(false)
    void watching
  })
})
