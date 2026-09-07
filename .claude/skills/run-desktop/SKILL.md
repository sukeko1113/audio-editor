---
name: run-desktop
description: Build, run, and drive the audio-editor Electron desktop app. Use when asked to start the app, take a screenshot of it, click through its UI, or verify a change in the real app rather than in tests.
---

音声編集アプリは Electron のデスクトップアプリです。headless Linux（コンテナ）では
`.claude/skills/run-desktop/driver.mjs` の REPL を xvfb 上で動かして操作します。

起動は数秒かかるので、操作のたびに立ち上げ直さずに済む REPL の形にしています。
パスはすべてリポジトリのルートからの相対です。

## 前提

```bash
apt-get install -y xvfb          # Electron の共有ライブラリは Ubuntu 24.04 に揃っている
npm install                      # playwright-core（devDependency）と electron が入る
npm run build                    # main は out/main/index.js。ビルドしないと真っ白な窓になる
```

## 起動（エージェント向け）

tmux に包んで send-keys でコマンドを送り、capture-pane で結果を読みます。

```bash
tmux new-session -d -s app -x 220 -y 50
tmux send-keys -t app 'xvfb-run -a node .claude/skills/run-desktop/driver.mjs' Enter
timeout 30 bash -c 'until tmux capture-pane -t app -p | grep -q "driver>"; do sleep 0.3; done'
tmux send-keys -t app 'launch' Enter
timeout 90 bash -c 'until tmux capture-pane -t app -p | grep -qE "launched\.|ERROR"; do sleep 0.5; done'
tmux send-keys -t app 'ss 01-startup' Enter
tmux capture-pane -t app -p | tail -10
```

スクリーンショットは `/tmp/shots/` に出ます（`SCREENSHOT_DIR` で変更可）。
**撮ったら必ず画像を開いて中身を見ること。** 真っ黒／真っ白なら起動に失敗しています。

### コマンド

| command | 内容 |
| --- | --- |
| `launch` | アプリを起動し、ツールバーが出るまで待つ |
| `ss [name]` | スクリーンショット → `/tmp/shots/<name>.png` |
| `click <css>` | DOM の click()。`OK` / `NOT_FOUND` / `DISABLED` を返す |
| `wait <css>` | 要素が出るまで待つ（30秒） |
| `wait-status <文字列>` | ステータス行に文字列が出るまで待つ（180秒）。ffmpeg 処理の完了待ち |
| `eval <js>` | ページ側で評価して JSON で表示 |
| `text [css]` | innerText を表示 |
| `stub-open <path...>` | 次のファイル選択ダイアログの戻り値を固定（複数可・空でキャンセル） |
| `stub-save <path>` | 次の保存ダイアログの戻り値を固定（空でキャンセル） |
| `spy-dialogs` | ダイアログに渡された引数（フィルタ・既定ファイル名）を記録し始める |
| `dialog-log` | 記録した内容を JSON で表示 |
| `quit` | アプリを閉じて終了 |

### 典型的な流れ：ファイルを開いて保存する

```bash
send() { tmux send-keys -t app "$1" Enter; }
waitfor() { timeout ${2:-60} bash -c "until tmux capture-pane -t app -p | grep -qE \"$1\"; do sleep 0.3; done"; }

send 'stub-open /path/to/input.wma';  waitfor "stub-open ->"
send 'click #open-file-btn';          waitfor "click #open-file-btn ->"
send 'wait-status input.wma';         waitfor "status:|TIMEOUT"
send 'stub-save /tmp/out.mp3';        waitfor "stub-save ->"
send 'click #save-btn';               waitfor "click #save-btn ->"
send 'wait-status 保存しました';       waitfor "status: 保存しました|TIMEOUT"
```

一括結合なら `stub-open` に複数パスを渡して `#concat-files-btn` → `#concat-run-btn`、
保存後の「開きますか？」は `#confirm-yes-btn` / `#confirm-no-btn`。

主なセレクタ: `#open-file-btn` `#append-file-btn` `#concat-files-btn` `#save-btn`
`#play-btn` `#pause-btn` `#stop-btn` `#cut-btn` `#undo-btn` `#redo-btn` `#status`
`#time` `#concat-overlay` `#concat-list` `#concat-run-btn` `#confirm-overlay`

## 起動（人間向け）

```bash
npm run dev     # Vite の dev サーバー＋Electron。GUI のある環境でのみ意味がある
```

## Gotchas

- **ファイルダイアログはネイティブなので headless では操作できない。** `stub-open` /
  `stub-save` がメインプロセスの `dialog.showOpenDialog` / `showSaveDialog` を
  `app.evaluate()` で差し替えて回避する。これ無しでは開くボタンを押した時点で固まる。
- **`spy-dialogs` は `stub-open` / `stub-save` の「あと」に実行する。** spy は
  「いま入っている実装」を包む作りなので、先に spy を掛けると stub に上書きされて
  記録が残らない（`dialog-log` が空になる）。
- **wavesurfer の `<audio>` 要素は DOM に挿さらない。** `document.querySelector('audio')`
  は null。再生の確認は `#time` の表示が進むかで見る:
  `eval new Promise(r=>{const t=()=>document.getElementById("time").textContent;document.getElementById("play-btn").click();setTimeout(()=>r(t()),800)})`
- **`--no-sandbox` が要る。** コンテナには CAP_SYS_ADMIN が無く Electron の
  サンドボックスが動かない（driver.mjs が指定済み）。
- **ビルドしていないと真っ白な窓が出る。** `package.json` の main は `out/main/index.js`。
  driver は起動前に存在を確認してエラーを出す。
- **読み込み・カット・結合・保存は ffmpeg を回すので時間がかかる。** 完了は
  ステータス行に出るので `wait-status` で待つ。固定の sleep では足りないことがある。

## Troubleshooting

- **「Missing X server」** → `xvfb-run` を付け忘れている。
- **Xvfb のロックが残っている** → `rm -f /tmp/.X*-lock; pkill Xvfb`
- **launch が 45 秒でタイムアウト** → `npm run build` を実行したか確認する。
- **tmux のセッションが残っている** → `tmux kill-session -t app`

## Windows インストーラー（参考）

`npm run build:win` で NSIS インストーラーを `release/` に作ります。
Linux からクロスビルドする場合は wine の用意と **Windows 用 ffmpeg の取り直しが必須**です
（取り直さないと Linux バイナリが同梱され、Windows 上で ffmpeg 処理が全部失敗します）。
手順は README の「Windows インストーラーのビルド」を参照してください。
