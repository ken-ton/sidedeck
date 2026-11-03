import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Brightness, DisplayMode, PowerPlan, throttle, Volume } from "./api";

const modeKey = (m: DisplayMode) => `${m.width}x${m.height}@${m.refresh}`;

export default function SystemPanel({ onClose }: { onClose: () => void }) {
  const [volume, setVolume] = useState<Volume | null>(null);
  const [bright, setBright] = useState<Brightness | null>(null);
  const [modes, setModes] = useState<{ current: DisplayMode; modes: DisplayMode[] } | null>(null);
  const [plans, setPlans] = useState<PowerPlan[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getVolume().then(setVolume).catch(() => setVolume(null));
    api.getBrightness().then(setBright).catch(() => setBright(null));
    api.listModes().then(setModes).catch(() => setModes(null));
    api.listPowerPlans().then(setPlans);
  }, []);
  useEffect(load, [load]);

  const sendVolume = useMemo(() => throttle((v: number) => api.setVolume(v), 60), []);
  const sendBright = useMemo(() => throttle((v: number) => api.setBrightness(v).catch((e) => setError(String(e))), 150), []);

  const resolutions = useMemo(() => {
    if (!modes) return [];
    const seen = new Set<string>();
    return modes.modes.filter((m) => {
      const k = `${m.width}x${m.height}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [modes]);
  const rates = useMemo(
    () => (modes ? modes.modes.filter((m) => m.width === modes.current.width && m.height === modes.current.height) : []),
    [modes],
  );

  const changeMode = async (m: DisplayMode) => {
    try {
      await api.setMode(m);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="side-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>システム</h1>
          <button className="close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        {volume && (
          <section>
            <div className="row">
              <h2>音量</h2>
              <span>{volume.muted ? "ミュート" : `${Math.round(volume.level * 100)}%`}</span>
            </div>
            <div className="slider-row">
              <button
                className={`icon ${volume.muted ? "on" : ""}`}
                onClick={() => {
                  api.setMute(!volume.muted);
                  setVolume({ ...volume, muted: !volume.muted });
                }}
              >
                {volume.muted ? "🔇" : "🔊"}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume.level * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  setVolume({ ...volume, level: v });
                  sendVolume(v);
                }}
              />
            </div>
          </section>
        )}

        {bright && (
          <section>
            <div className="row">
              <h2>明るさ（Deck 用モニター）</h2>
              <span>{bright.value}%</span>
            </div>
            <div className="slider-row">
              <span className="icon">☀</span>
              <input
                type="range"
                min={bright.min}
                max={100}
                value={bright.value}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setBright({ ...bright, value: v });
                  sendBright(v);
                }}
              />
            </div>
            {bright.method === "gamma" && <p className="hint">このモニターは DDC/CI に対応していないため、ソフトウェアで減光しています。</p>}
          </section>
        )}

        {modes && (
          <section>
            <h2>解像度（Deck 用モニター）</h2>
            <div className="chips wrap">
              {resolutions.map((m) => {
                const on = m.width === modes.current.width && m.height === modes.current.height;
                return (
                  <button key={modeKey(m)} className={on ? "on" : ""} onClick={() => !on && changeMode(m)}>
                    {m.width}×{m.height}
                  </button>
                );
              })}
            </div>
            {rates.length > 1 && (
              <>
                <h2>リフレッシュレート</h2>
                <div className="chips wrap">
                  {rates.map((m) => (
                    <button key={modeKey(m)} className={m.refresh === modes.current.refresh ? "on" : ""} onClick={() => changeMode(m)}>
                      {m.refresh}Hz
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {plans.length > 0 && (
          <section>
            <h2>電源プラン</h2>
            <div className="chips wrap">
              {plans.map((p) => (
                <button
                  key={p.id}
                  className={p.active ? "on" : ""}
                  onClick={async () => {
                    await api.setPowerPlan(p.id).catch((e) => setError(String(e)));
                    setPlans(await api.listPowerPlans());
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {error && (
          <p className="hint warn" onClick={() => setError(null)}>
            {error}
          </p>
        )}
      </aside>
    </div>
  );
}
