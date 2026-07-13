import { contextBridge, ipcRenderer } from 'electron'

// レンダラー（Web 側）に安全な API のみを公開する
contextBridge.exposeInMainWorld('api', {
  // 音声ファイル選択ダイアログを開き、選択されたファイルパスを返す（キャンセル時は null）
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),

  // 指定パスの音声を読み込み、波形描画用のピークデータと長さ(秒)を返す
  // 返り値: { peaks: number[], duration: number }
  loadAudio: (filePath) => ipcRenderer.invoke('audio:load', filePath),

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

  // 現在の編集結果を、保存ダイアログで選んだフォーマット/パスへ書き出す
  // 返り値: 保存成功時 { path }、キャンセル時 null（失敗時は例外）
  exportAudio: () => ipcRenderer.invoke('audio:export')
})
