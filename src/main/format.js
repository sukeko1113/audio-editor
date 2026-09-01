import { extname } from 'path'

/**
 * 出力形式（コンテナ／コーデック）の定義と、入力ファイルとの同一判定。
 *
 * 「編集なしでの保存」は、選ばれた出力形式が入力ファイルと同じなら書き出す
 * 意味がなく、違うなら形式変換として書き出したい。この判定を拡張子で行うと
 * 「ADPCM の .wav を 16bit PCM の .wav として保存する」ようなケースを
 * 取りこぼすため、ffprobe が返すコンテナ名（format_name）とコーデック名で比べる。
 */

// 拡張子 → 出力形式。ffmpeg へ渡すコーデック引数と、書き出した結果の
// コンテナ／コーデック（＝ffprobe が返す名前）を1か所にまとめている。
// 書き出しと判定で別々に定義を持つと、両者がずれたときに誤判定になるため。
//   wav → pcm_s16le（16bit PCM） / mp3 → libmp3lame（192kbps） / m4a → aac（192kbps）
const OUTPUT_FORMATS = {
  '.wav': { container: 'wav', codec: 'pcm_s16le', args: ['-c:a', 'pcm_s16le'] },
  '.mp3': { container: 'mp3', codec: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  '.m4a': { container: 'm4a', codec: 'aac', args: ['-c:a', 'aac', '-b:a', '192k'] }
}

// 出力パスの拡張子から出力形式を決める。未対応の拡張子はここで弾く。
export function outputFormatFor(outPath) {
  const format = OUTPUT_FORMATS[extname(outPath).toLowerCase()]
  if (!format) {
    throw new Error(`対応していない出力形式です: ${extname(outPath) || '(拡張子なし)'}`)
  }
  return format
}

// 出力パスの拡張子に対応する ffmpeg の音声コーデック引数を返す。
export function codecArgsFor(outPath) {
  return outputFormatFor(outPath).args
}

// ffprobe の format_name は "mov,mp4,m4a,3gp,3g2,mj2" のように、その
// デマルチプレクサが扱う名前のカンマ区切りで返るため、含まれるかで判定する。
function containerMatches(formatName, container) {
  return String(formatName || '')
    .split(',')
    .includes(container)
}

/**
 * probeAudioStream() で調べたファイルの中身が、指定の出力形式と同じか。
 * 拡張子ではなくコンテナ＋コーデックで見るため、ADPCM の .wav を
 * .wav（pcm_s16le）として保存する場合は「異なる」＝変換ありと判定される。
 */
export function isSameFormat(info, format) {
  return containerMatches(info.formatName, format.container) && info.codecName === format.codec
}
