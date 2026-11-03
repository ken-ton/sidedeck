use std::path::{Path, PathBuf};

use serde::Serialize;
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub title: String,
    pub source: String,
    pub launch: String,
    pub art: Option<String>,
}

pub fn steam_root() -> Option<PathBuf> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam").ok()?;
    let p: String = key.get_value("SteamPath").ok()?;
    Some(PathBuf::from(p.replace('/', "\\")))
}

/// `"key"  "value"` の行だけを拾う。ネストは区別しない。
fn vdf_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('"').collect();
            // ["\t", key, "\t\t", value, ""]
            (parts.len() >= 5).then(|| (parts[1].to_string(), parts[3].replace(r"\\", r"\")))
        })
        .collect()
}

pub fn find_art(root: &Path, appid: &str) -> Option<String> {
    let cache = root.join("appcache").join("librarycache");
    let dir = cache.join(appid);
    let mut dirs = vec![dir.clone()];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        dirs.extend(rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
    }
    for name in ["library_600x900.jpg", "library_600x900_2x.jpg", "library_capsule.jpg"] {
        for d in &dirs {
            let p = d.join(name);
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    let old = cache.join(format!("{appid}_library_600x900.jpg"));
    if old.is_file() {
        return Some(old.to_string_lossy().into_owned());
    }
    dirs.iter()
        .map(|d| d.join("header.jpg"))
        .chain(Some(cache.join(format!("{appid}_header.jpg"))))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn is_steam_tool(appid: &str, name: &str) -> bool {
    const SKIP: [&str; 5] = ["Redistributable", "Steamworks", "Proton", "Steam Linux Runtime", "SteamVR"];
    appid == "228980" || SKIP.iter().any(|s| name.contains(s))
}

fn steam_games() -> Vec<Game> {
    let Some(root) = steam_root() else { return vec![] };
    let mut libs = vec![root.clone()];
    if let Ok(t) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        libs.extend(vdf_pairs(&t).into_iter().filter(|(k, _)| k == "path").map(|(_, v)| PathBuf::from(v)));
    }
    libs.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    libs.dedup_by_key(|p| p.to_string_lossy().to_lowercase());

    let mut out = Vec::new();
    for lib in libs {
        let Ok(rd) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().into_owned();
            if !(fname.starts_with("appmanifest_") && fname.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            let pairs = vdf_pairs(&text);
            let get = |k: &str| pairs.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
            let (Some(appid), Some(name)) = (get("appid"), get("name")) else { continue };
            if is_steam_tool(&appid, &name) {
                continue;
            }
            out.push(Game {
                id: format!("steam:{appid}"),
                art: find_art(&root, &appid),
                launch: format!("steam://rungameid/{appid}"),
                title: name,
                source: "steam".into(),
            });
        }
    }
    out
}

fn epic_games() -> Vec<Game> {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    let dir = PathBuf::from(base).join(r"Epic\EpicGamesLauncher\Data\Manifests");
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    rd.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "item"))
        .filter_map(|e| {
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()?;
            if v["bIsIncompleteInstall"].as_bool() == Some(true) {
                return None;
            }
            if let Some(cats) = v["AppCategories"].as_array() {
                if !cats.iter().any(|c| c == "games") {
                    return None;
                }
            }
            let app = v["AppName"].as_str()?;
            let ns = v["CatalogNamespace"].as_str()?;
            let item = v["CatalogItemId"].as_str()?;
            Some(Game {
                id: format!("epic:{app}"),
                title: v["DisplayName"].as_str().unwrap_or(app).to_string(),
                source: "epic".into(),
                launch: format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true"),
                art: None,
            })
        })
        .collect()
}

pub fn list_games() -> Vec<Game> {
    let mut v = steam_games();
    v.extend(epic_games());
    v.sort_by_key(|g| g.title.to_lowercase());
    v
}
