import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 既定のフィルタは2か所に書かれている: state.js の初期値と、index.html の
// aria-pressed。ずれると「押されていないチップの中身」が表示された状態で
// 一覧が開く。片方だけ直すのを防ぐため、一致をここで固定する。
const ROOT = join(import.meta.dir, '../..')

function pressedChipFilter() {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
  const chips = [...html.matchAll(/<button class="chip" data-filter="([^"]+)" aria-pressed="([^"]+)"/g)]
  return chips.filter(([, , pressed]) => pressed === 'true').map(([, filter]) => filter)
}

describe('既定のフィルタ', () => {
  test('aria-pressed が true のチップはちょうど1つ', () => {
    expect(pressedChipFilter()).toHaveLength(1)
  })

  test('state.js の初期値と index.html の押されているチップが一致する', async () => {
    const { getState } = await import('../../public/js/state.js')
    expect(pressedChipFilter()[0]).toBe(getState().filter)
  })

  test('既定は「最近の更新」で、チップの先頭に置く', () => {
    const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')
    const order = [...html.matchAll(/<button class="chip" data-filter="([^"]+)"/g)].map((m) => m[1])
    expect(order[0]).toBe('recent')
    expect(order[1]).toBe('all')
  })
})
