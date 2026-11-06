import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
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
  onConfigSaved
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
  const baseDerived: TechnicalEngineParameters = useMemo(() => {
    if (isReady && (parsedConfig.baseAIConfig || parsedConfig.derivedSnapshot)) {
      return parsedConfig.baseAIConfig || parsedConfig.derivedSnapshot
    }
    return mapIntentToParameters(currentIntent, hardwareInfo)
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

  // 待持久化数据引用与防抖计时器
  const pendingOverridesRef = useRef<Partial<TechnicalEngineParameters> | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 核心写盘方法 (按当前工作目录隔离持久化)
  const persistConfig = useCallback(
    async (targetOverrides: Partial<TechnicalEngineParameters>) => {
      if (!workspace.id) return
      setIsSaving(true)
      try {
        const hasAnyOverride = Object.keys(targetOverrides).length > 0
        const updatedConfig: WorkspaceConfig = {
          schemaVersion: 1,
          status: 'ready',
          intent: currentIntent,
          policyVersion: 1,
          baseAIConfig: baseDerived,
          derivedSnapshot: baseDerived,
          overrides: hasAnyOverride ? targetOverrides : undefined,
          customIgnoreRules:
            parsedConfig.status === 'ready' ? parsedConfig.customIgnoreRules || [] : [],
          customWhitelistRules:
            parsedConfig.status === 'ready' ? parsedConfig.customWhitelistRules || [] : [],
          configuredAt: Date.now()
        }

        if (window.electronAPI?.updateWorkspaceConfig) {
          const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, updatedConfig)
          if (res.success) {
            onConfigSaved?.()
          } else {
            toast.error(res.error || t('保存失败'))
          }
        }
      } catch (err: any) {
        console.error('[ContentExtractionTab] 自动保存微调策略异常:', err)
      } finally {
        setIsSaving(false)
      }
    },
    [workspace.id, currentIntent, baseDerived, parsedConfig, onConfigSaved]
  )

  // 切 Tab (isActive 变为 false) 或卸载时立即 flush 未落盘数据，杜绝并发覆盖竞态
  useEffect(() => {
    if (!isActive && pendingOverridesRef.current !== null) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      persistConfig(pendingOverridesRef.current)
      pendingOverridesRef.current = null
    }
  }, [isActive, persistConfig])

  // 组件卸载或弹窗关闭时：无条件立即写盘
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      if (pendingOverridesRef.current !== null) {
        persistConfig(pendingOverridesRef.current)
        pendingOverridesRef.current = null
      }
    }
  }, [persistConfig])

  // 修改单个参数 (用户修改即保存，500ms 防抖自动落盘)
  const handleParamChange = <K extends keyof TechnicalEngineParameters>(
    key: K,
    val: TechnicalEngineParameters[K]
  ) => {
    setOverrides(prev => {
      const next = { ...prev, [key]: val }
      if (val === baseDerived[key]) {
        delete next[key]
      }
      pendingOverridesRef.current = next

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(() => {
        if (pendingOverridesRef.current !== null) {
          const toSave = pendingOverridesRef.current
          pendingOverridesRef.current = null
          persistConfig(toSave)
        }
      }, 500)

      return next
    })
  }

  // 检查当前 Tab 是否存在个性化覆盖项 (仅针对 CONTENT_EXTRACTION_KEYS)
  const hasContentOverrides = useMemo(() => {
    return CONTENT_EXTRACTION_KEYS.some(k => overrides[k] !== undefined)
  }, [overrides])

  // 重置为当前意图预设基线 (仅剔除内容萃取管理的键，完整保留基础AI引擎等其他Tab的overrides)
  const handleResetToPreset = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    const next = { ...overrides }
    for (const k of CONTENT_EXTRACTION_KEYS) {
      delete next[k]
    }
    pendingOverridesRef.current = next
    setOverrides(next)
    persistConfig(next)
    toast.success(t('已恢复当前场景的文件内容萃取推荐参数'))
  }

  // 检测 LibreOffice 状态
  const checkLibreOfficeStatus = async () => {
    if (!(window as any).electronAPI?.utils?.detectLibreOffice) {
      setLibreOfficeInstalled(false)
      return
    }
    setCheckingLibreOffice(true)
    try {
      const result = await (window as any).electronAPI.utils.detectLibreOffice()
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
            {t('当前工作目录生效场景: {intent}。控制文本提取、OCR识别与Office封面生成。', {
              intent: getIntentDisplayName(currentIntent)
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

          {/* 恢复场景预设按钮 (仅在存在本Tab微调项时展示) */}
          {hasContentOverrides && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleResetToPreset}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 h-8"
              title={t('清除所有微调项，恢复为场景推荐默认值')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('恢复场景推荐')}</span>
            </Button>
          )}
        </div>
      </div>

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
                  {t('正文(含OCR)提取大小上限')}
                </Label>
                <HelpTooltip
                  content={t(
                    '单个文本指标（文本/文档/OCR/HTML）的最大提取大小，超长内容会被自动截断，避免过多占用存储。'
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
              const ticks = [10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100, -1]
              const normalizedValue = currentMaxContentSizeKb === 0 ? -1 : currentMaxContentSizeKb
              const currentIndex =
                ticks.indexOf(normalizedValue) !== -1 ? ticks.indexOf(normalizedValue) : 2

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
                <HelpTooltip content={t('控制 PDF 文档提取前多少页的内容进行文字与向量索引。')} />
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
                    {t('开启 Office 文档封面截图')}
                  </Label>
                  <HelpTooltip
                    content={t(
                      '支持 Office 文档首页导出为封面缩略图，但会增加 Office 分析耗时，PDF不受影响。需要安装 LibreOffice。'
                    )}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {currentEnableOfficeCover
                    ? t('开启：调用 LibreOffice 转首页为缩略图封面')
                    : t('关闭：跳过 Office 封面图提取')}
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
                      {t('依赖环境：LibreOffice')}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('支持 Office 文件整页转换与封面图提取')}，
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
                              : t('展开 Windows 安装与 PATH 配置教程 💡')}
                          </button>
                          {showLibreOfficeHelp && (
                            <div className="mt-2 p-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-700 dark:text-amber-300 space-y-1">
                              <p className="font-semibold">{t('如何配置：')}</p>
                              <ul className="ml-4 list-disc space-y-0.5">
                                <li>
                                  {t('请先将 LibreOffice 的安装路径添加进系统的 PATH 环境变量')}
                                </li>
                                <li>{t('默认位置：')}C:\Program Files\LibreOffice\program</li>
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
                      onClick={checkLibreOfficeStatus}
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
            <span>{t('OCR 文字识别与处理')}</span>
          </div>

          {/* 开启图片 OCR 识别 */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-muted/20 border border-border/60">
            <div className="space-y-1 pr-4">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="image-ocr-switch" className="text-sm font-medium">
                  {t('开启图片 OCR 智能识别')}
                </Label>
                <HelpTooltip content={t('毫秒级智能感知图片中是否有文本，有则进行 OCR 识别')} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('自动识别并提取图片中的文本内容，支持全文检索与视觉标签')}
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
                  {t('文档内嵌 OCR 识别数量上限')}
                </Label>
                <HelpTooltip
                  content={t(
                    'Office 文档内嵌图片数量 / PDF 扫描版识别页数上限。0 表示跳过文档 OCR。'
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
              <Label className="text-sm font-medium">{t('OCR 识别精度等级')}</Label>
              <HelpTooltip
                content={t(
                  '选择 OCR 文字识别精度等级。极速 OCR 适合大部分场景；高精度 OCR 识别更准但耗时稍长。'
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
                    {t('极速 OCR (tiny)')}
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
                    {t('高精度 OCR (small)')}
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
