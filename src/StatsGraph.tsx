import { HISTORY_SECONDS, InfoKind, StatKey, Stats, STATS_SERIES } from "./deck";

export const SERIES_COLORS: Record<StatKey, string> = {
  cpu: "#4ea1ff",
  memory: "#b07cff",
  gpu: "#3ddc97",
  netDown: "#4ea1ff",
  netUp: "#ffb224",
};

/** 回線が空いているときに小さな揺れで振り切らないよう、縦軸は最低でも 1 Mbps にする */
const MIN_NET_SCALE = 1e6 / 8;

const W = HISTORY_SECONDS - 1;
const H = 100;

/** null の点で線を切る */
function segments(values: (number | null)[], max: number): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  const offset = W - (values.length - 1);
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) out.push(cur);
      cur = [];
      return;
    }
    cur.push([offset + i, H - (Math.min(v, max) / max) * H]);
  });
  if (cur.length) out.push(cur);
  return out;
}

export default function StatsGraph({ kind, history }: { kind: InfoKind; history: Stats[] }) {
  const keys = STATS_SERIES[kind];
  if (!keys || history.length < 2) return null;
  const isNet = keys[0] === "netDown" || keys[0] === "netUp";
  const max = isNet ? Math.max(MIN_NET_SCALE, ...history.flatMap((s) => keys.map((k) => s[k] ?? 0))) : 100;
  const single = keys.length === 1;
  return (
    <svg className="stats-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      {keys.map((k) =>
        segments(history.map((s) => s[k]), max).map((pts, i) => {
          const line = pts.map(([x, y]) => `${x},${y}`).join(" ");
          return (
            <g key={`${k}-${i}`} style={{ color: SERIES_COLORS[k] }}>
              {pts.length > 1 && (
                <polygon points={`${pts[0][0]},${H} ${line} ${pts[pts.length - 1][0]},${H}`} fill="currentColor" fillOpacity={single ? 0.28 : 0.12} />
              )}
              <polyline points={line} fill="none" stroke="currentColor" strokeOpacity={0.8} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          );
        }),
      )}
    </svg>
  );
}
