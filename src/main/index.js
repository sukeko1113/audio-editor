import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 500,
    title: '音声編集アプリ',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // 開発時は Vite の dev サーバー、本番はビルド済み HTML を読み込む
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// レンダラーからの「ファイルを開く」要求に応じてダイアログを表示する
ipcMain.handle('dialog:openAudioFile', async () => {
  const result = await dialog.showOpenDialog({
    title: '音声ファイルを開く',
    properties: ['openFile'],
    filters: [
      { name: '音声ファイル (MP3 / WAV / M4A)', extensions: ['mp3', 'wav', 'm4a'] },
      { name: 'すべてのファイル', extensions: ['*'] }
    ]
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
