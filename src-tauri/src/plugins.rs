//! 外部プロセスとして動くプラグインのホスト。プロトコルは docs/plugins.md を参照。

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::*;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 構造はフロントエンドが解釈する（docs/plugins.md）
    #[serde(default)]
    pub actions: Vec<Value>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Starting,
    Running,
    Stopped,
    Error,
}

struct Entry {
    manifest: Manifest,
    dir: PathBuf,
    /// プラグインごとに別のトークンにして、ほかのプラグインになりすまして登録できないようにする
    token: String,
    status: Status,
    error: Option<String>,
    tx: Option<mpsc::UnboundedSender<String>>,
    child: Option<Arc<Mutex<Child>>>,
    restarts: Vec<Instant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub status: Status,
    pub error: Option<String>,
    pub actions: Vec<Value>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginButton {
    pub plugin_id: String,
    pub context: String,
    pub action: String,
    #[serde(default)]
    pub settings: Value,
}

pub struct Host {
    dir: PathBuf,
    /// 待ち受けを開始できなかったときは None（プラグインは起動しない）
    port: Option<u16>,
    /// HANDLE は Send でないので値で持つ。プロセスが終わると閉じられ、子プロセスも終了する。
    job: isize,
    entries: Mutex<HashMap<String, Entry>>,
    buttons: Mutex<Vec<PluginButton>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let a = std::collections::hash_map::RandomState::new();
    let mut h = a.build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let b = std::collections::hash_map::RandomState::new().hash_one(std::process::id());
    format!("{:016x}{:016x}", h.finish(), b)
}

fn create_job() -> isize {
    unsafe {
        let Ok(job) = CreateJobObjectW(None, windows::core::PCWSTR::null()) else { return 0 };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job.0 as isize
    }
}

fn broken_manifest(id: String) -> Manifest {
    Manifest { name: id.clone(), id, version: String::new(), command: String::new(), args: vec![], actions: vec![] }
}

/// plugins フォルダを読む。読めない manifest や id の重複は、エラーの Entry として一覧に出す。
fn load_entries(dir: &Path, startup_error: Option<&str>) -> HashMap<String, Entry> {
    let mut entries: HashMap<String, Entry> = HashMap::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return entries };
    let mut folders: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join("manifest.json").is_file()).collect();
    folders.sort();
    for path in folders {
        let folder = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let (mut manifest, mut error) = match std::fs::read_to_string(path.join("manifest.json"))
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Manifest>(&t).map_err(|e| e.to_string()))
        {
            Ok(m) => (m, None),
            Err(e) => (broken_manifest(folder.clone()), Some(format!("manifest.json を読み込めません: {e}"))),
        };
        let mut key = manifest.id.clone();
        if let Some(other) = entries.get(&key) {
            let other_folder = other.dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
            error = Some(format!("id「{}」がフォルダ「{other_folder}」のプラグインと重複しています", manifest.id));
            key = format!("{}@{folder}", manifest.id);
            manifest = Manifest { id: key.clone(), ..manifest };
        }
        if error.is_none() {
            error = startup_error.map(String::from);
        }
        let status = if error.is_some() { Status::Error } else { Status::Stopped };
        let entry = Entry { manifest, dir: path, token: random_token(), status, error, tx: None, child: None, restarts: vec![] };
        entries.insert(key, entry);
    }
    entries
}

fn startable(entries: &HashMap<String, Entry>) -> Vec<String> {
    entries.iter().filter(|(_, e)| e.error.is_none()).map(|(id, _)| id.clone()).collect()
}

impl Host {
    fn info(&self) -> Vec<PluginInfo> {
        let entries = self.entries.lock().unwrap();
        let mut v: Vec<PluginInfo> = entries
            .values()
            .map(|e| PluginInfo {
                id: e.manifest.id.clone(),
                name: e.manifest.name.clone(),
                version: e.manifest.version.clone(),
                status: e.status,
                error: e.error.clone(),
                actions: e.manifest.actions.clone(),
            })
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v
    }

    fn send(&self, plugin_id: &str, msg: Value) -> Result<(), String> {
        let entries = self.entries.lock().unwrap();
        let e = entries.get(plugin_id).ok_or_else(|| format!("プラグイン {plugin_id} が見つかりません"))?;
        let tx = e.tx.as_ref().ok_or_else(|| format!("プラグイン「{}」が動いていません", e.manifest.name))?;
        tx.send(msg.to_string()).map_err(|_| format!("プラグイン「{}」に送れませんでした", e.manifest.name))
    }

    fn buttons_message(&self, plugin_id: &str) -> Value {
        let buttons: Vec<PluginButton> = self.buttons.lock().unwrap().iter().filter(|b| b.plugin_id == plugin_id).cloned().collect();
        json!({ "event": "buttons", "buttons": buttons })
    }
}

fn notify_changed(app: &AppHandle) {
    let _ = app.emit("plugins-changed", ());
}

fn append_log(dir: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join("plugin.log")) {
        let _ = writeln!(f, "{line}");
    }
}

fn spawn_process(app: &AppHandle, id: &str) {
    let host = app.state::<Host>();
    let Some(port) = host.port else { return };
    let (manifest, dir, token) = {
        let mut entries = host.entries.lock().unwrap();
        let Some(e) = entries.get_mut(id) else { return };
        // 再起動を待つ間に reload などで起動済みになっていたら、二重に起動しない
        if e.child.is_some() || e.manifest.command.is_empty() {
            return;
        }
        e.status = Status::Starting;
        e.error = None;
        (e.manifest.clone(), e.dir.clone(), e.token.clone())
    };
    let local = dir.join(&manifest.command);
    let program = if local.is_file() { local } else { PathBuf::from(&manifest.command) };
    let log = OpenOptions::new().create(true).append(true).open(dir.join("plugin.log"));
    let mut cmd = Command::new(program);
    cmd.args(&manifest.args)
        .current_dir(&dir)
        .env("SIDEDECK_PORT", port.to_string())
        .env("SIDEDECK_TOKEN", &token)
        .env("SIDEDECK_PLUGIN_ID", id)        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    match log.and_then(|f| Ok((f.try_clone()?, f))) {
        Ok((out, err)) => {
            cmd.stdout(out).stderr(err);
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let mut entries = host.entries.lock().unwrap();
            if let Some(e) = entries.get_mut(id) {
                e.status = Status::Error;
                e.error = Some(format!("起動できませんでした（{}）: {err}", manifest.command));
            }
            notify_changed(app);
            return;
        }
    };
    if host.job != 0 {
        unsafe {
            let _ = AssignProcessToJobObject(HANDLE(host.job as _), HANDLE(child.as_raw_handle() as _));
        }
    }
    let child = Arc::new(Mutex::new(child));
    host.entries.lock().unwrap().get_mut(id).map(|e| e.child = Some(child.clone()));
    notify_changed(app);

    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let code = loop {
            std::thread::sleep(Duration::from_millis(500));
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
        };
        let host = app.state::<Host>();
        let restart = {
            let mut entries = host.entries.lock().unwrap();
            let Some(e) = entries.get_mut(&id) else { return };
            // restart_plugin が差し替えた後の古いプロセスなら何もしない
            if !e.child.as_ref().is_some_and(|c| Arc::ptr_eq(c, &child)) {
                return;
            }
            e.child = None;
            e.tx = None;
            let now = Instant::now();
            e.restarts.retain(|t| now - *t < RESTART_WINDOW);
            append_log(&e.dir, &format!("[SideDeck] プロセスが終了しました (code {code:?})"));
            if e.restarts.len() >= MAX_RESTARTS {
                e.status = Status::Error;
                e.error = Some(format!("繰り返し終了したため停止しました（code {code:?}）。plugin.log を確認してください"));
                false
            } else {
                e.restarts.push(now);
                e.status = Status::Stopped;
                true
            }
        };
        notify_changed(&app);
        if restart {
            std::thread::sleep(Duration::from_secs(2));
            spawn_process(&app, &id);
        }
    });
}

async fn handle_connection(app: AppHandle, stream: TcpStream) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut sink, mut source) = ws.split();

    let first = tokio::time::timeout(Duration::from_secs(10), source.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = first else { return };
    let Ok(reg) = serde_json::from_str::<Value>(&text) else { return };
    let host = app.state::<Host>();
    let plugin_id = reg["pluginId"].as_str().unwrap_or_default().to_string();

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let registered = {
        let mut entries = host.entries.lock().unwrap();
        match entries.get_mut(&plugin_id) {
            Some(e) if reg["event"] == "register" && reg["token"] == e.token.as_str() => {
                e.tx = Some(tx.clone());
                e.status = Status::Running;
                e.error = None;
                true
            }
            _ => false,
        }
    };
    if !registered {
        let _ = sink.close().await;
        return;
    }
    notify_changed(&app);
    let _ = tx.send(host.buttons_message(&plugin_id).to_string());

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(Message::Text(m.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = source.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        match v["event"].as_str() {
            Some("setState") => {
                let _ = app.emit("plugin-state", &v);
            }
            Some("showAlert") => {
                let _ = app.emit("plugin-alert", &v);
            }
            Some("options") | Some("response") => {
                if let Some(rid) = v["requestId"].as_str() {
                    if let Some(waiter) = host.pending.lock().unwrap().remove(rid) {
                        let _ = waiter.send(v.clone());
                    }
                }
            }
            Some("log") => {
                let dir = host.entries.lock().unwrap().get(&plugin_id).map(|e| e.dir.clone());
                if let Some(dir) = dir {
                    append_log(&dir, v["message"].as_str().unwrap_or_default());
                }
            }
            _ => {}
        }
    }

    writer.abort();
    {
        let mut entries = host.entries.lock().unwrap();
        if let Some(e) = entries.get_mut(&plugin_id) {
            if e.tx.as_ref().is_some_and(|t| t.same_channel(&tx)) {
                e.tx = None;
                if e.status == Status::Running {
                    e.status = Status::Stopped;
                }
            }
        }
    }
    notify_changed(&app);
}

/// 待ち受けを開始できなくても Host は登録する（コマンドが state を取れずに panic しないように）。
/// そのときはプラグインを起動せず、一覧にエラーとして出す。
pub fn init(app: &AppHandle, dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let listener = tauri::async_runtime::block_on(TcpListener::bind("127.0.0.1:0"))
        .and_then(|l| l.local_addr().map(|a| (l, a.port())))
        .map_err(|e| format!("プラグインの待ち受けを開始できません: {e}"));
    let startup_error = listener.as_ref().err().cloned();
    let entries = load_entries(&dir, startup_error.as_deref());
    let ids = startable(&entries);
    app.manage(Host {
        dir,
        port: listener.as_ref().ok().map(|(_, p)| *p),
        job: create_job(),
        entries: Mutex::new(entries),
        buttons: Mutex::new(vec![]),
        pending: Mutex::new(HashMap::new()),
    });
    let Ok((listener, _)) = listener else { return };

    let accept_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tauri::async_runtime::spawn(handle_connection(accept_app.clone(), stream));
                }
                // 一時的なエラーで待ち受け全体を止めない
                Err(e) => {
                    eprintln!("プラグインの接続を受け付けられません: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    });
    for id in ids {
        spawn_process(app, &id);
    }
}

pub fn list(app: &AppHandle) -> Vec<PluginInfo> {
    app.state::<Host>().info()
}

pub fn key_down(app: &AppHandle, plugin_id: &str, action: &str, context: &str, settings: Value) -> Result<(), String> {
    app.state::<Host>().send(plugin_id, json!({ "event": "keyDown", "context": context, "action": action, "settings": settings }))
}

pub async fn request(app: &AppHandle, plugin_id: &str, mut msg: Value) -> Result<Value, String> {
    let host = app.state::<Host>();
    let rid = random_token();
    msg["requestId"] = Value::String(rid.clone());
    let (tx, rx) = oneshot::channel();
    host.pending.lock().unwrap().insert(rid.clone(), tx);
    if let Err(e) = host.send(plugin_id, msg) {
        host.pending.lock().unwrap().remove(&rid);
        return Err(e);
    }
    match tokio::time::timeout(Duration::from_secs(8), rx).await {
        Ok(Ok(v)) => {
            if let Some(err) = v["error"].as_str() {
                return Err(err.to_string());
            }
            Ok(v)
        }
        _ => {
            host.pending.lock().unwrap().remove(&rid);
            Err("プラグインから返事がありませんでした".into())
        }
    }
}

pub fn set_buttons(app: &AppHandle, buttons: Vec<PluginButton>) {
    let host = app.state::<Host>();
    let ids: Vec<String> = {
        let mut current = host.buttons.lock().unwrap();
        let mut ids: Vec<String> = current.iter().chain(buttons.iter()).map(|b| b.plugin_id.clone()).collect();
        ids.sort();
        ids.dedup();
        *current = buttons;
        ids
    };
    for id in ids {
        let _ = host.send(&id, host.buttons_message(&id));
    }
}

/// manifest を読み直して全プラグインを起動し直す（追加・削除・更新を反映する）。
pub fn reload(app: &AppHandle) {
    let host = app.state::<Host>();
    let startup_error = host.port.is_none().then_some("プラグインの待ち受けを開始できていません。SideDeck を起動し直してください");
    let (old, ids) = {
        let mut entries = host.entries.lock().unwrap();
        let children: Vec<Arc<Mutex<Child>>> = entries.values_mut().filter_map(|e| e.child.take()).collect();
        *entries = load_entries(&host.dir, startup_error);
        (children, startable(&entries))
    };
    for c in old {
        let _ = c.lock().unwrap().kill();
    }
    notify_changed(app);
    for id in ids {
        spawn_process(app, &id);
    }
}

pub fn dir(app: &AppHandle) -> PathBuf {
    app.state::<Host>().dir.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, folder: &str, manifest: &str) {
        let d = dir.join(folder);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("manifest.json"), manifest).unwrap();
    }

    #[test]
    fn loads_entries_and_reports_problems() {
        let dir = std::env::temp_dir().join(format!("sidedeck-plugins-test-{}", random_token()));
        let m = |id: &str| format!(r#"{{"id":"{id}","name":"{id}","command":"node"}}"#);
        write(&dir, "a", &m("x"));
        write(&dir, "b", &m("x"));
        write(&dir, "c", "{ broken");
        write(&dir, "d", &m("y"));
        std::fs::create_dir_all(dir.join("no-manifest")).unwrap();

        let entries = load_entries(&dir, None);
        assert_eq!(entries.len(), 4);
        assert!(entries["x"].error.is_none());
        assert!(entries["x@b"].error.as_deref().unwrap().contains("重複"));
        assert!(entries["c"].error.as_deref().unwrap().contains("manifest.json"));
        assert_ne!(entries["x"].token, entries["y"].token);
        let mut ids = startable(&entries);
        ids.sort();
        assert_eq!(ids, vec!["x", "y"]);

        let failed = load_entries(&dir, Some("待ち受け失敗"));
        assert!(startable(&failed).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
