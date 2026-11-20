import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  BaseAIConfig,
  WorkspaceDirectory,
  WorkspaceConfig,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  HardwareInfo
} from '@firefly/types'
import { mapIntentToParameters } from '@firefly/shared'
import { getIntentDisplayName } from '../WorkspaceConfigPanel'
import { Card } from '../../ui/card'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Label } from '../../ui/label'
import { cn } from '../../../lib/utils'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  submitWorkspacePolicyMutation,
  getMutationErrorText,
  type DegradationFixAction,
  type ResolvedTriStateField
} from '../../../lib/workspace-policy/workspace-ai-client'
import { getOcrModelSizeLabel, TriStateFieldFeedback } from './TriStateFieldFeedback'
import { openExternalLink } from '../../../lib/external-link'
import {
  FileText,
  ScanText,
  Boxes,
  RotateCcw,
  Loader2,
  CheckCircle2,
  Check,
  AlertCircle,
  ExternalLink,
  HelpCircle
} from 'lucide-react'

export interface ContentExtractionTabProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  isActive?: boolean
  onConfigSaved?: () => void
  resolvedFields?: Record<string, ResolvedTriStateField>
  hasBoundWorkflow?: boolean
  onFixAction?: (action: DegradationFixAction, pluginId?: string) => void
}

/** 待提交的补丁累积 */
interface PendingPolicyPatch {
  patch: Partial<TechnicalEngineParameters>
  restore: Set<keyof TechnicalEngineParameters>
}

/** 属于文件内容萃取 Tab 专管的参数键列表 (与基础AI引擎隔离，防跨Tab全量抹杀) */
const CONTENT_EXTRACTION_KEYS: (keyof TechnicalEngineParameters)[] = [
  'maxContentSizeKb',
  'extractPages',
  'maxDocumentOcrItems',
  'enableOfficeCover',
  'reuseBasicAnalysisData',
  'enableImageOcr',
  'ocrModelSize'
]

/**
 * 辅助悬浮气泡组件
 */
const HelpTooltip: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState(false)
  return (
    <span
      className="relative inline-flex items-center ml-1 cursor-pointer text-muted-foreground hover:text-foreground"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <HelpCircle className="h-3.5 w-3.5" />
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 text-xs bg-popover text-popover-foreground border rounded-lg shadow-md z-50 pointer-events-none whitespace-normal normal-case leading-normal font-normal">
          {content}
        </span>
      )}
    </span>
  )
}

/**
 * 工作区专有：文件内容萃取设置 Tab (原 content-extraction-settings 完整还原版)
 */
export const ContentExtractionTab: React.FC<ContentExtractionTabProps> = ({
  workspace,
  hardwareInfo,
  isActive = true,
  onConfigSaved,
  resolvedFields,
  hasBoundWorkflow = false,
  onFixAction
}) => {
  const [isSaving, setIsSaving] = useState(false)

  // LibreOffice 状态检测
  const [libreOfficeInstalled, setLibreOfficeInstalled] = useState<boolean | null>(null)
  const [libreOfficeVersion, setLibreOfficeVersion] = useState<string | undefined>(undefined)
  const [checkingLibreOffice, setCheckingLibreOffice] = useState(false)
  const [showLibreOfficeHelp, setShowLibreOfficeHelp] = useState(false)

  // 解析当前配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const isReady = parsedConfig.status === 'ready'
  const currentIntent = isReady && parsedConfig.intent ? parsedConfig.intent : 'fast_archive'

  // 基线快照与局部微调覆盖
  const baseDerived: BaseAIConfig = useMemo(() => {
    if (isReady && parsedConfig.baseAIConfig) {
      return parsedConfig.baseAIConfig
    }
    return mapIntentToParameters(currentIntent, hardwareInfo) as BaseAIConfig
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
  const effectiveParams: BaseAIConfig = useMemo(() => {
    return {
      ...baseDerived,
      ...overrides
    }
  }, [baseDerived, overrides])

  // 待提交的补丁累积（用户触碰字段 / 待恢复字段）与防抖计时器
  const pendingPatchRef = useRef<PendingPolicyPatch | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  /** 通过统一补丁通道提交（严禁整份拼装 WorkspaceConfigReady 直写） */
  const persistMutation = useCallback(
    async (pending: PendingPolicyPatch) => {
      if (!workspace.id) return
      const restoreKeys = Array.from(pending.restore)
      const hasPatch = Object.keys(pending.patch).length > 0
      if (!hasPatch && restoreKeys.length === 0) return
      setIsSaving(true)
      try {
        const res = await submitWorkspacePolicyMutation(workspace.id, {
          ...(hasPatch ? { overridePatch: pending.patch } : {}),
          ...(restoreKeys.length > 0 ? { restoreOverrideFields: restoreKeys } : {})
        })
        if (res.success) {
          onConfigSaved?.()
        } else {
          toast.error(getMutationErrorText(res, t('保存失败')))
        }
      } catch (err: any) {
        console.error('[ContentExtractionTab] 提交配置补丁异常:', err)
        toast.error(t('保存失败'))
      } finally {
        setIsSaving(false)
      }
    },
    [workspace.id, onConfigSaved]
  )

  const flushPending = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const pending = pendingPatchRef.current
    if (pending !== null) {
      pendingPatchRef.current = null
      void persistMutation(pending)
    }
  }, [persistMutation])

  // 切 Tab (isActive 变为 false) 或卸载时立即 flush 未落盘数据，杜绝并发覆盖竞态
  useEffect(() => {
    if (!isActive) flushPending()
  }, [isActive, flushPending])

  useEffect(() => {
    return () => flushPending()
  }, [flushPending])

  // 修改单个参数：等值回退——设值与当前基线（工作流默认/系统默认）一致时精确 delete 覆盖键算回默认态，
  // 仅值 ≠ 基线的显式覆盖写入补丁保留 user_custom，500ms 防抖提交
  const handleParamChange = <K extends keyof TechnicalEngineParameters>(
    key: K,
    val: TechnicalEngineParameters[K]
  ) => {
    const baselineVal = (baseDerived as Partial<TechnicalEngineParameters>)[key]
    if (val === baselineVal) {
      // 等值回退：本地覆盖字典同步删除该键，effectiveParams 自动回落基线（值相同）
      setOverrides(prev => {
        if (prev[key] === undefined) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    } else {
      setOverrides(prev => ({ ...prev, [key]: val }))
    }
    const pending = pendingPatchRef.current ?? { patch: {}, restore: new Set() }
    if (val === baselineVal) {
      delete pending.patch[key]
      pending.restore.add(key)
    } else {
      pending.patch = { ...pending.patch, [key]: val }
      pending.restore.delete(key)
    }
    pendingPatchRef.current = pending
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(flushPending, 500)
  }

  // 检查当前 Tab 是否存在个性化覆盖项
  const hasContentOverrides = useMemo(() => {
    return CONTENT_EXTRACTION_KEYS.some(k => overrides[k] !== undefined)
  }, [overrides])

  // 恢复默认：仅对本 Tab 管辖且已覆盖的键发送 restoreOverrideFields（严禁传 null）
  const handleResetToPreset = () => {
    const pending = pendingPatchRef.current ?? { patch: {}, restore: new Set() }
    for (const k of CONTENT_EXTRACTION_KEYS.filter(k => overrides[k] !== undefined)) {
      pending.restore.add(k)
      delete pending.patch[k]
    }
    pendingPatchRef.current = pending
    const next = { ...overrides }
    for (const k of CONTENT_EXTRACTION_KEYS) delete next[k]
    setOverrides(next)
    flushPending()
    toast.success(t('已恢复当前场景的文件内容萃取推荐参数'))
  }

  // 检测 LibreOffice 状态（手动重检传 forceRefresh=true 穿透缓存）
  const checkLibreOfficeStatus = async (forceRefresh = false) => {
    if (!(window as any).electronAPI?.utils?.detectLibreOffice) {
      setLibreOfficeInstalled(false)
      return
    }
    setCheckingLibreOffice(true)
    try {
      const result = await (window as any).electronAPI.utils.detectLibreOffice(forceRefresh)
      setLibreOfficeInstalled(result?.installed ?? false)
      setLibreOfficeVersion(result?.version)
    } catch (error) {
      console.error('检测LibreOffice失败:', error)
      setLibreOfficeInstalled(false)
    } finally {
      setCheckingLibreOffice(false)
    }
  }

  useEffect(() => {
    checkLibreOfficeStatus()
  }, [])

  const handleOpenLibreOfficeDownload = () => {
    openExternalLink('https://www.libreoffice.org/download/download/')
  }

  const currentMaxContentSizeKb = effectiveParams.maxContentSizeKb ?? 30
  const currentMaxDocOcrItems = effectiveParams.maxDocumentOcrItems ?? 3
  const currentExtractPages = effectiveParams.extractPages ?? 2
  const currentEnableOfficeCover = effectiveParams.enableOfficeCover ?? false
  const currentEnableImageOcr = effectiveParams.enableImageOcr ?? true
  const currentOcrModelSize = effectiveParams.ocrModelSize ?? 'tiny'
  const currentReuseBasicData = effectiveParams.reuseBasicAnalysisData ?? true

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部标题与场景概览 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/60">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Boxes className="w-5 h-5 text-primary" />
            <span>{t('文件内容萃取')}</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('当前配置：{name}。控制文字提取、图片文字识别与文档封面生成。', {
              name:
                parsedConfig.status === 'ready' && parsedConfig.workflowId
                  ? (parsedConfig as unknown as { workflowName?: string }).workflowName ||
                    getIntentDisplayName(currentIntent)
                  : t('默认配置')
            })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* 自动保存状态指示 */}
          {isSaving ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1.5 animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              <span>{t('正在自动保存...')}</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/80 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              <span>{t('已自动保存')}</span>
            </span>
          )}

          {/* 恢复默认按钮 (仅在存在本Tab微调项时展示) */}
          {hasContentOverrides && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleResetToPreset}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 h-8"
              title={t('清除所有微调项，恢复为默认值')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>
                {parsedConfig.status === 'ready' && parsedConfig.workflowId
                  ? t('恢复工作流默认')
                  : t('恢复默认配置')}
              </span>
            </Button>
          )}
        </div>
      </div>

      {/* SLICE-08：本 Tab 专管内容萃取参数的三态反馈（用户自定义 / 环境降级 / 级联关闭） */}
      {resolvedFields && (
        <div className="space-y-1.5">
          {CONTENT_EXTRACTION_KEYS.map(fieldKey => {
            const field = resolvedFields[fieldKey]
            if (!field || !field.visible) return null
            if (field.origin !== 'user_custom' && field.applicability === 'active') return null
            const fmtVal = (v: unknown) =>
              fieldKey === 'ocrModelSize'
                ? getOcrModelSizeLabel(v === 'small' ? 'small' : 'tiny')
                : String(v ?? '')
            return (
              <TriStateFieldFeedback
                key={fieldKey}
                field={field}
                effectiveText={fmtVal(field.effectiveValue)}
                desiredText={fmtVal(field.desiredValue)}
                baselineText={fmtVal(baseDerived[fieldKey as keyof BaseAIConfig])}
                hasBoundWorkflow={hasBoundWorkflow}
                onRestore={() => {
                  if (workspace.id == null) return
                  void submitWorkspacePolicyMutation(workspace.id, {
                    restoreOverrideFields: [fieldKey as keyof BaseAIConfig]
                  }).then(res => {
                    if (res.success) {
                      setOverrides(prev => {
                        const next = { ...prev }
                        delete next[fieldKey]
                        return next
                      })
                      onConfigSaved?.()
                    } else {
                      toast.error(getMutationErrorText(res, t('恢复默认失败')))
                    }
                  })
                }}
                onFixAction={onFixAction}
              />
            )
          })}
        </div>
      )}

      {/* 主卡片 */}
      <Card className="p-5 space-y-6">
        {/* 小节 1：文档与正文提取 */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText className="h-4 w-4 text-primary shrink-0" />
            <span>{t('文档与正文内容提取')}</span>
          </div>

          {/* 内容提取大小上限 */}
          <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="max-content-size" className="text-sm font-medium">
                  {t('正文提取大小上限')}
                </Label>
                <HelpTooltip
                  content={t(
                    '单个文件中可提取的文字内容大小上限，超长内容会被自动截断，避免过多占用存储。'
                  )}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary">
                  {currentMaxContentSizeKb === -1 || currentMaxContentSizeKb === 0
                    ? t('不限')
                    : `${currentMaxContentSizeKb} KB`}
                </span>
                {currentMaxContentSizeKb > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {(() => {
                      const chineseChars = currentMaxContentSizeKb * 333
                      const englishWords = Math.round(chineseChars / 2)
                      const formattedZh =
                        chineseChars >= 10000
                          ? `${(chineseChars / 10000).toLocaleString(undefined, {
                              maximumFractionDigits: 1
                            })}${t('万')}`
                          : chineseChars.toLocaleString()
                      const formattedEn =
                        englishWords >= 10000
                          ? `${(englishWords / 10000).toLocaleString(undefined, {
                              maximumFractionDigits: 1
                            })}${t('万')}`
                          : englishWords.toLocaleString()
                      return `（${t('相当于约 {zh} 字或 {en} 单词', {
                        zh: formattedZh,
                        en: formattedEn
                      })}）`
                    })()}
                  </span>
                )}
              </div>
            </div>

            {(() => {
              const STANDARD_TICKS = [256, 512, 1024, 2048, 4096, 8192, 16384, -1]
              const normalizedValue = currentMaxContentSizeKb === 0 ? -1 : currentMaxContentSizeKb
              // 历史非标值（如 100）按实际值插入刻度并保真展示，禁止静默落回其它刻度
              const ticks =
                normalizedValue > 0 && !STANDARD_TICKS.includes(normalizedValue)
                  ? [...STANDARD_TICKS.slice(0, -1), normalizedValue, -1].sort((a, b) =>
                      a === -1 ? 1 : b === -1 ? -1 : a - b
                    )
                  : STANDARD_TICKS
              const currentIndex = Math.max(0, ticks.indexOf(normalizedValue))

              return (
                <div className="space-y-2 pt-1 pb-1 px-1">
                  <input
                    id="max-content-size"
                    type="range"
                    min={0}
                    max={ticks.length - 1}
                    step={1}
                    value={currentIndex}
                    onChange={e => {
                      const idx = parseInt(e.target.value, 10)
                      handleParamChange('maxContentSizeKb', ticks[idx])
                    }}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-secondary accent-primary"
                  />
                  <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-1 select-none">
                    {ticks.map((tick, index) => {
                      const isActive = index === currentIndex
                      const isUnlimited = tick === -1
                      return (
                        <button
                          key={tick}
                          type="button"
                          onClick={() => handleParamChange('maxContentSizeKb', tick)}
                          className={cn(
                            'flex flex-col items-center gap-1 transition-colors hover:text-foreground cursor-pointer',
                            isActive && 'text-primary font-bold scale-110'
                          )}
                        >
                          <span
                            className={cn(
                              'w-0.5 h-1.5 rounded-full',
                              isActive ? 'bg-primary h-2.5' : 'bg-muted-foreground/30'
                            )}
                          />
                          <span>{isUnlimited ? t('不限') : tick}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* PDF 提取页数 */}
          <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="pdf-extract-pages" className="text-sm font-medium">
                  {t('PDF 文档正文提取页数')}
                </Label>
                <HelpTooltip content={t('控制 PDF 文档提取前多少页的文字内容用于搜索。')} />
              </div>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary">
                {currentExtractPages === -1 ? t('全本不限') : `${currentExtractPages} ${t('页')}`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <input
                id="pdf-extract-pages"
                type="range"
                min={1}
                max={20}
                step={1}
                value={currentExtractPages === -1 ? 20 : currentExtractPages}
                onChange={e => handleParamChange('extractPages', Number(e.target.value))}
                className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-secondary accent-primary"
              />
              <Button
                type="button"
                variant={currentExtractPages === -1 ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs px-2.5 shrink-0"
                onClick={() =>
                  handleParamChange(
                    'extractPages',
                    currentExtractPages === -1 ? (baseDerived.extractPages ?? 2) : -1
                  )
                }
              >
                {t('全本不限')}
              </Button>
            </div>
          </div>

          {/* 开启 Office 文档封面截图与 LibreOffice 联动 */}
          <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1 pr-4">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="office-cover-switch" className="text-sm font-medium">
                    {t('开启办公文档封面缩略图')}
                  </Label>
                  <HelpTooltip
                    content={t(
                      '支持将 Word/PPT/Excel 首页导出为封面缩略图，但会增加文档分析耗时，PDF 不受影响。需要先安装办公文档排版组件。'
                    )}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {currentEnableOfficeCover
                    ? t('开启：自动为文档首页生成缩略图封面')
                    : t('关闭：不生成办公文档封面缩略图')}
                </p>
              </div>
              <Switch
                id="office-cover-switch"
                checked={currentEnableOfficeCover}
                onCheckedChange={checked => handleParamChange('enableOfficeCover', checked)}
              />
            </div>

            {currentEnableOfficeCover && (
              <div className="pt-3 border-t border-border/40">
                <div className="flex items-start justify-between">
                  <div className="flex-1 pr-4">
                    <Label className="text-sm font-medium flex items-center gap-2">
                      {t('依赖环境：办公文档排版组件')}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('支持 Word/PPT/Excel 首页缩略图')}，
                      <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                        {t('但会增加内容提取耗时，PDF不受影响')}
                      </span>
                    </p>

                    {!checkingLibreOffice &&
                      libreOfficeInstalled === false &&
                      navigator.platform.includes('Win') && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() => setShowLibreOfficeHelp(!showLibreOfficeHelp)}
                            className="text-xs text-amber-600 dark:text-amber-400 hover:underline font-medium flex items-center gap-1 cursor-pointer"
                          >
                            {showLibreOfficeHelp
                              ? t('收起 Windows 安装教程 💡')
                              : t('展开 Windows 安装与配置教程 💡')}
                          </button>
                          {showLibreOfficeHelp && (
                            <div className="mt-2 p-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-300 space-y-1">
                              <p className="font-semibold">{t('如何配置：')}</p>
                              <ul className="ml-4 list-disc space-y-0.5">
                                <li>
                                  {t('请先安装办公文档排版组件，并将其安装路径加入系统环境变量')}
                                </li>
                                <li>
                                  {t('默认位置：办公文档排版组件安装目录下的 program 文件夹')}
                                </li>
                                <li>{t('配置后重启应用再次点击重新检测。')}</li>
                              </ul>
                            </div>
                          )}
                        </div>
                      )}

                    {!checkingLibreOffice && libreOfficeInstalled === false && (
                      <Button
                        size="sm"
                        className="mt-3.5 h-8 text-xs"
                        onClick={handleOpenLibreOfficeDownload}
                      >
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        {t('前往下载')}
                      </Button>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <div>
                      {checkingLibreOffice && (
                        <span className="text-xs text-muted-foreground">{t('检测中...')}</span>
                      )}
                      {!checkingLibreOffice && libreOfficeInstalled === true && (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                          <CheckCircle2 className="h-4 w-4" />
                          {t('已安装')}
                          {libreOfficeVersion && <span>（{libreOfficeVersion}）</span>}
                        </span>
                      )}
                      {!checkingLibreOffice && libreOfficeInstalled === false && (
                        <span className="flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400 font-medium">
                          <AlertCircle className="h-4 w-4" />
                          {t('未检测到')}
                        </span>
                      )}
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void checkLibreOfficeStatus(true)}
                      disabled={checkingLibreOffice}
                      className="h-8 text-xs"
                    >
                      {checkingLibreOffice ? t('检测中...') : t('重新检测')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 小节 2：OCR 识别与处理 */}
        <div className="space-y-4 pt-3 border-t border-border/60">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ScanText className="h-4 w-4 text-primary shrink-0" />
            <span>{t('图片与文档文字识别')}</span>
          </div>

          {/* 开启图片 OCR 识别 */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-muted/20 border border-border/60">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="image-ocr-switch" className="text-sm font-medium">
                  {t('开启图片文字识别')}
                </Label>
                <HelpTooltip content={t('快速判断图片中是否有文字，有则自动识别')} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('自动识别图片中的文字内容，可直接按文字搜索')}
              </p>
            </div>
            <Switch
              id="image-ocr-switch"
              checked={currentEnableImageOcr}
              onCheckedChange={checked => handleParamChange('enableImageOcr', checked)}
            />
          </div>

          {/* 文档 OCR 识别数量上限 */}
          <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="max-doc-ocr-items" className="text-sm font-medium">
                  {t('文档内嵌图片文字识别数量上限')}
                </Label>
                <HelpTooltip
                  content={t(
                    '办公文档内嵌图片数量与 PDF 扫描版识别页数上限。设为 0 表示跳过文档内图片文字识别。'
                  )}
                />
              </div>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary">
                {currentMaxDocOcrItems === -1
                  ? t('不限')
                  : currentMaxDocOcrItems === 0
                    ? t('关闭 (0)')
                    : `${currentMaxDocOcrItems} ${t('项/页')}`}
              </span>
            </div>

            {(() => {
              const ticks = Array.from({ length: 31 }, (_, i) => i).concat([-1])
              const currentIndex =
                ticks.indexOf(currentMaxDocOcrItems) !== -1
                  ? ticks.indexOf(currentMaxDocOcrItems)
                  : 0

              return (
                <div className="space-y-2 pt-1 pb-1 px-1">
                  <input
                    id="max-doc-ocr-items"
                    type="range"
                    min={0}
                    max={ticks.length - 1}
                    step={1}
                    value={currentIndex}
                    onChange={e => {
                      const idx = parseInt(e.target.value, 10)
                      handleParamChange('maxDocumentOcrItems', ticks[idx])
                    }}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-secondary accent-primary"
                  />
                  <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-1 select-none">
                    {ticks.map((tick, idx) => {
                      const isMajorTick = [0, 5, 10, 15, 20, 25, 30, -1].includes(tick)
                      const isActive = idx === currentIndex
                      const isUnlimited = tick === -1
                      if (!isMajorTick) {
                        return <span key={tick} className="flex-1" />
                      }
                      return (
                        <button
                          key={tick}
                          type="button"
                          onClick={() => handleParamChange('maxDocumentOcrItems', tick)}
                          className={cn(
                            'flex flex-col items-center gap-1 transition-colors hover:text-foreground cursor-pointer',
                            isActive && 'text-primary font-bold scale-110'
                          )}
                        >
                          <span
                            className={cn(
                              'w-0.5 h-1.5 rounded-full',
                              isActive ? 'bg-primary h-2.5' : 'bg-muted-foreground/30'
                            )}
                          />
                          <span>{isUnlimited ? t('不限') : tick}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
          </div>

          {/* OCR 识别精度卡片 */}
          <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-3">
            <div className="flex items-center gap-1.5">
              <Label className="text-sm font-medium">{t('文字识别清晰度')}</Label>
              <HelpTooltip
                content={t(
                  '选择图片与文档文字识别清晰度。极速识别适合大部分场景；高清精识识别更准但耗时稍长。'
                )}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* 极速 OCR */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleParamChange('ocrModelSize', 'tiny')}
                className={cn(
                  'relative overflow-hidden flex flex-col p-4 rounded-xl border-2 cursor-pointer transition-all',
                  currentOcrModelSize === 'tiny'
                    ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20'
                    : 'border-border/60 bg-card hover:border-primary/40 hover:bg-muted/30'
                )}
              >
                <div className="absolute top-0 right-0 text-[9px] font-medium bg-green-500/15 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded-bl-md border border-green-500/20">
                  {t('推荐')}
                </div>
                {currentOcrModelSize === 'tiny' && (
                  <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-xs">
                    <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                  </div>
                )}
                <div className="flex items-center justify-between pr-8">
                  <span
                    className={cn(
                      'font-semibold text-sm',
                      currentOcrModelSize === 'tiny' && 'text-primary'
                    )}
                  >
                    {getOcrModelSizeLabel('tiny')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {t('单图 1~2 秒内完成，性能极佳，适合绝大部分日常图片。')}
                </p>
              </div>

              {/* 高精度 OCR */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleParamChange('ocrModelSize', 'small')}
                className={cn(
                  'relative overflow-hidden flex flex-col p-4 rounded-xl border-2 cursor-pointer transition-all',
                  currentOcrModelSize === 'small'
                    ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20'
                    : 'border-border/60 bg-card hover:border-primary/40 hover:bg-muted/30'
                )}
              >
                {currentOcrModelSize === 'small' && (
                  <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-xs">
                    <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                  </div>
                )}
                <div className="flex items-center justify-between pr-8">
                  <span
                    className={cn(
                      'font-semibold text-sm',
                      currentOcrModelSize === 'small' && 'text-primary'
                    )}
                  >
                    {getOcrModelSizeLabel('small')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {t('单图 2~4 秒内完成，提高字迹复杂、低对比度图片的识别率。')}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* 小节 3：重新分析复用数据开关 */}
        <div className="pt-3 border-t border-border/60">
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-muted/20 border border-border/60">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="reuse-basic-data-switch" className="text-sm font-medium">
                  {t('重新分析时复用数据')}
                </Label>
                <HelpTooltip
                  content={t(
                    '如果文件已更新，请关闭此项；否则已存在的基础信息（文件类型、缩略图、元数据、正文）将直接复用，加速分析。'
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('分析大幅提速，跳过已存在的基础客观信息提取阶段')}
              </p>
            </div>
            <Switch
              id="reuse-basic-data-switch"
              checked={currentReuseBasicData}
              onCheckedChange={checked => handleParamChange('reuseBasicAnalysisData', checked)}
            />
          </div>
        </div>
      </Card>
    </div>
  )
}
