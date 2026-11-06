import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

/** タッチは Rust 側が重ねる透明なウィンドウで受ける。ここは見た目と、その位置を知らせるだけ */
const mounted = new Map<HTMLElement, { id: string; speed: number }>();

function syncAreas() {
  const areas = [...mounted].map(([el, { id, speed }]) => {
    const r = el.getBoundingClientRect();
    return { id, speed, x: r.left, y: r.top, w: r.width, h: r.height };
  });
  api.setTrackpadAreas(areas).catch(() => {});
}

export default function Trackpad({ id, speed, style, className, onError, children }: {
  id: string;
  speed: number;
  style?: CSSProperties;
  className?: string;
  onError: (msg: string) => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("idle");
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const el = ref.current!;
    mounted.set(el, { id, speed });
    syncAreas();
    const ro = new ResizeObserver(syncAreas);
    ro.observe(el);
    // 上に通知の帯が出るなどして、大きさは変わらず位置だけずれることがある
    if (el.parentElement) ro.observe(el.parentElement);
    return () => {
      mounted.delete(el);
      ro.disconnect();
      syncAreas();
    };
  }, [id, speed]);

  useEffect(() => {
    const un = [
      listen<{ id: string; state: string }>("trackpad-state", (e) => e.payload.id === id && setState(e.payload.state)),
      listen<{ id: string; message: string }>("trackpad-error", (e) => e.payload.id === id && onErrorRef.current(e.payload.message)),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [id]);

  return (
    <div ref={ref} className={`${className ?? ""} trackpad ${state}`} style={style}>
      {children}
    </div>
  );
}
