import { useState } from "react";
import { api, WindowApp } from "./api";
import ActionEditor, { validateAction } from "./ActionEditor";
import {
  ACTION_LABELS,
  Automation,
  AUTOMATION_EXCLUDE,
  emptyTrigger,
  OBS_EVENT_LABELS,
  ObsEvent,
  Page,
  Trigger,
  TRIGGER_LABELS,
  TriggerType,
  WEEKDAYS,
} from "./deck";

function AppField({ app, onChange }: { app: string; onChange: (app: string) => void }) {
  const [running, setRunning] = useState<WindowApp[] | null>(null);
  return (
    <>
      <label className="field">
        <span>アプリ（プロセス名）</span>
        <input value={app} placeholder="例: code.exe" onChange={(e) => onChange(e.target.value)} />
      </label>
      <div className="chips wrap">
        <button onClick={() => api.listWindowApps().then(setRunning)}>実行中のアプリから選ぶ</button>
      </div>
      {running && (
        <ul className="picker">
          {running.map((w) => (
            <li key={w.name}>
              <button
                className={app === w.name ? "on" : ""}
                onClick={() => {
                  onChange(w.name);
                  setRunning(null);
                }}
              >
                <span>{w.name}</span>
                <small>{w.title}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TriggerFields({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  switch (trigger.type) {
    case "app_focus":
    case "app_blur":
      return <AppField app={trigger.app} onChange={(app) => onChange({ ...trigger, app })} />;
    case "time":
      return (
        <>
          <label className="field">
            <span>時刻</span>
            <input type="time" value={trigger.time} onChange={(e) => onChange({ ...trigger, time: e.target.value })} />
          </label>
          <div className="chips wrap">
            {[...WEEKDAYS].map((d, i) => (
              <button
                key={d}
                className={trigger.days.includes(i) ? "on" : ""}
                onClick={() =>
                  onChange({ ...trigger, days: trigger.days.includes(i) ? trigger.days.filter((x) => x !== i) : [...trigger.days, i].sort() })
                }
              >
                {d}
              </button>
            ))}
          </div>
          <p className="hint">曜日を選ばなければ毎日実行します。SideDeck が起動していて、PC がスリープしていないときだけ動きます。</p>
        </>
      );
    case "obs":
      return (
        <>
          <div className="chips wrap">
            {(Object.keys(OBS_EVENT_LABELS) as ObsEvent[]).map((e) => (
              <button key={e} className={trigger.event === e ? "on" : ""} onClick={() => onChange({ ...trigger, event: e })}>
                {OBS_EVENT_LABELS[e]}
              </button>
            ))}
          </div>
          <p className="hint">設定の「OBS 連携」で OBS につないでいるときだけ動きます。</p>
        </>
      );
    default:
      return null;
  }
}

export default function AutomationEditor({
  initial,
  isNew,
  folders,
  onSave,
  onDelete,
  onClose,
  onError,
}: {
  initial: Automation;
  isNew: boolean;
  folders: Page[];
  onSave: (a: Automation) => void;
  onDelete: () => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [a, setA] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    const t = a.trigger;
    if ((t.type === "app_focus" || t.type === "app_blur") && !t.app.trim()) return onError("アプリを指定してください");
    if (t.type === "time" && !/^\d{2}:\d{2}$/.test(t.time)) return onError("時刻を指定してください");
    const error = validateAction(a.action);
    if (error) return onError(error);
    let trigger = t;
    if (t.type === "app_focus" || t.type === "app_blur") {
      const app = t.app.trim().toLowerCase();
      trigger = { ...t, app: app.endsWith(".exe") ? app : `${app}.exe` };
    }
    onSave({ ...a, trigger, name: a.name.trim() || ACTION_LABELS[a.action.type] });
  };

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>{isNew ? "自動化を追加" : "自動化を編集"}</h1>
          <button className="close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        <section>
          <label className="field">
            <span>名前</span>
            <input value={a.name} placeholder="未入力なら操作の名前" onChange={(e) => setA({ ...a, name: e.target.value })} />
          </label>
          <label className="switch-row">
            <span>有効</span>
            <input type="checkbox" className="switch" checked={a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} />
          </label>
        </section>

        <section>
          <h2>いつ</h2>
          <div className="chips wrap">
            {(Object.keys(TRIGGER_LABELS) as TriggerType[]).map((t) => (
              <button key={t} className={a.trigger.type === t ? "on" : ""} onClick={() => a.trigger.type !== t && setA({ ...a, trigger: emptyTrigger(t) })}>
                {TRIGGER_LABELS[t]}
              </button>
            ))}
          </div>
          <TriggerFields trigger={a.trigger} onChange={(trigger) => setA({ ...a, trigger })} />
        </section>

        <section>
          <h2>実行する操作</h2>
          <ActionEditor action={a.action} onChange={(action) => setA({ ...a, action })} folders={folders} exclude={AUTOMATION_EXCLUDE} onError={onError} />
        </section>

        <div className="sheet-actions">
          {!isNew && (
            <button
              className="danger"
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                onDelete();
              }}
            >
              {confirmDelete ? "本当に削除" : "削除"}
            </button>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            キャンセル
          </button>
          <button className="on" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
