import {
  Check,
  Cpu,
  Gauge,
  HelpCircle,
  Layers,
  Lock,
  Sparkles
} from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel
} from '../ui/alert-dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SettingsCategory } from '@firefly/types/settings-types'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../common/Toast'

/**
 * 辅助悬浮气泡组件
 */
const HelpTooltip: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState(false)
  const { t } = useVoerkaI18n(i18nScope)
  return (
    <span
      className="relative inline-flex items-center ml-1 cursor-pointer text-muted-foreground hover:text-foreground"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <HelpCircle className="h-3.5 w-3.5" />
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 text-xs bg-popover text-popover-foreground border rounded-lg shadow-md z-50 pointer-events-none whitespace-normal normal-case leading-normal font-normal">
          {t(content)}
        </span>
      )}
    </span>
  )
}

/**
 * 基础AI引擎配置组件
 */
export const BasicAIEngineConfigSettings: React.FC = () => {
  const config = useSettingsStore(s => s.config)
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const openSettings = useSettingsStore(s => s.openSettings)
  const { t } = useVoerkaI18n(i18nScope)

  // 高级AI引擎（萤核/云端）是否已开启；disabled = 仅基础AI引擎
  const isAdvancedAiEnabled = (config?.aiServiceMode ?? 'local') !== 'disabled'
  // 高级AI引擎关闭时，增强/全面不可选，展示与生效模式统一回落为标准分析
  const analysisMode = isAdvancedAiEnabled
    ? (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name')
    : 'simple'

  // 多模态嵌入画像档位（二元档位契约）：classic_light (384d) vs gemma_unified (512d)
  const embeddingProfile =
    getConfigValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ?? 'classic_light'
  const [pendingProfile, setPendingProfile] = useState<'classic_light' | 'gemma_unified' | null>(null)
  const [pendingDimension, setPendingDimension] = useState<256 | 512 | 768 | null>(null)

  // MRL 多维度弹性降维 (256 | 512 | 768)
  const mrlDimension =
    getConfigValue<256 | 512 | 768>('EMBEDDING_MRL_DIMENSION') ?? 512

  // 视频切片抽帧间隔（秒）
  const [localVideoInterval, setLocalVideoInterval] = useState<number>(
    getConfigValue<number>('VIDEO_FRAME_INTERVAL_SECONDS') ?? 5.0
  )

  // 硬件自适应推荐状态
  const [recommendedSettings, setRecommendedSettings] = useState<{
    profile: 'classic_light' | 'gemma_unified'
    mrlDimension: 256 | 512 | 768
    videoFrameIntervalSeconds: number
  } | null>(null)
  const recommendationCheckedRef = React.useRef(false)

  useEffect(() => {
    if (recommendationCheckedRef.current) return
    recommendationCheckedRef.current = true

    window.electronAPI?.getRecommendedEmbeddingSettings?.()
      .then((rec: any) => {
        if (rec) {
          setRecommendedSettings(rec)
          // 若当前尚未配置过 AI_EMBEDDING_PROFILE 且硬件推荐为 gemma_unified，自动对齐
          const currentProfile = getConfigValue<string>('AI_EMBEDDING_PROFILE')
          if (!currentProfile && rec.profile === 'gemma_unified') {
            updateConfigValue('AI_EMBEDDING_PROFILE', 'gemma_unified')
            if (rec.mrlDimension) {
              updateConfigValue('EMBEDDING_MRL_DIMENSION', rec.mrlDimension)
            }
            if (rec.videoFrameIntervalSeconds) {
              updateConfigValue('VIDEO_FRAME_INTERVAL_SECONDS', rec.videoFrameIntervalSeconds)
              setLocalVideoInterval(rec.videoFrameIntervalSeconds)
            }
          }
        }
      })
      .catch(() => {})
  }, [])

  const handleConfirmProfileSwitch = async () => {
    if (!pendingProfile) return
    const target = pendingProfile
    setPendingProfile(null)
    await updateConfigValue('AI_EMBEDDING_PROFILE', target)
    if (target === 'gemma_unified' && recommendedSettings?.mrlDimension) {
      await updateConfigValue('EMBEDDING_MRL_DIMENSION', recommendedSettings.mrlDimension)
    }
    captureEvent('切换嵌入模型档位', { profile: target })
    toast.success(
      t('已切换搜索与理解模式并重启，新导入的文件将使用新模式分析')
    )
  }

  const handleConfirmDimensionSwitch = async () => {
    if (!pendingDimension) return
    const target = pendingDimension
    setPendingDimension(null)
    await updateConfigValue('EMBEDDING_MRL_DIMENSION', target)
    captureEvent('切换特征分析精度', { dimension: target })
    toast.success(
      t('已将特征分析精度切换为 {dim} 维，已分析的文件重新分析后生效', { dim: target })
    )
  }

  const handleApplyHardwareRecommendations = async () => {
    if (!recommendedSettings) return
    if (embeddingProfile !== recommendedSettings.profile) {
      setPendingProfile(recommendedSettings.profile)
      return
    }
    await updateConfigValue('EMBEDDING_MRL_DIMENSION', recommendedSettings.mrlDimension)
    await updateConfigValue('VIDEO_FRAME_INTERVAL_SECONDS', recommendedSettings.videoFrameIntervalSeconds)
    setLocalVideoInterval(recommendedSettings.videoFrameIntervalSeconds)
    toast.success(
      t('已同步硬件推荐配置（{profile} · {dim}维 · {interval}秒抽帧）', {
        profile: recommendedSettings.profile === 'gemma_unified' ? t('全模态标准档') : t('极速轻量档'),
        dim: recommendedSettings.mrlDimension,
        interval: recommendedSettings.videoFrameIntervalSeconds
      })
    )
  }

  // 视频切片抽帧间隔防抖同步
  useEffect(() => {
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('VIDEO_FRAME_INTERVAL_SECONDS') ?? 5.0
      if (localVideoInterval !== currentConfigValue) {
        updateConfigValue('VIDEO_FRAME_INTERVAL_SECONDS', localVideoInterval)
        captureEvent('更新视频切片抽帧间隔', {
          intervalSeconds: localVideoInterval
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localVideoInterval])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('基础AI引擎配置')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('配置分析模式、嵌入模型档位、MRL 向量维度与视频切片抽帧参数')}
        </p>
      </div>

      {/* 选择分析模式 */}
      <Card className="p-5">
        <div className="space-y-4">
          {/* 切换文件分析模式 */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Gauge className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Label className="text-base font-semibold leading-none">{t('选择分析模式')}</Label>
              <HelpTooltip
                content={t(
                  '根据需求选择不同模式，全面分析耗时最长但精度最高；标准分析最快。增强分析与全面分析需开启高级AI引擎。'
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 标准分析（原简单分类） */}
            <div
              onClick={() => {
                updateConfigValue('ANALYSIS_MODE', 'simple')
                captureEvent('切换分析模式', { mode: 'simple' })
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${
                analysisMode === 'simple'
                  ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
              }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('极速')}
              </div>
              {/* 选中勾选标记 */}
              {analysisMode === 'simple' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={`font-semibold text-sm ${analysisMode === 'simple' ? 'text-primary' : ''}`}
                >
                  {t('标准分析')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('基于基础AI引擎高速获取文件标签、智能文件名和摘要')}
              </p>
            </div>

            {/* 增强分析（原快速命名）—— 需开启高级AI引擎 */}
            <div
              onClick={() => {
                if (!isAdvancedAiEnabled) return
                updateConfigValue('ANALYSIS_MODE', 'quick_name')
                captureEvent('切换分析模式', { mode: 'quick_name' })
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 transition-all ${
                !isAdvancedAiEnabled
                  ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                  : analysisMode === 'quick_name'
                    ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20 cursor-pointer'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
              }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('默认')}
              </div>
              {/* 选中勾选标记 */}
              {isAdvancedAiEnabled && analysisMode === 'quick_name' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={`font-semibold text-sm ${
                    isAdvancedAiEnabled && analysisMode === 'quick_name' ? 'text-primary' : ''
                  }`}
                >
                  {t('增强分析')}
                </span>
                {!isAdvancedAiEnabled && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('【标准分析】+ 高级AI引擎修正和补充分析结果')}
              </p>
              {!isAdvancedAiEnabled && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3 shrink-0" />
                  <button
                    type="button"
                    className="underline font-medium hover:text-amber-700"
                    onClick={e => {
                      e.stopPropagation()
                      openSettings(SettingsCategory.AI_ENGINE_CONFIG)
                    }}
                  >
                    {t('需开启高级AI引擎')}
                  </button>
                </div>
              )}
            </div>

            {/* 全面分析 —— 需开启高级AI引擎 */}
            <div
              onClick={() => {
                if (!isAdvancedAiEnabled) return
                updateConfigValue('ANALYSIS_MODE', 'full')
                captureEvent('切换分析模式', { mode: 'full' })
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 transition-all ${
                !isAdvancedAiEnabled
                  ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                  : analysisMode === 'full'
                    ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20 cursor-pointer'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
              }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                {t('推荐')}
              </div>
              {/* 选中勾选标记 */}
              {isAdvancedAiEnabled && analysisMode === 'full' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={`font-semibold text-sm ${
                    isAdvancedAiEnabled && analysisMode === 'full' ? 'text-primary' : ''
                  }`}
                >
                  {t('全面分析')}
                </span>
                {!isAdvancedAiEnabled && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t(
                  '【增强分析】+ 全面AI分析，包含质量评分与详细图片、音频、视频内容描述等'
                )}
              </p>
              {!isAdvancedAiEnabled && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3 shrink-0" />
                  <button
                    type="button"
                    className="underline font-medium hover:text-amber-700"
                    onClick={e => {
                      e.stopPropagation()
                      openSettings(SettingsCategory.AI_ENGINE_CONFIG)
                    }}
                  >
                    {t('需开启高级AI引擎')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* 多模态语义搜索模式 (二元分级架构) */}
      <Card className="p-5">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Layers className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                <Label className="text-base font-semibold leading-none">{t('语义搜索与智能理解模式')}</Label>
                <HelpTooltip
                  content={t(
                    '决定文件与音视频的搜索理解深度。全模态标准档支持深层看懂图片与音视频对话；极速轻量档省电省内存、低发热。'
                  )}
                />
              </div>
            </div>

            {recommendedSettings && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs text-primary border-primary/30 hover:bg-primary/10"
                onClick={handleApplyHardwareRecommendations}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1 text-primary" />
                {t('应用硬件推荐设置')}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* 极速轻量档 */}
            <div
              onClick={() => {
                if (embeddingProfile !== 'classic_light') {
                  setPendingProfile('classic_light')
                }
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${
                embeddingProfile === 'classic_light'
                  ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
              }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('超省电 · 极速分析')}
              </div>
              {embeddingProfile === 'classic_light' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center gap-2 pr-8">
                <span
                  className={`font-semibold text-sm ${
                    embeddingProfile === 'classic_light' ? 'text-primary' : ''
                  }`}
                >
                  {t('极速轻量档')}
                </span>
                {recommendedSettings?.profile === 'classic_light' && (
                  <span className="text-[10px] bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium border border-blue-500/20">
                    {t('硬件推荐')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line">
                {t(
                  '【优势】分析飞快，内存占用极低（< 80MB），省电且机身不发热。\n【代价】仅支持文字与基础图片搜索，无法深度理解视频内容与对话。\n【适合】8GB 内存轻薄本、日常基础办公或电池供电场景。'
                )}
              </p>
            </div>

            {/* 全模态标准档 */}
            <div
              onClick={() => {
                if (embeddingProfile !== 'gemma_unified') {
                  setPendingProfile('gemma_unified')
                }
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${
                embeddingProfile === 'gemma_unified'
                  ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
              }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                {t('深度理解 · 音视频全能')}
              </div>
              {embeddingProfile === 'gemma_unified' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center gap-2 pr-8">
                <span
                  className={`font-semibold text-sm ${
                    embeddingProfile === 'gemma_unified' ? 'text-primary' : ''
                  }`}
                >
                  {t('全模态标准档')}
                </span>
                {recommendedSettings?.profile === 'gemma_unified' && (
                  <span className="text-[10px] bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded font-medium border border-green-500/20">
                    {t('硬件推荐')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed whitespace-pre-line">
                {t(
                  '【优势】看懂复杂画面细节与音视频对话，搜一句话即可秒级定位到视频片段。\n【代价】分析时会占用一定算力与内存（约 300~500MB）。\n【适合】16GB 及以上内存电脑，追求极致搜索与智能整理体验。'
                )}
              </p>
            </div>
          </div>

          {/* 全模态标准档下的进阶配置 */}
          {embeddingProfile === 'gemma_unified' && (
            <div className="mt-5 pt-4 border-t border-border/60 space-y-4">
              {/* MRL 分析精度多档配置 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-sm font-medium text-foreground">
                      {t('特征分析精度')}
                    </Label>
                    <HelpTooltip
                      content={t(
                        '决定为每个文件提取特征的精细程度。精度越高，模糊词和长句搜索越精准；精度越低，索引文件越省磁盘空间。'
                      )}
                    />
                  </div>
                  {recommendedSettings?.mrlDimension && (
                    <span className="text-[11px] text-muted-foreground">
                      {t('硬件推荐：{level}（{dim}维）', {
                        level:
                          recommendedSettings.mrlDimension === 768
                            ? t('精准档')
                            : recommendedSettings.mrlDimension === 512
                              ? t('标准档')
                              : t('紧凑档'),
                        dim: recommendedSettings.mrlDimension
                      })}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                  {/* 紧凑档 256 */}
                  <div
                    onClick={() => {
                      if (mrlDimension !== 256) {
                        setPendingDimension(256)
                      }
                    }}
                    className={`relative p-3 rounded-lg border-2 cursor-pointer transition-all flex flex-col justify-between ${
                      mrlDimension === 256
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-semibold ${mrlDimension === 256 ? 'text-primary' : ''}`}>
                          {t('紧凑省盘档（256维）')}
                        </span>
                        {recommendedSettings?.mrlDimension === 256 && (
                          <span className="text-[10px] bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded font-medium">
                            {t('推荐')}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug whitespace-pre-line">
                        {t('【优势】极省磁盘，每文件仅约 1KB 索引，省 67% 存储空间。\n【代价】对极复杂细微描述的辨识度略有降低（约 95% 准确率）。\n【适合】磁盘空间紧张或 8GB 内存设备。')}
                      </p>
                    </div>
                  </div>

                  {/* 标准档 512 */}
                  <div
                    onClick={() => {
                      if (mrlDimension !== 512) {
                        setPendingDimension(512)
                      }
                    }}
                    className={`relative p-3 rounded-lg border-2 cursor-pointer transition-all flex flex-col justify-between ${
                      mrlDimension === 512
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-semibold ${mrlDimension === 512 ? 'text-primary' : ''}`}>
                          {t('标准平衡档（512维）')}
                        </span>
                        {recommendedSettings?.mrlDimension === 512 && (
                          <span className="text-[10px] bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded font-medium">
                            {t('推荐')}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug whitespace-pre-line">
                        {t('【优势】速度与精度的黄金平衡，保留 98.5% 以上细节辨识能力。\n【代价】每文件约 2KB 索引空间。\n【适合】8GB ~ 16GB 主流电脑首选推荐。')}
                      </p>
                    </div>
                  </div>

                  {/* 精准档 768 */}
                  <div
                    onClick={() => {
                      if (mrlDimension !== 768) {
                        setPendingDimension(768)
                      }
                    }}
                    className={`relative p-3 rounded-lg border-2 cursor-pointer transition-all flex flex-col justify-between ${
                      mrlDimension === 768
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-semibold ${mrlDimension === 768 ? 'text-primary' : ''}`}>
                          {t('旗舰精准档（768维）')}
                        </span>
                        {recommendedSettings?.mrlDimension === 768 && (
                          <span className="text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 px-1.5 py-0.5 rounded font-medium">
                            {t('推荐')}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug whitespace-pre-line">
                        {t('【优势】满血最高精度，对模糊长句和音画视频内容细节匹配最佳。\n【代价】每文件约 3KB 索引空间，分析时需稍多内存。\n【适合】16GB / 32GB 及以上高性能电脑推荐。')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* 视频分析抽帧间隔滑块 */}
              <div className="space-y-2 pt-2 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="video-interval-slider" className="text-sm font-medium text-foreground">
                      {t('视频内容定位精度（抽帧间隔）')}
                    </Label>
                    <HelpTooltip
                      content={t(
                        '分析长视频时每隔几秒截取一次画面。间隔越短，越能精确按秒定位到视频画面片段；间隔越长，视频分析越省电快速。'
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {recommendedSettings?.videoFrameIntervalSeconds && (
                      <button
                        type="button"
                        onClick={() => {
                          setLocalVideoInterval(recommendedSettings.videoFrameIntervalSeconds)
                        }}
                        className="text-[11px] text-primary hover:underline transition-colors"
                      >
                        {t('恢复硬件推荐（{sec}秒）', { sec: recommendedSettings.videoFrameIntervalSeconds })}
                      </button>
                    )}
                    <span className="text-xs font-mono font-medium text-foreground bg-muted px-2 py-0.5 rounded">
                      {localVideoInterval.toFixed(1)} {t('秒')}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    id="video-interval-slider"
                    type="range"
                    min={1}
                    max={30}
                    step={1}
                    value={localVideoInterval}
                    onChange={e => setLocalVideoInterval(parseFloat(e.target.value))}
                    className="w-full accent-primary cursor-pointer"
                  />
                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      value={localVideoInterval}
                      onChange={e => {
                        const val = parseFloat(e.target.value)
                        if (!isNaN(val)) {
                          setLocalVideoInterval(Math.max(1, Math.min(30, val)))
                        }
                      }}
                      className="h-8 text-xs text-right"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-line">
                  {t(
                    '【较短间隔（如 2.0 秒）】能精确定位视频中每一处画面细节，但长视频分析时间较长；\n【较长间隔（如 15.0 秒）】快速提取视频大意，极速省电，适合轻薄本。'
                  )}
                </p>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* 模式切换确认弹窗 */}
      <AlertDialog open={!!pendingProfile} onOpenChange={open => !open && setPendingProfile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认切换智能理解模式？')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                <p>
                  {t(
                    '即将切换为【{profile}】模式。切换后系统将自动重启 AI 引擎。',
                    {
                      profile: pendingProfile === 'gemma_unified' ? t('全模态标准档') : t('极速轻量档')
                    }
                  )}
                </p>
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-md text-amber-600 dark:text-amber-400 text-xs leading-relaxed space-y-1">
                  <p className="font-semibold">{t('⚠️ 注意事项与生效机制：')}</p>
                  <p>{t('1. 新导入的文件：将立即自动采用新模式进行深度特征分析；')}</p>
                  <p>{t('2. 已经分析过的旧文件：历史数据仍安全保留。如需让旧文件享受新模式的搜索特性，需在文件列表中右键选择「重新分析」。')}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmProfileSwitch}>
              {t('立即应用并重启引擎')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 精度切换确认弹窗 */}
      <AlertDialog open={!!pendingDimension} onOpenChange={open => !open && setPendingDimension(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认切换特征分析精度？')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                <p>
                  {t(
                    '即将把特征分析精度调整为【{level}（{dim} 维）】。',
                    {
                      level:
                        pendingDimension === 768
                          ? t('旗舰精准档')
                          : pendingDimension === 512
                            ? t('标准平衡档')
                            : t('紧凑省盘档'),
                      dim: pendingDimension ?? 512
                    }
                  )}
                </p>
                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-md text-blue-600 dark:text-blue-400 text-xs leading-relaxed space-y-1">
                  <p className="font-semibold">{t('⚠️ 生效机制说明：')}</p>
                  <p>{t('1. 新导入的文件：将直接以 {dim} 维精度生成特征索引；', { dim: pendingDimension ?? 512 })}</p>
                  <p>{t('2. 已分析的旧文件：旧特征索引不受破坏，但若要在搜索时享受当前精度的匹配效果，需在文件列表中执行「重新分析」。')}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDimensionSwitch}>
              {t('确认调整精度')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
