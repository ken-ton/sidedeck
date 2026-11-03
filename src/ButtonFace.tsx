import type { DeckButton } from "./deck";

export default function ButtonFace({ button, sub }: { button: DeckButton; sub?: string | null }) {
  const { icon, label } = button;
  return (
    <>
      {icon?.kind === "image" && <img className="face-icon" src={icon.src} alt="" draggable={false} />}
      {icon?.kind === "emoji" && <span className="face-icon emoji">{icon.value}</span>}
      {label && <span className={`face-label ${icon ? "" : "only"}`}>{label}</span>}
      {sub && <span className="face-sub">{sub}</span>}
    </>
  );
}
