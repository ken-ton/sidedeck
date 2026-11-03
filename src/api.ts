import { invoke } from "@tauri-apps/api/core";

export type MonitorInfo = {
  gdiName: string;
  friendlyName: string;
  devicePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  refresh: number;
  primary: boolean;
};

export type CustomGame = { id: string; title: string; path: string };

export type Config = {
  deckMonitor: string | null;
  deckMonitorName: string | null;
  autoDeck: boolean;
  moveGameWindows: boolean;
  customGames: CustomGame[];
};

export type Game = {
  id: string;
  title: string;
  source: "steam" | "epic" | "custom";
  launch: string;
  art: string | null;
};

export type DeckStatus = { active: boolean; monitorConnected: boolean };
export type Volume = { level: number; muted: boolean };
export type Brightness = { method: "ddc" | "gamma"; value: number; min: number };
export type DisplayMode = { width: number; height: number; refresh: number };
export type PowerPlan = { id: string; name: string; active: boolean };

export const api = {
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
  getConfig: () => invoke<Config>("get_config"),
  setDeckMonitor: (devicePath: string, name: string) => invoke<void>("set_deck_monitor", { devicePath, name }),
  setAutoDeck: (enabled: boolean) => invoke<void>("set_auto_deck", { enabled }),
  setMoveGameWindows: (enabled: boolean) => invoke<void>("set_move_game_windows", { enabled }),
  addCustomGame: (title: string, path: string) => invoke<void>("add_custom_game", { title, path }),
  removeCustomGame: (id: string) => invoke<void>("remove_custom_game", { id }),
  listGames: () => invoke<Game[]>("list_games"),
  launchGame: (id: string) => invoke<void>("launch_game", { id }),
  deckStatus: () => invoke<DeckStatus>("deck_status"),
  deckEnter: () => invoke<void>("deck_enter"),
  deckExit: () => invoke<void>("deck_exit"),
  showHome: () => invoke<void>("show_home"),
  quickSetExpanded: (expanded: boolean) => invoke<void>("quick_set_expanded", { expanded }),
  getVolume: () => invoke<Volume>("get_volume"),
  setVolume: (level: number) => invoke<void>("set_volume", { level }),
  setMute: (muted: boolean) => invoke<void>("set_mute", { muted }),
  getBrightness: () => invoke<Brightness>("get_brightness"),
  setBrightness: (value: number) => invoke<void>("set_brightness", { value }),
  listModes: () => invoke<{ current: DisplayMode; modes: DisplayMode[] }>("list_modes"),
  setMode: (mode: DisplayMode) => invoke<void>("set_mode", { mode }),
  listPowerPlans: () => invoke<PowerPlan[]>("list_power_plans"),
  setPowerPlan: (id: string) => invoke<void>("set_power_plan", { id }),
  openTouchSetup: () => invoke<void>("open_touch_setup"),
};

/** 連続したスライダー操作をまとめて送る */
export function throttle<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  let last = 0;
  let timer: number | undefined;
  return (...a: T) => {
    const now = Date.now();
    window.clearTimeout(timer);
    if (now - last >= ms) {
      last = now;
      fn(...a);
    } else {
      timer = window.setTimeout(() => {
        last = Date.now();
        fn(...a);
      }, ms);
    }
  };
}
