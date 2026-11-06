//! トラックパッドの位置に透明なウィンドウを重ね、タッチをそこで直接受け取る。
//! WebView でタッチを受けると、Windows がマウス入力へ置き換えるときにカーソルを指の位置へ移してしまう。
//! WM_POINTER を自分で処理して DefWindowProc に渡さなければ、この置き換えが起きずカーソルは動かない。

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// x / y / w / h は WebView のクライアント座標（CSS ピクセル）
#[derive(Deserialize, Clone)]
pub struct Area {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    speed: f64,
}

#[derive(Serialize, Clone)]
struct StateEvent<'a> {
    id: &'a str,
    state: &'a str,
}

#[derive(Serialize, Clone)]
struct ErrorEvent<'a> {
    id: &'a str,
    message: String,
}

const TAP_MS: u128 = 250;
const TAP_SLOP: f64 = 8.0;
/// 動かさずにこの時間触れていたら、左ボタンを押したままにする（そのまま動かすとドラッグ）
const DRAG_HOLD_MS: u32 = 400;
/// 指 1 DIP あたりのホイールの量（120 で 1 ノッチ）
const SCROLL_PER_DIP: f64 = 3.0;

const TIMER_HOLD: usize = 1;
/// デッキの移動や非表示に追従する
const TIMER_LAYOUT: usize = 2;
const LAYOUT_MS: u32 = 300;
const WM_APP_AREAS: u32 = WM_APP + 1;

static APP: OnceLock<AppHandle> = OnceLock::new();
static DECK_HWND: AtomicIsize = AtomicIsize::new(0);
static UI_THREAD: AtomicU32 = AtomicU32::new(0);
static PENDING: Mutex<Option<Vec<Area>>> = Mutex::new(None);

#[derive(Default)]
struct Gesture {
    pointers: HashMap<u32, (i32, i32)>,
    start: HashMap<u32, (i32, i32)>,
    started: Option<Instant>,
    max_pointers: usize,
    moved: bool,
    dragging: bool,
    moving: (f64, f64),
    scrolling: (f64, f64),
}

struct Pad {
    hwnd: HWND,
    area: Area,
    g: Gesture,
}

thread_local! {
    static PADS: RefCell<Vec<Pad>> = const { RefCell::new(Vec::new()) };
}

fn emit_state(id: &str, state: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("trackpad-state", StateEvent { id, state });
    }
}

fn report(id: &str, r: Result<(), String>) {
    if let (Err(message), Some(app)) = (r, APP.get()) {
        let _ = app.emit("trackpad-error", ErrorEvent { id, message });
    }
}

fn deck_hwnd() -> Option<HWND> {
    let h = DECK_HWND.load(Ordering::SeqCst);
    (h != 0).then_some(HWND(h as *mut _))
}

pub fn set_areas(app: &AppHandle, deck: HWND, areas: Vec<Area>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    DECK_HWND.store(deck.0 as isize, Ordering::SeqCst);
    *PENDING.lock().unwrap() = Some(areas);
    let tid = start_thread()?;
    unsafe { PostThreadMessageW(tid, WM_APP_AREAS, WPARAM(0), LPARAM(0)) }.map_err(|e| e.to_string())
}

fn start_thread() -> Result<u32, String> {
    let tid = UI_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        return Ok(tid);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let Ok(module) = GetModuleHandleW(None) else {
            let _ = tx.send(Err("トラックパッドを準備できませんでした".to_string()));
            return;
        };
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: module.into(),
            lpszClassName: w!("SideDeckTrackpad"),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            ..Default::default()
        };
        RegisterClassW(&class);
        // メッセージキューを作ってから ID を知らせる（先に PostThreadMessage されると失われる）
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let tid = GetCurrentThreadId();
        UI_THREAD.store(tid, Ordering::SeqCst);
        let _ = tx.send(Ok(tid));
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.hwnd.is_invalid() && msg.message == WM_APP_AREAS {
                if let Some(areas) = PENDING.lock().unwrap().take() {
                    apply_areas(areas);
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
    rx.recv().map_err(|_| "トラックパッドを準備できませんでした".to_string())?
}

fn apply_areas(areas: Vec<Area>) {
    let Some(deck) = deck_hwnd() else { return };
    PADS.with_borrow_mut(|pads| {
        while pads.len() > areas.len() {
            let p = pads.pop().unwrap();
            if p.g.dragging {
                report(&p.area.id, button("left", "up"));
            }
            unsafe {
                let _ = DestroyWindow(p.hwnd);
            }
        }
        for (i, area) in areas.into_iter().enumerate() {
            if let Some(p) = pads.get_mut(i) {
                if p.area.id != area.id {
                    p.g = Gesture::default();
                }
                p.area = area;
                continue;
            }
            let Some(hwnd) = create_window(deck) else { continue };
            pads.push(Pad { hwnd, area, g: Gesture::default() });
        }
    });
    layout();
}

fn create_window(owner: HWND) -> Option<HWND> {
    unsafe {
        let module = GetModuleHandleW(None).ok()?;
        let hwnd = CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
            w!("SideDeckTrackpad"),
            w!(""),
            WS_POPUP,
            0,
            0,
            0,
            0,
            Some(owner),
            None,
            Some(module.into()),
            None,
        )
        .ok()?;
        // 完全に透明（0）だとタッチが下のウィンドウへ抜けるので、見えない程度に残す
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA);
        SetTimer(Some(hwnd), TIMER_LAYOUT, LAYOUT_MS, None);
        Some(hwnd)
    }
}

fn layout() {
    let Some(deck) = deck_hwnd() else { return };
    unsafe {
        let visible = IsWindowVisible(deck).as_bool() && !IsIconic(deck).as_bool();
        let mut origin = POINT::default();
        let _ = ClientToScreen(deck, &mut origin);
        let scale = GetDpiForWindow(deck) as f64 / 96.0;
        PADS.with_borrow(|pads| {
            for p in pads {
                let a = &p.area;
                let flags = SWP_NOACTIVATE | SWP_NOZORDER | if visible { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
                let _ = SetWindowPos(
                    p.hwnd,
                    None,
                    origin.x + (a.x * scale).round() as i32,
                    origin.y + (a.y * scale).round() as i32,
                    (a.w * scale).round() as i32,
                    (a.h * scale).round() as i32,
                    flags,
                );
            }
        });
    }
}

fn pointer_id(wparam: WPARAM) -> u32 {
    (wparam.0 & 0xFFFF) as u32
}

fn pointer_pos(lparam: LPARAM) -> (i32, i32) {
    ((lparam.0 & 0xFFFF) as i16 as i32, ((lparam.0 >> 16) & 0xFFFF) as i16 as i32)
}

fn on_down(hwnd: HWND, p: &mut Pad, id: u32, pos: (i32, i32)) {
    let g = &mut p.g;
    if g.pointers.is_empty() {
        *g = Gesture { started: Some(Instant::now()), ..Default::default() };
        emit_state(&p.area.id, "touching");
        unsafe { SetTimer(Some(hwnd), TIMER_HOLD, DRAG_HOLD_MS, None) };
    } else {
        unsafe {
            let _ = KillTimer(Some(hwnd), TIMER_HOLD);
        }
    }
    g.pointers.insert(id, pos);
    g.start.insert(id, pos);
    g.max_pointers = g.max_pointers.max(g.pointers.len());
}

fn on_hold(hwnd: HWND, p: &mut Pad) {
    unsafe {
        let _ = KillTimer(Some(hwnd), TIMER_HOLD);
    }
    let g = &mut p.g;
    if g.moved || g.pointers.len() != 1 || g.dragging {
        return;
    }
    g.dragging = true;
    emit_state(&p.area.id, "holding");
    report(&p.area.id, button("left", "down"));
}

fn on_move(hwnd: HWND, p: &mut Pad, id: u32, pos: (i32, i32)) {
    let g = &mut p.g;
    let Some(prev) = g.pointers.insert(id, pos) else { return };
    let (dx, dy) = ((pos.0 - prev.0) as f64, (pos.1 - prev.1) as f64);
    let start = g.start[&id];
    if !g.moved && (((pos.0 - start.0) as f64).hypot((pos.1 - start.1) as f64)) > TAP_SLOP {
        g.moved = true;
        unsafe {
            let _ = KillTimer(Some(hwnd), TIMER_HOLD);
        }
    }
    if !g.moved {
        return;
    }
    let n = g.pointers.len();
    // 2 本指のスクロールから 1 本だけ離したときに、残りの指でカーソルを動かさない
    if n == 1 && g.max_pointers == 1 {
        g.moving.0 += dx * p.area.speed;
        g.moving.1 += dy * p.area.speed;
        let (mx, my) = (g.moving.0.trunc(), g.moving.1.trunc());
        g.moving.0 -= mx;
        g.moving.1 -= my;
        if mx != 0.0 || my != 0.0 {
            report(&p.area.id, move_by(mx as i32, my as i32));
        }
    } else if n == 2 {
        let k = SCROLL_PER_DIP * 96.0 / unsafe { GetDpiForWindow(hwnd) }.max(1) as f64 / n as f64;
        // 指の動きにページが付いてくる向き（Windows のタッチパッドの既定と同じ）
        g.scrolling.0 -= dx * k;
        g.scrolling.1 += dy * k;
        let (sx, sy) = (g.scrolling.0.trunc(), g.scrolling.1.trunc());
        g.scrolling.0 -= sx;
        g.scrolling.1 -= sy;
        if sx != 0.0 || sy != 0.0 {
            report(&p.area.id, scroll(sx as i32, sy as i32));
        }
    }
}

fn on_up(hwnd: HWND, p: &mut Pad, id: u32, cancelled: bool) {
    let g = &mut p.g;
    if g.pointers.remove(&id).is_none() || !g.pointers.is_empty() {
        return;
    }
    unsafe {
        let _ = KillTimer(Some(hwnd), TIMER_HOLD);
    }
    emit_state(&p.area.id, "idle");
    if g.dragging {
        g.dragging = false;
        report(&p.area.id, button("left", "up"));
        return;
    }
    let quick = g.started.is_some_and(|t| t.elapsed().as_millis() <= TAP_MS);
    if cancelled || g.moved || !quick {
        return;
    }
    let b = match g.max_pointers {
        1 => "left",
        2 => "right",
        _ => "middle",
    };
    report(&p.area.id, button(b, "click"));
}

/// DestroyWindow や SetWindowPos の中から同期的に呼ばれることがあるので、借用中なら何もしない
fn with_pad(hwnd: HWND, f: impl FnOnce(&mut Pad)) -> bool {
    PADS.with(|cell| {
        let Ok(mut pads) = cell.try_borrow_mut() else { return false };
        pads.iter_mut().find(|p| p.hwnd == hwnd).map(f).is_some()
    })
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP | WM_POINTERCAPTURECHANGED => {
            let id = pointer_id(wparam);
            let pos = pointer_pos(lparam);
            if with_pad(hwnd, |p| match msg {
                WM_POINTERDOWN => on_down(hwnd, p, id, pos),
                WM_POINTERUPDATE => on_move(hwnd, p, id, pos),
                WM_POINTERUP => on_up(hwnd, p, id, false),
                _ => on_up(hwnd, p, id, true),
            }) {
                return LRESULT(0);
            }
        }
        WM_POINTERACTIVATE => return LRESULT(PA_NOACTIVATE as isize),
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_TIMER if wparam.0 == TIMER_HOLD => {
            with_pad(hwnd, |p| on_hold(hwnd, p));
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == TIMER_LAYOUT => {
            layout();
            return LRESULT(0);
        }
        _ => {}
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize != inputs.len() {
        return Err("マウス操作を送信できませんでした（管理者権限のアプリには送れません）".into());
    }
    Ok(())
}

fn move_by(dx: i32, dy: i32) -> Result<(), String> {
    send(&[mouse(MOUSEEVENTF_MOVE, dx, dy, 0)])
}

/// 1 ノッチは 120
fn scroll(dx: i32, dy: i32) -> Result<(), String> {
    let mut inputs = Vec::new();
    if dy != 0 {
        inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, dy));
    }
    if dx != 0 {
        inputs.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx));
    }
    if inputs.is_empty() {
        return Ok(());
    }
    send(&inputs)
}

fn button(button: &str, action: &str) -> Result<(), String> {
    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        _ => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    match action {
        "click" => send(&[mouse(down, 0, 0, 0), mouse(up, 0, 0, 0)]),
        "down" => send(&[mouse(down, 0, 0, 0)]),
        _ => send(&[mouse(up, 0, 0, 0)]),
    }
}
