import type { ReactNode } from "react";
import type { DeckButton } from "./deck";

/**
 * U+FE0E を付けて、白黒の字形がある絵文字はそちらを使わせる。
 * ZWJ でつないだもの・肌の色・キーキャップ・旗は付けると分解されるので、そのまま（CSS でグレーにする）
 */
const textPresentation = (s: string) =>
  /‍|⃣|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]/u.test(s)
    ? s
    : [...s.replace(/️/g, "")].map((c) => c + "︎").join("");

/**
 * override はプラグインからの表示（null / 未指定ならボタンの設定を使う）。
 * table なら名前の各行を「見出し 値」の表に並べ（CPU / メモリ / GPU をまとめた表示など）、
 * lineColors はその各行の見出しの色（背景のグラフの凡例）
 */
export default function ButtonFace({ button, sub, override, background, table, lineColors }: {
  button: DeckButton;
  sub?: string | null;
  override?: { title?: string | null; icon?: string | null };
  background?: ReactNode;
  table?: boolean;
  lineColors?: string[];
}) {
  const label = override?.title ?? button.label;
  const icon = override?.icon ? ({ kind: "image", src: override.icon } as const) : button.icon;
  return (
    <>
      {background}
      {icon?.kind === "image" && <img className="face-icon" src={icon.src} alt="" draggable={false} />}
      {icon?.kind === "emoji" && (
        <>
          <span className="face-icon emoji color">{icon.value}</span>
          <span className="face-icon emoji mono">{textPresentation(icon.value)}</span>
        </>
      )}
      {label && table && label.includes("\n") ? (
        <span className={`face-label multi ${icon ? "" : "only"}`}>
          {label.split("\n").map((line, i) => {
            const at = line.indexOf(" ");
            return at < 0 ? (
              <span key={i} className="multi-value">{line}</span>
            ) : (
              <span key={i} className="multi-row">
                <span style={lineColors?.[i] ? { color: lineColors[i], opacity: 1 } : undefined}>{line.slice(0, at)}</span>
                <span className="multi-value">{line.slice(at + 1)}</span>
              </span>
            );
          })}
        </span>
      ) : (
        label && <span className={`face-label ${icon ? "" : "only"}`}>{label}</span>
      )}
      {sub && <span className="face-sub">{sub}</span>}
    </>
  );
}
