import { contextBridge, ipcRenderer } from 'electron'

// レンダラー（Web 側）に安全な API のみを公開する
contextBridge.exposeInMainWorld('api', {
  // 音声ファイル選択ダイアログを開き、選択されたファイルパスを返す（キャンセル時は null）
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),

  // 「末尾にファイルを追加」用のファイル選択ダイアログを開き、選択されたファイルパスを返す（キャンセル時は null）
  openAppendFile: () => ipcRenderer.invoke('dialog:openAppendFile'),

  // 指定パスの音声を読み込み、波形描画用のピークデータと長さ(秒)を返す
  // 返り値: { peaks: number[], duration: number }
  loadAudio: (filePath) => ipcRenderer.invoke('audio:load', filePath),

  // 指定パスの音声を、現在の編集対象の末尾に連結する
  // 返り値: 連結後の { peaks: number[], duration: number }
  appendAudio: (filePath) => ipcRenderer.invoke('audio:append', filePath),

  // 選択範囲（[{start,end}, ...]）をまとめてカットする
  // 返り値: カット後の { peaks: number[], duration: number }
  cutRegions: (regions) => ipcRenderer.invoke('audio:cut', regions),

  // 音量を調整する。regions=空/null なら全体、[{start,end}, ...] 指定時はそれらの範囲のみ。
  // 返り値: 調整後の { peaks: number[], duration: number }
  adjustVolume: (factor, regions) => ipcRenderer.invoke('audio:volume', { factor, regions }),

  // アンドゥ／リドゥ：版を1つ戻す／進める。
  // 返り値: { peaks, duration, canUndo, canRedo, hasEdits }
  undo: () => ipcRenderer.invoke('audio:undo'),
  redo: () => ipcRenderer.invoke('audio:redo'),

  // 現在の編集結果を、保存ダイアログで選んだフォーマット/パスへ書き出す。
  // 編集が無くても、入力と違う形式を選べば形式変換として書き出せる。
  // 出力形式は MP3 / WAV / M4A / MP4（黒画面の動画）から選べる。
  // 返り値: 書き出した場合 { path, converted }（converted=true は形式変換のみの保存）、
  //         編集も形式変換も無く書き出さなかった場合 { unchanged: true }、
  //         キャンセル時 null（失敗時は例外）
  exportAudio: () => ipcRenderer.invoke('audio:export'),

  // --- 区切り線による分割書き出し ---

  // 分割書き出しダイアログの初期値
  // 返り値: { formats: [{ ext, label }], defaultExt, folder }
  getSplitOptions: () => ipcRenderer.invoke('split:options'),

  // 出力先フォルダを選ぶダイアログ。返り値: フォルダのパス / キャンセル時 null
  selectFolder: (defaultPath) => ipcRenderer.invoke('dialog:selectFolder', defaultPath),

  // 書き出すファイル名の一覧と、そのうち出力先にすでに存在するもの（上書き確認用）
  // 引数: { markers: number[]（区切り位置・秒）, ext, folder }
  // 返り値: { names: string[], existing: string[] }
  checkSplit: (options) => ipcRenderer.invoke('split:check', options),

  // 区切り位置で分割して書き出す。返り値: { folder, count }（失敗時は例外）
  runSplit: (options) => ipcRenderer.invoke('split:run', options),

  // 分割書き出しの進捗（何個中何個目か）を受け取る。返り値: 購読を解除する関数
  onSplitProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('split:progress', listener)
    return () => ipcRenderer.removeListener('split:progress', listener)
  },

  // --- 複数ファイルの一括結合（編集セッションとは独立した機能） ---

  // 結合するファイルの選択ダイアログ（複数選択）を開く
  // 返り値: string[]（選択されたパス）/ キャンセル時 null
  openConcatFiles: () => ipcRenderer.invoke('dialog:openConcatFiles'),

  // 結合候補のファイルを自然順に並べ、各ファイルの長さと合計を返す（確認ダイアログ用）
  // 返り値: { files: [{ path, name, duration }], totalDuration, limit }（失敗時は例外）
  inspectConcatFiles: (filePaths) => ipcRenderer.invoke('concat:inspect', filePaths),

  // 渡した順番どおりに結合し、保存ダイアログで選んだパス/形式へ書き出す
  // 返り値: { path, duration, fileCount, video }（video=true は MP4 で書き出した）、
  //         キャンセル時 null（失敗時は例外）
  runConcat: (filePaths) => ipcRenderer.invoke('concat:run', filePaths),

  // 結合中の進捗（何ファイル目を処理中か）を受け取る。
  // 返り値: 購読を解除する関数（結合が終わったら呼ぶ）
  onConcatProgress: (callback) => {
    const listener = (_event, progress) => callback(progress)
    ipcRenderer.on('concat:progress', listener)
    return () => ipcRenderer.removeListener('concat:progress', listener)
  }
})
