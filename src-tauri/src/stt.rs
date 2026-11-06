//! 音声認識: 選んだマイクから録音し、話し終わりを無音で判定して Whisper で文字にする

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// (設定の値, ファイル名, SHA-256)。SHA-256 は Hugging Face のファイル一覧（LFS の oid）の値で、ダウンロードした内容と照合する
const MODELS: &[(&str, &str, &str)] = &[
    ("base", "ggml-base.bin", "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"),
    ("small", "ggml-small.bin", "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"),
    ("large-v3-turbo", "ggml-large-v3-turbo-q5_0.bin", "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
];
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

const WHISPER_RATE: u32 = 16_000;
/// 話し始めるのをこれだけ待つ
const START_TIMEOUT: Duration = Duration::from_secs(8);
/// 話し始めてから、これだけ無音が続いたら話し終わりとみなす
const END_SILENCE: Duration = Duration::from_millis(1100);
const MAX_LENGTH: Duration = Duration::from_secs(30);

static LEVEL: AtomicU32 = AtomicU32::new(0);
static INPUT_NAME: Mutex<String> = Mutex::new(String::new());
/// これ以下の ID の聞き取りは取り消された。録音を始める前に届いた取り消しも失わないよう、ID で比べる
static CANCELLED: AtomicU64 = AtomicU64::new(0);
static DOWNLOADING: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static CONTEXT: Mutex<Option<(PathBuf, Arc<WhisperContext>)>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    id: String,
    name: String,
    is_default: bool,
}

pub fn list_inputs() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().and_then(|d| d.id().ok()).map(|id| id.to_string());
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    Ok(devices
        .filter_map(|d| {
            let id = d.id().ok()?.to_string();
            Some(InputDevice { is_default: default_id.as_deref() == Some(id.as_str()), name: d.to_string(), id })
        })
        .collect())
}

#[derive(Serialize)]
pub struct Level {
    name: String,
    level: f32,
}

/// 録音中のマイクの名前と音量（0〜1）
pub fn level() -> Level {
    Level { name: INPUT_NAME.lock().unwrap().clone(), level: f32::from_bits(LEVEL.load(Ordering::Relaxed)) }
}

pub fn stop(id: u64) {
    CANCELLED.fetch_max(id, Ordering::SeqCst);
}

fn cancelled(id: u64) -> bool {
    CANCELLED.load(Ordering::SeqCst) >= id
}

fn find_device(id: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if !id.is_empty() {
        if let Some(d) = id.parse().ok().and_then(|id| host.device_by_id(&id)) {
            return Ok(d);
        }
    }
    host.default_input_device().ok_or_else(|| "マイクが見つかりません".to_string())
}

/// 話し終わるまで録音して 16kHz モノラルで返す。取り消されたら None
fn record(device_id: &str, id: u64) -> Result<Option<Vec<f32>>, String> {
    let device = find_device(device_id)?;
    *INPUT_NAME.lock().unwrap() = device.to_string();
    let supported = device.default_input_config().map_err(|e| format!("マイクを使えません（{e}）"))?;
    let config = supported.config();
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    let buf: Arc<Mutex<Vec<f32>>> = Arc::default();

    let push = {
        let buf = buf.clone();
        move |mono: Vec<f32>| {
            let peak = mono.iter().fold(0f32, |m, v| m.max(v.abs()));
            LEVEL.store(peak.to_bits(), Ordering::Relaxed);
            buf.lock().unwrap().extend(mono);
        }
    };
    let to_mono = move |frame: &[f32]| frame.iter().sum::<f32>() / frame.len() as f32;
    let err = |e: cpal::Error| eprintln!("[stt] stream error: {e}");
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
            config,
            move |data, _| push(data.chunks(channels).map(to_mono).collect()),
            err,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
            config,
            move |data, _| {
                push(data.chunks(channels).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / f.len() as f32).collect())
            },
            err,
            None,
        ),
        f => return Err(format!("このマイクの形式（{f:?}）には対応していません")),
    }
    .map_err(|e| format!("マイクを開けません（{e}）"))?;
    stream.play().map_err(|e| format!("録音を始められません（{e}）"))?;

    let started = Instant::now();
    let mut noise_floor = f32::MAX;
    let mut speech_at: Option<Instant> = None;
    let mut voiced_at = Instant::now();
    let mut checked = 0usize;
    loop {
        std::thread::sleep(Duration::from_millis(50));
        if cancelled(id) {
            LEVEL.store(0, Ordering::Relaxed);
            return Ok(None);
        }
        let (rms, len) = {
            let b = buf.lock().unwrap();
            let chunk = &b[checked.min(b.len())..];
            let rms = if chunk.is_empty() { 0.0 } else { (chunk.iter().map(|v| v * v).sum::<f32>() / chunk.len() as f32).sqrt() };
            (rms, b.len())
        };
        checked = len;
        // 最初の 0.3 秒で周りの雑音の大きさを測り、それより十分大きければ声とみなす
        if started.elapsed() < Duration::from_millis(300) {
            noise_floor = noise_floor.min(rms.max(0.002));
            continue;
        }
        let voiced = rms > (noise_floor * 3.0).max(0.01);
        let now = Instant::now();
        if voiced {
            voiced_at = now;
            speech_at.get_or_insert(now);
        }
        match speech_at {
            None if started.elapsed() > START_TIMEOUT => {
                LEVEL.store(0, Ordering::Relaxed);
                return Err("声が聞こえませんでした".into());
            }
            Some(_) if now - voiced_at > END_SILENCE || started.elapsed() > MAX_LENGTH => break,
            _ => {}
        }
    }
    drop(stream);
    LEVEL.store(0, Ordering::Relaxed);
    let samples = std::mem::take(&mut *buf.lock().unwrap());
    Ok(Some(resample(&samples, rate, WHISPER_RATE)))
}

fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let len = (input.len() as f64 / ratio) as usize;
    (0..len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let j = pos as usize;
            let t = (pos - j as f64) as f32;
            let a = input[j];
            let b = *input.get(j + 1).unwrap_or(&a);
            a + (b - a) * t
        })
        .collect()
}

fn context(path: &Path) -> Result<Arc<WhisperContext>, String> {
    let mut cached = CONTEXT.lock().unwrap();
    if let Some((p, ctx)) = cached.as_ref() {
        if p == path {
            return Ok(ctx.clone());
        }
    }
    let ctx = WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("音声認識のモデルを読み込めません（{e}）"))?;
    let ctx = Arc::new(ctx);
    *cached = Some((path.to_path_buf(), ctx.clone()));
    Ok(ctx)
}

/// 無音や雑音に対して Whisper が出しがちな決まり文句
fn is_hallucination(text: &str) -> bool {
    const PHRASES: &[&str] = &["ご視聴ありがとうございました", "ご清聴ありがとうございました", "チャンネル登録", "字幕"];
    let t = text.trim().trim_matches(|c: char| c.is_ascii_punctuation() || "。、！？".contains(c));
    t.is_empty() || PHRASES.iter().any(|p| t.starts_with(p))
}

fn transcribe(model: &Path, audio: &[f32]) -> Result<String, String> {
    let ctx = context(model)?;
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("ja"));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    params.set_n_threads((threads / 2).clamp(1, 8) as i32);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, audio).map_err(|e| format!("音声を文字にできませんでした（{e}）"))?;
    let text: String = state.as_iter().map(|s| s.to_string()).collect::<String>().trim().to_string();
    Ok(if is_hallucination(&text) { String::new() } else { text })
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("whisper")).map_err(|e| e.to_string())
}

fn model_info(model: &str) -> Result<&'static (&'static str, &'static str, &'static str), String> {
    MODELS.iter().find(|(m, _, _)| *m == model).ok_or_else(|| "不明なモデルです".to_string())
}

fn model_path(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    let (_, file, _) = model_info(model)?;
    Ok(models_dir(app)?.join(file))
}

/// 取り消されたら空文字列
pub fn listen(app: &AppHandle, device_id: &str, model: &str, id: u64) -> Result<String, String> {
    let path = model_path(app, model)?;
    if !path.exists() {
        return Err("設定の「AI アシスタント」で、音声認識のモデルをダウンロードしてください".into());
    }
    if cancelled(id) {
        return Ok(String::new());
    }
    let Some(audio) = record(device_id, id)? else { return Ok(String::new()) };
    let _ = app.emit("stt-transcribing", ());
    let started = Instant::now();
    let text = transcribe(&path, &audio)?;
    eprintln!("[stt] {:.1}s of audio in {:?}: {text:?}", audio.len() as f32 / WHISPER_RATE as f32, started.elapsed());
    if text.is_empty() {
        return Err("聞き取れませんでした".into());
    }
    Ok(text)
}

#[derive(Serialize)]
pub struct ModelStatus {
    downloaded: Vec<String>,
    downloading: Vec<String>,
}

pub fn model_status(app: &AppHandle) -> ModelStatus {
    let downloaded = MODELS.iter().filter(|(m, _, _)| model_path(app, m).is_ok_and(|p| p.exists())).map(|(m, _, _)| m.to_string()).collect();
    let downloading = DOWNLOADING.lock().unwrap().iter().flatten().cloned().collect();
    ModelStatus { downloaded, downloading }
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    model: &'a str,
    received: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
struct Finished<'a> {
    model: &'a str,
    error: Option<String>,
}

/// 同じモデルを並行してダウンロードすると、同じ一時ファイルに書き込んで壊れるので、1 つずつにする
pub fn download_model(app: &AppHandle, model: &str) -> Result<(), String> {
    let path = model_path(app, model)?;
    if !DOWNLOADING.lock().unwrap().get_or_insert_default().insert(model.to_string()) {
        return Err("このモデルはダウンロード中です".into());
    }
    let part = path.with_extension("part");
    let result = download(app, model, &path, &part);
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    DOWNLOADING.lock().unwrap().get_or_insert_default().remove(model);
    let _ = app.emit("whisper-download-end", Finished { model, error: result.as_ref().err().cloned() });
    result
}

fn download(app: &AppHandle, model: &str, path: &Path, part: &Path) -> Result<(), String> {
    let (_, file, sha256) = model_info(model)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let res = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .build()
        .get(&format!("{MODEL_BASE_URL}/{file}"))
        .call()
        .map_err(|e| format!("モデルをダウンロードできません（{e}）"))?;
    let total = res.header("content-length").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut out = std::fs::File::create(part).map_err(|e| e.to_string())?;
    let mut reader = res.into_reader();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let (mut received, mut last) = (0u64, Instant::now());
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("ダウンロードが途切れました（{e}）"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if last.elapsed() > Duration::from_millis(200) {
            last = Instant::now();
            let _ = app.emit("whisper-download", Progress { model, received, total });
        }
    }
    drop(out);
    let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest != *sha256 {
        return Err("ダウンロードしたモデルが壊れているか、正しいファイルではありません。もう一度ダウンロードしてください".into());
    }
    std::fs::rename(part, path).map_err(|e| e.to_string())
}
