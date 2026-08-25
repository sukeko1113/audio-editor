import { spawn } from 'child_process'
import { ffmpegPath, ffprobePath } from './binaries.js'

/**
 * 動画コンテナ（MP4 等）から「音声トラックだけ」を取り出す処理。
 *
 * MP4 は映像と音声が同じファイルに入っているため、そのまま編集対象にすると
 *   - 音量調整・カットの ffmpeg 出力（FLAC）に映像ストリームを入れられず失敗する
 *   - <audio> での再生時に不要な映像データまで転送してしまう
 * といった問題が出る。そこで読み込み時に音声トラックだけを一時ファイルへ
 * 取り出し、以降は通常の音声ファイルとまったく同じ経路で扱う。
 * 元ファイル（動画）は変更しない。
 *
 * 取り出しは可能なかぎり再エンコードせず（-c:a copy）、ディスク上をストリーム
 * 処理するため、長尺の動画でもメモリに全展開せず短時間で終わる。
 */

// 無変換で取り出せる（＝コンテナに入れ替えるだけで Chromium が再生できる）
// コーデックと、その音声だけを入れるコンテナの拡張子。
// ここに無いコーデック（AC-3 / ALAC 等）は再生できないため、
// 呼び出し側で 16bit PCM WAV へ変換する（normalize.js）。
const STREAM_COPY_CONTAINERS = new Map([
  ['aac', 'm4a'],
  ['mp3', 'mp3'],
  ['flac', 'flac']
])

/**
 * このコーデックの音声トラックを無変換で取り出せるか。
 * @returns {string|null} 取り出し先の拡張子。無変換で取り出せない場合は null。
 */
export function streamCopyExtensionFor(codecName) {
  return STREAM_COPY_CONTAINERS.get(codecName) || null
}

/**
 * 映像ストリームを持つファイル（＝音声トラックの取り出しが必要なファイル）か。
 *
 * MP3 / M4A に埋め込まれたジャケット画像も ffprobe 上は映像ストリームとして
 * 見えるため、disposition の attached_pic が立っているものは映像として数えない
 * （画像1枚が入っているだけの普通の音声ファイルを動画と誤判定しないため）。
 */
export function hasVideoStream(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v',
      '-show_entries', 'stream_disposition=attached_pic',
      '-of', 'json',
      filePath
    ]
    const proc = spawn(ffprobePath, args)
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d.toString() })
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed (code ${code}): ${err.trim()}`))
        return
      }
      let streams
      try {
        streams = JSON.parse(out).streams || []
      } catch {
        reject(new Error('ファイルの構成を解析できませんでした'))
        return
      }
      resolve(streams.some((s) => !s.disposition || s.disposition.attached_pic !== 1))
    })
  })
}

/**
 * 先頭の音声トラックを再エンコードせずに取り出す（映像は捨てる）。
 * 音質は元のまま、処理はコンテナの入れ替えだけなので長尺でも高速。
 * 元ファイルは変更しない。
 */
export function copyAudioTrack(inputPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-nostdin',
      '-i', inputPath,
      '-map', '0:a:0',
      '-vn', // 映像・ジャケット画像は取り出さない
      '-c:a', 'copy',
      '-y', outPath
    ]

    const proc = spawn(ffmpegPath, args)
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg extract failed (code ${code}): ${err.trim()}`))
        return
      }
      resolve()
    })
  })
}
