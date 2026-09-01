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
  // 返り値: 書き出した場合 { path, converted }（converted=true は形式変換のみの保存）、
  //         編集も形式変換も無く書き出さなかった場合 { unchanged: true }、
  //         キャンセル時 null（失敗時は例外）
  exportAudio: () => ipcRenderer.invoke('audio:export')
})
