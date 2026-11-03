//! キー入力の送信と、フォーカスを奪わないウィンドウ設定。

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::*;

/// キー名 → 仮想キー。`media` が true のキーはスキャンコードを持たないので VK で送る。
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
    let (wvk, wscan) = if media {
        (vk, 0)
    } else {
        // ゲームの多くはスキャンコード（DirectInput / Raw Input）で読むので、スキャンコードで送る
        let sc = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC_EX) };
        flags |= KEYEVENTF_SCANCODE;
        if sc & 0xFF00 == 0xE000 || sc & 0xFF00 == 0xE100 {
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

/// `["ctrl", "shift", "s"]` のような組み合わせを押して離す。
pub fn send_keys(keys: &[String]) -> Result<(), String> {
    let vks: Vec<_> = keys
        .iter()
        .map(|k| vk_for(k).ok_or_else(|| format!("未対応のキーです: {k}")))
        .collect::<Result<_, _>>()?;
    let down: Vec<_> = vks.iter().map(|&(vk, m)| key_input(vk, m, false)).collect();
    let up: Vec<_> = vks.iter().rev().map(|&(vk, m)| key_input(vk, m, true)).collect();
    send(&down)?;
    // ゲームはフレーム単位で入力を読むので、押している時間を少し取る
    std::thread::sleep(Duration::from_millis(40));
    send(&up)
}

/// 文字列をそのまま入力する（Unicode 入力。ゲームには効かないことが多い）。
pub fn send_text(text: &str) -> Result<(), String> {
    let mut inputs = Vec::new();
    for unit in text.encode_utf16() {
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

/// 前面ウィンドウのプロセス名と、管理者権限で動いているかを返す（診断用）。
/// 権限が取れない場合は None（保護されたプロセスや、管理者権限のプロセスのことが多い）。
pub fn foreground_info() -> (String, Option<bool>) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
    use windows::Win32::System::Threading::{OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let name = crate::window_mover::process_name(pid).unwrap_or_else(|| format!("pid {pid}"));
        let elevated = (|| {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut token = HANDLE::default();
            let ok = OpenProcessToken(h, TOKEN_QUERY, &mut token).is_ok();
            let _ = CloseHandle(h);
            if !ok {
                return None;
            }
            let mut e = TOKEN_ELEVATION::default();
            let mut len = 0u32;
            let r = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut e as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            let _ = CloseHandle(token);
            r.ok()?;
            Some(e.TokenIsElevated != 0)
        })();
        (name, elevated)
    }
}

/// 自分（win-deck）が管理者権限で動いているか。
pub fn self_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut e = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let r = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut e as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        let _ = CloseHandle(token);
        r.is_ok() && e.TokenIsElevated != 0
    }
}

/// NOACTIVATE を有効にしているウィンドウ（HWND の値）
static NOACTIVATE: LazyLock<Mutex<HashSet<isize>>> = LazyLock::new(Default::default);
/// サブクラス化済みのウィンドウ
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
                // クリック・タップでアクティブにしない
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

/// クリック・タップしてもアクティブにならないウィンドウにする（WS_EX_NOACTIVATE）。
/// 前面のアプリやゲームからフォーカスを奪わずにボタンを押せるようになる。
/// その代わりキーボード入力は受け取れないので、編集時は解除する。
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
