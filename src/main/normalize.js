import { spawn } from 'child_process'
import { ffmpegPath, ffprobePath } from './binaries.js'

/**
 * 読み込み入口での「音声の正規化」。
 *
 * 拡張子が .wav でも中身が ADPCM (adpcm_ima_wav 等) の圧縮形式だと、
 * Chromium の <audio> / Web Audio がデコードできず再生できない
 * （波形は main 側の ffmpeg で作るため表示だけは成功してしまう）。
 * そこで読み込み時に ffprobe でコーデックを調べ、ブラウザが素で再生できない
 * ものだけ ffmpeg で 16bit PCM WAV に変換してから扱う。
 *
 * サンプルレート・チャンネル数は元の値を維持し、コーデックのみ正規化する。
 */

// Chromium がそのままデコードできるコーデック。これらは変換しない。
// MP3/M4A(aac) を WAV に展開すると長尺で数 GB の一時ファイルになるうえ、
// 再生には何の利点も無いため、あえて対象外にしている。
// カット/音量調整の中間ファイル(FLAC)も同じ理由でここに含まれる。
const PLAYABLE_CODECS = new Set(['pcm_s16le', 'mp3', 'aac', 'flac', 'vorbis', 'opus'])

// ブラウザが扱えるサンプルレートの範囲（Web Audio がサポートする 3000〜384000Hz）。
// これを外れる極端な値は再生できないため、FALLBACK_SAMPLE_RATE へ載せ替える。
// 範囲内なら 44100 でも 48000 でも 96000 でも、元の値をそのまま維持する。
const MIN_SAMPLE_RATE = 3000
const MAX_SAMPLE_RATE = 384000
const FALLBACK_SAMPLE_RATE = 48000

// チャンネル数の上限（不正な probe 結果でおかしな変換をしないためのガード）
const MAX_CHANNELS = 8

function toPositiveInt(value) {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * ffprobe で先頭の音声ストリームの codec_name / sample_rate / channels を取得する。
 * メタデータのみ読むため軽量。
 * @returns {Promise<{ codecName: string, sampleRate: number|null, channels: number|null }>}
 */
export function probeAudioStream(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels',
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
      let stream
      try {
        const parsed = JSON.parse(out)
        stream = parsed.streams && parsed.streams[0]
      } catch {
        reject(new Error('音声情報を解析できませんでした'))
        return
      }
      if (!stream) {
        reject(new Error('音声ストリームが見つかりませんでした'))
        return
      }
      resolve({
        codecName: String(stream.codec_name || ''),
        sampleRate: toPositiveInt(stream.sample_rate),
        channels: toPositiveInt(stream.channels)
      })
    })
  })
}

// 変換後に使うサンプルレート。元の値が妥当ならそのまま維持する。
function outputSampleRate(sampleRate) {
  if (sampleRate === null) return FALLBACK_SAMPLE_RATE
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) return FALLBACK_SAMPLE_RATE
  return sampleRate
}

/**
 * この音声を 16bit PCM WAV へ変換する必要があるか。
 * ブラウザが再生できないコーデック、または極端なサンプルレートの場合に true。
 */
export function needsNormalization(info) {
  if (!PLAYABLE_CODECS.has(info.codecName)) return true
  return outputSampleRate(info.sampleRate) !== info.sampleRate
}

/**
 * ffmpeg で 16bit PCM WAV へ変換する。ディスク上をストリーム処理するため、
 * 長尺でもメモリに全展開しない。元ファイルは変更しない。
 */
export function normalizeToPcmWav(inputPath, outPath, info) {
  return new Promise((resolve, reject) => {
    const channels = info.channels !== null ? Math.min(info.channels, MAX_CHANNELS) : null

    const args = [
      '-v', 'error',
      '-nostdin',
      '-i', inputPath,
      '-map', '0:a:0',
      '-c:a', 'pcm_s16le',
      '-ar', String(outputSampleRate(info.sampleRate))
    ]
    if (channels !== null) args.push('-ac', String(channels))
    args.push('-y', outPath)

    const proc = spawn(ffmpegPath, args)
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg normalize failed (code ${code}): ${err.trim()}`))
        return
      }
      resolve()
    })
  })
}
