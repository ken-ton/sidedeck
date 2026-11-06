import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { assistant, AssistantState, AssistantStatus } from "./assistant";

/** 長押しで会話をリセットする */
const RESET_HOLD_MS = 700;

const STATUS_LABELS: Record<AssistantStatus, string> = {
  idle: "タップして話しかける",
  listening: "聞いています…",
  transcribing: "文字にしています…",
  thinking: "考えています…",
  speaking: "話しています（タップで止める）",
};

type Input = { name: string; level: number };

/** 小さな声でも動きが見えるよう平方根で広げ、減るときはゆっくり戻す */
const smooth = (prev: number, raw: number) => Math.max(Math.min(1, Math.sqrt(raw) * 2.2), prev * 0.8);

/** 聞き取り中だけ、録音しているマイクの音量を読む */
function useMicLevel(active: boolean) {
  const [input, setInput] = useState<Input | null>(null);
  useEffect(() => {
    if (!active) {
      setInput(null);
      return;
    }
    let alive = true;
    const t = window.setInterval(() => {
      api
        .micLevel()
        .then((v) => alive && setInput((prev) => ({ name: v.name, level: smooth(prev?.level ?? 0, v.level) })))
        .catch(() => {});
    }, 50);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active]);
  return input;
}

export default function AssistantPad({ style, className, children }: { style?: CSSProperties; className?: string; children?: ReactNode }) {
  const [s, setS] = useState<AssistantState>(assistant.state);
  useEffect(() => assistant.subscribe(setS), []);
  const hold = useRef<{ timer: number; fired: boolean }>({ timer: 0, fired: false });
  const replyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = replyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.reply]);

  // タップは click で受ける（タッチでは指が少し動くだけで pointercancel になることがある）
  const down = () => {
    const h = hold.current;
    window.clearTimeout(h.timer);
    h.fired = false;
    h.timer = window.setTimeout(() => {
      h.fired = true;
      assistant.reset();
    }, RESET_HOLD_MS);
  };
  const release = () => window.clearTimeout(hold.current.timer);
  const click = () => {
    if (hold.current.fired) {
      hold.current.fired = false;
      return;
    }
    assistant.tap();
  };

  const input = useMicLevel(s.status === "listening");
  const level = input?.level ?? 0;
  const empty = !s.heard && !s.reply && !s.error;
  return (
    <button
      className={`${className ?? ""} assistant ${s.status}`}
      style={style}
      onPointerDown={down}
      onPointerUp={release}
      onPointerCancel={release}
      onClick={click}
      onContextMenu={(e) => e.preventDefault()}
    >
      {s.status === "listening" ? (
        <div className="assistant-meter">
          <span className="assistant-meter-dot" style={{ transform: `scale(${0.25 + level * 0.75})` }} />
          <div className="assistant-inputs">
            {input?.name && <InputRow input={input} />}
          </div>
        </div>
      ) : empty ? (
        children
      ) : (
        <div className="assistant-log">
          {s.heard && <div className="assistant-heard">{s.heard}</div>}
          <div ref={replyRef} className="assistant-reply">
            {s.error ? <span className="assistant-error">{s.error}</span> : s.reply}
          </div>
        </div>
      )}
      <span className="assistant-status">
        <span className="assistant-dot" />
        {STATUS_LABELS[s.status]}
      </span>
    </button>
  );
}

function InputRow({ input }: { input: Input }) {
  return (
    <div className="assistant-input">
      <span className="assistant-input-name">{input.name}</span>
    </div>
  );
}
