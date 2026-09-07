import { spawn } from 'child_process'
import { extname } from 'path'
import { ffmpegPath } from './binaries.js'
import { probeDuration } from './peaks.js'

/**
 * このアプリが扱う音声形式の定義：入力として受け付ける形式、出力形式
 * （コンテナ／コーデック）、入力ファイルとの同一判定、そして書き出し。
 *
 * 「編集なしでの保存」は、選ばれた出力形式が入力ファイルと同じなら書き出す
 * 意味がなく、違うなら形式変換として書き出したい。この判定を拡張子で行うと
 * 「ADPCM の .wav を 16bit PCM の .wav として保存する」ようなケースを
 * 取りこぼすため、ffprobe が返すコンテナ名（format_name）とコーデック名で比べる。
 *
 * 定義・判定・書き出しを1つのモジュールにまとめているのは、これらがずれると
 * 「変換したはずが同じ形式だった」「判定は通ったが書き出しが違う形式だった」
 * といった食い違いになるため。書き出し（encodeToFormat）もここに置き、
 * カット後の書き出しと一括結合の書き出しが同じ引数を使うようにしている。
 *
 * 入力形式もここに置く。ファイル選択ダイアログ（開く／末尾に追加／一括結合）と
 * 受け入れ判定が別々に一覧を持つと、対応形式を増やしたときに直し漏れるため。
 */

/**
 * 入力として受け付ける拡張子。
 *
 * 出力形式と違い、入力はコーデックの定義を持たない。ffmpeg がデコードできれば
 * よく、ブラウザがそのまま再生できない形式（WMA・ADPCM の WAV など）は
 * 読み込み時に normalize.js が 16bit PCM WAV へ変換するため。
 *
 * WMA は入力専用。ffmpeg-static には wmav1 / wmav2 のエンコーダも含まれるが、
 * レガシー形式で新規に書き出す用途がないため出力形式には入れていない。
 */
const INPUT_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.wma']

// エラーメッセージやダイアログの表示に使う「MP3 / WAV / M4A / WMA」。
// 対応形式を増やしたときに文言も一緒に変わるよう、一覧から組み立てる。
export const INPUT_FORMATS_LABEL = INPUT_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(' / ')

/**
 * ファイル選択ダイアログ（開く／末尾に追加／一括結合）用のフィルタ。
 * MP4 は映像を含む書き出し専用の形式なので、ここには出さない。
 */
export function inputDialogFilters() {
  return [
    {
      name: `音声ファイル (${INPUT_FORMATS_LABEL})`,
      extensions: INPUT_EXTENSIONS.map((e) => e.slice(1))
    }
  ]
}

// 指定パスの拡張子が入力として受け付ける形式か。
export function isSupportedInputPath(filePath) {
  return INPUT_EXTENSIONS.includes(extname(filePath || '').toLowerCase())
}

// 映像トラック（MP4）の設定。
// YouTube は音声のみの MP4 を受け付けないため、音声の長さぶん黒一色の静止画を
// 敷いた動画として書き出す。
//
// フレームレートは 5fps。静止画なのでこれで足りる。3時間の音声で実測すると、
// 書き出し時間はほぼ AAC（音声）のエンコードで決まり、映像側を上げるとそこが
// 律速に変わる（4コアの環境で計測）：
//   音声のみ（AAC 192k）  247 秒  ← どの形式でも避けられない下限
//   MP4  5fps            294 秒 / 253MB
//   MP4 15fps            419 秒 / 272MB  ← 映像側が律速になり +2分
// 下限が 247 秒なので 1fps まで落としても 5fps から大きくは縮まらない。
// それより、極端に低いフレームレートを避けて一般的な値にしておく。
const VIDEO_SIZE = '1280x720'
const VIDEO_FPS = 5
// キーフレーム間隔は約2秒。YouTube の推奨（GOP 長 2秒以下）に合わせる。
const VIDEO_GOP = VIDEO_FPS * 2

/**
 * 黒一色の映像を生成する仮想入力（lavfi）。
 *
 * color フィルタは止めない限り無限にフレームを作り続けるため、音声の長さ(秒)を
 * -t で与えて終端する。-shortest に任せる方法は試したが、多重化バッファのぶん
 * 映像が先に進み、音声より1〜2秒長い出力になった。-fflags +shortest を足すと
 * 今度は音声の末尾が数百ミリ秒切り落とされてしまう（実測）。
 * 長さを明示すれば、映像は音声を1フレーム以内で覆う長さに収まる。
 */
function videoInputArgs(duration) {
  return ['-f', 'lavfi', '-t', duration.toFixed(3), '-i', `color=c=black:s=${VIDEO_SIZE}:r=${VIDEO_FPS}`]
}

// H.264 / yuv420p。YouTube が推奨する組み合わせで、静止画向けの
// チューニング（stillimage）と軽いプリセットで長尺でも短時間で終わる。
const VIDEO_ARGS = [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-tune', 'stillimage',
  '-profile:v', 'high',
  '-pix_fmt', 'yuv420p',
  '-crf', '28',
  '-g', String(VIDEO_GOP)
]

// 拡張子 → 出力形式。ffmpeg へ渡すコーデック引数と、書き出した結果の
// コンテナ／コーデック（＝ffprobe が返す名前）を1か所にまとめている。
// 書き出しと判定で別々に定義を持つと、両者がずれたときに誤判定になるため。
//   wav → pcm_s16le（16bit PCM） / mp3 → libmp3lame（192kbps） / m4a → aac（192kbps）
//   mp4 → 黒一色の H.264 映像 ＋ aac（192kbps）。映像を含むため書き出し専用。
// 並び順は保存ダイアログのフィルタの並びにもなる。
const OUTPUT_FORMATS = {
  '.mp3': {
    label: 'MP3',
    container: 'mp3',
    codec: 'mp3',
    audioArgs: ['-c:a', 'libmp3lame', '-b:a', '192k']
  },
  '.wav': {
    label: 'WAV',
    container: 'wav',
    codec: 'pcm_s16le',
    audioArgs: ['-c:a', 'pcm_s16le']
  },
  '.m4a': {
    label: 'M4A',
    container: 'm4a',
    codec: 'aac',
    audioArgs: ['-c:a', 'aac', '-b:a', '192k']
  },
  '.mp4': {
    label: 'MP4（動画・YouTube 向け）',
    container: 'mp4',
    codec: 'aac',
    audioArgs: ['-c:a', 'aac', '-b:a', '192k'],
    // video を持つ形式は「映像トラックを足して書き出す形式」。
    // 音声だけの入力とは常に別物になるため、同一判定からも除外する。
    video: { input: videoInputArgs, args: VIDEO_ARGS }
  }
}

// 出力パスの拡張子から出力形式を決める。未対応の拡張子はここで弾く。
export function outputFormatFor(outPath) {
  const format = OUTPUT_FORMATS[extname(outPath).toLowerCase()]
  if (!format) {
    throw new Error(`対応していない出力形式です: ${extname(outPath) || '(拡張子なし)'}`)
  }
  return format
}

/**
 * 指定パスの拡張子が「映像を含む出力形式（MP4）」か。
 * 映像を含む形式は書き出し専用で、読み込み・末尾への追加・一括結合の
 * 入力としては受け付けない。
 */
export function isVideoOutputPath(filePath) {
  const format = OUTPUT_FORMATS[extname(filePath || '').toLowerCase()]
  return !!(format && format.video)
}

/**
 * 保存ダイアログのデフォルトに使う拡張子を返す。
 *
 * 通常は元ファイルと同じ形式にしたいが、入力にしか対応していない形式
 * （WMA）を開いている場合、その拡張子はそのまま出力できない。
 * 出力できない形式のときは MP3（もっとも一般的な出力形式）へ寄せる。
 */
export function defaultOutputExtension(preferredExt) {
  const ext = String(preferredExt || '').replace('.', '').toLowerCase()
  return OUTPUT_FORMATS[`.${ext}`] ? ext : 'mp3'
}

/**
 * 保存ダイアログ用のフィルタ一覧を返す。
 * preferredExt（元ファイルの拡張子など）に対応する形式を先頭に置き、
 * 保存時のデフォルト形式にする。
 */
export function saveDialogFilters(preferredExt) {
  const preferred = String(preferredExt || '').replace('.', '').toLowerCase()
  const filters = Object.entries(OUTPUT_FORMATS).map(([ext, format]) => ({
    name: format.label,
    extensions: [ext.slice(1)]
  }))
  return [
    ...filters.filter((f) => f.extensions[0] === preferred),
    ...filters.filter((f) => f.extensions[0] !== preferred)
  ]
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
  // 映像トラックを足す形式（MP4）は、音声だけの入力とは常に別物。
  // M4A の format_name は "mov,mp4,m4a,3gp,3g2,mj2" で mp4 を含むため、
  // コンテナ名だけで比べると M4A → MP4 を「同じ」と誤判定してしまう。
  if (format.video) return false
  return containerMatches(info.formatName, format.container) && info.codecName === format.codec
}

/**
 * 入力ファイルを、出力パスの拡張子が示す形式へ変換して書き出す。
 * ディスク上をストリーム処理するため、長尺でもメモリに全展開しない。
 * 元ファイルは変更しない。
 *
 * MP4（映像を含む形式）の場合は、黒一色の映像を生成する仮想入力（lavfi）を
 * 0 番目の入力として足し、音声と多重化する。映像の長さは音声に合わせて
 * -t で指定し（videoInputArgs のコメント参照）、-movflags +faststart で
 * moov atom を先頭に置く（アップロード先で頭出しが早くなる）。
 */
export async function encodeToFormat(inputPath, outPath) {
  const format = outputFormatFor(outPath)

  const args = ['-v', 'error', '-nostdin']
  if (format.video) {
    // 映像の長さを決めるため、先に音声の長さを調べる（メタデータのみで軽量）
    const duration = await probeDuration(inputPath)
    args.push(
      ...format.video.input(duration),
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      ...format.video.args,
      ...format.audioArgs,
      '-movflags', '+faststart'
    )
  } else {
    args.push('-i', inputPath, '-map', '0:a', ...format.audioArgs)
  }
  args.push('-y', outPath)

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args)
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg export failed (code ${code}): ${err.trim()}`))
        return
      }
      resolve()
    })
  })
}
