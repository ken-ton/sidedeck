//! AI アシスタント: Claude との会話と、VOICEVOX での音声合成

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::*;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
/// 拒否されたときに、拒否の種類に合ったモデルでサーバー側がやり直す
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const CRED_TARGET: &str = "SideDeck/anthropic-api-key";

// ---- API キー（Windows の資格情報マネージャーに保存し、画面側には渡さない） ----

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn read_key() -> Option<String> {
    let target = wide(CRED_TARGET);
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    unsafe {
        CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred).ok()?;
        let c = &*cred;
        let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
        let key = String::from_utf8(bytes.to_vec()).ok();
        CredFree(cred as *const _);
        key
    }
}

pub fn has_key() -> bool {
    read_key().is_some_and(|k| !k.is_empty())
}

pub fn set_key(key: &str) -> Result<(), String> {
    let mut target = wide(CRED_TARGET);
    let key = key.trim();
    if key.is_empty() {
        unsafe {
            let _ = CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None);
        }
        return Ok(());
    }
    let mut blob = key.as_bytes().to_vec();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("API キーを保存できませんでした: {e}"))
}

// ---- 会話 ----

static CURRENT_CHAT: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ChatEvent {
    Text { id: u64, text: String },
    /// content はそのまま履歴に足せる形（思考ブロックを含む）
    #[serde(rename_all = "camelCase")]
    Done { id: u64, content: Value, stop_reason: String },
    Error { id: u64, message: String },
}

fn emit(app: &AppHandle, ev: ChatEvent) {
    let _ = app.emit("assistant-chat", ev);
}

pub fn cancel_chat() {
    CURRENT_CHAT.store(0, Ordering::SeqCst);
}

/// ウェブ検索の検索結果を地域に合わせる
#[derive(serde::Deserialize, Clone)]
pub struct Location {
    city: String,
    country: String,
    timezone: String,
}

/// messages は Messages API の形のまま画面側が持つ。location が None ならウェブ検索を使わない
pub fn start_chat(app: AppHandle, id: u64, model: String, system: String, messages: Value, web_search: Option<Location>) -> Result<(), String> {
    let key = read_key().filter(|k| !k.is_empty()).ok_or("設定で Claude の API キーを入力してください")?;
    CURRENT_CHAT.store(id, Ordering::SeqCst);
    std::thread::spawn(move || {
        let ev = match run_chat(&app, id, &key, &model, &system, messages, web_search) {
            Ok(Some((content, stop_reason))) => ChatEvent::Done { id, content, stop_reason },
            Ok(None) => return,
            Err(message) => ChatEvent::Error { id, message },
        };
        if CURRENT_CHAT.load(Ordering::SeqCst) == id {
            emit(&app, ev);
        }
    });
    Ok(())
}

fn api_error(code: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_default();
    match code {
        401 => "API キーが正しくありません".into(),
        403 => format!("この API キーでは使えません（{detail}）"),
        404 => format!("モデルが見つかりません（{detail}）"),
        429 => "利用の上限に達しました。少し待ってからもう一度話しかけてください".into(),
        500..=599 => "Claude が混み合っています。少し待ってからもう一度話しかけてください".into(),
        _ => format!("Claude からエラーが返りました（{code}: {detail}）"),
    }
}

/// キャンセルされたら Ok(None)
fn web_search_tool(model: &str, loc: &Location) -> Value {
    // 検索結果を絞り込む新しい版は Haiku に対応していない
    let kind = if model.starts_with("claude-haiku") { "web_search_20250305" } else { "web_search_20260209" };
    let mut user_location = json!({ "type": "approximate", "timezone": loc.timezone });
    if !loc.city.is_empty() {
        user_location["city"] = json!(loc.city);
    }
    if !loc.country.is_empty() {
        user_location["country"] = json!(loc.country);
    }
    json!({ "type": kind, "name": "web_search", "max_uses": 3, "user_location": user_location })
}

fn run_chat(
    app: &AppHandle,
    id: u64,
    key: &str,
    model: &str,
    system: &str,
    messages: Value,
    web_search: Option<Location>,
) -> Result<Option<(Value, String)>, String> {
    // Haiku にはサーバー側のフォールバックがなく、指定すると拒否がそのまま返るか 400 になる
    let fallbacks = !model.starts_with("claude-haiku");
    let mut body = json!({
        "model": model,
        "max_tokens": 16000,
        "stream": true,
        "cache_control": { "type": "ephemeral" },
        "output_config": { "effort": "low" },
        "system": system,
        "messages": messages,
    });
    if fallbacks {
        body["fallbacks"] = json!("default");
    }
    if let Some(loc) = &web_search {
        body["tools"] = json!([web_search_tool(model, loc)]);
    }
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(120)).build();
    let mut req = agent
        .post(API_URL)
        .set("content-type", "application/json")
        .set("x-api-key", key)
        .set("anthropic-version", API_VERSION);
    if fallbacks {
        req = req.set("anthropic-beta", FALLBACK_BETA);
    }
    let res = match req.send_string(&body.to_string()) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => return Err(api_error(code, &r.into_string().unwrap_or_default())),
        Err(e) => return Err(format!("Claude につながりません: {e}")),
    };

    let mut blocks: Vec<Value> = Vec::new();
    let mut partial_json: Vec<String> = Vec::new();
    let mut stop_reason = String::new();
    for line in BufReader::new(res.into_reader()).lines() {
        if CURRENT_CHAT.load(Ordering::SeqCst) != id {
            return Ok(None);
        }
        let line = line.map_err(|e| format!("返事の受信が途切れました: {e}"))?;
        let Some(data) = line.strip_prefix("data:") else { continue };
        let Ok(ev) = serde_json::from_str::<Value>(data.trim()) else { continue };
        match ev["type"].as_str().unwrap_or_default() {
            "content_block_start" => {
                let i = ev["index"].as_u64().unwrap_or(0) as usize;
                if blocks.len() <= i {
                    blocks.resize(i + 1, Value::Null);
                    partial_json.resize(i + 1, String::new());
                }
                blocks[i] = ev["content_block"].clone();
            }
            "content_block_delta" => {
                let i = ev["index"].as_u64().unwrap_or(0) as usize;
                let Some(b) = blocks.get_mut(i) else { continue };
                let d = &ev["delta"];
                let append = |b: &mut Value, field: &str, s: &str| {
                    let cur = b[field].as_str().unwrap_or_default().to_string();
                    b[field] = Value::String(cur + s);
                };
                match d["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        let text = d["text"].as_str().unwrap_or_default();
                        append(b, "text", text);
                        emit(app, ChatEvent::Text { id, text: text.to_string() });
                    }
                    "thinking_delta" => append(b, "thinking", d["thinking"].as_str().unwrap_or_default()),
                    "signature_delta" => b["signature"] = d["signature"].clone(),
                    "input_json_delta" => partial_json[i].push_str(d["partial_json"].as_str().unwrap_or_default()),
                    "citations_delta" => {
                        if !b["citations"].is_array() {
                            b["citations"] = json!([]);
                        }
                        b["citations"].as_array_mut().unwrap().push(d["citation"].clone());
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let i = ev["index"].as_u64().unwrap_or(0) as usize;
                if let (Some(b), Some(p)) = (blocks.get_mut(i), partial_json.get(i)) {
                    if !p.is_empty() {
                        b["input"] = serde_json::from_str(p).unwrap_or(json!({}));
                    }
                }
            }
            "message_delta" => {
                if let Some(r) = ev["delta"]["stop_reason"].as_str() {
                    stop_reason = r.to_string();
                }
            }
            "error" => {
                let msg = ev["error"]["message"].as_str().unwrap_or("不明なエラー");
                return Err(format!("Claude からエラーが返りました: {msg}"));
            }
            _ => {}
        }
    }
    let mut blocks: Vec<Value> = blocks.into_iter().filter(|b| !b.is_null()).collect();
    // 途中でフォールバックしたときは、最後の fallback より前の思考・ツール呼び出しを履歴に戻さない
    if let Some(last) = blocks.iter().rposition(|b| b["type"] == "fallback") {
        let mut i = 0;
        blocks.retain(|b| {
            let keep = i >= last || !matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking" | "tool_use"));
            i += 1;
            keep
        });
    }
    Ok(Some((Value::Array(blocks), stop_reason)))
}

// ---- VOICEVOX ----

fn voicevox_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout_read(Duration::from_secs(60)).build()
}

fn voicevox_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("VOICEVOX からエラーが返りました（{code}）"),
        _ => "VOICEVOX につながりません。VOICEVOX を起動してください".into(),
    }
}

#[derive(Serialize)]
pub struct VoicevoxStyle {
    id: i64,
    name: String,
}

pub fn voicevox_speakers(base: &str) -> Result<Vec<VoicevoxStyle>, String> {
    let v: Value = voicevox_agent()
        .get(&format!("{}/speakers", base.trim_end_matches('/')))
        .call()
        .map_err(voicevox_error)?
        .into_string()
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))?;
    let mut out = Vec::new();
    for s in v.as_array().into_iter().flatten() {
        let speaker = s["name"].as_str().unwrap_or_default();
        for st in s["styles"].as_array().into_iter().flatten() {
            if let Some(id) = st["id"].as_i64() {
                out.push(VoicevoxStyle { id, name: format!("{speaker}（{}）", st["name"].as_str().unwrap_or_default()) });
            }
        }
    }
    Ok(out)
}

/// WAV を返す
pub fn voicevox_synthesize(base: &str, speaker: i64, text: &str) -> Result<Vec<u8>, String> {
    let base = base.trim_end_matches('/');
    let agent = voicevox_agent();
    let query: Value = agent
        .post(&format!("{base}/audio_query"))
        .query("speaker", &speaker.to_string())
        .query("text", text)
        .call()
        .map_err(voicevox_error)?
        .into_string()
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))?;
    let res = agent
        .post(&format!("{base}/synthesis"))
        .query("speaker", &speaker.to_string())
        .set("content-type", "application/json")
        .send_string(&query.to_string())
        .map_err(voicevox_error)?;
    let mut wav = Vec::new();
    res.into_reader().take(50 * 1024 * 1024).read_to_end(&mut wav).map_err(|e| e.to_string())?;
    Ok(wav)
}
