/**
 * 音声の長さに関する共通ルール。
 *
 * 「最長3時間程度」（要件5.1）の上限は、末尾へのファイル追加と複数ファイルの
 * 一括結合の両方で判定する。2か所に同じ数値を書くと片方だけ変えたときに
 * ずれるため、上限と表示用の整形をここ1か所にまとめている。
 */

// 扱える音声の長さの上限（秒）。これを超える結合は、時間のかかる変換を
// 始める前に中断する。
export const MAX_DURATION = 3 * 60 * 60

// 表示用に秒を「2時間55分3秒」の形へ整形する
export function formatDurationJa(seconds) {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}時間${m}分${s}秒` : `${m}分${s}秒`
}
