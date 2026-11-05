import { invoke } from "@tauri-apps/api/core";
import type { Action, DeckData, MacroStep, Stats } from "./deck";

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
export type StartApp = { name: string; target: string; packaged: boolean };
export type DeckStatus = { active: boolean; monitorConnected: boolean };
export type States = { micMuted: boolean | null; defaultOutput: string | null };
export type AudioDevice = { id: string; name: string; isDefault: boolean };
export type NowPlaying = { title: string; artist: string; playing: boolean; thumbnail: string | null };
export type AppVolume = { key: string; name: string; path: string | null; level: number; muted: boolean };
export type Volume = { level: number; muted: boolean };
export type Brightness = { method: "ddc" | "gamma"; value: number; min: number };
export type DisplayMode = { width: number; height: number; refresh: number };
export type WindowApp = { name: string; title: string };
export type PluginField = {
  key: string;
  label: string;
  type: "text" | "number" | "checkbox" | "select";
  default?: unknown;
  options?: PluginOption[];
  optionsFrom?: string;
  dependsOn?: string[];
};
export type PluginOption = { value: string | number; label: string; group?: string };
export type PluginActionDef = { id: string; name: string; description?: string; fields?: PluginField[] };
export type PluginInfo = {
  id: string;
  name: string;
  version: string;
  status: "starting" | "running" | "stopped" | "error";
  error: string | null;
  actions: PluginActionDef[];
};
export type PluginButtonState = { context: string; title?: string | null; icon?: string | null; sub?: string | null; state?: "normal" | "active" | "alert" | null };
export type PowerPlan = { id: string; name: string; active: boolean };

export const api = {
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
  getConfig: () => invoke<Config>("get_config"),
  setDeckMonitor: (devicePath: string, name: string) => invoke<void>("set_deck_monitor", { devicePath, name }),
  setAutoDeck: (enabled: boolean) => invoke<void>("set_auto_deck", { enabled }),
  deckStatus: () => invoke<DeckStatus>("deck_status"),
  deckEnter: () => invoke<void>("deck_enter"),
  deckExit: () => invoke<void>("deck_exit"),
  setFocusable: (focusable: boolean) => invoke<void>("set_focusable", { focusable }),
  openTouchSetup: () => invoke<void>("open_touch_setup"),
  getAutostart: () => invoke<{ enabled: boolean; devBuild: boolean }>("get_autostart"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),

  getDeck: () => invoke<DeckData | null>("get_deck"),
  saveDeck: (deck: DeckData) => invoke<void>("save_deck", { deck }),
  runAction: (action: Action, buttonId?: string) => invoke<string | null>("run_action", { action, buttonId }),
  pressKeys: (keys: string[]) => invoke<void>("press_keys", { keys }),
  releaseKeys: (keys: string[]) => invoke<void>("release_keys", { keys }),
  setShortcuts: (entries: { id: string; keys: string[] }[]) => invoke<{ id: string; error: string | null }[]>("set_shortcuts", { entries }),
  checkShortcut: (keys: string[]) => invoke<string | null>("check_shortcut", { keys }),
  suspendShortcuts: (suspended: boolean) => invoke<void>("suspend_shortcuts", { suspended }),
  takeStartupWarning: () => invoke<string | null>("take_startup_warning"),
  listPlugins: () => invoke<PluginInfo[]>("list_plugins"),
  pluginGetOptions: (pluginId: string, source: string, settings: Record<string, unknown>) =>
    invoke<PluginOption[]>("plugin_get_options", { pluginId, source, settings }),
  setPluginButtons: (buttons: { pluginId: string; context: string; action: string; settings: Record<string, unknown> }[]) =>
    invoke<void>("set_plugin_buttons", { buttons }),
  reloadPlugins: () => invoke<void>("reload_plugins"),
  openPluginsFolder: () => invoke<void>("open_plugins_folder"),
  startKeyRecording: () => invoke<void>("start_key_recording"),
  stopKeyRecording: (keepTiming: boolean) => invoke<MacroStep[]>("stop_key_recording", { keepTiming }),
  getStats: () => invoke<Stats>("get_stats"),
  getNowPlaying: () => invoke<NowPlaying | null>("get_now_playing"),
  getStates: () => invoke<States>("get_states"),
  listAudioOutputs: () => invoke<AudioDevice[]>("list_audio_outputs"),
  getIcon: (target: string) => invoke<string | null>("get_icon", { target }),
  listInstalledGames: () => invoke<InstalledGame[]>("list_installed_games"),
  listStartApps: () => invoke<StartApp[]>("list_start_apps"),
  getForegroundApp: () => invoke<WindowApp | null>("get_foreground_app"),
  listWindowApps: () => invoke<WindowApp[]>("list_window_apps"),

  getVolume: () => invoke<Volume>("get_volume"),
  setVolume: (level: number) => invoke<void>("set_volume", { level }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  listAppVolumes: () => invoke<AppVolume[]>("list_app_volumes"),
  setAppVolume: (key: string, level: number | null, muted: boolean | null) => invoke<void>("set_app_volume", { key, level, muted }),
  setMute: (muted: boolean) => invoke<void>("set_mute", { muted }),
  getBrightness: () => invoke<Brightness>("get_brightness"),
  setBrightness: (value: number) => invoke<void>("set_brightness", { value }),
  listModes: () => invoke<{ current: DisplayMode; modes: DisplayMode[] }>("list_modes"),
  setMode: (mode: DisplayMode) => invoke<void>("set_mode", { mode }),
  listPowerPlans: () => invoke<PowerPlan[]>("list_power_plans"),
  setPowerPlan: (id: string) => invoke<void>("set_power_plan", { id }),
};

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
