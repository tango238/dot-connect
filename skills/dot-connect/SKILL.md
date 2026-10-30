---
name: dot-connect
description: 依頼文・要件・メモを読んで作業を複数のTODOに分解し、各TODOのタイトル・詳細・LLMモデル・作業ディレクトリと、まとめ先のマイルストーン(新規または既存)を提案して、ユーザーの承認後にローカルの dot-connect(MCP または HTTP API)へ登録する。「dot-connect に登録して」「TODOに分解して」「タスクに切って dot-connect へ」「この依頼を TODO 化して」などと言われたとき、または依頼文を貼り付けて dot-connect への登録を求められたときに使う。登録結果と、ユーザーが直したモデル・作業ディレクトリは記録ファイルに残し、次回の提案に使う。herdr 上で動いている Claude Code セッションから「このセッションを TODO に紐づけて」「いまの作業を dot-connect の TODO にしてこのセッションを紐づけて」と言われたときも使う(そのセッションを TODO の herdr セッションとして登録する)。
---

# dot-connect: 依頼文を TODO に分解して登録する

ローカルで動いている dot-connect に、依頼文から作った複数の TODO を登録する。
**ユーザーの承認なしに登録しない。** 提案 → 承認(修正) → 登録 → 記録 の順で進める。

依頼が「このセッションを TODO に紐づけて」なら、分解はせず **手順6** に進む(接続先の決め方は手順1と同じ)。

## 1. 接続先を決める

次の順で使えるものを選ぶ。以降の手順はどちらでも同じ。

1. **MCP**: `mcp__dot-connect__create_todo` などのツールが使えるならそれを使う
   (`list_workspaces` / `list_milestones` / `create_milestone` / `update_milestone` / `create_todo` / `update_todo` / `list_labels`)。
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
- **マイルストーン**: `GET /api/milestones`(MCP なら `list_milestones`)。`status` が完了済みのものはまとめ先の候補にしない。
- **ラベル**: 新規マイルストーンを提案するときだけ `GET /api/labels`(MCP なら `list_labels`)。

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

### マイルストーンにまとめるか

分解した結果、**1つの目的のために複数の TODO で対応する**(目安: 関連する TODO が2件以上)なら、
それらをマイルストーンの子タスクとして登録することを提案する。

- **既存マイルストーンに入れる**: 未完了のマイルストーンのうち、タイトル・説明・ラベルが依頼の目的と合うものがあればそれを第一候補にする。
  期間(`targetDate`)や説明を広げる必要があれば、その更新内容も提案に含める。
- **新規マイルストーンを作る**: 合うものが無ければ新規を提案する。決めるもの:
  - タイトル(目的が一目で分かる名詞句)、説明(ゴールと完了条件)
  - `startDate`(既定は今日)と `targetDate`(依頼文の期限。無ければ TODO の量から見積もり、見積もりだと明記する)
  - ラベル(合うものがあれば。無理に付けない)
- **まとめない**: TODO が1件だけ、または互いに無関係な小さな作業の寄せ集めなら、マイルストーンは提案しない。
- 依頼文が無関係な目的を複数含むなら、目的ごとに別のマイルストーンに分けてよい。マイルストーンに入れない TODO が混ざってもよい。
- 迷うときは「まとめる案」を出したうえで、まとめないで登録する選択肢もあると添える。

提示の形(番号は登録順):

```
## マイルストーン: <タイトル>(新規 / 既存 #12)
- 期間: 2026-10-09 〜 2026-10-31(終了日は見積もり)
- ラベル: なし
- 説明: <ゴールと完了条件>
- (既存を更新する場合)変更: targetDate 2026-10-20 → 2026-10-31

### 1. <タイトル>
- モデル: sonnet(理由: 定型的なUI追加)
- 作業ディレクトリ: /Users/.../dot-connect(理由: workspaces.md の「dot-connect の機能追加」)
- 詳細:
  <詳細本文>
```

最後に「この内容で登録してよいか / 直したい点(追加・削除・統合・モデルやディレクトリの変更・マイルストーンの有無や新規/既存の切り替え)」を尋ねる。
修正を受けたら提案を作り直して再度確認する。**明確な承認が出るまで登録しない。**

## 4. 登録する

承認された内容を次の順で登録する。

1. **マイルストーン**(提案した場合のみ)
   - 新規: `create_milestone` / `POST /api/milestones`
     (`title` `description` `startDate` `targetDate`、必要なら `labelId`)。応答の `id` を控える。
   - 既存を更新: `update_milestone` / `PATCH /api/milestones/<id>` に変更する項目だけ渡す。
   - **マイルストーンの作成に失敗したら TODO の登録に進まず**、理由を伝えてどうするか尋ねる
     (マイルストーン無しで登録する / 直して再試行する)。
2. **TODO** を順に作成する。マイルストーンに入れるものには `milestoneId` を付ける。
3. 依頼文が既存の TODO をマイルストーンに入れることを求めていて、それも承認された場合は
   `update_todo` / `PATCH /api/todos/<id>` に `{"milestoneId": <id>}` を渡す。

- MCP: `create_todo` に `title` `description` `model` `workspacePath`(必要なら `milestoneId`)を渡す。
  依頼文に締切があれば `dueDate`(YYYY-MM-DD)、「10時から12時にやる」のように取り組む時間帯が
  あれば `scheduledStart` / `scheduledEnd`(`YYYY-MM-DDTHH:MM`、必ずペア・同じ日)も渡す。
- API:
  ```bash
  curl -s -X POST "$BASE/api/milestones" \
    -H "Origin: $BASE" -H "Content-Type: application/json" \
    -d '{"title":"...","description":"...","startDate":"2026-10-09","targetDate":"2026-10-31"}'

  curl -s -X POST "$BASE/api/todos" \
    -H "Origin: $BASE" -H "Content-Type: application/json" \
    -d '{"title":"...","description":"...","model":"sonnet","workspacePath":"/abs/path","milestoneId":12}'
  ```
  JSON は手で文字列連結せず、`jq -n --arg title "$T" ...` などで組み立てて改行や引用符を壊さない。
- 「要確認」のまま承認された作業ディレクトリ・未指定のモデルは、キーごと省く。
- TODO は1件失敗しても残りは続け、最後にマイルストーン(ID付き)・成功した TODO(ID付き)・失敗(理由)をまとめて報告する。

登録した TODO は dot-connect の画面に自動で反映される。herdr への投入(dispatch)はこのスキルでは行わない。

## 5. 記録する

登録後、記録ディレクトリ(手順2の `notesDir`)に書き込む。ディレクトリやファイルが無ければ作る。

- `history.md` の末尾に、登録した TODO を1件1行で追記する:
  ```
  - 2026-10-09 #123 <タイトル> | model: sonnet | dir: /abs/path | ms: #12 <マイルストーン名>
  ```
  マイルストーンに入れなかった TODO は `| ms:` を省く。
- ユーザーが提案の **モデルや作業ディレクトリを直した** ときは、次回同じ判断ができるようにルールを追記する:
  - 作業ディレクトリ → `workspaces.md` に「<作業の特徴・キーワード> → <パス>」
  - モデル → `models.md` に「<作業の種類> → <モデル>(理由)」
  - マイルストーンのまとめ方を直された(まとめる/まとめない、別の既存マイルストーンに入れた)→
    `workspaces.md` の末尾に「<作業の特徴> → マイルストーン #12 <名前> に入れる」などと追記する
  - 既存のルールと矛盾する場合は、追記せずに既存の行を書き換える。
- ユーザーが書いた既存の内容は消さない・並べ替えない。
- 何を記録したかを最後に1〜2行で伝える(設定画面の「Finderで開く」から編集できることも添える)。

## 6. herdr セッションから TODO を紐づける

herdr のペイン内で動いているこの Claude Code セッションを、dot-connect の TODO の
**herdr セッション**として登録する。紐づけると dot-connect 側で「セッションを開く」・
状態の同期・WIP の数え方・完了時のワークスペース close が、dot-connect から投入した
セッションと同じように効く。

使うとき: 「このセッションを TODO #12 に紐づけて」「いまやっている作業を TODO にして、
このセッションを紐づけて」など。手順3の分解・提案はしない(新規に作るなら1件だけ)。
手順1〜5で TODO を一括登録しているセッション(作業ディレクトリが記録ファイル置き場)は
作業セッションではないので、頼まれても紐づけず、その旨を伝える。

1. **herdr のペイン内か確かめる**: `echo "$HERDR_PANE_ID $HERDR_TAB_ID $HERDR_WORKSPACE_ID"`。
   空なら herdr のセッションではないので、紐づけられないことを伝えて止める。
2. **紐づけ先の TODO を決める**:
   - 番号やタイトルが指定されていれば `list_todos` / `GET /api/todos` で、実在し未完了で、
     まだ別のセッションを持っていない(`herdrPaneId` が null)ことを確かめる。候補が複数なら並べて選ばせる。
   - 「この作業を TODO にして」なら、会話の内容からタイトル・詳細(手順3の表の基準)と
     作業ディレクトリ(このセッションの cwd、`pwd`)を1件分提案し、承認後に
     `create_todo` / `POST /api/todos` で作る。モデルは付けない(既に動いているセッションなので)。
     マイルストーンは頼まれなければ付けない。
3. **紐づける**(TODO の ID が決まったら、確認は不要。ユーザーの依頼そのものだから):
   - MCP: `link_todo_session` に `id` だけ渡す。paneId は MCP サーバーが環境変数から取る。
     「ペインIDが分かりません」と返ったら、手順1で得た値を `paneId` `tabId` `workspaceId` に渡す。
   - API:
     ```bash
     curl -s -X POST "$BASE/api/todos/<id>/session" \
       -H "Origin: $BASE" -H "Content-Type: application/json" \
       -d "$(jq -n --arg p "$HERDR_PANE_ID" --arg t "$HERDR_TAB_ID" --arg w "$HERDR_WORKSPACE_ID" \
             '{paneId:$p, tabId:$t, workspaceId:$w}')"
     ```
   - 409 が返ったら理由をそのまま伝えて止める(`pane_in_use`: このセッションは別の TODO に
     紐づき済み / `session_alive`: その TODO は別の生きたセッションを持つ / `wip_limit_reached` /
     完了済み / Grill 中)。**勝手に外さない。** 外してよいと言われたときだけ
     `unlink_todo_session` / `DELETE /api/todos/<id>/session` で紐づけを外して(ペインは閉じない)やり直す。
4. **報告する**: TODO の ID とタイトル、「以後この TODO を完了にすると、このワークスペースが
   閉じられる(処理中・許可待ちのときは閉じない)」ことを一言添える。
   `history.md` には `- <日付> #<id> <タイトル> | linked: herdr session | dir: <cwd>` を1行追記する
   (手順5と同じファイル。新規作成した TODO は手順5の形式の行も書く)。
