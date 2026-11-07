import { useEffect, useState } from "react";
import { api } from "./api";
import type { DeckData } from "./deck";

export default function MidiSection({ deck, onDeckChange }: { deck: DeckData; onDeckChange: (d: DeckData) => void }) {
  const [inputs, setInputs] = useState<string[] | null>(null);
  const load = () =>
    api
      .midiPorts()
      .then((p) => setInputs(p.inputs))
      .catch(() => setInputs([]));
  useEffect(() => {
    load();
  }, []);
  const current = deck.midiInput ?? "";
  const missing = !!current && inputs !== null && !inputs.includes(current);

  return (
    <section>
      <h2>MIDI</h2>
      <label className="field">
        <span>ボタンを光らせるために受信するポート</span>
        <select value={current} onChange={(e) => onDeckChange({ ...deck, midiInput: e.target.value || undefined })}>
          <option value="">受信しない</option>
          {missing && <option value={current}>{current}（見つかりません）</option>}
          {inputs?.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <div className="chips">
        <button onClick={load}>ポートの一覧を読み込み直す</button>
      </div>
      <p className="hint">
        「MIDI」のボタンは、ここで選んだポートに同じチャンネル・番号の Note か CC が届くと光ります（値が 0 になると消えます）。DJ ソフトなどが返す LED の状態を受け取るのに使います。
        送り先と同じポートを選ぶと、自分が送ったメッセージで光ることがあるので、送る用と受け取る用で別のポートを使ってください。
      </p>
    </section>
  );
}
