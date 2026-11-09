import React, { useEffect, useState, useRef } from 'react'
import {
  Sparkles,
  RefreshCw,
  FolderOpen,
  ArrowRight,
  ShieldCheck,
  Sliders,
  Search,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Label } from '../ui/label'
import { SettingsCategory } from '@firefly/types/settings-types'
import { useSettingsStore } from '../../stores/settings-store'
import { t } from '@app/languages'
import { toast } from '../common/Toast'

/**
 * 基础AI引擎与全局检索配置组件
 *
 * 架构说明 (TASK-06 彻底瘦身版)：
 * 1. 原全局性的「分析模式」、「视频分析参数」、「MRL 向量维度」等底层参数，已全面下沉并升级为各工作区专属的自适应策略体系 (workspace_config)；
 * 2. 本页面保留全局基础设施级能力：视觉语义检索开关 (CLIP Text Search) 与语义索引重建维护 (Canonical Maintenance)；
 * 3. 提供醒目的重定向指引卡片，引导用户前往「工作区」标签页针对具体目录进行意图模式与技术微调。
 */
export const BasicAIEngineConfigSettings: React.FC = () => {
  const config = useSettingsStore(s => s.config)
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const openSettings = useSettingsStore(s => s.openSettings)

  // 1. 全局视觉语义搜索开关
  const clipTextEnabled = getConfigValue<boolean>('AI_CLIP_TEXT_SEARCH_ENABLED') ?? true

  // 2. 语义索引重建状态
  const [rebuildCounts, setRebuildCounts] = useState<{
    pending: number
    ready: number
    visualOnly: number
    skipped: number
    failed: number
    uncomputed: number
    lastMaintenance: { reason: string; at: number; invalidated: number; requeued: number } | null
  } | null>(null)
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const [isRebuilding, setIsRebuilding] = useState(false)
  const rebuildLoadedRef = useRef(false)

  useEffect(() => {
    if (rebuildLoadedRef.current) return
    rebuildLoadedRef.current = true
    let cancelled = false

    window.electronAPI
      ?.getCanonicalRebuildCounts?.()
      .then(counts => {
        if (cancelled) return
        if (counts) {
          setRebuildCounts(counts)
          setRebuildError(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRebuildError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [])

  const handleRunRebuild = async () => {
    setIsRebuilding(true)
    try {
      await window.electronAPI?.runCanonicalMaintenance?.('settings_manual')
      const counts = await window.electronAPI?.getCanonicalRebuildCounts?.()
      if (counts) {
        setRebuildCounts(counts)
        setRebuildError(null)
      }
      toast.success(t('语义索引维护已完成'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRebuildError(msg)
      toast.error(t('语义索引维护异常: {msg}', { msg }))
    } finally {
      setIsRebuilding(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      {/* 头部标题区 */}
      <div>
        <h3 className="text-lg font-semibold mb-1 text-foreground">
          {t('检索式引擎与全局检索')}
        </h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('管理全局视觉语义检索、多模态索引维护，或前往各工作区配置专属场景策略。')}
        </p>
      </div>

      {/* 1. 重定向指引卡片：工作区意图策略体系 */}
      <Card className="p-5 border-primary/30 bg-primary/5 dark:bg-primary/10 shadow-xs relative overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-sm mt-0.5">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="font-bold text-sm text-foreground">
                  {t('分析策略已升级为「工作区专属配置」')}
                </h4>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary/20 text-primary">
                  {t('自适应架构')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t(
                  '分析模式、视频抽帧预算、OCR 精度与向量维度等底层参数已全面融入工作区体系。系统可根据目录文件构成自动推荐「极速整理」、「创意图库」、「影视素材」或「桌面下载」，各目录独立封闭、互不干扰。'
                )}
              </p>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            onClick={() => openSettings(SettingsCategory.WORKSPACE_CONFIG)}
            className="shrink-0 flex items-center gap-1.5 shadow-sm"
          >
            <span>{t('配置各工作区')}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </Card>

      {/* 2. 全局视觉语义搜索与多模态索引维护 */}
      <Card className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-primary shrink-0" />
              <Label className="text-sm font-semibold text-foreground">
                {t('视觉语义搜索 (CLIP)')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t(
                '允许使用自然语言描述画面（如「红色的跑车」、「海边的日落」）跨工作区检索图像内容。'
              )}
            </p>
          </div>
          <Switch
            checked={clipTextEnabled}
            onCheckedChange={checked => {
              void updateConfigValue('AI_CLIP_TEXT_SEARCH_ENABLED', checked)
            }}
            aria-label={t('视觉语义搜索')}
          />
        </div>

        <div className="pt-4 border-t border-border/60">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                <Label className="text-xs font-semibold text-foreground">
                  {t('全局语义索引状态')}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">
                {rebuildError
                  ? t('索引状态读取失败，可点击右侧按钮重新维护。')
                  : rebuildCounts
                    ? t('待自愈 {pending} 项 · 已就绪 {ready} 项 · 异常 {failed} 项', {
                        pending: rebuildCounts.pending + rebuildCounts.uncomputed,
                        ready: rebuildCounts.ready,
                        failed: rebuildCounts.failed
                      })
                    : t('正在读取索引状态…')}
              </p>
              {!rebuildError && rebuildCounts && rebuildCounts.lastMaintenance && (
                <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                  {t('最近一次自愈：{reason}（失效 {invalidated} 项，重新入队 {requeued} 项）', {
                    reason: rebuildCounts.lastMaintenance.reason,
                    invalidated: rebuildCounts.lastMaintenance.invalidated,
                    requeued: rebuildCounts.lastMaintenance.requeued
                  })}
                </p>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={isRebuilding}
              onClick={handleRunRebuild}
              className="shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRebuilding ? 'animate-spin' : ''}`} />
              {isRebuilding ? t('维护中…') : t('重建语义索引')}
            </Button>
          </div>
        </div>
      </Card>

      {/* 3. 高级 AI 引擎服务连接指引 */}
      <Card className="p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-muted text-muted-foreground flex items-center justify-center shrink-0">
              <Sliders className="w-5 h-5" />
            </div>
            <div className="space-y-0.5 min-w-0">
              <h5 className="font-semibold text-xs text-foreground">
                {t('高级 AI 引擎与云端连接')}
              </h5>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {t('配置本地大语言模型服务、云端 LLM 密钥与「思考模式」深度推理参数。')}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openSettings(SettingsCategory.AI_ENGINE_CONFIG)}
            className="shrink-0 text-xs"
          >
            <span>{t('配置高级引擎')}</span>
            <ArrowRight className="w-3 h-3 ml-1" />
          </Button>
        </div>
      </Card>
    </div>
  )
}
