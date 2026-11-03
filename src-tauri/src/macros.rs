use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::actions::Action;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Step {
    Keys { keys: Vec<String> },
    KeyDown { keys: Vec<String> },
    KeyUp { keys: Vec<String> },
    Text { text: String },
    Wait { ms: u64 },
    Action { action: Box<Action> },
}

#[derive(Serialize, Clone)]
struct MacroState {
    id: String,
    running: bool,
    error: Option<String>,
}

static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

/// 同じ `id` が実行中なら停止する。`repeat` が 0 なら停止されるまで繰り返す。
pub fn toggle(app: &AppHandle, id: String, steps: Vec<Step>, repeat: u32) -> Option<String> {
    let mut running = RUNNING.lock().unwrap();
    if let Some(cancel) = running.get(&id) {
        cancel.store(true, Ordering::SeqCst);
        return Some("マクロを停止しました".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    running.insert(id.clone(), cancel.clone());
    drop(running);

    let app = app.clone();
    let _ = app.emit("macro-state", MacroState { id: id.clone(), running: true, error: None });
    std::thread::spawn(move || {
        let mut held: Vec<String> = Vec::new();
        let result = run_steps(&app, &steps, repeat, &cancel, &mut held);
        // 途中で止めても、押しっぱなしのキーが残らないようにする
        if !held.is_empty() {
            let _ = crate::input::key_up(&held);
        }
        RUNNING.lock().unwrap().remove(&id);
        let _ = app.emit("macro-state", MacroState { id, running: false, error: result.err() });
    });
    None
}

fn sleep_unless_cancelled(ms: u64, cancel: &AtomicBool) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep((end - Instant::now()).min(Duration::from_millis(15)));
    }
    !cancel.load(Ordering::SeqCst)
}

fn run_steps(app: &AppHandle, steps: &[Step], repeat: u32, cancel: &AtomicBool, held: &mut Vec<String>) -> Result<(), String> {
    if steps.is_empty() {
        return Ok(());
    }
    let has_wait = steps.iter().any(|s| matches!(s, Step::Wait { ms } if *ms > 0));
    let mut round = 0;
    while repeat == 0 || round < repeat {
        for step in steps {
            if cancel.load(Ordering::SeqCst) {
                return Ok(());
            }
            match step {
                Step::Keys { keys } => crate::input::send_keys(keys)?,
                Step::KeyDown { keys } => {
                    crate::input::key_down(keys)?;
                    held.extend(keys.iter().filter(|k| !held.contains(k)).cloned().collect::<Vec<_>>());
                }
                Step::KeyUp { keys } => {
                    crate::input::key_up(keys)?;
                    held.retain(|k| !keys.contains(k));
                }
                Step::Text { text } => crate::input::send_text(text)?,
                Step::Wait { ms } => {
                    if !sleep_unless_cancelled(*ms, cancel) {
                        return Ok(());
                    }
                }
                Step::Action { action } => {
                    if matches!(**action, Action::Macro { .. }) {
                        return Err("マクロの中でマクロは実行できません".into());
                    }
                    crate::actions::run(app, (**action).clone(), None)?;
                }
            }
        }
        round += 1;
        // 待ちのない無限ループで CPU を使い切らないように
        if repeat == 0 && !has_wait && !sleep_unless_cancelled(10, cancel) {
            return Ok(());
        }
    }
    Ok(())
}

struct RecEvent {
    at: Instant,
    key: String,
    down: bool,
}

static EVENTS: LazyLock<Mutex<Vec<RecEvent>>> = LazyLock::new(Default::default);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
const MAX_EVENTS: usize = 5000;

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if code >= 0 {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            // win-deck 自身が送った入力（マクロの再生など）は記録しない
            let injected = kb.flags.0 & LLKHF_INJECTED.0 != 0;
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            if !injected {
                if let Some(key) = crate::input::name_for_vk(kb.vkCode as u16) {
                    let mut ev = EVENTS.lock().unwrap();
                    // 押しっぱなしによるキーリピートは 1 回の押下として扱う
                    let repeat = down && ev.iter().rev().find(|e| e.key == key).is_some_and(|e| e.down);
                    if !repeat && ev.len() < MAX_EVENTS {
                        ev.push(RecEvent { at: Instant::now(), key, down });
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }
}

pub fn start_recording() -> Result<(), String> {
    if HOOK_THREAD.load(Ordering::SeqCst) != 0 {
        return Err("すでに記録中です".into());
    }
    EVENTS.lock().unwrap().clear();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let module = GetModuleHandleW(None).ok();
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module.map(|m| m.into()), 0) {
            Ok(h) => h,
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
                return;
            }
        };
        HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        let _ = tx.send(Ok(()));
        // 低レベルフックはこのスレッドのメッセージループで呼ばれる
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(hook);
        HOOK_THREAD.store(0, Ordering::SeqCst);
    });
    rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "記録を開始できませんでした".to_string())?
}

pub fn stop_recording(keep_timing: bool) -> Vec<Step> {
    let tid = HOOK_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    let events = std::mem::take(&mut *EVENTS.lock().unwrap());
    to_steps(&events, keep_timing)
}

/// 短く押して離しただけのキーは「キーを押す」1 ステップにまとめる。
fn to_steps(events: &[RecEvent], keep_timing: bool) -> Vec<Step> {
    const TAP_MS: u128 = 150;
    let mut steps = Vec::new();
    let mut last: Option<Instant> = None;
    let mut i = 0;
    while i < events.len() {
        let e = &events[i];
        if keep_timing {
            if let Some(prev) = last {
                let ms = (e.at - prev).as_millis() as u64 / 10 * 10;
                if ms > 0 {
                    steps.push(Step::Wait { ms });
                }
            }
        }
        let next = events.get(i + 1);
        let tap = e.down
            && next.is_some_and(|n| !n.down && n.key == e.key && (n.at - e.at).as_millis() <= TAP_MS);
        if tap {
            steps.push(Step::Keys { keys: vec![e.key.clone()] });
            last = Some(events[i + 1].at);
            i += 2;
            continue;
        }
        let keys = vec![e.key.clone()];
        steps.push(if e.down { Step::KeyDown { keys } } else { Step::KeyUp { keys } });
        last = Some(e.at);
        i += 1;
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(base: Instant, ms: u64, key: &str, down: bool) -> RecEvent {
        RecEvent { at: base + Duration::from_millis(ms), key: key.into(), down }
    }

    #[test]
    fn converts_taps_and_holds() {
        let t = Instant::now();
        let events = vec![
            ev(t, 0, "w", true),
            ev(t, 1000, "w", false),
            ev(t, 1200, "ctrl", true),
            ev(t, 1250, "c", true),
            ev(t, 1300, "c", false),
            ev(t, 1400, "ctrl", false),
        ];
        let k = |s: &str| vec![s.to_string()];
        assert_eq!(
            to_steps(&events, true),
            vec![
                Step::KeyDown { keys: k("w") },
                Step::Wait { ms: 1000 },
                Step::KeyUp { keys: k("w") },
                Step::Wait { ms: 200 },
                Step::KeyDown { keys: k("ctrl") },
                Step::Wait { ms: 50 },
                Step::Keys { keys: k("c") },
                Step::Wait { ms: 100 },
                Step::KeyUp { keys: k("ctrl") },
            ]
        );
        assert!(!to_steps(&events, false).iter().any(|s| matches!(s, Step::Wait { .. })));
    }
}
