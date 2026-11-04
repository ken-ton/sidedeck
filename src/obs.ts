/** obs-websocket v5（OBS 28 以降に標準で入っている）のクライアント */

export type ObsSettings = { url: string; password: string };
export const DEFAULT_OBS_URL = "ws://127.0.0.1:4455";

export type ObsState = {
  status: "off" | "connecting" | "connected" | "error";
  error: string | null;
  scene: string | null;
  recording: boolean;
  recordPaused: boolean;
  streaming: boolean;
  virtualcam: boolean;
  replayBuffer: boolean;
  muted: Record<string, boolean>;
};

const initial: ObsState = {
  status: "off",
  error: null,
  scene: null,
  recording: false,
  recordPaused: false,
  streaming: false,
  virtualcam: false,
  replayBuffer: false,
  muted: {},
};

type Pending = { resolve: (d: Record<string, unknown>) => void; reject: (e: Error) => void };

const EVENTS_ALL = 0x7ff;
const RETRY_MS = 5000;

async function sha256Base64(s: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

class Obs {
  state: ObsState = initial;
  private listeners = new Set<(s: ObsState) => void>();
  private ws: WebSocket | null = null;
  private settings: ObsSettings | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private retry: number | undefined;
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;

  subscribe(l: (s: ObsState) => void) {
    this.listeners.add(l);
    l(this.state);
    return () => void this.listeners.delete(l);
  }

  private set(patch: Partial<ObsState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  /** null で切断。同じ設定なら何もしない */
  configure(settings: ObsSettings | null) {
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) return;
    this.settings = settings;
    this.disconnect();
    if (settings) this.connect();
  }

  private disconnect() {
    window.clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.failPending("OBS との接続が切れました");
    this.ready = null;
    this.set({ ...initial });
  }

  private failPending(msg: string) {
    this.pending.forEach((p) => p.reject(new Error(msg)));
    this.pending.clear();
  }

  private connect() {
    const settings = this.settings;
    if (!settings) return;
    this.set({ status: "connecting", error: null });
    this.ready = new Promise((r) => (this.resolveReady = r));
    let ws: WebSocket;
    try {
      ws = new WebSocket(settings.url || DEFAULT_OBS_URL);
    } catch (e) {
      this.set({ status: "error", error: `URL が正しくありません: ${e}` });
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      void this.handle(ws, settings, JSON.parse(String(e.data)));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failPending("OBS との接続が切れました");
      // 4009: パスワード違い。何度試しても同じなので再接続しない
      const auth = e.code === 4009;
      this.set({ ...initial, status: "error", error: auth ? "パスワードが違います" : "OBS に接続できません（OBS が起動しているか、WebSocket サーバーが有効か確認してください）" });
      if (!auth) this.retry = window.setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  private async handle(ws: WebSocket, settings: ObsSettings, msg: { op: number; d: Record<string, any> }) {
    const { op, d } = msg;
    if (op === 0) {
      const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: EVENTS_ALL };
      if (d.authentication) {
        const secret = await sha256Base64(settings.password + d.authentication.salt);
        identify.authentication = await sha256Base64(secret + d.authentication.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (op === 2) {
      this.set({ status: "connected", error: null });
      this.resolveReady?.();
      void this.refresh();
    } else if (op === 7) {
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      if (d.requestStatus?.result) p.resolve(d.responseData ?? {});
      else p.reject(new Error(d.requestStatus?.comment || `OBS でエラーが発生しました（${d.requestStatus?.code}）`));
    } else if (op === 5) {
      this.onEvent(d.eventType, d.eventData ?? {});
    }
  }

  private onEvent(type: string, data: Record<string, any>) {
    switch (type) {
      case "CurrentProgramSceneChanged":
        return this.set({ scene: data.sceneName });
      case "RecordStateChanged":
        return this.set({ recording: data.outputActive, recordPaused: data.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED" });
      case "StreamStateChanged":
        return this.set({ streaming: data.outputActive });
      case "VirtualcamStateChanged":
        return this.set({ virtualcam: data.outputActive });
      case "ReplayBufferStateChanged":
        return this.set({ replayBuffer: data.outputActive });
      case "InputMuteStateChanged":
        return this.set({ muted: { ...this.state.muted, [data.inputName]: data.inputMuted } });
    }
  }

  private async refresh() {
    const get = (type: string) => this.request(type).catch(() => ({}) as Record<string, any>);
    const [scene, record, stream, cam, replay] = await Promise.all([
      get("GetCurrentProgramScene"),
      get("GetRecordStatus"),
      get("GetStreamStatus"),
      get("GetVirtualCamStatus"),
      get("GetReplayBufferStatus"),
    ]);
    this.set({
      scene: (scene.currentProgramSceneName as string) ?? null,
      recording: !!record.outputActive,
      recordPaused: !!record.outputPaused,
      streaming: !!stream.outputActive,
      virtualcam: !!cam.outputActive,
      replayBuffer: !!replay.outputActive,
    });
  }

  /** ミュート状態はボタンにある入力だけ問い合わせる（イベントで更新され続ける） */
  async watchMute(inputs: string[]) {
    const unknown = inputs.filter((i) => !(i in this.state.muted));
    for (const inputName of unknown) {
      const r = await this.request("GetInputMute", { inputName }).catch(() => null);
      if (r) this.set({ muted: { ...this.state.muted, [inputName]: !!r.inputMuted } });
    }
  }

  async request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, any>> {
    if (!this.settings) throw new Error("設定で OBS 連携を有効にしてください");
    if (this.state.status !== "connected") {
      if (this.state.status !== "connecting" || !this.ready) throw new Error(this.state.error ?? "OBS に接続していません");
      await Promise.race([this.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("OBS に接続できません")), 3000))]);
    }
    const ws = this.ws;
    if (!ws) throw new Error("OBS に接続していません");
    const requestId = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }
}

export const obs = new Obs();
