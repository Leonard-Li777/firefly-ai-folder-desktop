import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Edit3,
  ExternalLink,
  FileX,
  Filter,
  FolderX,
  Plus,
  Save,
  Trash2,
  X,
  HelpCircle,
  ChevronDown,
  ChevronUp
} from 'lucide-react'
import React, { useEffect, useMemo, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { IIgnoreRule } from '@firefly/types/settings-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SUPPORTED_LANGUAGES } from '@firefly/shared'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { openExternalLink } from '../../lib/external-link'
import { useSettingsStore } from '../../stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'
import { MaterialIcon } from '../common/MaterialIcon'

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
 * 分析设置组件
 */
export const AnalysisSettings: React.FC = () => {
  const {
    config,
    updateConfig,
    getConfigValue,
    updateConfigValue,
    ignoreRules,
    addIgnoreRule,
    updateIgnoreRule,
    removeIgnoreRule,
    loadIgnoreRules
  } = useSettingsStore()

  const [editingRule, setEditingRule] = useState<string | null>(null)
  const [newRule, setNewRule] = useState<Partial<IIgnoreRule>>({
    type: 'file',
    value: '',
    isSystem: false,
    isActive: true
  })
  const [showAddRule, setShowAddRule] = useState(false)
  const [libreOfficeInstalled, setLibreOfficeInstalled] = useState<boolean | null>(null)
  const [libreOfficeVersion, setLibreOfficeVersion] = useState<string | undefined>(undefined)
  const [checkingLibreOffice, setCheckingLibreOffice] = useState(false)
  const [ffmpegInstalled, setFfmpegInstalled] = useState<boolean | null>(null)
  const [ffmpegPath, setFfmpegPath] = useState<string | undefined>(undefined)
  const [ffmpegDownloading, setFfmpegDownloading] = useState<boolean>(false)
  const [checkingFfmpeg, setCheckingFfmpeg] = useState(false)
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)

  const [unitPrompt, setUnitPrompt] = useState(
    getConfigValue<string>('UNIT_RECOGNITION_PROMPT') || ''
  )
  const [qualityPrompt, setQualityPrompt] = useState(
    getConfigValue<string>('QUALITY_SCORE_PROMPT') || ''
  )
  const [tagPrompt, setTagPrompt] = useState(getConfigValue<string>('TAG_GENERATION_PROMPT') || '')
  const [localAudioDuration, setLocalAudioDuration] = useState<number>(
    getConfigValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
  )
  const [localExtractPages, setLocalExtractPages] = useState<number>(
    getConfigValue<number>('EXTRACT_PAGES') ?? 2
  )
  const [localMaxContentSizeKb, setLocalMaxContentSizeKb] = useState<number>(
    getConfigValue<number>('MAX_CONTENT_SIZE_KB') ?? 30
  )
  const [localEnableOfficeCover, setLocalEnableOfficeCover] = useState<boolean>(
    getConfigValue<boolean>('ENABLE_OFFICE_COVER') ?? false
  )
  const [localMaxDocOcrItems, setLocalMaxDocOcrItems] = useState<number>(
    getConfigValue<number>('MAX_DOCUMENT_OCR_ITEMS') ?? 0
  )
  const [localEnableImageOcr, setLocalEnableImageOcr] = useState<boolean>(
    getConfigValue<boolean>('ENABLE_IMAGE_OCR') ?? true
  )
  const [showAdvancedPrompts, setShowAdvancedPrompts] = useState(false)
  const [showLibreOfficeHelp, setShowLibreOfficeHelp] = useState(false)

  const useDebouncedPromptUpdater = (
    promptValue: string,
    configKey: 'UNIT_RECOGNITION_PROMPT' | 'QUALITY_SCORE_PROMPT' | 'TAG_GENERATION_PROMPT'
  ) => {
    useEffect(() => {
      const handler = setTimeout(() => {
        if (promptValue !== (getConfigValue<string>(configKey) || '')) {
          updateConfigValue(configKey, promptValue)
          // 捕获自定义提示词更新
          captureEvent('更新自定义提示词', {
            prompt_type: configKey,
            content: promptValue,
            content_length: promptValue.length
          })
        }
      }, 500)

      return () => {
        clearTimeout(handler)
      }
    }, [promptValue, configKey, getConfigValue, updateConfigValue])
  }

  // 为每个提示词设置独立的防抖更新
  useDebouncedPromptUpdater(unitPrompt, 'UNIT_RECOGNITION_PROMPT')
  useDebouncedPromptUpdater(qualityPrompt, 'QUALITY_SCORE_PROMPT')
  useDebouncedPromptUpdater(tagPrompt, 'TAG_GENERATION_PROMPT')

  /**
   * 音频分析截取时长防抖同步
   */
  useEffect(() => {
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
      if (localAudioDuration !== currentConfigValue) {
        updateConfigValue('AUDIO_ANALYSIS_DURATION', localAudioDuration)
        captureEvent('更新音频分析截取时长', {
          duration: localAudioDuration
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localAudioDuration])

  /**
   * PDF提取页数防抖同步
   */
  useEffect(() => {
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('EXTRACT_PAGES') ?? 2
      if (localExtractPages !== currentConfigValue) {
        updateConfigValue('EXTRACT_PAGES', localExtractPages)
        captureEvent('更新PDF提取页数', {
          pages: localExtractPages
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localExtractPages])

  /**
   * 内容提取大小上限防抖同步（0 表示不限制）
   */
  useEffect(() => {
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('MAX_CONTENT_SIZE_KB') ?? 30
      if (localMaxContentSizeKb !== currentConfigValue) {
        updateConfigValue('MAX_CONTENT_SIZE_KB', localMaxContentSizeKb)
        captureEvent('更新内容提取大小上限', {
          sizeKb: localMaxContentSizeKb
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localMaxContentSizeKb])

  /**
   * 文档 OCR 识别数量防抖同步（0 表示不识别，-1 表示不限）
   */
  useEffect(() => {
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('MAX_DOCUMENT_OCR_ITEMS') ?? 0
      if (localMaxDocOcrItems !== currentConfigValue) {
        updateConfigValue('MAX_DOCUMENT_OCR_ITEMS', localMaxDocOcrItems)
        captureEvent('更新文档OCR识别数量上限', {
          items: localMaxDocOcrItems
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localMaxDocOcrItems])

  /**
   * Office 封面截图开关同步
   */
  useEffect(() => {
    const currentConfigValue = getConfigValue<boolean>('ENABLE_OFFICE_COVER') ?? false
    if (localEnableOfficeCover !== currentConfigValue) {
      updateConfigValue('ENABLE_OFFICE_COVER', localEnableOfficeCover)
      captureEvent('切换Office封面截图', { enabled: localEnableOfficeCover })
    }
  }, [localEnableOfficeCover])

  /**
   * 图片OCR开关同步
   */
  useEffect(() => {
    const currentConfigValue = getConfigValue<boolean>('ENABLE_IMAGE_OCR') ?? false
    if (localEnableImageOcr !== currentConfigValue) {
      updateConfigValue('ENABLE_IMAGE_OCR', localEnableImageOcr)
      captureEvent('切换图片OCR识别', { enabled: localEnableImageOcr })
    }
  }, [localEnableImageOcr])

  /**
   * 监听外部配置变更（如重置或同步），更新本地显示
   */
  useEffect(() => {
    const externalValue = getConfigValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
    // 只有当外部值真的变化了，且不是当前用户正在输入的值时，才同步
    if (externalValue !== localAudioDuration) {
      setLocalAudioDuration(externalValue)
    }
  }, [config.audioAnalysisDuration])

  /**
   * 检测环境状态并加载规则
   */
  useEffect(() => {
    checkLibreOfficeStatus()
    checkFfmpegStatus()
    loadIgnoreRules()
  }, [])

  const checkLibreOfficeStatus = async () => {
    setCheckingLibreOffice(true)
    try {
      const result = await (window as any).electronAPI.utils.detectLibreOffice()
      setLibreOfficeInstalled(result.installed)
      setLibreOfficeVersion(result.version)
    } catch (error) {
      console.error('检测LibreOffice失败:', error)
      setLibreOfficeInstalled(false)
    } finally {
      setCheckingLibreOffice(false)
    }
  }

  const checkFfmpegStatus = async () => {
    setCheckingFfmpeg(true)
    try {
      const result = await (window as any).electronAPI.utils.detectFfmpeg()
      setFfmpegInstalled(result.installed)
      setFfmpegPath(result.path)
      // 保存下载状态以便在UI中使用
      if (result.downloading !== undefined) {
        setFfmpegDownloading(result.downloading)
      }
    } catch (error) {
      console.error('检测FFmpeg失败:', error)
      setFfmpegInstalled(false)
      setFfmpegDownloading(false)
    } finally {
      setCheckingFfmpeg(false)
    }
  }

  const handleOpenLibreOfficeDownload = async () => {
    await openExternalLink('https://www.libreoffice.org/download/download-libreoffice/')
  }

  const handleOpenFfmpegDownload = async () => {
    await openExternalLink('https://ffbinaries.com/downloads')
  }

  /**
   * 默认提示词模板
   */
  const defaultPrompts = useMemo(
    () => ({
      unitRecognition: t(
        '示例：作为整体单元的文件集合特征为：文件命名带数字后缀的文件集合，例如：1.txt, 2.txt, 3.txt'
      ),
      qualityScore: t(
        '示例：为喜剧故事多加分；为技术指标降低权重; 多模态内容描述着重人物关系, lrc翻译为{activeLanguage}',
        {
          activeLanguage: SUPPORTED_LANGUAGES.find(lang => lang.code === activeLanguage)?.nativeName
        }
      ),
      tagGeneration: t(
        '示例：智能文件名需要翻译成{activeLanguage}，格式：作者_内容描述。例如：乔治·马丁_冰与火之歌.pdf。标签最多生成20个，且每个不要超过2个字，至少从文件名提取一个标签，其它必须从此集合里提取：[开心,痛苦,愤恨,...]',
        {
          activeLanguage: SUPPORTED_LANGUAGES.find(lang => lang.code === activeLanguage)?.nativeName
        }
      )
    }),
    [activeLanguage]
  )

  /**
   * 处理添加忽略规则
   */
  const handleAddRule = () => {
    if (!newRule.value?.trim()) return

    addIgnoreRule({
      type: newRule.type!,
      value: newRule.value.trim(),
      isSystem: false,
      isActive: true
    })

    setNewRule({
      type: 'file',
      value: '',
      isSystem: false,
      isActive: true
    })
    setShowAddRule(false)
  }

  /**
   * 处理编辑忽略规则
   */
  const handleEditRule = (ruleId: string) => {
    setEditingRule(ruleId)
  }

  /**
   * 处理保存编辑的规则
   */
  const handleSaveRule = (ruleId: string, updates: Partial<IIgnoreRule>) => {
    updateIgnoreRule(ruleId, updates)
    setEditingRule(null)
  }

  /**
   * 处理取消编辑
   */
  const handleCancelEdit = () => {
    setEditingRule(null)
  }

  /**
   * 获取规则类型图标
   */
  const getRuleTypeIcon = (type: IIgnoreRule['type']) => {
    switch (type) {
      case 'file':
        return <FileX className="h-4 w-4" />
      case 'directory':
        return <FolderX className="h-4 w-4" />
      case 'extension':
        return <Filter className="h-4 w-4" />
      case 'regex':
        return <Filter className="h-4 w-4" />
      case 'wildcard':
        return <Filter className="h-4 w-4" />
      default:
        return <FileX className="h-4 w-4" />
    }
  }

  /**
   * 获取规则类型标签
   */
  const getRuleTypeLabel = (type: IIgnoreRule['type']) => {
    const labels = {
      file: t('文件'),
      directory: t('目录'),
      extension: t('扩展名'),
      regex: t('正则表达式'),
      wildcard: t('通配符'),
      pattern: t('模式') // 保持兼容
    }
    return labels[type] || type
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('分析设置')}</h3>
        <p className="text-sm text-muted-foreground">{t('配置AI分析行为、提示词和忽略规则')}</p>
      </div>

      {/* 分析模式与提取配置（影响分析数据速度和内容提取） */}
      <Card className="p-4">
        <div className="space-y-5">
          {/* 切换文件分析模式 */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <Label className="text-base font-medium">{t('选择分析模式')}</Label>
              <HelpTooltip
                content={t(
                  '根据需求选择不同模式，全面分析耗时最长但精度最高；简单分类最快但不支持AI生成描述。'
                )}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* 简单分类 */}
              <div
                onClick={() => {
                  updateConfigValue('ANALYSIS_MODE', 'simple')
                  captureEvent('切换分析模式', { mode: 'simple' })
                }}
                className={`relative overflow-hidden flex flex-col p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                  (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'simple'
                    ? 'border-primary bg-primary/15 shadow-md ring-1 ring-primary/30'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
              >
                <div className="absolute top-0 right-0 text-[11px] font-bold bg-muted text-muted-foreground px-3 py-1 rounded-bl-md">
                  {t('极速')}
                </div>
                {/* 选中勾选标记 */}
                {(getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'simple' && (
                  <div className="absolute bottom-2 right-2 w-4.5 h-4.5 rounded-full bg-primary flex items-center justify-center">
                    <MaterialIcon icon="check" className="text-[11px] text-primary-foreground" />
                  </div>
                )}
                <div className="flex items-center justify-between pr-8">
                  <span
                    className={`font-semibold text-sm ${
                      (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'simple'
                        ? 'text-primary'
                        : ''
                    }`}
                  >
                    {t('简单分类')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {t('按文件类型分类，并行抽取缩略图、元数据及全量文档文本与 OCR(如开启)。')}
                </p>
              </div>

              {/* 快速命名 */}
              <div
                onClick={() => {
                  updateConfigValue('ANALYSIS_MODE', 'quick_name')
                  captureEvent('切换分析模式', { mode: 'quick_name' })
                }}
                className={`relative overflow-hidden flex flex-col p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                  (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'quick_name'
                    ? 'border-primary bg-primary/15 shadow-md ring-1 ring-primary/30'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
              >
                <div className="absolute top-0 right-0 text-[11px] font-bold bg-muted text-muted-foreground px-3 py-1 rounded-bl-md">
                  {t('默认')}
                </div>
                {/* 选中勾选标记 */}
                {(getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'quick_name' && (
                  <div className="absolute bottom-2 right-2 w-4.5 h-4.5 rounded-full bg-primary flex items-center justify-center">
                    <MaterialIcon icon="check" className="text-[11px] text-primary-foreground" />
                  </div>
                )}
                <div className="flex items-center justify-between pr-8">
                  <span
                    className={`font-semibold text-sm ${
                      (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'quick_name'
                        ? 'text-primary'
                        : ''
                    }`}
                  >
                    {t('快速命名')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {t(
                    '【简单分类】 + 快速AI分析，直接生成智能文件名、维度标签和简短描述，速度更快。'
                  )}
                </p>
              </div>

              {/* 全面分析 */}
              <div
                onClick={() => {
                  updateConfigValue('ANALYSIS_MODE', 'full')
                  captureEvent('切换分析模式', { mode: 'full' })
                }}
                className={`relative overflow-hidden flex flex-col p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                  (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'full'
                    ? 'border-primary bg-primary/15 shadow-md ring-1 ring-primary/30'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
              >
                <div className="absolute top-0 right-0 text-[11px] font-bold bg-green-500 text-white px-3 py-1 rounded-bl-md shadow-sm dark:bg-green-600">
                  {t('推荐')}
                </div>
                {/* 选中勾选标记 */}
                {(getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'full' && (
                  <div className="absolute bottom-2 right-2 w-4.5 h-4.5 rounded-full bg-primary flex items-center justify-center">
                    <MaterialIcon icon="check" className="text-[11px] text-primary-foreground" />
                  </div>
                )}
                <div className="flex items-center justify-between pr-8">
                  <span
                    className={`font-semibold text-sm ${
                      (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name') === 'full'
                        ? 'text-primary'
                        : ''
                    }`}
                  >
                    {t('全面分析')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {t('【快速命名】 + 全面AI分析，包含质量评分与详细图片内容描述、lrc（歌词）等。')}
                </p>
              </div>
            </div>
          </div>

          {/* 性能与提取设置网格 */}
          <div className="border-t pt-4 space-y-4">
            {/* 分组1：文档与内容提取 */}
            <div className="p-4 rounded-lg border bg-muted/10 space-y-4">
              <div className="flex items-center gap-2 border-b border-border/50 pb-2.5">
                <MaterialIcon icon="article" className="text-lg text-primary h-4 w-4" />
                <Label className="text-sm font-semibold">{t('文档与内容提取')}</Label>
              </div>

              {/* 内容提取大小上限（刻度条带刻度线与每个刻度的数值标注，终点为特殊值 -1 "不限"） */}
              <div className="p-3.5 rounded-lg border bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="max-content-size" className="text-sm font-medium">
                      {t('内容(含OCR）提取大小上限')}
                    </Label>
                    <HelpTooltip
                      content={t(
                        '单个文本指标（文本/文档/OCR/HTML）的最大提取大小，超长内容会被自动截断。否则过多占用存储空间，影响性能。'
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary">
                      {localMaxContentSizeKb === -1 || localMaxContentSizeKb === 0
                        ? t('不限')
                        : `${localMaxContentSizeKb} KB`}
                    </span>
                    {localMaxContentSizeKb !== -1 && localMaxContentSizeKb !== 0 && (
                      <span className="text-xs text-muted-foreground">
                        {(() => {
                          // 1 KB UTF-8 UTF-8 中文约 330 字，英文约 165 单词
                          const chineseChars = localMaxContentSizeKb * 333
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
                  const ticks = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, -1]
                  // 兼容旧配置 0 映射为 -1 (不限)
                  const normalizedValue = localMaxContentSizeKb === 0 ? -1 : localMaxContentSizeKb
                  const currentIndex =
                    ticks.indexOf(normalizedValue) !== -1 ? ticks.indexOf(normalizedValue) : 2 // 默认 30KB (index 2)

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
                          const selectedValue = ticks[idx]
                          setLocalMaxContentSizeKb(selectedValue)
                        }}
                        className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-secondary accent-primary"
                      />
                      {/* 刻度线与刻度值展示 */}
                      <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-1 select-none">
                        {ticks.map((tick, index) => {
                          const isActive = index === currentIndex
                          const isUnlimited = tick === -1
                          return (
                            <button
                              key={tick}
                              type="button"
                              onClick={() => setLocalMaxContentSizeKb(tick)}
                              className={`flex flex-col items-center gap-1 transition-colors hover:text-foreground ${
                                isActive ? 'text-primary font-bold scale-110' : ''
                              }`}
                            >
                              <span
                                className={`w-0.5 h-1.5 rounded-full ${
                                  isActive ? 'bg-primary h-2.5' : 'bg-muted-foreground/30'
                                }`}
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

              {/* 开启Office文档封面截图与 LibreOffice 插件联动 */}
              <div className="p-3 rounded-lg border bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="office-cover-switch" className="text-sm font-medium">
                        {t('开启Office文档封面截图')}
                      </Label>
                      <HelpTooltip
                        content={t(
                          '支持Office文档首页导出为封面缩略图，但会大大增加Office内容提取耗时，PDF不受影响。需要安装LibreOffice。'
                        )}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {localEnableOfficeCover
                        ? t('开启，调用LibreOffice转首页为缩略图封面（非常耗时）')
                        : t('关闭，跳过Office封面图提取')}
                    </p>
                  </div>
                  <Switch
                    id="office-cover-switch"
                    checked={localEnableOfficeCover}
                    onCheckedChange={setLocalEnableOfficeCover}
                  />
                </div>

                {/* 联动：开启 Office 封面截图后，显示插件安装：LibreOffice */}
                {localEnableOfficeCover && (
                  <div className="pt-3 border-t border-border/50">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 pr-4">
                        <div className="flex items-center gap-1">
                          <Label className="text-sm font-medium flex items-center gap-2">
                            {t('插件安装：LibreOffice')}
                          </Label>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t(
                            '支持Office文件整页转换与封面图提取'
                          )}
                          ，
                          <span className="text-xs text-amber-600 font-medium">
                            但会大大增加Office内容提取耗时，PDF不受影响
                          </span>
                        </p>
                        {/* Windows 配置提示折叠部分 */}
                        {!checkingLibreOffice &&
                          libreOfficeInstalled === false &&
                          navigator.platform.includes('Win') && (
                            <div className="mt-2">
                              <button
                                onClick={() => setShowLibreOfficeHelp(!showLibreOfficeHelp)}
                                className="text-xs text-amber-600 hover:text-amber-700 underline font-medium flex items-center gap-1"
                              >
                                {showLibreOfficeHelp
                                  ? t('收起 Windows 安装教程 💡')
                                  : t('展开 Windows 安装与 PATH 配置教程 💡')}
                              </button>
                              <div
                                className={`transition-all duration-300 overflow-hidden ${
                                  showLibreOfficeHelp
                                    ? 'max-h-40 opacity-100 mt-2'
                                    : 'max-h-0 opacity-0 pointer-events-none'
                                }`}
                              >
                                <div className="p-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-700 dark:text-amber-300 space-y-1">
                                  <p className="font-semibold">{t('如何配置：')}</p>
                                  <ul className="ml-4 list-disc space-y-0.5">
                                    <li>
                                      {t('请先将 LibreOffice 的安装路径添加进系统的 PATH 环境变量')}
                                    </li>
                                    <li>{t('默认位置：')}C:\Program Files\LibreOffice\program</li>
                                    <li>{t('配置后重启应用再次点击重新检测。')}</li>
                                  </ul>
                                </div>
                              </div>
                            </div>
                          )}

                        {!checkingLibreOffice && libreOfficeInstalled === false && (
                          <Button
                            size="sm"
                            className="mt-3.5"
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
                            <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                              <CheckCircle2 className="h-4 w-4" />
                              {t('已安装')}
                              {libreOfficeVersion && <span>（{libreOfficeVersion}）</span>}
                            </span>
                          )}
                          {!checkingLibreOffice && libreOfficeInstalled === false && (
                            <span className="flex items-center gap-1 text-xs text-orange-600 font-medium">
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

              {/* 音频分析截取时长（仅AI分析模式整行呈现） */}
              {(getConfigValue<string>('ANALYSIS_MODE') ?? 'full') === 'full' && (
                <div className="flex items-center justify-between p-3 rounded-lg border bg-card">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="audio-duration" className="text-sm font-medium">
                        {t('音频分析截取时长')}
                      </Label>
                      <HelpTooltip
                        content={t('最大值100秒，设置过大会让分析变慢或超时，仅部分大模型支持')}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('仅 gemma-4 系列模型支持音频分析。超大会增加耗时甚至超时失败')}
                    </p>
                  </div>
                  <div className="w-24">
                    <Input
                      id="audio-duration"
                      type="number"
                      min={1}
                      max={100}
                      value={localAudioDuration}
                      onChange={e => {
                        const value = parseInt(e.target.value) || 0
                        setLocalAudioDuration(value)
                      }}
                      className="h-8 text-xs text-right"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 分组2：OCR 识别与处理 */}
          <div className="p-4 rounded-lg border bg-muted/10 space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2.5">
              <MaterialIcon icon="article" className="text-lg text-primary h-4 w-4" />
              <Label className="text-sm font-semibold">{t('OCR 识别与处理')}</Label>
            </div>

            <div className="space-y-4">
              {/* 文档 OCR 识别数量上限（总是显示，0 表示不识别，-1 表示不限） */}
              <div className="p-3.5 rounded-lg border bg-card space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor="max-doc-ocr-items" className="text-sm font-medium">
                      {t('文档OCR识别数量')}
                    </Label>
                    <HelpTooltip
                      content={t(
                        '文档OCR识别数量上限（Office文档内嵌图片数量 / PDF文档页数）'
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-primary/10 text-primary">
                      {localMaxDocOcrItems === -1
                        ? t('不限')
                        : localMaxDocOcrItems === 0
                        ? t('关闭 (0)')
                        : `${localMaxDocOcrItems} ${t('项/页')}`}
                    </span>
                  </div>
                </div>

                {(() => {
                  // 0 到 30 每刻度递增 1，最后是 -1 (不限)
                  const ticks = Array.from({ length: 31 }, (_, i) => i).concat([-1])
                  const currentIndex =
                    ticks.indexOf(localMaxDocOcrItems) !== -1
                      ? ticks.indexOf(localMaxDocOcrItems)
                      : 0 // 默认 0 (index 0)

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
                          const selectedValue = ticks[idx]
                          setLocalMaxDocOcrItems(selectedValue)
                        }}
                        className="w-full h-2 rounded-lg appearance-none cursor-pointer bg-secondary accent-primary"
                      />
                      {/* 刻度线与主要刻度值展示 (0, 5, 10, 15, 20, 25, 30, 不限)
                          注意：必须渲染与滑块索引一一对应的全部占位，否则 justify-between 均分会导致
                          刻度标签位置与滑块实际索引位置（步进 1）错位 */}
                      <div className="flex justify-between items-center text-[11px] text-muted-foreground pt-1 select-none">
                        {ticks.map((tick, idx) => {
                          const isMajorTick = [0, 5, 10, 15, 20, 25, 30, -1].includes(tick)
                          const isActive = idx === currentIndex
                          const isUnlimited = tick === -1
                          // 非主要刻度：渲染空占位保持 justify-between 与滑块索引对齐
                          if (!isMajorTick) {
                            return <span key={tick} className="flex-1" />
                          }
                          return (
                            <button
                              key={tick}
                              type="button"
                              onClick={() => setLocalMaxDocOcrItems(tick)}
                              className={`flex flex-col items-center gap-1 transition-colors hover:text-foreground ${
                                isActive ? 'text-primary font-bold scale-110' : ''
                              }`}
                            >
                              <span
                                className={`w-0.5 h-1.5 rounded-full ${
                                  isActive ? 'bg-primary h-2.5' : 'bg-muted-foreground/30'
                                }`}
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

              {/* 图片 OCR 开关 */}
              <div className="p-3 rounded-lg border bg-card">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Label htmlFor="image-ocr-switch" className="text-sm font-medium">
                        {t('启用图片OCR文字识别')}
                      </Label>
                      <HelpTooltip
                        content={t(
                          '开启后会对PNG、JPG、WebP、BMP、TIFF等图片文件进行OCR文字识别'
                        )}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">{t('开启会让分析耗时增加1~4秒')}</p>
                  </div>
                  <Switch
                    id="image-ocr-switch"
                    checked={localEnableImageOcr}
                    onCheckedChange={setLocalEnableImageOcr}
                  />
                </div>
              </div>
            </div>

            {/* 联动：只有当文档 OCR 开启 (数量 != 0) 或图片 OCR 开启时，才显示 OCR 识别精度 */}
            {(localMaxDocOcrItems !== 0 || localEnableImageOcr) && (
              <div className="pt-2">
                <div className="flex items-center gap-1.5 mb-2.5">
                  <Label className="text-sm font-medium">{t('OCR识别精度')}</Label>
                  <HelpTooltip
                    content={t(
                      '选择OCR文字识别的精度等级。极速OCR适合大部分场景；高精度OCR识别更准确但耗时稍长。'
                    )}
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* 极速OCR */}
                  <div
                    onClick={() => {
                      updateConfigValue('OCR_MODEL_SIZE', 'tiny')
                      captureEvent('切换OCR精度', { size: 'tiny' })
                    }}
                    className={`relative overflow-hidden flex flex-col p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                      (getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'tiny'
                        ? 'border-primary bg-primary/15 shadow-md ring-1 ring-primary/30'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
                  >
                    <div className="absolute top-0 right-0 text-[11px] font-bold bg-green-500 text-white px-3 py-1 rounded-bl-md shadow-sm dark:bg-green-600">
                      {t('推荐')}
                    </div>
                    {(getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'tiny' && (
                      <div className="absolute bottom-2 right-2 w-4.5 h-4.5 rounded-full bg-primary flex items-center justify-center">
                        <MaterialIcon
                          icon="check"
                          className="text-[11px] text-primary-foreground"
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-between pr-8">
                      <span
                        className={`font-semibold text-sm ${
                          (getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'tiny'
                            ? 'text-primary'
                            : ''
                        }`}
                      >
                        {t('极速OCR')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                      {t('单图1~2秒内完成，适合大部分场景')}
                    </p>
                  </div>

                  {/* 高精度OCR */}
                  <div
                    onClick={() => {
                      updateConfigValue('OCR_MODEL_SIZE', 'small')
                      captureEvent('切换OCR精度', { size: 'small' })
                    }}
                    className={`relative overflow-hidden flex flex-col p-3.5 rounded-lg border-2 cursor-pointer transition-all ${
                      (getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'small'
                        ? 'border-primary bg-primary/15 shadow-md ring-1 ring-primary/30'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
                  >
                    {(getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'small' && (
                      <div className="absolute bottom-2 right-2 w-4.5 h-4.5 rounded-full bg-primary flex items-center justify-center">
                        <MaterialIcon
                          icon="check"
                          className="text-[11px] text-primary-foreground"
                        />
                      </div>
                    )}
                    <div className="flex items-center justify-between pr-8">
                      <span
                        className={`font-semibold text-sm ${
                          (getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'small'
                            ? 'text-primary'
                            : ''
                        }`}
                      >
                        {t('高精度OCR')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                      {t('单图2~4秒内完成，提高识别精度')}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 复用数据开关（始终显示，占满整行，位于其它项之后、插件安装之前） */}
          <div className="border-t pt-4">
            <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/10">
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Label htmlFor="reuse-basic-data-switch" className="text-sm font-medium">
                    {t('重新分析时复用数据')}
                  </Label>
                  <HelpTooltip
                    content={t(
                      '如果文件有更新，请关闭此项，否则任意文件基础信息已存在则跳过该项信息获取，基础信息包括：文件类型、缩略图、元数据、文件内容'
                    )}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('分析提速，不会重新获取简单分类阶段的信息')}
                </p>
              </div>
              <Switch
                id="reuse-basic-data-switch"
                checked={getConfigValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ?? true}
                onCheckedChange={checked => {
                  updateConfigValue('REUSE_BASIC_ANALYSIS_DATA', checked)
                  captureEvent('切换复用基础分析数据', { enabled: checked })
                }}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* 最小单元识别开关 */}
      <Card className="p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-1">
                <Label htmlFor="unit-recognition-switch" className="text-base font-medium">
                  {t('启用最小单元识别')}
                </Label>
                <HelpTooltip
                  content={t(
                    '以下类别强制识别，无需开启：系统目录、软件安装目录、工程项目、游戏包、AI数据集/模型、缓存与LFS、虚拟环境'
                  )}
                />
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {t('启用后，识别为最小单元的目录，跳过文件逐一分析')}
              </p>
            </div>
            <Switch
              id="unit-recognition-switch"
              checked={getConfigValue<boolean>('ENABLE_UNIT_RECOGNITION') ?? false}
              onCheckedChange={checked => {
                updateConfigValue('ENABLE_UNIT_RECOGNITION', checked)
                captureEvent('切换最小单元识别', { enabled: checked })
              }}
            />
          </div>
          {/* 最小单元详细说明 */}
          <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3 space-y-2">
            <ul className="list-disc list-inside space-y-1">
              <li>{t('系列文件：连续编号的文档或图片（如 01.jpg, 02.jpg, 03.jpg）')}</li>
              <li>{t('音频专辑：同一专辑的音轨文件集合（如 .flac, .mp3）')}</li>
              <li>{t('设计工程：含工程文件及资源目录的设计项目（如 .prproj、.aep、.blend）')}</li>
            </ul>
            <p className="text-xs text-orange-600">
              {t('提示：关闭后所有文件将独立分析，适用于需对每个文件单独生成描述和标签的场景')}
            </p>
          </div>
        </div>
      </Card>

      {/* 提示词设置 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div
            onClick={() => setShowAdvancedPrompts(!showAdvancedPrompts)}
            className="flex items-center justify-between cursor-pointer select-none"
          >
            <div>
              <Label className="text-base font-medium flex items-center gap-1 cursor-pointer">
                {t('高级 AI 提示词自定义')}
              </Label>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t('自定义提示词以微调模型对分类命名和质量评分，推荐云端模型遵循较好')}
              </p>
              <p className="text-xs text-orange-600 font-medium mt-1">
                {t('若因字数过多导致AI分析失败，请自行减少字数。对于本地小模型，建议100字以内。')}
              </p>
            </div>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              {showAdvancedPrompts ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>

          <div
            className={`transition-all duration-300 overflow-hidden px-1 ${
              showAdvancedPrompts
                ? 'max-h-[1200px] opacity-100 border-t pt-4 space-y-4'
                : 'max-h-0 opacity-0 pointer-events-none'
            }`}
          >
            {/* 最小单元识别提示词 */}
            <div className="space-y-2">
              <Label htmlFor="unit-prompt">{t('最小单元识别提示词（需启用最小单元识别）')}</Label>
              <Textarea
                id="unit-prompt"
                placeholder={defaultPrompts.unitRecognition}
                value={unitPrompt}
                onChange={e => {
                  const value = e.target.value
                  if (value.length <= 1000) {
                    setUnitPrompt(value)
                  }
                }}
                rows={4}
                className="font-mono text-sm mt-2"
                maxLength={1000}
              />
              <div className="flex items-center justify-end">
                <span
                  className={`text-xs ${
                    (unitPrompt?.length || 0) >= 1000 ? 'text-red-500' : 'text-muted-foreground'
                  }`}
                >
                  {unitPrompt?.length || 0}
                  {t('/1000 字符')}
                </span>
              </div>
            </div>

            {/* 质量评分提示词 */}
            <div className="space-y-2">
              <Label htmlFor="quality-prompt">{t('质量评分提示词')}</Label>
              <Textarea
                id="quality-prompt"
                placeholder={defaultPrompts.qualityScore}
                value={qualityPrompt}
                onChange={e => {
                  const value = e.target.value
                  if (value.length <= 1000) {
                    setQualityPrompt(value)
                  }
                }}
                rows={4}
                className="font-mono text-sm mt-2"
                maxLength={1000}
              />
              <div className="flex items-center justify-end">
                <span
                  className={`text-xs ${
                    (qualityPrompt?.length || 0) >= 1000 ? 'text-red-500' : 'text-muted-foreground'
                  }`}
                >
                  {qualityPrompt?.length || 0}
                  {t('/1000 字符')}
                </span>
              </div>
            </div>

            {/* 标签生成提示词 */}
            <div className="space-y-2">
              <Label htmlFor="tag-prompt">{t('标签、智能文件名生成提示词')}</Label>
              <Textarea
                id="tag-prompt"
                placeholder={defaultPrompts.tagGeneration}
                value={tagPrompt}
                onChange={e => {
                  const value = e.target.value
                  if (value.length <= 1000) {
                    setTagPrompt(value)
                  }
                }}
                rows={4}
                className="font-mono text-sm mt-2"
                maxLength={1000}
              />
              <div className="flex items-center justify-end">
                <span
                  className={`text-xs ${
                    (tagPrompt?.length || 0) >= 1000 ? 'text-red-500' : 'text-muted-foreground'
                  }`}
                >
                  {tagPrompt?.length || 0}
                  {t('/1000 字符')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* AI分析忽略规则 */}
      <Card className="p-4">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base font-medium">{t('AI分析忽略规则')}</Label>
              <p className="text-sm text-muted-foreground mt-1">
                {t('设置不需要进行AI分析的文件和目录')}
              </p>
            </div>
            <Button size="sm" onClick={() => setShowAddRule(true)}>
              <Plus className="h-4 w-4 mr-1" />
              {t('添加规则')}
            </Button>
          </div>

          {/* 添加新规则 */}
          {showAddRule && (
            <div className="p-3 border rounded-lg bg-muted/30">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="new-rule-type">{t('类型')}</Label>
                    <Select
                      value={newRule.type}
                      onValueChange={value =>
                        setNewRule({ ...newRule, type: value as IIgnoreRule['type'] })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="file">{t('文件')}</SelectItem>
                        <SelectItem value="directory">{t('目录')}</SelectItem>
                        <SelectItem value="extension">{t('扩展名')}</SelectItem>
                        <SelectItem value="wildcard">{t('通配符')}</SelectItem>
                        <SelectItem value="regex">{t('正则表达式')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="new-rule-value">{t('值')}</Label>
                    <Input
                      id="new-rule-value"
                      placeholder={t('输入匹配值...')}
                      value={newRule.value}
                      onChange={e => setNewRule({ ...newRule, value: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="new-rule-desc">{t('描述（可选）')}</Label>
                  <Input
                    id="new-rule-desc"
                    placeholder={t('输入规则描述...')}
                    value={newRule.description}
                    onChange={e => setNewRule({ ...newRule, description: e.target.value })}
                  />
                </div>
                <div className="flex items-center space-x-2 pt-1">
                  <input
                    type="checkbox"
                    id="new-rule-czkawka"
                    checked={newRule.isCzkawka ?? false}
                    onChange={e => setNewRule({ ...newRule, isCzkawka: e.target.checked })}
                    className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
                  />
                  <Label htmlFor="new-rule-czkawka" className="text-xs cursor-pointer select-none">
                    {t('清理与查重时原生排除保护')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleAddRule} disabled={!newRule.value?.trim()}>
                    <Save className="h-4 w-4 mr-1" />
                    {t('保存')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowAddRule(false)}>
                    <X className="h-4 w-4 mr-1" />
                    {t('取消')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* 规则列表 */}
          <div className="space-y-2">
            {[...ignoreRules]
              .sort((a, b) => {
                // 系统规则排在最后 (isSystem 为 true 的排在后面)
                if (a.isSystem && !b.isSystem) return 1
                if (!a.isSystem && b.isSystem) return -1
                return 0
              })
              .map(rule => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  {editingRule === rule.id ? (
                    <EditRuleForm
                      rule={rule}
                      onSave={updates => handleSaveRule(rule.id, updates)}
                      onCancel={handleCancelEdit}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-3 flex-1">
                        <div className="flex items-center gap-2">
                          {getRuleTypeIcon(rule.type)}
                          <span className="text-xs bg-muted px-2 py-1 rounded">
                            {getRuleTypeLabel(rule.type)}
                          </span>
                        </div>
                        <div className="flex-1">
                          <div className="font-medium flex items-center gap-2">
                            <span>{rule.value}</span>
                            {rule.isCzkawka && (
                              <span className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded font-normal">
                                {t('排除清理')}
                              </span>
                            )}
                          </div>
                          {rule.description && (
                            <div className="text-sm text-muted-foreground">{rule.description}</div>
                          )}
                        </div>
                        {rule.isSystem && (
                          <span className="text-xs text-muted-foreground px-2 py-1 rounded">
                            {t('内置')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={rule.isActive}
                          onCheckedChange={checked =>
                            updateIgnoreRule(rule.id, { isActive: checked })
                          }
                          disabled={rule.isSystem}
                        />
                        {!rule.isSystem && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleEditRule(rule.id)}
                            >
                              <Edit3 className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => removeIgnoreRule(rule.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
          </div>
        </div>
      </Card>

      {/* 提示信息 */}
      <Card className="p-4 bg-muted border-foreground">
        <div className="flex items-start gap-2">
          <div className="text-blue-600 mt-0.5">💡</div>
          <div className="text-sm text-foreground/50">
            <p className="font-medium mb-1">{t('提示')}</p>
            <ul className="space-y-1">
              <li>{t('• 提示词修改后将应用到新的分析任务')}</li>
              <li>{t('• 忽略规则可以提高分析效率，避免处理不必要的文件')}</li>
              <li>{t('• 系统预设的忽略规则不能删除')}</li>
              <li>{t('• 标记【排除清理】的规则会在清理查重时自动跳过，确保核心数据与工作区安全')}</li>
              <li>{t('• 通配符支持 * 和 ? 匹配，正则表达式支持更复杂的模式')}</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  )
}

/**
 * 编辑规则表单组件
 */
interface EditRuleFormProps {
  rule: IIgnoreRule
  onSave: (updates: Partial<IIgnoreRule>) => void
  onCancel: () => void
}

const EditRuleForm: React.FC<EditRuleFormProps> = ({ rule, onSave, onCancel }) => {
  const { t } = useVoerkaI18n(i18nScope)
  const [editedRule, setEditedRule] = useState({
    type: rule.type,
    value: rule.value,
    description: rule.description || '',
    isCzkawka: rule.isCzkawka ?? false
  })

  const handleSave = () => {
    onSave(editedRule)
  }

  return (
    <div className="flex-1 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Select
            value={editedRule.type}
            onValueChange={value =>
              setEditedRule({ ...editedRule, type: value as IIgnoreRule['type'] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="file">{t('文件')}</SelectItem>
              <SelectItem value="directory">{t('目录')}</SelectItem>
              <SelectItem value="extension">{t('扩展名')}</SelectItem>
              <SelectItem value="wildcard">{t('通配符')}</SelectItem>
              <SelectItem value="regex">{t('正则表达式')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Input
            value={editedRule.value}
            onChange={e => setEditedRule({ ...editedRule, value: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Input
          placeholder={t('描述（可选）')}
          value={editedRule.description}
          onChange={e => setEditedRule({ ...editedRule, description: e.target.value })}
        />
      </div>
      <div className="flex items-center space-x-2">
        <input
          type="checkbox"
          id={`edit-rule-czkawka-${rule.id}`}
          checked={editedRule.isCzkawka}
          onChange={e => setEditedRule({ ...editedRule, isCzkawka: e.target.checked })}
          className="rounded border-gray-300 text-primary focus:ring-primary h-4 w-4"
        />
        <Label htmlFor={`edit-rule-czkawka-${rule.id}`} className="text-xs cursor-pointer select-none">
          {t('清理与查重时原生排除保护')}
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={!editedRule.value?.trim()}>
          <Save className="h-4 w-4 mr-1" />
          {t('保存')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-4 w-4 mr-1" />
          {t('取消')}
        </Button>
      </div>
    </div>
  )
}
