import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { ASSISTANT_MODELS, AssistantConfig, AssistantVoice, DEFAULT_ASSISTANT, DeckData, VOICE_LABELS, WHISPER_MODELS } from "./deck";
import { loadVoices, Speaker } from "./speech";

const SAMPLE = "こんにちは。SideDeck のアシスタントです。";

export default function AssistantSection({ deck, onDeckChange, onError }: { deck: DeckData; onDeckChange: (d: DeckData) => void; onError: (msg: string) => void }) {
  const conf = { ...DEFAULT_ASSISTANT, ...deck.assistant };
  const save = (patch: Partial<AssistantConfig>) => onDeckChange({ ...deck, assistant: { ...conf, ...patch } });

  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  useEffect(() => {
    api.assistantHasKey().then(setHasKey).catch(() => setHasKey(false));
  }, []);
  const saveKey = async (k: string) => {
    try {
      await api.assistantSetKey(k);
      setHasKey(!!k.trim());
      setKey("");
    } catch (e) {
      onError(String(e));
    }
  };

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    loadVoices().then(setVoices);
  }, []);

  const [vvUrl, setVvUrl] = useState(conf.voicevoxUrl);
  const [speakers, setSpeakers] = useState<{ id: number; name: string }[] | null>(null);
  const loadSpeakers = () =>
    api
      .voicevoxSpeakers(vvUrl.trim() || DEFAULT_ASSISTANT.voicevoxUrl)
      .then(setSpeakers)
      .catch((e) => {
        setSpeakers(null);
        onError(String(e));
      });
  useEffect(() => {
    if (conf.voice === "voicevox") loadSpeakers();
  }, [conf.voice]);

  const [instructions, setInstructions] = useState(conf.instructions);
  const [city, setCity] = useState(conf.city);

  const [inputs, setInputs] = useState<{ id: string; name: string; isDefault: boolean }[]>([]);
  useEffect(() => {
    api.listAudioInputs().then(setInputs).catch((e) => onError(String(e)));
  }, []);

  // ダウンロードは設定画面を閉じても続くので、状態は Rust 側から読み、終わりはイベントで知る
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [downloading, setDownloading] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ model: string; received: number; total: number } | null>(null);
  const refreshModels = () =>
    api
      .whisperModels()
      .then((s) => {
        setDownloaded(s.downloaded);
        setDownloading(s.downloading);
      })
      .catch(() => {});
  useEffect(() => {
    refreshModels();
    const un = [
      listen<{ model: string; received: number; total: number }>("whisper-download", (e) => setProgress(e.payload)),
      listen<{ model: string; error: string | null }>("whisper-download-end", (e) => {
        setProgress(null);
        if (e.payload.error) onError(e.payload.error);
        refreshModels();
      }),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);
  const download = (model: string) => {
    setDownloading((d) => [...d, model]);
    // 結果は whisper-download-end で受け取る
    api.downloadWhisperModel(model).catch(() => {});
  };
  const hasModel = downloaded.includes(conf.whisperModel);
  const busy = downloading.includes(conf.whisperModel);
  const shown = progress?.model === conf.whisperModel ? progress : null;

  const preview = () => new Speaker(() => conf, () => {}, onError).speak(SAMPLE);

  return (
    <section>
      <h2>AI アシスタント</h2>
      <p className="hint">ボタンの操作で「AI アシスタント」を選ぶと、声で Claude と会話できます。タップで話しかけ、長押しで会話をリセットします。</p>

      <label className="field">
        <span>Claude の API キー{hasKey ? "（保存済み）" : ""}</span>
        <input type="password" value={key} placeholder={hasKey ? "変更するときだけ入力" : "sk-ant-…"} onChange={(e) => setKey(e.target.value)} />
      </label>
      <div className="chips">
        <button disabled={!key.trim()} onClick={() => saveKey(key)}>
          保存
        </button>
        {hasKey && <button onClick={() => saveKey("")}>削除</button>}
      </div>
      <p className="hint">API キーは Claude Console（platform.claude.com）で作成します。使った分だけ料金がかかります。キーは Windows の資格情報マネージャーに保存します。</p>

      <h3 className="sub-heading">モデル</h3>
      <div className="chips wrap">
        {ASSISTANT_MODELS.map(([id, label]) => (
          <button key={id} className={conf.model === id ? "on" : ""} onClick={() => save({ model: id })}>
            {label}
          </button>
        ))}
      </div>

      <h3 className="sub-heading">聞き取り</h3>
      <label className="field">
        <span>マイク</span>
        <select value={conf.inputDevice} onChange={(e) => save({ inputDevice: e.target.value })}>
          <option value="">Windows の既定の録音デバイス</option>
          {inputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.isDefault ? "（既定）" : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="chips wrap">
        {WHISPER_MODELS.map((m) => (
          <button key={m.id} className={conf.whisperModel === m.id ? "on" : ""} onClick={() => save({ whisperModel: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
      {busy ? (
        <p className="hint">
          ダウンロードしています…{" "}
          {shown && (shown.total ? `${Math.floor((shown.received / shown.total) * 100)}%` : `${Math.floor(shown.received / 1e6)} MB`)}
        </p>
      ) : hasModel ? (
        <p className="hint">ダウンロード済みです。</p>
      ) : (
        <div className="chips">
          <button onClick={() => download(conf.whisperModel)}>
            ダウンロード（{WHISPER_MODELS.find((m) => m.id === conf.whisperModel)?.size}）
          </button>
        </div>
      )}
      <p className="hint">話しかけた声は、この PC の上で Whisper が文字にします（声はネットに送りません）。大きいモデルほど正確ですが、文字にするのに時間がかかります。</p>

      <h3 className="sub-heading">読み上げ</h3>
      <div className="chips wrap">
        {(Object.keys(VOICE_LABELS) as AssistantVoice[]).map((v) => (
          <button key={v} className={conf.voice === v ? "on" : ""} onClick={() => save({ voice: v })}>
            {VOICE_LABELS[v]}
          </button>
        ))}
      </div>
      {conf.voice === "windows" && (
        <>
          <label className="field">
            <span>声</span>
            <select value={conf.windowsVoice} onChange={(e) => save({ windowsVoice: e.target.value })}>
              <option value="">既定</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          {voices.length === 0 && <p className="hint">日本語の声が見つかりません。Windows の設定の「時刻と言語」→「音声認識」で、日本語の音声を追加してください。</p>}
        </>
      )}
      {conf.voice === "voicevox" && (
        <>
          <label className="field">
            <span>VOICEVOX の URL</span>
            <input value={vvUrl} placeholder={DEFAULT_ASSISTANT.voicevoxUrl} onChange={(e) => setVvUrl(e.target.value)} onBlur={() => save({ voicevoxUrl: vvUrl.trim() || DEFAULT_ASSISTANT.voicevoxUrl })} />
          </label>
          <label className="field">
            <span>声</span>
            <select value={conf.voicevoxSpeaker ?? ""} onChange={(e) => save({ voicevoxSpeaker: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">選んでください</option>
              {speakers?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="chips">
            <button onClick={loadSpeakers}>声の一覧を読み込み直す</button>
          </div>
          <p className="hint">VOICEVOX を起動している間だけ使えます。声を使うときは、VOICEVOX の利用規約と各キャラクターの規約に従ってください。</p>
        </>
      )}
      {conf.voice !== "none" && (
        <>
          <label className="field">
            <span>音量 {conf.voiceVolume}</span>
            <input type="range" min={0} max={100} step={5} value={conf.voiceVolume} onChange={(e) => save({ voiceVolume: Number(e.target.value) })} />
          </label>
          <div className="chips">
            <button onClick={preview}>試聴</button>
          </div>
        </>
      )}

      <h3 className="sub-heading">調べもの</h3>
      <label className="switch-row">
        <span>天気やニュースをウェブで調べる</span>
        <input type="checkbox" className="switch" checked={conf.webSearch} onChange={(e) => save({ webSearch: e.target.checked })} />
      </label>
      <label className="field">
        <span>地域（任意）</span>
        <input value={city} placeholder="例: 東京都渋谷区" onChange={(e) => setCity(e.target.value)} onBlur={() => save({ city: city.trim() })} />
      </label>
      <p className="hint">
        Claude API のウェブ検索を使います。検索した回数に応じた料金が、会話の料金とは別にかかります。地域を入れると、天気などをその地域で答えます。Claude Console の組織の設定でウェブ検索がオフになっていると使えません。
      </p>

      <label className="field">
        <span>追加の指示（任意）</span>
        <textarea
          rows={3}
          value={instructions}
          placeholder="例: 関西弁で話して。ゲームの話題が多いです。"
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => save({ instructions })}
        />
      </label>
    </section>
  );
}
