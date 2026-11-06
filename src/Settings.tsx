import { useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, UpdateInfo, Config, DeckStatus, MonitorInfo, PluginInfo } from "./api";
import { DEFAULT_TOGGLE_SHORTCUT, misplacedButtons, type DeckData } from "./deck";
import ShortcutField from "./ShortcutField";
import ObsSection from "./ObsSection";
import AutomationsSection from "./AutomationsSection";
import AssistantSection from "./AssistantSection";

type Props = {
  deck: DeckData;
  status: DeckStatus;
  onDeckChange: (deck: DeckData) => void;
  toggleShortcutError: string | null;
  shortcutUserOf: (keys: string[] | undefined) => string | null;
  onResetDeck: () => void;
  update: UpdateInfo | null;
  onError: (msg: string) => void;
  onClose: () => void;
};

const monitorLabel = (m: MonitorInfo) => m.friendlyName || m.gdiName.replace("\\\\.\\", "");

export default function Settings({ deck, status, onDeckChange, toggleShortcutError, shortcutUserOf, onResetDeck, update, onError, onClose }: Props) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [autostart, setAutostart] = useState<{ enabled: boolean; devBuild: boolean } | null>(null);

  const reload = useCallback(async () => {
    setMonitors(await api.listMonitors());
    setConfig(await api.getConfig());
    setAutostart(await api.getAutostart());
  }, []);

  useEffect(() => {
    reload();
    const loadPlugins = () => api.listPlugins().then(setPlugins);
    loadPlugins();
    const un = [listen("monitors-changed", reload), listen("plugins-changed", loadPlugins)];
    return () => {
      un.forEach((p) => p.then((f) => f()));
    };
  }, [reload]);

  const toggleDeck = () => (status.active ? api.deckExit() : api.deckEnter()).catch((e) => onError(String(e)));

  const resize = (columns: number, rows: number) => {
    const lost = deck.pages.reduce((n, p) => n + misplacedButtons(p, columns, rows), 0);
    if (lost > 0) {
      onError(`${lost} 個のボタンがはみ出すか重なるため変更できません。先に移動・縮小・削除をしてください。`);
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
              {autostart && (
                <>
                  <label className="switch-row">
                    <span>Windows の起動時に自動で起動する</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={autostart.enabled}
                      onChange={async (e) => {
                        await api.setAutostart(e.target.checked).catch((err) => onError(String(err)));
                        reload();
                      }}
                    />
                  </label>
                  <p className="hint">
                    自動で起動したときは、トレイに常駐した状態で始まります。上の自動切替もオンにしておくと、PC を起動するだけで Deck 用モニターにデッキが表示されます。
                  </p>
                  {autostart.devBuild && (
                    <p className="hint warn">いまは開発版で動いています。開発版の実行ファイルが登録されてしまうので、インストールした版で設定してください。</p>
                  )}
                </>
              )}
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
          <label className="switch-row">
            <span>絵文字のアイコンを白黒で表示する</span>
            <input type="checkbox" className="switch" checked={!!deck.monoEmoji} onChange={(e) => onDeckChange({ ...deck, monoEmoji: e.target.checked })} />
          </label>
          <p className="hint">カラーの絵文字と白黒の記号が混ざらないよう、すべて白黒の記号にそろえます。白黒の形がない新しい絵文字は、グレーで表示します。</p>
        </section>

        <section>
          <h2>デッキを前面に出すショートカット</h2>
          <ShortcutField
            value={deck.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT}
            onChange={(keys) => onDeckChange({ ...deck, toggleShortcut: keys ?? [] })}
            registeredError={toggleShortcutError}
            usedBy={shortcutUserOf(deck.toggleShortcut ?? DEFAULT_TOGGLE_SHORTCUT)}
          />
          <p className="hint">Deck 用モニターでほかのアプリがデッキを隠しているときに押すと、デッキを手前に出します。もう一度押すと後ろに下げます。どちらもフォーカスは奪いません。</p>
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
          <p className="hint">タッチがメインモニター側に反応する場合は、Deck 用モニターをタッチ画面として登録してください。開くときに管理者権限の確認が表示されます。</p>
          <button className="action secondary" onClick={() => api.openTouchSetup().catch((e) => onError(String(e)))}>
            タッチ画面のセットアップを開く
          </button>
        </section>

        <AutomationsSection deck={deck} onDeckChange={onDeckChange} onError={onError} />

        <ObsSection deck={deck} onDeckChange={onDeckChange} />

        <AssistantSection deck={deck} onDeckChange={onDeckChange} onError={onError} />

        <section>
          <h2>プラグイン</h2>
          {plugins.length === 0 && <p className="hint">プラグインは入っていません。</p>}
          <ul className="plugin-list">
            {plugins.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>{p.name}</strong> <small>{p.version}</small>
                  {p.error && <p className="hint warn">{p.error}</p>}
                </div>
                <span className={`badge status-${p.status}`}>
                  {{ running: "動作中", starting: "起動中", stopped: "停止中", error: "エラー" }[p.status]}
                </span>
              </li>
            ))}
          </ul>
          <div className="chips wrap">
            <button onClick={() => api.reloadPlugins()}>プラグインを再読み込み</button>
            <button onClick={() => api.openPluginsFolder().catch((e) => onError(String(e)))}>フォルダを開く</button>
          </div>
          <p className="hint">プラグインは、フォルダごと「フォルダを開く」の場所に置いてから再読み込みします。プラグインはパソコン上で自由に動けるプログラムなので、信頼できるものだけを入れてください。</p>
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

        <section>
          <h2>終了</h2>
          <button className="danger" onClick={() => api.quitApp().catch((e) => onError(String(e)))}>
            SideDeck を終了
          </button>
          <p className="hint">ウィンドウを閉じてもトレイに常駐し続けます。完全に終了するときはこのボタンを使ってください。</p>
        </section>

        <About update={update} onError={onError} />
      </aside>
    </div>
  );
}

const REPOSITORY = "https://github.com/ken-ton/sidedeck";

function About({ update, onError }: { update: UpdateInfo | null; onError: (msg: string) => void }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion);
  }, []);
  const open = (url: string) => openUrl(url).catch((e) => onError(String(e)));

  return (
    <section className="about">
      <h2>このアプリについて</h2>
      <p>
        <strong>SideDeck</strong> <span className="about-version">{version ? `バージョン ${version}` : ""}</span>
      </p>
      {update && (
        <div className="update-notice">
          <span>新しいバージョン {update.version} が出ています</span>
          <button className="on" onClick={() => open(update.url)}>
            ダウンロード
          </button>
        </div>
      )}
      <div className="chips wrap">
        <button onClick={() => open(REPOSITORY)}>GitHub</button>
        <button onClick={() => open(`${REPOSITORY}/releases/latest`)}>最新のリリース</button>
        <button onClick={() => open(`${REPOSITORY}/blob/main/LICENSE`)}>ライセンス</button>
      </div>
      <p className="hint">© 2026 KT ・ MIT License</p>
    </section>
  );
}
