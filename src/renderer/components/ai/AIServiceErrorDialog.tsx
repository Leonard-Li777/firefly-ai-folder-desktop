/**
 * AI服务错误对话框组件
 * 显示用户友好的AI服务启动错误信息和解决建议
 */

import { Alert, AlertDescription } from '../ui/alert'
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, Settings, XCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAIServiceError, useAIServiceStatus } from '../../stores/ai-service-store'

import { Button } from '../ui/button'
import { t } from '@app/languages'

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
}

/**
 * 错误类型枚举（与AIServiceError保持一致）
 */
enum ErrorType {
  MEMORY = 'memory',
  MODEL = 'model',
  COMPATIBILITY = 'compatibility',
  NETWORK = 'network',
  PORT = 'port',
  CONFIG = 'config',
  UNKNOWN = 'unknown'
}

/**
 * 错误信息接口
 */
interface IErrorInfo {
  type: ErrorType
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
 * AI服务错误对话框组件
 */
export const AIServiceErrorDialog: React.FC<IAIServiceErrorDialogProps> = ({
  open,
  onClose,
  onOpenSettings
}) => {
  const { initializeAIService } = useAIServiceStatus()
  const { error, clearError } = useAIServiceError()

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
   * 处理重置
   */
  const handleReset = useCallback(() => {
    clearError()
    onClose()
  }, [clearError, onClose])

  /**
   * 获取错误信息（基于AIServiceError类型）
   */
  const getErrorInfo = useCallback(
    (aiError: import('@yonuc/types').AIServiceError): IErrorInfo => {
      const errorType = aiError.type as ErrorType

      switch (errorType) {
        case ErrorType.MEMORY:
          return {
            type: ErrorType.MEMORY,
            title: t('系统内存不足'),
            description:
              aiError.details || t('当前系统可用内存不足以启动AI服务。AI模型需要较多内存来运行。'),
            icon: <AlertTriangle className="h-6 w-6 text-orange-500" />,
            suggestions: aiError.suggestions,
            actions: [
              {
                label: aiError.canSwitchModel ? t('选择其他模型') : t('管理设置'),
                action: () => onOpenSettings?.(),
                variant: 'default'
              },
              ...(aiError.canRetry
                ? [
                    {
                      label: t('重试'),
                      action: handleRetry,
                      variant: 'outline' as const
                    }
                  ]
                : [])
            ]
          }

        case ErrorType.MODEL:
          return {
            type: ErrorType.MODEL,
            title: t('AI模型问题'),
            description: aiError.details || t('选择的AI模型未下载或文件损坏。请检查模型状态。'),
            icon: <XCircle className="h-6 w-6 text-red-500" />,
            suggestions: aiError.suggestions,
            actions: [
              {
                label: t('管理模型'),
                action: () => onOpenSettings?.(),
                variant: 'default'
              },
              ...(aiError.canRetry
                ? [
                    {
                      label: t('重试'),
                      action: handleRetry,
                      variant: 'outline' as const
                    }
                  ]
                : [])
            ]
          }

        case ErrorType.COMPATIBILITY:
          return {
            type: ErrorType.COMPATIBILITY,
            title: t('模型兼容性问题'),
            description:
              aiError.details || t('当前AI模型与系统不兼容。可能是模型架构不支持或版本不匹配。'),
            icon: <AlertTriangle className="h-6 w-6 text-yellow-500" />,
            suggestions: aiError.suggestions,
            actions: [
              {
                label: t('选择兼容模型'),
                action: () => onOpenSettings?.(),
                variant: 'default'
              },
              ...(aiError.canRetry
                ? [
                    {
                      label: t('重试'),
                      action: handleRetry,
                      variant: 'outline' as const
                    }
                  ]
                : [])
            ]
          }

        case ErrorType.NETWORK:
        case ErrorType.PORT:
          return {
            type: ErrorType.NETWORK,
            title: t('网络端口问题'),
            description: aiError.details || t('AI服务所需的网络端口被占用或无法访问。'),
            icon: <AlertTriangle className="h-6 w-6 text-blue-500" />,
            suggestions: aiError.suggestions,
            actions: [
              ...(aiError.canRetry
                ? [
                    {
                      label: t('重试'),
                      action: handleRetry,
                      variant: 'default' as const
                    }
                  ]
                : [])
            ]
          }

        case ErrorType.CONFIG:
          return {
            type: ErrorType.CONFIG,
            title: t('配置错误'),
            description: aiError.details || t('AI服务配置存在问题。'),
            icon: <Settings className="h-6 w-6 text-purple-500" />,
            suggestions: aiError.suggestions,
            actions: [
              {
                label: t('打开设置'),
                action: () => onOpenSettings?.(),
                variant: 'default'
              },
              ...(aiError.canRetry
                ? [
                    {
                      label: t('重试'),
                      action: handleRetry,
                      variant: 'outline' as const
                    }
                  ]
                : [])
            ]
          }

        default:
          return {
            type: ErrorType.UNKNOWN,
            title: t('AI服务启动失败'),
            description: aiError.details || aiError.message,
            icon: <XCircle className="h-6 w-6 text-gray-500" />,
            suggestions: aiError.suggestions,
            actions: [
              ...(aiError.canRetry
                ? [
                    {
                      label: t('重试'),
                      action: handleRetry,
                      variant: 'default' as const
                    }
                  ]
                : []),
              {
                label: t('打开设置'),
                action: () => onOpenSettings?.(),
                variant: 'outline'
              }
            ]
          }
      }
    },
    [handleRetry, onOpenSettings]
  )

  // 使用 useMemo 缓存错误信息，避免重复计算
  const errorInfo = useMemo(() => {
    if (!error) return null
    return getErrorInfo(error)
  }, [error, getErrorInfo])

  if (!error || !errorInfo) {
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {errorInfo.icon}
            {errorInfo.title}
          </DialogTitle>
          <DialogDescription className="text-left">{errorInfo.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 错误详情 */}
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="whitespace-pre-line">
              {error.message}
              {error.details && (
                <>
                  {'\n\n' + t('详细信息: ')}
                  {error.details}
                </>
              )}
            </AlertDescription>
          </Alert>

          {/* 诊断信息 */}
          {error.diagnosticInfo && (
            <Alert>
              <HelpCircle className="h-4 w-4" />
              <AlertDescription>
                <div className="text-sm">
                  <strong>{t('系统诊断信息:')}</strong>
                  <ul className="mt-1 space-y-1">
                    {error.diagnosticInfo.systemMemory && (
                      <li>
                        {t('系统内存: {systemMemory} GB', {
                          systemMemory: error.diagnosticInfo.systemMemory
                        })}
                      </li>
                    )}
                    {error.diagnosticInfo.availableVram && (
                      <li>
                        {t('可用显存: {availableVram} GB', {
                          availableVram: error.diagnosticInfo.availableVram
                        })}
                      </li>
                    )}
                    {error.diagnosticInfo.modelFileExists !== undefined && (
                      <li>
                        {t('模型文件: {modelFileExists}', {
                          modelFileExists: error.diagnosticInfo.modelFileExists
                            ? t('存在')
                            : t('缺失')
                        })}
                      </li>
                    )}
                    {error.diagnosticInfo.portAvailable !== undefined && (
                      <li>
                        {t('端口状态: {portAvailable}', {
                          portAvailable: error.diagnosticInfo.portAvailable
                            ? t('可用')
                            : t('被占用')
                        })}
                      </li>
                    )}
                    {error.diagnosticInfo.networkConnectivity !== undefined && (
                      <li>
                        {t('网络连接: {networkConnectivity}', {
                          networkConnectivity: error.diagnosticInfo.networkConnectivity
                            ? t('正常')
                            : t('异常')
                        })}
                      </li>
                    )}
                  </ul>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* 解决建议 */}
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <HelpCircle className="h-4 w-4" />
              {t('建议解决方案')}
            </h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              {errorInfo.suggestions.map((suggestion, index) => (
                <li key={index} className="flex items-start gap-2">
                  <CheckCircle2 className="h-3 w-3 mt-0.5 text-green-500 flex-shrink-0" />
                  {suggestion}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <div className="flex gap-2 w-full sm:w-auto">
            {errorInfo.actions.map((action, index) => (
              <Button
                key={index}
                variant={action.variant || 'default'}
                onClick={action.action}
                className="flex-1 sm:flex-none"
              >
                {action.label === t('重试') && <RefreshCw className="h-4 w-4 mr-2" />}
                {action.label.includes(t('设置')) && <Settings className="h-4 w-4 mr-2" />}
                {action.label}
              </Button>
            ))}
          </div>

          <div className="flex gap-2 w-full sm:w-auto">
            <Button variant="ghost" onClick={handleReset} className="flex-1 sm:flex-none">
              {t('忽略错误')}
            </Button>
            <Button variant="outline" onClick={onClose} className="flex-1 sm:flex-none">
              {t('关闭')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 使用AI服务错误对话框的Hook
 */
export const useAIServiceErrorDialog = () => {
  const [isOpen, setIsOpen] = useState(false)
  const { error, hasError } = useAIServiceError()

  // 使用 useMemo 缓存错误状态，避免不必要的重新计算
  const shouldShowDialog = useMemo(() => {
    return hasError && error !== null
  }, [hasError, error])

  // 使用 useEffect 但避免无限循环，添加更严格的条件检查
  useEffect(() => {
    // 只有在状态真正需要改变时才更新
    if (shouldShowDialog && !isOpen) {
      setIsOpen(true)
    } else if (!shouldShowDialog && isOpen) {
      setIsOpen(false)
    }
  }, [shouldShowDialog]) // 移除 isOpen 依赖，避免循环

  // 使用 useCallback 缓存回调函数
  const openDialog = useCallback(() => {
    setIsOpen(true)
  }, [])

  const closeDialog = useCallback(() => {
    setIsOpen(false)
  }, [])

  return {
    isOpen,
    openDialog,
    closeDialog,
    hasError,
    error
  }
}
