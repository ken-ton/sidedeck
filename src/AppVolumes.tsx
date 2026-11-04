import { useEffect, useRef, useState } from "react";
import { api, AppVolume, throttle } from "./api";

const icons = new Map<string, Promise<string | null>>();
const iconFor = (path: string) => {
  if (!icons.has(path)) icons.set(path, api.getIcon(path).catch(() => null));
  return icons.get(path)!;
};

function AppIcon({ app }: { app: AppVolume }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (app.path) void iconFor(app.path).then(setSrc);
  }, [app.path]);
  if (src) return <img className="app-volume-icon" src={src} alt="" />;
  return <span className="app-volume-icon">{app.path ? "🔊" : "🔔"}</span>;
}

export default function AppVolumes() {
  const [apps, setApps] = useState<AppVolume[] | null>(null);
  /** ドラッグ中に定期更新で値が戻らないよう、最後に動かした時刻を覚える */
  const touched = useRef(new Map<string, number>());
  const senders = useRef(new Map<string, (v: number) => void>());

  useEffect(() => {
    const load = () =>
      api
        .listAppVolumes()
        .then((list) => {
          const now = Date.now();
          setApps((prev) => list.map((a) => (now - (touched.current.get(a.key) ?? 0) < 1500 ? (prev?.find((p) => p.key === a.key) ?? a) : a)));
        })
        .catch(() => setApps([]));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const update = (key: string, patch: Partial<AppVolume>) => setApps((prev) => prev?.map((a) => (a.key === key ? { ...a, ...patch } : a)) ?? prev);

  const sendLevel = (key: string, level: number) => {
    let send = senders.current.get(key);
    if (!send) {
      send = throttle((v: number) => void api.setAppVolume(key, v, null).catch(() => {}), 60);
      senders.current.set(key, send);
    }
    send(level);
  };

  if (!apps?.length) return null;
  return (
    <section>
      <h2>アプリごとの音量</h2>
      <ul className="app-volumes">
        {apps.map((a) => (
          <li key={a.key}>
            <div className="row">
              <span className="app-volume-name">
                <AppIcon app={a} />
                {a.name}
              </span>
              <span>{a.muted ? "ミュート" : `${Math.round(a.level * 100)}%`}</span>
            </div>
            <div className="slider-row">
              <button
                className={`icon ${a.muted ? "on" : ""}`}
                onClick={() => {
                  update(a.key, { muted: !a.muted });
                  touched.current.set(a.key, Date.now());
                  void api.setAppVolume(a.key, null, !a.muted).catch(() => {});
                }}
                aria-label="ミュート"
              >
                {a.muted ? "🔇" : "🔊"}
              </button>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(a.level * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  update(a.key, { level: v });
                  touched.current.set(a.key, Date.now());
                  sendLevel(a.key, v);
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
