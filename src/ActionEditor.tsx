import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, AudioDevice, InstalledGame } from "./api";
import { Action, ACTION_GROUPS, ACTION_LABELS, ActionType, emptyAction, formatKeys, keyFromCode, MEDIA_LABELS, MediaCommand, MODIFIERS, Page } from "./deck";
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
  if (a.type === "macro" && a.steps.length === 0) return "ステップを 1 つ以上追加してください";
  if (a.type === "macro" && a.steps.some((s) => (s.type === "keys" || s.type === "key_down" || s.type === "key_up") && s.keys.length === 0))
    return "キーが未設定のステップがあります";
  return null;
}

function LaunchFields({
  action,
  onChange,
  onPicked,
}: {
  action: Extract<Action, { type: "launch" }>;
  onChange: (a: Action) => void;
  onPicked: (target: string, label: string, iconSource: string) => void;
}) {
  const [games, setGames] = useState<InstalledGame[] | null>(null);

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
        />
      </label>
      <div className="chips wrap">
        <button onClick={() => pickFile(false)}>ファイルを選ぶ</button>
        <button onClick={() => pickFile(true)}>フォルダを選ぶ</button>
        <button onClick={() => api.listInstalledGames().then(setGames)}>Steam / Epic から選ぶ</button>
      </div>
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
  onPicked?: (target: string, label: string, iconSource: string) => void;
  onSuggestLabel?: (label: string) => void;
  onError: (msg: string) => void;
};

export default function ActionEditor({ action, onChange, folders, exclude = [], onPicked, onSuggestLabel, onError }: Props) {
  const changeType = (type: ActionType) => {
    if (type === action.type) return;
    onChange(type === "page" ? { type, pageId: folders[0]?.id ?? NEW_FOLDER } : emptyAction(type));
  };

  return (
    <>
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

      <div className="action-fields">
        {action.type === "launch" && (
          <LaunchFields
            action={action}
            onChange={onChange}
            onPicked={onPicked ?? ((target) => onChange({ type: "launch", target, args: "" }))}
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
        {action.type === "system_panel" && <p className="hint">音量・明るさ・解像度・電源プランのパネルを開きます。</p>}
      </div>
    </>
  );
}
