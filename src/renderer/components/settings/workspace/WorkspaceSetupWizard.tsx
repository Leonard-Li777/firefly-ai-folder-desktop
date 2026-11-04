import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigIntent,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  HardwareInfo,
  UserTier
} from '@firefly/types'
import { mapIntentToParameters } from '@firefly/shared'
import { useTierStore } from '../../../stores/tier-store'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { MaterialIcon, cn } from '../../../lib/utils'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  Sparkles,
  Check,
  Loader2,
  ArrowRight,
  Play
} from 'lucide-react'
import { getIntentCards } from '../WorkspaceConfigPanel'

export interface WorkspaceSetupWizardProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  /**
   * 完成向导后的流转回调
   * @param mode 'complete' 自动完成并关闭弹窗；'customize' 切入高级 3-Tab 自定义
   */
  onFinish: (mode: 'complete' | 'customize', readyConfig: WorkspaceConfig) => void
}

/**
 * 极简工作目录配置向导 (TASK-08)
 *
 * 核心设计：
 * 1. 彻底移除了折叠的高级技术微调，纯粹聚焦于场景意图选择；
 * 2. 毫秒级目录画像嗅探：自动检测视频/图片/文档比例并提供高置信度推荐；
 * 3. 双通道流转出口：
 *    - 主出口「完成并开始分析」：快速写入 ready，自动关闭弹窗并提示队列已就绪；
 *    - 高级出口「深度自定义设置 ➔」：写入 ready，原地无缝切入高级 3 Tab 视图。
 */
export const WorkspaceSetupWizard: React.FC<WorkspaceSetupWizardProps> = ({
  workspace,
  hardwareInfo,
  onFinish
}) => {
  const [profileResult, setProfileResult] = useState<any | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const hasUserInteractedRef = useRef(false)

  // 动态意图卡片列表 (遵循 AGENTS.md §2.6 动态 i18n 避坑)
  const intentCards = useMemo(() => getIntentCards(), [])

  // 会员权益中性提示
  const tier = useTierStore(s => s.tier)
  const isFreeTier = (tier ?? UserTier.FREE) === UserTier.FREE

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const initialIntent: WorkspaceConfigIntent = useMemo(() => {
    if (parsedConfig.status === 'ready') {
      return parsedConfig.intent
    }
    return parsedConfig.detectedIntent || 'fast_archive'
  }, [parsedConfig])

  const [selectedIntent, setSelectedIntent] = useState<WorkspaceConfigIntent>(initialIntent)

  // 异步探测目录画像
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      if (!window.electronAPI?.utils?.probeDirectoryProfile || !workspace.path) return
      setIsProbing(true)
      try {
        const result = await window.electronAPI.utils.probeDirectoryProfile(workspace.path)
        if (!cancelled && result) {
          setProfileResult(result)
          // 若处于 pending 状态且用户尚未手动交互选中，自动采纳 Profiler 推荐的高置信度意图
          if (
            parsedConfig.status === 'pending' &&
            result.confidence > 0 &&
            !hasUserInteractedRef.current
          ) {
            setSelectedIntent(result.detectedIntent)
          }
        }
      } catch (err) {
        console.warn('[WorkspaceSetupWizard] 嗅探目录画像失败:', err)
      } finally {
        if (!cancelled) setIsProbing(false)
      }
    }

    probe()
    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.path, parsedConfig.status])

  // 推荐状态判断
  const isRecommended = useCallback(
    (intentId: WorkspaceConfigIntent) => {
      return profileResult && profileResult.detectedIntent === intentId && profileResult.confidence > 0
    },
    [profileResult]
  )

  // 统一提交就绪配置
  const submitConfig = async (flowMode: 'complete' | 'customize') => {
    if (!workspace.id) {
      toast.error(t('工作区 ID 无效'))
      return
    }
    setIsSaving(true)
    try {
      let actualHw = hardwareInfo
      if (!actualHw && window.electronAPI?.getHardwareInfo) {
        try {
          actualHw = await window.electronAPI.getHardwareInfo()
        } catch {
          // fallback
        }
      }

      // 生成派生参数快照
      const derivedSnapshot = mapIntentToParameters(selectedIntent, actualHw)

      // 保留原有自定义忽略规则（如果存在）
      const existingCustomIgnoreRules =
        parsedConfig.status === 'ready' ? parsedConfig.customIgnoreRules : undefined

      const readyConfig: WorkspaceConfig = {
        schemaVersion: 1,
        status: 'ready',
        intent: selectedIntent,
        policyVersion: 1,
        derivedSnapshot,
        overrides: parsedConfig.status === 'ready' ? parsedConfig.overrides : undefined,
        customIgnoreRules: existingCustomIgnoreRules,
        configuredAt: Date.now()
      }

      if (window.electronAPI?.updateWorkspaceConfig) {
        const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, readyConfig)
        if (res.success) {
          if (flowMode === 'complete') {
            toast.success(t('工作区已配置完成，AI 智能分析已启动！'))
          }
          onFinish(flowMode, readyConfig)
        } else {
          toast.error(res.error || t('保存配置失败'))
        }
      } else {
        onFinish(flowMode, readyConfig)
      }
    } catch (error: any) {
      toast.error(error?.message || t('保存配置异常'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden p-6 space-y-6">
      {/* 头部引导与画像嗅探摘要 */}
      <div className="space-y-3 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-xl font-bold flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <span>{t('配置工作目录分析策略')}</span>
            </h3>
          </div>

          {/* 嗅探状态与采样信息 */}
          <div className="flex items-center gap-2 text-xs">
            {isProbing ? (
              <div className="flex items-center gap-1.5 text-muted-foreground bg-muted/60 px-3 py-1 rounded-full border border-border/50">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                <span>{t('智能嗅探目录内容中...')}</span>
              </div>
            ) : profileResult?.stats ? (
              <div className="flex items-center gap-1.5 text-muted-foreground bg-muted/40 px-3 py-1 rounded-full border border-border/50">
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <span>
                  {t('已采样 {count} 个文件', { count: profileResult.stats.totalSampled })}
                </span>
                {profileResult.stats.topExtensions?.length > 0 && (
                  <span className="text-primary font-medium">
                    ({profileResult.stats.topExtensions.slice(0, 3).map((e: any) => `${e.ext} ${e.count}`).join(', ')})
                  </span>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* 四大场景意图卡片网格 */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold text-foreground">
            {t('为「{name}」选择最贴合的文件整理场景，系统将自动自适应算力与分析深度。', {
                name: workspace.name
              })}
          </Label>
          {profileResult && profileResult.confidence > 0 && (
            <span className="text-xs text-primary font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              {t('系统根据目录文件推荐: {name} (匹配度 {pct}%)', {
                name: intentCards.find(c => c.id === profileResult.detectedIntent)?.title || '',
                pct: Math.round(profileResult.confidence * 100)
              })}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {intentCards.map(card => {
            const isSelected = selectedIntent === card.id
            const recommended = isRecommended(card.id)

            return (
              <div
                key={card.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  hasUserInteractedRef.current = true
                  setSelectedIntent(card.id)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    hasUserInteractedRef.current = true
                    setSelectedIntent(card.id)
                  }
                }}
                className={cn(
                  'relative flex flex-col p-4 rounded-xl border text-left cursor-pointer transition-all duration-200 select-none group',
                  isSelected
                    ? 'bg-primary/5 dark:bg-primary/10 border-primary shadow-md shadow-primary/10 ring-1.5 ring-primary'
                    : 'bg-card hover:bg-muted/40 border-border/80 hover:border-border'
                )}
              >
                {/* 推荐角标 */}
                {recommended && (
                  <div className="absolute top-3 right-3 flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    <Sparkles className="w-3 h-3" />
                    <span>{t('推荐')}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 mb-2">
                  <div
                    className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
                      isSelected
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'bg-muted text-muted-foreground group-hover:text-foreground'
                    )}
                  >
                    <MaterialIcon icon={card.icon} className="text-lg" />
                  </div>
                  <div>
                    <h5 className="font-bold text-sm leading-snug">{card.title}</h5>
                    <p className="text-[11px] text-muted-foreground leading-tight">{card.subtitle}</p>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed mt-1 flex-1">
                  {card.description}
                </p>

                <div className="flex items-center justify-between mt-3.5 pt-2.5 border-t border-border/50 text-xs">
                  <span className="font-medium text-muted-foreground">{card.badge}</span>
                  {isSelected && (
                    <span className="text-primary font-bold flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" />
                      {t('已选用')}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* 影视剪辑素材场景 Free/Pro 权益中性告知 */}
        {isFreeTier && selectedIntent === 'footage_studio' && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-primary/5 border border-primary/20 text-xs text-muted-foreground mt-2">
            <Sparkles className="w-4 h-4 text-primary shrink-0" />
            <span>{t('当前体验首个 5 分钟切片分析，升级 Pro 可流式续作自动处理全片')}</span>
          </div>
        )}
      </div>

      {/* 底部双通道流转操作栏 */}
      <div className="pt-4 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
        <div className="text-xs text-muted-foreground">
          {t('选定后可随时在「工作目录设置」中重新运行向导或精细微调参数')}
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          {/* 高级出口：深度自定义 */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={() => submitConfig('customize')}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <span>{t('深度自定义设置')}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Button>

          {/* 主出口：完成并开始分析 */}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={isSaving}
            onClick={() => submitConfig('complete')}
            className="flex items-center gap-1.5 text-xs font-semibold px-4 shadow-sm"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
            <span>{t('完成并开始分析')}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
