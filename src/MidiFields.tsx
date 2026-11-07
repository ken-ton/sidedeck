import { useEffect, useState } from "react";
import { api } from "./api";
import { Action, MIDI_KIND_LABELS, MidiKind, noteName } from "./deck";

type MidiAction = Extract<Action, { type: "midi" }>;

const clamp = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

export default function MidiFields({ action, onChange }: { action: MidiAction; onChange: (a: Action) => void }) {
  const [ports, setPorts] = useState<string[] | null>(null);
  const load = () =>
    api
      .midiPorts()
      .then((p) => setPorts(p.outputs))
      .catch(() => setPorts([]));
  useEffect(() => {
    load();
  }, []);
  const set = (patch: Partial<MidiAction>) => onChange({ ...action, ...patch });
  const missing = !!action.port && ports !== null && !ports.includes(action.port);

  return (
    <>
      <label className="field">
        <span>送り先の MIDI ポート</span>
        <select value={action.port} onChange={(e) => set({ port: e.target.value })}>
          <option value="">選んでください</option>
          {missing && <option value={action.port}>{action.port}（見つかりません）</option>}
          {ports?.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <div className="chips">
        <button onClick={load}>ポートの一覧を読み込み直す</button>
      </div>
      <div className="chips wrap">
        {(Object.keys(MIDI_KIND_LABELS) as MidiKind[]).map((k) => (
          <button key={k} className={action.kind === k ? "on" : ""} onClick={() => set({ kind: k })}>
            {MIDI_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="icon-row">
        <label className="field">
          <span>チャンネル（1〜16）</span>
          <input type="number" min={1} max={16} value={action.channel} onChange={(e) => set({ channel: clamp(e.target.value, 1, 16) })} />
        </label>
        <label className="field">
          <span>{action.kind === "note" ? `ノート番号（${noteName(action.number)}）` : "CC 番号"}</span>
          <input type="number" min={0} max={127} value={action.number} onChange={(e) => set({ number: clamp(e.target.value, 0, 127) })} />
        </label>
        <label className="field">
          <span>{action.kind === "note" ? "ベロシティ" : "値"}（1〜127）</span>
          <input type="number" min={1} max={127} value={action.value} onChange={(e) => set({ value: clamp(e.target.value, 1, 127) })} />
        </label>
      </div>
      <p className="hint">
        押したときに{action.kind === "note" ? "ノートオン" : "この値"}を、離したときに{action.kind === "note" ? "ノートオフ" : "値 0"}を送ります。設定の「MIDI」で受信用のポートを選ぶと、同じチャンネル・番号の値が 0 より大きい間、ボタンが光ります。
        ほかのアプリに送るには、loopMIDI などで仮想の MIDI ポートを作ってください。
      </p>
    </>
  );
}
