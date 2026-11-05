import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, AudioDevice, InstalledGame, StartApp } from "./api";
import {
  Action,
  ACTION_GROUPS,
  ACTION_LABELS,
  ActionType,
  CONFIRM_SYSTEM,
  emptyAction,
  formatKeys,
  keyFromCode,
  MEDIA_LABELS,
  MediaCommand,
  MODIFIERS,
  Page,
  formatDuration,
  OBS_LABELS,
  ObsCommand,
  SOUND_EXTENSIONS,
  SOUND_RETAP_LABELS,
  SoundRetap,
  SYSTEM_LABELS,
  SystemCommand,
  TIMER_PRESETS,
} from "./deck";
import { playSound, stopSounds } from "./sound";
import { obs } from "./obs";
import MacroFields from "./MacroFields";
import WindowFields from "./WindowFields";
import PluginFields from "./PluginFields";

/** 新しいフォルダを作るときの仮の pageId */
export const NEW_FOLDER = "__new__";

export const baseName = (p: string) =>
  p
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.(exe|lnk|url|bat|cmd)$/i, "") ?? p;

export function validateAction(a: Action): string | null {
  if (a.type === "launch" && !a.target.trim()) return "開くものを指定してください";
  if (a.type === "hotkey" && !a.keys.some((k) => !(MODIFIERS as readonly string[]).includes(k))) return "キーを指定してください";
  if (a.type === "text" && !a.text) return "入力する文字を指定してください";
  if (a.type === "plugin" && (!a.pluginId || !a.actionId)) return "プラグインの操作を選んでください";
  if (a.type === "window" && a.command === "focus" && !a.app) return "前面に出すアプリを指定してください";
  if (a.type === "window" && a.command === "move_to" && !a.monitor) return "移動先のモニターを選んでください";
  if (a.type === "timer" && a.mode === "timer" && a.seconds <= 0) return "タイマーの長さを指定してください";
  if (a.type === "obs" && a.command === "scene" && !a.scene.trim()) return "シーンを指定してください";
  if (a.type === "obs" && a.command === "mute" && !a.input.trim()) return "音声ソースを指定してください";
  if (a.type === "sound" && !a.path.trim()) return "音声ファイルを選んでください";
  if (a.type === "macro" && a.steps.length === 0) return "ステップを 1 つ以上追加してください";
  if (a.type === "macro" && a.steps.some((s) => (s.type === "keys" || s.type === "key_down" || s.type === "key_up") && s.keys.length === 0))
    return "キーが未設定のステップがあります";
  return null;
}

function ObsFields({ action, onChange }: { action: Extract<Action, { type: "obs" }>; onChange: (a: Action) => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kind = action.command === "scene" ? "scene" : action.command === "mute" ? "input" : null;
  useEffect(() => {
    setNames(null);
    setError(null);
    if (!kind) return;
    const req = kind === "scene" ? obs.request("GetSceneList") : obs.request("GetInputList");
    req
      .then((d) =>
        setNames(kind === "scene" ? (d.scenes as { sceneName: string }[]).map((x) => x.sceneName).reverse() : (d.inputs as { inputName: string }[]).map((x) => x.inputName)),
      )
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, [kind]);
  const value = kind === "scene" ? action.scene : action.input;
  const setValue = (v: string) => onChange(kind === "scene" ? { ...action, scene: v } : { ...action, input: v });
  return (
    <>
      <div className="chips wrap">
        {(Object.keys(OBS_LABELS) as ObsCommand[]).map((c) => (
          <button key={c} className={action.command === c ? "on" : ""} onClick={() => onChange({ ...action, command: c })}>
            {OBS_LABELS[c]}
          </button>
        ))}
      </div>
      {kind && (
        <>
          <label className="field">
            <span>{kind === "scene" ? "シーン" : "音声ソース"}</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          {names && (
            <div className="chips wrap">
              {names.map((n) => (
                <button key={n} className={value === n ? "on" : ""} onClick={() => setValue(n)}>
                  {n}
                </button>
              ))}
            </div>
          )}
          {error && <p className="hint">OBS から一覧を取得できませんでした（{error}）。名前を直接入力することもできます。</p>}
        </>
      )}
      {action.command === "stream" && <p className="hint">誤って押さないよう、3 秒以内にもう一度タップしたときに実行します。</p>}
      <p className="hint">設定の「OBS 連携」で接続先を設定してください。ボタンは録画中・配信中・選択中のシーンなどで色が変わります。</p>
    </>
  );
}

const PREVIEW_ID = "__preview__";

function SoundFields({
  action,
  onChange,
  onSuggestLabel,
}: {
  action: Extract<Action, { type: "sound" }>;
  onChange: (a: Action) => void;
  onSuggestLabel?: (label: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => stopSounds(PREVIEW_ID), []);
  const pick = async () => {
    const p = await open({ multiple: false, filters: [{ name: "音声", extensions: SOUND_EXTENSIONS }] });
    if (typeof p !== "string") return;
    onChange({ ...action, path: p });
    onSuggestLabel?.(baseName(p).replace(/\.[^.]+$/, ""));
  };
  const preview = async () => {
    setError(null);
    stopSounds(PREVIEW_ID);
    try {
      await playSound(PREVIEW_ID, action.path, action.volume);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <label className="field">
        <span>音声ファイル</span>
        <input value={action.path} placeholder="C:\…\sound.mp3" onChange={(e) => onChange({ ...action, path: e.target.value })} />
      </label>
      <div className="chips wrap">
        <button onClick={pick}>ファイルを選ぶ</button>
        <button disabled={!action.path} onClick={preview}>
          試聴
        </button>
        <button onClick={() => stopSounds(PREVIEW_ID)}>停止</button>
      </div>
      {error && <p className="hint">{error}</p>}
      <label className="field">
        <span>音量 {action.volume}%</span>
        <input type="range" min={0} max={100} value={action.volume} onChange={(e) => onChange({ ...action, volume: Number(e.target.value) })} />
      </label>
      <h3 className="sub-heading">再生中にタップしたとき</h3>
      <div className="chips wrap">
        {(Object.keys(SOUND_RETAP_LABELS) as SoundRetap[]).map((r) => (
          <button key={r} className={action.retap === r ? "on" : ""} onClick={() => onChange({ ...action, retap: r })}>
            {SOUND_RETAP_LABELS[r]}
          </button>
        ))}
      </div>
      <p className="hint">既定の出力デバイスで再生します。対応する形式は {SOUND_EXTENSIONS.join(" / ")} です。</p>
    </>
  );
}

function LaunchFields({
  action,
  onChange,
  onPicked,
  onUrlEntered,
}: {
  action: Extract<Action, { type: "launch" }>;
  onChange: (a: Action) => void;
  onPicked: (target: string, label: string, iconSource: string) => void;
  onUrlEntered?: (url: string) => void;
}) {
  const [games, setGames] = useState<InstalledGame[] | null>(null);
  const [apps, setApps] = useState<StartApp[] | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shownApps = apps?.filter((a) => !q || a.name.toLowerCase().includes(q));

  const pickFile = async (directory: boolean) => {
    const path = await open({ multiple: false, directory });
    if (typeof path === "string") onPicked(path, baseName(path), path);
  };

  return (
    <>
      <label className="field">
        <span>開くもの（パスか URL）</span>
        <input
          value={action.target}
          placeholder="C:\…\app.exe、https://…、steam://rungameid/…"
          onChange={(e) => onChange({ ...action, target: e.target.value })}
          onBlur={() => /^https?:\/\//i.test(action.target.trim()) && onUrlEntered?.(action.target.trim())}
        />
      </label>
      <div className="chips wrap">
        <button onClick={() => pickFile(false)}>ファイルを選ぶ</button>
        <button onClick={() => pickFile(true)}>フォルダを選ぶ</button>
        <button
          onClick={() => {
            setGames(null);
            api.listStartApps().then(setApps);
          }}
        >
          アプリ一覧から選ぶ
        </button>
        <button
          onClick={() => {
            setApps(null);
            api.listInstalledGames().then(setGames);
          }}
        >
          Steam / Epic から選ぶ
        </button>
      </div>
      {shownApps && (
        <>
          <label className="field">
            <span>絞り込み</span>
            <input value={query} placeholder="アプリ名" onChange={(e) => setQuery(e.target.value)} autoFocus />
          </label>
          <ul className="picker">
            {shownApps.length === 0 && <li className="hint">見つかりません</li>}
            {shownApps.map((a) => (
              <li key={a.target}>
                <button
                  onClick={() => {
                    onPicked(a.target, a.name, a.target);
                    setApps(null);
                    setQuery("");
                  }}
                >
                  <span>{a.name}</span>
                  {a.packaged && <small>ストア</small>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {games && (
        <ul className="picker">
          {games.length === 0 && <li className="hint">インストール済みのゲームが見つかりません</li>}
          {games.map((g) => (
            <li key={g.id}>
              <button
                onClick={() => {
                  onPicked(g.launch, g.title, g.art ?? g.launch);
                  setGames(null);
                }}
              >
                <span>{g.title}</span>
                <small>{g.source === "steam" ? "Steam" : "Epic"}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {/\.exe"?$/i.test(action.target.trim()) && (
        <label className="field">
          <span>引数（任意）</span>
          <input value={action.args} onChange={(e) => onChange({ ...action, args: e.target.value })} />
        </label>
      )}
    </>
  );
}

function HotkeyFields({ action, onChange }: { action: Extract<Action, { type: "hotkey" }>; onChange: (a: Action) => void }) {
  const recorder = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const mods = action.keys.filter((k) => (MODIFIERS as readonly string[]).includes(k));
  const main = action.keys.find((k) => !(MODIFIERS as readonly string[]).includes(k)) ?? "";

  const set = (m: string[], k: string) => onChange({ ...action, keys: [...MODIFIERS.filter((x) => m.includes(x)), ...(k ? [k] : [])] });

  return (
    <>
      <div className="keys-display">{action.keys.length ? formatKeys(action.keys) : "未設定"}</div>
      <div className="chips wrap">
        {MODIFIERS.map((m) => (
          <button key={m} className={mods.includes(m) ? "on" : ""} onClick={() => set(mods.includes(m) ? mods.filter((x) => x !== m) : [...mods, m], main)}>
            {formatKeys([m])}
          </button>
        ))}
      </div>
      <label className="field">
        <span>キー（例: s、f5、space、enter、up）</span>
        <input value={main} onChange={(e) => set(mods, e.target.value.trim().toLowerCase())} />
      </label>
      <button
        className={`action secondary ${recording ? "on" : ""}`}
        onClick={() => {
          setRecording(true);
          recorder.current?.focus();
        }}
      >
        {recording ? "キーを押してください…" : "キーボードで記録する"}
      </button>
      <input
        ref={recorder}
        className="recorder"
        readOnly
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          e.preventDefault();
          const k = keyFromCode(e.code);
          if (!k) return; // 修飾キーだけのときは、続けて押されるのを待つ
          const m = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt", e.metaKey && "win"].filter(Boolean) as string[];
          set(m, k);
          e.currentTarget.blur();
        }}
      />
      <p className="hint">ゲームにも届くよう、スキャンコードで送信します。管理者権限で動くアプリには送れません。</p>
    </>
  );
}

function AudioDeviceFields({ action, onChange }: { action: Extract<Action, { type: "audio_device" }>; onChange: (a: Action) => void }) {
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  useEffect(() => {
    api.listAudioOutputs().then(setDevices).catch(() => setDevices([]));
  }, []);
  const toggle = (id: string) =>
    onChange({ ...action, deviceIds: action.deviceIds.includes(id) ? action.deviceIds.filter((x) => x !== id) : [...action.deviceIds, id] });

  return (
    <>
      <p className="hint">
        1 つだけ選ぶとそのデバイスに切り替えます。複数選ぶと、選んだ順に切り替えます。何も選ばないと、すべての出力デバイスを順番に切り替えます。
      </p>
      <ul className="picker">
        {devices?.map((d) => {
          const i = action.deviceIds.indexOf(d.id);
          return (
            <li key={d.id}>
              <button className={i >= 0 ? "on" : ""} onClick={() => toggle(d.id)}>
                <span>{d.name}</span>
                <small>{i >= 0 ? `${i + 1} 番目` : d.isDefault ? "使用中" : ""}</small>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

type Props = {
  action: Action;
  onChange: (a: Action) => void;
  folders: Page[];
  /** 選べないようにする操作の種類 */
  exclude?: ActionType[];
  /** 「なし」を選べるようにする（表示だけのボタン用） */
  allowNone?: boolean;
  onPicked?: (target: string, label: string, iconSource: string) => void;
  /** 開くものに URL を入力し終えたとき（ファビコンの自動取得用） */
  onUrlEntered?: (url: string) => void;
  onSuggestLabel?: (label: string) => void;
  onError: (msg: string) => void;
};

export default function ActionEditor({ action, onChange, folders, exclude = [], allowNone = false, onPicked, onUrlEntered, onSuggestLabel, onError }: Props) {
  const changeType = (type: ActionType) => {
    if (type === action.type) return;
    onChange(type === "page" ? { type, pageId: folders[0]?.id ?? NEW_FOLDER } : emptyAction(type));
  };

  return (
    <>
      {allowNone && (
        <div className="chips wrap">
          <button className={action.type === "none" ? "on" : ""} onClick={() => changeType("none")}>
            {ACTION_LABELS.none}
          </button>
        </div>
      )}
      {ACTION_GROUPS.map((g) => {
        const types = g.types.filter((t) => !exclude.includes(t));
        if (!types.length) return null;
        return (
          <div key={g.label} className="action-group">
            <h3>{g.label}</h3>
            <div className="chips wrap">
              {types.map((t) => (
                <button key={t} className={action.type === t ? "on" : ""} onClick={() => changeType(t)}>
                  {ACTION_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {action.type !== "none" && (
        <div className="action-fields">
          <h3 className="action-fields-title">{ACTION_LABELS[action.type]}の設定</h3>
          {action.type === "launch" && (
            <LaunchFields
              action={action}
              onChange={onChange}
              onPicked={onPicked ?? ((target) => onChange({ type: "launch", target, args: "" }))}
              onUrlEntered={onUrlEntered}
            />
          )}
          {action.type === "hotkey" && <HotkeyFields action={action} onChange={onChange} />}
          {action.type === "text" && (
            <label className="field">
              <span>入力する文字</span>
              <textarea rows={3} value={action.text} onChange={(e) => onChange({ type: "text", text: e.target.value })} />
            </label>
          )}
          {action.type === "media" && (
            <div className="chips wrap">
              {(Object.keys(MEDIA_LABELS) as MediaCommand[]).map((c) => (
                <button key={c} className={action.command === c ? "on" : ""} onClick={() => onChange({ type: "media", command: c })}>
                  {MEDIA_LABELS[c]}
                </button>
              ))}
            </div>
          )}
          {action.type === "mic_mute" && <p className="hint">既定のマイクのミュートを切り替えます。ミュート中はボタンが赤くなります。</p>}
          {action.type === "audio_device" && <AudioDeviceFields action={action} onChange={onChange} />}
          {action.type === "page" && (
            <div className="chips wrap">
              {folders.map((f) => (
                <button key={f.id} className={action.pageId === f.id ? "on" : ""} onClick={() => onChange({ type: "page", pageId: f.id })}>
                  📁 {f.name}
                </button>
              ))}
              <button className={action.pageId === NEW_FOLDER ? "on" : ""} onClick={() => onChange({ type: "page", pageId: NEW_FOLDER })}>
                ＋ 新しいフォルダ
              </button>
            </div>
          )}
          {action.type === "window" && <WindowFields action={action} onChange={onChange} />}
          {action.type === "plugin" && <PluginFields action={action} onChange={onChange} onSuggestLabel={onSuggestLabel ?? (() => {})} />}
          {action.type === "macro" && <MacroFields action={action} onChange={onChange} onError={onError} />}
          {action.type === "system" && (
            <>
              <div className="chips wrap">
                {(Object.keys(SYSTEM_LABELS) as SystemCommand[]).map((c) => (
                  <button key={c} className={action.command === c ? "on" : ""} onClick={() => onChange({ type: "system", command: c })}>
                    {SYSTEM_LABELS[c]}
                  </button>
                ))}
              </div>
              {CONFIRM_SYSTEM.includes(action.command) && <p className="hint">誤って押さないよう、3 秒以内にもう一度タップしたときに実行します。</p>}
            </>
          )}
          {action.type === "timer" && (
            <>
              <div className="chips wrap">
                <button className={action.mode === "timer" ? "on" : ""} onClick={() => onChange({ ...action, mode: "timer" })}>
                  タイマー
                </button>
                <button className={action.mode === "stopwatch" ? "on" : ""} onClick={() => onChange({ ...action, mode: "stopwatch" })}>
                  ストップウォッチ
                </button>
              </div>
              {action.mode === "timer" ? (
                <>
                  <div className="chips wrap">
                    {TIMER_PRESETS.map((s) => (
                      <button key={s} className={action.seconds === s ? "on" : ""} onClick={() => onChange({ ...action, seconds: s })}>
                        {s < 60 ? `${s} 秒` : `${s / 60} 分`}
                      </button>
                    ))}
                  </div>
                  <div className="icon-row">
                    <label className="field">
                      <span>分</span>
                      <input
                        type="number"
                        min={0}
                        value={Math.floor(action.seconds / 60)}
                        onChange={(e) => onChange({ ...action, seconds: Math.max(0, Number(e.target.value) || 0) * 60 + (action.seconds % 60) })}
                      />
                    </label>
                    <label className="field">
                      <span>秒</span>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={action.seconds % 60}
                        onChange={(e) => onChange({ ...action, seconds: Math.floor(action.seconds / 60) * 60 + Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                      />
                    </label>
                  </div>
                  <label className="switch-row">
                    <span>時間になったら音を鳴らす</span>
                    <input type="checkbox" className="switch" checked={action.sound} onChange={(e) => onChange({ ...action, sound: e.target.checked })} />
                  </label>
                  <p className="hint">
                    タップで開始し、動いている間にタップすると止めます。{formatDuration(action.seconds * 1000)} たつとボタンが点滅します。点滅中にタップすると元に戻ります。
                  </p>
                </>
              ) : (
                <p className="hint">タップするたびに、開始 → 一時停止 → リセットの順に切り替わります。</p>
              )}
            </>
          )}
          {action.type === "obs" && <ObsFields action={action} onChange={onChange} />}
          {action.type === "sound" && <SoundFields action={action} onChange={onChange} onSuggestLabel={onSuggestLabel} />}
          {action.type === "now_playing" && (
            <p className="hint">
              再生中の曲名・アーティスト・ジャケット画像をボタンに表示し、タップで再生 / 一時停止します。Spotify・ブラウザなど、Windows のメディア操作に対応したアプリの曲を表示します。
            </p>
          )}
          {action.type === "system_panel" && <p className="hint">音量・明るさ・解像度・電源プランのパネルを開きます。</p>}
        </div>
      )}
    </>
  );
}
