import { describe, expect, test } from 'bun:test'
import {
  LABEL_TITLE_COLUMNS,
  displayColumns,
  herdrWorkspaceLabel,
} from '../../src/services/herdrWorkspaceLabel'

describe('displayColumns', () => {
  test('全角は2カラム、半角は1カラムで数える', () => {
    expect(displayColumns('abc')).toBe(3)
    expect(displayColumns('あいう')).toBe(6)
    expect(displayColumns('漢字')).toBe(4)
    expect(displayColumns('ａｂ')).toBe(4) // 全角英字
    expect(displayColumns('a漢')).toBe(3)
  })

  test('絵文字は2カラム、サロゲートペアを割らない', () => {
    expect(displayColumns('🔥')).toBe(2)
    expect(displayColumns('a🔥b')).toBe(4)
  })

  test('半角カナは1カラム', () => {
    expect(displayColumns('ｱｲｳ')).toBe(3)
  })
})

describe('herdrWorkspaceLabel', () => {
  const todo = (id: number, title: string) => ({ id, title })

  test('短いタイトルはそのまま "#<id> <title>"', () => {
    expect(herdrWorkspaceLabel(todo(79, '高級貸出品の追加工数'))).toBe('#79 高級貸出品の追加工数')
  })

  test('日本語も英語も同じ表示幅で切る', () => {
    expect(LABEL_TITLE_COLUMNS).toBe(36)
    // 18文字 = 36カラム ちょうど。切られない。
    const exact = '脈天神のみにチェックイン時のメールに'
    expect(displayColumns(exact)).toBe(36)
    expect(herdrWorkspaceLabel(todo(78, exact))).toBe(`#78 ${exact}`)

    // 36カラムを超えたら…を付けて切る
    const long = '脈天神のみにチェックイン時のメールにアンケートURLを送付する'
    const label = herdrWorkspaceLabel(todo(78, long))
    expect(label.startsWith('#78 ')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(displayColumns(label.slice('#78 '.length, -1))).toBeLessThanOrEqual(36)

    // 英語だけのタイトルは同じ36カラムぶん、つまり倍の文字数が入る
    const english = 'a'.repeat(50)
    const englishLabel = herdrWorkspaceLabel(todo(1, english))
    expect(englishLabel).toBe(`#1 ${'a'.repeat(36)}…`)
  })

  test('切る位置が全角の途中に来ても文字を割らない', () => {
    // 35カラム目までしか入らない場合、全角1文字を丸ごと落とす
    const title = `${'a'.repeat(35)}あい`
    const label = herdrWorkspaceLabel(todo(1, title))
    expect(label).toBe(`#1 ${'a'.repeat(35)}…`)
  })

  test('絵文字で終わる位置でもサロゲートペアを割らない', () => {
    const title = `${'a'.repeat(35)}🔥🔥`
    expect(herdrWorkspaceLabel(todo(1, title))).toBe(`#1 ${'a'.repeat(35)}…`)
  })

  test('改行と連続空白は1つの半角スペースに畳む', () => {
    // ラベルに改行が入ると herdr 側の表示が崩れる
    expect(herdrWorkspaceLabel(todo(5, 'A\nB'))).toBe('#5 A B')
    expect(herdrWorkspaceLabel(todo(5, 'A   B\t\tC'))).toBe('#5 A B C')
    expect(herdrWorkspaceLabel(todo(5, '  余白つき  '))).toBe('#5 余白つき')
  })

  test('タイトルが空、または空白だけなら番号だけにする', () => {
    for (const title of ['', '   ', '\n\t']) {
      expect(herdrWorkspaceLabel(todo(42, title))).toBe('#42')
    }
  })
})

describe('herdrWorkspaceLabel の壊れやすい入力', () => {
  const todo = (id: number, title: string) => ({ id, title })
  const codePoints = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join(' ')

  test('全角スペースも半角1つに畳む', () => {
    // JS の \s は U+3000 を含む。意図した挙動なのでテストに残す。
    expect(herdrWorkspaceLabel(todo(5, 'A\u3000B'))).toBe('#5 A B')
    expect(herdrWorkspaceLabel(todo(5, '\u3000\u3000'))).toBe('#5')
  })

  test('制御文字と双方向制御はラベルに残さない', () => {
    // タイトルは herdr の一覧に描かれるので、ANSIエスケープが素通りすると
    // 他プロセスの端末描画が壊れる。
    expect(herdrWorkspaceLabel(todo(1, 'safe\u001B[31mred'))).toBe('#1 safe[31mred')
    expect(herdrWorkspaceLabel(todo(1, 'a\u007Fb'))).toBe('#1 ab')
    expect(herdrWorkspaceLabel(todo(1, 'a\u202Eb'))).toBe('#1 ab')
    expect(herdrWorkspaceLabel(todo(1, 'a\u200Bb'))).toBe('#1 ab')
  })

  test('ZWJ で繋いだ絵文字は1書記素として扱い、途中で割らない', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    expect(displayColumns(family)).toBe(2)
    // 35カラム使ったあとに幅2の書記素は入らないので、丸ごと落ちる
    const label = herdrWorkspaceLabel(todo(1, `${'a'.repeat(35)}${family}`))
    expect(label).toBe(`#1 ${'a'.repeat(35)}…`)
    expect(codePoints(label)).not.toContain('200d')
  })

  test('国旗を片割れの地域表示記号にしない', () => {
    const flag = '\u{1F1EF}\u{1F1F5}'
    expect(displayColumns(flag)).toBe(2)
    expect(herdrWorkspaceLabel(todo(1, `${'a'.repeat(35)}${flag}`))).toBe(`#1 ${'a'.repeat(35)}…`)
  })

  test('結合文字つきの仮名を2文字ぶんの幅に数えない', () => {
    // NFD の「が」。コードポイント単位で数えると幅が倍になり、意図の半分の
    // 長さで切られてしまう。
    const ga = '\u304B\u3099'
    expect(displayColumns(ga)).toBe(2)
    expect(displayColumns(ga.repeat(18))).toBe(36)
    expect(herdrWorkspaceLabel(todo(1, ga.repeat(18)))).toBe(`#1 ${ga.repeat(18)}`)
  })

  test('タイトルが何であれラベル全体の幅は有界', () => {
    // title は API 側で200文字までに制限されている(schemas.ts)。
    for (const title of ['a'.repeat(200), '漢'.repeat(200), '\u{1F525}'.repeat(200)]) {
      expect(displayColumns(herdrWorkspaceLabel(todo(12345, title)))).toBeLessThanOrEqual(44)
    }
  })
})

describe('全角判定の境界（壊れたら落ちる形で固定する）', () => {
  test('NFC正規化で範囲が化けたら落ちる', () => {
    // WIDE_PATTERN をリテラルの漢字で書くと、整形ツールが一度 NFC を掛けた
    // だけで U+F900 が U+8C48 に分解され、私用領域まで全角扱いになる。
    expect(displayColumns('\uF900')).toBe(2) // CJK互換漢字（上端の内側）
    expect(displayColumns('\uF8FF')).toBe(1) // 私用領域（外側のまま）
    expect(displayColumns('\uE0A0')).toBe(1) // Nerd Font のアイコン領域
  })

  test('半角カナと全角記号の境界', () => {
    expect(displayColumns('\uFF60')).toBe(2) // 全角記号の上端
    expect(displayColumns('\uFF61')).toBe(1) // 半角カナの下端
    expect(displayColumns('\uFF9F')).toBe(1) // 半角カナの上端
    expect(displayColumns('\uFFE0')).toBe(2) // 全角記号の再開
  })

  test('CJK拡張B以降の漢字も全角に数える', () => {
    // 𠮟 は人名・地名で実在する。BMP外なのでサロゲートペアで届く。
    expect(displayColumns('\u{20B9F}')).toBe(2)
  })

  test('異体字セレクタつきの絵文字とキーキャップも全角に数える', () => {
    // 先頭の文字だけ見る方式の唯一の穴。U+FE0F を含むクラスタは絵文字として
    // 描かれるので2カラム。
    expect(displayColumns('\u2764\uFE0F')).toBe(2) // ハート
    expect(displayColumns('\u26A0\uFE0F')).toBe(2) // 警告
    expect(displayColumns('1\uFE0F\u20E3')).toBe(2) // キーキャップ
  })
})

describe('sanitizeTitle の取りこぼし', () => {
  const todo = (id: number, title: string) => ({ id, title })

  test('NEL(U+0085)は改行と同じく空白に畳む（消して単語をくっつけない）', () => {
    expect(herdrWorkspaceLabel(todo(1, 'A\u0085B'))).toBe('#1 A B')
  })

  test('対にならない末尾のZWJは残さない', () => {
    // ZWJ は絵文字の連結に要るので落とさないが、単独で末尾に残るのは残骸。
    expect(herdrWorkspaceLabel(todo(1, 'abc\u200D'))).toBe('#1 abc')
    const label = herdrWorkspaceLabel(todo(1, 'a'.repeat(34) + 'b\u200D\u{1F468}'))
    expect(label.endsWith('\u200D…')).toBe(false)
  })
})
