import { useEffect, useState } from "react";
import { WEEKDAYS } from "./deck";
import { holidayName } from "./holidays";

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function useToday() {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setToday((prev) => (sameDay(prev, new Date()) ? prev : new Date())), 30_000);
    return () => clearInterval(t);
  }, []);
  return today;
}

const dayClass = (d: Date) => (d.getDay() === 0 || holidayName(d) ? " sun" : d.getDay() === 6 ? " sat" : "");

const daysOf = (year: number, month: number) => Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => new Date(year, month, i + 1));

/** ボタンの中にも置くので、要素は span だけにする */
function MonthGrid({ year, month, today }: { year: number; month: number; today: Date }) {
  const days = daysOf(year, month);
  return (
    <span className="cal-grid">
      {[...WEEKDAYS].map((w, i) => (
        <span key={w} className={`cal-weekday${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>
          {w}
        </span>
      ))}
      {days.map((d) => (
        <span
          key={d.getDate()}
          className={`cal-day${dayClass(d)}${sameDay(d, today) ? " today" : ""}`}
          style={d.getDate() === 1 ? { gridColumnStart: d.getDay() + 1 } : undefined}
        >
          {d.getDate()}
        </span>
      ))}
    </span>
  );
}

export function CalendarFace() {
  const today = useToday();
  return (
    <span className="cal-face">
      <span className="cal-title">
        {today.getFullYear()}年 {today.getMonth() + 1}月
      </span>
      <MonthGrid year={today.getFullYear()} month={today.getMonth()} today={today} />
    </span>
  );
}

export default function CalendarPanel({ months, onClose }: { months: number; onClose: () => void }) {
  const today = useToday();
  const [offset, setOffset] = useState(0);
  const count = Math.min(3, Math.max(1, months));
  const shown = Array.from({ length: count }, (_, i) => new Date(today.getFullYear(), today.getMonth() + offset + i, 1));
  return (
    <div className="overlay center" onClick={onClose}>
      <div className="sheet" style={{ width: `min(${count * 400 + 44}px, calc(100% - 32px))` }} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>カレンダー</h1>
          <div className="cal-nav">
            <button onClick={() => setOffset(offset - 1)} aria-label="前の月">
              ◀
            </button>
            <button className={offset === 0 ? "on" : ""} onClick={() => setOffset(0)}>
              今月
            </button>
            <button onClick={() => setOffset(offset + 1)} aria-label="次の月">
              ▶
            </button>
            <button className="close" onClick={onClose} aria-label="閉じる">
              ✕
            </button>
          </div>
        </div>
        <div className="cal-months">
          {shown.map((first) => {
            const year = first.getFullYear();
            const month = first.getMonth();
            const holidays = daysOf(year, month).filter((d) => holidayName(d));
            return (
              <div key={`${year}-${month}`} className="cal-month">
                <h2>
                  {year}年 {month + 1}月
                </h2>
                <MonthGrid year={year} month={month} today={today} />
                <ul className="cal-holidays">
                  {holidays.map((d) => (
                    <li key={d.getDate()}>
                      <span>
                        {d.getDate()}日（{WEEKDAYS[d.getDay()]}）
                      </span>
                      {holidayName(d)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
