import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, AudioDevice, InstalledGame } from "./api";
import {
  Action,
  ACTION_LABELS,
  ActionType,
  COLORS,
  DeckButton,
  DeckData,
  emptyAction,
  formatKeys,
  keyFromCode,
  MEDIA_LABELS,
  MediaCommand,
  MODIFIERS,
  Page,
  uid,
} from "./deck";
import ButtonFace from "./ButtonFace";

/** 新しいフォルダを作るときの仮の pageId */
const NEW_FOLDER = "__new__";

type Props = {
  initial: DeckButton;
  isNew: boolean;
  deck: DeckData;
  onSave: (button: DeckButton, newFolder: Page | null) => void;
  onDelete: () => void;
  onMove: () => void;
  onClose: () => void;
  onError: (msg: string) => void;
};

const baseName = (p: string) =>
  p
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.(exe|lnk|url|bat|cmd)$/i, "") ?? p;

// ---------------------------------------------------------------- 操作ごとの入力欄

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

// ---------------------------------------------------------------- エディター本体

export default function ButtonEditor({ initial, isNew, deck, onSave, onDelete, onMove, onClose, onError }: Props) {
  const [b, setB] = useState<DeckButton>(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setAction = (action: Action) => setB((x) => ({ ...x, action }));
  const folders = deck.pages.filter((p) => p.folder);

  const fetchIcon = async (source: string) => {
    const src = await api.getIcon(source).catch(() => null);
    if (src) setB((x) => ({ ...x, icon: { kind: "image", src } }));
    return !!src;
  };

  const changeType = (type: ActionType) => {
    if (type === b.action.type) return;
    setAction(type === "page" ? { type, pageId: folders[0]?.id ?? NEW_FOLDER } : emptyAction(type));
  };

  const save = () => {
    const a = b.action;
    if (a.type === "launch" && !a.target.trim()) return onError("開くものを指定してください");
    if (a.type === "hotkey" && !a.keys.some((k) => !(MODIFIERS as readonly string[]).includes(k))) return onError("キーを指定してください");
    if (a.type === "text" && !a.text) return onError("入力する文字を指定してください");
    let folder: Page | null = null;
    let button = b;
    if (a.type === "page" && (a.pageId === NEW_FOLDER || !a.pageId)) {
      folder = { id: uid(), name: b.label || "フォルダ", folder: true, buttons: [] };
      button = { ...b, action: { type: "page", pageId: folder.id } };
    }
    if (!button.label && !button.icon) button = { ...button, label: ACTION_LABELS[a.type] };
    onSave(button, folder);
  };

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>{isNew ? "ボタンを追加" : "ボタンを編集"}</h1>
          <button className="close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <div className="editor-top">
          <div className="preview">
            <ButtonFace button={b} />
          </div>
          <div className="editor-top-fields">
            <label className="field">
              <span>名前</span>
              <input value={b.label} onChange={(e) => setB({ ...b, label: e.target.value })} />
            </label>
            <div className="icon-row">
              <label className="field emoji">
                <span>絵文字</span>
                <input
                  value={b.icon?.kind === "emoji" ? b.icon.value : ""}
                  placeholder="🎮"
                  onChange={(e) => setB({ ...b, icon: e.target.value ? { kind: "emoji", value: e.target.value } : null })}
                />
              </label>
              <button
                onClick={async () => {
                  const p = await open({ multiple: false, filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp", "ico", "exe"] }] });
                  if (typeof p === "string" && !(await fetchIcon(p))) onError("画像を読み込めませんでした");
                }}
              >
                画像
              </button>
              {b.action.type === "launch" && b.action.target && (
                <button onClick={async () => !(await fetchIcon(b.action.type === "launch" ? b.action.target : "")) && onError("アイコンを取得できませんでした")}>
                  自動
                </button>
              )}
              <button className="ghost" onClick={() => setB({ ...b, icon: null })}>
                なし
              </button>
            </div>
            <div className="chips colors">
              {COLORS.map((c) => (
                <button
                  key={c ?? "none"}
                  className={`swatch ${b.color === c ? "on" : ""}`}
                  style={{ background: c ?? "var(--bg-3)" }}
                  onClick={() => setB({ ...b, color: c })}
                  aria-label={c ?? "標準"}
                />
              ))}
            </div>
          </div>
        </div>

        <section>
          <h2>操作</h2>
          <div className="chips wrap">
            {(Object.keys(ACTION_LABELS) as ActionType[])
              .filter((t) => t !== "none")
              .map((t) => (
                <button key={t} className={b.action.type === t ? "on" : ""} onClick={() => changeType(t)}>
                  {ACTION_LABELS[t]}
                </button>
              ))}
          </div>
        </section>

        <section className="action-fields">
          {b.action.type === "launch" && (
            <LaunchFields
              action={b.action}
              onChange={setAction}
              onPicked={(target, label, iconSource) => {
                setB((x) => ({ ...x, label: x.label || label, action: { type: "launch", target, args: "" } }));
                fetchIcon(iconSource);
              }}
            />
          )}
          {b.action.type === "hotkey" && <HotkeyFields action={b.action} onChange={setAction} />}
          {b.action.type === "text" && (
            <label className="field">
              <span>入力する文字</span>
              <textarea rows={3} value={b.action.text} onChange={(e) => setAction({ type: "text", text: e.target.value })} />
            </label>
          )}
          {b.action.type === "media" && (
            <div className="chips wrap">
              {(Object.keys(MEDIA_LABELS) as MediaCommand[]).map((c) => (
                <button key={c} className={b.action.type === "media" && b.action.command === c ? "on" : ""} onClick={() => setAction({ type: "media", command: c })}>
                  {MEDIA_LABELS[c]}
                </button>
              ))}
            </div>
          )}
          {b.action.type === "mic_mute" && <p className="hint">既定のマイクのミュートを切り替えます。ミュート中はボタンが赤くなります。</p>}
          {b.action.type === "audio_device" && <AudioDeviceFields action={b.action} onChange={setAction} />}
          {b.action.type === "page" && (
            <div className="chips wrap">
              {folders.map((f) => (
                <button key={f.id} className={b.action.type === "page" && b.action.pageId === f.id ? "on" : ""} onClick={() => setAction({ type: "page", pageId: f.id })}>
                  📁 {f.name}
                </button>
              ))}
              <button className={b.action.type === "page" && b.action.pageId === NEW_FOLDER ? "on" : ""} onClick={() => setAction({ type: "page", pageId: NEW_FOLDER })}>
                ＋ 新しいフォルダ
              </button>
            </div>
          )}
          {b.action.type === "system_panel" && <p className="hint">音量・明るさ・解像度・電源プランのパネルを開きます。</p>}
        </section>

        <div className="sheet-actions">
          {!isNew && (
            <>
              <button
                className="danger"
                onClick={() => {
                  if (!confirmDelete) return setConfirmDelete(true);
                  onDelete();
                }}
              >
                {confirmDelete ? (b.action.type === "page" ? "フォルダごと削除" : "本当に削除") : "削除"}
              </button>
              <button onClick={onMove}>移動</button>
            </>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="on" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
