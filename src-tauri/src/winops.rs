use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::BOOL;

use crate::display;
use crate::foreground::process_name;

const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(h, &mut buf) }.max(0) as usize;
    String::from_utf16_lossy(&buf[..n])
}

fn pid_of(h: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

pub(crate) fn is_app_window(h: HWND) -> bool {
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        let owned = GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid());
        IsWindowVisible(h).as_bool() && ex & WS_EX_TOOLWINDOW.0 == 0 && !owned && GetWindowTextLengthW(h) > 0
    }
}

/// デッキは前面を奪わないので、タップした時点の前面ウィンドウ＝ユーザーが作業中のウィンドウ。
fn foreground_target() -> Result<HWND, String> {
    let h = unsafe { GetForegroundWindow() };
    if h.is_invalid() || pid_of(h) == std::process::id() || SHELL_CLASSES.contains(&class_name(h).as_str()) {
        return Err("操作するウィンドウがありません".into());
    }
    Ok(h)
}

/// 前面に近い順
fn app_windows(name: &str) -> Vec<HWND> {
    unsafe extern "system" fn cb(h: HWND, data: LPARAM) -> BOOL {
        unsafe { (*(data.0 as *mut Vec<HWND>)).push(h) };
        BOOL(1)
    }
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut all as *mut _ as isize));
    }
    let name = name.to_lowercase();
    all.into_iter()
        .filter(|&h| is_app_window(h) && process_name(pid_of(h)).as_deref() == Some(name.as_str()))
        .collect()
}

/// SetForegroundWindow はバックグラウンドのプロセスからだと拒否されることがあるので、
/// 失敗したら前面スレッドに入力を一時的にアタッチしてからやり直す。
fn activate(h: HWND) -> Result<(), String> {
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        if SetForegroundWindow(h).as_bool() && GetForegroundWindow() == h {
            return Ok(());
        }
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = BringWindowToTop(h);
        let _ = SetForegroundWindow(h);
        let _ = SetFocus(Some(h));
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        if GetForegroundWindow() == h {
            Ok(())
        } else {
            Err("ウィンドウを前面に出せませんでした".into())
        }
    }
}

/// 起動していなければ `launch` を開く。すでに前面にあれば、同じアプリの次のウィンドウに切り替える。
pub fn focus_app(app: &tauri::AppHandle, name: &str, launch: &str) -> Result<Option<String>, String> {
    let wins = app_windows(name);
    if wins.is_empty() {
        if launch.trim().is_empty() {
            return Err(format!("{name} は起動していません"));
        }
        crate::actions::launch(app, launch, "")?;
        return Ok(Some(format!("{name} を起動しました")));
    }
    let fg = unsafe { GetForegroundWindow() };
    // z 順の最後（いちばん奥）を出すと、タップするたびに全ウィンドウを順に巡回できる
    let target = if wins.contains(&fg) { *wins.last().unwrap() } else { wins[0] };
    activate(target).map(|_| None)
}

fn monitor_rects(h: HMONITOR) -> Option<(RECT, RECT)> {
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(h, &mut mi) }.as_bool().then_some((mi.rcMonitor, mi.rcWork))
}

/// `target` が None なら次のモニター（`skip` のモニターは飛ばす）へ移す。
/// 移動先でも、作業領域に対する相対位置と大きさを保つ。
pub fn move_foreground(target: Option<&str>, skip: Option<&str>) -> Result<Option<String>, String> {
    let h = foreground_target()?;
    let mut mons = display::list_monitors();
    mons.sort_by_key(|m| (m.x, m.y));
    let handles: Vec<(display::MonitorInfo, HMONITOR)> = mons
        .into_iter()
        .filter_map(|m| display::hmonitor_for(&m.gdi_name).map(|hm| (m, hm)))
        .collect();
    let cur = unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) };

    let dest = match target {
        Some(path) => handles
            .iter()
            .find(|(m, _)| m.device_path == path)
            .ok_or("移動先のモニターが接続されていません")?,
        None => {
            let candidates: Vec<_> = handles
                .iter()
                .filter(|(m, hm)| *hm == cur || skip != Some(m.device_path.as_str()))
                .collect();
            let pos = candidates.iter().position(|(_, hm)| *hm == cur).unwrap_or(0);
            let next = candidates.get((pos + 1) % candidates.len().max(1)).ok_or("移動先のモニターがありません")?;
            *next
        }
    };
    if dest.1 == cur {
        return Ok(None);
    }

    let (src_full, src_work) = monitor_rects(cur).ok_or("モニターの情報を取得できません")?;
    let (dst_full, dst_work) = monitor_rects(dest.1).ok_or("モニターの情報を取得できません")?;
    unsafe {
        let zoomed = IsZoomed(h).as_bool();
        if zoomed {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let mut wr = RECT::default();
        GetWindowRect(h, &mut wr).map_err(|e| e.to_string())?;
        // ボーダーレス全画面はモニター全体、それ以外は作業領域（タスクバーを除く）を基準にする
        let fullscreen = wr.left <= src_full.left && wr.top <= src_full.top && wr.right >= src_full.right && wr.bottom >= src_full.bottom;
        let (s, d) = if fullscreen { (src_full, dst_full) } else { (src_work, dst_work) };
        let (sw, sh) = ((s.right - s.left).max(1) as f64, (s.bottom - s.top).max(1) as f64);
        let (dw, dh) = ((d.right - d.left) as f64, (d.bottom - d.top) as f64);
        let x = d.left + ((wr.left - s.left) as f64 / sw * dw) as i32;
        let y = d.top + ((wr.top - s.top) as f64 / sh * dh) as i32;
        let w = ((wr.right - wr.left) as f64 / sw * dw) as i32;
        let hgt = ((wr.bottom - wr.top) as f64 / sh * dh) as i32;
        SetWindowPos(h, None, x, y, w, hgt, SWP_NOZORDER | SWP_NOACTIVATE)
            .map_err(|_| "ウィンドウを移動できませんでした（管理者権限のアプリは移動できません）".to_string())?;
        if zoomed {
            let _ = ShowWindow(h, SW_MAXIMIZE);
        }
    }
    let name = if dest.0.friendly_name.is_empty() { dest.0.gdi_name.clone() } else { dest.0.friendly_name.clone() };
    Ok(Some(format!("{name} へ移動しました")))
}

pub fn toggle_maximize() -> Result<Option<String>, String> {
    let h = foreground_target()?;
    unsafe {
        let _ = ShowWindow(h, if IsZoomed(h).as_bool() { SW_RESTORE } else { SW_MAXIMIZE });
    }
    Ok(None)
}

pub fn minimize() -> Result<Option<String>, String> {
    let h = foreground_target()?;
    unsafe {
        let _ = ShowWindow(h, SW_MINIMIZE);
    }
    Ok(None)
}

fn intersects(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/// `deck` が `area` の中で一番手前なら最背面へ、そうでなければ最前面へ移す。どちらもアクティブにはしない。
/// タスクバーなどの常に手前にあるウィンドウは、手前かどうかの判定から外す。
pub fn toggle_front(deck: HWND, area: RECT) {
    unsafe {
        let mut front = false;
        let mut h = GetTopWindow(None).unwrap_or_default();
        while !h.is_invalid() {
            if h == deck {
                front = true;
                break;
            }
            let topmost = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0;
            let mut r = RECT::default();
            if !topmost && is_app_window(h) && !IsIconic(h).as_bool() && GetWindowRect(h, &mut r).is_ok() && intersects(&r, &area) {
                break;
            }
            h = GetWindow(h, GW_HWNDNEXT).unwrap_or_default();
        }
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
        if front {
            let _ = SetWindowPos(deck, Some(HWND_BOTTOM), 0, 0, 0, 0, flags);
        } else {
            // TOPMOST にしてすぐ戻すと、アクティブにせずに通常ウィンドウの一番手前へ出せる
            let _ = SetWindowPos(deck, Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
            let _ = SetWindowPos(deck, Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
        }
    }
}
