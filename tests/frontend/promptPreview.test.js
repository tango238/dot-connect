import { describe, expect, test } from 'bun:test'
import { renderPromptPreview } from '../../public/js/lib/promptPreview.js'

const values = { title: 'ログイン機能の追加', description: 'エラーハンドリングの実装' }

describe('renderPromptPreview', () => {
  test('substitutes {{title}} and {{description}}', () => {
    expect(renderPromptPreview('{{title}}: {{description}}', values)).toBe(
      'ログイン機能の追加: エラーハンドリングの実装'
    )
  })

  test('tolerates inner whitespace like {{ title }}', () => {
    expect(renderPromptPreview('{{ title }}', values)).toBe('ログイン機能の追加')
  })

  test('leaves unknown placeholders untouched', () => {
    expect(renderPromptPreview('{{title}} / {{unknown}}', values)).toBe('ログイン機能の追加 / {{unknown}}')
  })

  test('substitutes an empty description as empty text, not left as a placeholder', () => {
    expect(renderPromptPreview('desc: [{{description}}]', { title: 'x', description: '' })).toBe(
      'desc: []'
    )
  })

  test('replaces every occurrence of a repeated placeholder', () => {
    expect(renderPromptPreview('{{title}} again: {{title}}', values)).toBe(
      'ログイン機能の追加 again: ログイン機能の追加'
    )
  })

  test('returns plain text unchanged when there are no placeholders', () => {
    expect(renderPromptPreview('plain prompt text', values)).toBe('plain prompt text')
  })

  test('does not touch a single unmatched brace', () => {
    expect(renderPromptPreview('{not a placeholder}', values)).toBe('{not a placeholder}')
  })
})
