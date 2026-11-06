import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { AssistantConfig, DEFAULT_ASSISTANT } from "./deck";
import { SentenceSplitter, Speaker } from "./speech";

export type AssistantStatus = "idle" | "listening" | "transcribing" | "thinking" | "speaking";

export type AssistantState = {
  status: AssistantStatus;
  /** 最後に話しかけた内容と、その返事 */
  heard: string;
  reply: string;
  error: string | null;
};

type ChatEvent =
  | { type: "text"; id: number; text: string }
  | { type: "done"; id: number; content: unknown[]; stopReason: string }
  | { type: "error"; id: number; message: string };

const SYSTEM_PROMPT = `あなたは SideDeck の音声アシスタントです。SideDeck は、PC の横に置いたタッチモニターをボタンのパネルとして使う Windows アプリです。
ユーザーはゲームや作業をしながら声で話しかけてきます。あなたの返事は音声で読み上げられ、小さな画面にも表示されます。
- 日本語の話し言葉で、短く答えてください。ふだんは 1〜3 文で十分です。詳しく聞かれたときだけ長く話してください。
- 読み上げるので、Markdown、箇条書き、表、記号、絵文字、URL は使わないでください。
- ユーザーの発言は音声認識の結果なので、聞き間違いが含まれることがあります。意図をくみ取って答え、分からなければ短く聞き返してください。
- 天気、ニュース、営業時間など、最新の情報が必要な質問にはウェブ検索を使ってください（使えるときだけ）。検索の結果を話すときも短くまとめ、サイト名や URL は読み上げないでください。
- ユーザーのメッセージの先頭に、今の日時と地域が添えてあります。「今日」「明日」「ここ」などはそれを基準にしてください。`;

/** これより間が空いたら、次に話しかけたときに新しい会話を始める */
const IDLE_RESET_MS = 10 * 60 * 1000;

let conf: AssistantConfig = DEFAULT_ASSISTANT;
let state: AssistantState = { status: "idle", heard: "", reply: "", error: null };
let messages: unknown[] = [];
/** 今のやり取りが始まる前の messages の長さ。失敗や取り消しのときはここまで戻す */
let turnStart = 0;
let lastAt = 0;
let chatId = 0;
/** 聞き取りの ID。取り消したら増やし、古い聞き取りの結果は捨てる */
let listenId = 0;
let streamDone = true;
const listeners = new Set<(s: AssistantState) => void>();

const set = (patch: Partial<AssistantState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
};

const speaker = new Speaker(
  () => conf,
  () => {
    if (streamDone && state.status === "speaking") set({ status: "idle" });
  },
  (error) => set({ error }),
);
let splitter = new SentenceSplitter((s) => speaker.speak(s));

let started = false;
function start() {
  if (started) return;
  started = true;
  listen("stt-transcribing", () => {
    if (state.status === "listening") set({ status: "transcribing" });
  });
  listen<ChatEvent>("assistant-chat", ({ payload: e }) => {
    if (e.id !== chatId) return;
    if (e.type === "text") {
      if (state.status === "thinking") set({ status: "speaking" });
      set({ reply: state.reply + e.text });
      splitter.push(e.text);
      return;
    }
    streamDone = true;
    if (e.type === "error") {
      messages.length = turnStart;
      speaker.stop();
      set({ status: "idle", error: e.message });
      return;
    }
    if (e.stopReason === "refusal") {
      // 拒否された返事は途中までのものも捨て、履歴からも外す
      messages.length = turnStart;
      speaker.stop();
      set({ status: "idle", reply: "", error: "この内容には答えられませんでした" });
      return;
    }
    messages.push({ role: "assistant", content: e.content });
    lastAt = Date.now();
    if (e.stopReason === "pause_turn") {
      // ウェブ検索などサーバー側のツールが回数の上限に達した。そのまま送り直すと続きから再開する
      streamDone = false;
      request();
      return;
    }
    splitter.flush();
    if (!speaker.busy) set({ status: "idle" });
    else if (state.status === "thinking") set({ status: "speaking" });
  });
}

function context() {
  const now = new Date().toLocaleString("ja-JP", { dateStyle: "full", timeStyle: "short" });
  return conf.city.trim() ? `（今は ${now}。地域: ${conf.city.trim()}）` : `（今は ${now}）`;
}

function request() {
  const system = conf.instructions.trim() ? `${SYSTEM_PROMPT}\n\nユーザーからの追加の指示:\n${conf.instructions.trim()}` : SYSTEM_PROMPT;
  const region = new Intl.Locale(navigator.language).maximize().region ?? "";
  const webSearch = conf.webSearch ? { city: conf.city.trim(), country: region, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : null;
  api.assistantChat(chatId, conf.model, system, messages, webSearch).catch((e) => {
    messages.length = turnStart;
    streamDone = true;
    set({ status: "idle", error: String(e) });
  });
}

export const assistant = {
  get state() {
    return state;
  },
  subscribe(l: (s: AssistantState) => void) {
    start();
    listeners.add(l);
    l(state);
    return () => void listeners.delete(l);
  },
  configure(c: AssistantConfig | undefined) {
    conf = { ...DEFAULT_ASSISTANT, ...c };
  },

  /** 待機中なら聞き取りを始め、それ以外なら今していることを止める */
  async tap() {
    start();
    switch (state.status) {
      case "listening":
        api.assistantStopListening(listenId).catch(() => {});
        return;
      case "transcribing":
        return;
      case "thinking":
        chatId++;
        streamDone = true;
        api.assistantCancel().catch(() => {});
        messages.length = turnStart;
        set({ status: "idle" });
        return;
      case "speaking":
        // 返事の受信は続けて履歴には残し、読み上げだけ止める
        speaker.stop();
        splitter = new SentenceSplitter(() => {});
        set({ status: streamDone ? "idle" : "thinking" });
        return;
    }
    const id = ++listenId;
    set({ status: "listening", error: null });
    let text: string;
    try {
      text = (await api.assistantListen(conf.inputDevice, conf.whisperModel, id)).trim();
    } catch (e) {
      if (id === listenId) set({ status: "idle", error: String(e) });
      return;
    }
    // 文字にしている間にリセットされた
    if (id !== listenId) return;
    if (!text) {
      set({ status: "idle" });
      return;
    }
    this.send(text);
  },

  send(text: string) {
    if (Date.now() - lastAt > IDLE_RESET_MS) messages = [];
    turnStart = messages.length;
    messages.push({ role: "user", content: [{ type: "text", text: context() }, { type: "text", text }] });
    chatId++;
    streamDone = false;
    splitter = new SentenceSplitter((s) => speaker.speak(s));
    set({ status: "thinking", heard: text, reply: "", error: null });
    request();
  },

  reset() {
    chatId++;
    streamDone = true;
    api.assistantCancel().catch(() => {});
    api.assistantStopListening(listenId).catch(() => {});
    listenId++;
    speaker.stop();
    messages = [];
    set({ status: "idle", heard: "", reply: "", error: null });
  },
};

// 会話の状態をモジュールに持つので、差し替えると表示と処理が別のインスタンスを見てしまう。開発中は画面ごと読み直す
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
