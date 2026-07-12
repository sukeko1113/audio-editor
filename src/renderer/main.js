import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'

const openFileBtn = document.getElementById('open-file-btn')
const statusEl = document.getElementById('status')
const placeholderEl = document.getElementById('placeholder')
const waveformEl = document.getElementById('waveform')
const transportEl = document.getElementById('transport')
const playBtn = document.getElementById('play-btn')
const pauseBtn = document.getElementById('pause-btn')
const stopBtn = document.getElementById('stop-btn')
const timeEl = document.getElementById('time')
const editToolsEl = document.getElementById('edit-tools')
const regionCountEl = document.getElementById('region-count')
const deleteRegionBtn = document.getElementById('delete-region-btn')
const clearRegionsBtn = document.getElementById('clear-regions-btn')
const cutBtn = document.getElementById('cut-btn')
const saveBtn = document.getElementById('save-btn')
const volumeInput = document.getElementById('volume-input')
const volumeApplyBtn = document.getElementById('volume-apply-btn')
const volumeDownBtn = document.getElementById('volume-down-btn')
const volumeUpBtn = document.getElementById('volume-up-btn')
const volumeDoubleBtn = document.getElementById('volume-double-btn')
const volumeMuteBtn = document.getElementById('volume-mute-btn')
const undoBtn = document.getElementById('undo-btn')
const redoBtn = document.getElementById('redo-btn')

const REGION_COLOR = 'rgba(91, 141, 239, 0.22)'
const REGION_COLOR_SELECTED = 'rgba(255, 176, 60, 0.42)'

let wavesurfer = null
let regionsPlugin = null
let selectedRegion = null
let loadToken = 0 // 音声の読み込み/カットごとにインクリメントし、キャッシュを回避する
let busy = false // カット処理中などの多重操作を防ぐ
let canSave = false // 編集操作（カット/音量調整）が行われ、保存可能な中間ファイルが存在するか
let canUndo = false // 1つ前の版に戻せるか
let canRedo = false // 1つ先の版に進めるか

// 秒を m:ss.d 形式に整形
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const d = Math.floor((seconds * 10) % 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

function updateTime() {
  if (!wavesurfer) return
  timeEl.textContent = `${formatTime(wavesurfer.getCurrentTime())} / ${formatTime(wavesurfer.getDuration())}`
}

// 再生状態に応じてボタンの活性/非活性を切り替える
function setTransportState(state) {
  // state: 'stopped' | 'playing' | 'paused'
  playBtn.disabled = state === 'playing'
  pauseBtn.disabled = state !== 'playing'
  stopBtn.disabled = state === 'stopped'
}

// 範囲選択に関するボタン・表示を現在の状態に合わせて更新する
function updateEditControls() {
  const count = regionsPlugin ? regionsPlugin.getRegions().length : 0
  regionCountEl.textContent = `選択範囲: ${count}`
  deleteRegionBtn.disabled = busy || !selectedRegion
  clearRegionsBtn.disabled = busy || count === 0
  cutBtn.disabled = busy || count === 0
  // 保存は編集操作（カット/音量調整）が行われたときのみ有効
  saveBtn.disabled = busy || !canSave
  // 音量調整は音声が読み込まれていて処理中でないときに有効
  const volumeReady = !busy && !!wavesurfer
  volumeInput.disabled = !volumeReady
  volumeApplyBtn.disabled = !volumeReady
  volumeDownBtn.disabled = !volumeReady
  volumeUpBtn.disabled = !volumeReady
  volumeDoubleBtn.disabled = !volumeReady
  volumeMuteBtn.disabled = !volumeReady
  // アンドゥ/リドゥは戻せる/進める版があるときのみ有効
  undoBtn.disabled = busy || !canUndo
  redoBtn.disabled = busy || !canRedo
}

// main から返る履歴/保存の状態（canUndo / canRedo / hasEdits）を反映する。
// load / cut / volume / undo / redo の各処理後に共通で呼ぶ。
function applyHistoryState(state) {
  canSave = !!state.hasEdits
  canUndo = !!state.canUndo
  canRedo = !!state.canRedo
  updateEditControls()
}

function selectRegion(region) {
  if (selectedRegion && selectedRegion !== region) {
    selectedRegion.setOptions({ color: REGION_COLOR })
  }
  selectedRegion = region
  if (region) region.setOptions({ color: REGION_COLOR_SELECTED })
  updateEditControls()
}

function clearSelection() {
  if (selectedRegion) selectedRegion.setOptions({ color: REGION_COLOR })
  selectedRegion = null
  updateEditControls()
}

function destroyWavesurfer() {
  if (wavesurfer) {
    wavesurfer.destroy()
    wavesurfer = null
    regionsPlugin = null
    selectedRegion = null
  }
}

// 波形を（再）描画する。読み込み・カット後に共通で呼ぶ。
function renderWaveform(peaks, duration, token) {
  destroyWavesurfer()

  wavesurfer = WaveSurfer.create({
    container: waveformEl,
    height: 160,
    waveColor: '#5b8def',
    progressColor: '#2f6fe0',
    cursorColor: '#ff5c5c', // プレイヘッド（再生位置カーソル）
    cursorWidth: 2,
    barWidth: 2,
    barGap: 1,
    barRadius: 1,
    interact: true // 波形クリックでシーク
  })

  // Regions プラグイン：ドラッグで範囲選択、端のドラッグで微調整
  regionsPlugin = wavesurfer.registerPlugin(RegionsPlugin.create())
  regionsPlugin.enableDragSelection({ color: REGION_COLOR, drag: true, resize: true })

  regionsPlugin.on('region-created', (region) => {
    selectRegion(region)
  })
  regionsPlugin.on('region-updated', () => {
    updateEditControls()
  })
  regionsPlugin.on('region-clicked', (region, e) => {
    e.stopPropagation() // 範囲クリックでシークさせない
    selectRegion(region)
  })
  regionsPlugin.on('region-removed', () => {
    if (selectedRegion && selectedRegion.isRemoved) selectedRegion = null
    updateEditControls()
  })

  // 波形の何もない所をクリックしたら選択解除
  wavesurfer.on('interaction', () => clearSelection())

  wavesurfer.on('play', () => setTransportState('playing'))
  wavesurfer.on('pause', () => {
    setTransportState(wavesurfer.getCurrentTime() === 0 ? 'stopped' : 'paused')
  })
  wavesurfer.on('finish', () => setTransportState('stopped'))
  wavesurfer.on('timeupdate', updateTime)
  wavesurfer.on('ready', updateTime)

  // url + 事前計算した peaks + duration を渡すことで、
  // ファイル全体のフェッチ/デコードを行わずに描画する。
  // 再生は <audio> が app-audio プロトコル経由でストリーム取得する。
  const mediaUrl = `app-audio://media/audio?token=${token}`
  return wavesurfer.load(mediaUrl, [peaks], duration)
}

async function openAndLoad() {
  if (busy) return
  const filePath = await window.api.openAudioFile()
  if (!filePath) return

  const token = ++loadToken
  busy = true
  canSave = false // 新規読み込み時点では未編集なので保存は無効
  statusEl.textContent = '波形を生成中…'
  openFileBtn.disabled = true
  placeholderEl.hidden = true

  try {
    // メインプロセスで ffmpeg により軽量なピークデータを生成（長尺でもメモリ安全）
    const state = await window.api.loadAudio(filePath)
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    transportEl.hidden = false
    editToolsEl.hidden = false
    applyHistoryState(state) // 読み込み直後は未編集（undo/redo/save すべて無効）
    setTransportState('stopped')
    clearSelection()
    updateTime()
    statusEl.textContent = filePath
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = ''
      placeholderEl.hidden = false
      placeholderEl.textContent = `読み込みに失敗しました: ${err.message}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

async function doCut() {
  if (busy || !regionsPlugin) return
  const regions = regionsPlugin.getRegions().map((r) => ({ start: r.start, end: r.end }))
  if (regions.length === 0) return

  const token = ++loadToken
  busy = true
  openFileBtn.disabled = true
  statusEl.textContent = 'カット処理中…'
  updateEditControls()

  try {
    // メインプロセスで ffmpeg によりディスク上でカット（メモリに全展開しない）
    const state = await window.api.cutRegions(regions)
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    applyHistoryState(state) // カット結果ができたので保存可能・アンドゥ可能
    setTransportState('stopped')
    clearSelection()
    updateTime()
    statusEl.textContent = `カット完了（長さ: ${formatTime(state.duration)}）`
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = `カットに失敗しました: ${err.message}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

// 音量を調整する。範囲が選択されていればその範囲のみ、なければ全体に適用する。
// presetPercent を渡すとその値を使い、未指定なら数値入力の値を使う。
async function doVolume(presetPercent) {
  if (busy || !wavesurfer) return

  let percent
  if (presetPercent === undefined) {
    percent = Number(volumeInput.value)
  } else {
    percent = presetPercent
    volumeInput.value = String(presetPercent) // プリセットを入力欄にも反映
  }
  if (!Number.isFinite(percent) || percent < 0) {
    statusEl.textContent = '音量の値が不正です（0 以上の数値を入力してください）'
    return
  }

  // 範囲が選択されていればその範囲のみ、なければ全体（null）に適用
  const region = selectedRegion
    ? { start: selectedRegion.start, end: selectedRegion.end }
    : null
  const factor = percent / 100

  const token = ++loadToken
  busy = true
  openFileBtn.disabled = true
  statusEl.textContent = '音量調整中…'
  updateEditControls()

  try {
    // メインプロセスで ffmpeg によりディスク上で音量調整（メモリに全展開しない）
    const state = await window.api.adjustVolume(factor, region)
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    applyHistoryState(state) // 音量調整の結果ができたので保存可能・アンドゥ可能
    setTransportState('stopped')
    clearSelection()
    updateTime()
    const scope = region ? '選択範囲' : '全体'
    statusEl.textContent = `音量調整完了（${percent}% / ${scope}）`
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = `音量調整に失敗しました: ${err.message}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

// アンドゥ／リドゥ共通処理。版を切り替え、その版の状態に波形を再描画する。
// ffmpeg の再処理は行わず、各版が保持する中間ファイル（peaks/duration）を使う。
async function navigateHistory(direction) {
  // direction: 'undo' | 'redo'
  if (busy) return
  if (direction === 'undo' && !canUndo) return
  if (direction === 'redo' && !canRedo) return

  const token = ++loadToken
  busy = true
  openFileBtn.disabled = true
  statusEl.textContent = direction === 'undo' ? '元に戻しています…' : 'やり直しています…'
  updateEditControls()

  try {
    const state = direction === 'undo' ? await window.api.undo() : await window.api.redo()
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    applyHistoryState(state)
    setTransportState('stopped')
    clearSelection()
    updateTime()
    if (direction === 'undo') {
      statusEl.textContent = state.hasEdits
        ? `元に戻しました（長さ: ${formatTime(state.duration)}）`
        : '最初の状態に戻しました'
    } else {
      statusEl.textContent = `やり直しました（長さ: ${formatTime(state.duration)}）`
    }
  } catch (err) {
    if (token === loadToken) {
      const label = direction === 'undo' ? '元に戻せませんでした' : 'やり直せませんでした'
      statusEl.textContent = `${label}: ${err.message}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

// 現在の編集結果を、選んだフォーマットでディスクへ書き出す
async function doSave() {
  if (busy || !canSave) return

  busy = true
  openFileBtn.disabled = true
  const prevStatus = statusEl.textContent
  statusEl.textContent = '保存中…'
  updateEditControls()

  try {
    const result = await window.api.exportAudio()
    if (result) {
      statusEl.textContent = `保存しました: ${result.path}`
    } else {
      // 保存ダイアログでキャンセルされた場合は元の表示に戻す
      statusEl.textContent = prevStatus
    }
  } catch (err) {
    statusEl.textContent = `保存に失敗しました: ${err.message}`
  } finally {
    busy = false
    openFileBtn.disabled = false
    updateEditControls()
  }
}

openFileBtn.addEventListener('click', openAndLoad)

playBtn.addEventListener('click', () => wavesurfer && wavesurfer.play())
pauseBtn.addEventListener('click', () => wavesurfer && wavesurfer.pause())
stopBtn.addEventListener('click', () => {
  if (!wavesurfer) return
  wavesurfer.stop() // 停止して先頭へ
  setTransportState('stopped')
  updateTime()
})

deleteRegionBtn.addEventListener('click', () => {
  if (busy || !selectedRegion) return
  selectedRegion.remove()
  selectedRegion = null
  updateEditControls()
})

clearRegionsBtn.addEventListener('click', () => {
  if (busy || !regionsPlugin) return
  regionsPlugin.clearRegions()
  selectedRegion = null
  updateEditControls()
})

cutBtn.addEventListener('click', doCut)
saveBtn.addEventListener('click', doSave)

undoBtn.addEventListener('click', () => navigateHistory('undo'))
redoBtn.addEventListener('click', () => navigateHistory('redo'))

// 音量調整：入力値で適用 ＋ よく使う倍率のプリセット
volumeApplyBtn.addEventListener('click', () => doVolume())
volumeDownBtn.addEventListener('click', () => doVolume(50)) // 半分
volumeUpBtn.addEventListener('click', () => doVolume(150)) // 1.5倍
volumeDoubleBtn.addEventListener('click', () => doVolume(200)) // 2倍
volumeMuteBtn.addEventListener('click', () => doVolume(0)) // ミュート

// 数値入力欄など編集可能な要素にフォーカスがあるか（ショートカット誤作動の防止用）
function isTypingInField() {
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

document.addEventListener('keydown', (e) => {
  // 入力欄にフォーカスがある間は、キー操作を欄の編集（数値入力・IME 等）に委ねる
  if (isTypingInField()) return

  // Ctrl+Z でアンドゥ、Ctrl+Y でリドゥ（Cmd も許容）
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase()
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault()
      navigateHistory('undo')
      return
    }
    if (key === 'y') {
      e.preventDefault()
      navigateHistory('redo')
      return
    }
  }

  // Delete / Backspace キーで選択中の範囲を削除
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRegion && !busy) {
    e.preventDefault()
    selectedRegion.remove()
    selectedRegion = null
    updateEditControls()
  }
})
