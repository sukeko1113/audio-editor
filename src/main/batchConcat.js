import { basename, extname, join, resolve } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { probeDuration } from './peaks.js'
import { probeAudioStream } from './normalize.js'
import { convertToPcmWav, concatPcmWavs } from './concat.js'
import { outputFormatFor, encodeToFormat, isSameFormat } from './format.js'
import { MAX_DURATION, formatDurationJa } from './duration.js'

/**
 * 複数音声ファイルの一括結合。
 *
 * 「末尾へのファイル追加」（editSession#append）とは別の独立した機能で、
 * 選ばれた複数のファイルを一覧の順番どおりに1本へ繋いで保存するだけ。
 * 編集セッション（版履歴）には一切触れないため、編集中の音声は変化しない。
 *
 * 連結そのものは append と同じ concat.js を使う：
 * 全ファイルを「並び順の先頭ファイル」のサンプルレート・チャンネル数の
 * 16bit PCM WAV へ揃えてから concat demuxer で繋ぐ。
 * （concat demuxer は入力どうしのパラメータ不一致を検出せず、そのまま繋いだ
 *   壊れた出力を作ってしまうため、揃えるのは省略できない）
 *
 * 中間ファイルは結合専用の一時ディレクトリにまとめ、成功時・失敗時とも削除する。
 */

// 入力として受け付ける形式（読み込み・末尾への追加と同じ MP3 / WAV / M4A）。
// MP4 は映像を含む書き出し専用の形式なので入力にはできない。
const INPUT_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a'])

// 連結の中間ファイル（concat demuxer の入力・出力）の中身。
// 出力形式がこれと同じなら、連結結果をそのまま出力先に書き出せる。
const MERGED_INFO = { formatName: 'wav', codecName: 'pcm_s16le' }

// 数字の並びで分割するための正規表現（キャプチャ付きなので split の結果に残る）
const DIGITS = /(\d+)/

function isDigits(chunk) {
  return /^\d+$/.test(chunk)
}

// 数字だけの文字列どうしを数値として比べる。
// parseInt は桁数が多いと精度を失うため、先頭の 0 を落としたうえで
// 「桁数 → 辞書順」で比べる（どちらも非負整数なのでこれで数値の大小に一致する）。
function compareDigits(a, b) {
  const na = a.replace(/^0+(?=\d)/, '')
  const nb = b.replace(/^0+(?=\d)/, '')
  if (na.length !== nb.length) return na.length - nb.length
  if (na !== nb) return na < nb ? -1 : 1
  return 0
}

/**
 * 自然順（natural order）でファイル名を比べる。
 *
 * 単純な文字列比較では文字コード順になり「1.wav → 10.wav → 2.wav」と並ぶ。
 * 名前を「数字の並び」と「それ以外」に分割し、数字部分だけ数値として比べる
 * ことで「1.wav → 2.wav → 10.wav」の順にする。
 * Windows のファイル名は大文字小文字を区別しないため、まず小文字化して比べ、
 * それで同じなら元の文字列で決着させて並びを安定させる。
 */
export function naturalCompare(a, b) {
  const chunksA = a.toLowerCase().split(DIGITS).filter((s) => s !== '')
  const chunksB = b.toLowerCase().split(DIGITS).filter((s) => s !== '')

  const shared = Math.min(chunksA.length, chunksB.length)
  for (let i = 0; i < shared; i++) {
    const x = chunksA[i]
    const y = chunksB[i]
    if (x === y) continue
    if (isDigits(x) && isDigits(y)) {
      const byNumber = compareDigits(x, y)
      if (byNumber !== 0) return byNumber
      continue // 数値としては同じ（"01" と "1" 等）。次の要素で比べる。
    }
    // 文字どうしはロケールに依存しないコードポイント順で比べる
    return x < y ? -1 : 1
  }
  if (chunksA.length !== chunksB.length) return chunksA.length - chunksB.length

  // 大文字小文字だけが違う場合も順序が安定するように、最後は元の文字列で比べる
  return a < b ? -1 : a > b ? 1 : 0
}

// ファイル名（basename）の自然順に並べる。同名のファイルが別フォルダにある
// 場合に順序がぶれないよう、同点はフルパスで決着させる。
export function sortPathsNaturally(filePaths) {
  return [...filePaths].sort((a, b) => {
    const byName = naturalCompare(basename(a), basename(b))
    return byName !== 0 ? byName : naturalCompare(a, b)
  })
}

// どのファイルで失敗したかが分かるエラーにする。
// ffprobe / ffmpeg のエラーはファイル名を含まないことがあるため、ここで添える。
function fileError(filePath, action, err) {
  const detail = (err && err.message) || String(err)
  return new Error(`「${basename(filePath)}」の${action}に失敗しました: ${detail}`)
}

function assertSupportedInput(filePath) {
  const ext = extname(filePath || '').toLowerCase()
  if (!INPUT_EXTENSIONS.has(ext)) {
    throw new Error(
      `対応していない形式です: ${basename(filePath) || '(名前なし)'}` +
        `（MP3 / WAV / M4A を選択してください）`
    )
  }
}

// 各ファイルの長さ（秒）を ffprobe で取得する。メタデータのみ読むため軽量で、
// 読めないファイルはこの時点で分かる。
async function probeFiles(filePaths) {
  const files = []
  for (const filePath of filePaths) {
    assertSupportedInput(filePath)
    let duration
    try {
      duration = await probeDuration(filePath)
    } catch (err) {
      throw fileError(filePath, '読み込み', err)
    }
    files.push({ path: filePath, name: basename(filePath), duration })
  }
  return files
}

/**
 * 結合候補のファイルを自然順に並べ、各ファイルの長さと合計を返す。
 * 確認ダイアログの表示に使う（この時点ではまだ何も変換しない）。
 *
 * @returns {Promise<{ files: Array<{path:string,name:string,duration:number}>,
 *                     totalDuration: number, limit: number }>}
 */
export async function inspectFiles(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('ファイルが選択されていません')
  }
  const files = await probeFiles(sortPathsNaturally(filePaths))
  return {
    files,
    totalDuration: files.reduce((sum, f) => sum + f.duration, 0),
    limit: MAX_DURATION
  }
}

// 出力先が入力ファイルのどれかと同じだと、結合の素材にしたファイルが結果で
// 上書きされてしまう。保存ダイアログの上書き確認だけでは気づきにくいため弾く。
function isSamePath(a, b) {
  const pa = resolve(a)
  const pb = resolve(b)
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb
}

/**
 * 一覧の順番どおりにファイルを結合し、outPath の拡張子が示す形式で書き出す。
 *
 * 現在の編集セッションには触れず、一時ファイルも専用ディレクトリに作って
 * 成功・失敗のどちらでも削除する。
 *
 * @param {string[]} filePaths 結合するファイル（この順に繋ぐ）
 * @param {string} outPath 出力先（拡張子で MP3 / WAV / M4A / MP4 が決まる）
 * @param {(progress: {phase:string, current:number, total:number, name?:string}) => void} onProgress
 * @returns {Promise<{ path:string, duration:number, fileCount:number, video:boolean }>}
 */
export async function concatToFile(filePaths, outPath, onProgress = () => {}) {
  if (!Array.isArray(filePaths) || filePaths.length < 2) {
    throw new Error('結合するには2つ以上のファイルが必要です')
  }
  // 未対応の拡張子は、時間のかかる変換を始める前にここで弾く
  const format = outputFormatFor(outPath)
  for (const filePath of filePaths) {
    if (isSamePath(filePath, outPath)) {
      throw new Error(
        `出力先が結合するファイル（${basename(filePath)}）と同じです。別の名前で保存してください`
      )
    }
  }

  // 全ファイルが読めること・合計が上限を超えないことを、変換を始める前に確かめる。
  // 判定は ffprobe が返す長さの単純な合計で、実際の連結結果とは数十ミリ秒
  // ずれうるが（MP3 のパディング等）、上限判定にはこの精度で足りる。
  const total = filePaths.length
  onProgress({ phase: 'probe', current: 0, total })
  const files = await probeFiles(filePaths)
  const totalDuration = files.reduce((sum, f) => sum + f.duration, 0)
  if (totalDuration > MAX_DURATION) {
    throw new Error(
      `結合後が上限の3時間を超えるため保存できません（合計 ${formatDurationJa(totalDuration)}）`
    )
  }

  // 連結の基準になるパラメータ（サンプルレート・チャンネル数）は並び順の先頭ファイルから取る
  const head = filePaths[0]
  let headInfo
  try {
    headInfo = await probeAudioStream(head)
  } catch (err) {
    throw fileError(head, '読み込み', err)
  }
  if (headInfo.sampleRate === null || headInfo.channels === null) {
    throw new Error(`「${basename(head)}」のサンプルレート・チャンネル数を取得できませんでした`)
  }
  const params = { sampleRate: headInfo.sampleRate, channels: headInfo.channels }

  // 中間ファイルは専用の一時ディレクトリにまとめ、finally でまるごと消す。
  // 編集セッションの一時ディレクトリとは分けているため、版履歴には影響しない。
  const workDir = mkdtempSync(join(tmpdir(), 'audio-editor-concat-'))
  let startedOutput = false
  try {
    const parts = []
    for (let i = 0; i < total; i++) {
      const src = filePaths[i]
      onProgress({ phase: 'convert', current: i + 1, total, name: basename(src) })
      const partPath = join(workDir, `part-${String(i + 1).padStart(4, '0')}.wav`)
      try {
        await convertToPcmWav(src, partPath, params)
      } catch (err) {
        throw fileError(src, '変換', err)
      }
      parts.push(partPath)
    }

    // 出力形式が中間ファイルと同じ（WAV / 16bit PCM）なら、連結結果をそのまま
    // 出力先へ書き出す。3時間ぶんで数 GB になるファイルを二度書きしないため。
    const mergedIsOutput = isSameFormat(MERGED_INFO, format)
    const mergedPath = mergedIsOutput ? outPath : join(workDir, 'merged.wav')

    onProgress({ phase: 'concat', current: total, total })
    if (mergedIsOutput) startedOutput = true
    await concatPcmWavs(parts, join(workDir, 'concat-list.txt'), mergedPath)

    if (!mergedIsOutput) {
      onProgress({ phase: 'encode', current: total, total, name: basename(outPath) })
      startedOutput = true
      await encodeToFormat(mergedPath, outPath)
    }

    return {
      path: outPath,
      duration: await probeDuration(outPath),
      fileCount: total,
      video: !!format.video
    }
  } catch (err) {
    // 途中で失敗した場合、出力先には書きかけの壊れたファイルが残るため削除する
    // （ffmpeg は -y で開いた時点で中身を切り詰めるので、残しても再生できない）
    if (startedOutput) {
      try {
        rmSync(outPath, { force: true })
      } catch {
        /* クリーンアップ失敗は無視 */
      }
    }
    throw err
  } finally {
    // 中間ファイルは成功・失敗にかかわらず破棄する
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* クリーンアップ失敗は無視 */
    }
  }
}
