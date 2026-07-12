import { spawn } from 'child_process'
import { join, extname } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import ffmpegStatic from 'ffmpeg-static'
import { generatePeaks } from './peaks.js'

const ffmpegPath = (ffmpegStatic || '').replace('app.asar', 'app.asar.unpacked')

// 削除範囲どうしを正規化（0以上にクランプ・ソート・重なり/隣接をマージ）する
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

// 出力パスの拡張子から ffmpeg の音声コーデック引数を決定する。
//   wav → pcm_s16le（16bit PCM） / mp3 → libmp3lame（192kbps） / m4a → aac（192kbps）
function codecArgsFor(outPath) {
  switch (extname(outPath).toLowerCase()) {
    case '.wav':
      return ['-c:a', 'pcm_s16le']
    case '.mp3':
      return ['-c:a', 'libmp3lame', '-b:a', '192k']
    case '.m4a':
      return ['-c:a', 'aac', '-b:a', '192k']
    default:
      throw new Error(`対応していない出力形式です: ${extname(outPath) || '(拡張子なし)'}`)
  }
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

  ensureTempDir() {
    if (!this.tempDir) {
      this.tempDir = mkdtempSync(join(tmpdir(), 'audio-editor-'))
    }
    return this.tempDir
  }

  nextTempPath(ext) {
    this.tempCounter += 1
    return join(this.ensureTempDir(), `edit-${this.tempCounter}.${ext}`)
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

  // 新しいファイルを読み込み、版履歴を初期化する
  async load(filePath) {
    this.reset()
    this.originalPath = filePath
    const { peaks, duration } = await generatePeaks(filePath)
    this.versions = [{ path: filePath, duration, peaks, isTemp: false, op: null }]
    this.index = 0
    return { peaks, duration }
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

    return { peaks, duration }
  }

  /**
   * 音量を調整して新しい版を積む。カット処理と完全に同じフロー
   * （ffmpeg でディスク上のファイルを処理 → 中間ファイル生成 → 波形取得）。
   * region が指定されればその範囲のみ、null なら全体に適用する。元ファイルは変更しない。
   * @param {number} factor 倍率（1=変更なし, 0.5=半分, 2=2倍, 0=ミュート）
   * @param {{start:number,end:number}|null} region
   */
  async applyVolume(factor, region) {
    const cur = this.current()
    if (!cur) throw new Error('音声が読み込まれていません')
    if (!Number.isFinite(factor) || factor < 0) {
      throw new Error('音量の倍率が不正です')
    }

    const outPath = this.nextTempPath('flac')
    await this.runFfmpegVolume(cur.path, factor, region, cur.duration, outPath)

    // 調整後の実際の長さ・波形を新しいファイルから取得
    const { peaks, duration } = await generatePeaks(outPath)

    // やり直し（redo）側の版が残っていれば破棄してから新しい版を積む
    this.discardRedoTail()
    this.versions.push({
      path: outPath,
      duration,
      peaks,
      isTemp: true,
      op: { type: 'volume', factor, region: region || null }
    })
    this.index = this.versions.length - 1

    return { peaks, duration }
  }

  // ffmpeg の volume フィルタで音量を調整する。カット処理と同じくディスク上を
  // ストリーム処理し、可逆の FLAC で中間ファイルを出力する。
  // region 指定時は enable='between(t,start,end)' で対象範囲を限定する。
  runFfmpegVolume(inputPath, factor, region, duration, outPath) {
    return new Promise((resolve, reject) => {
      const fmt = (n) => n.toFixed(6)
      let filter
      if (region) {
        const start = Math.max(0, Math.min(region.start, duration))
        const end = Math.max(start, Math.min(region.end, duration))
        filter = `volume=${fmt(factor)}:enable='between(t,${fmt(start)},${fmt(end)})'`
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

  // カット等の編集が1回でも行われているか（＝カット後の中間ファイルが存在するか）
  hasEdits() {
    const cur = this.current()
    return !!(cur && cur.isTemp)
  }

  // 元の読み込みファイルの拡張子（デフォルトの保存形式に使う）を返す
  originalExtension() {
    return extname(this.originalPath || '').replace('.', '').toLowerCase() || 'mp3'
  }

  /**
   * 現在の編集結果を指定パスへ書き出す。
   * 入力は現在の版のファイル（カット済みなら中間ファイル、未編集なら元ファイル）。
   * 出力コーデックは outPath の拡張子から決まる。元ファイルは変更しない。
   */
  async export(outPath) {
    const cur = this.current()
    if (!cur) throw new Error('音声が読み込まれていません')
    await this.runFfmpegExport(cur.path, outPath)
    return outPath
  }

  // ffmpeg で入力ファイルを指定フォーマットへ変換して書き出す。
  // カット処理と同様、ディスク上のファイルをストリーム処理する。
  runFfmpegExport(inputPath, outPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'error',
        '-nostdin',
        '-i', inputPath,
        '-map', '0:a',
        ...codecArgsFor(outPath),
        '-y',
        outPath
      ]

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
