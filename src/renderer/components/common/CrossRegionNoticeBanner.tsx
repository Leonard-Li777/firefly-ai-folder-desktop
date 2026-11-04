import React, { useState, useEffect } from 'react'
import { Info, X } from 'lucide-react'
import { t } from '@app/languages'

const STORAGE_KEY = 'firefly_dismissed_cross_region_notice_v4'

/**
 * 跨区域覆盖安装历史数据感知提示条 (P1 / ISS-04)
 * 当检测到对侧区域的历史数据目录存在时，在顶部提供非阻断轻量说明，不影响用户正常使用与登录
 */
export const CrossRegionNoticeBanner: React.FC = () => {
  const [visible, setVisible] = useState(false)
  const [peerRegion, setPeerRegion] = useState<'cn' | 'intl'>('intl')

  useEffect(() => {
    try {
      const isDismissed = localStorage.getItem(STORAGE_KEY) === 'true'
      if (isDismissed) {
        return
      }

      const status = window.electronAPI?.getCrossRegionStatus?.()
      if (status?.hasPeerData) {
        setPeerRegion(status.peerRegion)
        setVisible(true)
      }
    } catch {
      // safe fallback
    }
  }, [])

  const handleDismiss = () => {
    setVisible(false)
    try {
      localStorage.setItem(STORAGE_KEY, 'true')
    } catch {}
  }

  if (!visible) {
    return null
  }

  const noticeText =
    peerRegion === 'intl'
      ? t('提示：检测到您曾安装过国际版，历史数据保存在原目录中，两个区域的数据相互独立。')
      : t('提示：检测到您曾安装过国内版，历史数据保存在原目录中，两个区域的数据相互独立。')

  return (
    <div className="w-full bg-sky-500/10 dark:bg-sky-950/40 border-b border-sky-500/20 px-4 py-2 flex items-center justify-between text-xs text-sky-800 dark:text-sky-200 transition-all z-[999]">
      <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap">
        <Info className="w-3.5 h-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
        <span>{noticeText}</span>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="p-1 rounded-md text-sky-600 dark:text-sky-400 hover:bg-sky-500/15 transition-colors shrink-0 ml-2"
        aria-label="关闭提示"
        title="关闭提示"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
