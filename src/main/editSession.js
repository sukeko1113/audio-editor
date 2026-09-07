import { spawn } from 'child_process'
import { join, extname } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ffmpegPath } from './binaries.js'
import { generatePeaks, probeDuration } from './peaks.js'
import { probeAudioStream, needsNormalization, normalizeToPcmWav } from './normalize.js'
import { convertToPcmWav, concatPcmWavs } from './concat.js'
import {
  outputFormatFor,
  encodeToFormat,
  isSameFormat,
  isVideoOutputPath,
  isSupportedInputPath,
  INPUT_FORMATS_LABEL
} from './format.js'
import { MAX_DURATION, formatDurationJa } from './duration.js'

// 編集対象の範囲どうしを正規化（0〜duration にクランプ・ソート・重なり/隣接をマージ）する。
// カット・音量調整で共用する。
function mergeIntervals(intervals, duration) {
  const sorted = intervals
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, duration)),
      end: Math.max(0, Math.min(r.end, duration))
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)

  const merged = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

// 現在の編集対象を、変換せずそのまま concat の入力にできるか。
// 連結パラメータは現在の編集対象から取っているため、あとは中身が
// 16bit PCM の WAV かどうかだけを見ればよい。
// （カット/音量調整の中間ファイルは FLAC、元ファイルは MP3/M4A のこともある）
function isPcmWavFile(filePath, info) {
  return extname(filePath).toLowerCase() === '.wav' && info.codecName === 'pcm_s16le'
}

// 削除範囲の補集合（＝残す範囲）を求める
function keepSegments(removed, duration) {
  const keep = []
  let cursor = 0
  for (const r of removed) {
    if (r.start > cursor) keep.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
    if (cursor >= duration) break
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration })
  // ごく短い（丸め誤差レベルの）セグメントは除外
  return keep.filter((s) => s.end - s.start > 1e-3)
}

/**
 * 編集セッション。ドキュメントの「版履歴」を管理する。
 *
 * 各編集操作（カット等）の結果を version として積む構造にしてあり、
 * 将来のアンドゥ/リドゥは index を前後させるだけで実装できる。
 *   version = { path, duration, peaks, isTemp, op }
 *     path     : その版の音声ファイル（元ファイル or 一時ファイル）
 *     op       : この版を生む編集操作（{ type:'cut', regions } / 初期版は null）
 *
 * カットは AudioBuffer をメモリ展開せず、ffmpeg でディスク上のファイルを
 * ストリーム処理して新しい一時ファイルを生成する。元ファイルは変更しない。
 */
export class EditSession {
  constructor() {
    this.originalPath = null
    this.tempDir = null
    this.tempCounter = 0
    this.versions = []
    this.index = -1
  }

  current() {
    return this.versions[this.index] || null
  }

  currentPath() {
    const cur = this.current()
    return cur ? cur.path : null
  }

  // これ以上戻せる版があるか（最初の版より前には戻れない）
  canUndo() {
    return this.index > 0
  }

  // これ以上進める版があるか（末尾より先には進めない）
  canRedo() {
    return this.index < this.versions.length - 1
  }

  // 現在の版の波形・長さと、履歴/保存の状態をまとめて返す。
  // load / cut / applyVolume / undo / redo の共通の返り値に使う。
  state() {
    const cur = this.current()
    return {
      peaks: cur ? cur.peaks : [],
      duration: cur ? cur.duration : 0,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      hasEdits: this.hasEdits()
    }
  }

  // 1つ前の版へ戻す。ffmpeg 再処理は不要で、各版が保持する中間ファイルを切り替えるだけ。
  undo() {
    if (this.canUndo()) this.index -= 1
    return this.state()
  }

  // 1つ先の版へ進める（アンドゥで戻った版がある場合）。
  redo() {
    if (this.canRedo()) this.index += 1
    return this.state()
  }

  ensureTempDir() {
    if (!this.tempDir) {
      this.tempDir = mkdtempSync(join(tmpdir(), 'audio-editor-'))
    }
    return this.tempDir
  }

  nextTempPath(ext, prefix = 'edit') {
    this.tempCounter += 1
    return join(this.ensureTempDir(), `${prefix}-${this.tempCounter}.${ext}`)
  }

  // これまでの一時ファイルを含めセッションを破棄する
  reset() {
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true })
      } catch {
        /* クリーンアップ失敗は無視 */
      }
    }
    this.originalPath = null
    this.tempDir = null
    this.tempCounter = 0
    this.versions = []
    this.index = -1
  }

  /**
   * 新しいファイルを読み込み、版履歴を初期化する。
   *
   * ブラウザが再生できないコーデック（ADPCM WAV 等）の場合はここで
   * 16bit PCM WAV の一時ファイルへ変換し、以降の版・再生・書き出しは
   * すべてその正規化済みファイルを入力にする。元ファイルは変更しない。
   * 一時ファイルはセッションの一時ディレクトリに置かれるため、
   * 次の load / 終了時の reset() でまとめて破棄される。
   */
  async load(filePath) {
    // MP4 は映像トラックを足して書き出すための形式で、読み込みには対応しない。
    // ファイル選択ダイアログでは絞り込んでいるが、「すべてのファイル」から
    // 選べてしまうため、ここでも弾いて分かりやすいエラーにする。
    if (isVideoOutputPath(filePath)) {
      throw new Error(
        `MP4 は書き出し専用の形式です（${INPUT_FORMATS_LABEL} を選択してください）`
      )
    }

    this.reset()
    this.originalPath = filePath

    let sourcePath = filePath
    let isTemp = false
    const info = await probeAudioStream(filePath)
    if (needsNormalization(info)) {
      const normalizedPath = this.nextTempPath('wav', 'source')
      await normalizeToPcmWav(filePath, normalizedPath, info)
      sourcePath = normalizedPath
      isTemp = true
    }

    const { peaks, duration } = await generatePeaks(sourcePath)
    this.versions = [{ path: sourcePath, duration, peaks, isTemp, op: null }]
    this.index = 0
    return this.state()
  }

  /**
   * 選択範囲（複数可）をまとめてカットし、新しい版を積む。
   * @param {Array<{start:number,end:number}>} regions
   */
  async cut(regions) {
    const cur = this.current()
    if (!cur) throw new Error('音声が読み込まれていません')
    if (!Array.isArray(regions) || regions.length === 0) {
      throw new Error('カットする範囲が選択されていません')
    }

    const removed = mergeIntervals(regions, cur.duration)
    const keep = keepSegments(removed, cur.duration)

    if (keep.length === 0) {
      throw new Error('すべての範囲を削除することはできません')
    }

    const outPath = this.nextTempPath('flac')
    await this.runFfmpegCut(cur.path, keep, outPath)

    // カット後の実際の長さ・波形を新しいファイルから取得
    const { peaks, duration } = await generatePeaks(outPath)

    // やり直し（redo）側の版が残っていれば破棄してから新しい版を積む
    this.discardRedoTail()
    this.versions.push({
      path: outPath,
      duration,
      peaks,
      isTemp: true,
      op: { type: 'cut', regions: removed }
    })
    this.index = this.versions.length - 1

    return this.state()
  }

  /**
   * 音量を調整して新しい版を積む。カット処理と完全に同じフロー
   * （ffmpeg でディスク上のファイルを処理 → 中間ファイル生成 → 波形取得）。
   * regions（複数可）が指定されればそれらの範囲のみ、空/null なら全体に適用する。
   * 元ファイルは変更しない。
   * @param {number} factor 倍率（1=変更なし, 0.5=半分, 2=2倍, 0=ミュート）
   * @param {Array<{start:number,end:number}>|null} regions
   */
  async applyVolume(factor, regions) {
    const cur = this.current()
    if (!cur) throw new Error('音声が読み込まれていません')
    if (!Number.isFinite(factor) || factor < 0) {
      throw new Error('音量の倍率が不正です')
    }

    // カットと同様に正規化（duration へのクランプ・ソート・重なり/隣接のマージ）
    const hasRegions = Array.isArray(regions) && regions.length > 0
    const normalized = hasRegions ? mergeIntervals(regions, cur.duration) : []
    if (hasRegions && normalized.length === 0) {
      throw new Error('音量を調整する範囲が不正です')
    }

    const outPath = this.nextTempPath('flac')
    await this.runFfmpegVolume(cur.path, factor, normalized, outPath)

    // 調整後の実際の長さ・波形を新しいファイルから取得
    const { peaks, duration } = await generatePeaks(outPath)

    // やり直し（redo）側の版が残っていれば破棄してから新しい版を積む
    this.discardRedoTail()
    this.versions.push({
      path: outPath,
      duration,
      peaks,
      isTemp: true,
      op: { type: 'volume', factor, regions: normalized }
    })
    this.index = this.versions.length - 1

    return this.state()
  }

  // ffmpeg の volume フィルタで音量を調整する。カット処理と同じくディスク上を
  // ストリーム処理し、可逆の FLAC で中間ファイルを出力する。
  // regions 指定時は各範囲の between(t,start,end) を +（論理和）で連結した
  // enable 式で対象範囲を限定する。空配列なら全体に適用する。
  runFfmpegVolume(inputPath, factor, regions, outPath) {
    return new Promise((resolve, reject) => {
      const fmt = (n) => n.toFixed(6)
      let filter
      if (regions.length > 0) {
        const enable = regions
          .map((r) => `between(t,${fmt(r.start)},${fmt(r.end)})`)
          .join('+')
        filter = `volume=${fmt(factor)}:enable='${enable}'`
      } else {
        filter = `volume=${fmt(factor)}`
      }

      const args = [
        '-v', 'error',
        '-nostdin',
        '-i', inputPath,
        '-af', filter,
        '-c:a', 'flac',
        '-y',
        outPath
      ]

      const proc = spawn(ffmpegPath, args)
      let err = ''
      proc.stderr.on('data', (d) => { err += d.toString() })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg volume failed (code ${code}): ${err.trim()}`))
          return
        }
        resolve()
      })
    })
  }

  /**
   * 別の音声ファイルを現在の編集対象の末尾に連結し、新しい版を積む。
   * カット・音量調整と同じく、結果は一時ファイルとして生成され、
   * 以降は1本の音声として通常どおり編集できる（元ファイルは変更しない）。
   *
   * concat demuxer は入力どうしのパラメータ不一致を検出せず壊れた出力を作るため、
   * 追加ファイルは「元から同じパラメータに見えても」必ず変換を通し、
   * 現在の編集対象も同じパラメータの 16bit PCM WAV でなければ変換してから連結する。
   * 変換に使う値（サンプルレート・チャンネル数）は現在の編集対象のものに揃える。
   *
   * 連結後の長さが上限（要件5.1 の3時間）を超える場合は、変換を始める前に中断する。
   *
   * @param {string} filePath 末尾に追加する音声ファイル（format.js の入力形式）
   */
  async append(filePath) {
    const cur = this.current()
    if (!cur) throw new Error('音声が読み込まれていません')

    if (!isSupportedInputPath(filePath)) {
      const ext = extname(filePath || '').toLowerCase()
      throw new Error(
        `対応していない形式です: ${ext || '(拡張子なし)'}（${INPUT_FORMATS_LABEL} を選択してください）`
      )
    }

    // 追加ファイルが音声として読めるかを、変換を始める前に確かめる
    await probeAudioStream(filePath)

    // 連結後の長さが上限を超えないかも、同じく変換を始める前に確かめる。
    // 判定は ffprobe が返す長さの単純な合計で、実際の連結結果とは
    // 数十ミリ秒ずれうるが（MP3 のパディング等）、上限判定にはこの精度で足りる。
    const addDuration = await probeDuration(filePath)
    const totalDuration = cur.duration + addDuration
    if (totalDuration > MAX_DURATION) {
      // ステータス表示は1行なので、内訳は記号でコンパクトに示す
      throw new Error(
        `連結後が上限の3時間を超えるため追加できません` +
          `（${formatDurationJa(cur.duration)} ＋ ${formatDurationJa(addDuration)}` +
          ` ＝ ${formatDurationJa(totalDuration)}）`
      )
    }

    // 連結の基準になるパラメータは現在の編集対象から取る
    const target = await probeAudioStream(cur.path)
    if (target.sampleRate === null || target.channels === null) {
      throw new Error('現在の音声のサンプルレート・チャンネル数を取得できませんでした')
    }
    const params = { sampleRate: target.sampleRate, channels: target.channels }

    const outPath = this.nextTempPath('wav', 'append')
    const temps = [] // 連結のためだけに作る中間ファイル。完了後・失敗時とも削除する。
    try {
      const addPath = this.nextTempPath('wav', 'append-add')
      temps.push(addPath)
      await convertToPcmWav(filePath, addPath, params)

      let basePath = cur.path
      if (!isPcmWavFile(cur.path, target)) {
        basePath = this.nextTempPath('wav', 'append-base')
        temps.push(basePath)
        await convertToPcmWav(cur.path, basePath, params)
      }

      const listPath = this.nextTempPath('txt', 'append-list')
      temps.push(listPath)
      await concatPcmWavs([basePath, addPath], listPath, outPath)
    } catch (err) {
      // 失敗した場合は版を積まない。作りかけの出力も含めて捨て、現在の版を維持する。
      this.removeTempFiles([...temps, outPath])
      throw err
    }
    this.removeTempFiles(temps)

    // 連結後の実際の長さ・波形を新しいファイルから取得
    const { peaks, duration } = await generatePeaks(outPath)

    // やり直し（redo）側の版が残っていれば破棄してから新しい版を積む
    this.discardRedoTail()
    this.versions.push({
      path: outPath,
      duration,
      peaks,
      isTemp: true,
      op: { type: 'append', source: filePath }
    })
    this.index = this.versions.length - 1

    return this.state()
  }

  // 中間生成した一時ファイルを削除する（失敗時の後始末にも使う）
  removeTempFiles(paths) {
    for (const p of paths) {
      try {
        rmSync(p, { force: true })
      } catch {
        /* クリーンアップ失敗は無視 */
      }
    }
  }

  // カット等の編集が1回でも行われているか（＝編集操作から生まれた版にいるか）。
  // 読み込み時の正規化でも一時ファイルにはなるが、それは編集ではないので
  // isTemp ではなく op の有無で判定する。
  hasEdits() {
    const cur = this.current()
    return !!(cur && cur.op)
  }

  // 元の読み込みファイルの拡張子（デフォルトの保存形式に使う）を返す
  originalExtension() {
    return extname(this.originalPath || '').replace('.', '').toLowerCase() || 'mp3'
  }

  /**
   * 現在の編集結果を指定パスへ書き出す。
   * 入力は現在の版のファイル（カット済みなら中間ファイル、未編集なら読み込み時のファイル）。
   * 出力コーデックは outPath の拡張子から決まる。元ファイルは変更しない。
   *
   * 編集が1つも無い場合は「形式変換だけの保存」になるため、元ファイルの中身
   * （コンテナ／コーデック）を調べ、出力形式と同じなら書き出さずに中断する。
   * 判定は拡張子ではなく中身で行うので、ADPCM の .wav を .wav（pcm_s16le）
   * として保存する場合は変換ありとして書き出す。読み込み時に正規化した音声
   * （ADPCM や極端なサンプルレート）も、その時点で中身が変わっているため
   * つねに変換ありとして扱う。
   *
   * 書き出しても版履歴は変更しない（形式変換だけの場合も同じ）。
   *
   * @returns {Promise<{ path: string, converted: boolean } | { unchanged: true }>}
   *   unchanged: 編集も形式変換も無いため書き出さなかった
   *   converted: 編集は無く、形式変換として書き出した
   */
  async export(outPath) {
    const cur = this.current()
    if (!cur) throw new Error('音声が読み込まれていません')

    // 未対応の拡張子は、ffmpeg を起動する前にここで弾く
    const format = outputFormatFor(outPath)

    // 編集が1つも無ければ「形式変換だけの保存」。
    // 編集があれば、形式が同じでも書き出す内容は元ファイルと異なるので必ず書き出す。
    const conversionOnly = !this.hasEdits()
    if (conversionOnly) {
      const info = await probeAudioStream(this.originalPath)
      if (!needsNormalization(info) && isSameFormat(info, format)) {
        return { unchanged: true }
      }
    }

    // 書き出しは format.js が担当する（MP4 は黒一色の映像トラックを足して書き出す）
    await encodeToFormat(cur.path, outPath)
    return { path: outPath, converted: conversionOnly }
  }

  // 現在位置より後ろ（redo 対象）の版と、その一時ファイルを破棄する
  discardRedoTail() {
    for (let i = this.versions.length - 1; i > this.index; i--) {
      const v = this.versions[i]
      if (v.isTemp) {
        try {
          rmSync(v.path, { force: true })
        } catch {
          /* 無視 */
        }
      }
    }
    this.versions = this.versions.slice(0, this.index + 1)
  }

  // ffmpeg で「残す範囲」だけを atrim で切り出し concat で連結、FLAC(可逆)で出力する。
  // 入力ファイルをストリーム処理するため、長尺でもメモリに全展開しない。
  runFfmpegCut(inputPath, keep, outPath) {
    return new Promise((resolve, reject) => {
      const fmt = (n) => n.toFixed(6)
      let filter
      if (keep.length === 1) {
        const s = keep[0]
        filter = `[0:a]atrim=start=${fmt(s.start)}:end=${fmt(s.end)},asetpts=PTS-STARTPTS[out]`
      } else {
        const parts = keep.map(
          (s, i) => `[0:a]atrim=start=${fmt(s.start)}:end=${fmt(s.end)},asetpts=PTS-STARTPTS[k${i}]`
        )
        const labels = keep.map((_, i) => `[k${i}]`).join('')
        filter = `${parts.join(';')};${labels}concat=n=${keep.length}:v=0:a=1[out]`
      }

      const args = [
        '-v', 'error',
        '-nostdin',
        '-i', inputPath,
        '-filter_complex', filter,
        '-map', '[out]',
        '-c:a', 'flac',
        '-y',
        outPath
      ]

      const proc = spawn(ffmpegPath, args)
      let err = ''
      proc.stderr.on('data', (d) => { err += d.toString() })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg cut failed (code ${code}): ${err.trim()}`))
          return
        }
        resolve()
      })
    })
  }
}
