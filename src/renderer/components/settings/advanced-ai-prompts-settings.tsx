import {
  AlertTriangle,
  Info,
  RotateCcw,
  Sparkles
} from 'lucide-react'
import React, { useEffect, useMemo, useState } from 'react'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { SUPPORTED_LANGUAGES } from '@firefly/shared'
import { Textarea } from '../ui/textarea'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'

/**
 * 防抖更新自定义提示词 Hook
 */
function useDebouncedPromptUpdater(
  promptValue: string,
  configKey: 'UNIT_RECOGNITION_PROMPT' | 'QUALITY_SCORE_PROMPT' | 'TAG_GENERATION_PROMPT',
  getConfigValue: (key: any) => any,
  updateConfigValue: (key: any, value: any) => Promise<any>
) {
  useEffect(() => {
    const handler = setTimeout(() => {
      if (promptValue !== (getConfigValue(configKey) || '')) {
        updateConfigValue(configKey, promptValue)
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

/**
 * 高级AI提示词设置组件
 */
export const AdvancedAIPromptsSettings: React.FC = () => {
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)

  const [qualityPrompt, setQualityPrompt] = useState(
    getConfigValue<string>('QUALITY_SCORE_PROMPT') || ''
  )
  const [tagPrompt, setTagPrompt] = useState(
    getConfigValue<string>('TAG_GENERATION_PROMPT') || ''
  )

  // 为每个提示词设置独立的防抖更新
  useDebouncedPromptUpdater(qualityPrompt, 'QUALITY_SCORE_PROMPT', getConfigValue, updateConfigValue)
  useDebouncedPromptUpdater(tagPrompt, 'TAG_GENERATION_PROMPT', getConfigValue, updateConfigValue)

  /**
   * 默认提示词示例
   */
  const defaultPrompts = useMemo(
    () => ({
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
    [activeLanguage, t]
  )

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('高级AI提示词')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('自定义提示词以微调模型对分类命名和质量评分的生成规则')}
        </p>
      </div>

      {/* 提示与建议卡片 */}
      <div className="p-4 rounded-xl border border-amber-500/20 bg-amber-500/5 dark:bg-amber-500/10 flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <div className="text-xs space-y-1 text-foreground/80 leading-relaxed">
          <p className="font-semibold text-amber-700 dark:text-amber-300">
            {t('提示词调优说明')}
          </p>
          <p>
            {t('推荐使用遵循度较好的云端模型或高参数量模型；若因提示词字数过多导致 AI 分析失败，请适当精简内容。对于本地轻量小模型，建议精简至 100 字以内。')}
          </p>
        </div>
      </div>

      {/* 提示词列表 */}
      <div className="space-y-5">
        {/* 1. 质量评分提示词 */}
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="quality-prompt" className="text-sm font-semibold">
                {t('质量评分提示词')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('调整多模态内容评分侧重点与权重逻辑')}
              </p>
            </div>
            {qualityPrompt && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
                onClick={() => setQualityPrompt('')}
              >
                <RotateCcw className="h-3 w-3" />
                {t('清空')}
              </Button>
            )}
          </div>
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
            className="font-mono text-xs"
            maxLength={1000}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="text-[11px] italic">
              {qualityPrompt ? t('已配置自定义提示词') : t('留空则使用默认提示词模板')}
            </span>
            <span className={qualityPrompt.length >= 1000 ? 'text-destructive font-medium' : ''}>
              {qualityPrompt.length} / 1000 {t('字符')}
            </span>
          </div>
        </Card>

        {/* 2. 标签与智能文件名生成提示词 */}
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="tag-prompt" className="text-sm font-semibold">
                {t('标签与智能文件名生成提示词')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('指导模型如何提炼关键词、格式化文件名与挑选分类标签')}
              </p>
            </div>
            {tagPrompt && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
                onClick={() => setTagPrompt('')}
              >
                <RotateCcw className="h-3 w-3" />
                {t('清空')}
              </Button>
            )}
          </div>
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
            className="font-mono text-xs"
            maxLength={1000}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="text-[11px] italic">
              {tagPrompt ? t('已配置自定义提示词') : t('留空则使用默认提示词模板')}
            </span>
            <span className={tagPrompt.length >= 1000 ? 'text-destructive font-medium' : ''}>
              {tagPrompt.length} / 1000 {t('字符')}
            </span>
          </div>
        </Card>
      </div>

      {/* 底部提示 */}
      <div className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-500" />
        <p>
          {t('提示词修改后将实时防抖保存，并应用于后续触发的全部文件分析任务。')}
        </p>
      </div>
    </div>
  )
}

export default AdvancedAIPromptsSettings
