# 音声編集アプリ

波形を見ながら不要な部分をカットし、音量を調整して書き出すための、Windows 向けデスクトップ音声編集アプリケーションです。
（要件の詳細は [REQUIREMENTS.md](./REQUIREMENTS.md) を参照してください。）

## 開発状況

段階的に開発を進めています。

- **ステップ1**: Electron + Vite でプロジェクトの土台を構築。アプリのウィンドウが起動し、「ファイルを開く」ボタンから MP3 / WAV / M4A ファイルを選択するダイアログを表示できるところまで。
- **ステップ2（現在）**: 波形表示（要件4.1）を実装。
  - wavesurfer.js による波形表示（MP3 / WAV / M4A 対応）
  - 再生・一時停止・停止
  - 波形クリックによるシーク（再生位置の移動）
  - 再生位置を示すプレイヘッド（カーソル）の表示
  - カット・音量調整・書き出し機能はまだ実装していません。

### 長尺（最長3時間）音声への対応方針

要件5.1のとおり、最長3時間の音声を扱ってもメモリが破綻しない設計にしています。

- **波形はピークデータで描画**: 音声ファイル全体をメモリに展開せず、メインプロセスで ffmpeg により 8kHz モノラルへダウンサンプリングしながら PCM をストリーム処理し、**固定本数（8000点）のピーク配列**へ集約します。ファイルの長さに関わらずピーク配列のサイズは一定で、処理中に保持するのは小さなチャンクとピーク配列のみです。
- **再生はストリーミング**: 波形描画時はファイル全体のデコードを行いません。再生はカスタムプロトコル（`app-audio://`）＋ HTTP Range で必要な範囲だけを配信するため、`<audio>` 要素がファイル全体を読み込むことなくストリーム再生・シークできます。

### M4A の読み込みについて

- **波形（ピーク）生成**: ブラウザ標準（Web Audio API の `decodeAudioData`）は M4A をデコードできますが、ファイル全体をメモリ上の AudioBuffer に展開するため長尺では破綻します。そこで **ffmpeg（`ffmpeg-static`）でストリームデコードしてピークを生成**します。
- **再生**: Electron に同梱される Chromium は AAC/M4A を標準再生できるため、`<audio>` 要素でそのまま再生します。

## 技術スタック

- [Electron](https://www.electronjs.org/) — デスクトップアプリ基盤
- [Vite](https://vitejs.dev/) / [electron-vite](https://electron-vite.org/) — ビルド・開発サーバー
- [wavesurfer.js](https://wavesurfer.xyz/) — 波形表示・再生・シーク
- [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) / [ffprobe-static](https://github.com/joshwnj/node-ffprobe-static) — 波形用ピークの生成（M4A デコード・長さ取得）
- [electron-builder](https://www.electron.build/) — Windows インストーラー（NSIS）生成

> **補足**: `npm install` 時に `ffmpeg-static` / `ffprobe-static` が ffmpeg / ffprobe バイナリを自動ダウンロードします。インターネット接続のある環境で `npm install` を実行してください（バイナリ取得後はオフラインで動作します）。

---

## Windows PC でのセットアップ手順

### 1. 前提ソフトウェアのインストール

以下を事前にインストールしておいてください。

- **[Node.js](https://nodejs.org/)**（LTS 版、v20 以上を推奨）
  - インストーラーに同梱される **npm** も一緒に入ります。
- **[Git](https://git-scm.com/download/win)**（リポジトリを取得する場合）

インストール後、コマンドプロンプト（または PowerShell）で以下を実行し、バージョンが表示されることを確認します。

```bat
node -v
npm -v
```

### 2. ソースコードの取得

Git を使う場合:

```bat
git clone <このリポジトリのURL>
cd audio-editor
```

（ZIP をダウンロードした場合は、展開したフォルダへ `cd` で移動してください。）

### 3. 依存パッケージのインストール

プロジェクトのフォルダ内で以下を実行します。

```bat
npm install
```

> 初回は Electron 本体などのダウンロードが行われるため、完了まで数分かかることがあります。

### 4. アプリの起動（開発モード）

```bat
npm run dev
```

しばらくするとアプリのウィンドウが起動します。
「ファイルを開く」ボタンを押すと、MP3 / WAV / M4A ファイルを選択するダイアログが表示されます。

---

## その他のコマンド

| コマンド | 説明 |
| --- | --- |
| `npm run dev` | 開発モードでアプリを起動（ホットリロード対応） |
| `npm run build` | レンダラー・メイン・プリロードをビルド（`out/` へ出力） |
| `npm start` | ビルド済みのアプリをプレビュー起動 |
| `npm run build:win` | Windows 用インストーラー（NSIS `.exe`）を `dist/` に生成 |

## プロジェクト構成

```
audio-editor/
├── electron.vite.config.js   # electron-vite の設定
├── electron-builder.yml      # Windows インストーラーの設定
├── src/
│   ├── main/                 # メインプロセス
│   │   ├── index.js          #   ウィンドウ生成・ファイルダイアログ・音声ストリーム配信
│   │   └── peaks.js          #   ffmpeg による波形ピーク生成（メモリ安全なストリーム処理）
│   ├── preload/              # プリロード（レンダラーへ安全に API を公開）
│   │   └── index.js
│   └── renderer/             # 画面（UI）
│       ├── index.html
│       ├── main.js           #   波形表示・再生コントロール
│       └── style.css
├── REQUIREMENTS.md           # 要件定義書
└── README.md
```
