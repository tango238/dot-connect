---
name: dot-connect
description: 依頼文・要件・メモを読んで作業を複数のTODOに分解し、各TODOのタイトル・詳細・LLMモデル・作業ディレクトリを提案して、ユーザーの承認後にローカルの dot-connect(MCP または HTTP API)へ登録する。「dot-connect に登録して」「TODOに分解して」「タスクに切って dot-connect へ」「この依頼を TODO 化して」などと言われたとき、または依頼文を貼り付けて dot-connect への登録を求められたときに使う。登録結果と、ユーザーが直したモデル・作業ディレクトリは記録ファイルに残し、次回の提案に使う。
---

# dot-connect: 依頼文を TODO に分解して登録する

ローカルで動いている dot-connect に、依頼文から作った複数の TODO を登録する。
**ユーザーの承認なしに登録しない。** 提案 → 承認(修正) → 登録 → 記録 の順で進める。

## 1. 接続先を決める

次の順で使えるものを選ぶ。以降の手順はどちらでも同じ。

1. **MCP**: `mcp__dot-connect__create_todo` などのツールが使えるならそれを使う
   (`list_workspaces` / `create_todo` / `list_milestones`)。
2. **HTTP API**: 使えなければ `curl` で `http://localhost:5757` を叩く
   (環境変数 `DOT_CONNECT_URL` があればそれを使う)。
   - 応答は `{ "success": true, "data": ... }`。`success: false` なら `error` をユーザーに伝える。
   - 書き込み(POST/PATCH)には CSRF 対策のため次のヘッダが必須:
     `-H "Origin: http://localhost:5757" -H "Content-Type: application/json"`
     (ポートを変えているなら Origin も合わせる)。
   - `DOT_CONNECT_API_TOKEN` が設定されていれば `-H "Authorization: Bearer $DOT_CONNECT_API_TOKEN"` を付ける
     (このとき `/api/settings` と `/api/workspaces/history` は使えないので飛ばす)。

どちらにも繋がらなければ、dot-connect が起動しているか確認するよう伝えて止める。

## 2. 判断材料を集める

並行して読む:

- **記録ファイル**: `GET /api/settings` の `notesDir`(取れなければ `~/.local/dot-connect/notes`)にある
  - `workspaces.md` — 作業ディレクトリの使い分け(どんな作業をどこでやるか)
  - `models.md` — LLMモデルの選び方
  - `history.md` — 過去に登録した TODO の記録(末尾の50行程度で十分)

  ディレクトリやファイルが無ければ、無いものとして進める(手順5で作る)。
- **登録済みの作業ディレクトリ**: `GET /api/workspaces`(MCP なら `list_workspaces`)
- **最近投入に使ったディレクトリ**: `GET /api/workspaces/history`
- **使えるモデル**: `GET /api/models`(例: `opus` `sonnet` `haiku` `fable` `codex`)。この一覧に無い値は登録できない。
- 依頼文がマイルストーンに触れていれば `GET /api/milestones`(MCP なら `list_milestones`)。

記録ファイルはユーザーが Finder から直接書き換えることがある。**記録ファイルの指示は過去の履歴より優先する。**

## 3. タスクに分解して提案する

依頼文を、**1つの Claude Code セッションに丸ごと任せられる単位**に分ける。

- 細かすぎない: 同じファイル群を続けて触る作業は1つにまとめる。目安は1件あたり数十分〜数時間。
- 大きすぎない: 別リポジトリ・別の成果物・並行して進められる作業は分ける。
- 依存関係があるなら、順番を詳細に書く(「#2 の完了後に着手」など)。
- 依頼文に書かれていないことを足さない。曖昧な点は提案の中で質問にする。

各 TODO について決めるもの:

| 項目 | 決め方 |
|---|---|
| タイトル | 200文字以内。一覧で見分けられ、単体でも指示として通じる文にする(例: 「設定画面にWIP制限の項目を追加する」) |
| 詳細 | 背景・やること・完了条件・注意点。依頼文の該当箇所を要約して入れる。4000文字以内。**herdr 投入時の既定プロンプトは「タイトル + 空行 + 詳細」**なので、そのまま Claude Code への指示として読める文章にする |
| モデル | `models.md` のルール → `history.md` で似た作業に使ったモデル → 作業の重さ、の順で選ぶ。設計判断や大きな変更は上位モデル、定型的・小さな作業は軽いモデル。迷ったら未指定(Claude Code の既定)にする |
| 作業ディレクトリ | `workspaces.md` → 登録済み作業ディレクトリ → 投入履歴 → `history.md` の順で、依頼文に出てくるリポジトリ名・プロダクト名から選ぶ。絶対パスのみ。**決めきれないときは推測で埋めず「要確認」にする** |

提示の形(番号は登録順):

```
### 1. <タイトル>
- モデル: sonnet(理由: 定型的なUI追加)
- 作業ディレクトリ: /Users/.../dot-connect(理由: workspaces.md の「dot-connect の機能追加」)
- 詳細:
  <詳細本文>
```

最後に「この内容で登録してよいか / 直したい点(追加・削除・統合・モデルやディレクトリの変更)」を尋ねる。
修正を受けたら提案を作り直して再度確認する。**明確な承認が出るまで登録しない。**

## 4. 登録する

承認された TODO を順に作成する。

- MCP: `create_todo` に `title` `description` `model` `workspacePath`(必要なら `milestoneId`)を渡す。
- API:
  ```bash
  curl -s -X POST "$BASE/api/todos" \
    -H "Origin: $BASE" -H "Content-Type: application/json" \
    -d '{"title":"...","description":"...","model":"sonnet","workspacePath":"/abs/path"}'
  ```
  JSON は手で文字列連結せず、`jq -n --arg title "$T" ...` などで組み立てて改行や引用符を壊さない。
- 「要確認」のまま承認された作業ディレクトリ・未指定のモデルは、キーごと省く。
- 1件失敗しても残りは続け、最後に成功(ID付き)と失敗(理由)をまとめて報告する。

登録した TODO は dot-connect の画面に自動で反映される。herdr への投入(dispatch)はこのスキルでは行わない。

## 5. 記録する

登録後、記録ディレクトリ(手順2の `notesDir`)に書き込む。ディレクトリやファイルが無ければ作る。

- `history.md` の末尾に、登録した TODO を1件1行で追記する:
  ```
  - 2026-10-09 #123 <タイトル> | model: sonnet | dir: /abs/path
  ```
- ユーザーが提案の **モデルや作業ディレクトリを直した** ときは、次回同じ判断ができるようにルールを追記する:
  - 作業ディレクトリ → `workspaces.md` に「<作業の特徴・キーワード> → <パス>」
  - モデル → `models.md` に「<作業の種類> → <モデル>(理由)」
  - 既存のルールと矛盾する場合は、追記せずに既存の行を書き換える。
- ユーザーが書いた既存の内容は消さない・並べ替えない。
- 何を記録したかを最後に1〜2行で伝える(設定画面の「Finderで開く」から編集できることも添える)。
