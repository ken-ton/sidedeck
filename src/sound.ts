import { invoke } from "@tauri-apps/api/core";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
};

/** パスごとに読み込んだ Blob URL。ファイルを差し替えたときは試聴か再起動で読み直す */
const urls = new Map<string, Promise<string>>();
const playing = new Map<string, Set<HTMLAudioElement>>();
const listeners = new Set<(ids: Set<string>) => void>();

const notify = () => {
  const ids = new Set([...playing].filter(([, s]) => s.size).map(([id]) => id));
  listeners.forEach((l) => l(ids));
};

export const onSoundsChange = (l: (ids: Set<string>) => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function load(path: string, fresh: boolean) {
  const cached = urls.get(path);
  if (cached && !fresh) return cached;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const p = invoke<ArrayBuffer>("read_sound", { path }).then((buf) =>
    URL.createObjectURL(new Blob([buf], { type: MIME[ext] ?? "" })),
  );
  urls.set(path, p);
  p.catch(() => urls.delete(path));
  return p;
}

export function stopSounds(id?: string) {
  for (const [key, set] of playing) {
    if (id !== undefined && key !== id) continue;
    set.forEach((a) => a.pause());
    set.clear();
  }
  notify();
}

export async function playSound(id: string, path: string, volume: number, fresh = id.startsWith("__")) {
  const audio = new Audio(await load(path, fresh));
  audio.volume = Math.min(1, Math.max(0, volume / 100));
  const set = playing.get(id) ?? new Set();
  playing.set(id, set);
  const done = () => {
    set.delete(audio);
    notify();
  };
  audio.addEventListener("ended", done);
  audio.addEventListener("pause", done);
  set.add(audio);
  notify();
  try {
    await audio.play();
  } catch (e) {
    done();
    throw new Error(`再生できません: ${e instanceof Error ? e.message : e}`);
  }
}
