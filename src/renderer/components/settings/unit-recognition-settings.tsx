import {
  AlertTriangle,
  GitFork,
  HelpCircle,
  Info,
  RotateCcw,
  Sparkles
} from 'lucide-react'
import React, { useEffect, useMemo, useState } from 'react'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
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
 * 最小单元识别设置组件
 */
export const UnitRecognitionSettings: React.FC = () => {
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const { t } = useVoerkaI18n(i18nScope)

  const isEnabled = getConfigValue<boolean>('ENABLE_UNIT_RECOGNITION') ?? false
  const [unitPrompt, setUnitPrompt] = useState<string>(
    getConfigValue<string>('UNIT_RECOGNITION_PROMPT') || ''
  )

  /**
   * 提示词防抖更新同步
   */
  useEffect(() => {
    const handler = setTimeout(() => {
      if (unitPrompt !== (getConfigValue('UNIT_RECOGNITION_PROMPT') || '')) {
        updateConfigValue('UNIT_RECOGNITION_PROMPT', unitPrompt)
        captureEvent('更新自定义提示词', {
          prompt_type: 'UNIT_RECOGNITION_PROMPT',
          content: unitPrompt,
          content_length: unitPrompt.length
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [unitPrompt, getConfigValue, updateConfigValue])



  const defaultPromptPlaceholder = useMemo(
    () =>
      t(
        '示例：作为整体单元的文件集合特征为：文件命名带数字后缀的文件集合，例如：1.txt, 2.txt, 3.txt'
      ),
    [t]
  )

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('最小单元识别')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('识别系列文件、音轨专辑、工程目录等整体单元，并支持自定义单元识别提示词')}
        </p>
      </div>

      {/* 最小单元识别开关卡片 */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-2.5 flex-1 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary mt-0.5">
              <GitFork className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Label
                  htmlFor="unit-recognition-switch"
                  className="text-base font-semibold leading-none cursor-pointer"
                >
                  {t('启用最小单元识别')}
                </Label>
                <HelpTooltip
                  content={t(
                    '以下类别强制识别，无需开启：系统目录、软件安装目录、工程项目、游戏包、AI数据集/模型、缓存与LFS、虚拟环境'
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                {t('启用后，识别为最小单元的目录，跳过文件逐一分析')}
              </p>
            </div>
          </div>
          <Switch
            id="unit-recognition-switch"
            checked={isEnabled}
            onCheckedChange={checked => {
              updateConfigValue('ENABLE_UNIT_RECOGNITION', checked)
              captureEvent('切换最小单元识别', { enabled: checked })
            }}
          />
        </div>

        {/* 最小单元详细说明 */}
        <div className="text-xs text-muted-foreground bg-muted/30 border border-border/50 rounded-lg p-3 space-y-2">
          <ul className="list-disc list-inside space-y-1">
            <li>{t('系列文件：连续编号的文档或图片（如 01.jpg, 02.jpg, 03.jpg）')}</li>
            <li>{t('音频专辑：同一专辑的音轨文件集合（如 .flac, .mp3）')}</li>
            <li>{t('设计工程：含工程文件及资源目录的设计项目（如 .prproj、.aep、.blend）')}</li>
          </ul>
          <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
            {t('提示：关闭后所有文件将独立分析，适用于需对每个文件单独生成描述和标签的场景')}
          </p>
        </div>
      </Card>

      {/* 最小单元识别提示词卡片 */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="unit-prompt" className="text-sm font-semibold">
                {t('最小单元识别提示词')}
              </Label>
              {!isEnabled && (
                <span className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full font-medium">
                  {t('需开启上方开关方可生效')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('定义什么样的文件集合应被视作一个整体单元，微调模型的识别判断')}
            </p>
          </div>
          {unitPrompt && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
              onClick={() => setUnitPrompt('')}
            >
              <RotateCcw className="h-3 w-3" />
              {t('清空')}
            </Button>
          )}
        </div>
        <Textarea
          id="unit-prompt"
          placeholder={defaultPromptPlaceholder}
          value={unitPrompt}
          onChange={e => {
            const value = e.target.value
            if (value.length <= 1000) {
              setUnitPrompt(value)
            }
          }}
          rows={4}
          className="font-mono text-xs"
          maxLength={1000}
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="text-[11px] italic">
            {unitPrompt ? t('已配置自定义提示词') : t('留空则使用默认提示词模板')}
          </span>
          <span className={unitPrompt.length >= 1000 ? 'text-destructive font-medium' : ''}>
            {unitPrompt.length} / 1000 {t('字符')}
          </span>
        </div>
      </Card>

      {/* 底部说明 */}
      <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
        <p>
          {t('作为最小单元识别的目录将被整体作为一个文件处理，避免产生过多碎片分析结果。')}
        </p>
      </div>
    </div>
  )
}

export default UnitRecognitionSettings
