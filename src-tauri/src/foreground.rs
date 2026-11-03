use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{BOOL, PWSTR};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WindowApp {
    /// 小文字のプロセス名
    pub name: String,
    pub title: String,
}

const IGNORE: &[&str] = &[
    "win-deck.exe",
    "searchhost.exe",
    "searchapp.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "lockapp.exe",
    "applicationframehost.exe",
];

#[derive(Default)]
pub struct LastForeground(pub Mutex<Option<WindowApp>>);

pub fn process_name(pid: u32) -> Option<String> {
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

fn window_app(hwnd: HWND) -> Option<WindowApp> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let name = process_name(pid)?;
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
        Some(WindowApp { name, title: String::from_utf16_lossy(&buf[..n]) })
    }
}

pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_name = String::new();
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let hwnd = unsafe { GetForegroundWindow() };
            if hwnd.is_invalid() {
                continue;
            }
            let Some(w) = window_app(hwnd) else { continue };
            if IGNORE.contains(&w.name.as_str()) || w.name == last_name {
                continue;
            }
            last_name = w.name.clone();
            *app.state::<LastForeground>().0.lock().unwrap() = Some(w.clone());
            let _ = app.emit("foreground-app", w);
        }
    });
}

pub fn list_window_apps() -> Vec<WindowApp> {
    unsafe extern "system" fn cb(h: HWND, data: LPARAM) -> BOOL {
        unsafe {
            let out = &mut *(data.0 as *mut Vec<HWND>);
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
            let owned = GetWindow(h, GW_OWNER).is_ok_and(|o| !o.is_invalid());
            // 最小化されているアプリも候補に含める
            if IsWindowVisible(h).as_bool()
                && ex & WS_EX_TOOLWINDOW.0 == 0
                && !owned
                && GetWindowTextLengthW(h) > 0
            {
                out.push(h);
            }
            BOOL(1)
        }
    }
    let mut hwnds: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut hwnds as *mut _ as isize));
    }
    let mut seen = HashSet::new();
    let mut apps: Vec<WindowApp> = hwnds
        .into_iter()
        .filter_map(window_app)
        .filter(|w| !IGNORE.contains(&w.name.as_str()) && seen.insert(w.name.clone()))
        .collect();
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps
}
