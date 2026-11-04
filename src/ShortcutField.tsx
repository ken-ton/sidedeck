import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { formatKeys, keyFromCode } from "./deck";

type Props = {
  value: string[] | undefined;
  onChange: (keys: string[] | undefined) => void;
  /** 保存後に登録できなかったときのエラー */
  registeredError?: string | null;
  /** SideDeck の中で同じキーを使っているもの */
  usedBy?: string | null;
};

export default function ShortcutField({ value, onChange, registeredError, usedBy }: Props) {
  const recorder = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const keys = value ?? [];

  // 記録中は SideDeck のショートカットを外す（登録済みのキーが記録欄に届かず、ボタンが実行されてしまうため）
  useEffect(() => {
    if (!recording) return;
    api.suspendShortcuts(true);
    return () => {
      api.suspendShortcuts(false);
    };
  }, [recording]);

  useEffect(() => {
    setCheckError(null);
    if (keys.length === 0) return;
    let cancelled = false;
    api.checkShortcut(keys).then((e) => !cancelled && setCheckError(e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join("+")]);

  const warning = usedBy ? `「${usedBy}」と同じショートカットです` : (checkError ?? registeredError ?? null);

  return (
    <>
      <div className="shortcut-row">
        <span className="keys-display small">{keys.length ? formatKeys(keys) : "なし"}</span>
        <button
          className={recording ? "on" : ""}
          onClick={() => {
            setRecording(true);
            recorder.current?.focus();
          }}
        >
          {recording ? "キーを押してください…" : "記録する"}
        </button>
        {keys.length > 0 && (
          <button className="ghost" onClick={() => onChange([])}>
            なしにする
          </button>
        )}
      </div>
      <input
        ref={recorder}
        className="recorder"
        readOnly
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          e.preventDefault();
          const k = keyFromCode(e.code);
          if (!k) return;
          const mods = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.altKey && "alt", e.metaKey && "win"].filter(Boolean) as string[];
          onChange([...mods, k]);
          e.currentTarget.blur();
        }}
      />
      {warning && <p className="hint warn">⚠ {warning}</p>}
    </>
  );
}
