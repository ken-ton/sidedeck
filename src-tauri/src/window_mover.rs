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
use windows::core::{BOOL, PWSTR};

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
unsafe fn try_move(hwnd: HWND, deck: HMONITOR, target: RECT, me: u32, existing: &HashSet<u32>) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        // 起動前からウィンドウを持っていたプロセス（ターミナルやブラウザなど）は動かさない
        if pid == 0 || pid == me || existing.contains(&pid) {
            return false;
        }
        // 管理者権限のプロセスなどは名前も取れず、移動もできないので諦める
        let Some(name) = process_name(pid) else { return true };
        if SKIP.contains(&name.as_str()) {
            return false;
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if mon == deck {
            eprintln!("[window_mover] {name}: 既に移動先モニター上にあるので移動しない");
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
        let r = SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        eprintln!(
            "[window_mover] {name}: ({},{} {ww}x{wh}) → ({x},{y} {w}x{h}) 全画面={covers_monitor} 結果={r:?}",
            wr.left, wr.top
        );
        if zoomed {
            let _ = ShowWindow(hwnd, SW_MAXIMIZE);
        }
        true
    }
}

/// Steam の Big Picture モードのウィンドウが表示されていれば、そのモニターを返す。
pub(crate) fn big_picture_monitor() -> Option<HMONITOR> {
    unsafe extern "system" fn cb(h: HWND, data: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() {
                let mut buf = [0u16; 256];
                let n = GetWindowTextW(h, &mut buf).max(0) as usize;
                // タイトルは言語によって「Steam Big Pictureモード」「Steam Big Picture Mode」など
                if String::from_utf16_lossy(&buf[..n]).contains("Big Picture") {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(h, Some(&mut pid));
                    if process_name(pid).as_deref() == Some("steamwebhelper.exe") {
                        *(data.0 as *mut Option<HWND>) = Some(h);
                        return BOOL(0); // 見つかったので列挙を止める
                    }
                }
            }
            BOOL(1)
        }
    }
    let mut found: Option<HWND> = None;
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut found as *mut _ as isize));
        found.map(|h| MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST))
    }
}

/// 表示中のトップレベルウィンドウを持つプロセスの PID を集める。
fn processes_with_windows() -> HashSet<u32> {
    unsafe extern "system" fn cb(h: HWND, data: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(h).as_bool() {
                let mut pid = 0u32;
                GetWindowThreadProcessId(h, Some(&mut pid));
                (*(data.0 as *mut HashSet<u32>)).insert(pid);
            }
            BOOL(1)
        }
    }
    let mut set = HashSet::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut set as *mut _ as isize));
    }
    set
}

/// ゲーム起動直後に呼ぶ。`duration` の間、新しく前面に出たウィンドウを移動先モニターへ移す。
///
/// 移動先は通常 Deck モニター。ただし `prefer_big_picture` が true で
/// Steam の Big Picture モードが開いていれば、Big Picture があるモニターにする。
pub fn follow_launch(deck_gdi: String, duration: Duration, prefer_big_picture: bool) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // 起動前の状態を記録する（呼び出し元はゲームを起動した直後なので、ここで取れば十分早い）
    let existing = processes_with_windows();
    std::thread::spawn(move || {
        let bp = if prefer_big_picture { big_picture_monitor() } else { None };
        let Some(deck) = bp.or_else(|| crate::display::hmonitor_for(&deck_gdi)) else { return };
        let Some(target) = monitor_rect(deck) else { return };
        eprintln!(
            "[window_mover] 監視開始: BigPicture={} 移動先=({},{} {}x{})",
            if bp.is_some() { "あり" } else if prefer_big_picture { "なし" } else { "対象外" },
            target.left,
            target.top,
            target.right - target.left,
            target.bottom - target.top
        );
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
            if unsafe { try_move(hwnd, deck, target, me, &existing) } {
                done.insert(key);
            }
        }
    });
}

/// 進行中の監視を止める（Deck モード終了時など）
pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

