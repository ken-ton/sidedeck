import type { DeckButton } from "./deck";

/**
 * U+FE0E を付けて、白黒の字形がある絵文字はそちらを使わせる。
 * ZWJ でつないだもの・肌の色・キーキャップ・旗は付けると分解されるので、そのまま（CSS でグレーにする）
 */
const textPresentation = (s: string) =>
  /‍|⃣|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]/u.test(s)
    ? s
    : [...s.replace(/️/g, "")].map((c) => c + "︎").join("");

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
      {icon?.kind === "emoji" && (
        <>
          <span className="face-icon emoji color">{icon.value}</span>
          <span className="face-icon emoji mono">{textPresentation(icon.value)}</span>
        </>
      )}
      {label && <span className={`face-label ${icon ? "" : "only"}`}>{label}</span>}
      {sub && <span className="face-sub">{sub}</span>}
    </>
  );
}
