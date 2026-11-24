import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  BaseAIConfig,
  WorkspaceDirectory,
  WorkspaceConfig,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  HardwareInfo,
  DEFAULT_UNBOUND_AI_CONFIG
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
  type DegradationFixAction,
  type ResolvedTriStateField
} from '../../../lib/workspace-policy/workspace-ai-client'
import { PolicySliderRow, PolicySliderTick, useStickyStops } from './policy-slider-kit'
import { useWorkspacePolicyPatchChannel } from './use-workspace-policy-patch-channel'
import { getOcrModelSizeLabel, TriStateFieldFeedback } from './TriStateFieldFeedback'
import { TriStateCustomFieldsTable, type TriStateCustomFieldRow } from './TriStateCustomFieldsTable'
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
 * CONTENT_EXTRACTION_KEYS 参数项展示名（渲染期 switch 动态返回静态 t() 以支持语言切换，
 * 严禁置于模块级静态对象字面量——t() 静态对象切换语言后无法刷新）
 */
function getContentExtractionFieldLabel(key: string): string {
  switch (key) {
    case 'maxContentSizeKb':
      return t('正文提取大小上限')
    case 'extractPages':
      return t('PDF 文档正文提取页数')
    case 'maxDocumentOcrItems':
      return t('文档内嵌图片文字识别数量上限')
    case 'enableOfficeCover':
      return t('开启办公文档封面缩略图')
    case 'reuseBasicAnalysisData':
      return t('重新分析时复用数据')
    case 'enableImageOcr':
      return t('开启图片文字识别')
    case 'ocrModelSize':
      return t('文字识别清晰度')
    default:
      return key
  }
}

/** 设置值四态表格各值列的大白话渲染：布尔转「开启/关闭」、枚举/数值转 UI 命名与单位（渲染期动态 t()） */
function formatContentExtractionCellValue(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? t('开启') : t('关闭')
  if (key === 'ocrModelSize') return getOcrModelSizeLabel(v === 'small' ? 'small' : 'tiny')
  if (key === 'maxContentSizeKb') {
    const n = Number(v)
    return n <= 0 ? t('不限') : `${n} KB`
  }
  if (key === 'extractPages') {
    const n = Number(v)
    if (!Number.isFinite(n)) return String(v ?? '')
    return n === -1 ? t('全本不限') : `${n} ${t('页')}`
  }
  if (key === 'maxDocumentOcrItems') {
    const n = Number(v)
    // 契约语义（对齐类型注释与内核 docOcrOff 判据）：-1 不限、0 关闭文档识别，其余为张数
    if (n === -1) return t('不限')
    if (n === 0) return t('关闭')
    return `${n} ${t('张')}`
  }
  return String(v ?? '')
}

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

  const {
    overrides,
    effectiveParams,
    isSaving,
    handleParamChange,
    flushPending,
    restoreField,
    resetKeys
  } = useWorkspacePolicyPatchChannel({
    workspaceId: workspace.id,
    workspaceConfig: workspace.workspace_config,
    baseDerived,
    isActive: Boolean(isActive),
    onConfigSaved,
    logTag: 'ContentExtractionTab'
  })

  // 检查当前 Tab 是否存在个性化覆盖项
  const hasContentOverrides = useMemo(() => {
    return CONTENT_EXTRACTION_KEYS.some(k => overrides[k] !== undefined)
  }, [overrides])

  /** 恢复单个字段默认：先冲刷防抖队列再发 restoreOverrideFields */
  const restoreContentExtractionField = useCallback(
    (fieldKey: string) => {
      restoreField(fieldKey as keyof TechnicalEngineParameters)
    },
    [restoreField]
  )

  // 恢复默认：仅对本 Tab 管辖且已覆盖的键发送 restoreOverrideFields（严禁传 null）
  const handleResetToPreset = () => {
    resetKeys(CONTENT_EXTRACTION_KEYS)
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
                  : t('恢复全局默认')}
              </span>
            </Button>
          )}
        </div>
      </div>

      {/* SLICE-08 + v1.5：本 Tab 专管内容萃取参数的三态反馈
          - 用户自定义 && 正常生效项 → 设置值四态表格（逐行标明参数项 + 全局默认/工作流默认/用户自定义值/最终结算值对照）
          - 环境降级 / 级联关闭等态 → 保持 TriStateFieldFeedback 单项反馈 */}
      {resolvedFields && (
        <div className="space-y-1.5">
          <TriStateCustomFieldsTable
            rows={CONTENT_EXTRACTION_KEYS.reduce<TriStateCustomFieldRow[]>((acc, fieldKey) => {
              const field = resolvedFields[fieldKey]
              if (!field || !field.visible) return acc
              if (field.origin !== 'user_custom' || field.applicability !== 'active') return acc
              acc.push({
                key: String(fieldKey),
                label: getContentExtractionFieldLabel(fieldKey),
                globalDefaultText: formatContentExtractionCellValue(
                  fieldKey,
                  DEFAULT_UNBOUND_AI_CONFIG[fieldKey as keyof BaseAIConfig]
                ),
                workflowDefaultText: hasBoundWorkflow
                  ? formatContentExtractionCellValue(
                      fieldKey,
                      baseDerived[fieldKey as keyof BaseAIConfig]
                    )
                  : undefined,
                customText: formatContentExtractionCellValue(fieldKey, field.desiredValue),
                finalText: formatContentExtractionCellValue(fieldKey, field.effectiveValue)
              })
              return acc
            }, [])}
            hasBoundWorkflow={hasBoundWorkflow}
            onRestore={fieldKey => restoreContentExtractionField(fieldKey)}
          />
          {CONTENT_EXTRACTION_KEYS.map(fieldKey => {
            const field = resolvedFields[fieldKey]
            if (!field || !field.visible) return null
            // 默认正常态零冗余；user_custom && active 已收归上方设置值四态表格；
            // cascaded_off / pending 属具体控件位置语义（如清晰度随上方开关级联关闭），
            // 由「文字识别清晰度」控件区内渲染，严禁在顶部重复罗列
            if (field.applicability !== 'degraded') return null
            return (
              <TriStateFieldFeedback
                key={fieldKey}
                field={field}
                effectiveText={formatContentExtractionCellValue(fieldKey, field.effectiveValue)}
                desiredText={formatContentExtractionCellValue(fieldKey, field.desiredValue)}
                baselineText={formatContentExtractionCellValue(
                  fieldKey,
                  baseDerived[fieldKey as keyof BaseAIConfig]
                )}
                hasBoundWorkflow={hasBoundWorkflow}
                onRestore={() => restoreContentExtractionField(fieldKey)}
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

          {/* 正文提取大小上限 */}
          {(() => {
            const rawContentKb = currentMaxContentSizeKb === 0 ? -1 : currentMaxContentSizeKb
            const STANDARD_CONTENT_STOPS = [256, 512, 1024, 2048, 4096, 8192, 16384, -1] as const
            const contentStops = useStickyStops(STANDARD_CONTENT_STOPS, rawContentKb)
            const contentTicks: PolicySliderTick[] = contentStops.map(s => ({
              value: s,
              label: s === -1 ? t('不限') : String(s)
            }))

            const renderValue = (n: number) => {
              const isUnlimited = n === -1 || n === 0
              const chineseChars = !isUnlimited ? n * 333 : 0
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

              return (
                <>
                  <span className="text-sm font-extrabold font-mono text-primary">
                    {isUnlimited ? t('不限') : `${n} KB`}
                  </span>
                  {!isUnlimited && (
                    <span className="text-[11px] text-muted-foreground font-mono">
                      ({t('相当于约 {zh} 字或 {en} 单词', { zh: formattedZh, en: formattedEn })})
                    </span>
                  )}
                </>
              )
            }

            const renderLegend = (n: number) => {
              if (n === -1 || n === 0) {
                return {
                  left: t('不限制提取文字量，超长文件整理会更久、占用更多存储'),
                  badge: { paused: false, text: t('涵盖整本书籍与超长资料') }
                }
              }
              return {
                left: t('单个文件最多提取 {size} KB 文字，超长内容自动截断，不占过多存储', {
                  size: n
                }),
                badge:
                  n <= 1024
                    ? { paused: false, text: t('涵盖日常文档与短文章') }
                    : n <= 8192
                      ? { paused: false, text: t('涵盖长篇报告与小说章节') }
                      : { paused: false, text: t('涵盖整本书籍与超长资料') }
              }
            }

            return (
              <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-3">
                <PolicySliderRow
                  testIdPrefix="max-content-size"
                  title={t('正文提取大小上限')}
                  titleExtra={
                    <HelpTooltip
                      content={t(
                        '单个文件中可提取的文字内容大小上限，超长内容会被自动截断，避免过多占用存储。'
                      )}
                    />
                  }
                  capsuleText={t('按需选择 · 可设不限')}
                  renderValue={renderValue}
                  stops={contentStops}
                  value={rawContentKb}
                  onChange={val => handleParamChange('maxContentSizeKb', val === -1 ? -1 : val)}
                  ticks={contentTicks}
                  renderLegend={renderLegend}
                />
              </div>
            )
          })()}

          {/* PDF 提取页数 */}
          {(() => {
            const PDF_STOPS: ReadonlyArray<number> = [
              ...Array.from({ length: 20 }, (_, i) => i + 1),
              -1
            ]
            const PDF_TICKS: PolicySliderTick[] = [
              { value: 1, label: '1' },
              { value: 5, label: '5' },
              { value: 10, label: '10' },
              { value: 15, label: '15' },
              { value: 20, label: '20' },
              { value: -1, label: t('全本不限') }
            ]

            const renderValue = (pages: number) => (
              <span className="text-sm font-extrabold font-mono text-primary">
                {pages === -1 ? t('全本不限') : `${pages} ${t('页')}`}
              </span>
            )

            const renderLegend = (pages: number) => {
              if (pages === -1) {
                return {
                  left: t('PDF 全部页面的文字都会被提取用于搜索'),
                  badge: { paused: false, text: t('涵盖长篇文档与整本电子书') }
                }
              }
              return {
                left: t('PDF 仅提取前 {pages} 页文字用于搜索', { pages }),
                badge:
                  pages <= 3
                    ? { paused: false, text: t('涵盖摘要与目录页') }
                    : pages <= 10
                      ? { paused: false, text: t('涵盖论文与短报告') }
                      : { paused: false, text: t('涵盖长篇文档与整本电子书') }
              }
            }

            return (
              <div className="p-3.5 rounded-xl bg-muted/20 border border-border/60 space-y-3">
                <PolicySliderRow
                  testIdPrefix="pdf-extract-pages"
                  title={t('PDF 文档正文提取页数')}
                  titleExtra={
                    <HelpTooltip content={t('控制 PDF 文档提取前多少页的文字内容用于搜索。')} />
                  }
                  capsuleText={t('1 页一档 · 可全本不限')}
                  renderValue={renderValue}
                  stops={PDF_STOPS}
                  value={currentExtractPages}
                  onChange={val => handleParamChange('extractPages', val)}
                  ticks={PDF_TICKS}
                  renderLegend={renderLegend}
                />
              </div>
            )
          })()}

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
            {(() => {
              const OCR_STOPS: ReadonlyArray<number> = [
                ...Array.from({ length: 31 }, (_, i) => i),
                -1
              ]
              const OCR_TICKS: PolicySliderTick[] = [0, 5, 10, 15, 20, 25, 30, -1].map(v => ({
                value: v,
                label: v === -1 ? t('不限') : String(v)
              }))

              const renderValue = (n: number) => (
                <>
                  <span className="text-sm font-extrabold font-mono text-primary">
                    {n === -1 ? t('不限') : n === 0 ? t('关闭 (0)') : `${n} ${t('项/页')}`}
                  </span>
                  {n === 0 && (
                    <span className="text-[11px] text-muted-foreground font-mono">
                      ({t('已跳过文档图片识别')})
                    </span>
                  )}
                </>
              )

              const renderLegend = (n: number) => {
                if (n === 0) {
                  return {
                    left: t('已跳过文档内图片文字识别'),
                    badge: { paused: true, text: t('已关闭文档图片识别') }
                  }
                }
                if (n === -1) {
                  return {
                    left: t('不限制数量，扫描版文档整理耗时会明显变长'),
                    badge: { paused: false, text: t('涵盖整本扫描版资料') }
                  }
                }
                return {
                  left: t('办公文档内嵌图片与扫描版 PDF 最多识别 {count} 项/页', { count: n }),
                  badge:
                    n <= 10
                      ? { paused: false, text: t('涵盖带插图的常见文档') }
                      : { paused: false, text: t('涵盖多图排版与长图文档') }
                }
              }

              return (
                <PolicySliderRow
                  testIdPrefix="max-doc-ocr-items"
                  title={t('文档内嵌图片文字识别数量上限')}
                  titleExtra={
                    <HelpTooltip
                      content={t(
                        '办公文档内嵌图片数量与 PDF 扫描版识别页数上限。设为 0 表示跳过文档内图片文字识别。'
                      )}
                    />
                  }
                  capsuleText={t('0 为关闭 · 可设不限')}
                  renderValue={renderValue}
                  stops={OCR_STOPS}
                  value={currentMaxDocOcrItems}
                  onChange={val => handleParamChange('maxDocumentOcrItems', val)}
                  ticks={OCR_TICKS}
                  renderLegend={renderLegend}
                />
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
            {/* 清晰度级联/下载提示：随上方「开启图片文字识别」开关级联关闭时在此渲染（顶部汇总区严禁重复罗列） */}
            {(() => {
              const ocrField = resolvedFields?.['ocrModelSize']
              if (
                !ocrField ||
                ocrField.visible === false ||
                (ocrField.applicability !== 'cascaded_off' && ocrField.applicability !== 'pending')
              ) {
                return null
              }
              return (
                <TriStateFieldFeedback
                  field={ocrField}
                  effectiveText={formatContentExtractionCellValue(
                    'ocrModelSize',
                    ocrField.effectiveValue
                  )}
                  desiredText={formatContentExtractionCellValue(
                    'ocrModelSize',
                    ocrField.desiredValue
                  )}
                  hasBoundWorkflow={hasBoundWorkflow}
                  onFixAction={onFixAction}
                />
              )
            })()}
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
