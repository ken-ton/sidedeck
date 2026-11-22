const FIRST_YEAR = 2007;
/** 春分・秋分の近似式が使える範囲 */
const LAST_YEAR = 2099;

const nthMonday = (year: number, month: number, n: number) => 1 + ((8 - new Date(year, month - 1, 1).getDay()) % 7) + (n - 1) * 7;

const equinox = (year: number, base: number) => Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));

/** 東京オリンピックの特例で移動した年（[海の日, 山の日, スポーツの日]） */
const MOVED: Record<number, [number, number][]> = {
  2020: [[7, 23], [8, 10], [7, 24]],
  2021: [[7, 22], [8, 8], [7, 23]],
};

const keyOf = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

const cache = new Map<number, Map<string, string>>();

function holidaysOf(year: number): Map<string, string> {
  const cached = cache.get(year);
  if (cached) return cached;
  const h = new Map<string, string>();
  cache.set(year, h);
  if (year < FIRST_YEAR || year > LAST_YEAR) return h;
  const add = (month: number, day: number, name: string) => h.set(`${month}/${day}`, name);
  const [sea, mountain, sports] = MOVED[year] ?? [[7, nthMonday(year, 7, 3)], [8, 11], [10, nthMonday(year, 10, 2)]];

  add(1, 1, "元日");
  add(1, nthMonday(year, 1, 2), "成人の日");
  add(2, 11, "建国記念の日");
  if (year >= 2020) add(2, 23, "天皇誕生日");
  add(3, equinox(year, 20.8431), "春分の日");
  add(4, 29, "昭和の日");
  add(5, 3, "憲法記念日");
  add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  add(sea[0], sea[1], "海の日");
  if (year >= 2016) add(mountain[0], mountain[1], "山の日");
  add(9, nthMonday(year, 9, 3), "敬老の日");
  add(9, equinox(year, 23.2488), "秋分の日");
  add(sports[0], sports[1], year >= 2020 ? "スポーツの日" : "体育の日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");
  if (year <= 2018) add(12, 23, "天皇誕生日");
  if (year === 2019) {
    add(5, 1, "即位の日");
    add(10, 22, "即位礼正殿の儀");
  }

  const national = [...h.keys()].map((k) => {
    const [month, day] = k.split("/").map(Number);
    return new Date(year, month - 1, day);
  });
  const isNational = new Set(h.keys());
  for (const d of national) {
    if (d.getDay() !== 0) continue;
    const sub = new Date(d);
    do sub.setDate(sub.getDate() + 1);
    while (isNational.has(keyOf(sub)));
    h.set(keyOf(sub), "振替休日");
  }
  for (const d of national) {
    const between = new Date(year, d.getMonth(), d.getDate() + 1);
    const after = new Date(year, d.getMonth(), d.getDate() + 2);
    if (isNational.has(keyOf(after)) && !h.has(keyOf(between))) h.set(keyOf(between), "国民の休日");
  }
  return h;
}

/** 日本の祝日・休日の名前。2007〜2099 年以外は判定しない */
export const holidayName = (d: Date): string | undefined => holidaysOf(d.getFullYear()).get(keyOf(d));
