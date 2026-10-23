import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join, extname, basename, dirname } from 'path'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { EditSession } from './editSession.js'
import {
  saveDialogFilters,
  inputDialogFilters,
  defaultOutputExtension,
  outputFormatList
} from './format.js'
import { concatToFile, inspectFiles } from './batchConcat.js'

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
    filters: [...inputDialogFilters(), { name: 'すべてのファイル', extensions: ['*'] }]
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

// 「末尾にファイルを追加」用のファイル選択ダイアログ（単一選択）。
ipcMain.handle('dialog:openAppendFile', async () => {
  const result = await dialog.showOpenDialog({
    title: '末尾に追加する音声ファイルを選択',
    properties: ['openFile'],
    filters: inputDialogFilters()
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

// 指定ファイルを現在の編集対象の末尾に連結し、新しい版の波形ピーク・長さを返す。
ipcMain.handle('audio:append', async (_event, filePath) => {
  return session.append(filePath)
})

// 選択範囲（複数可）をまとめてカットし、新しい版の波形ピーク・長さを返す。
ipcMain.handle('audio:cut', async (_event, regions) => {
  return session.cut(regions)
})

// アンドゥ：1つ前の版へ戻し、その版の状態（波形・長さ・履歴/保存フラグ）を返す。
ipcMain.handle('audio:undo', async () => {
  return session.undo()
})

// リドゥ：1つ先の版へ進め、その版の状態を返す。
ipcMain.handle('audio:redo', async () => {
  return session.redo()
})

// 音量を調整し、新しい版の波形ピーク・長さを返す。
// regions が空/null なら全体、{start,end} の配列指定時はそれらの範囲のみに適用する。
ipcMain.handle('audio:volume', async (_event, { factor, regions }) => {
  return session.applyVolume(factor, regions)
})

// 現在の編集結果を、保存ダイアログで選んだフォーマット/パスへ書き出す。
// 編集が無い場合は「形式変換だけの保存」になるため、書き出すかどうかは
// 出力形式が決まるダイアログのあとに EditSession#export が判断する。
// キャンセル時は null、書き出した場合は { path, converted }、
// 編集も形式変換も無く書き出さなかった場合は { unchanged: true } を返す。
// ffmpeg エラーは例外として伝播する。
ipcMain.handle('audio:export', async () => {
  if (!session.currentPath()) {
    throw new Error('音声が読み込まれていません')
  }

  // 元ファイルが WMA のように入力専用の形式の場合、その拡張子では書き出せない。
  // デフォルトの形式・ファイル名には出力できる形式を使う。
  const ext = defaultOutputExtension(session.originalExtension())
  const hasEdits = session.hasEdits()
  // デフォルトのファイル名：元ファイル名 + "-edited"（編集が無い場合は "-converted"）+ 元の拡張子。
  // 元ファイルを上書きしないよう、どちらの場合も接尾辞を付ける（要件4.5）。
  const originalPath = session.originalPath || ''
  const base = basename(originalPath, extname(originalPath)) || 'audio'
  const defaultPath = `${base}${hasEdits ? '-edited' : '-converted'}.${ext}`

  const result = await dialog.showSaveDialog({
    title: hasEdits ? '編集した音声を保存' : '音声を保存',
    defaultPath,
    // 元ファイルと同じ形式をデフォルト（先頭）に並べる（MP4 を開いた場合は M4A）。MP4（動画）も選べる。
    filters: saveDialogFilters(ext)
  })

  if (result.canceled || !result.filePath) {
    return null
  }

  return session.export(result.filePath)
})

// --- 区切り線による分割書き出し ---

// 分割書き出しダイアログの初期値：出力形式の一覧と、出力先フォルダ（元ファイルと同じ場所）。
ipcMain.handle('split:options', async () => {
  if (!session.currentPath()) {
    throw new Error('音声が読み込まれていません')
  }
  return {
    formats: outputFormatList(),
    defaultExt: defaultOutputExtension(session.originalExtension()),
    folder: dirname(session.originalPath || '')
  }
})

// 出力先フォルダの選択ダイアログ。キャンセル時は null。
ipcMain.handle('dialog:selectFolder', async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog({
    title: '分割したファイルの出力先フォルダを選択',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

// 書き出すファイル名の一覧と、そのうち出力先にすでに存在するものを返す（確認表示・上書き確認用）。
ipcMain.handle('split:check', async (_event, { markers, ext, folder }) => {
  return session.splitCheck(markers, ext, folder)
})

// 区切り位置で分割して書き出す。進捗は 'split:progress' でレンダラーへ随時送る。
// 返り値: { folder, count }（失敗時は例外）
ipcMain.handle('split:run', async (event, { markers, ext, folder }) => {
  return session.exportSplit(markers, ext, folder, (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('split:progress', progress)
    }
  })
})

// 「複数ファイルを結合」用のファイル選択ダイアログ（複数選択）。
// 受け付ける形式は format.js の入力形式の定義に従う（MP4 は音声だけを使う）。
ipcMain.handle('dialog:openConcatFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '結合する音声ファイルを選択（複数選択可）',
    properties: ['openFile', 'multiSelections'],
    filters: inputDialogFilters()
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths
})

// 結合候補のファイルを自然順に並べ、各ファイルの長さと合計を返す（確認ダイアログ用）。
// まだ何も変換しないため、読めないファイルがあればこの時点で分かる。
ipcMain.handle('concat:inspect', async (_event, filePaths) => {
  return inspectFiles(filePaths)
})

// 一覧の順番どおりに結合し、保存ダイアログで選んだパス・形式へ書き出す。
// 編集セッション（版履歴）には触れないため、編集中の音声は変化しない。
// キャンセル時は null、書き出した場合は { path, duration, fileCount, video } を返す。
// 進捗は 'concat:progress' でレンダラーへ随時送る。
ipcMain.handle('concat:run', async (event, filePaths) => {
  if (!Array.isArray(filePaths) || filePaths.length < 2) {
    throw new Error('結合するには2つ以上のファイルが必要です')
  }

  // デフォルトのファイル名・出力形式は先頭ファイルに合わせる。
  // 素材のファイルを上書きしないよう "-concat" を付ける（要件4.5 と同じ考え方）。
  const first = filePaths[0]
  const ext = defaultOutputExtension(extname(first))
  const base = basename(first, extname(first)) || 'audio'

  const result = await dialog.showSaveDialog({
    title: '結合した音声を保存',
    defaultPath: `${base}-concat.${ext}`,
    filters: saveDialogFilters(ext)
  })

  if (result.canceled || !result.filePath) {
    return null
  }

  return concatToFile(filePaths, result.filePath, (progress) => {
    // ウィンドウが閉じたあとに送ると例外になるため、生きている間だけ通知する
    if (!event.sender.isDestroyed()) {
      event.sender.send('concat:progress', progress)
    }
  })
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
