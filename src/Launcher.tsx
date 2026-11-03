import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, DeckStatus, Game } from "./api";
import Settings from "./Settings";

type Tab = "library" | "settings";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock">{now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>;
}

const SOURCE_LABEL: Record<Game["source"], string> = { steam: "Steam", epic: "Epic", custom: "手動" };

function Tile({ game, onLaunch }: { game: Game; onLaunch: (g: Game) => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button className="tile" onClick={() => onLaunch(game)}>
      {game.art && !broken ? (
        <img src={convertFileSrc(game.art)} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <div className="tile-fallback">{game.title}</div>
      )}
      <div className="tile-caption">
        <span className="tile-title">{game.title}</span>
        <span className={`badge badge-${game.source}`}>{SOURCE_LABEL[game.source]}</span>
      </div>
    </button>
  );
}

export default function Launcher() {
  const [tab, setTab] = useState<Tab>("library");
  const [games, setGames] = useState<Game[]>([]);
  const [filter, setFilter] = useState<"all" | Game["source"]>("all");
  const [status, setStatus] = useState<DeckStatus>({ active: false, monitorConnected: false });
  const [toast, setToast] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }, []);

  const reloadGames = useCallback(() => api.listGames().then(setGames), []);

  useEffect(() => {
    reloadGames();
    api.deckStatus().then(setStatus);
    const un = [
      listen<DeckStatus>("deck-status", (e) => setStatus(e.payload)),
      listen<string>("deck-error", (e) => showToast(e.payload)),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [reloadGames, showToast]);

  const launch = async (g: Game) => {
    setLaunching(g.id);
    try {
      await api.launchGame(g.id);
    } catch (e) {
      showToast(`起動できませんでした: ${e}`);
    } finally {
      setTimeout(() => setLaunching(null), 1500);
    }
  };

  const toggleDeck = async () => {
    try {
      await (status.active ? api.deckExit() : api.deckEnter());
    } catch (e) {
      showToast(String(e));
    }
  };

  const shown = games.filter((g) => filter === "all" || g.source === filter);

  return (
    <div className={`launcher ${status.active ? "is-deck" : ""}`}>
      <header className="topbar">
        <nav className="tabs">
          <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
            ライブラリ
          </button>
          <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
            設定
          </button>
        </nav>
        <div className="topbar-right">
          <button className={`deck-toggle ${status.active ? "on" : ""}`} onClick={toggleDeck} disabled={!status.active && !status.monitorConnected}>
            {status.active ? "Deck モード終了" : status.monitorConnected ? "Deck モード開始" : "モニター未接続"}
          </button>
          <Clock />
        </div>
      </header>

      {tab === "library" ? (
        <main className="library">
          {/* 検証用（フォーカスを奪わずにキーを送れるか） */}
          <div className="chips spike">
            {(
              [
                ["文字: hello", () => api.sendText("hello ")],
                ["W（スキャンコード）", () => api.sendKeys(["w"])],
                ["Space", () => api.sendKeys(["space"])],
                ["Ctrl+A", () => api.sendKeys(["ctrl", "a"])],
                ["Alt+Tab", () => api.sendKeys(["alt", "tab"])],
                ["再生/停止", () => api.sendKeys(["media_play_pause"])],
                ["次の曲", () => api.sendKeys(["media_next"])],
              ] as [string, () => Promise<unknown>][]
            ).map(([label, fn]) => (
              <button key={label} onClick={() => fn().then((r) => typeof r === "string" && showToast(r)).catch((e) => showToast(String(e)))}>
                {label}
              </button>
            ))}
          </div>
          <div className="chips">
            {(["all", "steam", "epic", "custom"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "all" ? `すべて (${games.length})` : SOURCE_LABEL[f]}
              </button>
            ))}
            <button className="ghost" onClick={reloadGames}>
              再読み込み
            </button>
          </div>
          {shown.length === 0 ? (
            <p className="empty">
              ゲームが見つかりません。Steam / Epic のゲームは自動で表示されます。
              <br />
              それ以外は「設定」から実行ファイルを追加してください。
            </p>
          ) : (
            <div className="grid">
              {shown.map((g) => (
                <Tile key={g.id} game={g} onLaunch={launch} />
              ))}
            </div>
          )}
        </main>
      ) : (
        <Settings onGamesChanged={reloadGames} onError={showToast} />
      )}

      {launching && <div className="launching">起動中…</div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
