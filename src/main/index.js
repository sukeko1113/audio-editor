import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join, extname, basename } from 'path'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { EditSession } from './editSession.js'

// 編集セッション（版履歴とカット処理を管理）。
// app-audio プロトコルは常に現在の版のファイルを配信する。
const session = new EditSession()

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
    case '.flac': return 'audio/flac' // カット後の一時ファイルは可逆の FLAC
    default: return 'application/octet-stream'
  }
}

// app-audio://... へのリクエストを、現在の版のファイルを Range 対応でストリーム配信して応答する。
function handleAudioRequest(request) {
  const currentFilePath = session.currentPath()
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

// 指定ファイルを読み込み、版履歴を初期化して波形ピーク・長さを返す。
ipcMain.handle('audio:load', async (_event, filePath) => {
  return session.load(filePath)
})

// 選択範囲（複数可）をまとめてカットし、新しい版の波形ピーク・長さを返す。
ipcMain.handle('audio:cut', async (_event, regions) => {
  return session.cut(regions)
})

// 音量を調整し、新しい版の波形ピーク・長さを返す。
// region が null なら全体、{start,end} 指定時はその範囲のみに適用する。
ipcMain.handle('audio:volume', async (_event, { factor, region }) => {
  return session.applyVolume(factor, region)
})

// 現在の編集結果を、保存ダイアログで選んだフォーマット/パスへ書き出す。
// キャンセル時は null、成功時は { path } を返す。ffmpeg エラーは例外として伝播する。
ipcMain.handle('audio:export', async () => {
  if (!session.currentPath()) {
    throw new Error('音声が読み込まれていません')
  }

  const ext = session.originalExtension()
  // デフォルトのファイル名：元ファイル名 + "-edited" + 元の拡張子
  const originalPath = session.originalPath || ''
  const base = basename(originalPath, extname(originalPath)) || 'audio'
  const defaultPath = `${base}-edited.${ext}`

  // 元ファイルと同じ形式をデフォルト（先頭）に並べる
  const allFilters = [
    { name: 'MP3', extensions: ['mp3'] },
    { name: 'WAV', extensions: ['wav'] },
    { name: 'M4A', extensions: ['m4a'] }
  ]
  const filters = [
    ...allFilters.filter((f) => f.extensions[0] === ext),
    ...allFilters.filter((f) => f.extensions[0] !== ext)
  ]

  const result = await dialog.showSaveDialog({
    title: '編集した音声を保存',
    defaultPath,
    filters
  })

  if (result.canceled || !result.filePath) {
    return null
  }

  const outPath = await session.export(result.filePath)
  return { path: outPath }
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

// 終了時に一時ファイル（カット結果）を掃除する
app.on('will-quit', () => {
  session.reset()
})
