export type Icon = { kind: "emoji"; value: string } | { kind: "image"; src: string } | null;

export type MediaCommand = "play_pause" | "next" | "prev" | "stop" | "volume_up" | "volume_down" | "mute";

export type WindowCommand = "focus" | "move_next" | "move_to" | "maximize" | "minimize";

export type SystemCommand = "lock" | "sleep" | "monitor_off" | "empty_recycle_bin" | "screenshot" | "snip" | "sign_out" | "restart" | "shutdown";

export type MacroStep =
  | { type: "keys"; keys: string[] }
  | { type: "key_down"; keys: string[] }
  | { type: "key_up"; keys: string[] }
  | { type: "text"; text: string }
  | { type: "wait"; ms: number }
  | { type: "action"; action: Action };

export type Action =
  | { type: "none" }
  | { type: "launch"; target: string; args: string }
  | { type: "hotkey"; keys: string[] }
  | { type: "text"; text: string }
  | { type: "media"; command: MediaCommand }
  | { type: "mic_mute" }
  | { type: "now_playing" }
  | { type: "audio_device"; deviceIds: string[] }
  | { type: "page"; pageId: string }
  | { type: "system_panel" }
  | { type: "system"; command: SystemCommand }
  /** seconds はタイマーの長さ（ストップウォッチでは使わない） */
  | { type: "timer"; mode: "timer" | "stopwatch"; seconds: number; sound: boolean }
  | { type: "sound"; path: string; volume: number; retap: SoundRetap }
  | { type: "obs"; command: ObsCommand; scene: string; input: string }
  /** repeat が 0 なら停止されるまで繰り返す */
  | { type: "macro"; steps: MacroStep[]; repeat: number }
  /** app は小文字のプロセス名、monitor はモニターのデバイスパス */
  | { type: "window"; command: WindowCommand; app: string; launch: string; monitor: string }
  | { type: "plugin"; pluginId: string; actionId: string; settings: Record<string, unknown> };

export type ActionType = Action["type"];

export type DeckButton = {
  id: string;
  /** 左上から 0, 1, 2, … */
  slot: number;
  label: string;
  icon: Icon;
  color: string | null;
  action: Action;
  /** 長押ししたときの動作。未設定ならタップと同じ */
  hold?: Hold;
  /** オン状態の見た目と、オンのときにタップしたら実行する操作 */
  toggle?: ToggleState;
  /** グローバルショートカット（例: ["ctrl", "alt", "m"]） */
  shortcut?: string[];
  /** 時刻や PC の使用率をボタンに表示する */
  info?: InfoKind;
  /** 未指定は 1×1。slot は左上のマス */
  size?: ButtonSize;
};

export type ButtonSize = "1x1" | "2x1" | "1x2" | "2x2";
export const BUTTON_SIZES: ButtonSize[] = ["1x1", "2x1", "1x2", "2x2"];
export const SIZE_LABELS: Record<ButtonSize, string> = { "1x1": "1×1", "2x1": "横 2×1", "1x2": "縦 1×2", "2x2": "2×2" };

export const sizeOf = (size: ButtonSize | undefined) => {
  const [w, h] = (size ?? "1x1").split("x").map(Number);
  return { w, h };
};

/** ボタンが占めるマス。グリッドからはみ出すときは null */
export function cellsOf(slot: number, size: ButtonSize | undefined, columns: number, rows: number): number[] | null {
  const { w, h } = sizeOf(size);
  const col = slot % columns;
  const row = Math.floor(slot / columns);
  if (col + w > columns || row + h > rows) return null;
  const cells: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push((row + y) * columns + col + x);
  return cells;
}

/** マス → そのマスを占めるボタン */
export function occupancy(buttons: DeckButton[], columns: number, rows: number, ignore?: string): Map<number, DeckButton> {
  const m = new Map<number, DeckButton>();
  for (const b of buttons) {
    if (b.id === ignore) continue;
    for (const c of cellsOf(b.slot, b.size, columns, rows) ?? [b.slot]) m.set(c, b);
  }
  return m;
}

export function fits(page: Page, columns: number, rows: number, slot: number, size: ButtonSize | undefined, ignore?: string) {
  const cells = cellsOf(slot, size, columns, rows);
  if (!cells) return false;
  const used = occupancy(page.buttons, columns, rows, ignore);
  return cells.every((c) => !used.has(c));
}

/** グリッドの大きさを変えたときに、はみ出すか重なるボタンの数 */
export function misplacedButtons(page: Page, columns: number, rows: number): number {
  const used = new Set<number>();
  let n = 0;
  for (const b of page.buttons) {
    const cells = cellsOf(b.slot, b.size, columns, rows);
    if (!cells || cells.some((c) => used.has(c))) n++;
    cells?.forEach((c) => used.add(c));
  }
  return n;
}

export type InfoKind = "time" | "time_seconds" | "date" | "cpu" | "memory" | "gpu";

export const INFO_LABELS: Record<InfoKind, string> = {
  time: "時刻",
  time_seconds: "時刻（秒まで）",
  date: "日付",
  cpu: "CPU 使用率",
  memory: "メモリ使用率",
  gpu: "GPU 使用率",
};

export const STATS_INFO: InfoKind[] = ["cpu", "memory", "gpu"];

export type Stats = { cpu: number | null; memory: number | null; gpu: number | null };

export const WEEKDAYS = "日月火水木金土";

export function formatInfo(kind: InfoKind, now: Date, stats: Stats | null): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const pct = (label: string, v: number | null | undefined) => `${label} ${v == null ? "--" : Math.round(v)}%`;
  switch (kind) {
    case "time":
      return `${now.getHours()}:${pad(now.getMinutes())}`;
    case "time_seconds":
      return `${now.getHours()}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    case "date":
      return `${now.getMonth() + 1}/${now.getDate()}（${WEEKDAYS[now.getDay()]}）`;
    case "cpu":
      return pct("CPU", stats?.cpu);
    case "memory":
      return pct("メモリ", stats?.memory);
    case "gpu":
      return pct("GPU", stats?.gpu);
  }
}

export type Hold =
  | { type: "repeat"; intervalMs: number }
  /** ショートカットキーの操作でだけ使う */
  | { type: "press" }
  | { type: "action"; action: Action };

export type HoldType = Hold["type"];

/** label・icon・color が空なら、オフ状態のものを使う */
export type ToggleState = { label: string; icon: Icon; color: string | null; action: Action };

/** それ自体が状態を持つ操作や、画面内で完結する操作はトグルにしない */
const NO_TOGGLE: ActionType[] = ["page", "system_panel", "macro", "plugin", "mic_mute", "system", "timer", "sound", "now_playing", "obs"];

export const canToggle = (a: Action) => !NO_TOGGLE.includes(a.type);

export const toggledFace = (b: DeckButton): DeckButton =>
  b.toggle ? { ...b, label: b.toggle.label || b.label, icon: b.toggle.icon ?? b.icon, color: b.toggle.color ?? b.color } : b;

export const HOLD_LABELS: Record<HoldType, string> = {
  repeat: "連打",
  press: "押している間押し続ける",
  action: "別の操作",
};

export const REPEAT_INTERVALS = [50, 100, 200, 500];

/** 長押しで「別の操作」に選べない種類。フォルダは作成処理が絡み、プラグインはボタンごとの状態と結び付いているため */
export const HOLD_ACTION_EXCLUDE: ActionType[] = ["page", "plugin", "timer"];

/** 連打できない種類（繰り返すと開閉や開始・停止を往復してしまう） */
const NO_REPEAT: ActionType[] = ["page", "system_panel", "macro", "system", "timer", "sound", "now_playing", "obs"];

export function holdTypesFor(action: Action): HoldType[] {
  const types: HoldType[] = [];
  if (!NO_REPEAT.includes(action.type)) types.push("repeat");
  if (action.type === "hotkey") types.push("press");
  types.push("action");
  return types;
}

export type Page = {
  id: string;
  name: string;
  /** フォルダはタブに出さず、ボタンから開く */
  folder: boolean;
  buttons: DeckButton[];
  /** 小文字のプロセス名。前面に来たらこのページに自動で切り替える */
  apps?: string[];
};

export type DeckData = {
  version: 1;
  columns: number;
  rows: number;
  pages: Page[];
  /** 未設定なら有効 */
  autoSwitch?: boolean;
  /** 絵文字のアイコンを白黒で表示する */
  monoEmoji?: boolean;
  automations?: Automation[];
  /** OBS 連携（obs-websocket）。パスワードは config.json に平文で保存する */
  obs?: { enabled: boolean; url: string; password: string };
  /** デッキを前面に出す／下げるショートカット。未設定なら DEFAULT_TOGGLE_SHORTCUT、空配列なら無効 */
  toggleShortcut?: string[];
};

export type ObsEvent = "record_start" | "record_stop" | "stream_start" | "stream_stop";

export type Trigger =
  | { type: "app_focus"; app: string }
  | { type: "app_blur"; app: string }
  /** time は "HH:MM"、days は 0（日）〜 6（土）。空なら毎日 */
  | { type: "time"; time: string; days: number[] }
  | { type: "startup" }
  | { type: "deck_enter" }
  | { type: "deck_exit" }
  | { type: "obs"; event: ObsEvent };

export type TriggerType = Trigger["type"];

export type Automation = { id: string; name: string; enabled: boolean; trigger: Trigger; action: Action };

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  app_focus: "アプリが前面に来たとき",
  app_blur: "アプリから離れたとき",
  time: "決まった時刻",
  startup: "SideDeck の起動時",
  deck_enter: "Deck モードの開始時",
  deck_exit: "Deck モードの終了時",
  obs: "OBS の録画・配信",
};

export const OBS_EVENT_LABELS: Record<ObsEvent, string> = {
  record_start: "録画を開始したとき",
  record_stop: "録画を停止したとき",
  stream_start: "配信を開始したとき",
  stream_stop: "配信を終了したとき",
};

/** ボタンがないと意味をなさない操作は、自動化では選べない */
export const AUTOMATION_EXCLUDE: ActionType[] = ["page", "system_panel", "timer"];

export function emptyTrigger(type: TriggerType): Trigger {
  switch (type) {
    case "app_focus":
    case "app_blur":
      return { type, app: "" };
    case "time":
      return { type, time: "09:00", days: [] };
    case "obs":
      return { type, event: "record_start" };
    default:
      return { type };
  }
}

export function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case "app_focus":
      return `${t.app} が前面に来たとき`;
    case "app_blur":
      return `${t.app} から離れたとき`;
    case "time":
      return `${t.days.length ? t.days.map((d) => WEEKDAYS[d]).join("・") : "毎日"} ${t.time}`;
    case "obs":
      return `OBS で${OBS_EVENT_LABELS[t.event]}`;
    default:
      return TRIGGER_LABELS[t.type];
  }
}

export const DEFAULT_TOGGLE_SHORTCUT = ["ctrl", "alt", "d"];
export const TOGGLE_SHORTCUT_ID = "__toggle__";

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const ACTION_LABELS: Record<ActionType, string> = {
  none: "なし",
  launch: "アプリ・ファイル・URL を開く",
  hotkey: "ショートカットキー",
  text: "文字を入力",
  media: "メディア操作",
  mic_mute: "マイクのミュート",
  now_playing: "再生中の曲",
  audio_device: "出力デバイスの切替",
  page: "フォルダを開く",
  system_panel: "システムパネル",
  system: "PC の操作",
  timer: "タイマー",
  sound: "サウンド",
  macro: "マクロ",
  window: "ウィンドウ操作",
  obs: "OBS",
  plugin: "プラグイン",
};

export const ACTION_GROUPS: { label: string; types: ActionType[] }[] = [
  { label: "開く・移動", types: ["launch", "page", "window"] },
  { label: "キー入力", types: ["hotkey", "text", "macro"] },
  { label: "音声・システム", types: ["media", "now_playing", "mic_mute", "audio_device", "system_panel", "system"] },
  { label: "ツール", types: ["timer", "sound"] },
  { label: "連携", types: ["obs", "plugin"] },
];

export const WINDOW_LABELS: Record<WindowCommand, string> = {
  focus: "アプリを前面に出す",
  move_next: "次のモニターへ移動",
  move_to: "指定のモニターへ移動",
  maximize: "最大化の切替",
  minimize: "最小化",
};

export const SYSTEM_LABELS: Record<SystemCommand, string> = {
  lock: "PC をロック",
  sleep: "スリープ",
  monitor_off: "画面をオフ",
  empty_recycle_bin: "ごみ箱を空にする",
  screenshot: "スクリーンショット（全画面を保存）",
  snip: "画面の切り取り",
  sign_out: "サインアウト",
  restart: "再起動",
  shutdown: "シャットダウン",
};

/** 誤タップを防ぐため、もう一度タップしたら実行する */
export const CONFIRM_SYSTEM: SystemCommand[] = ["sign_out", "restart", "shutdown"];

export type ObsCommand = "scene" | "record" | "record_pause" | "stream" | "virtualcam" | "replay" | "replay_save" | "mute";

export const OBS_LABELS: Record<ObsCommand, string> = {
  scene: "シーンを切り替え",
  record: "録画の開始 / 停止",
  record_pause: "録画の一時停止 / 再開",
  stream: "配信の開始 / 終了",
  virtualcam: "仮想カメラの開始 / 停止",
  replay: "リプレイバッファの開始 / 停止",
  replay_save: "リプレイを保存",
  mute: "音声のミュート",
};

export type SoundRetap = "stop" | "restart" | "overlap";

export const SOUND_RETAP_LABELS: Record<SoundRetap, string> = {
  stop: "止める",
  restart: "最初から再生",
  overlap: "重ねて再生",
};

export const SOUND_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus", "webm"];

export const TIMER_PRESETS = [30, 60, 180, 300, 600];

export const formatDuration = (ms: number, tenths = false) => {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  const t = tenths ? `.${Math.floor((total % 1000) / 100)}` : "";
  return h ? `${h}:${mm}:${ss}${t}` : `${mm}:${ss}${t}`;
};

export const windowAction = (command: WindowCommand): Action => ({ type: "window", command, app: "", launch: "", monitor: "" });

export const MEDIA_LABELS: Record<MediaCommand, string> = {
  play_pause: "再生 / 一時停止",
  next: "次の曲",
  prev: "前の曲",
  stop: "停止",
  volume_up: "音量を上げる",
  volume_down: "音量を下げる",
  mute: "ミュート",
};

export const COLORS: (string | null)[] = [null, "#1a9fff", "#30a46c", "#e5484d", "#f76b15", "#8e4ec6", "#ffb224", "#3e63dd"];

export function emptyAction(type: ActionType): Action {
  switch (type) {
    case "launch":
      return { type, target: "", args: "" };
    case "hotkey":
      return { type, keys: [] };
    case "text":
      return { type, text: "" };
    case "media":
      return { type, command: "play_pause" };
    case "audio_device":
      return { type, deviceIds: [] };
    case "page":
      return { type, pageId: "" };
    case "macro":
      return { type, steps: [], repeat: 1 };
    case "window":
      return windowAction("move_next");
    case "system":
      return { type, command: "lock" };
    case "timer":
      return { type, mode: "timer", seconds: 180, sound: true };
    case "obs":
      return { type, command: "scene", scene: "", input: "" };
    case "sound":
      return { type, path: "", volume: 100, retap: "stop" };
    case "plugin":
      return { type, pluginId: "", actionId: "", settings: {} };
    default:
      return { type } as Action;
  }
}

export const runsInBackend = (a: Action) => !["none", "page", "system_panel", "timer", "sound", "obs"].includes(a.type);

const btn = (slot: number, label: string, emoji: string, action: Action, color: string | null = null): DeckButton => ({
  id: uid(),
  slot,
  label,
  icon: { kind: "emoji", value: emoji },
  color,
  action,
});

export function defaultDeck(): DeckData {
  return {
    version: 1,
    columns: 5,
    rows: 3,
    pages: [
      {
        id: uid(),
        name: "メイン",
        folder: false,
        buttons: [
          btn(0, "前の曲", "⏮", { type: "media", command: "prev" }),
          btn(1, "再生 / 停止", "⏯", { type: "media", command: "play_pause" }, "#1a9fff"),
          btn(2, "次の曲", "⏭", { type: "media", command: "next" }),
          btn(3, "音量 −", "🔉", { type: "media", command: "volume_down" }),
          btn(4, "音量 ＋", "🔊", { type: "media", command: "volume_up" }),
          btn(5, "マイク", "🎙", { type: "mic_mute" }),
          btn(6, "出力切替", "🎧", { type: "audio_device", deviceIds: [] }),
          btn(7, "ミュート", "🔇", { type: "media", command: "mute" }),
          btn(9, "システム", "⚙", { type: "system_panel" }, "#3e63dd"),
          btn(10, "コピー", "📋", { type: "hotkey", keys: ["ctrl", "c"] }),
          btn(11, "貼り付け", "📥", { type: "hotkey", keys: ["ctrl", "v"] }),
          btn(12, "元に戻す", "↩", { type: "hotkey", keys: ["ctrl", "z"] }),
          btn(13, "スクショ", "✂", { type: "hotkey", keys: ["win", "shift", "s"] }),
          btn(14, "デスクトップ", "🖥", { type: "hotkey", keys: ["win", "d"] }),
        ],
      },
    ],
  };
}

const CODE_TO_KEY: Record<string, string> = {
  Space: "space",
  Enter: "enter",
  NumpadEnter: "enter",
  Tab: "tab",
  Escape: "esc",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PrintScreen: "printscreen",
  Pause: "pause",
  CapsLock: "capslock",
  ContextMenu: "contextmenu",
  Minus: "minus",
  Equal: "equal",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  Backquote: "backquote",
  Semicolon: "semicolon",
  Quote: "quote",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Backslash: "backslash",
  IntlRo: "intlro",
};

export const MODIFIERS = ["ctrl", "shift", "alt", "win"] as const;

export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  return CODE_TO_KEY[code] ?? null;
}

const KEY_DISPLAY: Record<string, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  win: "Win",
  space: "Space",
  enter: "Enter",
  esc: "Esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

export const formatKeys = (keys: string[]) =>
  keys.map((k) => KEY_DISPLAY[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join(" + ");

export const parseKeys = (s: string) =>
  s
    .split("+")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

/**
 * ボタンを新しい id で複製する。フォルダを開くボタンは、中身のフォルダごと別のフォルダとして複製する
 * （同じフォルダを共有すると、片方を消したときにもう片方が壊れるため）。
 */
export function cloneButton(b: DeckButton, pages: Page[], slot: number): { button: DeckButton; pages: Page[] } {
  const added: Page[] = [];
  const visiting = new Set<string>();
  const cloneFolder = (pageId: string): string => {
    const src = pages.find((p) => p.id === pageId && p.folder);
    if (!src || visiting.has(pageId)) return pageId;
    visiting.add(pageId);
    const id = uid();
    added.push({ ...src, id, buttons: src.buttons.map(cloneOne) });
    visiting.delete(pageId);
    return id;
  };
  const cloneOne = (x: DeckButton): DeckButton => {
    // ショートカットは複製すると必ず重複するので引き継がない
    const { shortcut: _, ...rest } = structuredClone(x);
    const copy: DeckButton = { ...rest, id: uid() };
    if (x.action.type === "page") copy.action = { type: "page", pageId: cloneFolder(x.action.pageId) };
    return copy;
  };
  return { button: { ...cloneOne(b), slot }, pages: added };
}

/** `from` 以降で最初の空き。なければ先頭から探す */
export function firstEmptySlot(page: Page, columns: number, rows: number, from = 0, size?: ButtonSize): number | null {
  const slots = columns * rows;
  for (let i = 0; i < slots; i++) {
    const s = (from + i) % slots;
    if (fits(page, columns, rows, s, size)) return s;
  }
  return null;
}

/** 押す順に関係なく同じ組み合わせを同じ文字列にする */
export const shortcutKey = (keys: string[]) => {
  const mods = MODIFIERS.filter((m) => keys.includes(m));
  return [...mods, ...keys.filter((k) => !(MODIFIERS as readonly string[]).includes(k))].join("+");
};

export type ShortcutEntry = { id: string; keys: string[]; label: string };

export function shortcutEntries(deck: DeckData): ShortcutEntry[] {
  const toggle = deck.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT;
  const out: ShortcutEntry[] = toggle.length ? [{ id: TOGGLE_SHORTCUT_ID, keys: toggle, label: "デッキを前面に出す" }] : [];
  for (const p of deck.pages) {
    for (const b of p.buttons) {
      if (b.shortcut?.length) out.push({ id: b.id, keys: b.shortcut, label: b.label || ACTION_LABELS[b.action.type] });
    }
  }
  return out;
}

/** `keys` をすでに使っている、`selfId` 以外のショートカットの名前 */
export function shortcutUser(deck: DeckData, keys: string[] | undefined, selfId: string): string | null {
  if (!keys?.length) return null;
  const k = shortcutKey(keys);
  return shortcutEntries(deck).find((e) => e.id !== selfId && shortcutKey(e.keys) === k)?.label ?? null;
}

/**
 * どのページからも辿れなくなったフォルダを消す。入れ子のフォルダの中身が孤立したまま残ると、
 * 画面からは消えたのにショートカットだけが登録され続けるため。
 */
export function pruneOrphanFolders(deck: DeckData): DeckData {
  const byId = new Map(deck.pages.map((p) => [p.id, p]));
  const reachable = new Set<string>();
  const stack = deck.pages.filter((p) => !p.folder).map((p) => p.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const b of byId.get(id)?.buttons ?? []) {
      if (b.action.type === "page" && byId.has(b.action.pageId)) stack.push(b.action.pageId);
    }
  }
  if (reachable.size === deck.pages.length) return deck;
  return { ...deck, pages: deck.pages.filter((p) => reachable.has(p.id)) };
}
