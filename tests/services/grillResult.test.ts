import { describe, expect, test } from 'bun:test'
import { BadRequestError } from '../../src/services/errors'
import { parseGrilledResult } from '../../src/services/grillResult'

describe('parseGrilledResult', () => {
  test('reads the heading as the title and the rest as the description', () => {
    const result = parseGrilledResult('# ログインを直す\n\n## 背景\nセッションが切れる\n\n## やること\n- 延長する\n')
    expect(result).toEqual({
      title: 'ログインを直す',
      description: '## 背景\nセッションが切れる\n\n## やること\n- 延長する',
    })
  })

  test('skips leading blank lines and trims surrounding blank lines of the description', () => {
    const result = parseGrilledResult('\n\n  \n#   Title  \n\n\n\nBody\n\n\n')
    expect(result).toEqual({ title: 'Title', description: 'Body' })
  })

  test('accepts CRLF line endings and a heading with no description', () => {
    expect(parseGrilledResult('# Only title\r\n')).toEqual({ title: 'Only title', description: '' })
  })

  test('rejects a file without a heading on its first non-blank line', () => {
    expect(() => parseGrilledResult('Title\n\nBody')).toThrow(BadRequestError)
    expect(() => parseGrilledResult('## Title\n\nBody')).toThrow(BadRequestError)
  })

  test('rejects an empty file', () => {
    expect(() => parseGrilledResult('\n  \n')).toThrow(BadRequestError)
  })

  test('rejects an empty title', () => {
    expect(() => parseGrilledResult('#   \n\nBody')).toThrow(BadRequestError)
  })

  test('rejects a title over 200 characters but accepts exactly 200', () => {
    expect(parseGrilledResult(`# ${'a'.repeat(200)}`).title).toHaveLength(200)
    expect(() => parseGrilledResult(`# ${'a'.repeat(201)}`)).toThrow(BadRequestError)
  })

  test('rejects a description over 4000 characters but accepts exactly 4000', () => {
    expect(parseGrilledResult(`# T\n\n${'b'.repeat(4000)}`).description).toHaveLength(4000)
    expect(() => parseGrilledResult(`# T\n\n${'b'.repeat(4001)}`)).toThrow(BadRequestError)
  })
})
