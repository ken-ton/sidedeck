import { useState } from "react";
import { createPortal } from "react-dom";
import AutomationEditor from "./AutomationEditor";
import { ACTION_LABELS, Automation, DeckData, describeTrigger, uid } from "./deck";

export default function AutomationsSection({ deck, onDeckChange, onError }: { deck: DeckData; onDeckChange: (d: DeckData) => void; onError: (msg: string) => void }) {
  const list = deck.automations ?? [];
  const [editing, setEditing] = useState<{ automation: Automation; isNew: boolean } | null>(null);
  const setList = (automations: Automation[]) => onDeckChange({ ...deck, automations });

  return (
    <section>
      <h2>自動化</h2>
      <p className="hint">アプリの切り替えや時刻などをきっかけに、操作を自動で実行します。</p>
      {list.length > 0 && (
        <ul className="automations">
          {list.map((a) => (
            <li key={a.id}>
              <button className="automation-item" onClick={() => setEditing({ automation: a, isNew: false })}>
                <span>{a.name}</span>
                <small>
                  {describeTrigger(a.trigger)} → {ACTION_LABELS[a.action.type]}
                </small>
              </button>
              <input
                type="checkbox"
                className="switch"
                checked={a.enabled}
                aria-label="有効"
                onChange={(e) => setList(list.map((x) => (x.id === a.id ? { ...x, enabled: e.target.checked } : x)))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="chips wrap">
        <button
          onClick={() =>
            setEditing({
              automation: { id: uid(), name: "", enabled: true, trigger: { type: "app_focus", app: "" }, action: { type: "hotkey", keys: [] } },
              isNew: true,
            })
          }
        >
          ＋ 自動化を追加
        </button>
      </div>
      {editing &&
        createPortal(
          <AutomationEditor
            initial={editing.automation}
            isNew={editing.isNew}
            folders={deck.pages.filter((p) => p.folder)}
            onSave={(a) => {
              setList(editing.isNew ? [...list, a] : list.map((x) => (x.id === a.id ? a : x)));
              setEditing(null);
            }}
            onDelete={() => {
              setList(list.filter((x) => x.id !== editing.automation.id));
              setEditing(null);
            }}
            onClose={() => setEditing(null)}
            onError={onError}
          />,
          document.body,
        )}
    </section>
  );
}
