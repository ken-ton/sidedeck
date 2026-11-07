//! MIDI の送受信。受信するポートは、SideDeck 本体（ボタンを光らせる）とプラグインのそれぞれが指定し、その和を開いておく

use std::collections::{BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex, OnceLock};

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const CLIENT: &str = "SideDeck";
/// 1 回で送れるバイト数の上限（SysEx を含む）
const MAX_MESSAGE: usize = 256;

static APP: OnceLock<AppHandle> = OnceLock::new();
static OUTPUTS: LazyLock<Mutex<HashMap<String, MidiOutputConnection>>> = LazyLock::new(Default::default);
static INPUTS: LazyLock<Mutex<HashMap<String, MidiInputConnection<()>>>> = LazyLock::new(Default::default);
/// 受信したい人（"app" や "plugin:<id>"）ごとの、受信するポートの名前
static WANTED: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(Default::default);

#[derive(Serialize)]
pub struct Ports {
    inputs: Vec<String>,
    outputs: Vec<String>,
}

pub fn ports() -> Result<Ports, String> {
    let input = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
    let output = MidiOutput::new(CLIENT).map_err(|e| e.to_string())?;
    Ok(Ports {
        inputs: input.ports().iter().filter_map(|p| input.port_name(p).ok()).collect(),
        outputs: output.ports().iter().filter_map(|p| output.port_name(p).ok()).collect(),
    })
}

fn connect_output(port: &str) -> Result<MidiOutputConnection, String> {
    let output = MidiOutput::new(CLIENT).map_err(|e| e.to_string())?;
    let p = output
        .ports()
        .into_iter()
        .find(|p| output.port_name(p).is_ok_and(|n| n == port))
        .ok_or_else(|| format!("MIDI のポート「{port}」が見つかりません"))?;
    output.connect(&p, CLIENT).map_err(|e| format!("MIDI のポート「{port}」を開けません（{e}）"))
}

pub fn send(port: &str, data: &[u8]) -> Result<(), String> {
    if data.is_empty() || data.len() > MAX_MESSAGE || data[0] & 0x80 == 0 {
        return Err("MIDI のメッセージが正しくありません".into());
    }
    let mut outputs = OUTPUTS.lock().unwrap();
    if let Some(conn) = outputs.get_mut(port) {
        if conn.send(data).is_ok() {
            return Ok(());
        }
        // 機器を抜き差しすると古い接続は使えなくなるので、開き直す
        outputs.remove(port);
    }
    let mut conn = connect_output(port)?;
    conn.send(data).map_err(|e| format!("MIDI を送れませんでした（{e}）"))?;
    outputs.insert(port.to_string(), conn);
    Ok(())
}

#[derive(Serialize, Clone)]
struct Incoming<'a> {
    port: &'a str,
    data: &'a [u8],
}

fn on_message(port: &str, data: &[u8]) {
    let Some(app) = APP.get() else { return };
    let _ = app.emit("midi-in", Incoming { port, data });
    let plugins: Vec<String> = WANTED
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, ports)| ports.iter().any(|p| p == port))
        .filter_map(|(owner, _)| owner.strip_prefix("plugin:").map(str::to_string))
        .collect();
    for id in plugins {
        crate::plugins::midi_in(app, &id, port, data);
    }
}

fn connect_input(port: &str) -> Result<MidiInputConnection<()>, String> {
    let mut input = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
    input.ignore(midir::Ignore::TimeAndActiveSense);
    let p = input
        .ports()
        .into_iter()
        .find(|p| input.port_name(p).is_ok_and(|n| n == port))
        .ok_or_else(|| format!("MIDI のポート「{port}」が見つかりません"))?;
    let name = port.to_string();
    input
        .connect(&p, CLIENT, move |_, data, _| on_message(&name, data), ())
        .map_err(|e| format!("MIDI のポート「{port}」を開けません（{e}）"))
}

/// owner が受信するポートを置き換え、全員の分の和になるようにポートを開け閉めする
pub fn set_listening(app: &AppHandle, owner: &str, ports: Vec<String>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    let wanted: BTreeSet<String> = {
        let mut w = WANTED.lock().unwrap();
        if ports.is_empty() {
            w.remove(owner);
        } else {
            w.insert(owner.to_string(), ports);
        }
        w.values().flatten().cloned().collect()
    };
    let mut inputs = INPUTS.lock().unwrap();
    inputs.retain(|port, _| wanted.contains(port));
    let mut errors = Vec::new();
    for port in wanted {
        if inputs.contains_key(&port) {
            continue;
        }
        match connect_input(&port) {
            Ok(conn) => {
                inputs.insert(port, conn);
            }
            Err(e) => errors.push(e),
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("\n")) }
}
