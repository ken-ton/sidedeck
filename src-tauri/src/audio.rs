use std::ffi::c_void;

use serde::Serialize;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::core::{GUID, HRESULT, IUnknown, Interface, PCWSTR};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub(crate) fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe {
        // 既に初期化済み（S_FALSE / RPC_E_CHANGED_MODE）でも続行できる
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())
    }
}

fn device_id(d: &IMMDevice) -> Option<String> {
    unsafe {
        let p = d.GetId().ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const c_void));
        s
    }
}

fn friendly_name(d: &IMMDevice) -> String {
    unsafe {
        d.OpenPropertyStore(STGM_READ)
            .and_then(|s| s.GetValue(&PKEY_Device_FriendlyName))
            .map(|v| v.to_string())
            .unwrap_or_default()
    }
}

fn default_id(flow: EDataFlow) -> Option<String> {
    let en = enumerator().ok()?;
    unsafe { en.GetDefaultAudioEndpoint(flow, eConsole).ok().and_then(|d| device_id(&d)) }
}

pub fn default_output_id() -> Option<String> {
    default_id(eRender)
}

pub fn list_outputs() -> Result<Vec<AudioDevice>, String> {
    let en = enumerator()?;
    let def = default_output_id();
    let mut out = Vec::new();
    unsafe {
        let col = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
        let n = col.GetCount().map_err(|e| e.to_string())?;
        for i in 0..n {
            let Ok(d) = col.Item(i) else { continue };
            let Some(id) = device_id(&d) else { continue };
            out.push(AudioDevice { is_default: def.as_deref() == Some(id.as_str()), name: friendly_name(&d), id });
        }
    }
    Ok(out)
}

/// 公開 API がないため、Windows の設定アプリも使っている非公開の IPolicyConfig を使う。
/// Windows 7 以降で広く使われている方法だが、将来の更新で動かなくなる可能性はある。
pub fn set_default_output(id: &str) -> Result<(), String> {
    const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID_IPOLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
    // IPolicyConfig の vtable 上の位置（IUnknown の 3 つの後に 10 個のメソッドが続く）
    const SET_DEFAULT_ENDPOINT: usize = 13;
    const RELEASE: usize = 2;
    type SetDefaultEndpoint = unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> HRESULT;
    type Release = unsafe extern "system" fn(*mut c_void) -> u32;

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let unk: IUnknown =
            CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(|e| format!("IPolicyConfig: {e}"))?;
        let mut p: *mut c_void = std::ptr::null_mut();
        unk.query(&IID_IPOLICY_CONFIG, &mut p).ok().map_err(|e| format!("IPolicyConfig: {e}"))?;
        let vtbl = *(p as *const *const usize);
        let set: SetDefaultEndpoint = std::mem::transmute(*vtbl.add(SET_DEFAULT_ENDPOINT));
        let wide = crate::display::to_wide(id);
        let mut result = Ok(());
        for role in [eConsole, eMultimedia, eCommunications] {
            if let Err(e) = set(p, PCWSTR(wide.as_ptr()), role).ok() {
                result = Err(format!("出力デバイスを切り替えられませんでした: {e}"));
            }
        }
        let release: Release = std::mem::transmute(*vtbl.add(RELEASE));
        release(p);
        result
    }
}

/// `ids` が空なら全デバイスを順番に切り替える。
pub fn cycle_output(ids: &[String]) -> Result<String, String> {
    let all = list_outputs()?;
    let candidates: Vec<&AudioDevice> = if ids.is_empty() {
        all.iter().collect()
    } else {
        ids.iter().filter_map(|id| all.iter().find(|d| &d.id == id)).collect()
    };
    if candidates.is_empty() {
        return Err("切り替え先の出力デバイスが見つかりません（接続されていない可能性があります）".into());
    }
    let pos = candidates.iter().position(|d| d.is_default);
    let next = match pos {
        Some(i) => candidates[(i + 1) % candidates.len()],
        None => candidates[0],
    };
    set_default_output(&next.id)?;
    Ok(next.name.clone())
}

fn mic_volume() -> Result<IAudioEndpointVolume, String> {
    let en = enumerator()?;
    unsafe {
        let dev = en
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .map_err(|_| "マイクが見つかりません".to_string())?;
        dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

pub fn mic_muted() -> Option<bool> {
    let v = mic_volume().ok()?;
    unsafe { v.GetMute().ok().map(|b| b.as_bool()) }
}

pub fn toggle_mic() -> Result<bool, String> {
    let v = mic_volume()?;
    unsafe {
        let muted = v.GetMute().map_err(|e| e.to_string())?.as_bool();
        v.SetMute(!muted, std::ptr::null()).map_err(|e| e.to_string())?;
        Ok(!muted)
    }
}
