import React, { useEffect, useState } from 'react'
import { Cpu } from 'lucide-react'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useUiJank } from '../../hooks/useUiJank'
import { HintBanner } from '../ui/hint-banner'

// 正文与 title（截断时的悬浮全量）共用同一来源
const CONTENTION_TEXT = '检测到界面卡顿，文件分析队列可能占用了较多算力，暂停它可让当前操作更流畅'

/**
 * 算力争抢横幅（挂在 DirectoryHeader 底部，贯穿视口宽度）
 *
 * 触发条件：界面正在卡顿，且文件分析队列确实在跑。
 * 队列没在跑时界面仍然卡，就不是这条横幅能解释的事，弹出来只会让用户去暂停一个本来就没在跑的队列。
 *
 * 消失条件：
 * 1. 卡顿结束（useUiJank 自动回到 false）——不卡了就不该继续占着屏幕；
 * 2. 用户点 X——本次卡顿不再打扰，但卡顿结束后会重置，
 *    下一次新卡顿属于新事件，仍需要提示，避免用户以为"关过一次就永久静音"。
 */
export function ResourceContentionBanner() {
  const queueRunning = useAnalysisQueueStore(s => s.snapshot.running)
  // 队列可能在另一个工作目录里跑，必须把「正在跑的那个目录」作为暂停目标，
  // 否则 pause() 默认取当前工作目录，会暂停一个根本没在跑的队列（用户以为点坏了）
  const activeRunningWorkspaceId = useAnalysisQueueStore(s => s.snapshot.activeRunningWorkspaceId)
  const janky = useUiJank()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!janky) setDismissed(false)
  }, [janky])

  if (!janky || !queueRunning || dismissed) return null

  return (
    <HintBanner
      icon={<Cpu className="w-3.5 h-3.5 animate-pulse" />}
      title={t(CONTENTION_TEXT)}
      className="border-t border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-300 py-1.5"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      actions={
        <button
          type="button"
          className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded border border-amber-600/40 hover:bg-amber-500/20 font-medium transition-colors cursor-pointer"
          onClick={() => {
            void useAnalysisQueueStore.getState().pause(activeRunningWorkspaceId)
          }}
        >
          {t('暂停文件分析')}
        </button>
      }
      onClose={() => setDismissed(true)}
    >
      {t(CONTENTION_TEXT)}
    </HintBanner>
  )
}
