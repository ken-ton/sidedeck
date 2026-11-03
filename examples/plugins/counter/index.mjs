// win-deck のプラグインの最小例。Node.js 22 以降（組み込みの WebSocket を使う）。
const { WINDECK_PORT, WINDECK_TOKEN, WINDECK_PLUGIN_ID } = process.env;
const ws = new WebSocket(`ws://127.0.0.1:${WINDECK_PORT}/`);
const send = (msg) => ws.send(JSON.stringify(msg));
const counts = new Map();

const FRUITS = {
  blue: ["ブルーベリー", "ぶどう"],
  red: ["りんご", "いちご", "さくらんぼ"],
};

ws.onopen = () => send({ event: "register", pluginId: WINDECK_PLUGIN_ID, token: WINDECK_TOKEN });
ws.onclose = () => process.exit(0);

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.event) {
    case "buttons":
      for (const b of msg.buttons) {
        send({ event: "setState", context: b.context, title: String(counts.get(b.context) ?? 0), sub: b.settings.fruit ?? null });
      }
      break;
    case "keyDown": {
      const step = Number(msg.settings.step ?? 1) * (msg.settings.down ? -1 : 1);
      const n = (counts.get(msg.context) ?? 0) + step;
      counts.set(msg.context, n);
      if (n < 0) {
        send({ event: "showAlert", context: msg.context, message: "0 より小さくなりました" });
      }
      send({
        event: "setState",
        context: msg.context,
        title: String(n),
        state: n >= 10 ? (msg.settings.color === "red" ? "alert" : "active") : "normal",
      });
      send({ event: "log", message: `count ${msg.context} -> ${n}` });
      break;
    }
    case "getOptions":
      if (msg.source === "fruits") {
        const list = FRUITS[msg.settings.color ?? "blue"] ?? [];
        send({ event: "options", requestId: msg.requestId, options: list.map((label) => ({ value: label, label })) });
      } else {
        send({ event: "options", requestId: msg.requestId, error: `不明な選択肢: ${msg.source}` });
      }
      break;
  }
};
