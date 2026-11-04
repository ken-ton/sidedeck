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
    /// 読めなかった設定は別名で退避してから初期値で始める（そのまま上書きして消さないため）。
    /// 退避したときは、ユーザーに伝えるメッセージを返す。
    pub fn load(path: &Path) -> (Self, Option<String>) {
        let Ok(text) = std::fs::read_to_string(path) else { return (Self::default(), None) };
        match serde_json::from_str(&text) {
            Ok(c) => (c, None),
            Err(e) => {
                let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                let backup = path.with_file_name(format!("config.broken-{stamp}.json"));
                let saved = std::fs::rename(path, &backup).is_ok();
                let msg = if saved {
                    format!("設定ファイルを読み込めなかったため、初期状態で起動しました。元のファイルは {} に残しています（{e}）", backup.display())
                } else {
                    format!("設定ファイルを読み込めませんでした（{e}）")
                };
                (Self::default(), Some(msg))
            }
        }
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

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn backs_up_unreadable_config() {
        let dir = std::env::temp_dir().join(format!("sidedeck-config-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");

        let (c, warn) = Config::load(&path);
        assert!(warn.is_none() && c.deck.is_none(), "ファイルがないときは初期値で、警告なし");

        std::fs::write(&path, r#"{"autoDeck": "yes"}"#).unwrap();
        let (c, warn) = Config::load(&path);
        assert!(!c.auto_deck);
        assert!(warn.unwrap().contains("config.broken-"));
        assert!(!path.exists(), "壊れたファイルは退避して、元の名前には残さない");
        let backups: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), r#"{"autoDeck": "yes"}"#);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
