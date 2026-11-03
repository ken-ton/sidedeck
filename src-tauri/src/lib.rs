mod config;
mod display;
mod games;
mod system;
mod input;
mod window_mover;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

use config::{Config, CustomGame};
use display::{DisplayMode, MonitorInfo};

const QUICK_BUTTON: f64 = 72.0; // 論理ピクセル
const QUICK_PANEL_WIDTH: f64 = 420.0;

#[derive(Default)]
struct Deck {
    active: bool,
    /// Deck モニターの矩形（物理ピクセル）
    rect: (i32, i32, u32, u32),
    quick_expanded: bool,
    gamma: f32,
}

struct AppState {
    config: Mutex<Config>,
    config_path: PathBuf,
    deck: Mutex<Deck>,
}

impl AppState {
    fn save(&self) {
        self.config.lock().unwrap().save(&self.config_path);
    }

    fn deck_monitor(&self) -> Result<MonitorInfo, String> {
        let id = self
            .config
            .lock()
            .unwrap()
            .deck_monitor
            .clone()
            .ok_or("Deck 用のモニターがまだ設定されていません")?;
        display::list_monitors()
            .into_iter()
            .find(|m| m.device_path == id)
            .ok_or_else(|| "Deck 用のモニターが接続されていません".into())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeckStatus {
    active: bool,
    monitor_connected: bool,
}

fn status(app: &AppHandle) -> DeckStatus {
    let st = app.state::<AppState>();
    DeckStatus {
        active: st.deck.lock().unwrap().active,
        monitor_connected: st.deck_monitor().is_ok(),
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("deck-status", status(app));
}

// ---------------------------------------------------------------- ウィンドウ配置

fn place_main_fullscreen(app: &AppHandle) {
    let (x, y, w, h) = app.state::<AppState>().deck.lock().unwrap().rect;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_decorations(false);
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(PhysicalSize::new(w, h));
        // タップしても前面のアプリ・ゲームからフォーカスを奪わないようにする
        input::set_noactivate(&win, true);
        let _ = win.show();
    }
}

fn place_quick(app: &AppHandle, expanded: bool) {
    let st = app.state::<AppState>();
    let (x, y, w, h) = {
        let mut d = st.deck.lock().unwrap();
        d.quick_expanded = expanded;
        d.rect
    };
    let Some(win) = app.get_webview_window("quick") else { return };
    // ウィンドウが今いる画面ではなく、Deck モニターの DPI 倍率を使う
    let scale = app
        .available_monitors()
        .ok()
        .and_then(|ms| ms.into_iter().find(|m| m.position().x == x && m.position().y == y))
        .map(|m| m.scale_factor())
        .unwrap_or_else(|| win.scale_factor().unwrap_or(1.0));
    let (qw, qh) = if expanded {
        ((QUICK_PANEL_WIDTH * scale) as u32, h)
    } else {
        let s = (QUICK_BUTTON * scale) as u32;
        (s, s)
    };
    let qx = x + w as i32 - qw as i32;
    let qy = y + (h as i32 - qh as i32) / 2;
    let _ = win.set_size(PhysicalSize::new(qw, qh));
    let _ = win.set_position(PhysicalPosition::new(qx, qy));
    let _ = win.set_always_on_top(true);
    input::set_noactivate(&win, true);
    let _ = win.show();
    let _ = win.emit("quick-expanded", expanded);
}

// ---------------------------------------------------------------- Deck モード

fn enter_deck(app: &AppHandle) -> Result<(), String> {
    // プライマリや画面配置は変更しない。ランチャーを Deck モニター上に置くだけ。
    let st = app.state::<AppState>();
    let mon = st.deck_monitor()?;
    {
        let mut d = st.deck.lock().unwrap();
        d.active = true;
        d.rect = (mon.x, mon.y, mon.width, mon.height);
        if d.gamma == 0.0 {
            d.gamma = 1.0;
        }
    }
    place_main_fullscreen(app);
    place_quick(app, false);
    emit_status(app);
    Ok(())
}

fn exit_deck(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    window_mover::cancel();
    // 旧バージョンで変更した配置が残っていれば戻す
    let saved = st.config.lock().unwrap().saved_layout.clone();
    let result = match &saved {
        Some(layout) => display::restore_layout(layout),
        None => Ok(()),
    };
    if result.is_ok() {
        st.config.lock().unwrap().saved_layout = None;
        st.save();
    }
    st.deck.lock().unwrap().active = false;

    if let Some(q) = app.get_webview_window("quick") {
        let _ = q.hide();
    }
    if let Some(win) = app.get_webview_window("main") {
        input::set_noactivate(&win, false);
        let _ = win.set_decorations(true);
        let _ = win.set_size(LogicalSize::new(1100.0, 720.0));
        let _ = win.center();
        let _ = win.show();
    }
    emit_status(app);
    result
}

/// モニターの抜き差しを監視し、自動で Deck モードに入る／抜ける。
fn spawn_monitor_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            let st = app.state::<AppState>();
            let connected = st.deck_monitor().is_ok();
            if last != Some(connected) {
                let first = last.is_none();
                last = Some(connected);
                let active = st.deck.lock().unwrap().active;
                let auto = st.config.lock().unwrap().auto_deck;
                if connected && auto && !active {
                    if let Err(e) = enter_deck(&app) {
                        eprintln!("Deck モード開始に失敗: {e}");
                    }
                } else if !connected && active {
                    let _ = exit_deck(&app);
                }
                if !first {
                    let _ = app.emit("monitors-changed", ());
                }
                emit_status(&app);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

// ---------------------------------------------------------------- コマンド

type CmdResult<T> = Result<T, String>;

#[tauri::command]
async fn list_monitors() -> Vec<MonitorInfo> {
    display::list_monitors()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigView {
    deck_monitor: Option<String>,
    deck_monitor_name: Option<String>,
    auto_deck: bool,
    move_game_windows: bool,
    custom_games: Vec<CustomGame>,
}

#[tauri::command]
async fn get_config(app: AppHandle) -> ConfigView {
    let c = app.state::<AppState>().config.lock().unwrap().clone();
    ConfigView {
        deck_monitor: c.deck_monitor,
        deck_monitor_name: c.deck_monitor_name,
        auto_deck: c.auto_deck,
        move_game_windows: c.move_game_windows,
        custom_games: c.custom_games,
    }
}

#[tauri::command]
async fn set_move_game_windows(app: AppHandle, enabled: bool) {
    let st = app.state::<AppState>();
    st.config.lock().unwrap().move_game_windows = enabled;
    st.save();
}

#[tauri::command]
async fn set_deck_monitor(app: AppHandle, device_path: String, name: String) {
    let st = app.state::<AppState>();
    {
        let mut c = st.config.lock().unwrap();
        c.deck_monitor = Some(device_path);
        c.deck_monitor_name = Some(name);
    }
    st.save();
    emit_status(&app);
}

#[tauri::command]
async fn set_auto_deck(app: AppHandle, enabled: bool) {
    let st = app.state::<AppState>();
    st.config.lock().unwrap().auto_deck = enabled;
    st.save();
}

#[tauri::command]
async fn add_custom_game(app: AppHandle, title: String, path: String) {
    let st = app.state::<AppState>();
    let id = format!(
        "{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
    );
    st.config.lock().unwrap().custom_games.push(CustomGame { id, title, path });
    st.save();
}

#[tauri::command]
async fn remove_custom_game(app: AppHandle, id: String) {
    let st = app.state::<AppState>();
    st.config.lock().unwrap().custom_games.retain(|g| g.id != id);
    st.save();
}

#[tauri::command]
async fn list_games(app: AppHandle) -> Vec<games::Game> {
    let custom = app.state::<AppState>().config.lock().unwrap().custom_games.clone();
    games::list_games(&custom)
}

#[tauri::command]
async fn launch_game(app: AppHandle, id: String) -> CmdResult<()> {
    let custom = app.state::<AppState>().config.lock().unwrap().custom_games.clone();
    let game = games::list_games(&custom)
        .into_iter()
        .find(|g| g.id == id)
        .ok_or("ゲームが見つかりません")?;
    let st = app.state::<AppState>();
    let active = st.deck.lock().unwrap().active;
    // 起動前のウィンドウを記録するため、起動より先に監視を始める
    if active && st.config.lock().unwrap().move_game_windows {
        if let Ok(mon) = st.deck_monitor() {
            window_mover::follow_launch(mon.gdi_name, Duration::from_secs(120), game.source == "steam");
        }
    }
    if let Err(e) = games::launch(&app, &game) {
        window_mover::cancel();
        return Err(e);
    }
    if active {
        // ゲームが前面に出るようにランチャーを隠す（クイックボタンは残る）
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }
    }
    Ok(())
}

#[tauri::command]
async fn deck_status(app: AppHandle) -> DeckStatus {
    status(&app)
}

#[tauri::command]
async fn deck_enter(app: AppHandle) -> CmdResult<()> {
    enter_deck(&app)
}

#[tauri::command]
async fn deck_exit(app: AppHandle) -> CmdResult<()> {
    exit_deck(&app)
}

#[tauri::command]
async fn show_home(app: AppHandle) {
    if app.state::<AppState>().deck.lock().unwrap().active {
        place_quick(&app, false);
        place_main_fullscreen(&app);
    } else if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
async fn quick_set_expanded(app: AppHandle, expanded: bool) {
    place_quick(&app, expanded);
}

#[tauri::command]
async fn get_volume() -> CmdResult<system::Volume> {
    system::get_volume()
}

#[tauri::command]
async fn set_volume(level: f32) -> CmdResult<()> {
    system::set_volume(level)
}

#[tauri::command]
async fn set_mute(muted: bool) -> CmdResult<()> {
    system::set_mute(muted)
}

#[derive(Serialize)]
struct Brightness {
    /// "ddc"（モニター本体の明るさ）| "gamma"（ソフトウェア減光）
    method: &'static str,
    value: u32,
    min: u32,
}

#[tauri::command]
async fn get_brightness(app: AppHandle) -> CmdResult<Brightness> {
    let st = app.state::<AppState>();
    let mon = st.deck_monitor()?;
    Ok(match display::ddc_get_brightness(&mon.gdi_name) {
        Some(v) => Brightness { method: "ddc", value: v, min: 0 },
        None => {
            let g = st.deck.lock().unwrap().gamma;
            Brightness { method: "gamma", value: ((if g == 0.0 { 1.0 } else { g }) * 100.0) as u32, min: 50 }
        }
    })
}

#[tauri::command]
async fn set_brightness(app: AppHandle, value: u32) -> CmdResult<()> {
    let st = app.state::<AppState>();
    let mon = st.deck_monitor()?;
    if display::ddc_set_brightness(&mon.gdi_name, value) {
        return Ok(());
    }
    let level = value as f32 / 100.0;
    if display::gamma_set(&mon.gdi_name, level) {
        st.deck.lock().unwrap().gamma = level.clamp(0.5, 1.0);
        Ok(())
    } else {
        Err("明るさを変更できませんでした".into())
    }
}

#[derive(Serialize)]
struct Modes {
    current: DisplayMode,
    modes: Vec<DisplayMode>,
}

#[tauri::command]
async fn list_modes(app: AppHandle) -> CmdResult<Modes> {
    let mon = app.state::<AppState>().deck_monitor()?;
    Ok(Modes {
        current: DisplayMode { width: mon.width, height: mon.height, refresh: mon.refresh },
        modes: display::list_modes(&mon.gdi_name),
    })
}

#[tauri::command]
async fn set_mode(app: AppHandle, mode: DisplayMode) -> CmdResult<()> {
    let st = app.state::<AppState>();
    let mon = st.deck_monitor()?;
    display::set_mode(&mon.gdi_name, mode)?;
    std::thread::sleep(Duration::from_millis(400));
    let mon = st.deck_monitor()?;
    let active = {
        let mut d = st.deck.lock().unwrap();
        d.rect = (mon.x, mon.y, mon.width, mon.height);
        d.active
    };
    if active {
        let expanded = st.deck.lock().unwrap().quick_expanded;
        place_quick(&app, expanded);
        if app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false)) {
            place_main_fullscreen(&app);
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_power_plans() -> Vec<system::PowerPlan> {
    system::list_power_plans()
}

#[tauri::command]
async fn set_power_plan(id: String) -> CmdResult<()> {
    system::set_power_plan(&id)
}

/// Windows の「タッチ入力を行う画面の識別」ツールを開く。
#[tauri::command]
async fn open_touch_setup() -> CmdResult<()> {
    std::process::Command::new("MultiDigiMon.exe")
        .arg("-touch")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_keys(keys: Vec<String>) -> CmdResult<String> {
    // 検証用: 送信先の情報を返す
    let (name, elevated) = input::foreground_info();
    let info = format!(
        "送信先: {name} / 管理者権限: {} / win-deck: {}",
        match elevated {
            Some(true) => "あり",
            Some(false) => "なし",
            None => "不明（取得できず）",
        },
        if input::self_elevated() { "管理者" } else { "通常" }
    );
    eprintln!("[send_keys] {keys:?} {info}");
    input::send_keys(&keys)?;
    Ok(info)
}

#[tauri::command]
async fn send_text(text: String) -> CmdResult<()> {
    input::send_text(&text)
}

/// 編集モードなど、キーボード入力が必要なときだけフォーカスを受け取れるようにする。
#[tauri::command]
async fn set_focusable(window: tauri::WebviewWindow, focusable: bool) {
    input::set_noactivate(&window, !focusable);
    if focusable {
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------- 起動

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let enter = MenuItem::with_id(app, "enter", "Deck モード開始", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Deck モード終了", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "ウィンドウを開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "win-deck を終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&enter, &exit, &open, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("win-deck")
        .menu(&menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "enter" => {
                if let Err(e) = enter_deck(app) {
                    eprintln!("{e}");
                    let _ = app.emit("deck-error", e);
                }
            }
            "exit" => {
                let _ = exit_deck(app);
            }
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                if app.state::<AppState>().deck.lock().unwrap().active {
                    let _ = exit_deck(app);
                }
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            let mut config = Config::load(&config_path);

            // 前回 Deck モードのまま異常終了していたら、画面配置を元に戻す
            if let Some(layout) = config.saved_layout.take() {
                if let Err(e) = display::restore_layout(&layout) {
                    eprintln!("画面配置の復元に失敗: {e}");
                }
                config.save(&config_path);
            }

            app.manage(AppState {
                config: Mutex::new(config),
                config_path,
                deck: Mutex::new(Deck { gamma: 1.0, ..Default::default() }),
            });

            if let Some(root) = games::steam_root() {
                let _ = app
                    .asset_protocol_scope()
                    .allow_directory(root.join("appcache").join("librarycache"), true);
            }

            build_tray(app)?;
            spawn_monitor_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 閉じるボタンではトレイに常駐させる
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_monitors,
            get_config,
            set_deck_monitor,
            set_auto_deck,
            set_move_game_windows,
            add_custom_game,
            remove_custom_game,
            list_games,
            launch_game,
            deck_status,
            deck_enter,
            deck_exit,
            show_home,
            quick_set_expanded,
            get_volume,
            set_volume,
            set_mute,
            get_brightness,
            set_brightness,
            list_modes,
            set_mode,
            list_power_plans,
            set_power_plan,
            open_touch_setup,
            send_keys,
            send_text,
            set_focusable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod smoke {
    //! 実機の状態を読むだけのスモークテスト（画面配置などは変更しない）。
    //! `cargo test -- --nocapture` で内容を表示できる。

    #[test]
    fn reads_system_state() {
        let mons = crate::display::list_monitors();
        assert!(!mons.is_empty(), "アクティブなモニターが 1 つも取得できない");
        assert_eq!(mons.iter().filter(|m| m.primary).count(), 1);
        for m in &mons {
            println!("{m:?} modes={}", crate::display::list_modes(&m.gdi_name).len());
            println!("  ddc brightness = {:?}", crate::display::ddc_get_brightness(&m.gdi_name));
        }
        for p in crate::system::list_power_plans() {
            println!("power: {} {} active={}", p.id, p.name, p.active);
        }
        println!("volume ok = {}", crate::system::get_volume().is_ok());
        println!("big picture monitor = {:?}", crate::window_mover::big_picture_monitor());
        let prim = crate::display::list_monitors().into_iter().find(|m| m.primary).unwrap();
        println!("primary hmonitor  = {:?}", crate::display::hmonitor_for(&prim.gdi_name));
        for g in crate::games::list_games(&[]) {
            println!("game: {} {} art={}", g.id, g.title, g.art.is_some());
        }
    }
}

