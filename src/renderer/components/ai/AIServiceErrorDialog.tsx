/**
 * AI服务错误对话框组件
 * 显示用户友好的AI服务启动错误信息和解决建议
 */

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Cpu,
  ExternalLink,
  HelpCircle,
  RefreshCw,
  Settings,
  XCircle,
  Zap
} from 'lucide-react'
import { AIErrorType, AIServiceError, SettingsCategory } from '@firefly/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { ErrorNormalizer, ICompleteErrorInfo, LogCategory, logger } from '@firefly/shared'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useAIServiceError,
  useAIServiceStatus,
  useAIServiceStore
} from '../../stores/ai-service-store'

import { Button } from '../ui/button'
import { openExternalLink } from '../../lib/external-link'
import { t } from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'

/**
 * AI服务错误对话框Props接口
 */
interface IAIServiceErrorDialogProps {
  /** 是否显示对话框 */
  open: boolean
  /** 关闭对话框回调 */
  onClose: () => void
  /** 打开设置页面回调 */
  onOpenSettings?: () => void
  /** 切换到云端服务回调 */
  onSwitchToCloud?: () => void
}

/**
 * 错误信息接口
 */
interface IErrorInfo {
  title: string
  description: string
  icon: React.ReactNode
  suggestions: string[]
  actions: Array<{
    label: string
    action: () => void
    variant?: 'default' | 'destructive' | 'outline' | 'secondary'
  }>
}

/**
 * 图标映射表
 */
const ICON_MAP: Record<string, React.ReactNode> = {
  AlertTriangle: <AlertTriangle />,
  XCircle: <XCircle />,
  Settings: <Settings />,
  HelpCircle: <HelpCircle />,
  Cpu: <Cpu />,
  RefreshCw: <RefreshCw />
}

/**
 * AI服务错误对话框组件
 */
export const AIServiceErrorDialog: React.FC<IAIServiceErrorDialogProps> = ({
  open,
  onClose,
  onOpenSettings,
  onSwitchToCloud
}) => {
  const { initializeAIService, initializeAIServiceWithCpu, initializeAIServiceWithVulkan } =
    useAIServiceStatus()
  const { error } = useAIServiceError()

  /**
   * 处理以 CPU 模式启动
   */
  const handleStartWithCpu = useCallback(async () => {
    try {
      await initializeAIServiceWithCpu()
      onClose()
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '以 CPU 模式初始化失败:', error)
    }
  }, [initializeAIServiceWithCpu, onClose])

  /**
   * 处理重试
   */
  const handleRetry = useCallback(async () => {
    try {
      await initializeAIService()
      onClose()
    } catch (error) {
      // 错误会被store自动处理
      logger.error(LogCategory.AI_SERVICE, '重试初始化失败:', error)
    }
  }, [initializeAIService, onClose])

  /**
   * 处理重新部署
   */
  const handleRedeploy = useCallback(async () => {
    try {
      await initializeAIService({ forceDeploy: true })
      onClose()
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '重新部署 AI 引擎失败:', error)
    }
  }, [initializeAIService, onClose])

  /**
   * 处理切换到云端服务
   */
  const handleSwitchToCloud = useCallback(() => {
    onSwitchToCloud?.()
    onClose()
  }, [onSwitchToCloud, onClose])

  /**
   * 处理切换到简单分类模式
   */
  const handleSwitchToSimple = useCallback(() => {
    useSettingsStore.getState().updateConfigValue('ANALYSIS_MODE', 'simple')
    useSettingsStore.getState().openSettings(SettingsCategory.ANALYSIS)
    onClose()
  }, [onClose])

  /**
   * 获取错误信息
   */
  const getErrorInfo = useCallback(
    (inputError: any): IErrorInfo => {
      // 1. 规范化错误：处理 inputError 可能是 AIServiceError 对象、Error 对象或字符串的情况
      const aiError = ErrorNormalizer.normalize(
        inputError,
        (inputError?.code || inputError?.type) as AIErrorType,
        'AIServiceErrorDialog'
      )

      // 2. 获取完整的错误详情（从共享的 ErrorNormalizer 获取）
      // 使用类型断言解决由于 monorepo 类型同步延迟导致的类型不匹配问题
      const completeInfo = ErrorNormalizer.getCompleteErrorInfo(
        aiError.code || aiError.type
      ) as ICompleteErrorInfo

      // 3. 构造操作按钮（云端配置按钮优先，使其获得主色）
      const actions: IErrorInfo['actions'] = []

      // 本地硬件不支持或建议中包含"云端"关键词 → 统一为"配置云端模型"按钮，优先加入获取主色
      const isCloudRelated =
        aiError.code === AIErrorType.LOCAL_AI_UNSUPPORTED ||
        aiError.suggestions?.some((s: string) => s.includes('云端'))
      if (isCloudRelated) {
        // 切换引擎：直接打开设置页的 AI引擎配置 tab
        actions.push({
          label: t('切换引擎'),
          action: () => {
            useSettingsStore.getState().openSettings(SettingsCategory.AI_ENGINE_CONFIG)
            onClose()
          },
          variant: actions.length === 0 ? 'default' : 'secondary'
        })
        actions.push({
          label: t('配置云端模型'),
          action: handleSwitchToCloud,
          variant: actions.length === 0 ? 'default' : 'secondary'
        })
      }

      // 如果是驱动过旧、显存不足或模型加载失败，提供自动降级启动（由后端策略控制）
      if (
        aiError.code === AIErrorType.GPU_DRIVER_OUTDATED ||
        aiError.code === AIErrorType.INSUFFICIENT_VRAM ||
        aiError.code === AIErrorType.MODEL_LOAD_FAILED
      ) {
        actions.push({
          label: t('升级显卡驱动'),
          action: () => openExternalLink('https://www.nvidia.com/Download/index.aspx'),
          variant: 'secondary'
        })
      }

      // 如果是 Llama 引擎未找到/部署失败错误，提供重新部署引擎按钮
      if (aiError.code === AIErrorType.ENGINE_NOT_FOUND) {
        actions.push({
          label: t('重新部署 AI 引擎'),
          action: handleRedeploy,
          variant: actions.length === 0 ? 'default' : 'secondary'
        })
      }

      // 如果是配置错误、显存不足、API 密钥缺失（排除已处理的 LOCAL_AI_UNSUPPORTED）
      if (
        (aiError.type === 'config' ||
          aiError.type === 'memory' ||
          aiError.code === AIErrorType.MODEL_LOAD_FAILED ||
          aiError.code === AIErrorType.API_KEY_MISSING) &&
        aiError.code !== AIErrorType.LOCAL_AI_UNSUPPORTED
      ) {
        let label = t('管理设置')
        if (aiError.code === AIErrorType.API_KEY_MISSING) {
          label = t('去配置 API 密钥')
        } else if (aiError.type === 'memory' || aiError.code === AIErrorType.MODEL_LOAD_FAILED) {
          label = t('管理模型')
        }
        actions.push({
          label,
          action: () => onOpenSettings?.(),
          variant: actions.length === 0 ? 'default' : 'secondary'
        })
      }

      // 兜底按钮：如果没有其他按钮，显示查看设置
      if (actions.length === 0) {
        // 如果可以重试，提供重试按钮
        if (aiError.canRetry) {
          actions.push({
            label: t('重试启动'),
            action: handleRetry,
            variant: actions.length === 0 ? 'default' : 'secondary'
          })
        }
        actions.push({
          label: t('查看设置'),
          action: () => onOpenSettings?.(),
          variant: 'secondary'
        })
      }

      // 始终提供切换到简单分类模式的选项
      actions.push({
        label: t('切换简单分类'),
        action: handleSwitchToSimple,
        variant: 'secondary'
      })

      return {
        title: completeInfo.title,
        description: aiError.details || completeInfo.userMessage,
        icon: ICON_MAP[completeInfo.iconName] || <XCircle />,
        suggestions: (aiError.suggestions && aiError.suggestions.length > 0
          ? aiError.suggestions
          : completeInfo.solutions
        ).concat(t('简单分类模式不依赖AI且高效，可快速完成文件分类和元数据提取')),
        actions
      }
    },
    [handleRetry, onOpenSettings, handleStartWithCpu, handleSwitchToCloud]
  )

  // 使用 useMemo 缓存错误信息
  const errorInfo = useMemo(() => {
    if (!error) return null
    return getErrorInfo(error)
  }, [error, getErrorInfo])

  if (!error || !errorInfo) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col bg-background border-border shadow-2xl p-0">
        <DialogHeader className="p-6 pb-2 text-left">
          <DialogTitle className="flex items-center gap-3 text-xl font-bold text-foreground">
            <span className="p-2 rounded-full bg-muted/50 shrink-0">
              {React.isValidElement(errorInfo.icon)
                ? React.cloneElement(errorInfo.icon as React.ReactElement<any>, {
                    className: 'h-6 w-6'
                  })
                : errorInfo.icon}
            </span>
            {errorInfo.title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-2 space-y-5">
          {/* 错误详情 */}
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 transition-colors">
            <div className="flex gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-destructive">{t('错误详情')}</p>
                <div className="text-sm text-foreground/90 font-mono break-all whitespace-pre-line leading-relaxed">
                  {error.message}
                  {(() => {
                    const detailContent = error.details || (error.context as any)?.originalError
                    if (!detailContent) return null
                    const formatted =
                      typeof detailContent === 'object'
                        ? detailContent.message || JSON.stringify(detailContent, null, 2)
                        : String(detailContent)
                    if (!formatted || formatted === '[object Object]') return null
                    return (
                      <div className="mt-2 pt-2 border-t border-destructive/10 text-xs opacity-80 italic">
                        {t('详细信息: ')}
                        {formatted}
                      </div>
                    )
                  })()}
                </div>
              </div>
            </div>
          </div>

          {/* 诊断信息 */}
          {error.diagnosticInfo && (
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex gap-3 mb-3">
                <HelpCircle className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
                <p className="text-sm font-semibold text-foreground">{t('系统诊断信息')}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-8 text-left">
                {error.diagnosticInfo?.systemMemory !== undefined && (
                  <div className="text-xs space-y-1">
                    <p className="text-muted-foreground">{t('系统内存')}</p>
                    <p className="font-medium text-foreground">
                      {error.diagnosticInfo.systemMemory} GB
                    </p>
                  </div>
                )}
                {error.diagnosticInfo?.availableVram !== undefined && (
                  <div className="text-xs space-y-1">
                    <p className="text-muted-foreground">{t('可用显存')}</p>
                    <p className="font-medium text-foreground">
                      {error.diagnosticInfo.availableVram} GB
                    </p>
                  </div>
                )}
                {error.diagnosticInfo?.modelFileExists !== undefined && (
                  <div className="text-xs space-y-1">
                    <p className="text-muted-foreground">{t('模型文件')}</p>
                    <p
                      className={
                        error.diagnosticInfo.modelFileExists
                          ? 'font-medium text-green-600 dark:text-green-400'
                          : 'font-medium text-destructive'
                      }
                    >
                      {error.diagnosticInfo.modelFileExists ? t('存在') : t('缺失')}
                    </p>
                  </div>
                )}
                {error.diagnosticInfo?.portAvailable !== undefined && (
                  <div className="text-xs space-y-1">
                    <p className="text-muted-foreground">{t('端口状态')}</p>
                    <p
                      className={
                        error.diagnosticInfo.portAvailable
                          ? 'font-medium text-green-600 dark:text-green-400'
                          : 'font-medium text-destructive'
                      }
                    >
                      {error.diagnosticInfo.portAvailable ? t('可用') : t('被占用')}
                    </p>
                  </div>
                )}
                {error.diagnosticInfo?.networkConnectivity !== undefined && (
                  <div className="text-xs space-y-1">
                    <p className="text-muted-foreground">{t('网络连接')}</p>
                    <p
                      className={
                        error.diagnosticInfo.networkConnectivity
                          ? 'font-medium text-green-600 dark:text-green-400'
                          : 'font-medium text-destructive'
                      }
                    >
                      {error.diagnosticInfo.networkConnectivity ? t('正常') : t('异常')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 解决建议 */}
          <div className="bg-muted/20 rounded-lg p-4 border border-border/50">
            <h4 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              {t('建议解决方案')}
            </h4>
            <ul className="space-y-2.5 text-left">
              {(errorInfo.suggestions || []).map((suggestion, index) => (
                <li
                  key={index}
                  className="flex items-start gap-3 text-sm text-muted-foreground leading-snug"
                >
                  <div className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary/40 shrink-0" />
                  {suggestion}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <DialogFooter className="p-6 pt-4 border-t bg-muted/10">
          <div className="flex flex-row flex-nowrap items-center gap-2.5 w-full py-1">
            {(errorInfo.actions || []).map((action, index) => (
              <Button
                key={index}
                variant={action.variant || 'default'}
                onClick={action.action}
                className={`flex-1 shrink-0 h-10 px-3 shadow-md transition-all hover:scale-[1.02] active:scale-[0.98] font-semibold whitespace-nowrap ${
                  action.variant === 'default'
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/20'
                    : ''
                }`}
              >
                {action.label.includes('CPU') && (
                  <Cpu className="h-4 w-4 mr-1.5 animate-pulse text-blue-200" />
                )}
                {action.label.includes('重试') && <RefreshCw className="h-4 w-4 mr-1.5" />}
                {(action.label.includes('设置') || action.label.includes('管理')) && (
                  <Settings className="h-4 w-4 mr-1.5" />
                )}
                {action.label.includes('下载') && <ExternalLink className="h-4 w-4 mr-1.5" />}
                {action.label}
                {action.variant === 'default' && (
                  <ChevronRight className="h-4 w-4 ml-1 opacity-50" />
                )}
              </Button>
            ))}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 使用AI服务错误对话框的Hook
 * 默认不再自动弹出，由用户点击Footer错误提示触发 openDialog 打开
 */
export const useAIServiceErrorDialog = () => {
  const { error, hasError, isErrorDialogOpen, openErrorDialog, closeErrorDialog } =
    useAIServiceError()

  return {
    isOpen: isErrorDialogOpen,
    openDialog: openErrorDialog,
    closeDialog: closeErrorDialog,
    hasError,
    error
  }
}
