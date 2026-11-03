//! ゲーム起動後に前面に出たウィンドウを Deck モニターへ移動する。
//!
//! プライマリを切り替えない運用では、ゲームはプライマリ側で起動しがちなので、
//! 起動からしばらくの間、前面ウィンドウを監視して Deck モニターへ移す。
//! 各ウィンドウは 1 回だけ移動するので、ユーザーが手で戻せば戻ったままになる。

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::PWSTR;

/// 新しい起動があったら古い監視を止めるための世代番号
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// 移動しないプロセス（ランチャーやシェル）
const SKIP: &[&str] = &[
    "win-deck.exe",
    "steam.exe",
    "steamwebhelper.exe",
    "epicgameslauncher.exe",
    "epicwebhelper.exe",
    "explorer.exe",
    "searchhost.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "textinputhost.exe",
    "applicationframehost.exe",
    "lockapp.exe",
];

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().map(|s| s.to_lowercase())
    }
}

fn monitor_rect(h: HMONITOR) -> Option<RECT> {
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(h, &mut mi) }.as_bool().then_some(mi.rcMonitor)
}

/// 前面ウィンドウを 1 つ調べ、必要なら Deck モニターへ移す。処理済みなら true。
unsafe fn try_move(hwnd: HWND, deck: HMONITOR, target: RECT, me: u32) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == me {
            return false;
        }
        // 管理者権限のプロセスなどは名前も取れず、移動もできないので諦める
        let Some(name) = process_name(pid) else { return true };
        if SKIP.contains(&name.as_str()) {
            return false;
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if mon == deck {
            return true;
        }
        let Some(src) = monitor_rect(mon) else { return false };
        let mut wr = RECT::default();
        if GetWindowRect(hwnd, &mut wr).is_err() {
            return false;
        }
        let (ww, wh) = (wr.right - wr.left, wr.bottom - wr.top);
        if ww < 320 || wh < 200 {
            return false; // スプラッシュや通知などの小さいウィンドウは後回し
        }
        let (tw, th) = (target.right - target.left, target.bottom - target.top);
        let zoomed = IsZoomed(hwnd).as_bool();
        let covers_monitor =
            wr.left <= src.left && wr.top <= src.top && wr.right >= src.right && wr.bottom >= src.bottom;

        let (x, y, w, h) = if covers_monitor && !zoomed {
            // ボーダーレス全画面 → Deck モニター全体に合わせる
            (target.left, target.top, tw, th)
        } else {
            let (w, h) = (ww.min(tw), wh.min(th));
            (target.left + (tw - w) / 2, target.top + (th - h) / 2, w, h)
        };
        if zoomed {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        if zoomed {
            let _ = ShowWindow(hwnd, SW_MAXIMIZE);
        }
        true
    }
}

/// ゲーム起動直後に呼ぶ。`duration` の間、新しく前面に出たウィンドウを Deck モニターへ移す。
pub fn follow_launch(deck_gdi: String, duration: Duration) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let Some(deck) = crate::display::hmonitor_for(&deck_gdi) else { return };
        let Some(target) = monitor_rect(deck) else { return };
        let me = std::process::id();
        let mut done: HashSet<isize> = HashSet::new();
        let start = Instant::now();
        while start.elapsed() < duration && GENERATION.load(Ordering::SeqCst) == generation {
            std::thread::sleep(Duration::from_millis(400));
            let hwnd = unsafe { GetForegroundWindow() };
            let key = hwnd.0 as isize;
            if hwnd.is_invalid() || done.contains(&key) {
                continue;
            }
            if unsafe { try_move(hwnd, deck, target, me) } {
                done.insert(key);
            }
        }
    });
}

/// 進行中の監視を止める（Deck モード終了時など）
pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}
