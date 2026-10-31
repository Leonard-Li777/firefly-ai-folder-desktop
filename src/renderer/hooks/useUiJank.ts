import { useEffect, useState } from 'react'

/** 单帧间隔超过此值即视为一次"可见卡顿"（60fps 正常帧约 16ms） */
const STALL_FRAME_MS = 150
/** 卡顿统计窗口：窗口内累计达到阈值次数才判定为正在卡顿 */
const STALL_WINDOW_MS = 6000
/** 判定为卡顿所需的窗口内卡顿次数（单次长帧可能只是 GC / 一次性重排，不足以打扰用户） */
const STALL_TRIGGER_COUNT = 3

/**
 * 界面卡顿探测器（渲染线程体感）
 *
 * 原理：requestAnimationFrame 的回调之间若出现远超一帧的间隔，说明主线程被同步任务占住
 * 或合成帧被持续挤占——这正是用户口中"卡"的直接来源。因此这里只观测帧间隔，
 * 不去猜测是哪个服务在吃 CPU：判定与归因分开，归因交给横幅文案去做"可能"表述。
 *
 * 恢复：卡顿记录在 STALL_WINDOW_MS 内滚动过期，连续无卡顿满一个窗口后自动判定恢复，
 * 不需要额外计时器，也不会出现"卡顿早已结束但标记还挂着"的粘滞状态。
 *
 * 窗口隐藏/最小化时 rAF 会被浏览器整体停摆，恢复瞬间的首帧 delta 极大，
 * 必须重置基线并清空历史，否则每次最小化后回来都会误报一次卡顿。
 */
export function useUiJank(): boolean {
  const [janky, setJanky] = useState(false)

  useEffect(() => {
    let rafId = 0
    let lastFrameAt = 0
    let stalls: number[] = []

    const tick = (now: number) => {
      if (lastFrameAt === 0) {
        lastFrameAt = now
      } else {
        const delta = now - lastFrameAt
        lastFrameAt = now

        if (delta > STALL_FRAME_MS) {
          stalls.push(now)
        }
        const cutoff = now - STALL_WINDOW_MS
        if (stalls.length > 0 && stalls[0] < cutoff) {
          stalls = stalls.filter(at => at >= cutoff)
        }

        const nextJanky = stalls.length >= STALL_TRIGGER_COUNT
        setJanky(prev => (prev === nextJanky ? prev : nextJanky))
      }
      rafId = requestAnimationFrame(tick)
    }

    const handleVisibilityChange = () => {
      lastFrameAt = 0
      stalls = []
      setJanky(false)
    }

    rafId = requestAnimationFrame(tick)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelAnimationFrame(rafId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return janky
}
