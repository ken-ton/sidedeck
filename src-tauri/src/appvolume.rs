use serde::Serialize;
use std::collections::BTreeMap;
use std::ffi::c_void;
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Media::Audio::*;
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::UI::Shell::SHLoadIndirectString;

pub const SYSTEM_SOUNDS: &str = "__system__";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVolume {
    /// プロセス名（小文字）。システム音は SYSTEM_SOUNDS
    key: String,
    name: String,
    path: Option<String>,
    level: f32,
    muted: bool,
}

struct Session {
    key: String,
    path: Option<String>,
    display: String,
    volume: ISimpleAudioVolume,
}

fn sessions() -> Result<Vec<Session>, String> {
    let en = crate::audio::enumerator()?;
    let mut out = Vec::new();
    unsafe {
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|e| e.to_string())?;
        let mgr = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
        let list = mgr.GetSessionEnumerator().map_err(|e| e.to_string())?;
        for i in 0..list.GetCount().map_err(|e| e.to_string())? {
            let Ok(ctl) = list.GetSession(i) else { continue };
            if ctl.GetState().is_ok_and(|s| s == AudioSessionStateExpired) {
                continue;
            }
            let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
            let Ok(volume) = ctl.cast::<ISimpleAudioVolume>() else { continue };
            let display = ctl
                .GetDisplayName()
                .ok()
                .map(|p| {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as *const c_void));
                    s
                })
                .filter(|s| !s.starts_with('@'))
                .unwrap_or_default();
            if ctl2.IsSystemSoundsSession().0 == 0 {
                out.push(Session { key: SYSTEM_SOUNDS.into(), path: None, display: "システム音".into(), volume });
                continue;
            }
            let Some(path) = ctl2.GetProcessId().ok().and_then(crate::foreground::process_path) else { continue };
            let key = match package_of(&path) {
                Some(p) => p.to_lowercase(),
                None => exe_name(&path),
            };
            out.push(Session { key, path: Some(path), display, volume });
        }
    }
    Ok(out)
}

fn exe_name(path: &str) -> String {
    path.rsplit('\\').next().unwrap_or(path).to_lowercase()
}

/// ストアアプリはパッケージのフォルダ名（パッケージのフルネーム）を返す。
/// Apple Music のように、1 つのアプリが複数のプロセスで音を出すので、パッケージ単位でまとめる
fn package_of(path: &str) -> Option<&str> {
    let i = path.to_ascii_lowercase().find("\\windowsapps\\")? + "\\windowsapps\\".len();
    path[i..].split('\\').next().filter(|s| s.contains('_'))
}

/// 音量ミキサーと同じく、パッケージの表示名を使う（例: "Apple Music"）
fn package_display_name(path: &str) -> Option<String> {
    let full = package_of(path)?;
    let i = path.find(full)? + full.len();
    let manifest = std::fs::read_to_string(format!("{}\\AppxManifest.xml", &path[..i])).ok()?;
    let start = manifest.find("<DisplayName>")? + "<DisplayName>".len();
    let raw = manifest[start..].split("</DisplayName>").next()?.trim();
    let Some(res) = raw.strip_prefix("ms-resource:") else {
        return (!raw.is_empty()).then(|| raw.to_string());
    };
    let name = full.split('_').next()?;
    let uri = if res.starts_with("//") {
        format!("ms-resource:{res}")
    } else if res.contains('/') {
        format!("ms-resource://{name}/{res}")
    } else {
        format!("ms-resource://{name}/resources/{res}")
    };
    let mut buf = [0u16; 512];
    unsafe { SHLoadIndirectString(&HSTRING::from(format!("@{{{full}?{uri}}}")), &mut buf, None) }.ok()?;
    let s = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]);
    (!s.trim().is_empty()).then(|| s.trim().to_string())
}

/// exe の「ファイルの説明」（例: "Google Chrome"）
fn file_description(path: &str) -> Option<String> {
    unsafe {
        let p = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&p, None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        GetFileVersionInfoW(&p, None, size, buf.as_mut_ptr() as *mut c_void).ok()?;
        let (mut ptr, mut len) = (std::ptr::null_mut(), 0u32);
        if !VerQueryValueW(buf.as_ptr() as _, &HSTRING::from("\\VarFileInfo\\Translation"), &mut ptr, &mut len).as_bool() || len < 4 {
            return None;
        }
        let lang = *(ptr as *const u16);
        let cp = *(ptr as *const u16).add(1);
        let sub = HSTRING::from(format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription"));
        if !VerQueryValueW(buf.as_ptr() as _, &sub, &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        let s = PCWSTR(ptr as *const u16).to_string().ok()?;
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// 同じアプリの複数のセッション（ブラウザのタブなど）は 1 つにまとめる
pub fn list() -> Result<Vec<AppVolume>, String> {
    let mut groups: BTreeMap<String, Vec<Session>> = BTreeMap::new();
    for s in sessions()? {
        groups.entry(s.key.clone()).or_default().push(s);
    }
    let mut v: Vec<AppVolume> = groups
        .into_iter()
        .map(|(key, ss)| {
            let first = &ss[0];
            let (level, muted) = unsafe { (first.volume.GetMasterVolume().unwrap_or(1.0), first.volume.GetMute().map(|b| b.as_bool()).unwrap_or(false)) };
            // パッケージでは、パッケージ名に含まれる exe（例: AppleMusic.exe）をアイコンに使う
            let path = ss
                .iter()
                .filter_map(|s| s.path.as_deref())
                .find(|p| key.contains(exe_name(p).trim_end_matches(".exe")))
                .or(first.path.as_deref())
                .map(str::to_string);
            let name = ss
                .iter()
                .map(|s| s.display.clone())
                .find(|d| !d.is_empty())
                .or_else(|| path.as_deref().and_then(package_display_name))
                .or_else(|| path.as_deref().and_then(file_description))
                .unwrap_or_else(|| path.as_deref().map(exe_name).unwrap_or(key.clone()).trim_end_matches(".exe").to_string());
            AppVolume { key, name, path, level, muted }
        })
        .collect();
    v.sort_by_key(|a| (a.key != SYSTEM_SOUNDS, a.name.to_lowercase()));
    Ok(v)
}

pub fn set(key: &str, level: Option<f32>, muted: Option<bool>) -> Result<(), String> {
    for s in sessions()?.into_iter().filter(|s| s.key == key) {
        unsafe {
            if let Some(l) = level {
                s.volume.SetMasterVolume(l.clamp(0.0, 1.0), std::ptr::null()).map_err(|e| e.to_string())?;
            }
            if let Some(m) = muted {
                s.volume.SetMute(m, std::ptr::null()).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn lists_app_volumes() {
        for a in super::list().unwrap() {
            println!("{} | {} | {:.2} {}", a.key, a.name, a.level, a.muted);
        }
    }
}
