import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, AudioDevice, DeckStatus, NowPlaying, PluginButtonState, States, WindowApp } from "./api";
import { Action, canToggle, cloneButton, CONFIRM_SYSTEM, formatDuration, DeckButton, DeckData, defaultDeck, firstEmptySlot, Page, pruneOrphanFolders, runsInBackend, shortcutEntries, shortcutUser, SYSTEM_LABELS, TOGGLE_SHORTCUT_ID, toggledFace, uid } from "./deck";
import ButtonEditor from "./ButtonEditor";
import ButtonFace from "./ButtonFace";
import Settings from "./Settings";
import SystemPanel from "./SystemPanel";
import { onSoundsChange, playSound, stopSounds } from "./sound";

const HOLD_MS = 500;
const REPEAT_DELAY_MS = 400;
const CONFIRM_MS = 3000;

type Press = { id: string; timers: number[]; intervals: number[]; fired: boolean; release?: () => void };

const TOGGLED_KEY = "sidedeck.toggled";

function loadToggled(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TOGGLED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** startedAt が null なら止まっている。durationMs はタイマーのときだけ */
type TimerState = { startedAt: number | null; elapsed: number; durationMs: number | null; done: boolean; sound: boolean };

const timerElapsed = (t: TimerState, now: number) => t.elapsed + (t.startedAt === null ? 0 : now - t.startedAt);

function beep(ctx: AudioContext) {
  for (let i = 0; i < 3; i++) {
    const at = ctx.currentTime + i * 0.35;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.25);
  }
}

function stopPress(p: Press) {
  p.timers.forEach((t) => window.clearTimeout(t));
  p.intervals.forEach((t) => window.clearInterval(t));
  p.release?.();
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  const p = (n: number) => String(n).padStart(2, "0");
  const weekday = "日月火水木金土"[now.getDay()];
  return (
    <span className="clock">
      {p(now.getMonth() + 1)}/{p(now.getDate())} ({weekday}) {p(now.getHours())}:{p(now.getMinutes())}
    </span>
  );
}

function AppsField({ apps, onChange, lastApp }: { apps: string[]; onChange: (apps: string[]) => void; lastApp: WindowApp | null }) {
  const [running, setRunning] = useState<WindowApp[] | null>(null);
  const [manual, setManual] = useState("");
  const add = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n) return;
    const exe = n.endsWith(".exe") ? n : `${n}.exe`;
    if (!apps.includes(exe)) onChange([...apps, exe]);
  };

  return (
    <section>
      <h2>自動で切り替えるアプリ</h2>
      <p className="hint">ここに登録したアプリが前面に来たら、このページに切り替えます。そのアプリから離れると、元のページに戻ります。</p>
      <div className="chips wrap">
        {apps.map((a) => (
          <button key={a} className="on" onClick={() => onChange(apps.filter((x) => x !== a))}>
            {a} ✕
          </button>
        ))}
        {apps.length === 0 && <span className="hint">未登録</span>}
      </div>
      <div className="chips wrap">
        {lastApp && !apps.includes(lastApp.name) && <button onClick={() => add(lastApp.name)}>＋ 直前に使っていたアプリ（{lastApp.name}）</button>}
        <button onClick={() => api.listWindowApps().then(setRunning)}>＋ 実行中のアプリから選ぶ</button>
      </div>
      {running && (
        <ul className="picker">
          {running.map((w) => (
            <li key={w.name}>
              <button
                className={apps.includes(w.name) ? "on" : ""}
                onClick={() => (apps.includes(w.name) ? onChange(apps.filter((x) => x !== w.name)) : add(w.name))}
              >
                <span>{w.name}</span>
                <small>{w.title}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="inline-add">
        <input value={manual} placeholder="プロセス名を入力（例: code.exe）" onChange={(e) => setManual(e.target.value)} />
        <button
          onClick={() => {
            add(manual);
            setManual("");
          }}
        >
          追加
        </button>
      </div>
    </section>
  );
}

function PageEditor({ page, canDelete, lastApp, onSave, onDelete, onClose }: {
  page: Page;
  canDelete: boolean;
  lastApp: WindowApp | null;
  onSave: (name: string, apps: string[]) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(page.name);
  const [apps, setApps] = useState(page.apps ?? []);
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
        {!page.folder && <AppsField apps={apps} onChange={setApps} lastApp={lastApp} />}
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
          <button className="on" onClick={() => onSave(name.trim() || page.name, apps)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [deck, setDeck] = useState<DeckData | null>(null);
  /** 最後が今のページ。フォルダを開くと積まれる。 */
  const [stack, setStack] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<{ button: DeckButton; isNew: boolean } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{ button: DeckButton; pages: Page[] } | null>(null);
  const [pageEdit, setPageEdit] = useState<Page | null>(null);
  const [overlay, setOverlay] = useState<"settings" | "system" | null>(null);
  const [status, setStatus] = useState<DeckStatus>({ active: false, monitorConnected: false });
  const [states, setStates] = useState<States>({ micMuted: null, defaultOutput: null });
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; ok: boolean } | null>(null);
  const [runningMacros, setRunningMacros] = useState<Set<string>>(new Set());
  const [foreground, setForeground] = useState<WindowApp | null>(null);
  const autoSwitched = useRef<{ page: string; returnTo: string[] } | null>(null);
  /** 登録できなかったショートカット（id → 理由） */
  const [shortcutErrors, setShortcutErrors] = useState<Record<string, string>>({});
  /** ショートカットのイベントから、最新の deck で実行するため */
  const runShortcut = useRef<(id: string) => void>(() => {});
  /** プラグインが setState で送ってきた見た目（ボタンの id → 状態） */
  const [pluginStates, setPluginStates] = useState<Record<string, PluginButtonState>>({});
  /** 長押しを設定したボタンを押している間の状態 */
  const press = useRef<Press | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [timers, setTimers] = useState<Record<string, TimerState>>({});
  const timersRef = useRef(timers);
  timersRef.current = timers;
  const [now, setNow] = useState(Date.now());
  /** 音はタップ（ユーザー操作）の中で作ったコンテキストでないと鳴らないことがある */
  const audio = useRef<AudioContext | null>(null);
  const anyTimerRunning = Object.values(timers).some((t) => t.startedAt !== null);
  useEffect(() => {
    if (!anyTimerRunning) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const finished = Object.entries(timersRef.current).filter(([, s]) => s.startedAt !== null && s.durationMs !== null && timerElapsed(s, t) >= s.durationMs);
      if (!finished.length) return;
      if (finished.some(([, s]) => s.sound) && audio.current) beep(audio.current);
      setTimers((prev) => {
        const next = { ...prev };
        for (const [id] of finished) if (next[id]) next[id] = { ...next[id], startedAt: null, elapsed: next[id].durationMs ?? 0, done: true };
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [anyTimerRunning]);
  const [sounds, setSounds] = useState<Set<string>>(new Set());
  useEffect(() => onSoundsChange(setSounds), []);
  /** 確認待ちの PC の操作（もう一度タップすると実行） */
  const confirming = useRef<{ id: string; at: number } | null>(null);
  /** オンになっているトグルボタンの id */
  const [toggled, setToggled] = useState<Set<string>>(loadToggled);
  useEffect(() => {
    try {
      localStorage.setItem(TOGGLED_KEY, JSON.stringify([...toggled]));
    } catch {
      // 保存できなくても、起動している間は切り替えられる
    }
  }, [toggled]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3000);
  }, []);

  const commit = useCallback((next: DeckData) => {
    const pruned = pruneOrphanFolders(next);
    setDeck(pruned);
    api.saveDeck(pruned).catch((e) => showToast(`保存できませんでした: ${e}`));
  }, [showToast]);

  useEffect(() => {
    api.getDeck().then((saved) => {
      const d = saved?.version === 1 && saved.pages?.length ? pruneOrphanFolders(saved) : defaultDeck();
      setDeck(d);
      if (!saved) api.saveDeck(d);
    });
    api.takeStartupWarning().then((w) => {
      if (!w) return;
      setToast(w);
      window.setTimeout(() => setToast((t) => (t === w ? null : t)), 15_000);
    });
    api.deckStatus().then(setStatus);
    api.getForegroundApp().then(setForeground);
    const un = [
      listen<DeckStatus>("deck-status", (e) => setStatus(e.payload)),
      listen<string>("deck-error", (e) => showToast(e.payload)),
      listen<WindowApp>("foreground-app", (e) => setForeground(e.payload)),
      listen<{ id: string; running: boolean; error: string | null }>("macro-state", (e) => {
        const { id, running, error } = e.payload;
        setRunningMacros((prev) => {
          const next = new Set(prev);
          if (running) next.add(id);
          else next.delete(id);
          return next;
        });
        if (error) showToast(`マクロが止まりました: ${error}`);
      }),
      listen<string>("shortcut", (e) => runShortcut.current(e.payload)),
      listen<PluginButtonState>("plugin-state", (e) => {
        const { context, ...patch } = e.payload;
        // 外部 URL を読み込ませない（CSP でも止めているが、表示側でも data: URL だけにする）
        if (typeof patch.icon === "string" && !patch.icon.startsWith("data:image/")) patch.icon = null;
        setPluginStates((prev) => ({ ...prev, [context]: { ...prev[context], ...patch, context } }));
      }),
      listen<{ context: string; message: string }>("plugin-alert", (e) => {
        showToast(e.payload.message);
        if (e.payload.context) {
          setFlash({ id: e.payload.context, ok: false });
          window.setTimeout(() => setFlash(null), 350);
        }
      }),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [showToast]);

  const refreshStates = useCallback(() => api.getStates().then(setStates).catch(() => {}), []);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const hasNowPlaying = !!deck?.pages.some((p) => p.buttons.some((b) => b.action.type === "now_playing"));
  useEffect(() => {
    if (!hasNowPlaying) return;
    const load = () => api.getNowPlaying().then(setNowPlaying).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [hasNowPlaying]);
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

  const entries = useMemo(() => (deck ? shortcutEntries(deck) : null), [deck]);
  const entriesKey = JSON.stringify(entries?.map((e) => [e.id, e.keys]));
  useEffect(() => {
    if (!entries) return;
    api.setShortcuts(entries.map(({ id, keys }) => ({ id, keys }))).then((results) => {
      const errors: Record<string, string> = {};
      for (const r of results) if (r.error) errors[r.id] = r.error;
      setShortcutErrors(errors);
      const failed = entries.filter((e) => errors[e.id]).map((e) => e.label);
      if (failed.length) showToast(`登録できなかったショートカットがあります: ${failed.join("、")}`);
    });
    // ショートカットの中身が変わったときだけ登録し直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey]);

  const pluginButtons = useMemo(
    () =>
      deck?.pages.flatMap((p) =>
        p.buttons.flatMap((b) =>
          b.action.type === "plugin" ? [{ pluginId: b.action.pluginId, context: b.id, action: b.action.actionId, settings: b.action.settings }] : [],
        ),
      ) ?? null,
    [deck],
  );
  const pluginButtonsKey = JSON.stringify(pluginButtons);
  const sentPluginButtons = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!pluginButtons) return;
    api.setPluginButtons(pluginButtons);
    // 設定が変わったボタンや、プラグイン以外の操作になったボタンには、古い表示を残さない（プラグインが送り直す）
    const next = new Map(pluginButtons.map((b) => [b.context, JSON.stringify(b)]));
    const prev = sentPluginButtons.current;
    const stale = [...prev.keys()].filter((id) => next.get(id) !== prev.get(id));
    sentPluginButtons.current = next;
    if (stale.length) setPluginStates((s) => Object.fromEntries(Object.entries(s).filter(([id]) => !stale.includes(id))));
    // 中身が変わったときだけ送る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginButtonsKey]);

  // 止まったプラグインのボタンは、プラグインが送った表示をやめて、ボタン自身の設定に戻す
  useEffect(() => {
    const un = listen("plugins-changed", async () => {
      const running = new Set((await api.listPlugins()).filter((p) => p.status === "running").map((p) => p.id));
      const stopped = new Set((pluginButtons ?? []).filter((b) => !running.has(b.pluginId)).map((b) => b.context));
      if (stopped.size) setPluginStates((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !stopped.has(id))));
    });
    return () => {
      un.then((f) => f());
    };
  }, [pluginButtons]);

  // 通常時はフォーカスを奪わないようにし、編集中だけキーボード入力を受け付ける
  useEffect(() => {
    // 設定画面にもショートカットの記録欄があるので、開いている間はキー入力を受け付ける
    api.setFocusable(editing || overlay === "settings");
    if (!editing) setMoving(null);
  }, [editing, overlay, status.active]);

  const roots = useMemo(() => deck?.pages.filter((p) => !p.folder) ?? [], [deck]);
  const page = useMemo(() => {
    if (!deck) return null;
    const id = stack[stack.length - 1];
    return deck.pages.find((p) => p.id === id) ?? roots[0] ?? null;
  }, [deck, stack, roots]);

  // 押している間にページが切り替わるとボタンが消えて pointerup が届かないので、ここで離す
  useEffect(
    () => () => {
      const p = press.current;
      if (!p) return;
      press.current = null;
      setPressed(null);
      stopPress(p);
    },
    [page?.id, editing],
  );

  useEffect(() => {
    if (!deck || !foreground || editing || deck.autoSwitch === false) return;
    const current = stack.length ? stack : roots[0] ? [roots[0].id] : [];
    const currentId = current[current.length - 1];
    const target = deck.pages.find((p) => !p.folder && p.apps?.includes(foreground.name));
    const auto = autoSwitched.current;
    if (target) {
      if (target.id === currentId) return;
      // 自動切替先から別の自動切替先へ移るときは、最初の戻り先を引き継ぐ
      const returnTo = auto && auto.page === currentId ? auto.returnTo : current;
      autoSwitched.current = { page: target.id, returnTo };
      setStack([target.id]);
    } else if (auto) {
      // 自動で切り替えたページのままなら元に戻す（自分でページを移動していたらそのまま）
      if (auto.page === currentId) setStack(auto.returnTo);
      autoSwitched.current = null;
    }
    // 前面のアプリが変わったときだけ判定する（ページ移動では再判定しない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreground]);

  if (!deck || !page) return null;

  const updatePage = (pageId: string, fn: (p: Page) => Page, extra: (d: DeckData) => DeckData = (d) => d) =>
    commit(extra({ ...deck, pages: deck.pages.map((p) => (p.id === pageId ? fn(p) : p)) }));

  /** `runId` はマクロの実行・停止やプラグインの識別に使う。長押しの操作はボタンとは別の id で動かす */
  const run = async (b: DeckButton, a: Action = b.action, runId = b.id, quiet = false) => {
    if (a.type === "now_playing") {
      a = { type: "media", command: "play_pause" };
      window.setTimeout(() => api.getNowPlaying().then(setNowPlaying).catch(() => {}), 300);
    }
    if (a.type === "page") {
      if (deck.pages.some((p) => p.id === a.pageId)) setStack([...stack, a.pageId]);
      else showToast("フォルダが見つかりません");
      return;
    }
    if (a.type === "system_panel") return setOverlay("system");
    if (a.type === "timer") {
      tapTimer(b.id, a);
      return true;
    }
    if (a.type === "sound") {
      if (sounds.has(runId) && a.retap !== "overlap") {
        stopSounds(runId);
        if (a.retap === "stop") return true;
      }
      try {
        await playSound(runId, a.path, a.volume);
        return true;
      } catch (e) {
        setFlash({ id: b.id, ok: false });
        window.setTimeout(() => setFlash(null), 350);
        showToast(String(e));
        return false;
      }
    }
    if (!runsInBackend(a)) return;
    if (a.type === "system" && CONFIRM_SYSTEM.includes(a.command)) {
      const c = confirming.current;
      if (!c || c.id !== runId || Date.now() - c.at > CONFIRM_MS) {
        confirming.current = { id: runId, at: Date.now() };
        showToast(`もう一度タップすると${SYSTEM_LABELS[a.command]}します`);
        return false;
      }
      confirming.current = null;
    }
    let ok = true;
    try {
      const msg = await api.runAction(a, runId);
      setFlash({ id: b.id, ok: true });
      if (msg && !quiet) showToast(msg);
    } catch (e) {
      ok = false;
      setFlash({ id: b.id, ok: false });
      showToast(String(e));
    }
    window.setTimeout(() => setFlash(null), 350);
    window.setTimeout(refreshStates, 300);
    return ok;
  };

  const tapTimer = (id: string, a: Extract<Action, { type: "timer" }>) => {
    if (a.sound && !audio.current) audio.current = new AudioContext();
    void audio.current?.resume();
    const t = Date.now();
    setNow(t);
    setTimers((prev) => {
      const cur = prev[id];
      const next = { ...prev };
      if (a.mode === "timer") {
        if (cur) delete next[id];
        else next[id] = { startedAt: t, elapsed: 0, durationMs: a.seconds * 1000, done: false, sound: a.sound };
      } else if (!cur) {
        next[id] = { startedAt: t, elapsed: 0, durationMs: null, done: false, sound: false };
      } else if (cur.startedAt !== null) {
        next[id] = { ...cur, startedAt: null, elapsed: timerElapsed(cur, t) };
      } else {
        delete next[id];
      }
      return next;
    });
  };

  const isOn = (b: DeckButton) => !!b.toggle && canToggle(b.action) && toggled.has(b.id);

  /** トグルボタンは、操作に成功したときだけオンとオフを切り替える */
  const tap = async (b: DeckButton) => {
    if (!b.toggle || !canToggle(b.action)) return void run(b);
    const on = toggled.has(b.id);
    const ok = await run(b, on ? b.toggle.action : b.action, on ? `${b.id}:toggle` : b.id);
    if (!ok) return;
    setToggled((prev) => {
      const next = new Set(prev);
      if (on) next.delete(b.id);
      else next.add(b.id);
      return next;
    });
  };

  runShortcut.current = (id: string) => {
    for (const p of deck.pages) {
      const b = p.buttons.find((x) => x.id === id);
      if (b) return void tap(b);
    }
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

  const placeClone = (source: DeckButton, sourcePages: Page[], slot: number) => {
    const { button, pages: added } = cloneButton(source, sourcePages, slot);
    updatePage(
      page.id,
      (p) => ({ ...p, buttons: [...p.buttons, button] }),
      (d) => ({ ...d, pages: [...d.pages, ...added] }),
    );
  };

  const duplicate = (b: DeckButton) => {
    const slot = firstEmptySlot(page, deck.columns * deck.rows, b.slot + 1);
    if (slot === null) return showToast("このページに空きがないため複製できません");
    placeClone(b, deck.pages, slot);
    setEditor(null);
  };

  const copy = (b: DeckButton) => {
    // コピー元があとで変更・削除されても貼り付けられるよう、この時点の内容を保持する
    setClipboard({ button: structuredClone(b), pages: structuredClone(deck.pages) });
    setEditor(null);
  };

  const pressStart = (e: React.PointerEvent<HTMLButtonElement>, b: DeckButton) => {
    const hold = b.hold;
    if (editing || !hold || press.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p: Press = { id: b.id, timers: [], intervals: [], fired: false };
    press.current = p;
    setPressed(b.id);
    if (hold.type === "repeat") {
      p.fired = true;
      run(b);
      p.timers.push(window.setTimeout(() => p.intervals.push(window.setInterval(() => run(b, b.action, b.id, true), hold.intervalMs)), REPEAT_DELAY_MS));
    } else if (hold.type === "press" && b.action.type === "hotkey") {
      const keys = b.action.keys;
      p.fired = true;
      api.pressKeys(keys).catch((err) => showToast(String(err)));
      p.release = () => void api.releaseKeys(keys).catch(() => {});
    } else if (hold.type === "action") {
      p.timers.push(
        window.setTimeout(() => {
          p.fired = true;
          run(b, hold.action, `${b.id}:hold`);
        }, HOLD_MS),
      );
    }
  };

  /** `cancelled` なら、まだ何も実行していなくてもタップとして扱わない */
  const pressEnd = (b: DeckButton, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== b.id) return;
    press.current = null;
    setPressed(null);
    stopPress(p);
    if (!p.fired && !cancelled) run(b);
  };

  const tapSlot = (slot: number, b?: DeckButton) => {
    // 長押しを設定したボタンは pointer イベントで処理する
    if (!editing) return b && !b.hold && tap(b);
    if (moving) return moveTo(slot);
    if (!b && clipboard) return placeClone(clipboard.button, clipboard.pages, slot);
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

  const addPage = () => {
    const p: Page = { id: uid(), name: `ページ ${roots.length + 1}`, folder: false, buttons: [] };
    commit({ ...deck, pages: [...deck.pages, p] });
    setStack([p.id]);
  };

  const tapTab = (p: Page) => {
    if (editing && p.id === page.id) return setPageEdit(p);
    setStack([p.id]);
  };

  const subFor = (b: DeckButton) => {
    const a = b.action;
    if (editing && shortcutErrors[b.id]) return "⚠ ショートカット";
    const ps = a.type === "plugin" ? pluginStates[b.id] : undefined;
    if (ps?.sub) return ps.sub;
    if (a.type === "mic_mute" && states.micMuted) return "ミュート中";
    if (a.type === "now_playing") return nowPlaying ? `${nowPlaying.playing ? "" : "⏸ "}${nowPlaying.artist}` : "再生していません";
    if (a.type === "audio_device" && a.deviceIds.length !== 1) return outputs.find((d) => d.id === states.defaultOutput)?.name ?? null;
    if (a.type === "page") return "📁";
    if (a.type === "macro") return runningMacros.has(b.id) ? "実行中…" : null;
    if (a.type === "timer") {
      const t = timers[b.id];
      if (a.mode === "stopwatch") return formatDuration(t ? timerElapsed(t, now) : 0, true);
      if (t?.done) return "時間です";
      return formatDuration(t ? Math.ceil(((t.durationMs ?? 0) - timerElapsed(t, now)) / 1000) * 1000 : a.seconds * 1000);
    }
    return null;
  };
  const overrideFor = (b: DeckButton) => {
    if (b.action.type === "plugin") return pluginStates[b.id];
    if (b.action.type === "now_playing" && nowPlaying) return { title: nowPlaying.title, icon: nowPlaying.thumbnail };
  };
  const classFor = (b: DeckButton) => {
    const a = b.action;
    const c = ["key"];
    if (a.type === "mic_mute" && states.micMuted) c.push("alert");
    if (a.type === "now_playing") c.push("now-playing");
    if (a.type === "audio_device" && a.deviceIds.length === 1 && a.deviceIds[0] === states.defaultOutput) c.push("active");
    if (flash?.id === b.id) c.push(flash.ok ? "fired" : "failed");
    if (moving === b.id) c.push("moving");
    if (pressed === b.id) c.push("pressed");
    if (isOn(b)) c.push("active");
    if (runningMacros.has(b.id)) c.push("running");
    if (a.type === "timer" && timers[b.id]?.startedAt != null) c.push("running");
    if (a.type === "timer" && timers[b.id]?.done) c.push("blink");
    if (sounds.has(b.id) || sounds.has(`${b.id}:hold`)) c.push("running");
    const ps = a.type === "plugin" ? pluginStates[b.id] : undefined;
    if (ps?.state === "active") c.push("active");
    if (ps?.state === "alert") c.push("alert");
    return c.join(" ");
  };

  const slots = deck.columns * deck.rows;
  const bySlot = new Map(page.buttons.map((b) => [b.slot, b]));

  return (
    <div className={`app ${editing ? "is-editing" : ""} ${deck.monoEmoji ? "mono-emoji" : ""}`}>
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
                {!!p.apps?.length && deck.autoSwitch !== false && <span className="auto-mark" title="自動切替あり">⚡</span>}
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
          {moving ? (
            "移動先をタップしてください（ボタンがある場所なら入れ替わります）"
          ) : clipboard ? (
            <>
              <span>
                コピー中:「{clipboard.button.label || "（名前なし）"}」 空いている場所をタップすると貼り付けます（ほかのページにも貼り付けられます）
              </span>
              <button className="hint-action" onClick={() => setClipboard(null)}>
                コピーを解除
              </button>
            </>
          ) : (
            "ボタンをタップして編集、空いている場所をタップして追加。タブをもう一度タップすると名前を変えられます。"
          )}
        </div>
      )}

      <main className="grid" style={{ gridTemplateColumns: `repeat(${deck.columns}, 1fr)`, gridTemplateRows: `repeat(${deck.rows}, 1fr)` }}>
        {Array.from({ length: slots }, (_, slot) => {
          const b = bySlot.get(slot);
          if (!b) {
            return (
              <button key={`empty-${slot}`} className={`key empty ${editing ? "editable" : ""}`} onClick={() => tapSlot(slot)} disabled={!editing}>
                {editing && <span className="plus">{clipboard && !moving ? "📋" : "＋"}</span>}
              </button>
            );
          }
          const face = isOn(b) ? toggledFace(b) : b;
          return (
            <button
              key={b.id}
              className={classFor(b)}
              style={face.color ? { background: face.color } : undefined}
              onClick={() => tapSlot(slot, b)}
              onPointerDown={(e) => pressStart(e, b)}
              onPointerUp={() => pressEnd(b, false)}
              onPointerCancel={() => pressEnd(b, true)}
              onLostPointerCapture={() => pressEnd(b, true)}
            >
              <ButtonFace button={face} sub={subFor(b)} override={overrideFor(b)} />
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
          onDuplicate={() => duplicate(editor.button)}
          onCopy={() => copy(editor.button)}
          shortcutError={shortcutErrors[editor.button.id] ?? null}
          shortcutUserOf={(keys) => shortcutUser(deck, keys, editor.button.id)}
          onClose={() => setEditor(null)}
          onError={showToast}
        />
      )}

      {pageEdit && (
        <PageEditor
          page={pageEdit}
          canDelete={pageEdit.folder || roots.length > 1}
          lastApp={foreground}
          onClose={() => setPageEdit(null)}
          onSave={(name, apps) => {
            const id = pageEdit.id;
            commit({
              ...deck,
              pages: deck.pages.map((p) =>
                p.id === id
                  ? { ...p, name, apps: p.folder ? undefined : apps }
                  : // 同じアプリは 1 つのページにだけ登録する
                    { ...p, apps: p.apps?.filter((a) => !apps.includes(a)) },
              ),
            });
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
          toggleShortcutError={shortcutErrors[TOGGLE_SHORTCUT_ID] ?? null}
          shortcutUserOf={(keys) => shortcutUser(deck, keys, TOGGLE_SHORTCUT_ID)}
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
