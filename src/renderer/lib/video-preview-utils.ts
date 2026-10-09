/**
 * 视频跳轴与切片高亮纯函数工具集
 * 遵循单一事实源与悲观防御设计
 */

/**
 * 将秒数格式化为 mm:ss 胶囊文本
 */
export function formatVideoTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const totalSec = Math.floor(seconds)
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
}

/**
 * 视频跳轴安全时间夹紧算法
 * - 负数夹紧至 0
 * - 超过总时长夹紧至 safeDuration - 0.1，防止播放器卡在最后一帧崩溃
 * - 总时长无效时使用 3600 秒兜底
 */
export function clampVideoTime(targetTime: number, duration: number): number {
  if (!Number.isFinite(targetTime)) return 0
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 3600
  return Math.max(0, Math.min(targetTime, Math.max(0, safeDuration - 0.1)))
}

/**
 * 进度条切片高亮百分比计算
 * 返回 left 与 width 样式百分比（0~100）
 */
export function computeHighlightPercent(
  startSec: number,
  endSec: number,
  duration: number
): { left: number; width: number } {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { left: 0, width: 0 }
  }
  const safeStart = Math.max(0, Math.min(duration, startSec))
  const safeEnd = Math.max(safeStart, Math.min(duration, endSec))

  const left = Math.max(0, Math.min(100, (safeStart / duration) * 100))
  const width = Math.max(1, Math.min(100, ((safeEnd - safeStart) / duration) * 100))
  return { left, width }
}
