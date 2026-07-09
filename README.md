# 音声編集アプリ

波形を見ながら不要な部分をカットし、音量を調整して書き出すための、Windows 向けデスクトップ音声編集アプリケーションです。
（要件の詳細は [REQUIREMENTS.md](./REQUIREMENTS.md) を参照してください。）

## 開発状況

段階的に開発を進めています。

- **ステップ1（現在）**: Electron + Vite でプロジェクトの土台を構築。アプリのウィンドウが起動し、「ファイルを開く」ボタンから MP3 / WAV / M4A ファイルを選択するダイアログを表示できるところまで。
  - 波形表示・カット・音量調整・書き出し機能はまだ実装していません。

## 技術スタック

- [Electron](https://www.electronjs.org/) — デスクトップアプリ基盤
- [Vite](https://vitejs.dev/) / [electron-vite](https://electron-vite.org/) — ビルド・開発サーバー
- [electron-builder](https://www.electron.build/) — Windows インストーラー（NSIS）生成

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
│   ├── main/                 # メインプロセス（ウィンドウ生成・ファイルダイアログ）
│   │   └── index.js
│   ├── preload/              # プリロード（レンダラーへ安全に API を公開）
│   │   └── index.js
│   └── renderer/             # 画面（UI）
│       ├── index.html
│       ├── main.js
│       └── style.css
├── REQUIREMENTS.md           # 要件定義書
└── README.md
```
