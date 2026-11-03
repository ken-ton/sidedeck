import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Config, DeckStatus, MonitorInfo } from "./api";
import type { DeckData } from "./deck";

type Props = {
  deck: DeckData;
  status: DeckStatus;
  onDeckChange: (deck: DeckData) => void;
  onResetDeck: () => void;
  onError: (msg: string) => void;
  onClose: () => void;
};

const monitorLabel = (m: MonitorInfo) => m.friendlyName || m.gdiName.replace("\\\\.\\", "");

export default function Settings({ deck, status, onDeckChange, onResetDeck, onError, onClose }: Props) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

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

  const toggleDeck = () => (status.active ? api.deckExit() : api.deckEnter()).catch((e) => onError(String(e)));

  const resize = (columns: number, rows: number) => {
    const max = columns * rows;
    const lost = deck.pages.reduce((n, p) => n + p.buttons.filter((b) => b.slot >= max).length, 0);
    if (lost > 0) {
      onError(`${lost} 個のボタンがはみ出すため変更できません。先に移動か削除をしてください。`);
      return;
    }
    onDeckChange({ ...deck, columns, rows });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="side-panel wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>設定</h1>
          <button className="close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <section>
          <h2>Deck モード</h2>
          <button className={`action ${status.active ? "secondary" : ""}`} onClick={toggleDeck} disabled={!status.active && !status.monitorConnected}>
            {status.active ? "Deck モードを終了" : status.monitorConnected ? "Deck モードを開始" : "Deck 用モニターが未接続"}
          </button>
          <p className="hint">Deck モード中は、Deck 用モニターにデッキを全画面で表示します。タップしても他のアプリからフォーカスを奪いません。</p>
        </section>

        {config && (
          <>
            <section>
              <h2>Deck 用モニター</h2>
              <div className="monitor-list">
                {monitors.map((m) => {
                  const selected = m.devicePath === config.deckMonitor;
                  return (
                    <button
                      key={m.devicePath || m.gdiName}
                      className={`monitor ${selected ? "on" : ""}`}
                      onClick={async () => {
                        await api.setDeckMonitor(m.devicePath, monitorLabel(m));
                        reload();
                      }}
                    >
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
            </section>
          </>
        )}

        <section>
          <label className="switch-row">
            <span>前面のアプリに合わせてページを自動で切り替える</span>
            <input
              type="checkbox"
              className="switch"
              checked={deck.autoSwitch !== false}
              onChange={(e) => onDeckChange({ ...deck, autoSwitch: e.target.checked })}
            />
          </label>
          <p className="hint">切り替えるアプリは、編集モードでページのタブをタップして登録します（⚡ が付いたページ）。</p>
        </section>

        <section>
          <h2>ボタンの数</h2>
          <div className="grid-size">
            <span>横</span>
            <div className="chips wrap">
              {[3, 4, 5, 6, 7, 8].map((n) => (
                <button key={n} className={deck.columns === n ? "on" : ""} onClick={() => resize(n, deck.rows)}>
                  {n}
                </button>
              ))}
            </div>
            <span>縦</span>
            <div className="chips wrap">
              {[2, 3, 4, 5].map((n) => (
                <button key={n} className={deck.rows === n ? "on" : ""} onClick={() => resize(deck.columns, n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section>
          <h2>タッチ入力</h2>
          <p className="hint">タッチがメインモニター側に反応する場合は、Deck 用モニターをタッチ画面として登録してください。</p>
          <button className="action secondary" onClick={() => api.openTouchSetup().catch((e) => onError(String(e)))}>
            タッチ画面のセットアップを開く
          </button>
        </section>

        <section>
          <h2>リセット</h2>
          <button
            className="danger"
            onClick={() => {
              if (!confirmReset) return setConfirmReset(true);
              setConfirmReset(false);
              onResetDeck();
            }}
          >
            {confirmReset ? "もう一度タップすると、すべてのボタンを初期状態に戻します" : "デッキを初期状態に戻す"}
          </button>
        </section>
      </aside>
    </div>
  );
}
