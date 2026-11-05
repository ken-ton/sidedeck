use serde::Serialize;
use std::ffi::c_void;
use std::process::Command;
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree};
use windows::Win32::UI::Shell::*;

pub const PREFIX: &str = r"shell:AppsFolder\";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartApp {
    pub name: String,
    pub target: String,
    /// MSIX（ストア）アプリかどうか。AUMID は「パッケージファミリー名!アプリ ID」の形になる
    pub packaged: bool,
}

unsafe fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    let p = unsafe { item.GetDisplayName(kind) }.ok()?;
    let s = unsafe { p.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(p.0 as *const c_void)) };
    s
}

/// スタートメニューの「すべてのアプリ」と同じ一覧
pub fn list() -> Vec<StartApp> {
    let mut apps = Vec::new();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(folder) = SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) else { return apps };
        let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else { return apps };
        loop {
            let mut buf = [None];
            let mut fetched = 0;
            if items.Next(&mut buf, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = buf[0].take() else { break };
            let (Some(name), Some(id)) = (display_name(&item, SIGDN_NORMALDISPLAY), display_name(&item, SIGDN_PARENTRELATIVEPARSING)) else { continue };
            // URL やドキュメントへのショートカットは除く
            if id.contains("://") || name.is_empty() {
                continue;
            }
            apps.push(StartApp { name, packaged: id.contains('!') && !id.contains('\\'), target: format!("{PREFIX}{id}") });
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}

pub fn launch(target: &str) -> Result<(), String> {
    Command::new("explorer.exe").arg(target).spawn().map(|_| ()).map_err(|e| format!("起動できませんでした: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn lists_start_apps() {
        for a in super::list() {
            println!("{} | {} | {}", a.name, a.packaged, a.target);
        }
    }
}
