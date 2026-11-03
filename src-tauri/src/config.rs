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

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Deck 用モニター（MD-14T）のデバイスパス
    pub deck_monitor: Option<String>,
    /// 表示用の名前
    pub deck_monitor_name: Option<String>,
    /// モニター接続時に自動で Deck モードに入る
    pub auto_deck: bool,
    pub custom_games: Vec<CustomGame>,
    /// Deck モードに入る前の画面配置。異常終了時の復元にも使う。
    pub saved_layout: Option<Vec<MonitorInfo>>,
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
