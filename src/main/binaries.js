import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

// パッケージ化(asar)された場合、バイナリは asar 外(unpacked)に展開されるため
// パスを付け替える。開発時は置換対象が無いのでそのまま。
function unpacked(binaryPath) {
  return (binaryPath || '').replace('app.asar', 'app.asar.unpacked')
}

export const ffmpegPath = unpacked(ffmpegStatic)
export const ffprobePath = unpacked(ffprobeStatic && ffprobeStatic.path)
