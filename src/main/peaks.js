import { spawn } from 'child_process'
// 開発/パッケージ後の両対応のパス解決は binaries.js に集約
import { ffmpegPath, ffprobePath } from './binaries.js'

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
 * 見積もりベースで集計した仮バケット列（先頭 usedBuckets 本が有効）を、
 * TARGET_PEAKS 本へ最大値プーリングで詰め直す。
 *
 * MP3 のエンコーダ遅延/パディングにより ffprobe の公称 duration と
 * 実デコード長が一致しない場合、実際に使われたバケット数は
 * TARGET_PEAKS と一致しない。ここで実バケット数を基準に均等割りし直す
 * ことで、返す peaks の各要素が実デコード時間軸 0..duration を
 * 正確に等分するようにする（波形の見た目は最大値の保存なので破綻しない）。
 */
function resampleToTarget(buckets, usedBuckets) {
  if (usedBuckets === TARGET_PEAKS) {
    return Array.from(buckets.subarray(0, TARGET_PEAKS))
  }
  const out = new Array(TARGET_PEAKS)
  for (let j = 0; j < TARGET_PEAKS; j++) {
    const lo = Math.floor((j * usedBuckets) / TARGET_PEAKS)
    const hi = Math.max(lo + 1, Math.ceil(((j + 1) * usedBuckets) / TARGET_PEAKS))
    let max = 0
    for (let i = lo; i < hi && i < usedBuckets; i++) {
      if (buckets[i] > max) max = buckets[i]
    }
    out[j] = max
  }
  return out
}

/**
 * ffmpeg でデコードした PCM(16bit モノラル)をストリームで受け取りながら、
 * 固定本数(TARGET_PEAKS)のピーク配列にダウンサンプリングする。
 *
 * 全サンプルをメモリに保持せず、チャンクごとに各バケットの最大振幅だけを
 * 更新していくため、長尺ファイルでもメモリ使用量は一定に保たれる。
 *
 * 返す duration は「実際にデコードされたサンプル数」から算出する
 * （実duration = sampleIndex / PEAK_SAMPLE_RATE）。カット処理の atrim は
 * デコード後の実サンプルを切るため、波形の時間軸をコンテナの公称値
 * ではなく実デコード基準に揃えることで、選択位置とカット位置が一致する。
 * ffprobe の公称 duration はバケットサイズの事前見積もりにのみ使う。
 *
 * @returns {Promise<{ peaks: number[], duration: number }>}
 */
export function generatePeaks(filePath) {
  return new Promise((resolve, reject) => {
    probeDuration(filePath).then((estimatedDuration) => {
      const estimatedSamples = Math.max(1, Math.round(estimatedDuration * PEAK_SAMPLE_RATE))
      const samplesPerBucket = Math.max(1, Math.floor(estimatedSamples / TARGET_PEAKS))

      // 仮の集計バケット。公称 duration が実際より短い場合は末尾に溢れるため、
      // 溢れたぶんだけ伸長する（通常のずれは数百 ms 程度なのでほぼ固定サイズ）。
      let buckets = new Float32Array(TARGET_PEAKS + 16)

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
          if (bucket >= buckets.length) {
            // 公称 duration の見積もりを超えてサンプルが続く場合は伸長する
            const grown = new Float32Array(Math.max(bucket + 1, buckets.length * 2))
            grown.set(buckets)
            buckets = grown
          }
          if (amp > buckets[bucket]) {
            buckets[bucket] = amp
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
        // 実デコード基準の duration（カットの atrim と同じ時間軸）。
        // 万一デコードできたサンプルが 0 の場合のみ公称値へフォールバックする。
        const duration = sampleIndex > 0 ? sampleIndex / PEAK_SAMPLE_RATE : estimatedDuration
        const usedBuckets = Math.max(1, Math.ceil(sampleIndex / samplesPerBucket))
        // IPC で渡すため通常配列で返す
        resolve({ peaks: resampleToTarget(buckets, usedBuckets), duration })
      })
    }).catch(reject)
  })
}
