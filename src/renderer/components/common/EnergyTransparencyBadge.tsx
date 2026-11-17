/**
 * 模块休眠节能胶囊与 Hover 透视卡片组件 (EnergyTransparencyBadge)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.5
 *
 * 关键特性：
 * 1. 响应式布局：宽屏 (>= 1200px) 展示胶囊药丸，窄屏 (< 1200px) 自动收缩为纯图标；
 * 2. 状态驱动：节能中 (isEnergySaving) 采用清新浅绿，全常驻采用常规中性；
 * 3. 悬浮/点击展开大白话浮层：展示可用物理内存、运行中模块、已休眠模块、未决状态提示与异常模块重试入口；
 * 4. 底部提供「一键释放可休眠内存」单按钮，点击排空并弹 Toast。
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Leaf, Zap, RefreshCw, X, Loader2, Info, AlertTriangle } from 'lucide-react'
import { useHibernationStore, selectHibernationGauges } from '../../stores/hibernation-store'
import { toast } from './Toast'
import { t } from '../../../languages'
import { cn } from '../../lib/utils'

/**
 * 格式化字节大小为大白话字符串 (如 "380 MB", "1.8 GB")
 */
function formatMemoryBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`
  }
  return `${Math.round(mb)} MB`
}

/**
 * 获取模块大白话中文展示名
 */
function getModuleDisplayName(m: { id: string; i18nNameKey?: string }): string {
  if (m.i18nNameKey) {
    switch (m.i18nNameKey) {
      case '轻量CPU引擎':
        return t('轻量CPU引擎')
      case '本地大模型引擎':
      case '萤核AI引擎':
        return t('萤核AI引擎')
      case '语音识别与字幕提取':
        return t('语音识别与字幕提取')
      case '语音合成与朗读':
      case '极速语音朗读':
        return t('极速语音朗读')
      case '个性化声音克隆':
        return t('个性化声音克隆')
      default:
        return m.i18nNameKey
    }
  }
  switch (m.id) {
    case 'pocket-cpu-int8-onnx':
      return t('轻量CPU引擎')
    case 'firefly-ai-engine':
      return t('萤核AI引擎')
    case 'asr-sensevoice-onnx':
      return t('语音识别与字幕提取')
    case 'tts-m5-onnx':
      return t('极速语音朗读')
    case 'tts-moss-onnx':
      return t('个性化声音克隆')
    default:
      return m.id
  }
}

/**
 * 获取模块的内存占用字节数（优先实测与释放快照，兜底按规格元数据估算）
 */
function getModuleMemoryBytes(m: {
  id: string
  residentBytes?: number
  residentSample?: { bytes: number }
  lastReleased?: { bytes: number }
  lastReleasedBytes?: number
  estimatedMemoryBytes?: number
}): number {
  if (m.residentSample && m.residentSample.bytes > 0) return m.residentSample.bytes
  if (m.residentBytes && m.residentBytes > 0) return m.residentBytes
  if (m.lastReleased && m.lastReleased.bytes > 0) return m.lastReleased.bytes
  if (m.lastReleasedBytes && m.lastReleasedBytes > 0) return m.lastReleasedBytes
  if (m.estimatedMemoryBytes && m.estimatedMemoryBytes > 0) return m.estimatedMemoryBytes

  switch (m.id) {
    case 'firefly-ai-engine':
      return 1800 * 1024 * 1024
    case 'tts-m5-onnx':
      return 315 * 1024 * 1024
    case 'asr-sensevoice-onnx':
      return 250 * 1024 * 1024
    case 'tts-moss-onnx':
      return 450 * 1024 * 1024
    case 'pocket-cpu-int8-onnx':
      return 380 * 1024 * 1024
    default:
      return 0
  }
}

/**
 * 判断模块是否处于 draft 状态（draft 状态模块不显示在能耗透视弹层中）
 */
function isModuleDraft(m: { id: string; availability?: string }): boolean {
  if (m.availability === 'draft') return true
  if (m.id === 'pocket-cpu-int8-onnx') return true
  return false
}

export const EnergyTransparencyBadge: React.FC<{ className?: string }> = ({ className }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [retryingTarget, setRetryingTarget] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ bottom: number; right: number; maxHeight: number }>({
    bottom: 48,
    right: 16,
    maxHeight: 480
  })

  const { snapshot, isReclaiming, reclaimAll, retryModule, subscribe } = useHibernationStore()

  // 挂载时订阅主进程广播
  useEffect(() => {
    const unsubscribe = subscribe()
    return () => {
      unsubscribe()
    }
  }, [subscribe])

  // 计算浮层坐标（始终悬浮在 Footer 触发按钮正上方，严防溢出屏幕与遮挡）
  const updateCoords = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setCoords({
        bottom: Math.max(16, window.innerHeight - rect.top + 8),
        right: Math.max(16, window.innerWidth - rect.right),
        maxHeight: Math.max(200, Math.min(540, rect.top - 24))
      })
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      updateCoords()
    }
  }, [isOpen, updateCoords])

  // 点击外部自动收起卡片，并在视口尺寸或滚动变化时实时重算坐标
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        buttonRef.current &&
        !buttonRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setIsOpen(false)
      }
    }
    const handleResizeOrScroll = () => {
      updateCoords()
    }

    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('resize', handleResizeOrScroll)
    window.addEventListener('scroll', handleResizeOrScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('resize', handleResizeOrScroll)
      window.removeEventListener('scroll', handleResizeOrScroll, true)
    }
  }, [isOpen, updateCoords])

  // 纯函数派生仪表盘数据
  const gauges = useMemo(() => selectHibernationGauges(snapshot), [snapshot])

  // 过滤掉 draft 状态的模块（如处于草稿态的轻量CPU引擎，严禁在弹层中显示）
  const visibleModules = useMemo(
    () => (snapshot?.modules ?? []).filter(m => !isModuleDraft(m)),
    [snapshot?.modules]
  )

  const residentModules = useMemo(
    () =>
      visibleModules.filter(
        m => m.state === 'resident' || m.state === 'loading' || m.state === 'draining'
      ),
    [visibleModules]
  )
  const hibernatedModules = useMemo(
    () => visibleModules.filter(m => m.state === 'hibernated'),
    [visibleModules]
  )
  const errorModules = useMemo(
    () => visibleModules.filter(m => m.state === 'error'),
    [visibleModules]
  )

  const hibernatedCount = hibernatedModules.length
  // 汇总可见模块的实测/释放/估算内存占用
  const totalResidentBytes = useMemo(
    () => residentModules.reduce((sum, m) => sum + getModuleMemoryBytes(m), 0),
    [residentModules]
  )
  const totalSavedBytes = useMemo(
    () => hibernatedModules.reduce((sum, m) => sum + getModuleMemoryBytes(m), 0),
    [hibernatedModules]
  )

  // 一键释放全量空闲内存
  const handleReclaimAll = async () => {
    try {
      const res = await reclaimAll()
      if (res.success && res.releasedBytes > 0) {
        toast.success(t('已释放约 {size} 内存', { size: formatMemoryBytes(res.releasedBytes) }))
      } else {
        toast.info(t('所有可休眠模块均已处于节能状态'))
      }
    } catch {
      toast.error(t('释放模块内存失败'))
    }
  }

  // 重试异常模块
  const handleRetry = async (targetId: string) => {
    setRetryingTarget(targetId)
    try {
      const success = await retryModule(targetId)
      if (success) {
        toast.success(t('重试成功'))
      } else {
        toast.error(t('重试失败'))
      }
    } catch {
      toast.error(t('重试失败'))
    } finally {
      setRetryingTarget(null)
    }
  }

  return (
    <div className={cn('relative inline-flex items-center', className)} ref={containerRef}>
      {/* 底部 Footer 节能胶囊按钮 */}
      <button
        ref={buttonRef}
        type="button"
        data-testid="energy-badge-trigger"
        onClick={() => {
          updateCoords()
          setIsOpen(prev => !prev)
        }}
        className={cn(
          'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-all duration-200 cursor-pointer select-none',
          gauges.isEnergySaving
            ? 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 shadow-sm'
            : 'bg-muted/40 hover:bg-muted/70 text-muted-foreground border border-border/40'
        )}
        title={
          gauges.isEnergySaving
            ? t('点击查看系统能耗管理看板（已休眠 {count} 个模块）', { count: hibernatedCount })
            : t('点击查看系统能耗管理看板（运行中）')
        }
      >
        {gauges.isEnergySaving ? (
          <Leaf className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        ) : (
          <Zap className="w-3.5 h-3.5 opacity-70 shrink-0" />
        )}

        {/* 宽屏展示文字（>= 1200px 对应 xl），窄屏自动收敛为仅图标 */}
        <span className="hidden xl:inline tracking-tight">
          {gauges.isEnergySaving
            ? t('🌿 节能中 · {count}个模块已休眠', { count: hibernatedCount })
            : t('⚡ 运行中')}
        </span>
      </button>

      {/* Hover / Click 浮动透视看板：通过 createPortal 挂载到 body，彻底消除父容器 overflow-hidden 截断与层叠上下文遮挡 */}
      {isOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              bottom: `${coords.bottom}px`,
              right: `${coords.right}px`,
              maxHeight: `${coords.maxHeight}px`,
              zIndex: 9999
            }}
            className="w-84 sm:w-96 rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md text-popover-foreground shadow-2xl p-4 overflow-y-auto animate-in fade-in zoom-in-95 duration-150 select-none"
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/40">
              <div className="flex items-center gap-1.5">
                <Leaf className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <h4 className="text-sm font-semibold text-foreground">{t('系统内存与能耗管理')}</h4>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 电脑当前剩余可用内存透视 */}
            <div className="mb-3 px-2.5 py-1.5 rounded-lg bg-muted/40 text-xs text-muted-foreground flex items-center justify-between">
              <span>
                {t('电脑当前剩余内存: {mem}', {
                  mem: formatMemoryBytes(snapshot?.availableMemoryBytes)
                })}
              </span>
              {hibernatedModules.length > 0 && (
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                  {t('(已触发智能休眠保护)')}
                </span>
              )}
            </div>

            {/* 模块列表分区 */}
            <div className="space-y-3 max-h-64 overflow-y-auto pr-1 text-xs">
              {/* 🟢 正在内存运行 */}
              {residentModules.length > 0 && (
                <div>
                  <div className="font-medium text-foreground flex items-center justify-between mb-1">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                      <span>{t('正在内存运行')}</span>
                    </span>
                    <span className="text-muted-foreground/80 font-normal">
                      {t('合计占用: 约 {size}', { size: formatMemoryBytes(totalResidentBytes) })}
                    </span>
                  </div>
                  <ul className="space-y-1 pl-3 text-muted-foreground">
                    {residentModules.map(m => {
                      const kindLabel =
                        (m.effectiveMemoryKind ?? m.defaultMemoryKind) === 'vram'
                          ? t('显存')
                          : t('内存')
                      const bytes = getModuleMemoryBytes(m)
                      return (
                        <li key={m.id} className="flex items-center justify-between py-0.5">
                          <span>• {getModuleDisplayName(m)}</span>
                          <span className="opacity-75 flex items-center gap-1.5">
                            <span>
                              {t('约 {size} {kind}', {
                                size: formatMemoryBytes(bytes),
                                kind: kindLabel
                              })}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-blue-500/10 text-blue-600 dark:text-sky-400 font-medium border border-blue-500/20">
                              {t('运行中')}
                            </span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* 💤 已休眠节能 */}
              {hibernatedModules.length > 0 && (
                <div>
                  <div className="font-medium text-foreground flex items-center justify-between mb-1">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <span>💤</span>
                      <span>{t('已休眠节能')}</span>
                    </span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                      {t('合计释放: 约 {size}', { size: formatMemoryBytes(totalSavedBytes) })}
                    </span>
                  </div>
                  <ul className="space-y-1 pl-3 text-muted-foreground">
                    {hibernatedModules.map(m => {
                      const kindLabel =
                        (m.effectiveMemoryKind ?? m.defaultMemoryKind) === 'vram'
                          ? t('显存')
                          : t('内存')
                      const bytes = getModuleMemoryBytes(m)
                      return (
                        <li key={m.id} className="flex items-center justify-between py-0.5">
                          <span>• {getModuleDisplayName(m)}</span>
                          <span className="text-emerald-600/90 dark:text-emerald-400/90 font-medium flex items-center gap-1.5">
                            <span>
                              {t('约 {size} {kind}', {
                                size: formatMemoryBytes(bytes),
                                kind: kindLabel
                              })}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                              {t('已释放')}
                            </span>
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              {/* ⚠️ 运行异常 */}
              {errorModules.length > 0 && (
                <div className="pt-1 border-t border-border/30">
                  <div className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1 mb-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>{t('运行异常 (点击可重试)')}</span>
                  </div>
                  <ul className="space-y-1.5 pl-3">
                    {errorModules.map(m => (
                      <li key={m.id} className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground truncate">
                          • {getModuleDisplayName(m)}
                        </span>
                        <button
                          type="button"
                          disabled={retryingTarget === m.id}
                          onClick={() => handleRetry(m.id)}
                          className="px-2 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 font-medium text-xs transition-colors shrink-0 flex items-center gap-1"
                        >
                          {retryingTarget === m.id && <Loader2 className="w-3 h-3 animate-spin" />}
                          <span>{t('重试')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* 未决异常提示 */}
            {gauges.hasUncertainMemoryModules && (
              <div className="mt-2.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0" />
                <span>{t('部分内存占用正在确认中')}</span>
              </div>
            )}

            {/* 底部大白话提示 */}
            <div className="mt-3 pt-2.5 border-t border-border/40 text-[11px] text-muted-foreground/70 leading-relaxed flex items-start gap-1">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{t('闲置时自动休眠，首次使用短暂加载，后续无需等待。')}</span>
            </div>

            {/* 一键释放单按钮 */}
            <div className="mt-3">
              <button
                type="button"
                disabled={isReclaiming}
                onClick={handleReclaimAll}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs transition-colors shadow-sm disabled:opacity-50 cursor-pointer"
              >
                {isReclaiming ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>{t('正在释放...')}</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{t('一键释放可休眠内存')}</span>
                  </>
                )}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
