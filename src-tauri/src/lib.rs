mod actions;
mod audio;
mod config;
mod display;
mod foreground;
mod games;
mod icons;
mod input;
mod macros;
mod system;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WindowEvent};

use config::Config;
use display::{DisplayMode, MonitorInfo};

#[derive(Default)]
struct Deck {
    active: bool,
    /// Deck モニターの矩形（物理ピクセル）
    rect: (i32, i32, u32, u32),
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

fn place_main_fullscreen(app: &AppHandle) {
    let (x, y, w, h) = app.state::<AppState>().deck.lock().unwrap().rect;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_decorations(false);
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_size(PhysicalSize::new(w, h));
        input::set_noactivate(&win, true);
        let _ = win.show();
    }
}

fn enter_deck(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    let mon = st.deck_monitor()?;
    {
        let mut d = st.deck.lock().unwrap();
        d.active = true;
        d.rect = (mon.x, mon.y, mon.width, mon.height);
    }
    place_main_fullscreen(app);
    emit_status(app);
    Ok(())
}

fn exit_deck(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    st.deck.lock().unwrap().active = false;
    if let Some(win) = app.get_webview_window("main") {
        input::set_noactivate(&win, false);
        let _ = win.set_decorations(true);
        let _ = win.set_size(LogicalSize::new(1100.0, 720.0));
        let _ = win.center();
        let _ = win.show();
    }
    emit_status(app);
    Ok(())
}

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
}

#[tauri::command]
async fn get_config(app: AppHandle) -> ConfigView {
    let c = app.state::<AppState>().config.lock().unwrap().clone();
    ConfigView { deck_monitor: c.deck_monitor, deck_monitor_name: c.deck_monitor_name, auto_deck: c.auto_deck }
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

/// Deck モードでないときは普通のウィンドウなので何もしない。
#[tauri::command]
async fn set_focusable(app: AppHandle, window: tauri::WebviewWindow, focusable: bool) {
    if !app.state::<AppState>().deck.lock().unwrap().active {
        return;
    }
    input::set_noactivate(&window, !focusable);
    if focusable {
        let _ = window.set_focus();
    }
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
async fn get_deck(app: AppHandle) -> Option<serde_json::Value> {
    app.state::<AppState>().config.lock().unwrap().deck.clone()
}

#[tauri::command]
async fn save_deck(app: AppHandle, deck: serde_json::Value) {
    let st = app.state::<AppState>();
    st.config.lock().unwrap().deck = Some(deck);
    st.save();
}

#[tauri::command]
async fn run_action(app: AppHandle, action: actions::Action, button_id: Option<String>) -> CmdResult<Option<String>> {
    actions::run(&app, action, button_id)
}

#[tauri::command]
async fn start_key_recording() -> CmdResult<()> {
    macros::start_recording()
}

#[tauri::command]
async fn stop_key_recording(keep_timing: bool) -> Vec<macros::Step> {
    macros::stop_recording(keep_timing)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct States {
    mic_muted: Option<bool>,
    default_output: Option<String>,
}

#[tauri::command]
async fn get_states() -> States {
    States { mic_muted: audio::mic_muted(), default_output: audio::default_output_id() }
}

#[tauri::command]
async fn list_audio_outputs() -> CmdResult<Vec<audio::AudioDevice>> {
    audio::list_outputs()
}

#[tauri::command]
async fn get_icon(target: String) -> Option<String> {
    icons::icon_for(&target)
}

#[tauri::command]
async fn get_foreground_app(app: AppHandle) -> Option<foreground::WindowApp> {
    app.state::<foreground::LastForeground>().0.lock().unwrap().clone()
}

#[tauri::command]
async fn list_window_apps() -> Vec<foreground::WindowApp> {
    foreground::list_window_apps()
}

#[tauri::command]
async fn list_installed_games() -> Vec<games::Game> {
    games::list_games()
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
            Brightness { method: "gamma", value: (g * 100.0) as u32, min: 50 }
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
        place_main_fullscreen(&app);
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
            "quit" => app.exit(0),
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

            // 旧バージョンが変更した画面配置が残っていたら元に戻す
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

            app.manage(foreground::LastForeground::default());

            build_tray(app)?;
            spawn_monitor_watcher(app.handle().clone());
            foreground::spawn_watcher(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
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
            deck_status,
            deck_enter,
            deck_exit,
            set_focusable,
            open_touch_setup,
            get_deck,
            save_deck,
            run_action,
            start_key_recording,
            stop_key_recording,
            get_states,
            list_audio_outputs,
            get_icon,
            list_installed_games,
            get_foreground_app,
            list_window_apps,
            get_volume,
            set_volume,
            set_mute,
            get_brightness,
            set_brightness,
            list_modes,
            set_mode,
            list_power_plans,
            set_power_plan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod smoke {
    //! 実機の状態を読むだけのスモークテスト。画面配置や音声デバイスは変更しない。

    #[test]
    fn reads_system_state() {
        let mons = crate::display::list_monitors();
        assert!(!mons.is_empty(), "アクティブなモニターが 1 つも取得できない");
        assert_eq!(mons.iter().filter(|m| m.primary).count(), 1);
        for m in &mons {
            println!("{m:?} modes={}", crate::display::list_modes(&m.gdi_name).len());
        }
        for p in crate::system::list_power_plans() {
            println!("power: {} {} active={}", p.id, p.name, p.active);
        }
        println!("volume ok = {}", crate::system::get_volume().is_ok());
        println!("mic muted = {:?}", crate::audio::mic_muted());
        for d in crate::audio::list_outputs().unwrap_or_default() {
            println!("output: {} default={} id={}", d.name, d.is_default, d.id);
        }
        // 既定デバイスを同じデバイスに設定し直す（実質変化なし）ことで、IPolicyConfig の呼び出しを確認する
        if let Some(id) = crate::audio::default_output_id() {
            let r = crate::audio::set_default_output(&id);
            println!("set_default_output(既定のまま) = {r:?}");
            assert!(r.is_ok());
            assert_eq!(crate::audio::default_output_id().as_deref(), Some(id.as_str()));
        }
        for w in crate::foreground::list_window_apps() {
            println!("window app: {} | {}", w.name, w.title);
        }
        let n = crate::games::list_games().len();
        println!("installed games = {n}");
        let notepad = r"C:\Windows\System32\notepad.exe";
        let icon = crate::icons::icon_for(notepad);
        println!("notepad icon = {:?}", icon.as_ref().map(|s| s.len()));
        assert!(icon.is_some_and(|s| s.starts_with("data:image/png;base64,")), "exe のアイコンが取れない");
    }
}
