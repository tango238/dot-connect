// Grill の結果ファイル GRILLED.md を TODO のタイトル・詳細に読み替える。
//
// 形式は GRILL.md(grillInstructions.md)でセッション側に指示しているもの:
// 最初の空でない行が `# <タイトル>`、その後ろすべてが詳細。上限は TODO の
// 作成・更新 API(src/api/schemas.ts)と同じにしてある —— ここを緩めると、
// API では作れない TODO が Grilled 経由でだけ作れてしまう。

import { BadRequestError } from './errors'

export const GRILLED_TITLE_MAX_LENGTH = 200
export const GRILLED_DESCRIPTION_MAX_LENGTH = 4000

export interface GrilledResult {
  readonly title: string
  readonly description: string
}

const HEADING_PATTERN = /^#[ \t]+(.*)$/

export function parseGrilledResult(text: string): GrilledResult {
  // CRLF で書かれても同じに読む。BOM も先頭の空行扱いにする。
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const headingIndex = lines.findIndex((line) => line.trim() !== '')
  if (headingIndex === -1) {
    throw new BadRequestError('GRILLED.md が空です。1行目に「# タイトル」を書いてください')
  }
  const match = HEADING_PATTERN.exec(lines[headingIndex]!.trim())
  if (match === null) {
    throw new BadRequestError('GRILLED.md の最初の行は「# タイトル」の形にしてください')
  }
  const title = match[1]!.trim()
  if (title === '') {
    throw new BadRequestError('GRILLED.md のタイトルが空です')
  }
  if (title.length > GRILLED_TITLE_MAX_LENGTH) {
    throw new BadRequestError(`GRILLED.md のタイトルが長すぎます(${GRILLED_TITLE_MAX_LENGTH}文字まで)`)
  }
  const description = lines.slice(headingIndex + 1).join('\n').trim()
  if (description.length > GRILLED_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestError(`GRILLED.md の詳細が長すぎます(${GRILLED_DESCRIPTION_MAX_LENGTH}文字まで)`)
  }
  return { title, description }
}
