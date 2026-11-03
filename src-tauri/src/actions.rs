//! ページ移動やシステムパネル表示など、画面内で完結する操作はフロントエンドが処理する。

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Launch {
        target: String,
        #[serde(default)]
        args: String,
    },
    Hotkey { keys: Vec<String> },
    Text { text: String },
    Media { command: String },
    MicMute,
    /// 空なら全デバイスを順番に切り替える
    AudioDevice {
        #[serde(default, rename = "deviceIds")]
        device_ids: Vec<String>,
    },
    /// `repeat` が 0 なら停止されるまで繰り返す
    Macro {
        steps: Vec<crate::macros::Step>,
        #[serde(default = "one")]
        repeat: u32,
    },
    Plugin {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        #[serde(rename = "actionId")]
        action_id: String,
        #[serde(default)]
        settings: serde_json::Value,
    },
    /// command: focus / move_next / move_to / maximize / minimize
    Window {
        command: String,
        /// focus の対象（小文字のプロセス名）
        #[serde(default)]
        app: String,
        /// focus で起動していなかったときに開くもの
        #[serde(default)]
        launch: String,
        /// move_to の移動先（モニターのデバイスパス）
        #[serde(default)]
        monitor: String,
    },
}

fn one() -> u32 {
    1
}

fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

pub(crate) fn launch(app: &tauri::AppHandle, target: &str, args: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = target.trim().trim_matches('"');
    if target.is_empty() {
        return Err("起動するものが設定されていません".into());
    }
    if target.contains("://") {
        return app.opener().open_url(target, None::<&str>).map_err(|e| e.to_string());
    }
    let path = Path::new(target);
    if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
        let mut cmd = Command::new(path);
        cmd.args(split_args(args));
        // "notepad.exe" のようにパスがないと parent() は空文字になり、current_dir("") だと起動に失敗する
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            cmd.current_dir(dir);
        }
        return cmd.spawn().map(|_| ()).map_err(|e| format!("起動できませんでした: {e}"));
    }
    app.opener().open_path(target, None::<&str>).map_err(|e| e.to_string())
}

/// `button_id` はマクロの実行・停止の切り替えに使う。
pub fn run(app: &tauri::AppHandle, action: Action, button_id: Option<String>) -> Result<Option<String>, String> {
    match action {
        Action::Launch { target, args } => launch(app, &target, &args).map(|_| None),
        Action::Hotkey { keys } => crate::input::send_keys(&keys).map(|_| None),
        Action::Text { text } => crate::input::send_text(&text).map(|_| None),
        Action::Media { command } => {
            let key = match command.as_str() {
                "play_pause" => "media_play_pause",
                "next" => "media_next",
                "prev" => "media_prev",
                "stop" => "media_stop",
                "volume_up" => "volume_up",
                "volume_down" => "volume_down",
                "mute" => "volume_mute",
                other => return Err(format!("未対応のメディア操作です: {other}")),
            };
            crate::input::send_keys(&[key.to_string()]).map(|_| None)
        }
        Action::MicMute => crate::audio::toggle_mic()
            .map(|muted| Some(if muted { "マイク: ミュート" } else { "マイク: オン" }.to_string())),
        Action::AudioDevice { device_ids } => crate::audio::cycle_output(&device_ids).map(|name| Some(format!("出力: {name}"))),
        Action::Macro { steps, repeat } => {
            let id = button_id.ok_or("マクロの識別子がありません")?;
            Ok(crate::macros::toggle(app, id, steps, repeat))
        }
        Action::Plugin { plugin_id, action_id, settings } => {
            crate::plugins::key_down(app, &plugin_id, &action_id, button_id.as_deref().unwrap_or_default(), settings).map(|_| None)
        }
        Action::Window { command, app: name, launch, monitor } => match command.as_str() {
            "focus" => crate::winops::focus_app(app, &name, &launch),
            "move_next" => {
                use tauri::Manager;
                let deck = app.state::<crate::AppState>().config.lock().unwrap().deck_monitor.clone();
                crate::winops::move_foreground(None, deck.as_deref())
            }
            "move_to" => crate::winops::move_foreground(Some(&monitor), None),
            "maximize" => crate::winops::toggle_maximize(),
            "minimize" => crate::winops::minimize(),
            other => Err(format!("未対応のウィンドウ操作です: {other}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::split_args;

    #[test]
    fn splits_args_with_quotes() {
        assert_eq!(split_args(r#"-a "C:\My Files\x.txt"  --b"#), vec!["-a", r"C:\My Files\x.txt", "--b"]);
        assert_eq!(split_args("   "), Vec::<String>::new());
        assert_eq!(split_args(r#""""#), vec![""]);
    }
}
