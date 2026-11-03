use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::display::MonitorInfo;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// モニターのデバイスパス（GDI 名は再接続で変わるため）
    pub deck_monitor: Option<String>,
    pub deck_monitor_name: Option<String>,
    pub auto_deck: bool,
    /// 構造はフロントエンドが管理する。
    pub deck: Option<serde_json::Value>,
    /// 旧バージョン（プライマリを切り替えていた頃）の画面配置。
    /// 残っていれば起動時に復元して消す。
    pub saved_layout: Option<Vec<MonitorInfo>>,
}

impl Config {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// 書き込み中に落ちても設定が壊れないよう、一時ファイルに書いてから置き換える。
    pub fn save(&self, path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}
