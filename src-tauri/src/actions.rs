//! デッキのボタンに割り当てる操作の実行。
//! ページ移動やシステムパネル表示など、画面内で完結する操作はフロントエンドが処理する。

use std::path::Path;
use std::process::Command;

use serde::Deserialize;

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    /// アプリ・ファイル・フォルダ・URL を開く
    Launch {
        target: String,
        #[serde(default)]
        args: String,
    },
    /// キーの組み合わせを送る（例: ["ctrl", "shift", "s"]）
    Hotkey { keys: Vec<String> },
    /// 文字列を入力する
    Text { text: String },
    /// メディア操作（play_pause / next / prev / stop / volume_up / volume_down / mute）
    Media { command: String },
    /// マイクのミュート切替
    MicMute,
    /// 出力デバイスの切替。空なら全デバイスを順番に切り替える
    AudioDevice {
        #[serde(default, rename = "deviceIds")]
        device_ids: Vec<String>,
    },
}

/// 引数文字列を空白で分割する（ダブルクォートで囲んだ部分は 1 つの引数）。
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

fn launch(app: &tauri::AppHandle, target: &str, args: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = target.trim().trim_matches('"');
    if target.is_empty() {
        return Err("起動するものが設定されていません".into());
    }
    // steam://, https:// などの URL
    if target.contains("://") {
        return app.opener().open_url(target, None::<&str>).map_err(|e| e.to_string());
    }
    let path = Path::new(target);
    if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
        let mut cmd = Command::new(path);
        cmd.args(split_args(args));
        if let Some(dir) = path.parent() {
            cmd.current_dir(dir);
        }
        return cmd.spawn().map(|_| ()).map_err(|e| format!("起動できませんでした: {e}"));
    }
    // .lnk / フォルダ / ドキュメントなどは関連付けに任せる
    app.opener().open_path(target, None::<&str>).map_err(|e| e.to_string())
}

/// 操作を実行する。表示用のメッセージがあれば返す。
pub fn run(app: &tauri::AppHandle, action: Action) -> Result<Option<String>, String> {
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
