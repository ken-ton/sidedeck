import { useEffect, useState } from "react";
import type { DeckData } from "./deck";
import { DEFAULT_OBS_URL, obs, ObsState } from "./obs";

const STATUS_LABELS: Record<ObsState["status"], string> = {
  off: "無効",
  connecting: "接続中…",
  connected: "接続しました",
  error: "接続できません",
};

export default function ObsSection({ deck, onDeckChange }: { deck: DeckData; onDeckChange: (d: DeckData) => void }) {
  const conf = deck.obs ?? { enabled: false, url: DEFAULT_OBS_URL, password: "" };
  // 入力のたびに再接続しないよう、欄を離れたときに保存する
  const [url, setUrl] = useState(conf.url);
  const [password, setPassword] = useState(conf.password);
  const [state, setState] = useState<ObsState>(obs.state);
  useEffect(() => obs.subscribe(setState), []);
  const save = (patch: Partial<typeof conf>) => onDeckChange({ ...deck, obs: { ...conf, url: url.trim() || DEFAULT_OBS_URL, password, ...patch } });

  return (
    <section>
      <h2>OBS 連携</h2>
      <label className="switch-row">
        <span>OBS とつなぐ</span>
        <input type="checkbox" className="switch" checked={conf.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
      </label>
      <label className="field">
        <span>WebSocket サーバーの URL</span>
        <input value={url} placeholder={DEFAULT_OBS_URL} onChange={(e) => setUrl(e.target.value)} onBlur={() => save({})} />
      </label>
      <label className="field">
        <span>パスワード</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onBlur={() => save({})} />
      </label>
      {conf.enabled && (
        <p className="hint">
          状態: {STATUS_LABELS[state.status]}
          {state.error && state.status === "error" ? `（${state.error}）` : ""}
        </p>
      )}
      <p className="hint">
        OBS の「ツール」→「WebSocket サーバー設定」で「WebSocket サーバーを有効にする」をオンにし、「接続情報を表示」の内容を入力します。パスワードは設定ファイルにそのまま保存されます。
      </p>
    </section>
  );
}
