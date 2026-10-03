use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DB_FILE: &str = "dot-connect.db";
const PREFERRED_PORT: u16 = 5757;
const STARTUP_TIMEOUT_SECS: u64 = 15;

type StartupResult<T> = Result<T, Box<dyn std::error::Error>>;

// サイドカーの生殺与奪。tauri-plugin-shell が RunEvent::Exit で片付けてくれるのは
// JS の IPC 経由で spawn された子だけで、Rust 側の Command::spawn() の子は追跡され
// ない。ここで保持して終了時に明示的に kill する。
// あわせて、CommandChild が stdin の書き込み側を保持している点も重要
// (サイドカーは stdin EOF でも自走終了する)ので、生存中はドロップさせない。
// kill(self) が値を消費するため Option に入れて take できるようにしている。
struct ServerProcess(Mutex<Option<CommandChild>>);

fn kill_server(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerProcess>() else {
        return;
    };
    let child = state.0.lock().ok().and_then(|mut guard| guard.take());
    if let Some(child) = child {
        let _ = child.kill();
    }
}

// 5757 が空いていればそれを、塞がっていれば OS が割り当てる空きポートを使う。
// PORT=0 をサーバーに渡さないのは、CSRF ミドルウェアが構築時に確定ポートで
// 許可 Origin を組むため(仕様書参照)。
fn pick_port() -> u16 {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        drop(l);
        return PREFERRED_PORT;
    }
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("no free port");
    l.local_addr().expect("local_addr").port()
}

// 初回起動時のみ: 既存 DB のインポートを提案し、選ばれたら .db / -wal / -shm を
// サーバー起動前にコピーする(WAL は次回オープン時に SQLite が正常回復する)。
// blocking 系ダイアログはメインスレッドから呼ぶとデッドロックするため、
// 呼び出しはワーカースレッドからに限る。
fn maybe_import_db(app: &AppHandle, db_path: &Path) -> StartupResult<()> {
    if db_path.exists() {
        return Ok(());
    }
    let import = app
        .dialog()
        .message("既存の dot-connect.db をインポートしますか?\n(リポジトリ運用時の data/dot-connect.db など)")
        .title("dot-connect 初回起動")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "インポート".to_string(),
            "新規で始める".to_string(),
        ))
        .blocking_show();
    if !import {
        return Ok(());
    }
    let picker = app.dialog().file().add_filter("SQLite", &["db"]);
    let Some(picked) = picker.blocking_pick_file() else {
        return Ok(());
    };
    let src = picked.into_path()?;
    // 失敗したら中途半端な .db を消す。残すと次回起動が「初回」と見なされず、
    // 空の DB のまま二度とインポートを提案できなくなる。
    if let Err(e) = fs::copy(&src, db_path) {
        let _ = fs::remove_file(db_path);
        return Err(format!(
            "DB のインポートに失敗しました。\n{} → {}\n{e}",
            src.display(),
            db_path.display()
        )
        .into());
    }
    // -wal / -shm は無くても SQLite が回復できるので、失敗しても続行する。
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{}", src.display(), suffix));
        if side.exists() {
            let _ = fs::copy(&side, format!("{}{}", db_path.display(), suffix));
        }
    }
    Ok(())
}

// Finder / Dock から起動されたアプリが継承するのは launchd の最小 PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) で、ログインシェルの PATH ではない。
// herdr や claude は /opt/homebrew/bin や ~/.local/bin にしか無いため、
// そのままサイドカーに渡すと `which herdr` も spawn も失敗する。
// ログインシェルに PATH を問い合わせ、現在の PATH と既知の場所にマージして渡す。
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(shell)
        // command printf は組み込み echo の解釈差を避けるため。
        .args(["-l", "-c", r#"command printf '%s' "$PATH""#])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // 対話設定を読み込むシェルは詰まることがあるので上限を切る。PATH は
    // パイプバッファに収まるサイズなので、待ってから読んでも詰まらない。
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // 起動に失敗したシェルは空や 1 行のエラーを返す。PATH らしくなければ捨てる。
    (!path.is_empty() && path.contains('/')).then_some(path)
}

// 既知の安全網ディレクトリ(/opt/homebrew/bin, /usr/local/bin, ~/.local/bin)を
// 先頭に置いてからログインシェルの PATH・継承した PATH をマージする。
// かつては安全網を末尾に足していたが、ログインシェルの PATH に同名のツールを
// 解決する古いエントリ(例: nvm がエクスポートする node の bin)が安全網より
// 前に来ていると、末尾の安全網は絶対に勝てない——ログインシェルの PATH が
// 信用できない時のための安全網なのに、まさにその状況で無力化されていた
// (実例: nvm の node18 bin にある古い claude-code の JS バンドルが
// ~/.local/bin/claude のネイティブバイナリより先に解決され、動作しない
// バンドルでサイドカーが起動してクラッシュしていた)。安全網を先頭にすれば、
// ログインシェルのどのエントリより優先して解決されるようになる。
// 重複排除は「最初に出てきたものが勝つ」方式のままなので、含まれるディレクトリ
// の集合は変わらず、優先順位だけが変わる。
#[cfg(unix)]
fn merge_sidecar_path(login_shell_path: Option<&str>, inherited_path: Option<&str>) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let known = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];
    let sources = known
        .into_iter()
        .chain(login_shell_path.map(str::to_string))
        .chain(inherited_path.map(str::to_string));

    let mut dirs: Vec<String> = Vec::new();
    for dir in sources.flat_map(|s| {
        s.split(':')
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    }) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

#[cfg(unix)]
fn resolve_sidecar_path() -> String {
    merge_sidecar_path(
        login_shell_path().as_deref(),
        std::env::var("PATH").ok().as_deref(),
    )
}

fn error_exit(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .title("dot-connect 起動エラー")
        .blocking_show();
    app.exit(1);
}

fn open_main_window(app: &AppHandle, port: u16) -> StartupResult<()> {
    let url: tauri::Url = format!("http://127.0.0.1:{port}").parse()?;
    let (tx, rx) = mpsc::channel::<Option<String>>();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
            .title("dot-connect")
            .inner_size(1280.0, 860.0)
            .build();
        let _ = tx.send(result.err().map(|e| e.to_string()));
    })?;
    match rx.recv() {
        Ok(None) => Ok(()),
        Ok(Some(e)) => Err(format!("ウィンドウの作成に失敗しました: {e}").into()),
        Err(e) => Err(format!("ウィンドウの作成結果を受け取れませんでした: {e}").into()),
    }
}

fn start_server(app: &AppHandle) -> StartupResult<()> {
    let data_dir = app.path().app_local_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let logs_dir = data_dir.join("logs");
    fs::create_dir_all(&logs_dir)?;
    let log_path = logs_dir.join("server.log");

    let db_path = data_dir.join(DB_FILE);
    maybe_import_db(app, &db_path)?;

    let static_dir = app.path().resolve("public", BaseDirectory::Resource)?;
    // The bundled sidecar keeps its platform extension, so looking for the
    // bare name on Windows finds nothing and the MCP button never appears.
    let mcp_name = if cfg!(windows) {
        "dot-connect-mcp.exe"
    } else {
        "dot-connect-mcp"
    };
    let mcp_bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(mcp_name)))
        .filter(|p| p.exists());
    let port = pick_port();

    let mut cmd = app
        .shell()
        .sidecar("dot-connect-server")?
        .env("DB_PATH", db_path.to_string_lossy().to_string())
        .env("STATIC_DIR", static_dir.to_string_lossy().to_string())
        .env("PORT", port.to_string())
        .env("DOT_CONNECT_DESKTOP", "1");
    if let Some(mcp) = mcp_bin {
        cmd = cmd.env("DOT_CONNECT_MCP_BIN", mcp.to_string_lossy().to_string());
    }
    #[cfg(unix)]
    {
        cmd = cmd.env("PATH", resolve_sidecar_path());
    }
    let (mut rx, child) = cmd.spawn()?;
    app.manage(ServerProcess(Mutex::new(Some(child))));

    let (ready_tx, ready_rx) = mpsc::channel::<u16>();
    let pump_log_path = log_path.clone();
    tauri::async_runtime::spawn(async move {
        let mut log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&pump_log_path)
            .ok();
        while let Some(event) = rx.recv().await {
            let line = match &event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    String::from_utf8_lossy(b).to_string()
                }
                CommandEvent::Error(e) => format!("[error: {e}]"),
                CommandEvent::Terminated(t) => {
                    format!("[terminated: code={:?} signal={:?}]", t.code, t.signal)
                }
                _ => continue,
            };
            if let Some(log) = log.as_mut() {
                let _ = writeln!(log, "{line}");
            }
            if let Some(rest) = line.trim().strip_prefix("LISTENING ") {
                if let Ok(p) = rest.trim().parse::<u16>() {
                    let _ = ready_tx.send(p);
                }
            }
        }
    });

    let actual_port = ready_rx
        .recv_timeout(Duration::from_secs(STARTUP_TIMEOUT_SECS))
        .map_err(|_| {
            format!(
                "サーバーの起動を確認できませんでした。\nログ: {}",
                log_path.display()
            )
        })?;

    open_main_window(app, actual_port)
}

// 既定メニュー(Tauri が macOS 向けに自動で入れているもの)を土台にする。
// .menu() を呼んだ時点で既定は置き換わるので、自前で組み直すと ⌘Q / ⌘C /
// ⌘V / ⌘Z やウィンドウ操作を再現し損ねる。足すだけに留める。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let settings = MenuItem::with_id(app, "settings", "設定…", true, Some("CmdOrCtrl+,"))?;
    let regenerate = MenuItem::with_id(
        app,
        "regenerate-report",
        "週次レポートを再生成",
        true,
        None::<&str>,
    )?;
    let choose_upload_dir = MenuItem::with_id(
        app,
        "choose-upload-dir",
        "アップロード先フォルダを選択…",
        true,
        None::<&str>,
    )?;
    let reload = MenuItem::with_id(app, "reload", "リロード", true, Some("CmdOrCtrl+R"))?;

    let mut in_file = false;
    let mut in_view = false;
    for item in menu.items()? {
        let Some(submenu) = item.as_submenu() else {
            continue;
        };
        match submenu.text()?.as_str() {
            "File" => {
                submenu.append(&PredefinedMenuItem::separator(app)?)?;
                submenu.append(&settings)?;
                submenu.append(&regenerate)?;
                submenu.append(&choose_upload_dir)?;
                in_file = true;
            }
            "View" => {
                submenu.append(&PredefinedMenuItem::separator(app)?)?;
                submenu.append(&reload)?;
                in_view = true;
            }
            _ => {}
        }
    }

    // 既定メニューの構成が変わって File / View が見つからない場合でも、行き場を
    // 失った項目は必ず届くようにする——メニューが消えるより不格好な方がましなので。
    let mut orphans: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    if !in_file {
        orphans.push(&settings);
        orphans.push(&regenerate);
        orphans.push(&choose_upload_dir);
    }
    if !in_view {
        orphans.push(&reload);
    }
    if !orphans.is_empty() {
        menu.append(&Submenu::with_items(app, "dot-connect", true, &orphans)?)?;
    }
    Ok(menu)
}

// 選んだパスは eval に渡す JS の二重引用符文字列リテラルに埋め込むので、
// リテラルを閉じたり壊したりしうる文字を潰してから入れる。パス名に " や \
// や改行が入るのは(見た目は異様でも)正当で、macOS がファイル名で禁じて
// いるのは / と NUL だけ。素で埋めると `"` ひとつでリテラルが閉じ、以降が
// コードとして評価される。U+2028 / U+2029 は古い JS エンジンでは文字列中
// でも行終端子として扱われるため、あわせてエスケープする。
fn escape_js_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => out.push(ch),
        }
    }
    out
}

// blocking 系ダイアログはメインスレッドから呼ぶとデッドロックする
// (maybe_import_db と同じ理由: 表示要求を処理するイベントループ自体を塞ぐ)。
// メニューイベントはメインスレッドで届くので、ここでワーカーに逃がす。
// eval 自体はどのスレッドからでもイベントループにディスパッチされる。
fn choose_upload_dir(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(picked) = app.dialog().file().blocking_pick_folder() else {
            return;
        };
        let Ok(path) = picked.into_path() else {
            return;
        };
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let script = format!(
            "window.__dotConnect?.setUploadDir?.(\"{}\")",
            escape_js_string(&path.to_string_lossy())
        );
        let _ = window.eval(script);
    });
}

pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            // フォルダ選択だけは eval の前にネイティブダイアログを挟むので、
            // 素通しの一方向シグナルとは別扱いにする。
            if event.id().as_ref() == "choose-upload-dir" {
                choose_upload_dir(app.clone());
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            // ページはリモート origin で IPC を持たないので、eval が唯一の一方向
            // チャネル。?. を挟むのは、ロード完了前に届いた場合にページ側で例外を
            // 投げさせないため。
            let script = match event.id().as_ref() {
                "settings" => "window.__dotConnect?.openSettings?.()",
                "regenerate-report" => "window.__dotConnect?.regenerateWeeklyReport?.()",
                "reload" => "location.reload()",
                _ => return,
            };
            let _ = window.eval(script);
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 起動シーケンスは blocking ダイアログを使うのでワーカースレッドで回す。
            // メインスレッドで待つと、ダイアログの表示要求を処理するイベントループ
            // 自体を塞いでしまう。
            std::thread::spawn(move || {
                if let Err(e) = start_server(&handle) {
                    error_exit(&handle, &e.to_string());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_server(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::escape_js_string;

    #[test]
    fn leaves_an_ordinary_path_alone() {
        assert_eq!(escape_js_string("/Users/me/添付"), "/Users/me/添付");
    }

    #[test]
    fn neutralizes_characters_that_would_break_out_of_the_literal() {
        assert_eq!(
            escape_js_string("/tmp/a\"); alert(1); (\""),
            "/tmp/a\\\"); alert(1); (\\\""
        );
        assert_eq!(escape_js_string("/tmp/back\\slash"), "/tmp/back\\\\slash");
        assert_eq!(escape_js_string("/tmp/two\nlines"), "/tmp/two\\nlines");
        assert_eq!(escape_js_string("/tmp/cr\r"), "/tmp/cr\\r");
        assert_eq!(escape_js_string("/tmp/ls\u{2028}"), "/tmp/ls\\u2028");
    }

    #[cfg(unix)]
    mod merge_sidecar_path {
        use super::super::merge_sidecar_path;

        // ログインシェルの PATH に安全網ディレクトリを日陰に追いやりうる古い
        // エントリ(nvm の node bin を模した decoy)が先頭に来ていても、
        // ~/.local/bin はそれより前に解決されなければならない。安全網が
        // 末尾に付いていた旧実装ではこの逆になり、まさにこのケースで
        // 古い claude-code バンドルが解決されてクラッシュしていた。
        #[test]
        fn known_dirs_precede_a_login_shell_decoy() {
            let home = std::env::var("HOME").unwrap_or_default();
            let local_bin = format!("{home}/.local/bin");
            let decoy = "/Users/test/.nvm/versions/node/v18.18.0/bin";
            let login = format!("{decoy}:/usr/bin:/bin");

            let result = merge_sidecar_path(Some(&login), None);

            let local_bin_pos = result.find(&local_bin).expect("local bin present");
            let decoy_pos = result.find(decoy).expect("decoy present");
            assert!(
                local_bin_pos < decoy_pos,
                "expected {local_bin} before {decoy} in {result}"
            );
        }

        // 安全網とログインシェルの PATH の両方に同じディレクトリが含まれて
        // いても、結果には一度しか現れない。
        #[test]
        fn dedupes_a_dir_present_in_both_known_and_login_shell() {
            let login = "/usr/local/bin:/usr/bin";

            let result = merge_sidecar_path(Some(login), None);

            let count = result
                .split(':')
                .filter(|d| *d == "/usr/local/bin")
                .count();
            assert_eq!(count, 1, "expected exactly one occurrence in {result}");
        }

        // 並び順を変えただけで、ログインシェルの PATH と継承した PATH の
        // ディレクトリを一つも取りこぼしてはいけない。
        #[test]
        fn keeps_every_dir_from_both_sources() {
            let login = "/opt/custom/bin:/usr/bin";
            let inherited = "/usr/sbin:/sbin";

            let result = merge_sidecar_path(Some(login), Some(inherited));

            let result_dirs: Vec<&str> = result.split(':').collect();
            for dir in login.split(':').chain(inherited.split(':')) {
                assert!(result_dirs.contains(&dir), "missing {dir} in {result}");
            }
        }
    }
}
