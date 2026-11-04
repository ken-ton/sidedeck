use serde::Serialize;
use windows::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender};
use windows::Win32::System::Com::CLSCTX_ALL;
use windows::Win32::System::Power::*;
use windows::core::GUID;

#[derive(Serialize)]
pub struct Volume {
    pub level: f32,
    pub muted: bool,
}

fn endpoint() -> Result<IAudioEndpointVolume, String> {
    let en = crate::audio::enumerator()?;
    unsafe {
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|e| e.to_string())?;
        dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

pub fn get_volume() -> Result<Volume, String> {
    let ep = endpoint()?;
    unsafe {
        Ok(Volume {
            level: ep.GetMasterVolumeLevelScalar().map_err(|e| e.to_string())?,
            muted: ep.GetMute().map_err(|e| e.to_string())?.as_bool(),
        })
    }
}

pub fn set_volume(level: f32) -> Result<(), String> {
    let ep = endpoint()?;
    unsafe {
        ep.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())
            .map_err(|e| e.to_string())
    }
}

pub fn set_mute(muted: bool) -> Result<(), String> {
    let ep = endpoint()?;
    unsafe { ep.SetMute(muted, std::ptr::null()).map_err(|e| e.to_string()) }
}

#[derive(Serialize)]
pub struct PowerPlan {
    /// GUID を 32 桁の 16 進文字列にしたもの
    pub id: String,
    pub name: String,
    pub active: bool,
}

fn active_scheme() -> Option<GUID> {
    unsafe {
        let mut p: *mut GUID = std::ptr::null_mut();
        if PowerGetActiveScheme(None, &mut p) != ERROR_SUCCESS || p.is_null() {
            return None;
        }
        let g = *p;
        let _ = LocalFree(Some(HLOCAL(p as *mut _)));
        Some(g)
    }
}

pub fn list_power_plans() -> Vec<PowerPlan> {
    let active = active_scheme();
    let mut out = Vec::new();
    unsafe {
        let mut i = 0u32;
        loop {
            let mut guid = GUID::zeroed();
            let mut size = std::mem::size_of::<GUID>() as u32;
            if PowerEnumerate(None, None, None, ACCESS_SCHEME, i, Some(&mut guid as *mut _ as *mut u8), &mut size)
                != ERROR_SUCCESS
            {
                break;
            }
            let mut buf = vec![0u16; 256];
            let mut bytes = (buf.len() * 2) as u32;
            let name = if PowerReadFriendlyName(None, Some(&guid), None, None, Some(buf.as_mut_ptr() as *mut u8), &mut bytes)
                == ERROR_SUCCESS
            {
                crate::display::from_wide(&buf)
            } else {
                format!("{guid:?}")
            };
            out.push(PowerPlan { id: format!("{:032x}", guid.to_u128()), name, active: Some(guid) == active });
            i += 1;
        }
    }
    out
}

pub fn set_power_plan(id: &str) -> Result<(), String> {
    let v = u128::from_str_radix(id, 16).map_err(|e| e.to_string())?;
    let g = GUID::from_u128(v);
    let r = unsafe { PowerSetActiveScheme(None, Some(&g)) };
    if r != ERROR_SUCCESS {
        return Err(format!("電源プランの切り替えに失敗しました (code {})", r.0));
    }
    Ok(())
}

/// command: lock / sleep / monitor_off / empty_recycle_bin / screenshot / snip / sign_out / restart / shutdown
pub fn run_command(command: &str) -> Result<Option<String>, String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{HWND_BROADCAST, PostMessageW, SC_MONITORPOWER, WM_SYSCOMMAND};

    let shutdown = |args: &[&str]| {
        std::process::Command::new("shutdown")
            .args(args)
            .spawn()
            .map(|_| None)
            .map_err(|e| format!("実行できませんでした: {e}"))
    };
    match command {
        "lock" => unsafe { windows::Win32::System::Shutdown::LockWorkStation() }.map(|_| None).map_err(|e| e.to_string()),
        "sleep" => {
            // 戻ってくるのは復帰後なので、待たない
            std::thread::spawn(|| unsafe {
                let _ = SetSuspendState(false, false, false);
            });
            Ok(None)
        }
        // 2 は電源オフ。どの画面も、タッチやマウスの操作で復帰する
        "monitor_off" => unsafe { PostMessageW(Some(HWND_BROADCAST), WM_SYSCOMMAND, WPARAM(SC_MONITORPOWER as usize), LPARAM(2)) }
            .map(|_| None)
            .map_err(|e| e.to_string()),
        "empty_recycle_bin" => {
            use windows::Win32::UI::Shell::{SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND, SHEmptyRecycleBinW};
            // 空のときも失敗が返るので、結果は見ない
            let _ = unsafe { SHEmptyRecycleBinW(None, None, SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND) };
            Ok(Some("ごみ箱を空にしました".into()))
        }
        "screenshot" => crate::input::send_keys(&["win".into(), "printscreen".into()]).map(|_| Some("ピクチャの「スクリーンショット」フォルダに保存しました".into())),
        "snip" => crate::input::send_keys(&["win".into(), "shift".into(), "s".into()]).map(|_| None),
        "sign_out" => shutdown(&["/l"]),
        "restart" => shutdown(&["/r", "/t", "0"]),
        "shutdown" => shutdown(&["/s", "/t", "0"]),
        other => Err(format!("未対応の PC の操作です: {other}")),
    }
}
