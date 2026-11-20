/**
 * 目录插件配置 Tab (`WorkspacePluginsTab`) — Group D / SLICE-08-2
 *
 * 严格仅渲染 6 个目录级可配置插件，严禁渲染 6 个全局专属插件。
 * - 主区（2 个已上线）：asr_sensevoice_onnx、perception_nsfw
 *   展示推荐标识、大白话收益/资源影响、Switch → `pluginOverridePatch`
 * - 预告区（4 个 coming_soon）：archive_vfs_parser、face_recognition_tool、
 *   object_detection_pro、password_vault_cracker
 *   中性只读预览，0 橙色降级，0 死链修复按钮；password_vault_cracker 加注绝不自动破解
 *
 * 【i18n 铁律】所有 UI 文案均为静态字面量 `t('...')`，严禁传入变量。
 * 【零工程黑话】严禁出现 ASR/OCR/CLIP/ONNX/gemma_unified/classic_light/LibreOffice 等术语。
 */
import React, { useCallback, useState } from 'react'
import { Eye, ImageIcon, Lock, Mic, Package, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react'

import { t } from '@app/languages'

import {
  WORKSPACE_AVAILABLE_PLUGIN_IDS,
  WORKSPACE_COMING_SOON_PLUGIN_IDS,
  submitWorkspacePolicyMutation,
  getMutationErrorText,
  type DegradationFixAction,
  type ResolvedPluginTriState
} from '../../../lib/workspace-policy/workspace-ai-client'
import { TriStateFieldFeedback } from './TriStateFieldFeedback'
import { Switch } from '../../ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card'

export interface WorkspacePluginsTabProps {
  workspaceId: number
  /** 6 个目录插件的三态仲裁结果 */
  plugins: Record<string, ResolvedPluginTriState>
  /** 是否已绑定工作流（决定推荐标识文案） */
  hasBoundWorkflow: boolean
  /** 补丁提交成功后的回调（可选，用于父组件刷新状态） */
  onMutationSuccess?: () => void
  /** 补丁提交失败后的回调 */
  onMutationError?: (error: string) => void
  /** 点击降级修复引导动作的回调（可选） */
  onFixAction?: (action: DegradationFixAction, pluginId: string) => void
}

/** 插件图标映射（lucide-react，零外部图片依赖） */
function PluginIcon({ pluginId }: { pluginId: string }): React.ReactNode {
  switch (pluginId) {
    case 'asr_sensevoice_onnx':
      return <Mic className="h-5 w-5 text-blue-500" aria-hidden="true" />
    case 'perception_nsfw':
      return <ShieldAlert className="h-5 w-5 text-rose-500" aria-hidden="true" />
    case 'archive_vfs_parser':
      return <Package className="h-5 w-5 text-amber-500" aria-hidden="true" />
    case 'face_recognition_tool':
      return <Eye className="h-5 w-5 text-emerald-500" aria-hidden="true" />
    case 'object_detection_pro':
      return <ImageIcon className="h-5 w-5 text-indigo-500" aria-hidden="true" />
    case 'password_vault_cracker':
      return <Lock className="h-5 w-5 text-slate-500" aria-hidden="true" />
    default:
      return <Sparkles className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
  }
}

/** 推荐标识 pill 文案 */
function renderRecommendationLabel(
  pluginId: string,
  plugins: Record<string, ResolvedPluginTriState>,
  hasBoundWorkflow: boolean
): string {
  if (!hasBoundWorkflow) return t('默认关闭')
  const p = plugins[pluginId]
  if (!p) return t('默认关闭')
  switch (p.workflowRecommendation) {
    case 'workflow_recommended_on':
      return t('本主题推荐开启')
    case 'workflow_default_off':
      return t('本主题默认关闭')
    case 'system_default_off':
      return t('默认关闭')
    default:
      return t('默认关闭')
  }
}

export function WorkspacePluginsTab(props: WorkspacePluginsTabProps): React.ReactNode {
  const { workspaceId, plugins, hasBoundWorkflow, onMutationSuccess, onMutationError, onFixAction } =
    props
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())

  const handleToggle = useCallback(
    async (pluginId: string, checked: boolean) => {
      setPendingIds((prev) => new Set(prev).add(pluginId))
      try {
        const result = await submitWorkspacePolicyMutation(workspaceId, {
          pluginOverridePatch: { [pluginId]: checked }
        })
        if (!result.success) {
          onMutationError?.(getMutationErrorText(result, 'UNKNOWN_ERROR'))
        } else {
          onMutationSuccess?.()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        onMutationError?.(message)
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(pluginId)
          return next
        })
      }
    },
    [workspaceId, onMutationSuccess, onMutationError]
  )

  const handleRestorePluginDefault = useCallback(
    async (pluginId: string) => {
      setPendingIds((prev) => new Set(prev).add(pluginId))
      try {
        const result = await submitWorkspacePolicyMutation(workspaceId, {
          restorePluginOverrideIds: [pluginId]
        })
        if (!result.success) {
          onMutationError?.(getMutationErrorText(result, 'UNKNOWN_ERROR'))
        } else {
          onMutationSuccess?.()
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        onMutationError?.(message)
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev)
          next.delete(pluginId)
          return next
        })
      }
    },
    [workspaceId, onMutationSuccess, onMutationError]
  )

  const availableIds = WORKSPACE_AVAILABLE_PLUGIN_IDS
  const comingSoonIds = WORKSPACE_COMING_SOON_PLUGIN_IDS

  return (
    <div className="space-y-4">
      {/* ─── 主区：已上线可用插件 ─── */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">
          {t('已上线功能组件')}
        </h3>
        <div className="space-y-2">
          {availableIds.map((pluginId) => {
            const plugin = plugins[pluginId]
            const isEnabled = plugin?.effectiveValue ?? false
            const isPending = pendingIds.has(pluginId)
            const isUserCustom = plugin?.origin === 'user_custom'
            const desiredEnabled = plugin?.workflowRecommendation === 'workflow_recommended_on'

            return (
              <Card key={pluginId}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <PluginIcon pluginId={pluginId} />
                    <span className="flex-1">{renderPluginName(pluginId)}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {renderRecommendationLabel(pluginId, plugins, hasBoundWorkflow)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {renderPluginBenefit(pluginId)}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground/70">
                    {renderPluginResourceImpact(pluginId)}
                  </p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {isEnabled ? t('已开启') : t('已关闭')}
                      </span>
                      {isUserCustom && (
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void handleRestorePluginDefault(pluginId)}
                          className="inline-flex items-center gap-1 text-xs text-purple-700 underline underline-offset-2 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-100"
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden="true" />
                          {hasBoundWorkflow ? t('恢复默认') : t('恢复默认配置')}
                        </button>
                      )}
                    </div>
                    <Switch
                      checked={isEnabled}
                      disabled={isPending}
                      onCheckedChange={(checked) => handleToggle(pluginId, checked)}
                      aria-label={renderPluginName(pluginId)}
                    />
                  </div>
                  {plugin && plugin.applicability === 'degraded' && (
                    <TriStateFieldFeedback
                      className="mt-2"
                      field={{
                        effectiveValue: plugin.effectiveValue,
                        desiredValue: desiredEnabled,
                        origin: plugin.origin,
                        applicability: plugin.applicability,
                        visible: true,
                        isUserCustom,
                        degradationReason: plugin.degradationReason,
                        inactiveReason: plugin.inactiveReason
                      }}
                      effectiveText={plugin.effectiveValue ? t('已开启') : t('已关闭')}
                      desiredText={desiredEnabled ? t('开启') : t('关闭')}
                      hasBoundWorkflow={hasBoundWorkflow}
                      onRestore={
                        isUserCustom
                          ? () => void handleRestorePluginDefault(pluginId)
                          : undefined
                      }
                      onFixAction={(action) => onFixAction?.(action, pluginId)}
                    />
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      {/* ─── 预告区：即将上线（coming_soon），中性只读 ─── */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-foreground">
          {t('即将上线')}
        </h3>
        <div className="space-y-2">
          {comingSoonIds.map((pluginId) => (
            <Card key={pluginId} className="opacity-70">
              <CardContent className="flex items-start gap-3 py-3">
                <PluginIcon pluginId={pluginId} />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {renderPluginName(pluginId)}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t('即将上线')}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {renderPluginBenefit(pluginId)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground/60">
                    {hasBoundWorkflow
                      ? t('即将上线 · 已按当前主题为您预先关联，发布后自动就绪')
                      : t('即将上线 · 发布后可按需在本目录开启')}
                  </p>
                  {pluginId === 'password_vault_cracker' && (
                    <p className="mt-1.5 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                      {t('启用仅表示允许在本目录协助解密常见密码本或详情页手动解密，不会自动暴力破解您的敏感文件')}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 插件展示名（大白话，零工程术语） */
function renderPluginName(pluginId: string): string {
  switch (pluginId) {
    case 'asr_sensevoice_onnx':
      return t('语音听写')
    case 'perception_nsfw':
      return t('内容安全识别')
    case 'archive_vfs_parser':
      return t('压缩包直接浏览')
    case 'face_recognition_tool':
      return t('照片人物识别')
    case 'object_detection_pro':
      return t('图片物体标记')
    case 'password_vault_cracker':
      return t('加密文件解密助手')
    default:
      return pluginId
  }
}

/** 插件大白话收益（§5.2 + 零工程术语） */
function renderPluginBenefit(pluginId: string): string {
  switch (pluginId) {
    case 'asr_sensevoice_onnx':
      return t('把语音和视频里的讲话自动转成文字，方便直接搜索和整理')
    case 'perception_nsfw':
      return t('自动识别不适宜公开的图片，帮您提前标记或过滤')
    case 'archive_vfs_parser':
      return t('不用解压就能直接浏览压缩包里的文件列表')
    case 'face_recognition_tool':
      return t('自动识别照片里的人物，帮您按人物整理相册')
    case 'object_detection_pro':
      return t('自动标记照片里的物体（如车、猫、建筑），让搜索更精准')
    case 'password_vault_cracker':
      return t('帮您打开带有密码保护的常见加密文件（如 PDF、ZIP）')
    default:
      return ''
  }
}

/** 插件资源影响（零工程术语，小白四维：资源影响维度） */
function renderPluginResourceImpact(pluginId: string): string {
  switch (pluginId) {
    case 'asr_sensevoice_onnx':
      return t('分析音视频时会多耗一些电，仅在有语音内容的文件上运行')
    case 'perception_nsfw':
      return t('扫描图片时会占用少量后台资源，普通电脑可流畅运行')
    case 'archive_vfs_parser':
      return t('仅在浏览压缩包时短暂占用资源')
    case 'face_recognition_tool':
      return t('扫描照片时会占用一定后台资源，建议有独立显卡的电脑开启')
    case 'object_detection_pro':
      return t('扫描图片时会占用一定后台资源')
    case 'password_vault_cracker':
      return t('仅在您手动操作时短暂运行，不会在后台持续占用资源')
    default:
      return ''
  }
}

export default WorkspacePluginsTab
