import type { DeckButton } from "./deck";

/** override はプラグインからの表示（null / 未指定ならボタンの設定を使う） */
export default function ButtonFace({ button, sub, override }: {
  button: DeckButton;
  sub?: string | null;
  override?: { title?: string | null; icon?: string | null };
}) {
  const label = override?.title ?? button.label;
  const icon = override?.icon ? ({ kind: "image", src: override.icon } as const) : button.icon;
  return (
    <>
      {icon?.kind === "image" && <img className="face-icon" src={icon.src} alt="" draggable={false} />}
      {icon?.kind === "emoji" && <span className="face-icon emoji">{icon.value}</span>}
      {label && <span className={`face-label ${icon ? "" : "only"}`}>{label}</span>}
      {sub && <span className="face-sub">{sub}</span>}
    </>
  );
}
