import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AudioDevice, DeckStatus, States } from "./api";
import { DeckButton, DeckData, defaultDeck, Page, runsInBackend, uid } from "./deck";
import ButtonEditor from "./ButtonEditor";
import ButtonFace from "./ButtonFace";
import Settings from "./Settings";
import SystemPanel from "./SystemPanel";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock">{now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>;
}

function PageEditor({ page, canDelete, onSave, onDelete, onClose }: {
  page: Page;
  canDelete: boolean;
  onSave: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(page.name);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="overlay center" onClick={onClose}>
      <div className="sheet small" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>{page.folder ? "フォルダ" : "ページ"}の編集</h1>
          <button className="close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <label className="field">
          <span>名前</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="sheet-actions">
          {canDelete && (
            <button className="danger" onClick={() => (confirm ? onDelete() : setConfirm(true))}>
              {confirm ? "中のボタンごと削除" : "削除"}
            </button>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="on" onClick={() => onSave(name.trim() || page.name)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [deck, setDeck] = useState<DeckData | null>(null);
  /** 表示中のページの履歴（最後が今のページ）。フォルダを開くと積まれる。 */
  const [stack, setStack] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<{ button: DeckButton; isNew: boolean } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [pageEdit, setPageEdit] = useState<Page | null>(null);
  const [overlay, setOverlay] = useState<"settings" | "system" | null>(null);
  const [status, setStatus] = useState<DeckStatus>({ active: false, monitorConnected: false });
  const [states, setStates] = useState<States>({ micMuted: null, defaultOutput: null });
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; ok: boolean } | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3000);
  }, []);

  const commit = useCallback((next: DeckData) => {
    setDeck(next);
    api.saveDeck(next).catch((e) => showToast(`保存できませんでした: ${e}`));
  }, [showToast]);

  // ---- 読み込みと状態の監視
  useEffect(() => {
    api.getDeck().then((saved) => {
      const d = saved?.version === 1 && saved.pages?.length ? saved : defaultDeck();
      setDeck(d);
      if (!saved) api.saveDeck(d);
    });
    api.deckStatus().then(setStatus);
    const un = [
      listen<DeckStatus>("deck-status", (e) => setStatus(e.payload)),
      listen<string>("deck-error", (e) => showToast(e.payload)),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [showToast]);

  const refreshStates = useCallback(() => api.getStates().then(setStates).catch(() => {}), []);
  const hasAudioButtons = !!deck?.pages.some((p) => p.buttons.some((b) => b.action.type === "audio_device"));
  useEffect(() => {
    refreshStates();
    const t = setInterval(refreshStates, 2000);
    return () => clearInterval(t);
  }, [refreshStates]);
  useEffect(() => {
    if (!hasAudioButtons) return;
    const load = () => api.listAudioOutputs().then(setOutputs).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [hasAudioButtons]);

  // 編集中だけキーボード入力を受け付ける（通常時はフォーカスを奪わない）
  useEffect(() => {
    api.setFocusable(editing);
    if (!editing) setMoving(null);
  }, [editing, status.active]);

  const roots = useMemo(() => deck?.pages.filter((p) => !p.folder) ?? [], [deck]);
  const page = useMemo(() => {
    if (!deck) return null;
    const id = stack[stack.length - 1];
    return deck.pages.find((p) => p.id === id) ?? roots[0] ?? null;
  }, [deck, stack, roots]);

  if (!deck || !page) return null;

  const updatePage = (pageId: string, fn: (p: Page) => Page, extra: (d: DeckData) => DeckData = (d) => d) =>
    commit(extra({ ...deck, pages: deck.pages.map((p) => (p.id === pageId ? fn(p) : p)) }));

  // ---- ボタンの操作
  const run = async (b: DeckButton) => {
    const a = b.action;
    if (a.type === "page") {
      if (deck.pages.some((p) => p.id === a.pageId)) setStack([...stack, a.pageId]);
      else showToast("フォルダが見つかりません");
      return;
    }
    if (a.type === "system_panel") return setOverlay("system");
    if (!runsInBackend(a)) return;
    try {
      const msg = await api.runAction(a);
      setFlash({ id: b.id, ok: true });
      if (msg) showToast(msg);
    } catch (e) {
      setFlash({ id: b.id, ok: false });
      showToast(String(e));
    }
    window.setTimeout(() => setFlash(null), 350);
    window.setTimeout(refreshStates, 300);
  };

  const moveTo = (slot: number) => {
    const src = page.buttons.find((b) => b.id === moving);
    setMoving(null);
    if (!src || src.slot === slot) return;
    updatePage(page.id, (p) => ({
      ...p,
      buttons: p.buttons.map((b) => (b.id === src.id ? { ...b, slot } : b.slot === slot ? { ...b, slot: src.slot } : b)),
    }));
  };

  const tapSlot = (slot: number, b?: DeckButton) => {
    if (!editing) return b && run(b);
    if (moving) return moveTo(slot);
    setEditor(
      b
        ? { button: b, isNew: false }
        : { button: { id: uid(), slot, label: "", icon: null, color: null, action: { type: "hotkey", keys: [] } }, isNew: true },
    );
  };

  const saveButton = (button: DeckButton, folder: Page | null) => {
    updatePage(
      page.id,
      (p) => ({ ...p, buttons: p.buttons.some((b) => b.id === button.id) ? p.buttons.map((b) => (b.id === button.id ? button : b)) : [...p.buttons, button] }),
      (d) => (folder ? { ...d, pages: [...d.pages, folder] } : d),
    );
    setEditor(null);
  };

  const deleteButton = (button: DeckButton) => {
    const a = button.action;
    updatePage(
      page.id,
      (p) => ({ ...p, buttons: p.buttons.filter((b) => b.id !== button.id) }),
      (d) => (a.type === "page" ? { ...d, pages: d.pages.filter((p) => !(p.folder && p.id === a.pageId)) } : d),
    );
    setEditor(null);
  };

  // ---- ページ
  const addPage = () => {
    const p: Page = { id: uid(), name: `ページ ${roots.length + 1}`, folder: false, buttons: [] };
    commit({ ...deck, pages: [...deck.pages, p] });
    setStack([p.id]);
  };

  const tapTab = (p: Page) => {
    if (editing && p.id === page.id) return setPageEdit(p);
    setStack([p.id]);
  };

  // ---- 表示用の状態
  const subFor = (b: DeckButton) => {
    const a = b.action;
    if (a.type === "mic_mute" && states.micMuted) return "ミュート中";
    if (a.type === "audio_device" && a.deviceIds.length !== 1) return outputs.find((d) => d.id === states.defaultOutput)?.name ?? null;
    if (a.type === "page") return "📁";
    return null;
  };
  const classFor = (b: DeckButton) => {
    const a = b.action;
    const c = ["key"];
    if (a.type === "mic_mute" && states.micMuted) c.push("alert");
    if (a.type === "audio_device" && a.deviceIds.length === 1 && a.deviceIds[0] === states.defaultOutput) c.push("active");
    if (flash?.id === b.id) c.push(flash.ok ? "fired" : "failed");
    if (moving === b.id) c.push("moving");
    return c.join(" ");
  };

  const slots = deck.columns * deck.rows;
  const bySlot = new Map(page.buttons.map((b) => [b.slot, b]));

  return (
    <div className={`app ${editing ? "is-editing" : ""}`}>
      <header className="topbar">
        {page.folder ? (
          <div className="tabs">
            <button className="back" onClick={() => setStack(stack.slice(0, -1))}>
              ← 戻る
            </button>
            <button className="on" onClick={() => editing && setPageEdit(page)}>
              📁 {page.name}
            </button>
          </div>
        ) : (
          <nav className="tabs">
            {roots.map((p) => (
              <button key={p.id} className={p.id === page.id ? "on" : ""} onClick={() => tapTab(p)}>
                {p.name}
                {editing && p.id === page.id && " ✎"}
              </button>
            ))}
            {editing && (
              <button className="ghost" onClick={addPage}>
                ＋ ページ
              </button>
            )}
          </nav>
        )}
        <div className="topbar-right">
          <Clock />
          <button className={`tool ${editing ? "on" : ""}`} onClick={() => setEditing(!editing)}>
            {editing ? "完了" : "✎ 編集"}
          </button>
          <button className="tool" onClick={() => setOverlay("settings")} aria-label="設定">
            ⚙
          </button>
        </div>
      </header>

      {editing && (
        <div className="edit-hint">
          {moving ? "移動先をタップしてください（ボタンがある場所なら入れ替わります）" : "ボタンをタップして編集、空いている場所をタップして追加。タブをもう一度タップすると名前を変えられます。"}
        </div>
      )}

      <main className="grid" style={{ gridTemplateColumns: `repeat(${deck.columns}, 1fr)`, gridTemplateRows: `repeat(${deck.rows}, 1fr)` }}>
        {Array.from({ length: slots }, (_, slot) => {
          const b = bySlot.get(slot);
          if (!b) {
            return (
              <button key={`empty-${slot}`} className={`key empty ${editing ? "editable" : ""}`} onClick={() => tapSlot(slot)} disabled={!editing}>
                {editing && <span className="plus">＋</span>}
              </button>
            );
          }
          return (
            <button key={b.id} className={classFor(b)} style={b.color ? { background: b.color } : undefined} onClick={() => tapSlot(slot, b)}>
              <ButtonFace button={b} sub={subFor(b)} />
            </button>
          );
        })}
      </main>

      {editor && (
        <ButtonEditor
          initial={editor.button}
          isNew={editor.isNew}
          deck={deck}
          onSave={saveButton}
          onDelete={() => deleteButton(editor.button)}
          onMove={() => {
            setMoving(editor.button.id);
            setEditor(null);
          }}
          onClose={() => setEditor(null)}
          onError={showToast}
        />
      )}

      {pageEdit && (
        <PageEditor
          page={pageEdit}
          canDelete={pageEdit.folder || roots.length > 1}
          onClose={() => setPageEdit(null)}
          onSave={(name) => {
            updatePage(pageEdit.id, (p) => ({ ...p, name }));
            setPageEdit(null);
          }}
          onDelete={() => {
            const id = pageEdit.id;
            commit({
              ...deck,
              // フォルダを開くボタンも一緒に消す
              pages: deck.pages
                .filter((p) => p.id !== id)
                .map((p) => ({ ...p, buttons: p.buttons.filter((b) => !(b.action.type === "page" && b.action.pageId === id)) })),
            });
            setStack(stack.filter((s) => s !== id));
            setPageEdit(null);
          }}
        />
      )}

      {overlay === "system" && <SystemPanel onClose={() => setOverlay(null)} />}
      {overlay === "settings" && (
        <Settings
          deck={deck}
          status={status}
          onDeckChange={commit}
          onResetDeck={() => {
            const d = defaultDeck();
            commit(d);
            setStack([]);
            setOverlay(null);
          }}
          onError={showToast}
          onClose={() => setOverlay(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
