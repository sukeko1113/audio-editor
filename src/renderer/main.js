import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'

const openFileBtn = document.getElementById('open-file-btn')
const appendFileBtn = document.getElementById('append-file-btn')
const concatFilesBtn = document.getElementById('concat-files-btn')
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
const zoomOutBtn = document.getElementById('zoom-out-btn')
const zoomInBtn = document.getElementById('zoom-in-btn')
const zoomSlider = document.getElementById('zoom-slider')
const zoomValueEl = document.getElementById('zoom-value')

// 一括結合の確認ダイアログ
const concatOverlayEl = document.getElementById('concat-overlay')
const concatListEl = document.getElementById('concat-list')
const concatSummaryEl = document.getElementById('concat-summary')
const concatWarningEl = document.getElementById('concat-warning')
const concatProgressEl = document.getElementById('concat-progress')
const concatCancelBtn = document.getElementById('concat-cancel-btn')
const concatRunBtn = document.getElementById('concat-run-btn')

// はい／いいえの確認ダイアログ
const confirmOverlayEl = document.getElementById('confirm-overlay')
const confirmMessageEl = document.getElementById('confirm-message')
const confirmYesBtn = document.getElementById('confirm-yes-btn')
const confirmNoBtn = document.getElementById('confirm-no-btn')

const REGION_COLOR = 'rgba(91, 141, 239, 0.22)'
const REGION_COLOR_SELECTED = 'rgba(255, 176, 60, 0.42)'

let wavesurfer = null
let regionsPlugin = null
let selectedRegion = null
let loadToken = 0 // 音声の読み込み/カットごとにインクリメントし、キャッシュを回避する
let busy = false // カット処理中などの多重操作を防ぐ
let fileLoaded = false // 音声が読み込まれているか（保存は編集の有無に関わらず常に可能）
let canUndo = false // 1つ前の版に戻せるか
let canRedo = false // 1つ先の版に進めるか

// 一括結合の確認ダイアログの状態。編集セッション（版履歴）とは独立している。
let concatItems = [] // [{ path, name, duration }] ダイアログに表示中の並び順
let concatLimit = 3 * 60 * 60 // 合計時間の上限(秒)。main から受け取った値で上書きする。
let concatRunning = false // 結合の実行中（並べ替え・除外・キャンセルを止める）

// 水平ズーム倍率。1 = 音声全体が1画面に収まる初期表示（＝ズーム下限）。
// 表示のみの状態で音声データには影響しない。カット/音量調整/アンドゥ等の
// 再描画をまたいで維持され、新しい長さの上限にクランプされる。
let zoomFactor = 1

const ZOOM_SLIDER_MAX = 100 // スライダーの分解能（0..100）
const ZOOM_BUTTON_STEP = 10 // ＋/−ボタン1回ぶんのスライダー移動量
// ズーム上限：1画面に収まる最小の秒数。長尺でも「duration / この値」が
// 上限倍率になるため、3時間音声を無制限に拡大することはできない。
// （wavesurfer v7 は拡大時もキャンバスを分割し可視範囲のみ遅延描画するため、
//   この上限なら描画・メモリ負荷は破綻しない）
const ZOOM_MIN_VISIBLE_SECONDS = 5

// main 側で投げた Error は IPC を通ると
// 「Error invoking remote method 'audio:append': Error: 本文」の形に包まれる。
// ステータス表示は1行しかないため、包み紙を外して本文だけを見せる。
function errorText(err) {
  const message = (err && err.message) || String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

// 秒を m:ss.d 形式に整形
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const d = Math.floor((seconds * 10) % 10)
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

// 秒を「1時間23分45秒」形式に整形（一覧の合計時間・結合結果の長さの表示用）。
// formatTime は m:ss.d 形式で、3時間ぶんだと「180:00.0」となり読みにくいため使い分ける。
function formatDurationJa(seconds) {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}時間${m}分${s}秒` : `${m}分${s}秒`
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
  // 音量調整・末尾へのファイル追加は、音声が読み込まれていて処理中でないときに有効
  const audioReady = !busy && !!wavesurfer
  // 保存はファイルが開かれていれば常に有効。編集が無くても形式変換として
  // 書き出せるため、編集も形式変換も無い場合の中断は保存ダイアログで
  // 出力形式が決まったあとに main 側で判断する。
  saveBtn.disabled = !audioReady || !fileLoaded
  volumeInput.disabled = !audioReady
  volumeApplyBtn.disabled = !audioReady
  volumeDownBtn.disabled = !audioReady
  volumeUpBtn.disabled = !audioReady
  volumeDoubleBtn.disabled = !audioReady
  volumeMuteBtn.disabled = !audioReady
  appendFileBtn.disabled = !audioReady
  // 一括結合はファイルが開かれていなくても使えるので、処理中かどうかだけで決める
  concatFilesBtn.disabled = busy
  // アンドゥ/リドゥは戻せる/進める版があるときのみ有効
  undoBtn.disabled = busy || !canUndo
  redoBtn.disabled = busy || !canRedo
  updateZoomControls()
}

// 現在の音声に対するズーム倍率の上限（下限は常に 1 = 全体表示）
function maxZoomFactor() {
  if (!wavesurfer) return 1
  const duration = wavesurfer.getDuration()
  if (!Number.isFinite(duration) || duration <= 0) return 1
  return Math.max(1, duration / ZOOM_MIN_VISIBLE_SECONDS)
}

// スライダー位置(0..MAX) と ズーム倍率(1..上限) の対数マッピング。
// 3時間音声では上限が数千倍になるため、線形だと低倍率側がほぼ操作不能になる。
function sliderToFactor(pos) {
  const max = maxZoomFactor()
  if (max <= 1) return 1
  return Math.pow(max, pos / ZOOM_SLIDER_MAX)
}

function factorToSlider(factor) {
  const max = maxZoomFactor()
  if (max <= 1 || factor <= 1) return 0
  return Math.round((Math.log(factor) / Math.log(max)) * ZOOM_SLIDER_MAX)
}

// スライダー位置・倍率表示・ボタンの活性状態を現在の zoomFactor に同期する
function updateZoomControls() {
  const ready = !busy && !!wavesurfer && Number.isFinite(wavesurfer.getDuration()) && wavesurfer.getDuration() > 0
  const max = maxZoomFactor()
  zoomSlider.disabled = !ready || max <= 1
  zoomOutBtn.disabled = !ready || zoomFactor <= 1
  zoomInBtn.disabled = !ready || zoomFactor >= max
  zoomSlider.value = String(factorToSlider(zoomFactor))
  zoomValueEl.textContent = zoomFactor >= 10 ? `×${Math.round(zoomFactor)}` : `×${zoomFactor.toFixed(1)}`
}

// 現在の zoomFactor を wavesurfer に適用する。
// wavesurfer 標準の zoom(minPxPerSec) を利用する：拡大で波形全体の幅が
// コンテナを超えると横スクロールバーが自動表示され、Regions・プレイヘッドも
// 時間ベースで追従するため位置がずれない。
function applyZoom() {
  if (!wavesurfer) return
  const duration = wavesurfer.getDuration()
  if (!Number.isFinite(duration) || duration <= 0) return
  zoomFactor = Math.min(Math.max(zoomFactor, 1), maxZoomFactor())
  if (zoomFactor <= 1) {
    // minPxPerSec = 0 はコンテナ幅にフィット（初期表示と同じ）
    wavesurfer.zoom(0)
  } else {
    // 「全体がちょうど1画面に収まる px/秒」× 倍率
    const scrollEl = wavesurfer.getWrapper().parentElement
    const viewWidth = (scrollEl && scrollEl.clientWidth) || waveformEl.clientWidth
    wavesurfer.zoom((viewWidth / duration) * zoomFactor)
  }
  updateZoomControls()
}

// main から返る履歴の状態（canUndo / canRedo）を反映する。
// load / cut / volume / undo / redo の各処理後に共通で呼ぶ。
// 保存の可否は編集の有無に依存しないため、ここでは扱わない。
function applyHistoryState(state) {
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
async function renderWaveform(peaks, duration, token) {
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
  const ws = wavesurfer
  await ws.load(mediaUrl, [peaks], duration)

  // ズーム状態を再描画をまたいで維持する。カットで長さが変わった場合に備えて
  // 新しい上限にクランプし、拡大中なら同じ倍率で描画し直す。
  // （このあいだに新しい読み込みが始まっていたら何もしない）
  if (ws !== wavesurfer || token !== loadToken) return
  zoomFactor = Math.min(zoomFactor, maxZoomFactor())
  if (zoomFactor > 1) {
    applyZoom()
  } else {
    updateZoomControls()
  }
}

async function openAndLoad() {
  if (busy) return
  const filePath = await window.api.openAudioFile()
  if (!filePath) return
  await loadFile(filePath)
}

// 指定パスの音声を読み込み、波形を描画して編集できる状態にする。
// 「ファイルを開く」と「結合結果を開く」で共用する（どちらも版履歴は作り直しになる）。
async function loadFile(filePath) {
  const token = ++loadToken
  busy = true
  fileLoaded = false // 読み込みが完了するまでは保存できない
  zoomFactor = 1 // 新しいファイルは全体表示から始める
  statusEl.textContent = '波形を生成中…'
  openFileBtn.disabled = true
  appendFileBtn.disabled = true
  placeholderEl.hidden = true

  try {
    // メインプロセスで ffmpeg により軽量なピークデータを生成（長尺でもメモリ安全）
    const state = await window.api.loadAudio(filePath)
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    transportEl.hidden = false
    editToolsEl.hidden = false
    fileLoaded = true // 未編集でも形式変換として保存できるので、この時点で保存は有効
    applyHistoryState(state) // 読み込み直後は未編集（undo/redo は無効）
    setTransportState('stopped')
    clearSelection()
    updateTime()
    statusEl.textContent = filePath
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = ''
      placeholderEl.hidden = false
      placeholderEl.textContent = `読み込みに失敗しました: ${errorText(err)}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

// 選択したファイルを現在の編集対象の末尾に連結する。
// 連結結果は1本の音声として新しい版になり、以降は通常どおり編集できる。
async function doAppend() {
  if (busy || !wavesurfer) return
  const filePath = await window.api.openAppendFile()
  if (!filePath) return

  const token = ++loadToken
  busy = true
  openFileBtn.disabled = true
  statusEl.textContent = 'ファイルを追加中…'
  updateEditControls()

  try {
    // メインプロセスで ffmpeg によりディスク上で連結（メモリに全展開しない）
    const state = await window.api.appendAudio(filePath)
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    applyHistoryState(state) // 連結結果ができたので保存可能・アンドゥ可能
    setTransportState('stopped')
    clearSelection()
    updateTime()
    statusEl.textContent = `ファイルを追加しました（長さ: ${formatTime(state.duration)}）`
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = `ファイルの追加に失敗しました: ${errorText(err)}`
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
      statusEl.textContent = `カットに失敗しました: ${errorText(err)}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

// 音量を調整する。範囲が選択されていればそのすべての範囲に、なければ全体に適用する
// （カットと同様に、選択中の全範囲をまとめて対象にする）。
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

  // カットと同じ集め方：選択中のすべての範囲を対象に、なければ全体（空配列）に適用
  const regions = regionsPlugin
    ? regionsPlugin.getRegions().map((r) => ({ start: r.start, end: r.end }))
    : []
  const factor = percent / 100

  const token = ++loadToken
  busy = true
  openFileBtn.disabled = true
  statusEl.textContent = '音量調整中…'
  updateEditControls()

  try {
    // メインプロセスで ffmpeg によりディスク上で音量調整（メモリに全展開しない）
    const state = await window.api.adjustVolume(factor, regions)
    if (token !== loadToken) return

    await renderWaveform(state.peaks, state.duration, token)
    if (token !== loadToken) return

    applyHistoryState(state) // 音量調整の結果ができたので保存可能・アンドゥ可能
    setTransportState('stopped')
    clearSelection()
    updateTime()
    const scope =
      regions.length === 0
        ? '全体'
        : regions.length === 1
          ? '選択範囲'
          : `選択範囲 ${regions.length}箇所`
    statusEl.textContent = `音量調整完了（${percent}% / ${scope}）`
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = `音量調整に失敗しました: ${errorText(err)}`
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
      statusEl.textContent = `${label}: ${errorText(err)}`
    }
  } finally {
    if (token === loadToken) {
      busy = false
      openFileBtn.disabled = false
      updateEditControls()
    }
  }
}

// 現在の編集結果を、選んだフォーマットでディスクへ書き出す。
// 編集が無い場合は形式変換としての保存になり、選んだ出力形式が
// 元ファイルと同じ（＝書き出す内容に変わりが無い）なら main 側で中断される。
async function doSave() {
  if (busy || !fileLoaded) return

  busy = true
  openFileBtn.disabled = true
  const prevStatus = statusEl.textContent
  statusEl.textContent = '保存中…'
  updateEditControls()

  try {
    const result = await window.api.exportAudio()
    if (!result) {
      // 保存ダイアログでキャンセルされた場合は元の表示に戻す
      statusEl.textContent = prevStatus
    } else if (result.unchanged) {
      statusEl.textContent = '変更がありません（編集がなく、出力形式も元ファイルと同じです）'
    } else if (result.converted) {
      statusEl.textContent = `形式を変換して保存しました: ${result.path}`
    } else {
      statusEl.textContent = `保存しました: ${result.path}`
    }
  } catch (err) {
    statusEl.textContent = `保存に失敗しました: ${errorText(err)}`
  } finally {
    busy = false
    openFileBtn.disabled = false
    updateEditControls()
  }
}

// ---- 複数ファイルの一括結合 ----
// 編集セッション（版履歴）とは独立した機能。選んだファイルを一覧の順番どおりに
// 1本へ結合して保存するだけで、編集中の音声・履歴には影響しない。

// 一覧の合計時間(秒)
function concatTotalDuration() {
  return concatItems.reduce((sum, item) => sum + item.duration, 0)
}

// 結合を実行できる状態か（2ファイル以上あり、合計が上限以内）。
// 警告表示と実行ボタンの活性、実行時のガードで同じ判定を使う。
function canRunConcat() {
  return concatItems.length >= 2 && concatTotalDuration() <= concatLimit
}

// 確認ダイアログの中身（並び順・合計・警告・ボタンの活性）を作り直す。
// 並べ替え・除外のたびに呼ぶ。
function renderConcatList() {
  concatListEl.textContent = '' // 既存の行をすべて捨ててから作り直す
  concatItems.forEach((item, index) => {
    concatListEl.appendChild(createConcatRow(item, index))
  })
  updateConcatSummary()
}

// 一覧の1行。ファイル名は textContent で入れるため、名前に含まれる記号が
// HTML として解釈されることはない。
function createConcatRow(item, index) {
  const row = document.createElement('li')
  row.className = 'concat-row'

  const order = document.createElement('span')
  order.className = 'concat-order'
  order.textContent = `${index + 1}.`

  const name = document.createElement('span')
  name.className = 'concat-name'
  name.textContent = item.name
  name.title = item.path // 同名ファイルの区別用にフルパスをツールチップで見せる

  const duration = document.createElement('span')
  duration.className = 'concat-duration'
  duration.textContent = `${item.duration.toFixed(1)} 秒`

  row.append(
    order,
    name,
    duration,
    createConcatRowButton('↑', '1つ上へ移動', index === 0, () => moveConcatItem(index, -1)),
    createConcatRowButton('↓', '1つ下へ移動', index === concatItems.length - 1, () =>
      moveConcatItem(index, 1)
    ),
    createConcatRowButton('除外', 'この一覧から外す', false, () => removeConcatItem(index))
  )
  return row
}

function createConcatRowButton(label, title, disabled, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn'
  button.textContent = label
  button.title = title
  button.disabled = disabled || concatRunning // 処理中は並べ替え・除外させない
  button.addEventListener('click', onClick)
  return button
}

// 行を1つ上/下へ入れ替える（direction: -1 = 上、+1 = 下）
function moveConcatItem(index, direction) {
  const target = index + direction
  if (concatRunning || target < 0 || target >= concatItems.length) return
  const moved = concatItems[index]
  concatItems[index] = concatItems[target]
  concatItems[target] = moved
  renderConcatList()
}

function removeConcatItem(index) {
  if (concatRunning) return
  concatItems.splice(index, 1)
  renderConcatList()
}

// 合計時間・警告・ボタンの活性を、現在の一覧に合わせて更新する
function updateConcatSummary() {
  const total = concatTotalDuration()
  concatSummaryEl.textContent =
    `合計 ${concatItems.length} ファイル / ` +
    `${total.toFixed(1)} 秒（${formatDurationJa(total)}）`

  // 2ファイル未満・上限超過はどちらも結合できない。理由を出して実行を止める。
  let warning = ''
  if (concatItems.length < 2) {
    warning = '結合するには2つ以上のファイルが必要です。'
  } else if (total > concatLimit) {
    // 上限の呼び方は main 側のエラーメッセージ（「上限の3時間」）に合わせる。
    // 判定そのものは main から受け取った concatLimit で行う。
    warning =
      `合計が上限の3時間を超えています（${formatDurationJa(total)}）。` +
      'ファイルを除外して合計を減らしてください。'
  }
  concatWarningEl.textContent = warning
  concatWarningEl.hidden = warning === ''

  concatRunBtn.disabled = concatRunning || !canRunConcat()
  concatCancelBtn.disabled = concatRunning // 結合は途中で止められないので閉じさせない
}

function setConcatProgress(text) {
  concatProgressEl.textContent = text
  concatProgressEl.hidden = !text
}

// main から届く進捗を、ダイアログに出す1行の文言にする
function concatProgressText(progress) {
  if (!progress) return ''
  switch (progress.phase) {
    case 'probe':
      return 'ファイルを確認中…'
    case 'convert':
      return `変換中… (${progress.current}/${progress.total}) ${progress.name}`
    case 'concat':
      return `結合中…（${progress.total} ファイル）`
    case 'encode':
      return `出力形式へ変換して書き出し中…（${progress.name}）`
    default:
      return '処理中…'
  }
}

// 確認ダイアログの開閉。開いている間は busy 扱いにして、背後の編集操作を止める。
function openConcatDialog() {
  concatRunning = false
  setConcatProgress('')
  concatOverlayEl.hidden = false
  busy = true
  openFileBtn.disabled = true
  renderConcatList()
  updateEditControls()
  concatRunBtn.focus()
}

function closeConcatDialog() {
  if (concatOverlayEl.hidden) return
  concatOverlayEl.hidden = true
  concatItems = []
  setConcatProgress('')
  busy = false
  openFileBtn.disabled = false
  updateEditControls()
}

// ツールバーの「複数ファイルを結合」。ファイルを選ばせ、長さを調べて確認ダイアログを出す。
async function startConcat() {
  if (busy) return
  const filePaths = await window.api.openConcatFiles()
  if (!filePaths) return
  if (filePaths.length < 2) {
    statusEl.textContent = '結合するには2つ以上のファイルを選択してください'
    return
  }

  busy = true
  openFileBtn.disabled = true
  statusEl.textContent = 'ファイルの情報を確認中…'
  updateEditControls()

  let info = null
  try {
    // 自然順ソートと各ファイルの長さ取得は main 側（ffprobe）で行う。
    // 読めないファイルがあれば、どのファイルかが分かるエラーになる。
    info = await window.api.inspectConcatFiles(filePaths)
  } catch (err) {
    statusEl.textContent = `ファイルを読み取れませんでした: ${errorText(err)}`
  }

  if (!info) {
    busy = false
    openFileBtn.disabled = false
    updateEditControls()
    return
  }

  statusEl.textContent = ''
  concatItems = info.files
  concatLimit = info.limit
  openConcatDialog() // busy と「ファイルを開く」の抑止はダイアログを閉じるまで続く
}

// 「結合して保存」。保存先の選択から書き出しまでを main に任せ、進捗を表示する。
async function runConcat() {
  if (concatRunning || !canRunConcat()) return

  concatRunning = true
  renderConcatList() // 並べ替え・除外・実行ボタンを無効化する
  setConcatProgress('保存先を選択してください…')
  const stopProgress = window.api.onConcatProgress((progress) => {
    setConcatProgress(concatProgressText(progress))
  })

  let result = null
  try {
    result = await window.api.runConcat(concatItems.map((item) => item.path))
    if (!result) setConcatProgress('保存がキャンセルされました')
  } catch (err) {
    // どのファイルで失敗したかは main 側のメッセージに含まれる
    setConcatProgress(`結合に失敗しました: ${errorText(err)}`)
  } finally {
    stopProgress()
    concatRunning = false
    renderConcatList() // 失敗・キャンセル時はそのまま並べ替えてやり直せる
  }
  if (!result) return

  closeConcatDialog()
  statusEl.textContent =
    `${result.fileCount} ファイルを結合して保存しました` +
    `（長さ: ${formatDurationJa(result.duration)}）: ${result.path}`

  // MP4 は映像を含む書き出し専用の形式なので、編集対象としては読み込めない
  if (result.video) return

  const message = fileLoaded
    ? '結合したファイルを開きますか？\n現在編集中の内容は破棄されます。'
    : '結合したファイルを開きますか？'
  if (await confirmDialog(message)) {
    await loadFile(result.path)
  }
}

// ---- はい／いいえの確認ダイアログ ----
// 押されるまで待って boolean を返す。開いている間は busy 扱いにする。
let confirmResolve = null

function confirmDialog(message) {
  confirmMessageEl.textContent = message
  confirmOverlayEl.hidden = false
  busy = true
  openFileBtn.disabled = true
  updateEditControls()
  confirmYesBtn.focus()
  return new Promise((resolve) => {
    confirmResolve = resolve
  })
}

function closeConfirmDialog(answer) {
  if (!confirmResolve) return
  confirmOverlayEl.hidden = true
  busy = false
  openFileBtn.disabled = false
  updateEditControls()
  const resolve = confirmResolve
  confirmResolve = null
  resolve(answer)
}

// モーダルを開いている間は、背後の編集ショートカットを効かせない
function isModalOpen() {
  return !concatOverlayEl.hidden || !confirmOverlayEl.hidden
}

openFileBtn.addEventListener('click', openAndLoad)
appendFileBtn.addEventListener('click', doAppend)
concatFilesBtn.addEventListener('click', startConcat)

concatRunBtn.addEventListener('click', runConcat)
concatCancelBtn.addEventListener('click', () => {
  if (!concatRunning) closeConcatDialog()
})
confirmYesBtn.addEventListener('click', () => closeConfirmDialog(true))
confirmNoBtn.addEventListener('click', () => closeConfirmDialog(false))

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

// ズーム操作：スライダーとボタンは同じ zoomFactor を介して連動する
zoomSlider.addEventListener('input', () => {
  if (busy || !wavesurfer) return
  zoomFactor = sliderToFactor(Number(zoomSlider.value))
  applyZoom()
})

function stepZoom(direction) {
  if (busy || !wavesurfer) return
  const pos = factorToSlider(zoomFactor) + direction * ZOOM_BUTTON_STEP
  zoomFactor = sliderToFactor(Math.min(ZOOM_SLIDER_MAX, Math.max(0, pos)))
  applyZoom()
}

zoomInBtn.addEventListener('click', () => stepZoom(1))
zoomOutBtn.addEventListener('click', () => stepZoom(-1))

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
  // モーダル表示中は Esc（キャンセル／いいえ）だけを扱い、
  // 背後の編集ショートカットは動かさない
  if (isModalOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!confirmOverlayEl.hidden) {
        closeConfirmDialog(false)
      } else if (!concatRunning) {
        closeConcatDialog()
      }
    }
    return
  }

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
