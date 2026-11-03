import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Action, ACTION_LABELS, formatKeys, MacroStep, MEDIA_LABELS, MediaCommand, parseKeys } from "./deck";

type MacroAction = Extract<Action, { type: "macro" }>;

const REPEATS = [1, 2, 3, 5, 10, 0];

function describe(s: MacroStep): string {
  switch (s.type) {
    case "keys":
      return `キー: ${formatKeys(s.keys) || "未設定"}`;
    case "key_down":
      return `押し続ける: ${formatKeys(s.keys) || "未設定"}`;
    case "key_up":
      return `離す: ${formatKeys(s.keys) || "未設定"}`;
    case "text":
      return `文字: “${s.text}”`;
    case "wait":
      return `待つ: ${(s.ms / 1000).toFixed(2)} 秒`;
    case "action": {
      const a = s.action;
      const detail = a.type === "media" ? MEDIA_LABELS[a.command] : a.type === "launch" ? a.target : "";
      return `操作: ${ACTION_LABELS[a.type]}${detail ? `（${detail}）` : ""}`;
    }
  }
}

function KeysInput({ keys, onChange }: { keys: string[]; onChange: (keys: string[]) => void }) {
  const [text, setText] = useState(keys.join("+"));
  return (
    <label className="field">
      <span>キー（例: ctrl+c、w、space、f5）</span>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseKeys(e.target.value));
        }}
      />
    </label>
  );
}

function StepForm({ step, onChange }: { step: MacroStep; onChange: (s: MacroStep) => void }) {
  if (step.type === "keys" || step.type === "key_down" || step.type === "key_up") {
    return (
      <>
        <div className="chips wrap">
          {(["keys", "key_down", "key_up"] as const).map((t) => (
            <button key={t} className={step.type === t ? "on" : ""} onClick={() => onChange({ type: t, keys: step.keys })}>
              {t === "keys" ? "押して離す" : t === "key_down" ? "押し続ける" : "離す"}
            </button>
          ))}
        </div>
        <KeysInput keys={step.keys} onChange={(keys) => onChange({ ...step, keys })} />
      </>
    );
  }
  if (step.type === "text") {
    return (
      <label className="field">
        <span>入力する文字</span>
        <input value={step.text} onChange={(e) => onChange({ type: "text", text: e.target.value })} />
      </label>
    );
  }
  if (step.type === "wait") {
    return (
      <>
        <label className="field">
          <span>待ち時間（ミリ秒）</span>
          <input type="number" min={0} step={10} value={step.ms} onChange={(e) => onChange({ type: "wait", ms: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <div className="chips wrap">
          {[50, 100, 500, 1000, 3000].map((ms) => (
            <button key={ms} className={step.ms === ms ? "on" : ""} onClick={() => onChange({ type: "wait", ms })}>
              {ms >= 1000 ? `${ms / 1000} 秒` : `${ms} ms`}
            </button>
          ))}
        </div>
      </>
    );
  }
  const a = step.action;
  const set = (action: Action) => onChange({ type: "action", action });
  return (
    <>
      <div className="chips wrap">
        <button className={a.type === "launch" ? "on" : ""} onClick={() => set({ type: "launch", target: "", args: "" })}>
          開く
        </button>
        <button className={a.type === "media" ? "on" : ""} onClick={() => set({ type: "media", command: "play_pause" })}>
          メディア操作
        </button>
        <button className={a.type === "mic_mute" ? "on" : ""} onClick={() => set({ type: "mic_mute" })}>
          マイクのミュート
        </button>
        <button className={a.type === "audio_device" ? "on" : ""} onClick={() => set({ type: "audio_device", deviceIds: [] })}>
          出力デバイスを順に切替
        </button>
      </div>
      {a.type === "launch" && (
        <label className="field">
          <span>開くもの（パスか URL）</span>
          <input value={a.target} onChange={(e) => set({ ...a, target: e.target.value })} />
        </label>
      )}
      {a.type === "media" && (
        <div className="chips wrap">
          {(Object.keys(MEDIA_LABELS) as MediaCommand[]).map((c) => (
            <button key={c} className={a.command === c ? "on" : ""} onClick={() => set({ type: "media", command: c })}>
              {MEDIA_LABELS[c]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export default function MacroFields({ action, onChange, onError }: { action: MacroAction; onChange: (a: Action) => void; onError: (msg: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [keepTiming, setKeepTiming] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const recordingRef = useRef(false);
  const steps = action.steps;
  const setSteps = (next: MacroStep[]) => onChange({ ...action, steps: next });

  // 記録中にエディターを閉じたら記録を捨てる
  useEffect(
    () => () => {
      if (recordingRef.current) api.stopKeyRecording(false);
    },
    [],
  );

  const toggleRecording = async () => {
    try {
      if (!recording) {
        await api.startKeyRecording();
        recordingRef.current = true;
        setRecording(true);
        return;
      }
      const recorded = await api.stopKeyRecording(keepTiming);
      recordingRef.current = false;
      setRecording(false);
      if (recorded.length === 0) return onError("キー入力が記録されませんでした");
      setSteps([...steps, ...recorded]);
      setOpen(null);
    } catch (e) {
      onError(String(e));
    }
  };

  const add = (s: MacroStep) => {
    setSteps([...steps, s]);
    setOpen(steps.length);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
    setOpen(open === i ? j : open === j ? i : open);
  };

  return (
    <>
      <h2>繰り返し</h2>
      <div className="chips wrap">
        {REPEATS.map((n) => (
          <button key={n} className={action.repeat === n ? "on" : ""} onClick={() => onChange({ ...action, repeat: n })}>
            {n === 0 ? "停止するまで" : `${n} 回`}
          </button>
        ))}
      </div>
      <p className="hint">実行中にもう一度タップすると止まります。押し続けているキーは、止めたときに自動で離します。</p>

      <div className={`record-box ${recording ? "on" : ""}`}>
        <button className={recording ? "danger-fill" : "action"} onClick={toggleRecording}>
          {recording ? "■ 記録を止める" : "● キー入力を記録"}
        </button>
        <label className="switch-row compact">
          <span>待ち時間も記録する</span>
          <input type="checkbox" className="switch" checked={keepTiming} disabled={recording} onChange={(e) => setKeepTiming(e.target.checked)} />
        </label>
        <p className="hint">
          {recording
            ? "記録中です。ゲームや他のアプリをクリックして操作し、終わったらこのボタンをタップしてください。"
            : "記録を始めたら、ゲームなどのウィンドウをクリックして操作します。記録した入力は、下の一覧の最後に追加されます。"}
        </p>
      </div>

      <h2>ステップ（{steps.length}）</h2>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={i} className={open === i ? "open" : ""}>
            <div className="step-row">
              <span className="step-no">{i + 1}</span>
              <button className="step-body" onClick={() => setOpen(open === i ? null : i)}>
                {describe(s)}
              </button>
              <button className="step-tool" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上へ">
                ↑
              </button>
              <button className="step-tool" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="下へ">
                ↓
              </button>
              <button
                className="step-tool"
                onClick={() => {
                  setSteps(steps.filter((_, j) => j !== i));
                  setOpen(null);
                }}
                aria-label="削除"
              >
                ✕
              </button>
            </div>
            {open === i && (
              <div className="step-form">
                <StepForm step={s} onChange={(next) => setSteps(steps.map((x, j) => (j === i ? next : x)))} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {steps.length > 0 && (
        <button className="ghost" onClick={() => setSteps([])}>
          ステップをすべて消す
        </button>
      )}
      <div className="chips wrap">
        <button onClick={() => add({ type: "keys", keys: [] })}>＋ キー</button>
        <button onClick={() => add({ type: "key_down", keys: [] })}>＋ 押し続ける</button>
        <button onClick={() => add({ type: "key_up", keys: [] })}>＋ 離す</button>
        <button onClick={() => add({ type: "wait", ms: 500 })}>＋ 待つ</button>
        <button onClick={() => add({ type: "text", text: "" })}>＋ 文字</button>
        <button onClick={() => add({ type: "action", action: { type: "media", command: "play_pause" } })}>＋ 操作</button>
      </div>
    </>
  );
}
