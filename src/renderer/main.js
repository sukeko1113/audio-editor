import WaveSurfer from 'wavesurfer.js'

const openFileBtn = document.getElementById('open-file-btn')
const statusEl = document.getElementById('status')
const placeholderEl = document.getElementById('placeholder')
const waveformEl = document.getElementById('waveform')
const transportEl = document.getElementById('transport')
const playBtn = document.getElementById('play-btn')
const pauseBtn = document.getElementById('pause-btn')
const stopBtn = document.getElementById('stop-btn')
const timeEl = document.getElementById('time')

let wavesurfer = null
let loadToken = 0 // 音声ファイルの読み込みごとにインクリメントし、キャッシュを回避する

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

function destroyWavesurfer() {
  if (wavesurfer) {
    wavesurfer.destroy()
    wavesurfer = null
  }
}

async function openAndLoad() {
  const filePath = await window.api.openAudioFile()
  if (!filePath) return

  const token = ++loadToken
  statusEl.textContent = '波形を生成中…'
  openFileBtn.disabled = true
  placeholderEl.hidden = true

  try {
    // メインプロセスで ffmpeg により軽量なピークデータを生成（長尺でもメモリ安全）
    const { peaks, duration } = await window.api.loadAudio(filePath)

    // 生成中に別のファイルが読み込まれていたら破棄
    if (token !== loadToken) return

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

    wavesurfer.on('play', () => setTransportState('playing'))
    wavesurfer.on('pause', () => {
      // stop() でも pause イベントが飛ぶため、位置で停止/一時停止を判別
      setTransportState(wavesurfer.getCurrentTime() === 0 ? 'stopped' : 'paused')
    })
    wavesurfer.on('finish', () => setTransportState('stopped'))
    wavesurfer.on('timeupdate', updateTime)
    wavesurfer.on('ready', updateTime)

    // url + 事前計算した peaks + duration を渡すことで、
    // ファイル全体のフェッチ/デコードを行わずに描画する。
    // 再生は <audio> が app-audio プロトコル経由でストリーム取得する。
    const mediaUrl = `app-audio://media/audio?token=${token}`
    await wavesurfer.load(mediaUrl, [peaks], duration)

    if (token !== loadToken) return

    transportEl.hidden = false
    setTransportState('stopped')
    updateTime()
    statusEl.textContent = filePath
  } catch (err) {
    if (token === loadToken) {
      statusEl.textContent = ''
      placeholderEl.hidden = false
      placeholderEl.textContent = `読み込みに失敗しました: ${err.message}`
    }
  } finally {
    if (token === loadToken) openFileBtn.disabled = false
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
