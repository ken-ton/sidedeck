// デッキ（ページとボタン）のデータ構造と、関連するヘルパー。

export type Icon = { kind: "emoji"; value: string } | { kind: "image"; src: string } | null;

export type MediaCommand = "play_pause" | "next" | "prev" | "stop" | "volume_up" | "volume_down" | "mute";

export type Action =
  | { type: "none" }
  | { type: "launch"; target: string; args: string }
  | { type: "hotkey"; keys: string[] }
  | { type: "text"; text: string }
  | { type: "media"; command: MediaCommand }
  | { type: "mic_mute" }
  | { type: "audio_device"; deviceIds: string[] }
  | { type: "page"; pageId: string }
  | { type: "system_panel" };

export type ActionType = Action["type"];

export type DeckButton = {
  id: string;
  /** グリッド上の位置（左上から 0, 1, 2, …） */
  slot: number;
  label: string;
  icon: Icon;
  color: string | null;
  action: Action;
};

export type Page = {
  id: string;
  name: string;
  /** true ならフォルダ（タブには出さず、ボタンから開く） */
  folder: boolean;
  buttons: DeckButton[];
  /** このアプリ（小文字のプロセス名）が前面に来たら、このページに自動で切り替える */
  apps?: string[];
};

export type DeckData = {
  version: 1;
  columns: number;
  rows: number;
  pages: Page[];
  /** 前面のアプリに合わせてページを自動で切り替える（未設定なら有効） */
  autoSwitch?: boolean;
};

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
};

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
    default:
      return { type } as Action;
  }
}

/** Rust 側で実行する操作か（false ならフロントエンドで処理する） */
export const runsInBackend = (a: Action) => !["none", "page", "system_panel"].includes(a.type);

const btn = (slot: number, label: string, emoji: string, action: Action, color: string | null = null): DeckButton => ({
  id: uid(),
  slot,
  label,
  icon: { kind: "emoji", value: emoji },
  color,
  action,
});

/** 初回起動時のデッキ */
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

// ---------------------------------------------------------------- キー

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

/** KeyboardEvent から（修飾キー以外の）キー名を得る。修飾キーだけなら null。 */
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

/** "ctrl+shift+s" のような文字列を分解する */
export const parseKeys = (s: string) =>
  s
    .split("+")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
