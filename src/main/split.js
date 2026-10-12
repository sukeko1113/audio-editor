/**
 * 区切り線による分割書き出しの計画（区間の算出とファイル名）。
 * ffmpeg には触れない純粋な計算だけを置き、書き出しは editSession が行う。
 */

// 区切り線どうし・先頭/末尾からの最小間隔(秒)。renderer 側の定数と同じ値。
// 短すぎる区間は書き出しても意味が無く、位置の丸め誤差にも埋もれてしまう。
export const MIN_SEGMENT = 0.1

// 浮動小数の誤差で「ちょうど 0.1 秒」の区間を弾かないための許容
const EPSILON = 1e-6

/**
 * 区切り位置（秒）から、書き出す区間 [{ start, end }] を作る。
 * 区切りが n 本なら n+1 区間。先頭の区間は 0 から、最後の区間は音声の終わりまで。
 */
export function buildSegments(markers, duration) {
  if (!Array.isArray(markers) || markers.length === 0) {
    throw new Error('区切りが1本もありません')
  }
  const times = markers.map(Number)
  if (times.some((t) => !Number.isFinite(t))) {
    throw new Error('区切りの位置が不正です')
  }
  times.sort((a, b) => a - b)

  const bounds = [0, ...times, duration]
  const segments = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]
    const end = bounds[i + 1]
    if (end - start < MIN_SEGMENT - EPSILON) {
      throw new Error(`区切りの間隔が ${MIN_SEGMENT} 秒未満の区間があります。区切りの位置を見直してください`)
    }
    segments.push({ start, end })
  }
  return segments
}

/**
 * 「元ファイル名-分割01.拡張子」の形のファイル名を count 個ぶん返す。
 * 連番は総数の桁数（最低2桁）でゼロ埋めする：99個以下は2桁、100〜999個は3桁、
 * 1000個以上は4桁。桁数が混ざると、ファイル名順に並べたときに順序が崩れるため。
 */
export function splitFileNames(baseName, ext, count) {
  const width = Math.max(2, String(count).length)
  return Array.from(
    { length: count },
    (_, i) => `${baseName}-分割${String(i + 1).padStart(width, '0')}.${ext}`
  )
}
