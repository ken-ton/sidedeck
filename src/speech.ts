import { api } from "./api";
import type { AssistantConfig } from "./deck";

/** 読み上げると不自然になる記号・URL・絵文字を取り除く */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*#`>|_~]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const japaneseVoices = () => speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("ja"));

/** 声の一覧は非同期に読み込まれるので、そろうまで待つ */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = japaneseVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(japaneseVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    window.setTimeout(done, 2000);
  });
}

/**
 * 一文ずつ順番に読み上げる。VOICEVOX は前の文を再生している間に次の文を合成しておく。
 * stop() すると、それまでに入れた文はすべて捨てる。
 */
export class Speaker {
  private generation = 0;
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();
  private audio: HTMLAudioElement | null = null;

  constructor(
    private conf: () => AssistantConfig,
    private onIdle: () => void,
    private onError: (msg: string) => void,
  ) {}

  get busy() {
    return this.pending > 0;
  }

  speak(text: string) {
    const t = speakable(text);
    const conf = this.conf();
    if (!t || conf.voice === "none") return;
    const gen = this.generation;
    this.pending++;
    const finish = () => {
      if (gen !== this.generation) return;
      this.pending--;
      if (this.pending === 0) this.onIdle();
    };
    if (conf.voice === "windows") {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = "ja-JP";
      u.volume = conf.voiceVolume / 100;
      const voice = japaneseVoices().find((v) => v.voiceURI === conf.windowsVoice) ?? japaneseVoices()[0];
      if (voice) u.voice = voice;
      u.onend = finish;
      u.onerror = (e) => {
        if (e.error !== "canceled" && e.error !== "interrupted") this.onError(`読み上げられませんでした（${e.error}）`);
        finish();
      };
      speechSynthesis.speak(u);
      return;
    }
    if (conf.voicevoxSpeaker == null) {
      this.onError("設定で VOICEVOX の声を選んでください");
      finish();
      return;
    }
    const wav = api.voicevoxSynthesize(conf.voicevoxUrl, conf.voicevoxSpeaker, t);
    this.chain = this.chain.then(async () => {
      try {
        const buf = await wav;
        if (gen !== this.generation) return;
        const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
        const audio = new Audio(url);
        audio.volume = this.conf().voiceVolume / 100;
        this.audio = audio;
        await new Promise<void>((resolve) => {
          audio.onended = audio.onpause = audio.onerror = () => resolve();
          audio.play().catch(() => resolve());
        });
        URL.revokeObjectURL(url);
      } catch (e) {
        if (gen === this.generation) this.onError(String(e));
      } finally {
        finish();
      }
    });
  }

  stop() {
    this.generation++;
    this.pending = 0;
    speechSynthesis.cancel();
    this.audio?.pause();
    this.audio = null;
    this.chain = Promise.resolve();
  }
}

/** ストリーミングで届く文章を、句点や改行で一文ずつ取り出す */
export class SentenceSplitter {
  private buf = "";
  constructor(private onSentence: (s: string) => void) {}

  push(delta: string) {
    this.buf += delta;
    for (;;) {
      const m = this.buf.match(/[。！？!?\n]/);
      if (!m || m.index === undefined) break;
      const s = this.buf.slice(0, m.index + 1);
      this.buf = this.buf.slice(m.index + 1);
      if (s.trim()) this.onSentence(s);
    }
  }

  flush() {
    if (this.buf.trim()) this.onSentence(this.buf);
    this.buf = "";
  }
}
