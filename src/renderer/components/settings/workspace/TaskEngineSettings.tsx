import React, { useState, useEffect, useMemo } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigReady,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  HardwareInfo,
  UserTier
} from '@firefly/types'
import { mapIntentToParameters } from '@firefly/shared'
import { useTierStore } from '../../../stores/tier-store'
import { Card } from '../../ui/card'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Label } from '../../ui/label'
import { Input } from '../../ui/input'
import { MaterialIcon, cn } from '../../../lib/utils'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  Sliders,
  Sparkles,
  Lock,
  Cpu,
  Layers,
  FileText,
  Film,
  Music,
  CheckCircle2,
  Save,
  RotateCcw,
  Loader2,
  Info
} from 'lucide-react'

export interface TaskEngineSettingsProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  onConfigSaved?: () => void
}

/**
 * 辅助参数说明气泡/文字组件
 */
const ParamHelp: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">{text}</p>
)

/**
 * 工作区专有：AI 分析与多媒体策略面板 (TASK-09)
 *
 * 设计原则：
 * 1. 还原原基础AI引擎与内容萃取的全套详尽参数说明，不再折叠或缩减提示；
 * 2. 读写当前工作区的 workspace_config；
 * 3. 守住 RV-01 向量底座只读铁律：embeddingProfile 与 mrlDimension 作为只读硬件基线卡片呈现，
 *    明确标示由系统级全局锁定，杜绝各目录私自撕裂向量流形空间。
 */
export const TaskEngineSettings: React.FC<TaskEngineSettingsProps> = ({
  workspace,
  hardwareInfo,
  onConfigSaved
}) => {
  const [isSaving, setIsSaving] = useState(false)
  const tier = useTierStore(s => s.tier)
  const isFreeTier = (tier ?? UserTier.FREE) === UserTier.FREE

  // 解析当前配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const isReady = parsedConfig.status === 'ready'
  const currentIntent = isReady ? parsedConfig.intent : 'fast_archive'

  // 基线快照与局部微调覆盖
  const baseDerived = useMemo(() => {
    return isReady
      ? parsedConfig.derivedSnapshot
      : mapIntentToParameters(currentIntent, hardwareInfo)
  }, [isReady, parsedConfig, currentIntent, hardwareInfo])

  const [overrides, setOverrides] = useState<Partial<TechnicalEngineParameters>>(() => {
    if (isReady && parsedConfig.overrides) {
      return { ...parsedConfig.overrides }
    }
    return {}
  })

  // 当外部 workspace 改变时同步更新
  useEffect(() => {
    const fresh = parseWorkspaceConfig(workspace.workspace_config)
    if (fresh.status === 'ready' && fresh.overrides) {
      setOverrides({ ...fresh.overrides })
    } else {
      setOverrides({})
    }
  }, [workspace.id, workspace.workspace_config])

  // 当前有效参数合成 (基线 + overrides)
  const effectiveParams: TechnicalEngineParameters = useMemo(() => {
    return {
      ...baseDerived,
      ...overrides
    }
  }, [baseDerived, overrides])

  // 检查是否有未保存的修改
  const hasChanges = useMemo(() => {
    const savedOverrides = (isReady && parsedConfig.overrides) || {}
    return JSON.stringify(overrides) !== JSON.stringify(savedOverrides)
  }, [isReady, parsedConfig, overrides])

  // 修改单个参数
  const handleParamChange = <K extends keyof TechnicalEngineParameters>(
    key: K,
    val: TechnicalEngineParameters[K]
  ) => {
    setOverrides(prev => {
      const next = { ...prev, [key]: val }
      // 若值与基线一致，可清除该 override 键
      if (val === baseDerived[key]) {
        delete next[key]
      }
      return next
    })
  }

  // 重置为当前意图预设基线
  const handleResetToPreset = () => {
    setOverrides({})
    toast.success(t('已恢复当前场景推荐的基线参数'))
  }

  // 保存微调参数
  const handleSave = async () => {
    if (!workspace.id) return
    setIsSaving(true)
    try {
      const hasAnyOverride = Object.keys(overrides).length > 0
      const updatedConfig: WorkspaceConfig = {
        schemaVersion: 1,
        status: 'ready',
        intent: currentIntent,
        policyVersion: 1,
        derivedSnapshot: baseDerived,
        overrides: hasAnyOverride ? overrides : undefined,
        customIgnoreRules: isReady ? parsedConfig.customIgnoreRules : undefined,
        configuredAt: Date.now()
      }

      if (window.electronAPI?.updateWorkspaceConfig) {
        const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, updatedConfig)
        if (res.success) {
          toast.success(t('AI 分析策略微调已保存'))
          onConfigSaved?.()
        } else {
          toast.error(res.error || t('保存失败'))
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('保存微调策略异常'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部标题与场景概览 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/60">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Sliders className="w-5 h-5 text-primary" />
            <span>{t('AI 分析与多媒体策略')}</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('当前工作目录生效场景: {intent}。在此可针对抽帧、ASR、OCR及长文本提取上限进行精细定制。', {
              intent: currentIntent
            })}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {Object.keys(overrides).length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResetToPreset}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 h-8"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('恢复场景预设')}</span>
            </Button>
          )}

          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={isSaving || !hasChanges}
            onClick={handleSave}
            className="text-xs font-semibold flex items-center gap-1.5 h-8 px-3.5 shadow-sm"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{t('保存微调策略')}</span>
          </Button>
        </div>
      </div>

      {/* 1. 基础分析模式选择 */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span>{t('基础 AI 分析模式')}</span>
          </Label>
          <span className="text-xs text-muted-foreground font-mono">
            {effectiveParams.analysisMode}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {[
            {
              id: 'simple' as const,
              title: t('极速标准 (simple)'),
              desc: t('快速提取客观元数据、标签与核心摘要，消耗最少资源。')
            },
            {
              id: 'quick_name' as const,
              title: t('智能命名 (quick_name)'),
              desc: t('在标准分析基础上优先生成高水准智能文件名与语义卡片。')
            },
            {
              id: 'full' as const,
              title: t('全面深度 (full)'),
              desc: t('全量提取文档正文、音视频台词、分镜打标与多维向量索引。')
            }
          ].map(mode => {
            const isSelected = effectiveParams.analysisMode === mode.id
            return (
              <div
                key={mode.id}
                role="button"
                tabIndex={0}
                onClick={() => handleParamChange('analysisMode', mode.id)}
                className={cn(
                  'p-3 rounded-lg border text-left cursor-pointer transition-all duration-150',
                  isSelected
                    ? 'bg-primary/10 border-primary text-foreground shadow-xs'
                    : 'bg-muted/20 border-border/60 hover:bg-muted/40 text-muted-foreground'
                )}
              >
                <div className="font-semibold text-xs text-foreground mb-1 flex items-center justify-between">
                  <span>{mode.title}</span>
                  {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-primary" />}
                </div>
                <p className="text-[11px] leading-relaxed opacity-90">{mode.desc}</p>
              </div>
            )
          })}
        </div>
      </Card>

      {/* 2. 视频分析精细策略 */}
      <Card className="p-4 space-y-4">
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <Film className="w-4 h-4 text-primary" />
          <h4 className="font-bold text-sm">{t('长视频与镜头切片策略')}</h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* 单视频最大抓图数量 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">{t('单视频抓图配额上限')}</Label>
              <span className="text-xs font-mono font-bold text-primary">
                {effectiveParams.videoQuotaMax} {t('帧')}
              </span>
            </div>
            <Input
              type="range"
              min={8}
              max={120}
              step={4}
              value={effectiveParams.videoQuotaMax}
              onChange={e => handleParamChange('videoQuotaMax', Number(e.target.value))}
              className="accent-primary cursor-pointer h-2"
            />
            <ParamHelp
              text={t(
                '约束单个视频切片抓取的最大代表帧数 (8~120)。抓图越多，复杂分镜检索越精准，但会增加显存消耗。'
              )}
            />
          </div>

          {/* 镜头切换敏锐度 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">{t('镜头切片捕捉敏锐度')}</Label>
              <span className="text-xs font-mono text-muted-foreground">
                {effectiveParams.videoCutSensitivity}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'low' as const, label: t('低敏锐 (长镜头)') },
                { id: 'medium' as const, label: t('适中 (推荐)') },
                { id: 'high' as const, label: t('高敏锐 (MV/快剪)') }
              ].map(opt => (
                <Button
                  key={opt.id}
                  type="button"
                  variant={effectiveParams.videoCutSensitivity === opt.id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleParamChange('videoCutSensitivity', opt.id)}
                  className="text-xs h-8"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
            <ParamHelp text={t('控制画面变动触发镜头切片的门限。快剪视频建议选高敏锐，课堂讲座建议选低敏锐。')} />
          </div>

          {/* 画面识别精细度软预算 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">{t('画面识别软预算')}</Label>
              <span className="text-xs font-mono text-primary font-bold">
                {effectiveParams.videoSoftTokenBudget} Token
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { budget: 48 as const, label: t('48 Token (流畅省电)') },
                { budget: 140 as const, label: t('140 Token (高清细致)') }
              ].map(b => (
                <Button
                  key={b.budget}
                  type="button"
                  variant={effectiveParams.videoSoftTokenBudget === b.budget ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleParamChange('videoSoftTokenBudget', b.budget)}
                  className="text-xs h-8"
                >
                  {b.label}
                </Button>
              ))}
            </div>
            <ParamHelp
              text={t(
                '用于单帧视觉多模态编码的软 Token 预算。140 Token 能捕捉更细微文字与微小物体，48 档速度更快。'
              )}
            />
          </div>

          {/* 视频伴音台词提取上限 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">{t('视频伴音识别上限 (秒)')}</Label>
              <span className="text-xs font-mono font-bold text-primary">
                {effectiveParams.videoAsrDurationSec}s
              </span>
            </div>
            <Input
              type="range"
              min={0}
              max={90}
              step={5}
              value={effectiveParams.videoAsrDurationSec}
              onChange={e => handleParamChange('videoAsrDurationSec', Number(e.target.value))}
              className="accent-primary cursor-pointer h-2"
            />
            <ParamHelp
              text={t(
                '仅提取视频内嵌音轨的前 N 秒语音识别台词标签 (0~90s)。设为 0 表示跳过视频伴音识别。'
              )}
            />
          </div>
        </div>
      </Card>

      {/* 3. 音频与文字萃取策略 */}
      <Card className="p-4 space-y-4">
        <div className="flex items-center gap-2 border-b border-border/50 pb-2">
          <FileText className="w-4 h-4 text-primary" />
          <h4 className="font-bold text-sm">{t('音频转写、OCR 与文本萃取')}</h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* 纯音频转写时长 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5 text-muted-foreground" />
                <span>{t('纯音频文件分析时长')}</span>
              </Label>
              <span className="text-xs font-mono font-bold text-primary">
                {effectiveParams.audioAnalysisDurationSec}s
              </span>
            </div>
            <Input
              type="range"
              min={0}
              max={180}
              step={10}
              value={effectiveParams.audioAnalysisDurationSec}
              onChange={e => handleParamChange('audioAnalysisDurationSec', Number(e.target.value))}
              className="accent-primary cursor-pointer h-2"
            />
            <ParamHelp text={t('对 MP3/FLAC 等纯音频文件前 N 秒进行离线语音转写提取语义标签 (0~180s)。')} />
          </div>

          {/* 文本与文档内容提取上限 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                <span>{t('文档文本提取上限 (KB)')}</span>
              </Label>
              <span className="text-xs font-mono font-bold text-primary">
                {effectiveParams.maxContentSizeKb} KB
              </span>
            </div>
            <Input
              type="number"
              min={10}
              max={5000}
              step={50}
              value={effectiveParams.maxContentSizeKb}
              onChange={e => handleParamChange('maxContentSizeKb', Number(e.target.value))}
              className="h-8 text-xs font-mono"
            />
            <ParamHelp text={t('约束单文档 (PDF/TXT/Word/Markdown) 提取并送入向量索引的正文字符上限 (KB)。')} />
          </div>

          {/* 图片 OCR 开关与模型尺寸 */}
          <div className="space-y-3 md:col-span-2 p-3.5 rounded-lg bg-muted/20 border border-border/50">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-xs font-bold">{t('图片文字识别 (OCR)')}</Label>
                <ParamHelp text={t('自动识别图片中的文字并建立全文检索索引，适合截图、发票和设计稿。')} />
              </div>
              <Switch
                checked={effectiveParams.enableImageOcr}
                onCheckedChange={checked => handleParamChange('enableImageOcr', checked)}
              />
            </div>

            {effectiveParams.enableImageOcr && (
              <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-4">
                <Label className="text-xs text-muted-foreground">{t('OCR 模型精度')}</Label>
                <div className="flex items-center gap-2">
                  {[
                    { id: 'tiny' as const, label: t('极轻量 (tiny)') },
                    { id: 'small' as const, label: t('标准高精度 (small)') }
                  ].map(m => (
                    <Button
                      key={m.id}
                      type="button"
                      variant={effectiveParams.ocrModelSize === m.id ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => handleParamChange('ocrModelSize', m.id)}
                      className="text-xs h-7 px-2.5"
                    >
                      {m.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 4. 向量与语义硬件底座 (只读锁定卡片，遵守 RV-01 铁律与单引擎不变量) */}
      <Card className="p-4 bg-muted/30 border-border/80 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-500" />
            <h4 className="font-bold text-xs text-foreground">{t('多模态嵌入与向量流形底座 (系统硬件锁定)')}</h4>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
            {t('全局唯一实例')}
          </span>
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t(
            '根据全系统不可动摇底层红线，Omni 核心推理引擎为全局单例后台进程，全库共享同一流形向量空间。多模态画像与 MRL 维度根据全机物理内存与硬件架构静态锁定，各工作目录不可单独覆写，以杜绝向量空间撕裂与引擎频繁启停。'
          )}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div className="p-2.5 rounded-lg bg-background border border-border/60 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-primary shrink-0" />
              <div>
                <div className="text-xs font-semibold">{t('嵌入多模态画像')}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{effectiveParams.embeddingProfile}</div>
              </div>
            </div>
            <Lock className="w-3.5 h-3.5 text-muted-foreground" />
          </div>

          <div className="p-2.5 rounded-lg bg-background border border-border/60 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary shrink-0" />
              <div>
                <div className="text-xs font-semibold">{t('MRL 向量维度')}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{effectiveParams.mrlDimension} Dim</div>
              </div>
            </div>
            <Lock className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
        </div>
      </Card>
    </div>
  )
}
