import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Cpu } from 'lucide-react'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useUiJank } from '../../hooks/useUiJank'
import { useTTSAudioStore } from '../../stores/tts-audio-store'
import { useOrganizeStore } from '../../stores/organize-store'
import { HintBanner } from '../ui/hint-banner'

// 正文与 title（截断时的悬浮全量）共用同一来源
const CONTENTION_TEXT = '检测到界面卡顿，文件分析队列可能占用了较多算力，暂停它可让当前操作更流畅'

/**
 * 算力争抢横幅（挂在 DirectoryHeader 底部，贯穿视口宽度）
 *
 * 触发条件：
 * 1. 界面正在卡顿（janky），且文件分析队列确实在跑（queueRunning），且用户未在本次卡顿中手动点击关闭（!dismissed）；
 * 2. 队列没在跑时界面仍然卡，就不是这条横幅能解释的事，弹出来只会让用户去暂停一个本来就没在跑的队列；
 * 3. 出现场景严格受限于：
 *    - 语音合成正在进行（无视页面，只要卡顿均显示）；
 *    - 否则，用户位于批量整理（/organize）的自动归类（organizing）| 完成（done）stage 或者智能聚类（smart-clustering）stage。
 *
 * 消失条件：
 * 1. 卡顿结束（useUiJank 自动回到 false）——不卡了就不该继续占着屏幕；
 * 2. 用户点 X——本次卡顿不再打扰，但卡顿结束后会重置，
 *    下一次新卡顿属于新事件，仍需要提示，避免用户以为"关过一次就永久静音"。
 */
export function ResourceContentionBanner() {
  const location = useLocation()
  const queueRunning = useAnalysisQueueStore(s => s.snapshot.running)
  // 队列可能在另一个工作目录里跑，必须把「正在跑的那个目录」作为暂停目标，
  // 否则 pause() 默认取当前工作目录，会暂停一个根本没在跑的队列（用户以为点坏了）
  const activeRunningWorkspaceId = useAnalysisQueueStore(s => s.snapshot.activeRunningWorkspaceId)
  const janky = useUiJank()
  const [dismissed, setDismissed] = useState(false)

  const ttsStatus = useTTSAudioStore(s => s.status)
  const isSynthesizing = useTTSAudioStore(s => s.isSynthesizing)
  const stage = useOrganizeStore(s => s.stage)

  useEffect(() => {
    if (!janky) setDismissed(false)
  }, [janky])

  // 1. 语音合成正在进行：无视页面，只要卡顿都显示
  const isTTSInProgress =
    isSynthesizing ||
    ttsStatus === 'loading' ||
    ttsStatus === 'playing' ||
    ttsStatus === 'exporting'

  // 2. 否则用户位于批量整理的自动归类|完成stage或者智能聚类stage
  const isOrganizeTargetStage =
    location.pathname === '/organize' &&
    (stage === 'organizing' || stage === 'done' || stage === 'smart-clustering')

  const isEligible = isTTSInProgress || isOrganizeTargetStage

  if (!janky || !queueRunning || dismissed || !isEligible) return null

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
