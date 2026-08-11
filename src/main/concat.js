import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { ffmpegPath } from './binaries.js'

/**
 * 「末尾へのファイル追加（結合）」で使う ffmpeg 処理。
 *
 * concat demuxer は入力どうしのサンプルレート・チャンネル数の食い違いを
 * 検出せず、そのまま繋いだ壊れた（再生速度やチャンネル配置がおかしい）出力を
 * 作ってしまう。そのため連結前に、両方の入力を必ず同じパラメータの
 * 16bit PCM WAV へ揃えてから -c copy で繋ぐ。
 *
 * 読み込み時の正規化（normalize.js）と違い、ここではサンプルレート・
 * チャンネル数を丸めずに指定値どおりへ変換する。丸めが入ると2つの入力で
 * 結果が食い違い、上記の壊れた出力を招くため。
 */

/**
 * 指定のサンプルレート・チャンネル数の 16bit PCM WAV へ変換する。
 * ディスク上をストリーム処理するため、長尺でもメモリに全展開しない。
 * 元ファイルは変更しない。
 */
export function convertToPcmWav(inputPath, outPath, { sampleRate, channels }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-nostdin',
      '-i', inputPath,
      '-map', '0:a:0',
      '-c:a', 'pcm_s16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-y', outPath
    ]

    const proc = spawn(ffmpegPath, args)
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg convert failed (code ${code}): ${err.trim()}`))
        return
      }
      resolve()
    })
  })
}

// concat demuxer のリストファイル1行分を組み立てる。
// パスはシングルクォートで囲む（スペース・日本語をそのまま書ける）。
// クォート内にシングルクォートは書けないため、' は '\'' の形
// （いったん閉じる → エスケープした ' → 開き直す）へ置き換える。
function concatListLine(filePath) {
  return `file '${filePath.replace(/'/g, "'\\''")}'`
}

/**
 * 同じパラメータの WAV 群を concat demuxer で連結する。
 * 再エンコードしない(-c copy)ため、長尺でも高速で、メモリに全展開しない。
 *
 * listPath には連結用のリストファイルを書き出す（絶対パスを1行ずつ）。
 * 中間ファイルなので、後始末は呼び出し側が行う。
 */
export function concatPcmWavs(inputPaths, listPath, outPath) {
  return new Promise((resolve, reject) => {
    try {
      const list = inputPaths.map(concatListLine).join('\n') + '\n'
      writeFileSync(listPath, list, 'utf8')
    } catch (err) {
      reject(new Error(`連結用リストファイルを作成できませんでした: ${err.message}`))
      return
    }

    const args = [
      '-v', 'error',
      '-nostdin',
      '-f', 'concat',
      '-safe', '0', // 絶対パスを許可する
      '-i', listPath,
      '-c', 'copy',
      '-y', outPath
    ]

    const proc = spawn(ffmpegPath, args)
    let err = ''
    proc.stderr.on('data', (d) => { err += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg concat failed (code ${code}): ${err.trim()}`))
        return
      }
      resolve()
    })
  })
}
