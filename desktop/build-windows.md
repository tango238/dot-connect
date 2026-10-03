# Windows版のビルド手順

macOS版と同じ Tauri v2 シェル(`desktop/src-tauri`)から Windows 版をビルドする
手順。**`.msi` / `.exe` インストーラの生成は Windows 実機(または Windows VM)で
しか行えない。** TauriのバンドラがWiX/NSISというWindows専用ツールに依存している
ため、macOSからのクロスビルドはできない。

> **未検証**: 以下はmacOS版の実装とTauriの仕様から導いた手順で、Windows実機での
> 動作確認はまだ行っていない。実際にビルドしたら差分をこのファイルに反映すること。

## 前提ソフトウェア

| 必要なもの | 入手方法・備考 |
| --- | --- |
| Visual Studio Build Tools | 「C++によるデスクトップ開発」ワークロードを選択。MSVCリンカとWindows SDKが要る |
| Rustup | https://rustup.rs 。既定の `x86_64-pc-windows-msvc` ツールチェインでよい |
| Bun | https://bun.sh 。サイドカーのビルドとパッケージ取得に使う |
| WebView2 ランタイム | Windows 11 と最近の Windows 10 には標準で入っている。無い場合のみ Microsoft から導入 |
| Git for Windows | `build-sidecars.sh` を実行する Git Bash が付属する(下記) |

## 手順

### 1. 依存パッケージの取得

```bash
bun install
cd desktop && bun install
```

### 2. サイドカーのビルド

サーバーとMCPサーバーを単一実行ファイルに固めたものを、Tauriのtarget triple
命名(`-x86_64-pc-windows-msvc.exe`)で `desktop/src-tauri/binaries/` に置く。

**Windows実機でビルドする場合**(Git Bash から実行):

```bash
./desktop/build-sidecars.sh bun-windows-x64
```

**macOSでクロスコンパイルして持ち込む場合**: `bun build --compile` は
ターゲット指定でのクロスコンパイルに対応しているので、Mac側で

```bash
./desktop/build-sidecars.sh bun-windows-x64
```

を実行して生成される以下の2ファイルを、Windows側の
`desktop/src-tauri/binaries/` にコピーすればよい。

- `dot-connect-server-x86_64-pc-windows-msvc.exe`
- `dot-connect-mcp-x86_64-pc-windows-msvc.exe`

クロスコンパイルできないのはTauri本体(Rust + WiX/NSIS)だけで、サイドカーは
どちらの方法でも同じものができる。

`desktop/src-tauri/binaries/` は `.gitignore` 済みなので、cloneしただけでは
空になっている。**この手順を飛ばすと `cargo check` の時点で失敗する**
(Tauriは `externalBin` に指定したファイルの実在をビルド時に検証するため)。

### 3. バンドルのビルド

**`--bundles` の指定が必須。**

```bash
cd desktop && bun x tauri build --bundles msi,nsis
```

**`bun x tauri build` を素で叩くとインストーラが1つも生成されない。**
`tauri.conf.json` の `bundle.targets` が macOS 向けの `["app", "dmg"]` に固定
されており、Tauriは生成対象を**設定値とホストOSの両方**で絞り込むため、
Windows上では両方とも対象外になって残りがゼロになる。`--bundles` はこの設定を
上書きするので、設定ファイルには手を入れずにWindows用の生成物だけを得られる
(macOS側のビルド手順は現状のままでよい)。

生成物は `desktop/src-tauri/target/release/bundle/` 配下の以下:

- `msi/dot-connect_0.1.0_x64_en-US.msi`(WiX)
- `nsis/dot-connect_0.1.0_x64-setup.exe`(NSIS)

どちらか一方だけでよければ `--bundles msi` や `--bundles nsis` と書く。

> **フラグの検証状況**: フラグ名が `-b, --bundles`(スペース区切りまたは
> カンマ区切り)であること、`msi` / `nsis` が正しい値であることは、
> 導入済みの `@tauri-apps/cli` 2.x で確認済み。ただし `--bundles` が受け付ける
> 値は**ホストOSによって変わる**ため、macOS上で `--bundles msi,nsis` を試すと
> `invalid value 'msi' ... [possible values: ios, app, dmg]` で弾かれる。
> これはWindows上では逆に `msi` / `nsis` が有効になることを意味するが、
> **Windows実機での実行はまだ確認できていない**(上記の生成物ファイル名も
> 未確認)。

## SmartScreen(初回実行時のブロック)

コード署名証明書を持っていないため、生成したインストーラを実行すると
Microsoft Defender SmartScreen の「WindowsによってPCが保護されました」という
青い画面でブロックされる。**「詳細情報」** をクリックし、現れる
**「実行」** ボタンを押せば実行できる。

これを恒常的に避けるにはOV/EVコード署名証明書での署名が必要で、現状は
未対応。社内配布であればこの手順を案内するのが現実的。

## データの置き場所

| パス | 中身 |
| --- | --- |
| `%LOCALAPPDATA%\net.tech-square.dot-connect\dot-connect.db` | SQLite本体 |
| `%LOCALAPPDATA%\net.tech-square.dot-connect\logs\server.log` | サイドカーのstdout/stderr |

macOS版と同じく、初回起動時のみ既存DBのインポートダイアログが出る。

## herdr連携はWindowsでは自動的に無効になる

herdr は現状 macOS 版しか無いため、Windows では以下が使えない:

- TODOのherdr投入(dispatch)
- herdrセッションへのフォーカス(open-session)

これは手動設定ではなく自動判定で、`GET /api/capabilities` が
`dispatch: false` / `sessionFocus: false` を返し、フロントエンド側が該当の
操作をグレーアウトして理由を表示する(`src/services/capabilitiesService.ts`)。
`which herdr` を叩く前に `platform !== 'darwin'` で打ち切っているので、
Windowsに存在しないコマンドを探しにいくことはない。

TODO・マイルストーン・ラベル・PR紐付けといったherdrに依存しない機能は
すべて通常どおり動く。MCPサーバーの登録ボタンも `mcpBinPath` は
プラットフォームに関係なく返るため、Windowsでも表示される。
