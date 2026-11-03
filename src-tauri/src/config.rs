use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::display::MonitorInfo;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomGame {
    pub id: String,
    pub title: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Deck 用モニター（MD-14T）のデバイスパス
    pub deck_monitor: Option<String>,
    /// 表示用の名前
    pub deck_monitor_name: Option<String>,
    /// モニター接続時に自動で Deck モードに入る
    pub auto_deck: bool,
    /// ゲーム起動後、そのウィンドウを Deck モニターへ移動する
    pub move_game_windows: bool,
    pub custom_games: Vec<CustomGame>,
    /// 旧バージョン（プライマリを切り替えていた頃）の画面配置。
    /// 残っていれば起動時に復元して消す。
    pub saved_layout: Option<Vec<MonitorInfo>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            deck_monitor: None,
            deck_monitor_name: None,
            auto_deck: false,
            move_game_windows: true,
            custom_games: Vec::new(),
            saved_layout: None,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, s);
        }
    }
}
