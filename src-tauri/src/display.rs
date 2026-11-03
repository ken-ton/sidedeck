use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::ColorSystem::SetDeviceGammaRamp;
use windows::core::{BOOL, PCWSTR, w};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// 再接続で変わることがある。
    pub gdi_name: String,
    pub friendly_name: String,
    /// 再接続しても変わらない識別子として使う。
    pub device_path: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub refresh: u32,
    pub primary: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh: u32,
}

pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

pub fn from_wide(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

fn query_active() -> Result<(Vec<DISPLAYCONFIG_PATH_INFO>, Vec<DISPLAYCONFIG_MODE_INFO>), String> {
    unsafe {
        let mut np = 0u32;
        let mut nm = 0u32;
        let r = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm);
        if r != ERROR_SUCCESS {
            return Err(format!("GetDisplayConfigBufferSizes 失敗 (code {})", r.0));
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        let r = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None);
        if r != ERROR_SUCCESS {
            return Err(format!("QueryDisplayConfig 失敗 (code {})", r.0));
        }
        paths.truncate(np as usize);
        modes.truncate(nm as usize);
        Ok((paths, modes))
    }
}

fn source_gdi_name(p: &DISPLAYCONFIG_PATH_INFO) -> Option<String> {
    let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
    src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
    src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
    src.header.adapterId = p.sourceInfo.adapterId;
    src.header.id = p.sourceInfo.id;
    (unsafe { DisplayConfigGetDeviceInfo(&mut src.header) } == 0).then(|| from_wide(&src.viewGdiDeviceName))
}

/// (GDI 名, 表示名, デバイスパス)
fn active_targets() -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok((paths, _)) = query_active() else { return out };
    unsafe {
        for p in &paths {
            let Some(gdi) = source_gdi_name(p) else { continue };

            let mut tgt = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            tgt.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            tgt.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            tgt.header.adapterId = p.targetInfo.adapterId;
            tgt.header.id = p.targetInfo.id;
            let ok = DisplayConfigGetDeviceInfo(&mut tgt.header) == 0;

            out.push((
                gdi,
                if ok { from_wide(&tgt.monitorFriendlyDeviceName) } else { String::new() },
                if ok { from_wide(&tgt.monitorDevicePath) } else { String::new() },
            ));
        }
    }
    out
}

fn current_mode(gdi: &str) -> Option<DEVMODEW> {
    let name = to_wide(gdi);
    let mut dm = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    unsafe { EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_CURRENT_SETTINGS, &mut dm).as_bool() }
        .then_some(dm)
}

pub fn list_monitors() -> Vec<MonitorInfo> {
    let mut seen = HashSet::new();
    active_targets()
        .into_iter()
        .filter_map(|(gdi, friendly, path)| {
            let dm = current_mode(&gdi)?;
            let pos = unsafe { dm.Anonymous1.Anonymous2.dmPosition };
            let key = if path.is_empty() { gdi.clone() } else { path.clone() };
            if !seen.insert(key) {
                return None;
            }
            // モバイルモニターは EDID に名前がないことが多いので、
            // デバイスパスの製造者+製品コード（例: RTK1920）で代用する
            let friendly = if friendly.is_empty() {
                path.split('#').nth(1).unwrap_or_default().to_string()
            } else {
                friendly
            };
            Some(MonitorInfo {
                friendly_name: friendly,
                device_path: path,
                x: pos.x,
                y: pos.y,
                width: dm.dmPelsWidth,
                height: dm.dmPelsHeight,
                refresh: dm.dmDisplayFrequency,
                primary: pos.x == 0 && pos.y == 0,
                gdi_name: gdi,
            })
        })
        .collect()
}

/// 旧 API の `ChangeDisplaySettingsEx` は環境によって DISP_CHANGE_FAILED になるため、
/// 設定アプリと同じ CCD API（SetDisplayConfig）でソースモードの位置を書き換える。
/// CCD ではデスクトップ座標 (0,0) にあるソースがプライマリになる。
fn apply_layout(entries: &[(String, i32, i32, bool)]) -> Result<(), String> {
    if !entries.iter().any(|(_, x, y, p)| *p && *x == 0 && *y == 0) {
        return Err("プライマリにするモニターが (0,0) にありません".into());
    }
    let (paths, mut modes) = query_active()?;
    let mut touched = HashSet::new();
    for p in &paths {
        let Some(gdi) = source_gdi_name(p) else { continue };
        let Some((_, x, y, _)) = entries.iter().find(|e| e.0 == gdi) else { continue };
        let idx = unsafe { p.sourceInfo.Anonymous.modeInfoIdx } as usize;
        let Some(mode) = modes.get_mut(idx) else { continue };
        if mode.infoType != DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE || !touched.insert(idx) {
            continue;
        }
        mode.Anonymous.sourceMode.position = POINTL { x: *x, y: *y };
    }
    let r = unsafe {
        SetDisplayConfig(
            Some(&paths),
            Some(&modes),
            SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES | SDC_SAVE_TO_DATABASE,
        )
    };
    if r != 0 {
        return Err(format!("画面配置の適用に失敗しました (SetDisplayConfig code {r})"));
    }
    Ok(())
}

/// GDI 名は変わり得るので、デバイスパスで対応付ける。
pub fn restore_layout(saved: &[MonitorInfo]) -> Result<(), String> {
    let current = list_monitors();
    let entries: Vec<_> = saved
        .iter()
        .filter_map(|s| {
            let cur = current.iter().find(|c| {
                if s.device_path.is_empty() { c.gdi_name == s.gdi_name } else { c.device_path == s.device_path }
            })?;
            Some((cur.gdi_name.clone(), s.x, s.y, s.primary))
        })
        .collect();
    if !entries.iter().any(|e| e.3) {
        return Err("元のプライマリモニターが見つからないため配置を戻せません".into());
    }
    apply_layout(&entries)
}

pub fn list_modes(gdi: &str) -> Vec<DisplayMode> {
    let name = to_wide(gdi);
    let mut set = HashSet::new();
    let mut i = 0u32;
    loop {
        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        if !unsafe { EnumDisplaySettingsW(PCWSTR(name.as_ptr()), ENUM_DISPLAY_SETTINGS_MODE(i), &mut dm) }.as_bool() {
            break;
        }
        if dm.dmBitsPerPel == 32 && dm.dmPelsWidth >= 800 {
            set.insert(DisplayMode { width: dm.dmPelsWidth, height: dm.dmPelsHeight, refresh: dm.dmDisplayFrequency });
        }
        i += 1;
    }
    let mut v: Vec<_> = set.into_iter().collect();
    v.sort_by(|a, b| (b.width * b.height, b.refresh).cmp(&(a.width * a.height, a.refresh)));
    v
}

pub fn set_mode(gdi: &str, mode: DisplayMode) -> Result<(), String> {
    let mut dm = current_mode(gdi).ok_or("現在の設定を取得できません")?;
    dm.dmPelsWidth = mode.width;
    dm.dmPelsHeight = mode.height;
    dm.dmDisplayFrequency = mode.refresh;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;
    let name = to_wide(gdi);
    let r = unsafe { ChangeDisplaySettingsExW(PCWSTR(name.as_ptr()), Some(&dm), None, CDS_TYPE(0), None) };
    if r != DISP_CHANGE_SUCCESSFUL {
        return Err(format!("解像度の変更に失敗しました (code {})", r.0));
    }
    Ok(())
}

pub fn hmonitor_for(gdi: &str) -> Option<HMONITOR> {
    unsafe extern "system" fn cb(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        unsafe { (*(data.0 as *mut Vec<HMONITOR>)).push(h) };
        BOOL(1)
    }
    let mut list: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut list as *mut _ as isize));
        list.into_iter().find(|&h| {
            let mut mi = MONITORINFOEXW::default();
            mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            GetMonitorInfoW(h, &mut mi as *mut _ as *mut MONITORINFO).as_bool() && from_wide(&mi.szDevice) == gdi
        })
    }
}

fn with_physical<T>(gdi: &str, f: impl FnOnce(HANDLE) -> Option<T>) -> Option<T> {
    let hmon = hmonitor_for(gdi)?;
    unsafe {
        let mut n = 0u32;
        GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut n).ok()?;
        if n == 0 {
            return None;
        }
        let mut arr = vec![PHYSICAL_MONITOR::default(); n as usize];
        GetPhysicalMonitorsFromHMONITOR(hmon, &mut arr).ok()?;
        let r = f(arr[0].hPhysicalMonitor);
        let _ = DestroyPhysicalMonitors(&arr);
        r
    }
}

pub fn ddc_get_brightness(gdi: &str) -> Option<u32> {
    with_physical(gdi, |h| {
        let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
        if unsafe { GetMonitorBrightness(h, &mut min, &mut cur, &mut max) } == 0 || max <= min {
            return None;
        }
        Some((cur - min) * 100 / (max - min))
    })
}

pub fn ddc_set_brightness(gdi: &str, percent: u32) -> bool {
    with_physical(gdi, |h| {
        let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
        if unsafe { GetMonitorBrightness(h, &mut min, &mut cur, &mut max) } == 0 {
            return None;
        }
        let v = min + (max - min) * percent.min(100) / 100;
        (unsafe { SetMonitorBrightness(h, v) } != 0).then_some(())
    })
    .is_some()
}

/// Windows は極端なランプを拒否するので、下限は 50% 程度になる。
pub fn gamma_set(gdi: &str, level: f32) -> bool {
    let level = level.clamp(0.5, 1.0);
    let mut ramp = [0u16; 768];
    for i in 0..256 {
        let v = ((i as f32) * 257.0 * level).min(65535.0) as u16;
        ramp[i] = v;
        ramp[256 + i] = v;
        ramp[512 + i] = v;
    }
    let name = to_wide(gdi);
    unsafe {
        let dc = CreateDCW(w!("DISPLAY"), PCWSTR(name.as_ptr()), PCWSTR::null(), None);
        if dc.is_invalid() {
            return false;
        }
        let ok = SetDeviceGammaRamp(dc, ramp.as_ptr() as *const _).as_bool();
        let _ = DeleteDC(dc);
        ok
    }
}
