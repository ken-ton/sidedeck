use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::*;

/// `media` が true のキーはスキャンコードを持たないので VK で送る。
fn vk_for(name: &str) -> Option<(VIRTUAL_KEY, bool)> {
    let n = name.to_ascii_lowercase();
    let vk = match n.as_str() {
        "ctrl" | "control" => VK_LCONTROL,
        "shift" => VK_LSHIFT,
        "alt" => VK_LMENU,
        "win" | "meta" => VK_LWIN,
        "space" => VK_SPACE,
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "esc" | "escape" => VK_ESCAPE,
        "backspace" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "printscreen" => VK_SNAPSHOT,
        "pause" => VK_PAUSE,
        "capslock" => VK_CAPITAL,
        "numlock" => VK_NUMLOCK,
        "scrolllock" => VK_SCROLL,
        "contextmenu" => VK_APPS,
        // 記号キー（US 配列の位置で指定。JIS 配列では刻印と違う記号になることがある）
        "minus" => VK_OEM_MINUS,
        "equal" => VK_OEM_PLUS,
        "comma" => VK_OEM_COMMA,
        "period" => VK_OEM_PERIOD,
        "slash" => VK_OEM_2,
        "backquote" => VK_OEM_3,
        "semicolon" => VK_OEM_1,
        "quote" => VK_OEM_7,
        "bracketleft" => VK_OEM_4,
        "bracketright" => VK_OEM_6,
        "backslash" => VK_OEM_5,
        "intlro" => VK_OEM_102,
        s if s.starts_with("num") && s.len() == 4 && s.as_bytes()[3].is_ascii_digit() => {
            VIRTUAL_KEY(VK_NUMPAD0.0 + (s.as_bytes()[3] - b'0') as u16)
        }
        "media_play_pause" => return Some((VK_MEDIA_PLAY_PAUSE, true)),
        "media_next" => return Some((VK_MEDIA_NEXT_TRACK, true)),
        "media_prev" => return Some((VK_MEDIA_PREV_TRACK, true)),
        "media_stop" => return Some((VK_MEDIA_STOP, true)),
        "volume_up" => return Some((VK_VOLUME_UP, true)),
        "volume_down" => return Some((VK_VOLUME_DOWN, true)),
        "volume_mute" => return Some((VK_VOLUME_MUTE, true)),
        s if s.len() == 1 && s.as_bytes()[0].is_ascii_alphanumeric() => {
            VIRTUAL_KEY(s.as_bytes()[0].to_ascii_uppercase() as u16)
        }
        s if s.starts_with('f') && s.len() <= 3 => {
            let num: u16 = s[1..].parse().ok()?;
            if !(1..=24).contains(&num) {
                return None;
            }
            VIRTUAL_KEY(VK_F1.0 + num - 1)
        }
        _ => return None,
    };
    Some((vk, false))
}

fn key_input(vk: VIRTUAL_KEY, media: bool, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    // ゲームの多くはスキャンコード（DirectInput / Raw Input）で読むので、スキャンコードで送る。
    // ただし E1 プレフィックスのキー（Pause = 0xE11D）は SendInput で表せず、
    // 下位バイトだけ送ると右 Ctrl になってしまうので、スキャンコードを持たないキーと同様に VK で送る。
    let sc = if media { 0 } else { unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC_EX) } };
    let (wvk, wscan) = if sc == 0 || sc & 0xFF00 == 0xE100 {
        (vk, 0)
    } else {
        flags |= KEYEVENTF_SCANCODE;
        if sc & 0xFF00 == 0xE000 {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        (VIRTUAL_KEY(0), (sc & 0xFF) as u16)
    };
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: wvk, wScan: wscan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize != inputs.len() {
        return Err("キー入力を送信できませんでした（管理者権限のアプリには送れません）".into());
    }
    Ok(())
}

fn resolve(keys: &[String]) -> Result<Vec<(VIRTUAL_KEY, bool)>, String> {
    keys.iter()
        .map(|k| vk_for(k).ok_or_else(|| format!("未対応のキーです: {k}")))
        .collect()
}

pub fn key_down(keys: &[String]) -> Result<(), String> {
    let inputs: Vec<_> = resolve(keys)?.iter().map(|&(vk, m)| key_input(vk, m, false)).collect();
    send(&inputs)
}

pub fn key_up(keys: &[String]) -> Result<(), String> {
    let inputs: Vec<_> = resolve(keys)?.iter().rev().map(|&(vk, m)| key_input(vk, m, true)).collect();
    send(&inputs)
}

pub fn send_keys(keys: &[String]) -> Result<(), String> {
    key_down(keys)?;
    // ゲームはフレーム単位で入力を読むので、押している時間を少し取る
    std::thread::sleep(Duration::from_millis(40));
    key_up(keys)
}

pub fn name_for_vk(vk: u16) -> Option<String> {
    let v = VIRTUAL_KEY(vk);
    let fixed = match v {
        VK_LCONTROL | VK_RCONTROL | VK_CONTROL => Some("ctrl"),
        VK_LSHIFT | VK_RSHIFT | VK_SHIFT => Some("shift"),
        VK_LMENU | VK_RMENU | VK_MENU => Some("alt"),
        VK_LWIN | VK_RWIN => Some("win"),
        _ => None,
    };
    if let Some(n) = fixed {
        return Some(n.into());
    }
    if (b'A' as u16..=b'Z' as u16).contains(&vk) || (b'0' as u16..=b'9' as u16).contains(&vk) {
        return Some((vk as u8 as char).to_ascii_lowercase().to_string());
    }
    if (VK_F1.0..=VK_F24.0).contains(&vk) {
        return Some(format!("f{}", vk - VK_F1.0 + 1));
    }
    if (VK_NUMPAD0.0..=VK_NUMPAD9.0).contains(&vk) {
        return Some(format!("num{}", vk - VK_NUMPAD0.0));
    }
    const NAMED: &[&str] = &[
        "space", "enter", "tab", "esc", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "up",
        "down", "left", "right", "printscreen", "pause", "capslock", "numlock", "scrolllock", "contextmenu", "minus",
        "equal", "comma", "period", "slash", "backquote", "semicolon", "quote", "bracketleft", "bracketright",
        "backslash", "intlro",
    ];
    NAMED.iter().find(|n| vk_for(n).is_some_and(|(x, _)| x == v)).map(|n| n.to_string())
}

fn modifier_held() -> Option<VIRTUAL_KEY> {
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .into_iter()
        .find(|&vk| unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000 != 0)
}

/// ショートカットで実行した操作に、ユーザーがまだ押している修飾キーが混ざらないよう待つ。
pub fn wait_modifiers_released(timeout: Duration) {
    let end = std::time::Instant::now() + timeout;
    while modifier_held().is_some() && std::time::Instant::now() < end {
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// Alt / Win を押したままのショートカットは、離したときに「Alt だけ（Win だけ）押した」と見なされ、
/// メニューバーやスタートメニューが開いてしまう。割り当てのない vkE8 を挟んでそれを防ぐ（AutoHotkey と同じ方法）。
pub fn mask_menu_key() {
    let held = |vk: VIRTUAL_KEY| unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000 != 0;
    if held(VK_MENU) || held(VK_LWIN) || held(VK_RWIN) {
        let mask = VIRTUAL_KEY(0xE8);
        let _ = send(&[key_input(mask, true, false), key_input(mask, true, true)]);
    }
}

/// Unicode 入力なので、ゲームには効かないことが多い。
pub fn send_text(text: &str) -> Result<(), String> {
    let mut inputs = Vec::new();
    // 改行を U+000A のまま送っても多くのアプリは改行にしないので、Enter キーとして送る
    for unit in text.replace("\r\n", "\n").encode_utf16() {
        if unit == u16::from(b'\n') {
            inputs.push(key_input(VK_RETURN, false, false));
            inputs.push(key_input(VK_RETURN, false, true));
            continue;
        }
        for up in [false, true] {
            let mut flags = KEYEVENTF_UNICODE;
            if up {
                flags |= KEYEVENTF_KEYUP;
            }
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                },
            });
        }
    }
    send(&inputs)
}

static NOACTIVATE: LazyLock<Mutex<HashSet<isize>>> = LazyLock::new(Default::default);
static SUBCLASSED: LazyLock<Mutex<HashSet<isize>>> = LazyLock::new(Default::default);

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    unsafe {
        if NOACTIVATE.lock().unwrap().contains(&(hwnd.0 as isize)) {
            match msg {
                WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
                // Tauri (tao) がウィンドウ表示やサイズ変更のたびに拡張スタイルを書き直すので、
                // そのたびに WS_EX_NOACTIVATE を付け直す
                WM_STYLECHANGING if wparam.0 as i32 == GWL_EXSTYLE.0 => {
                    let ss = &mut *(lparam.0 as *mut STYLESTRUCT);
                    ss.styleNew |= WS_EX_NOACTIVATE.0;
                }
                _ => {}
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// 有効な間はキーボード入力を受け取れないので、編集時は解除する。
pub fn set_noactivate(win: &tauri::WebviewWindow, on: bool) {
    let Ok(h) = win.hwnd() else { return };
    let key = h.0 as isize;
    {
        let mut set = NOACTIVATE.lock().unwrap();
        if on {
            set.insert(key);
        } else {
            set.remove(&key);
        }
    }
    // サブクラス化とスタイル変更は、ウィンドウを作ったスレッド（メインスレッド）で行う必要がある
    let _ = win.run_on_main_thread(move || unsafe {
        let hwnd = HWND(key as _);
        if SUBCLASSED.lock().unwrap().insert(key) {
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), 1, 0);
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let flag = WS_EX_NOACTIVATE.0 as isize;
        let new = if on { ex | flag } else { ex & !flag };
        if new != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        }
    });
}
