import { useEffect, useMemo, useState } from "react";
import { api, PluginField, PluginInfo, PluginOption } from "./api";
import type { Action } from "./deck";

type PluginAction = Extract<Action, { type: "plugin" }>;

function OptionPicker({ options, value, onPick }: { options: PluginOption[]; value: unknown; onPick: (o: PluginOption) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.group?.toLowerCase().includes(q)) : options;
    return hit.slice(0, 300);
  }, [options, query]);

  // 10 件以下なら一覧から選ぶより、チップを並べたほうが速い
  if (options.length <= 10) {
    return (
      <div className="chips wrap">
        {options.map((o) => (
          <button key={String(o.value)} className={o.value === value ? "on" : ""} onClick={() => onPick(o)}>
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <>
      <button className="picker-current" onClick={() => setOpen(!open)}>
        <span>{current ? current.label : value !== undefined && value !== "" ? `（${String(value)}）` : "選んでください"}</span>
        <small>{current?.group ?? ""} ▾</small>
      </button>
      {open && (
        <>
          <input value={query} placeholder={`絞り込み（${options.length} 件）`} onChange={(e) => setQuery(e.target.value)} />
          <ul className="picker">
            {shown.map((o) => (
              <li key={String(o.value)}>
                <button
                  className={o.value === value ? "on" : ""}
                  onClick={() => {
                    onPick(o);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span>{o.label}</span>
                  <small>{o.group ?? ""}</small>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="hint">見つかりません</li>}
          </ul>
        </>
      )}
    </>
  );
}

function DynamicSelect({ plugin, field, settings, onPick }: {
  plugin: string;
  field: PluginField;
  settings: Record<string, unknown>;
  onPick: (o: PluginOption) => void;
}) {
  const [options, setOptions] = useState<PluginOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deps = JSON.stringify((field.dependsOn ?? []).map((k) => settings[k]));

  useEffect(() => {
    let cancelled = false;
    setOptions(null);
    setError(null);
    api
      .pluginGetOptions(plugin, field.optionsFrom!, settings)
      .then((o) => !cancelled && setOptions(o ?? []))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // 依存する項目が変わったときだけ取り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin, field.optionsFrom, deps]);

  if (error) return <p className="hint warn">選択肢を取得できません: {error}</p>;
  if (!options) return <p className="hint">読み込み中…</p>;
  return <OptionPicker options={options} value={settings[field.key]} onPick={onPick} />;
}

export default function PluginFields({ action, onChange, onSuggestLabel }: {
  action: PluginAction;
  onChange: (a: Action) => void;
  /** 選んだ選択肢の名前を、ボタン名の候補として渡す */
  onSuggestLabel: (label: string) => void;
}) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  useEffect(() => {
    api.listPlugins().then(setPlugins);
  }, []);

  if (!plugins) return null;
  if (plugins.length === 0) {
    return (
      <>
        <p className="hint">プラグインが入っていません。設定の「プラグイン」から、プラグインのフォルダを開いて追加してください。</p>
        <button onClick={() => api.openPluginsFolder()}>プラグインのフォルダを開く</button>
      </>
    );
  }

  const plugin = plugins.find((p) => p.id === action.pluginId);
  const def = plugin?.actions.find((a) => a.id === action.actionId);
  const set = (patch: Partial<PluginAction>) => onChange({ ...action, ...patch });
  // 依存元が変わったら依存先の値は意味を失う（例: 種類を変えたら項目の id は別の物を指す）ので、連鎖的に消す
  const setValue = (key: string, value: unknown) => {
    const settings: Record<string, unknown> = { ...action.settings, [key]: value };
    const changed = [key];
    while (changed.length) {
      const k = changed.pop()!;
      for (const f of def?.fields ?? []) {
        if (f.dependsOn?.includes(k) && f.key in settings) {
          delete settings[f.key];
          changed.push(f.key);
        }
      }
    }
    set({ settings });
  };

  const chooseAction = (pluginId: string, actionId: string) => {
    if (pluginId === action.pluginId && actionId === action.actionId) return;
    const p = plugins.find((x) => x.id === pluginId);
    const d = p?.actions.find((x) => x.id === actionId);
    const settings: Record<string, unknown> = {};
    for (const f of d?.fields ?? []) if (f.default !== undefined) settings[f.key] = f.default;
    set({ pluginId, actionId, settings });
    if (d) onSuggestLabel(d.name);
  };

  return (
    <>
      {plugins.map((p) => (
        <div key={p.id} className="plugin-group">
          <h2>
            {p.name}
            {p.status !== "running" && <span className="hint warn"> （{p.status === "error" ? "エラー" : "停止中"}）</span>}
          </h2>
          <div className="chips wrap">
            {p.actions.map((a) => (
              <button key={a.id} className={action.pluginId === p.id && action.actionId === a.id ? "on" : ""} onClick={() => chooseAction(p.id, a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        </div>
      ))}

      {action.pluginId && !plugin && <p className="hint warn">このボタンのプラグイン（{action.pluginId}）が見つかりません。</p>}
      {def?.description && <p className="hint">{def.description}</p>}

      {def?.fields?.map((f) => (
        <div key={f.key} className="field">
          <span>{f.label}</span>
          {f.type === "text" && <input value={String(action.settings[f.key] ?? "")} onChange={(e) => setValue(f.key, e.target.value)} />}
          {f.type === "number" && (
            <input
              type="number"
              value={action.settings[f.key] === undefined ? "" : String(action.settings[f.key])}
              onChange={(e) => setValue(f.key, e.target.value === "" ? undefined : Number(e.target.value))}
            />
          )}
          {f.type === "checkbox" && (
            <input type="checkbox" className="switch" checked={!!action.settings[f.key]} onChange={(e) => setValue(f.key, e.target.checked)} />
          )}
          {f.type === "select" && f.options && (
            <OptionPicker options={f.options} value={action.settings[f.key]} onPick={(o) => setValue(f.key, o.value)} />
          )}
          {f.type === "select" && !f.options && f.optionsFrom && plugin && (
            <DynamicSelect
              plugin={plugin.id}
              field={f}
              settings={action.settings}
              onPick={(o) => {
                setValue(f.key, o.value);
                onSuggestLabel(o.label);
              }}
            />
          )}
        </div>
      ))}
    </>
  );
}
