# プラグイン

SideDeck のプラグインは、SideDeck とは別のプロセスとして動くプログラムです。
SideDeck が起動し、ローカルの WebSocket で通信します。言語は問いません。

## 置き場所

```
%APPDATA%\com.kenton.sidedeck\plugins\<任意のフォルダ名>\
  manifest.json
  （プラグイン本体のファイル）
  plugin.log      … SideDeck が書き込む（標準出力・標準エラー出力と log イベント）
```

SideDeck の起動時、または設定画面の「プラグインを再読み込み」で読み込まれます。

## manifest.json

```json
{
  "id": "com.example.counter",
  "name": "カウンター",
  "version": "1.0.0",
  "command": "node",
  "args": ["index.mjs"],
  "actions": [
    {
      "id": "count",
      "name": "数える",
      "description": "押すたびに数が増えます",
      "fields": [
        { "key": "step", "label": "増やす数", "type": "number", "default": 1 },
        { "key": "label", "label": "表示名", "type": "text" },
        { "key": "down", "label": "減らす", "type": "checkbox" },
        { "key": "color", "label": "色", "type": "select",
          "options": [{ "value": "red", "label": "赤" }, { "value": "blue", "label": "青" }] },
        { "key": "item", "label": "項目", "type": "select", "optionsFrom": "items", "dependsOn": ["color"] }
      ]
    }
  ]
}
```

| キー | 内容 |
|---|---|
| `id` | プラグインの識別子。ほかのプラグインと重ならない文字列 |
| `command` / `args` | 起動するコマンド。`command` がプラグインのフォルダ内にあればそれを、なければ PATH から探します。作業ディレクトリはプラグインのフォルダです |
| `actions[].fields` | ボタンの編集画面に出す設定項目。`type` は `text` / `number` / `checkbox` / `select` |
| `options` | `select` の固定の選択肢 |
| `optionsFrom` | `select` の選択肢をプラグインに問い合わせるときの名前（下の `getOptions`） |
| `dependsOn` | この項目の選択肢が依存する、ほかの項目の `key`。それらが変わると選択肢を取り直します |

設定値は、ボタンごとに `settings`（`key` → 値）として保存されます。

## 接続

SideDeck は、次の環境変数を付けてプロセスを起動します。

| 環境変数 | 内容 |
|---|---|
| `SIDEDECK_PORT` | 接続先のポート（`ws://127.0.0.1:<port>/`） |
| `SIDEDECK_TOKEN` | 登録に使うトークン |
| `SIDEDECK_PLUGIN_ID` | manifest の `id` |
接続したら、最初に次を送ります。トークンが違うと切断されます。

```json
{ "event": "register", "pluginId": "<SIDEDECK_PLUGIN_ID>", "token": "<SIDEDECK_TOKEN>" }
```

プロセスが終了すると、SideDeck は 2 秒後に起動し直します（1 分間に 3 回まで）。
SideDeck が終了すると、プラグインのプロセスも終了します（Job Object）。

## SideDeck → プラグイン

### buttons
このプラグインの操作が割り当てられたボタンの一覧です。登録の直後と、ボタンが変わるたびに送ります。

```json
{ "event": "buttons", "buttons": [
  { "pluginId": "com.example.counter", "context": "<ボタンの id>", "action": "count", "settings": { "step": 1 } }
] }
```

### keyDown
ボタンが押されたとき（グローバルショートカットやマクロから実行されたときも含む）。マクロから実行された場合、`context` は空文字です。

```json
{ "event": "keyDown", "context": "<ボタンの id>", "action": "count", "settings": { "step": 1 } }
```

### getOptions
編集画面で `optionsFrom` の選択肢が必要になったとき。8 秒以内に `options` で返事をしてください。

```json
{ "event": "getOptions", "requestId": "…", "source": "items", "settings": { "color": "red" } }
```

## プラグイン → SideDeck

### options（getOptions への返事）

```json
{ "event": "options", "requestId": "…", "options": [
  { "value": 1, "label": "りんご", "group": "果物" }
] }
```
失敗したときは `"error": "理由"` を付けて返すと、編集画面に表示されます。

### setState
ボタンの見た目を変えます。省略した項目は変わりません。`null` を送ると元に戻ります（ボタンに設定された名前・アイコンを使います）。

```json
{ "event": "setState", "context": "<ボタンの id>",
  "title": "3", "icon": "data:image/png;base64,…", "sub": "補足", "state": "active" }
```
`state` は `normal` / `active`（青い枠）/ `alert`（赤）。
`icon` は `data:image/…` の URL だけを受け付けます。外部の URL は表示しません。

### showAlert
ボタンを失敗の表示にして、メッセージを出します。

```json
{ "event": "showAlert", "context": "<ボタンの id>", "message": "接続していません" }
```

### log
`plugin.log` に 1 行書きます。

```json
{ "event": "log", "message": "…" }
```

## 例

`examples/plugins/counter` に、ビルド不要の最小のプラグイン（Node.js）があります。
フォルダごと `%APPDATA%\com.kenton.sidedeck\plugins\` にコピーすると使えます。
