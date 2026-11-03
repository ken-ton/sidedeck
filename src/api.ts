import { invoke } from "@tauri-apps/api/core";
import type { Action, DeckData } from "./deck";

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

export type Config = {
  deckMonitor: string | null;
  deckMonitorName: string | null;
  autoDeck: boolean;
};

export type InstalledGame = { id: string; title: string; source: "steam" | "epic"; launch: string; art: string | null };
export type DeckStatus = { active: boolean; monitorConnected: boolean };
export type States = { micMuted: boolean | null; defaultOutput: string | null };
export type AudioDevice = { id: string; name: string; isDefault: boolean };
export type Volume = { level: number; muted: boolean };
export type Brightness = { method: "ddc" | "gamma"; value: number; min: number };
export type DisplayMode = { width: number; height: number; refresh: number };
export type WindowApp = { name: string; title: string };
export type PowerPlan = { id: string; name: string; active: boolean };

export const api = {
  // 設定
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
  getConfig: () => invoke<Config>("get_config"),
  setDeckMonitor: (devicePath: string, name: string) => invoke<void>("set_deck_monitor", { devicePath, name }),
  setAutoDeck: (enabled: boolean) => invoke<void>("set_auto_deck", { enabled }),
  deckStatus: () => invoke<DeckStatus>("deck_status"),
  deckEnter: () => invoke<void>("deck_enter"),
  deckExit: () => invoke<void>("deck_exit"),
  setFocusable: (focusable: boolean) => invoke<void>("set_focusable", { focusable }),
  openTouchSetup: () => invoke<void>("open_touch_setup"),

  // デッキ
  getDeck: () => invoke<DeckData | null>("get_deck"),
  saveDeck: (deck: DeckData) => invoke<void>("save_deck", { deck }),
  runAction: (action: Action) => invoke<string | null>("run_action", { action }),
  getStates: () => invoke<States>("get_states"),
  listAudioOutputs: () => invoke<AudioDevice[]>("list_audio_outputs"),
  getIcon: (target: string) => invoke<string | null>("get_icon", { target }),
  listInstalledGames: () => invoke<InstalledGame[]>("list_installed_games"),
  getForegroundApp: () => invoke<WindowApp | null>("get_foreground_app"),
  listWindowApps: () => invoke<WindowApp[]>("list_window_apps"),

  // システムパネル
  getVolume: () => invoke<Volume>("get_volume"),
  setVolume: (level: number) => invoke<void>("set_volume", { level }),
  setMute: (muted: boolean) => invoke<void>("set_mute", { muted }),
  getBrightness: () => invoke<Brightness>("get_brightness"),
  setBrightness: (value: number) => invoke<void>("set_brightness", { value }),
  listModes: () => invoke<{ current: DisplayMode; modes: DisplayMode[] }>("list_modes"),
  setMode: (mode: DisplayMode) => invoke<void>("set_mode", { mode }),
  listPowerPlans: () => invoke<PowerPlan[]>("list_power_plans"),
  setPowerPlan: (id: string) => invoke<void>("set_power_plan", { id }),
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
