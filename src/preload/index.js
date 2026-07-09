import { contextBridge, ipcRenderer } from 'electron'

// レンダラー（Web 側）に安全な API のみを公開する
contextBridge.exposeInMainWorld('api', {
  // 音声ファイル選択ダイアログを開き、選択されたファイルパスを返す（キャンセル時は null）
  openAudioFile: () => ipcRenderer.invoke('dialog:openAudioFile'),

  // 指定パスの音声を読み込み、波形描画用のピークデータと長さ(秒)を返す
  // 返り値: { peaks: number[], duration: number }
  loadAudio: (filePath) => ipcRenderer.invoke('audio:load', filePath)
})
