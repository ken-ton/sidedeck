import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, MonitorInfo, WindowApp } from "./api";
import { Action, WINDOW_LABELS, WindowCommand } from "./deck";

type WindowAction = Extract<Action, { type: "window" }>;

export default function WindowFields({ action, onChange }: { action: WindowAction; onChange: (a: Action) => void }) {
  const [running, setRunning] = useState<WindowApp[] | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const set = (patch: Partial<WindowAction>) => onChange({ ...action, ...patch });

  useEffect(() => {
    if (action.command === "move_to") api.listMonitors().then(setMonitors);
  }, [action.command]);

  return (
    <>
      <div className="chips wrap">
        {(Object.keys(WINDOW_LABELS) as WindowCommand[]).map((c) => (
          <button key={c} className={action.command === c ? "on" : ""} onClick={() => set({ command: c })}>
            {WINDOW_LABELS[c]}
          </button>
        ))}
      </div>

      {action.command === "focus" && (
        <>
          <label className="field">
            <span>アプリ（プロセス名）</span>
            <input value={action.app} placeholder="code.exe" onChange={(e) => set({ app: e.target.value.trim().toLowerCase() })} />
          </label>
          <button onClick={() => api.listWindowApps().then(setRunning)}>実行中のアプリから選ぶ</button>
          {running && (
            <ul className="picker">
              {running.map((w) => (
                <li key={w.name}>
                  <button
                    className={action.app === w.name ? "on" : ""}
                    onClick={() => {
                      set({ app: w.name });
                      setRunning(null);
                    }}
                  >
                    <span>{w.name}</span>
                    <small>{w.title}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="field">
            <span>起動していないときに開くもの（任意）</span>
            <div className="inline-add">
              <input value={action.launch} placeholder="C:\…\app.exe" onChange={(e) => set({ launch: e.target.value })} />
              <button
                onClick={async () => {
                  const p = await open({ multiple: false });
                  if (typeof p === "string") set({ launch: p });
                }}
              >
                選ぶ
              </button>
            </div>
          </label>
          <p className="hint">そのアプリがすでに前面にあるときは、同じアプリの次のウィンドウに切り替えます。</p>
        </>
      )}

      {action.command === "move_to" && (
        <div className="monitor-list">
          {monitors.map((m) => (
            <button key={m.devicePath} className={`monitor ${action.monitor === m.devicePath ? "on" : ""}`} onClick={() => set({ monitor: m.devicePath })}>
              <strong>{m.friendlyName || m.gdiName}</strong>
              <span>
                {m.width}×{m.height}
                {m.primary ? " ・ プライマリ" : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {action.command !== "focus" && (
        <p className="hint">
          作業中（前面）のウィンドウを操作します。
          {action.command === "move_next" && " Deck 用モニターは飛ばします。"}
          {" "}特定のアプリを動かしたいときは、マクロで「アプリを前面に出す」と組み合わせてください。
        </p>
      )}
    </>
  );
}
