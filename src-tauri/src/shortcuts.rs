use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const TOGGLE_ID: &str = "__toggle__";

/// ショートカットの id（Shortcut::id()）→ ボタンの id
#[derive(Default)]
pub struct Registered(pub Mutex<HashMap<u32, String>>);

/// 最後に登録を頼まれた一覧（記録のために一時停止したあと、登録し直すのに使う）
#[derive(Default)]
pub struct LastEntries(pub Mutex<Vec<Entry>>);

#[derive(Deserialize, Clone)]
pub struct Entry {
    pub id: String,
    pub keys: Vec<String>,
}

#[derive(Serialize)]
pub struct EntryResult {
    pub id: String,
    pub error: Option<String>,
}

fn key_token(k: &str) -> Option<String> {
    let t = match k {
        "ctrl" => "ctrl",
        "shift" => "shift",
        "alt" => "alt",
        "win" => "super",
        "space" => "Space",
        "enter" => "Enter",
        "tab" => "Tab",
        "esc" => "Escape",
        "backspace" => "Backspace",
        "delete" => "Delete",
        "insert" => "Insert",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        "printscreen" => "PrintScreen",
        "pause" => "Pause",
        "minus" => "Minus",
        "equal" => "Equal",
        "comma" => "Comma",
        "period" => "Period",
        "slash" => "Slash",
        "backquote" => "Backquote",
        "semicolon" => "Semicolon",
        "quote" => "Quote",
        "bracketleft" => "BracketLeft",
        "bracketright" => "BracketRight",
        "backslash" => "Backslash",
        s if s.len() == 1 && s.as_bytes()[0].is_ascii_lowercase() => return Some(format!("Key{}", s.to_uppercase())),
        s if s.len() == 1 && s.as_bytes()[0].is_ascii_digit() => return Some(format!("Digit{s}")),
        s if s.starts_with("num") && s.len() == 4 => return Some(format!("Numpad{}", &s[3..])),
        s if s.starts_with('f') && s[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => return Some(s.to_uppercase()),
        _ => return None,
    };
    Some(t.to_string())
}

/// 修飾キーなしのショートカットは普段の入力を奪ってしまうので、F キー以外は受け付けない。
pub fn parse(keys: &[String]) -> Result<Shortcut, String> {
    const MODS: [&str; 4] = ["ctrl", "shift", "alt", "win"];
    let main: Vec<&String> = keys.iter().filter(|k| !MODS.contains(&k.as_str())).collect();
    if main.len() != 1 {
        return Err("修飾キー以外のキーを 1 つ指定してください".into());
    }
    let is_fkey = main[0].starts_with('f') && main[0].len() > 1 && main[0][1..].chars().all(|c| c.is_ascii_digit());
    if main.len() == keys.len() && !is_fkey {
        return Err("Ctrl・Alt・Shift・Win のどれかと組み合わせてください（F1〜F24 は単独でも可）".into());
    }
    let tokens = keys
        .iter()
        .map(|k| key_token(k).ok_or_else(|| format!("ショートカットに使えないキーです: {k}")))
        .collect::<Result<Vec<_>, _>>()?;
    tokens.join("+").parse::<Shortcut>().map_err(|e| e.to_string())
}

const CONFLICT: &str = "ほかのアプリが同じショートカットを使っているか、Windows が予約しているため登録できません";

/// すべて登録し直す。登録できなかったものはエラーを返す。
pub fn set_all(app: &AppHandle, entries: Vec<Entry>) -> Vec<EntryResult> {
    *app.state::<LastEntries>().0.lock().unwrap() = entries.clone();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = HashMap::new();
    let results = entries
        .into_iter()
        .map(|e| {
            let error = match parse(&e.keys) {
                Err(msg) => Some(msg),
                Ok(sc) if map.contains_key(&sc.id()) => Some("win-deck の中でほかと重複しています".into()),
                Ok(sc) => match gs.register(sc) {
                    Ok(()) => {
                        map.insert(sc.id(), e.id.clone());
                        None
                    }
                    Err(_) => Some(CONFLICT.into()),
                },
            };
            EntryResult { id: e.id, error }
        })
        .collect();
    *app.state::<Registered>().0.lock().unwrap() = map;
    results
}

/// キーを記録している間は、win-deck 自身のショートカットを外す。
/// 外さないと、登録済みのキーは Windows が横取りして、記録欄に届かずにボタンが実行されてしまう。
pub fn suspend(app: &AppHandle, suspended: bool) {
    if suspended {
        let _ = app.global_shortcut().unregister_all();
        app.state::<Registered>().0.lock().unwrap().clear();
    } else {
        let entries = app.state::<LastEntries>().0.lock().unwrap().clone();
        set_all(app, entries);
    }
}

/// 登録できるか試す（win-deck が登録済みのものは使用可とみなす）。
pub fn check(app: &AppHandle, keys: &[String]) -> Option<String> {
    let sc = match parse(keys) {
        Ok(sc) => sc,
        Err(msg) => return Some(msg),
    };
    // 記録の一時停止から戻る途中でも、win-deck 自身のキーは競合として扱わない
    let ours = app.state::<Registered>().0.lock().unwrap().contains_key(&sc.id())
        || app.state::<LastEntries>().0.lock().unwrap().iter().any(|e| parse(&e.keys).is_ok_and(|x| x.id() == sc.id()));
    if ours {
        return None;
    }
    let gs = app.global_shortcut();
    match gs.register(sc) {
        Ok(()) => {
            let _ = gs.unregister(sc);
            None
        }
        Err(_) => Some(CONFLICT.into()),
    }
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let Some(id) = app.state::<Registered>().0.lock().unwrap().get(&shortcut.id()).cloned() else { return };
            crate::input::mask_menu_key();
            if id == TOGGLE_ID {
                return crate::toggle_deck_front(app);
            }
            let app = app.clone();
            std::thread::spawn(move || {
                crate::input::wait_modifiers_released(std::time::Duration::from_secs(1));
                let _ = app.emit("shortcut", id);
            });
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn k(s: &str) -> Vec<String> {
        s.split('+').map(String::from).collect()
    }

    #[test]
    fn parses_shortcuts() {
        assert!(parse(&k("ctrl+alt+d")).is_ok());
        assert!(parse(&k("win+shift+s")).is_ok());
        assert!(parse(&k("ctrl+shift+up")).is_ok());
        assert!(parse(&k("alt+num5")).is_ok());
        assert!(parse(&k("f13")).is_ok());
        assert!(parse(&k("d")).is_err(), "修飾キーなしは不可");
        assert!(parse(&k("ctrl+alt")).is_err(), "修飾キーだけは不可");
        assert!(parse(&k("ctrl+a+b")).is_err(), "メインのキーは 1 つ");
        assert_ne!(parse(&k("ctrl+alt+d")).unwrap().id(), parse(&k("ctrl+shift+d")).unwrap().id());
        assert_eq!(parse(&k("alt+ctrl+d")).unwrap().id(), parse(&k("ctrl+alt+d")).unwrap().id());
    }
}
