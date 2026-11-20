/**
 * 三态字段反馈组件 (`TriStateFieldFeedback`) — Group D / SLICE-08
 *
 * 严格消费 `ResolvedTriStateField<T>` 双轴字段，按 §5.3 渲染四态反馈：
 * - 默认正常态 (`origin !== 'user_custom' && applicability === 'active'`)：返回 null（零冗余）
 * - 用户自定义 (`user_custom && active`)：🟣 徽标 + 原值对照 + [恢复默认]
 * - 环境降级 (`degraded`)：🟠 实际生效 + 来源回退 + DegradationCallout 一键引导
 * - 级联关闭 (`cascaded_off`)：温和灰显 + 浅灰行内提示，不打橙色徽标
 *
 * 【i18n 铁律】所有面向用户的文案一律函数内静态字面量 `t('...')`，
 * 严禁传入变量 / 查表结果 / 模板字符串 / 双重 `t(t(...))`。
 * 【零工程黑话】严禁出现 ASR/OCR/CLIP/ONNX/gemma_unified/classic_light/LibreOffice 等术语。
 */
import React from 'react'
import { AlertTriangle, Crown, RotateCcw, UserCheck } from 'lucide-react'

import { t } from '@app/languages'

import type {
  ConfigApplicability,
  ConfigOriginSource,
  DegradationFixAction,
  DegradationReasonCode,
  InactiveReasonCode,
  ResolvedTriStateField
} from '../../../lib/workspace-policy/workspace-ai-client'

export interface TriStateFieldFeedbackProps<T = unknown> {
  /** 三态仲裁结果 */
  field: ResolvedTriStateField<T>
  /** 生效值的大白话渲染（如 "清晰优先"、"极速识别（省电流畅）"） */
  effectiveText: string
  /** 期望值（用户/工作流声明）的大白话渲染 */
  desiredText: string
  /** 是否已绑定工作流（决定「工作流默认」vs「默认配置」回退文案） */
  hasBoundWorkflow: boolean
  /** 点击 [恢复默认] / [恢复默认配置] 回调 */
  onRestore?: () => void
  /** 点击一键修复动作回调 */
  onFixAction?: (action: DegradationFixAction) => void
  /** 级联关闭的浅灰行内提示（如「已由上方语音听写开关关闭」） */
  cascadedOffHint?: string
  className?: string
}

/**
 * 环境降级根因 → 法定大白话（§5.3 静态 t() 映射，逐条内联字面量）
 */
function renderDegradationReason(
  reason: DegradationReasonCode,
  onFixAction?: (action: DegradationFixAction) => void,
  fixAction?: DegradationFixAction
): React.ReactNode {
  switch (reason) {
    case 'generative_ai_disabled':
      return (
        <DegradationCallout
          message={t('智能理解引擎未开启，已自动切换为极速基础整理（不卡电脑，可直接检索与分类）')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('前往开启引擎')}
          secondaryActionLabel={t('保持当前模式')}
          onPrimary={() => onFixAction?.('open_generative_engine')}
        />
      )
    case 'gemma_unified_not_active':
      return (
        <DegradationCallout
          message={t('当前为轻量极速搜图模式，暂不支持视频逐帧找画面，可随时在插件中心切换高精度全能引擎')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('切换全能引擎')}
          onPrimary={() => onFixAction?.('switch_to_gemma_unified')}
        />
      )
    case 'global_plugin_not_installed':
      return (
        <DegradationCallout
          message={t('该功能组件尚未安装，安装后即可自动按目录启用')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('一键安装组件')}
          onPrimary={() => onFixAction?.('install_global_plugin')}
        />
      )
    case 'global_plugin_inactive':
      return (
        <DegradationCallout
          message={t('该功能组件已在全局插件中心关闭，本目录已自动暂停使用')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('前往开启组件')}
          onPrimary={() => onFixAction?.('enable_global_plugin')}
        />
      )
    case 'global_plugin_error':
      return (
        <DegradationCallout
          message={t('该功能组件运行异常，暂已安全跳过，修复后可一键补齐')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('立即修复组件')}
          onPrimary={() => onFixAction?.('fix_global_plugin')}
        />
      )
    case 'libreoffice_missing':
      return (
        <DegradationCallout
          message={t('未检测到办公文档排版组件，Word/PPT/Excel 暂不生成首页缩略图，安装后可一键补全封面')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('前往安装指引')}
          onPrimary={() => onFixAction?.('install_libreoffice')}
        />
      )
    case 'cpu_hardware_clamp':
      // 无一键引导动作（用户手动调节后将按其设定执行）
      return (
        <DegradationCallout
          message={t('未检测到独立显卡，已为默认视频抓图开启省电护航（手动调节后将按您的设定执行）')}
        />
      )
    case 'free_tier_video_limit':
      return (
        <DegradationCallout
          message={t('当前方案默认深度分析每个视频前 5 分钟精华内容，升级专业版可自动续跑整片无需重扫')}
          primaryActionLabel={fixAction === 'none' ? undefined : t('了解专业版')}
          onPrimary={() => onFixAction?.('open_pro_upgrade')}
        />
      )
    case 'ocr_disabled_cascade':
      // 无一键引导动作
      return (
        <DegradationCallout
          message={t('已关闭图片与文档文字提取，清晰度选项已暂停')}
        />
      )
    default:
      return null
  }
}

/**
 * 非激活原因 → 法定大白话（cascaded_off / pending / unavailable_soon 行内提示）
 */
function renderInactiveReason(reason: InactiveReasonCode): string | null {
  switch (reason) {
    case 'parent_plugin_off_by_user':
      return t('您已在本目录关闭语音听写功能，如需开启请打开上方开关')
    case 'parent_plugin_unavailable':
      return t('全局语音听写组件尚未就绪，该时长设置将在组件就绪后自动恢复生效')
    case 'classic_engine_only':
      return t('文字直接找图功能仅轻量双塔模式需要，全能引擎已原生支持自然语言找画面')
    case 'plugin_downloading':
      return t('正在后台下载安装该组件，就绪后自动启用，无需重启')
    case 'plugin_coming_soon':
      return t('即将上线 · 已按当前主题为您预先关联，发布后自动就绪')
    case 'ocr_disabled_cascade':
      return t('已关闭图片与文档文字提取，清晰度选项已暂停')
    default:
      return null
  }
}

/** 降级提示条（DegradationCallout）：大白话原因 + 可选一键修复按钮 */
function DegradationCallout(props: {
  message: string
  primaryActionLabel?: string
  secondaryActionLabel?: string
  onPrimary?: () => void
  onSecondary?: () => void
}): React.ReactNode {
  const { message, primaryActionLabel, secondaryActionLabel, onPrimary, onSecondary } = props
  return (
    <div
      className="mt-1 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 leading-relaxed">
        <span>{message}</span>
        {(primaryActionLabel || secondaryActionLabel) && (
          <span className="ml-2 inline-flex gap-2">
            {primaryActionLabel && (
              <button
                type="button"
                onClick={onPrimary}
                className="font-medium text-amber-700 underline underline-offset-2 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
              >
                {primaryActionLabel}
              </button>
            )}
            {secondaryActionLabel && (
              <button
                type="button"
                onClick={onSecondary}
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {secondaryActionLabel}
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * 文字识别清晰度档位 → 法定大白话（§5.3 第 15 条，严禁出现 tiny/small/OCR 术语）
 */
export function getOcrModelSizeLabel(size: 'tiny' | 'small'): string {
  return size === 'small' ? t('高清精识（适合票据与密字截图）') : t('极速识别（省电流畅）')
}

/** 主组件：按 applicability × origin 渲染四态反馈 */
export function TriStateFieldFeedback<T = unknown>(
  props: TriStateFieldFeedbackProps<T>
): React.ReactNode {
  const {
    field,
    effectiveText,
    desiredText,
    hasBoundWorkflow,
    onRestore,
    onFixAction,
    cascadedOffHint,
    className
  } = props

  const { origin, applicability, degradationReason, fixAction, inactiveReason } = field

  // 默认正常态：零冗余徽标
  if (origin !== 'user_custom' && applicability === 'active') {
    return null
  }

  // 用户自定义（仍正常生效）：🟣 徽标 + 原值对照 + 恢复默认
  if (origin === 'user_custom' && applicability === 'active') {
    return (
      <div className={className}>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 font-medium text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">
            <UserCheck className="h-3 w-3" aria-hidden="true" />
            {t('用户自定义')}
          </span>
          <span>
            {hasBoundWorkflow
              ? t('（工作流默认：{value}）', { value: desiredText })
              : t('（默认配置：{value}）', { value: desiredText })}
          </span>
          {onRestore && (
            <button
              type="button"
              onClick={onRestore}
              className="inline-flex items-center gap-1 text-purple-700 underline underline-offset-2 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-100"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {hasBoundWorkflow ? t('恢复默认') : t('恢复默认配置')}
            </button>
          )}
        </div>
      </div>
    )
  }

  // 环境自动降级：🟠 实际生效 + 来源回退 + 大白话原因 + 一键修复
  if (applicability === 'degraded') {
    return (
      <div className={className}>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {t('实际生效：{value}', { value: effectiveText })}
          </span>
          {origin === 'user_custom' ? (
            <span>{t('（用户自定义：{value}）', { value: desiredText })}</span>
          ) : (
            <span>
              {hasBoundWorkflow
                ? t('（工作流默认：{value}）', { value: desiredText })
                : t('（默认配置：{value}）', { value: desiredText })}
            </span>
          )}
          {origin === 'user_custom' && onRestore && (
            <button
              type="button"
              onClick={onRestore}
              className="inline-flex items-center gap-1 text-purple-700 underline underline-offset-2 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-100"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {hasBoundWorkflow ? t('恢复默认') : t('恢复默认配置')}
            </button>
          )}
        </div>
        {degradationReason &&
          renderDegradationReason(degradationReason, onFixAction, fixAction)}
      </div>
    )
  }

  // 级联关闭：温和灰显 + 浅灰行内提示，不打橙色徽标
  if (applicability === 'cascaded_off') {
    const hint =
      cascadedOffHint ??
      (inactiveReason ? renderInactiveReason(inactiveReason) : null)
    return (
      <div className={className}>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/70">
          <span className="inline-flex items-center gap-1">
            <Crown className="h-3 w-3 opacity-50" aria-hidden="true" />
            {t('已由上级开关关闭')}
          </span>
          {hint && <span className="opacity-80">{hint}</span>}
          {inactiveReason === 'parent_plugin_off_by_user' && onFixAction && (
            <button
              type="button"
              onClick={() => onFixAction('re_enable_parent_plugin')}
              className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
            >
              {t('重新开启')}
            </button>
          )}
        </div>
      </div>
    )
  }

  // 其他非激活态（pending / unavailable_soon / frozen_by_engine）：仅浅灰行内提示
  if (applicability !== 'active' && inactiveReason) {
    const hint = renderInactiveReason(inactiveReason)
    if (hint) {
      return (
        <div className={className}>
          <div className="text-xs text-muted-foreground/70">{hint}</div>
        </div>
      )
    }
  }

  return null
}

export default TriStateFieldFeedback
