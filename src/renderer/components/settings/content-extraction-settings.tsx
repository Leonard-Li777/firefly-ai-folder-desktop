import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  HelpCircle,
  ScanText
} from 'lucide-react'
import React, { useEffect, useState } from 'react'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { openExternalLink } from '../../lib/external-link'
import { useSettingsStore } from '../../stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'

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
 * 内容萃取设置组件
 */
export const ContentExtractionSettings: React.FC = () => {
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const { t } = useVoerkaI18n(i18nScope)

  const [libreOfficeInstalled, setLibreOfficeInstalled] = useState<boolean | null>(null)
  const [libreOfficeVersion, setLibreOfficeVersion] = useState<string | undefined>(undefined)
  const [checkingLibreOffice, setCheckingLibreOffice] = useState(false)
  const [showLibreOfficeHelp, setShowLibreOfficeHelp] = useState(false)

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
   * 监听外部配置变更更新本地显示
   */
  useEffect(() => {
    const externalAudio = getConfigValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
    if (externalAudio !== localAudioDuration) {
      setLocalAudioDuration(externalAudio)
    }

    const externalPages = getConfigValue<number>('EXTRACT_PAGES') ?? 2
    if (externalPages !== localExtractPages) {
      setLocalExtractPages(externalPages)
    }

    const externalSize = getConfigValue<number>('MAX_CONTENT_SIZE_KB') ?? 30
    if (externalSize !== localMaxContentSizeKb) {
      setLocalMaxContentSizeKb(externalSize)
    }

    const externalOfficeCover = getConfigValue<boolean>('ENABLE_OFFICE_COVER') ?? false
    if (externalOfficeCover !== localEnableOfficeCover) {
      setLocalEnableOfficeCover(externalOfficeCover)
    }

    const externalOcrItems = getConfigValue<number>('MAX_DOCUMENT_OCR_ITEMS') ?? 0
    if (externalOcrItems !== localMaxDocOcrItems) {
      setLocalMaxDocOcrItems(externalOcrItems)
    }
  }, [getConfigValue])

  /**
   * 检测 LibreOffice 状态
   */
  useEffect(() => {
    checkLibreOfficeStatus()
  }, [])

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

  const handleOpenLibreOfficeDownload = () => {
    openExternalLink('https://www.libreoffice.org/download/download/')
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('内容萃取设置')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('控制文件与文档文本、OCR、音视频等内容提取范围及精度')}
        </p>
      </div>

      {/* 内容萃取设置主卡片 */}
      <Card className="p-5">
        <div className="space-y-6">
          {/* 小节 1：文档与文本提取 */}
          <div className="space-y-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/90">
              <FileText className="h-4 w-4 text-primary shrink-0" />
              <span>{t('文档与内容提取')}</span>
            </div>

            {/* 内容提取大小上限 */}
            <div className="p-3.5 rounded-lg bg-muted/20 border border-border/50 space-y-3">
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
                const normalizedValue = localMaxContentSizeKb === 0 ? -1 : localMaxContentSizeKb
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
                        const selectedValue = ticks[idx]
                        setLocalMaxContentSizeKb(selectedValue)
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
            <div className="p-3.5 rounded-lg bg-muted/20 border border-border/50 space-y-3">
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
                  onCheckedChange={checked => {
                    setLocalEnableOfficeCover(checked)
                    updateConfigValue('ENABLE_OFFICE_COVER', checked)
                    captureEvent('切换Office封面截图', { enabled: checked })
                  }}
                />
              </div>

              {localEnableOfficeCover && (
                <div className="pt-3 border-t border-border/40">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 pr-4">
                      <div className="flex items-center gap-1">
                        <Label className="text-sm font-medium flex items-center gap-2">
                          {t('插件安装：LibreOffice')}
                        </Label>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('支持Office文件整页转换与封面图提取')}，
                        <span className="text-xs text-amber-600 font-medium">
                          {t('但会大大增加Office内容提取耗时，PDF不受影响')}
                        </span>
                      </p>
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

            {/* 音频分析截取时长 */}
            <div className="flex items-center justify-between p-3.5 rounded-lg bg-muted/20 border border-border/50">
              <div className="space-y-1 pr-4">
                <div className="flex items-center gap-1">
                  <Label htmlFor="audio-duration" className="text-sm font-medium">
                    {t('音频分析截取时长')}
                  </Label>
                  <HelpTooltip
                    content={t('截取音视频前N秒进行降噪与语音转录提取，最大值100秒，设置过大会增加耗时')}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('截取音视频前N秒进行语音转录，超大会增加分析耗时甚至超时失败')}
                </p>
              </div>
              <div className="w-24 shrink-0">
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
          </div>

          {/* 小节 2：OCR 识别与处理 */}
          <div className="space-y-3.5 pt-3 border-t border-border/60">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/90">
              <ScanText className="h-4 w-4 text-primary shrink-0" />
              <span>{t('OCR 识别与处理')}</span>
            </div>

            {/* 开启图片OCR智能识别 */}
            <div className="flex items-center justify-between p-3.5 rounded-lg bg-muted/20 border border-border/50">
              <div className="space-y-1 pr-4">
                <div className="flex items-center gap-1">
                  <Label htmlFor="image-ocr-switch" className="text-sm font-medium">
                    {t('开启图片OCR智能识别')}
                  </Label>
                  <HelpTooltip
                    content={t('毫秒级智能感知图片中是否有文本，有则进行OCR识别')}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('毫秒级智能感知图片中是否有文本，有则进行OCR识别')}
                </p>
              </div>
              <Switch
                id="image-ocr-switch"
                checked={getConfigValue<boolean>('ENABLE_IMAGE_OCR') ?? true}
                onCheckedChange={checked => {
                  updateConfigValue('ENABLE_IMAGE_OCR', checked)
                  captureEvent('切换图片OCR智能识别', { enabled: checked })
                }}
              />
            </div>

            {/* 文档 OCR 识别数量上限 */}
            <div className="p-3.5 rounded-lg bg-muted/20 border border-border/50 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="max-doc-ocr-items" className="text-sm font-medium">
                    {t('文档OCR识别数量')}
                  </Label>
                  <HelpTooltip
                    content={t('文档OCR识别数量上限（Office文档内嵌图片数量 / PDF文档页数）')}
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
                const ticks = Array.from({ length: 31 }, (_, i) => i).concat([-1])
                const currentIndex =
                  ticks.indexOf(localMaxDocOcrItems) !== -1
                    ? ticks.indexOf(localMaxDocOcrItems)
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
                        const selectedValue = ticks[idx]
                        setLocalMaxDocOcrItems(selectedValue)
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

            {/* OCR 识别精度 */}
            <div className="p-3.5 rounded-lg bg-muted/20 border border-border/50 space-y-3">
              <div className="flex items-center gap-1.5">
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
                  className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    (getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'tiny'
                      ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                      : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                  }`}
                >
                  <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                    {t('推荐')}
                  </div>
                  {(getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'tiny' && (
                    <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                      <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
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
                  className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    (getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'small'
                      ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                      : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                  }`}
                >
                  {(getConfigValue<string>('OCR_MODEL_SIZE') ?? 'tiny') === 'small' && (
                    <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                      <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
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
          </div>

          {/* 小节 3：复用数据开关 */}
          <div className="pt-3 border-t border-border/60">
            <div className="flex items-center justify-between p-3.5 rounded-lg bg-muted/20 border border-border/50">
              <div className="space-y-1 pr-4">
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
                  {t('分析提速，不会重新获取标准分析阶段的信息')}
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
    </div>
  )
}

export default ContentExtractionSettings
