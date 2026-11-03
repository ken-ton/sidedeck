export type Icon = { kind: "emoji"; value: string } | { kind: "image"; src: string } | null;

export type MediaCommand = "play_pause" | "next" | "prev" | "stop" | "volume_up" | "volume_down" | "mute";

export type WindowCommand = "focus" | "move_next" | "move_to" | "maximize" | "minimize";

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
  | { type: "audio_device"; deviceIds: string[] }
  | { type: "page"; pageId: string }
  | { type: "system_panel" }
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
  /** グローバルショートカット（例: ["ctrl", "alt", "m"]） */
  shortcut?: string[];
};

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
  /** デッキを前面に出す／下げるショートカット。未設定なら DEFAULT_TOGGLE_SHORTCUT、空配列なら無効 */
  toggleShortcut?: string[];
};

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
  audio_device: "出力デバイスの切替",
  page: "フォルダを開く",
  system_panel: "システムパネル",
  macro: "マクロ",
  window: "ウィンドウ操作",
  plugin: "プラグイン",
};

export const WINDOW_LABELS: Record<WindowCommand, string> = {
  focus: "アプリを前面に出す",
  move_next: "次のモニターへ移動",
  move_to: "指定のモニターへ移動",
  maximize: "最大化の切替",
  minimize: "最小化",
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
    case "plugin":
      return { type, pluginId: "", actionId: "", settings: {} };
    default:
      return { type } as Action;
  }
}

export const runsInBackend = (a: Action) => !["none", "page", "system_panel"].includes(a.type);

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
export function firstEmptySlot(page: Page, slots: number, from = 0): number | null {
  const used = new Set(page.buttons.map((b) => b.slot));
  for (let i = 0; i < slots; i++) {
    const s = (from + i) % slots;
    if (!used.has(s)) return s;
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
