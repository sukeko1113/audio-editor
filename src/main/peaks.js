import { spawn } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

// パッケージ化(asar)された場合、バイナリは asar 外(unpacked)に展開されるため
// パスを付け替える。開発時は置換対象が無いのでそのまま。
const ffmpegPath = (ffmpegStatic || '').replace('app.asar', 'app.asar.unpacked')
const ffprobePath = (ffprobeStatic.path || '').replace('app.asar', 'app.asar.unpacked')

// 波形描画用に生成するピークの本数（画面幅に対して十分な解像度）。
// ファイルの長さに関わらず固定なので、3時間の音声でもピーク配列のサイズは一定。
const TARGET_PEAKS = 8000

// ピーク抽出用のデコード先サンプルレート(モノラル)。
// 元のサンプルレートで全展開せず、8kHz モノラルにダウンサンプリングしながら
// ストリーム処理することで、扱うデータ量とメモリを大幅に削減する。
const PEAK_SAMPLE_RATE = 8000

/**
 * ffprobe で音声の長さ(秒)を取得する。メタデータのみ読むため軽量。
 */
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
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
      const duration = parseFloat(out.trim())
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('音声の長さを取得できませんでした'))
        return
      }
      resolve(duration)
    })
  })
}

/**
 * ffmpeg でデコードした PCM(16bit モノラル)をストリームで受け取りながら、
 * 固定本数(TARGET_PEAKS)のピーク配列にダウンサンプリングする。
 *
 * 全サンプルをメモリに保持せず、チャンクごとに各バケットの最大振幅だけを
 * 更新していくため、長尺ファイルでもメモリ使用量は一定に保たれる。
 *
 * @returns {Promise<{ peaks: number[], duration: number }>}
 */
export function generatePeaks(filePath) {
  return new Promise((resolve, reject) => {
    probeDuration(filePath).then((duration) => {
      const totalSamples = Math.max(1, Math.round(duration * PEAK_SAMPLE_RATE))
      const samplesPerBucket = Math.max(1, Math.floor(totalSamples / TARGET_PEAKS))

      // 出力ピーク配列。長さは固定なのでメモリ上限が保証される。
      const peaks = new Float32Array(TARGET_PEAKS)

      let sampleIndex = 0
      let leftoverByte = null // 16bit(2byte)がチャンク境界で分割された場合の繰り越し

      const args = [
        '-v', 'error',
        '-nostdin',
        '-i', filePath,
        '-ac', '1', // モノラルにミックスダウン
        '-ar', String(PEAK_SAMPLE_RATE), // ダウンサンプリング
        '-f', 's16le', // 符号付き16bit リトルエンディアン PCM
        '-acodec', 'pcm_s16le',
        '-'
      ]

      const proc = spawn(ffmpegPath, args)
      let err = ''
      proc.stderr.on('data', (d) => { err += d.toString() })
      proc.on('error', reject)

      proc.stdout.on('data', (chunk) => {
        let buf = chunk
        // 前チャンクの余り1バイトがあれば先頭に連結
        if (leftoverByte !== null) {
          buf = Buffer.concat([leftoverByte, chunk])
          leftoverByte = null
        }
        const sampleCount = buf.length >> 1 // 2バイト = 1サンプル
        for (let i = 0; i < sampleCount; i++) {
          const value = buf.readInt16LE(i * 2)
          const amp = Math.abs(value) / 32768 // 0..1 に正規化
          const bucket = Math.floor(sampleIndex / samplesPerBucket)
          if (bucket < TARGET_PEAKS && amp > peaks[bucket]) {
            peaks[bucket] = amp
          }
          sampleIndex++
        }
        // 奇数バイトが余ったら次チャンクへ繰り越す
        if (buf.length & 1) {
          leftoverByte = buf.subarray(buf.length - 1)
        }
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg failed (code ${code}): ${err.trim()}`))
          return
        }
        // IPC で渡すため通常配列に変換
        resolve({ peaks: Array.from(peaks), duration })
      })
    }).catch(reject)
  })
}
