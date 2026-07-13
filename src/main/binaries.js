import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

/**
 * ffmpeg / ffprobe バイナリの実行パスを解決する。
 *
 * 開発時 (app.isPackaged = false):
 *   ffmpeg-static / ffprobe-static が返す node_modules 内のパスをそのまま使う。
 *     - ffmpeg-static:  node_modules/ffmpeg-static/ffmpeg(.exe)
 *     - ffprobe-static: node_modules/ffprobe-static/bin/<platform>/<arch>/ffprobe(.exe)
 *
 * パッケージ後 (app.isPackaged = true):
 *   main プロセスは app.asar 内で動くため、上記モジュールが返すパスも
 *   .../resources/app.asar/node_modules/... を指す。しかし asar 内の
 *   実行ファイルは spawn できないため、electron-builder の asarUnpack で
 *   .../resources/app.asar.unpacked/node_modules/... に展開した実体を
 *   指すよう、パス中の app.asar セグメントを app.asar.unpacked に置換する。
 */
function resolveUnpacked(binPath) {
  if (!binPath) return ''
  if (!app.isPackaged) return binPath
  // パス区切り直前の "app.asar" セグメントのみを置換する（Windows の \ にも対応）
  return binPath.replace(/\bapp\.asar(?=[\\/])/, 'app.asar.unpacked')
}

export const ffmpegPath = resolveUnpacked(ffmpegStatic || '')
export const ffprobePath = resolveUnpacked(ffprobeStatic.path || '')
