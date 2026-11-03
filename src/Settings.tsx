import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Config, MonitorInfo } from "./api";

type Props = { onGamesChanged: () => void; onError: (msg: string) => void };

function monitorLabel(m: MonitorInfo) {
  return m.friendlyName || m.gdiName.replace("\\\\.\\", "");
}

export default function Settings({ onGamesChanged, onError }: Props) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [config, setConfig] = useState<Config | null>(null);

  const reload = useCallback(async () => {
    setMonitors(await api.listMonitors());
    setConfig(await api.getConfig());
  }, []);

  useEffect(() => {
    reload();
    const un = listen("monitors-changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  if (!config) return null;

  const chooseMonitor = async (m: MonitorInfo) => {
    await api.setDeckMonitor(m.devicePath, monitorLabel(m));
    reload();
  };

  const addGame = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "ゲーム / ショートカット", extensions: ["exe", "lnk", "url", "bat"] }],
    });
    if (typeof path !== "string") return;
    const title = path.split(/[\\/]/).pop()!.replace(/\.(exe|lnk|url|bat)$/i, "");
    await api.addCustomGame(title, path);
    reload();
    onGamesChanged();
  };

  const removeGame = async (id: string) => {
    await api.removeCustomGame(id);
    reload();
    onGamesChanged();
  };

  return (
    <main className="settings">
      <section>
        <h2>Deck 用モニター</h2>
        <p className="hint">MD-14T を選んでください。Deck モード中は、このモニターにランチャーを全画面で表示します（プライマリは切り替えません）。</p>
        <div className="monitor-list">
          {monitors.map((m) => {
            const selected = m.devicePath === config.deckMonitor;
            return (
              <button key={m.devicePath || m.gdiName} className={`monitor ${selected ? "on" : ""}`} onClick={() => chooseMonitor(m)}>
                <strong>{monitorLabel(m)}</strong>
                <span>
                  {m.width}×{m.height} @ {m.refresh}Hz{m.primary ? " ・ プライマリ" : ""}
                </span>
                {selected && <span className="check">Deck 用</span>}
              </button>
            );
          })}
        </div>
        {config.deckMonitor && !monitors.some((m) => m.devicePath === config.deckMonitor) && (
          <p className="hint warn">設定済みのモニター「{config.deckMonitorName}」は現在接続されていません。</p>
        )}
      </section>

      <section>
        <h2>自動切替</h2>
        <label className="switch-row">
          <span>モニターを接続したら自動で Deck モードにする</span>
          <input
            type="checkbox"
            className="switch"
            checked={config.autoDeck}
            onChange={async (e) => {
              await api.setAutoDeck(e.target.checked);
              reload();
            }}
          />
        </label>
        <p className="hint">モニターを取り外すと Deck モードを終了します。</p>
      </section>

      <section>
        <h2>ゲームウィンドウ</h2>
        <label className="switch-row">
          <span>起動したゲームを Deck 用モニターへ移動する</span>
          <input
            type="checkbox"
            className="switch"
            checked={config.moveGameWindows}
            onChange={async (e) => {
              await api.setMoveGameWindows(e.target.checked);
              reload();
            }}
          />
        </label>
        <p className="hint">
          起動から 2 分間、前面に出たゲームのウィンドウを移動します。ボーダーレス全画面のゲームは画面いっぱいに合わせます。
          排他フルスクリーンのゲームは移動できないことがあるので、ゲーム側でボーダーレスかウィンドウモードを選んでください。
        </p>
      </section>

      <section>
        <h2>タッチ入力</h2>
        <p className="hint">タッチがメインモニター側に反応する場合は、Windows の設定で MD-14T をタッチ画面として登録してください。</p>
        <button className="action" onClick={() => api.openTouchSetup().catch((e) => onError(String(e)))}>
          タッチ画面のセットアップを開く
        </button>
      </section>

      <section>
        <h2>手動で追加したゲーム</h2>
        <ul className="custom-games">
          {config.customGames.map((g) => (
            <li key={g.id}>
              <div>
                <strong>{g.title}</strong>
                <small>{g.path}</small>
              </div>
              <button className="danger" onClick={() => removeGame(g.id)}>
                削除
              </button>
            </li>
          ))}
        </ul>
        <button className="action" onClick={addGame}>
          ＋ 実行ファイルを追加
        </button>
      </section>
    </main>
  );
}
