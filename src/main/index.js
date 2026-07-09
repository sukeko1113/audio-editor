import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join, extname } from 'path'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { generatePeaks } from './peaks.js'

// 現在開いている音声ファイルのパス。app-audio プロトコルが配信する対象。
let currentFilePath = null

// レンダラーの <audio> が音声を「ストリーム再生」するためのカスタムスキーム。
// ファイル全体をメモリに読み込まず、Range リクエストで必要な範囲だけを配信する。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-audio',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  }
])

function mimeFor(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    default: return 'application/octet-stream'
  }
}

// app-audio://... へのリクエストを、現在のファイルを Range 対応でストリーム配信して応答する。
function handleAudioRequest(request) {
  if (!currentFilePath) {
    return new Response('No file loaded', { status: 404 })
  }

  let total
  try {
    total = statSync(currentFilePath).size
  } catch {
    return new Response('File not found', { status: 404 })
  }

  const type = mimeFor(currentFilePath)
  const rangeHeader = request.headers.get('Range')

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    let start = match && match[1] ? parseInt(match[1], 10) : 0
    let end = match && match[2] ? parseInt(match[2], 10) : total - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= total) end = total - 1
    if (start > end) start = 0
    const chunkSize = end - start + 1

    const stream = createReadStream(currentFilePath, { start, end })
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize)
      }
    })
  }

  const stream = createReadStream(currentFilePath)
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total)
    }
  })
}

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

// 指定ファイルを現在のファイルに設定し、波形描画用のピークデータを生成して返す。
ipcMain.handle('audio:load', async (_event, filePath) => {
  currentFilePath = filePath
  const { peaks, duration } = await generatePeaks(filePath)
  return { peaks, duration }
})

app.whenReady().then(() => {
  protocol.handle('app-audio', handleAudioRequest)
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
