// herdr のワークスペースにつける名前。
//
// 以前は `dc-<id>` だったが、herdr の一覧では手で作ったワークスペース(こちらは
// 作業ディレクトリ名がそのまま出る)と並ぶので、dot-connect が作ったものだけが
// 読めない番号列になっていた。TODOのタイトルを載せて、どの仕事が動いている
// のか一目で分かるようにする。
//
// 番号は残す: ログの todoId や画面のTODOと照合する手がかりがなくなるうえ、
// 先頭の `#` が「これは dot-connect が作った」という目印にもなる。

// タイトルに使える表示幅。文字数ではなくカラム数で切るのは、日本語のタイトル
// だけがラベルの倍の幅になるのを避けるため——36カラムは全角18文字ぶん、
// 半角なら36文字ぶんで、どちらも一覧の中で同じ長さに見える。
export const LABEL_TITLE_COLUMNS = 36

// 東アジアの全角文字と絵文字は2カラム、それ以外は1カラムとして数える。
// 絵文字の範囲を U+1F1E6 から始めているのは国旗のため: 🇯🇵 は地域表示記号
// (U+1F1E6-U+1F1FF)2つで1つの書記素になるので、そこを外すと国旗だけ
// 幅1として数えられる。
// 端末の桁数の話なので、正確な Unicode の East Asian Width 実装までは要らない
// ——ラベルが1〜2桁ぶれても一覧の読みやすさは変わらない。
//
// 範囲を \u エスケープで書いているのは意図的: リテラルの漢字で書くと、
// 整形ツールやエディタがファイルに一度でも NFC 正規化を掛けた瞬間に範囲が
// 黙って変わる(U+F900 `豈` は U+8C48 に分解され、私用領域や Nerd Font の
// アイコンまで全角扱いになってしまう)。
const WIDE_PATTERN =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F1E6}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u

// 端末の描画を壊す文字は落とす。タイトルは herdr の一覧に描かれるので、
// ANSIエスケープ(U+001B)が素通りすると他プロセスの画面が崩れる。双方向制御
// (U+202A-202E, U+2066-2069)は表示順を引っくり返し、0幅文字(U+200B 等)は
// 見えないのに幅として数えられる。
//
// ZWJ(U+200D)だけは残す——絵文字の連結に要るので、落とすと👨‍👩‍👧が
// バラバラの3文字になる。
const CONTROL_PATTERN =
  /[\p{Cc}\u200B\u200C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/gu

// 書記素クラスタ単位で回すための分割器。コードポイント単位だと、ZWJ で
// 繋いだ絵文字・国旗(地域表示記号2つ)・NFD の濁点つき仮名が、幅の計算でも
// 切り詰めでもバラバラに扱われる。ロケールを固定するのは、実行環境の既定
// ロケールで結果が変わらないようにするため。
const GRAPHEMES = new Intl.Segmenter('ja', { granularity: 'grapheme' })

function clusters(text: string): string[] {
  return [...GRAPHEMES.segment(text)].map((s) => s.segment)
}

// クラスタの幅は基本的に先頭の文字で決まる——後続の結合文字や ZWJ はそれ
// 自体では場所を取らない。例外は異体字セレクタ U+FE0F で、これが付くと
// 先頭が半角の記号でも絵文字として全角に描かれる(❤️ ⚠️ 1️⃣)。先頭だけを
// 見る方式の唯一の穴なので、ここで拾う。
function columnsOf(cluster: string): number {
  if (cluster.includes('\uFE0F')) {
    return 2
  }
  return WIDE_PATTERN.test([...cluster][0] ?? '') ? 2 : 1
}

/** 端末上でおおよそ何カラムを占めるか。 */
export function displayColumns(text: string): number {
  return clusters(text).reduce((total, cluster) => total + columnsOf(cluster), 0)
}

// 表示幅で切り詰める。書記素の途中では切らない——1カラム足りなければその
// 書記素ごと落とす。
function truncateToColumns(text: string, columns: number): string {
  let used = 0
  let kept = ''
  for (const cluster of clusters(text)) {
    const width = columnsOf(cluster)
    if (used + width > columns) {
      return `${stripDanglingJoiner(kept)}…`
    }
    used += width
    kept += cluster
  }
  return stripDanglingJoiner(kept)
}

// 改行やタブ、連続空白(全角スペース U+3000 を含む)を半角スペース1つに畳んで
// から、残った制御文字を落とす。順番が逆だと改行が消えて単語がくっつく。
// U+0085(NEL)を明示で足しているのは、改行系なのに JS の \s に含まれず、
// このあとの CONTROL_PATTERN で消えて単語がくっついてしまうため。
function sanitizeTitle(title: string): string {
  return title
    .replace(/[\s\u0085]+/gu, ' ')
    .replace(CONTROL_PATTERN, '')
    .trim()
}

// 対にならない ZWJ は絵文字を繋いでいないただの残骸なので、末尾に来たら
// 落とす。CONTROL_PATTERN で一律に消さないのは、絵文字の連結に要るから。
function stripDanglingJoiner(text: string): string {
  return text.replace(/\u200D+$/u, '')
}

/**
 * 例: `#79 高級貸出品の追加工数` / `#78 脈天神のみにチェックイン時のメールに…`
 * タイトルが空白だけのTODOでは番号だけ(`#42`)になる。
 */
export function herdrWorkspaceLabel(todo: { readonly id: number; readonly title: string }): string {
  const title = sanitizeTitle(todo.title)
  if (title === '') {
    return `#${todo.id}`
  }
  return `#${todo.id} ${truncateToColumns(title, LABEL_TITLE_COLUMNS)}`
}
