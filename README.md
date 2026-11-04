# SideDeck

[![CI](https://github.com/ken-ton/sidedeck/actions/workflows/ci.yml/badge.svg)](https://github.com/ken-ton/sidedeck/actions/workflows/ci.yml)

**English** — SideDeck is a Windows app that turns a touchscreen monitor attached to your PC (such as a portable display) into a full-screen, Stream Deck-style grid of buttons.
Buttons can launch apps and games, send keyboard shortcuts that reach games, control media and audio devices, manage windows, and run recorded macros.
Tapping a button never takes focus away from the active app or game, and pages can switch automatically based on the foreground application.
It can be extended with out-of-process plugins, and is built with Tauri (Rust) and React.

- Requirements: Windows 10 / 11 (x64)
- Download: the installer `SideDeck_<version>_x64-setup.exe` is on the [Releases](https://github.com/ken-ton/sidedeck/releases) page.
- Code signing: the installer is not signed, so Windows SmartScreen may show a warning.
- The rest of this README is in Japanese.

デスクトップ PC にタッチ対応モバイルモニターをつなぎ、
Stream Deck のような**タッチ操作のボタンパネル**として使うための Windows アプリです。
スマホやタブレットをネットワーク越しにつなぐのではなく、同じ PC につないだタッチモニターで動き、ゲームのフォーカスを奪いません。
Tauri 2（Rust）＋ React / TypeScript で作っています。

## 機能

- **Deck モード**: 指定したモニターにデッキ（ボタンのグリッド）を全画面で表示します。
  - プライマリや画面配置は変更しません。
  - **タップしても、作業中のアプリやゲームからフォーカスを奪いません**（`WS_EX_NOACTIVATE`）。
  - モニターを接続したら自動で Deck モードにすることもできます。
- **ボタンに割り当てられる操作**
  | 操作 | 内容 |
  |---|---|
  | 開く | アプリ（exe / lnk）、ファイル、フォルダ、URL（`steam://rungameid/…` を含む）。Steam / Epic のゲーム一覧からも選べます |
  | フォルダ | ボタンをまとめたフォルダを開きます |
  | ウィンドウ操作 | アプリを前面に出す（起動していなければ起動、複数ウィンドウは順に切替）、作業中のウィンドウを次 / 指定のモニターへ移動、最大化の切替、最小化 |
  | ショートカットキー | キーの組み合わせを送信します。**スキャンコードで送るので、ゲームにも届きます** |
  | 文字を入力 | 定型文を入力します |
  | マクロ | キーの押下・押し続け・解放、待ち時間、文字入力、ほかの操作を順に実行します。繰り返し回数も指定できます。実行中にもう一度タップすると止まります |
  | メディア操作 | 再生・一時停止、曲送り・曲戻し、停止、音量、ミュート |
  | 再生中の曲 | 再生中の曲名・アーティスト・ジャケット画像を表示し、タップで再生・一時停止します |
  | マイクのミュート | 既定のマイクのミュートを切り替えます。ミュート中はボタンが赤くなります |
  | 出力デバイスの切替 | 指定のデバイスに切り替える、または複数のデバイスを順番に切り替えます |
  | システムパネル | 音量、アプリごとの音量、明るさ（DDC/CI。非対応ならソフトウェア減光）、解像度、電源プラン |
  | PC の操作 | ロック、スリープ、画面をオフ、ごみ箱を空にする、スクリーンショット、画面の切り取り、サインアウト・再起動・シャットダウン（この 3 つは、もう一度タップしたときに実行します） |
  | タイマー | タイマー（残り時間を表示し、時間になったら点滅して音で知らせる）、ストップウォッチ |
  | サウンド | 音声ファイル（mp3・wav・ogg など）を再生する。再生中のタップで停止・最初から・重ねて再生を選べる |
  | OBS | シーンの切替、録画・配信・仮想カメラ・リプレイバッファの開始 / 停止、リプレイの保存、音声のミュート。状態に合わせてボタンの色が変わります（obs-websocket v5、OBS 28 以降） |
  | プラグイン | プラグインが追加した操作を実行します |
- **長押し**: 長押ししたときに、連打する、押している間キーを押し続ける、別の操作を実行する、から選べます。
- **トグル**: オンとオフで見た目と操作を切り替えるボタンにできます。
- **表示**: 時刻・日付・CPU / メモリ / GPU の使用率をボタンに表示できます。操作と組み合わせることも、表示だけのボタンにすることもできます。
- **自動化**: アプリが前面に来た / 離れた、決まった時刻（曜日指定）、SideDeck の起動、Deck モードの開始 / 終了、OBS の録画・配信の開始 / 終了をきっかけに、操作を自動で実行します（設定の「自動化」）。
- **マクロの記録**: ゲームなど、ほかのアプリでのキー操作を、待ち時間ごと記録してマクロにできます（記録している間だけ、低レベルキーボードフックを使います）。
- **グローバルショートカット**: どのアプリを使っていても、キーでデッキを前面に出す／下げる（既定は `Ctrl+Alt+D`）、またはボタンを実行できます。ほかのアプリや Windows と競合するキーは、記録時と保存後に注意を表示します。
- **ページ**: タブで切り替えます。ページは、中のフォルダごとファイルに書き出したり、ファイルから読み込んだりできます（編集モードでタブをタップ →「ファイルに書き出す」、タブの右の「ファイルから読み込む」）。
- **プロファイル自動切替**: ページにアプリ（プロセス名）を登録しておくと、そのアプリが前面に来たときにページを自動で切り替え、離れると元のページに戻ります。設定でまとめてオフにできます。
- **編集**: 「✎ 編集」から行います。ボタンをタップすると編集、空いている場所をタップすると追加です。ボタンをドラッグするか「移動」で並べ替え、「複製」「コピー」でボタンを複製できます（コピーしたボタンは、ほかのページにも貼り付けられます）。
  - アイコンには、絵文字・画像ファイル・アプリのアイコン（自動取得）を使えます。
  - ボタンの大きさは 1×1・横 2×1・縦 1×2・2×2 から選べます。
  - 編集中と設定画面を開いている間だけ、キーボード入力を受け付けます。
- **プラグイン**: 別のプロセスとして動くプラグインで、ボタンの操作を追加できます（下の「プラグイン」を参照）。
- タスクトレイに常駐し、トレイから Deck モードの開始と終了ができます。

## 動作環境

- Windows 10 / 11（x64）
- Microsoft Edge WebView2 ランタイム（Windows 11 には標準で入っています。Windows 10 で入っていない場合は、インストーラーがダウンロードします）

## インストール

[Releases](https://github.com/ken-ton/sidedeck/releases) から `SideDeck_<バージョン>_x64-setup.exe` をダウンロードして実行します。
管理者権限は不要で、現在のユーザーにインストールされます。
インストーラーにはコード署名がないため、Windows SmartScreen の警告が表示されることがあります。

## 使い方

1. ⚙（設定）で Deck 用モニターを選びます。モバイルモニターは EDID に名前がないことが多く、`RTK1920` のような製造者と製品のコードで表示されることがあります。
2. タッチがメインモニターに反応する場合は、設定の「タッチ画面のセットアップを開く」から、Deck 用モニターをタッチ画面として登録します。
3. 「Deck モードを開始」を押します。
4. 普段使いにするなら、設定で次の 2 つをオンにします。PC を起動するだけで、Deck 用モニターにデッキが表示されるようになります。
   - 「モニターを接続したら自動で Deck モードにする」
   - 「Windows の起動時に自動で起動する」（自動起動したときは、トレイに常駐した状態で始まります）

設定とボタンは `%APPDATA%\com.kenton.sidedeck\config.json` に保存されます。読み込めない場合は `config.broken-<日時>.json` という名前で残してから、初期状態で起動します。

## プラグイン

プラグインは、SideDeck とは別のプロセスとして動くプログラムです。`%APPDATA%\com.kenton.sidedeck\plugins\` にフォルダごと置き、設定の「プラグインを再読み込み」で読み込みます。

プラグインはパソコン上で自由に動けるプログラムなので、**信頼できるものだけを入れてください**。

作り方は [docs/plugins.md](docs/plugins.md)、最小の例は [examples/plugins/counter](examples/plugins/counter) にあります。

## 既知の制限

- **管理者権限で動くアプリやゲーム**には、キー入力を送れず、ウィンドウの移動や前面化もできないことがあります（Windows の UIPI による制限）。
- **出力デバイスの切替**は、Windows の非公開 API（`IPolicyConfig`）を使っています。将来の Windows 更新で動かなくなる可能性があります。
- 記号キーは US 配列の位置で指定します。JIS 配列では、刻印と違う記号が入力されることがあります。
- キーボードフックで入力を横取りするアプリ（PowerToys、AutoHotkey など）とのショートカットの競合は検出できません。
- ソフトウェア減光は、Windows の制限で 50% 程度までしか暗くできません。
- 解像度の変更は一時的なもので、再起動すると元に戻ります。

## 開発

### 必要なもの

- Rust（stable, MSVC）
- Visual Studio 2022 の「C++ によるデスクトップ開発」ワークロード（Windows SDK を含む）
- Node.js 22 以降

### ビルド

```sh
npm install
npm run tauri dev     # 開発版を起動
npm run tauri build   # インストーラーを作成（src-tauri/target/release/bundle/nsis/）
```

開発版とインストール版は同時には起動できません（後から起動した方は、先に起動している方のウィンドウを開くだけになります）。

### アイコン

アイコンの元画像は `assets/icon.svg` です。1024px の PNG に書き出してから、`npm run tauri icon <PNG のパス>` で `src-tauri/icons/` の各サイズを作り直します（Android / iOS 用に作られたフォルダは使わないので削除します）。

### テスト

```sh
cd src-tauri
cargo test                                # 単体テスト（CI でも実行）
cargo test -- --ignored --nocapture       # 実機のモニター・音声デバイス・アイコン取得などを読むスモークテスト
```

### リリースの手順

1. `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` のバージョンを上げます。`cargo build` を一度実行して `src-tauri/Cargo.lock` も更新し、まとめてコミットします。
2. `v<バージョン>` のタグ（例: `v0.2.3`）を付けて push します。
3. GitHub Actions がテストとビルドを行い、インストーラー付きのリリースを作成します。タグとバージョンが一致しないときは失敗します。

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

- SideDeck has no telemetry and does not check for updates by itself. It opens URLs (such as the links in Settings, or `https://` and `steam://` targets assigned to buttons) only when the user taps them.
- Plugins are separate programs that the user installs; they are not part of this program and are covered by their own policies.
- SideDeck renders its UI with Microsoft Edge WebView2, which is covered by the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).

## ライセンス

[MIT](LICENSE)
