import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import {
  Action,
  ACTION_LABELS,
  canToggle,
  COLORS,
  DeckButton,
  DeckData,
  Hold,
  HOLD_ACTION_EXCLUDE,
  HOLD_LABELS,
  holdTypesFor,
  HoldType,
  Page,
  REPEAT_INTERVALS,
  toggledFace,
  ToggleState,
  uid,
  INFO_GROUPS,
  HISTORY_SECONDS,
  STATS_INFO,
  INFO_LABELS,
  BUTTON_SIZES,
  ButtonSize,
  SIZE_LABELS,
} from "./deck";
import ActionEditor, { NEW_FOLDER, validateAction } from "./ActionEditor";
import ButtonFace from "./ButtonFace";
import ShortcutField from "./ShortcutField";

type Props = {
  initial: DeckButton;
  isNew: boolean;
  deck: DeckData;
  onSave: (button: DeckButton, newFolder: Page | null) => void;
  onDelete: () => void;
  onMove: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  shortcutError: string | null;
  shortcutUserOf: (keys: string[] | undefined) => string | null;
  /** 今の位置にその大きさで収まるか */
  sizeFits: (size: ButtonSize) => boolean;
  onClose: () => void;
  onError: (msg: string) => void;
};

function newHold(type: HoldType): Hold {
  if (type === "repeat") return { type, intervalMs: 100 };
  if (type === "press") return { type };
  return { type, action: { type: "hotkey", keys: [] } };
}

function HoldSection({ button, folders, onChange, onError }: { button: DeckButton; folders: Page[]; onChange: (h: Hold | undefined) => void; onError: (msg: string) => void }) {
  const hold = button.hold;
  const types = holdTypesFor(button.action);
  return (
    <section>
      <h2>長押し（任意）</h2>
      <div className="chips wrap">
        <button className={!hold ? "on" : ""} onClick={() => onChange(undefined)}>
          なし
        </button>
        {types.map((t) => (
          <button key={t} className={hold?.type === t ? "on" : ""} onClick={() => hold?.type !== t && onChange(newHold(t))}>
            {HOLD_LABELS[t]}
          </button>
        ))}
      </div>
      {hold?.type === "repeat" && (
        <>
          <p className="hint">押している間、操作を繰り返します。</p>
          <div className="chips wrap">
            {REPEAT_INTERVALS.map((ms) => (
              <button key={ms} className={hold.intervalMs === ms ? "on" : ""} onClick={() => onChange({ type: "repeat", intervalMs: ms })}>
                {ms} ms ごと
              </button>
            ))}
          </div>
        </>
      )}
      {hold?.type === "press" && <p className="hint">指を離すまでキーを押したままにします（プッシュトゥトークや移動キーなど）。</p>}
      {hold?.type === "action" && (
        <>
          <p className="hint">0.5 秒押し続けると、タップとは別の操作を実行します。</p>
          <ActionEditor action={hold.action} onChange={(action) => onChange({ type: "action", action })} folders={folders} exclude={HOLD_ACTION_EXCLUDE} onError={onError} />
        </>
      )}
    </section>
  );
}

function ToggleSection({ button, folders, onChange, onError }: { button: DeckButton; folders: Page[]; onChange: (t: ToggleState | undefined) => void; onError: (msg: string) => void }) {
  const t = button.toggle;
  return (
    <section>
      <h2>トグル（任意）</h2>
      <div className="chips wrap">
        <button className={!t ? "on" : ""} onClick={() => onChange(undefined)}>
          なし
        </button>
        <button className={t ? "on" : ""} onClick={() => !t && onChange({ label: "", icon: null, color: null, action: { type: "hotkey", keys: [] } })}>
          オンとオフを切り替える
        </button>
      </div>
      {t && (
        <>
          <p className="hint">タップするたびにオンとオフが切り替わります。オフのときは上の操作を、オンのときは下の操作を実行します。</p>
          <div className="editor-top">
            <div className="preview" style={{ background: toggledFace(button).color ?? undefined }}>
              <ButtonFace button={toggledFace(button)} />
            </div>
            <div className="editor-top-fields">
              <label className="field">
                <span>オンのときの名前（空ならオフと同じ）</span>
                <input value={t.label} onChange={(e) => onChange({ ...t, label: e.target.value })} />
              </label>
              <div className="icon-row">
                <label className="field emoji">
                  <span>オンのときの絵文字</span>
                  <input
                    value={t.icon?.kind === "emoji" ? t.icon.value : ""}
                    placeholder="🟢"
                    onChange={(e) => onChange({ ...t, icon: e.target.value ? { kind: "emoji", value: e.target.value } : null })}
                  />
                </label>
              </div>
              <div className="chips colors">
                {COLORS.map((c) => (
                  <button
                    key={c ?? "none"}
                    className={`swatch ${t.color === c ? "on" : ""}`}
                    style={{ background: c ?? "var(--bg-3)" }}
                    onClick={() => onChange({ ...t, color: c })}
                    aria-label={c ?? "オフと同じ"}
                  />
                ))}
              </div>
            </div>
          </div>
          <h3 className="sub-heading">オンのときにタップしたら実行する操作</h3>
          <ActionEditor action={t.action} onChange={(action) => onChange({ ...t, action })} folders={folders} exclude={HOLD_ACTION_EXCLUDE} onError={onError} />
        </>
      )}
    </section>
  );
}

export default function ButtonEditor({ initial, isNew, deck, onSave, onDelete, onMove, onDuplicate, onCopy, shortcutError, shortcutUserOf, sizeFits, onClose, onError }: Props) {
  const [b, setB] = useState<DeckButton>(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 自動で入れた名前。ユーザーが書き換えていなければ、次の候補で置き換える */
  const suggested = useRef<string | null>(null);
  const setAction = (action: Action) => setB((x) => ({ ...x, action }));
  const folders = deck.pages.filter((p) => p.folder);

  const fetchIcon = async (source: string) => {
    const src = await api.getIcon(source).catch(() => null);
    if (src) setB((x) => ({ ...x, icon: { kind: "image", src } }));
    return !!src;
  };

  const save = () => {
    const a = b.action;
    const error = validateAction(a);
    if (error) return onError(error);
    let button = b;
    if (button.toggle && !canToggle(a)) button = { ...button, toggle: undefined };
    if (button.toggle) {
      const toggleError = validateAction(button.toggle.action);
      if (toggleError) return onError(`トグル: ${toggleError}`);
      button = { ...button, hold: undefined };
    }
    // 操作の種類を変えて使えなくなった長押しは外す
    if (button.hold && !holdTypesFor(a).includes(button.hold.type)) button = { ...button, hold: undefined };
    if (button.hold?.type === "action") {
      const holdError = validateAction(button.hold.action);
      if (holdError) return onError(`長押し: ${holdError}`);
    }
    let folder: Page | null = null;
    if (a.type === "page" && (a.pageId === NEW_FOLDER || !a.pageId)) {
      folder = { id: uid(), name: b.label || "フォルダ", folder: true, buttons: [] };
      button = { ...button, action: { type: "page", pageId: folder.id } };
    }
    if (!button.label && !button.icon && !button.info) button = { ...button, label: ACTION_LABELS[a.type] };
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
          <h2>大きさ</h2>
          <div className="chips wrap">
            {BUTTON_SIZES.map((size) => (
              <button
                key={size}
                className={(b.size ?? "1x1") === size ? "on" : ""}
                disabled={!sizeFits(size)}
                onClick={() => setB({ ...b, size: size === "1x1" ? undefined : size })}
              >
                {SIZE_LABELS[size]}
              </button>
            ))}
          </div>
          {BUTTON_SIZES.some((size) => !sizeFits(size)) && <p className="hint">右や下にボタンがあるか、端にあるため選べない大きさがあります。空けるか、ボタンを移動してください。</p>}
        </section>

        <section>
          <h2>表示（任意）</h2>
          {INFO_GROUPS.map((group, i) => (
            <div key={i} className="chips wrap">
              {i === 0 && (
                <button className={!b.info ? "on" : ""} onClick={() => setB({ ...b, info: undefined })}>
                  なし
                </button>
              )}
              {group.map((k) => (
                <button key={k} className={b.info === k ? "on" : ""} onClick={() => setB({ ...b, info: k, action: validateAction(b.action) ? { type: "none" } : b.action })}>
                  {INFO_LABELS[k]}
                </button>
              ))}
            </div>
          ))}
          {b.info && STATS_INFO.includes(b.info) && (
            <label className="switch-row">
              <span>直近 {HISTORY_SECONDS} 秒の推移を背景にグラフで表示する</span>
              <input type="checkbox" className="switch" checked={!!b.graph} onChange={(e) => setB({ ...b, graph: e.target.checked || undefined })} />
            </label>
          )}
          {b.info && <p className="hint">名前とアイコンがなければ大きく、あれば名前の下に表示します。操作の「なし」と組み合わせると、表示だけのボタンになります。</p>}
        </section>

        <section>
          <h2>操作</h2>
          <ActionEditor
            action={b.action}
            onChange={setAction}
            allowNone={!!b.info || b.action.type === "none"}
            folders={folders}
            onError={onError}
            onUrlEntered={(url) => {
              if (b.icon) return;
              // 取得を待つ間にアイコンを選んでいたら、そちらを優先する
              void api.getIcon(url).then((src) => src && setB((x) => (x.icon ? x : { ...x, icon: { kind: "image", src } })), () => {});
            }}
            onPicked={(target, label, iconSource) => {
              setB((x) => ({ ...x, label: x.label || label, action: { type: "launch", target, args: "" } }));
              fetchIcon(iconSource);
            }}
            onSuggestLabel={(label) =>
              setB((x) => {
                if (x.label && x.label !== suggested.current) return x;
                suggested.current = label;
                return { ...x, label };
              })
            }
          />
        </section>

        {canToggle(b.action) && <ToggleSection button={b} folders={folders} onChange={(toggle) => setB((x) => ({ ...x, toggle }))} onError={onError} />}

        {!(b.toggle && canToggle(b.action)) && <HoldSection button={b} folders={folders} onChange={(hold) => setB((x) => ({ ...x, hold }))} onError={onError} />}

        <section>
          <h2>キーボードショートカット（任意）</h2>
          <ShortcutField
            value={b.shortcut}
            onChange={(keys) => setB({ ...b, shortcut: keys?.length ? keys : undefined })}
            registeredError={initial.shortcut?.join("+") === b.shortcut?.join("+") ? shortcutError : null}
            usedBy={shortcutUserOf(b.shortcut)}
          />
          <p className="hint">どのアプリを使っているときでも、このキーでボタンを実行できます。</p>
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
              <button onClick={onDuplicate}>複製</button>
              <button onClick={onCopy}>コピー</button>
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
