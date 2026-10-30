import { describe, expect, test } from 'bun:test'
import { renderInline, renderMarkdown } from '../../public/js/lib/markdown.js'

describe('renderInline', () => {
  test('escapes HTML before applying markup', () => {
    expect(renderInline('<b>x</b> & "y"')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;')
  })

  test('bold, italic, strike and code', () => {
    expect(renderInline('**太字** と *斜体* と _下線斜体_ と ~~取消~~ と `code`')).toBe(
      '<strong>太字</strong> と <em>斜体</em> と <em>下線斜体</em> と <del>取消</del> と <code>code</code>'
    )
  })

  test('code spans are left alone and underscores inside words are not italics', () => {
    expect(renderInline('`**not bold**` snake_case_name')).toBe('<code>**not bold**</code> snake_case_name')
  })

  test('links only for http(s) URLs, opened in a new tab', () => {
    expect(renderInline('[PR](https://github.com/a/b/pull/1)')).toBe(
      '<a href="https://github.com/a/b/pull/1" target="_blank" rel="noopener">PR</a>'
    )
    expect(renderInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))')
  })
})

describe('renderMarkdown', () => {
  test('headings of every level, with trailing hashes trimmed', () => {
    expect(renderMarkdown('# 今週の目標\n## 検索 ##\n###### 小')).toBe('<h1>今週の目標</h1><h2>検索</h2><h6>小</h6>')
  })

  test('a hash without a space is just text', () => {
    expect(renderMarkdown('#hashtag')).toBe('<p>#hashtag</p>')
  })

  test('paragraph lines are joined with <br>, blank lines split paragraphs', () => {
    expect(renderMarkdown('一行目\n二行目\n\n次の段落')).toBe('<p>一行目<br>二行目</p><p>次の段落</p>')
  })

  test('bullet and numbered lists', () => {
    expect(renderMarkdown('- a\n* b\n+ c')).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>')
    expect(renderMarkdown('1. a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })

  test('nested lists by indentation, and continuation lines', () => {
    expect(renderMarkdown('- 検索\n  - PR を出す\n  - レビュー\n- CI\n  4分以内')).toBe(
      '<ul><li>検索<ul><li>PR を出す</li><li>レビュー</li></ul></li><li>CI 4分以内</li></ul>'
    )
  })

  test('task lists render disabled checkboxes', () => {
    expect(renderMarkdown('- [ ] まだ\n- [x] 済み')).toBe(
      '<ul><li class="task"><input type="checkbox" disabled> まだ</li><li class="task done"><input type="checkbox" disabled checked> 済み</li></ul>'
    )
  })

  test('a list directly after a paragraph starts a new block', () => {
    expect(renderMarkdown('やること\n- a')).toBe('<p>やること</p><ul><li>a</li></ul>')
  })

  test('blockquotes, rules and fenced code', () => {
    expect(renderMarkdown('> 引用\n> **強調**')).toBe('<blockquote><p>引用<br><strong>強調</strong></p></blockquote>')
    expect(renderMarkdown('---')).toBe('<hr>')
    expect(renderMarkdown('```\n<tag> & *x*\n```')).toBe('<pre><code>&lt;tag&gt; &amp; *x*</code></pre>')
  })

  test('an unterminated fence still renders', () => {
    expect(renderMarkdown('```\ncode')).toBe('<pre><code>code</code></pre>')
  })

  test('empty / null input renders nothing', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
    expect(renderMarkdown('\n\n')).toBe('')
  })

  test('CRLF input is handled', () => {
    expect(renderMarkdown('# a\r\n- b')).toBe('<h1>a</h1><ul><li>b</li></ul>')
  })
})
