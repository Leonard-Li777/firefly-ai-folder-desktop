import { useState, useEffect, useRef, useCallback } from 'react'
import { DownloadProgressEvent } from '@yonuc/types/types'
import { logger, LogCategory } from '@yonuc/shared'
import { t } from '@app/languages'
import { toast } from '../components/common/Toast'
import { useSettingsStore } from '../stores/settings-store'
import { captureEvent } from '../lib/posthog'

export interface ModelDownloadState {
  isDownloading: boolean
  isPaused: boolean
  progress: number
  receivedBytes: number
  totalBytes: number
  speedBps: number
  currentFileName?: string
  error?: string
  taskId?: string
  modelId: string
  downloadProgress?: DownloadProgressEvent | null
  retryCount: number
  status: 'pending' | 'downloading' | 'retrying' | 'completed' | 'error' | 'canceled'
}

export interface UseModelDownloadOptions {
  autoStart?: boolean
  onDownloadStart?: () => void
  onDownloadProgress?: (progress: DownloadProgressEvent) => void
  onDownloadComplete?: () => void
  onDownloadError?: (error: string) => void
  onDownloadCancel?: () => void
}

/**
 * 模型下载Hook
 * 封装断点续传、进度跟踪等逻辑
 */
export function useModelDownload(
  modelId: string,
  options: UseModelDownloadOptions = {}
): {
  state: ModelDownloadState
  startDownload: (
    targetModelId?: string | { forceRestart?: boolean; autoRetry?: boolean },
    options?: { forceRestart?: boolean; autoRetry?: boolean }
  ) => Promise<void>
  pauseDownload: () => Promise<void>
  resumeDownload: () => Promise<void>
  cancelDownload: () => Promise<void>
  checkDownloadStatus: () => Promise<{
    isDownloaded: boolean
    hasPartialFiles: boolean
    downloadProgress: number
    missingFiles: string[]
    existingFiles: Array<{ name: string; size: number; expectedSize: number }>
  }>
  retryDownload: () => Promise<void>
} {
  // 获取当前平台配置
  const { getConfigValue } = useSettingsStore()
  const aiEngine = getConfigValue<string>('AI_ENGINE')
  const isOllama = aiEngine === 'ollama'

  const [state, setState] = useState<ModelDownloadState>({
    isDownloading: false,
    isPaused: false,
    progress: 0,
    receivedBytes: 0,
    totalBytes: 0,
    speedBps: 0,
    error: undefined,
    taskId: undefined,
    modelId,
    downloadProgress: null,
    retryCount: 0,
    status: 'pending'
  })

  const progressRef = useRef<DownloadProgressEvent | null>(null)
  const taskIdRef = useRef<string | undefined>(undefined)
  const cleanupRef = useRef<(() => void)[]>([])
  
  // 使用 Ref 存储最新的 options 和 modelId，避免 useEffect 频繁触发
  const optionsRef = useRef(options)
  const modelIdRef = useRef(modelId)

  useEffect(() => {
    optionsRef.current = options
    // 更新 modelIdRef
    if (modelId) {
      if (modelIdRef.current !== modelId) {
        // 模型ID变更，重置状态
        modelIdRef.current = modelId
        setState(prev => ({
          ...prev,
          modelId,
          status: 'pending',
          progress: 0,
          receivedBytes: 0,
          totalBytes: 0,
          speedBps: 0,
          error: undefined,
          taskId: undefined,
          isDownloading: false,
          isPaused: false,
          downloadProgress: null
        }))
      }
    } else if (modelIdRef.current !== '') {
      // modelId 为空（停止追踪），重置状态
      modelIdRef.current = ''
      setState(prev => ({
        ...prev,
        modelId: '',
        status: 'pending',
        isDownloading: false,
        error: undefined,
        downloadProgress: null
      }))
    }
  }, [options, modelId])

  // 清理事件监听
  const cleanup = useCallback(() => {
    cleanupRef.current.forEach(fn => fn())
    cleanupRef.current = []
  }, [])

  // 检查下载状态
  const checkDownloadStatus = useCallback(async () => {
    // Ollama 模式下不支持此操作
    if (isOllama) {
      return {
        isDownloaded: false,
        hasPartialFiles: false,
        downloadProgress: 0,
        missingFiles: [],
        existingFiles: []
      }
    }

    try {
      if (!window.electronAPI?.modelDownload?.checkDownloadStatus) {
        throw new Error(t('IPC 接口不可用: modelDownload.checkDownloadStatus'))
      }
      const status = await window.electronAPI.modelDownload.checkDownloadStatus(modelId)
      logger.info(LogCategory.RENDERER, `[DownloadHook] 检查下载状态完成: ${modelId}`, status)
      return status
    } catch (error) {
      logger.error(LogCategory.RENDERER, `[DownloadHook] 检查下载状态失败: ${modelId}`, error)
      throw error
    }
  }, [modelId, isOllama])

  // 开始下载
  const startDownload = useCallback(async (
    targetModelId?: string | { forceRestart?: boolean; autoRetry?: boolean },
    downloadOptions?: { forceRestart?: boolean; autoRetry?: boolean }
  ) => {
    // 处理参数重载
    let finalModelId = modelId
    let finalOptions = downloadOptions

    if (typeof targetModelId === 'string') {
      finalModelId = targetModelId
      modelIdRef.current = targetModelId // 立即更新 Ref
    } else if (typeof targetModelId === 'object') {
      finalOptions = targetModelId
    }

    if (!finalModelId) {
      logger.warn(LogCategory.RENDERER, '[DownloadHook] 尝试下载但模型 ID 为空')
      return
    }

    try {
      logger.info(LogCategory.RENDERER, `[DownloadHook] 尝试开始下载模型 (${isOllama ? 'Ollama' : 'llama.cpp'}), ID: "${finalModelId}"`)
      
      captureEvent('model_download_started', { modelId: finalModelId, platform: isOllama ? 'ollama' : 'llama.cpp' })
      modelIdRef.current = finalModelId // 确保同步

      setState(prev => ({
        ...prev,
        isDownloading: true,
        isPaused: false,
        status: 'downloading',
        error: undefined,
        modelId: finalModelId // 确保状态中的 modelId 同步
      }))

      // Ollama 模式逻辑
      if (isOllama) {
        if (!window.electronAPI?.ollama?.pullModel) {
          throw new Error(t('IPC 接口不可用: ollama.pullModel'))
        }
        
        // 发送启动通知
        options.onDownloadStart?.()
        
        // 开始拉取 (异步)
        const result = await window.electronAPI.ollama.pullModel(finalModelId)
        if (!result.success) {
          throw new Error(result.error || t('拉取 Ollama 模型失败'))
        }
        return
      }

      // llama.cpp 模式逻辑
      // 如果是强制重新下载，先取消现有任务
      if (finalOptions?.forceRestart && taskIdRef.current) {
        try {
          if (window.electronAPI?.modelDownload?.cancelDownload) {
            await window.electronAPI.modelDownload.cancelDownload(taskIdRef.current)
          }
        } catch (err) {
          logger.warn(LogCategory.RENDERER, `[DownloadHook] 取消现有任务失败: ${taskIdRef.current}`, err)
        }
      }

      if (!window.electronAPI?.modelDownload?.startDownload) {
        throw new Error(t('IPC 接口不可用: modelDownload.startDownload'))
      }

      const task = await window.electronAPI.modelDownload.startDownload(finalModelId, {
        autoRetry: finalOptions?.autoRetry !== false
      })

      taskIdRef.current = task.taskId
      setState(prev => ({
        ...prev,
        taskId: task.taskId,
        totalBytes: task.totalBytes
      }))

      options.onDownloadStart?.()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.RENDERER, `[DownloadHook] '开始下载失败: ${finalModelId}`, error)
      
      // 添加 Toast 提示
      let displayError = errorMessage
      if (errorMessage.includes('Ollama 未安装') || errorMessage.includes('Ollama not installed')) {
        displayError = t('Ollama 未安装。如果已安装，请试着重启萤核智能文件夹，以再次检测')
      }
      toast.error(t('开始下载失败: {message}', { message: displayError }))

      setState(prev => ({
        ...prev,
        isDownloading: false,
        status: 'error',
        error: errorMessage
      }))

      options.onDownloadError?.(errorMessage)
    }
  }, [modelId, options, isOllama])

  // 暂停下载
  const pauseDownload = useCallback(async () => {
    if (isOllama || !taskIdRef.current) return

    try {
      if (window.electronAPI?.modelDownload?.pauseDownload) {
        await window.electronAPI.modelDownload.pauseDownload(taskIdRef.current)
      }
      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: true,
        status: 'pending'
      }))
    } catch (error) {
      logger.error(LogCategory.RENDERER, `[DownloadHook] 暂停下载失败: ${taskIdRef.current}`, error)
    }
  }, [isOllama])

  // 恢复下载
  const resumeDownload = useCallback(async () => {
    if (isOllama || !taskIdRef.current) return

    try {
      if (window.electronAPI?.modelDownload?.resumeDownload) {
        await window.electronAPI.modelDownload.resumeDownload(taskIdRef.current)
      }
      setState(prev => ({
        ...prev,
        isDownloading: true,
        isPaused: false,
        status: 'downloading'
      }))
    } catch (error) {
      logger.error(LogCategory.RENDERER, `[DownloadHook] 恢复下载失败: ${taskIdRef.current}`, error)
    }
  }, [isOllama])

  // 取消下载
  const cancelDownload = useCallback(async () => {
    if (isOllama || !taskIdRef.current) return

    const currentTaskId = taskIdRef.current;
    try {
      if (window.electronAPI?.modelDownload?.cancelDownload) {
        await window.electronAPI.modelDownload.cancelDownload(currentTaskId)
      }
      
      // 立即更新本地状态，不再等待事件，防止 UI 延迟
      taskIdRef.current = undefined;
      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'canceled',
        error: undefined,
        taskId: undefined
      }))
      
      options.onDownloadCancel?.()
      logger.info(LogCategory.RENDERER, `[DownloadHook] 下载任务已取消: ${currentTaskId}`)
    } catch (error) {
      logger.error(LogCategory.RENDERER, `[DownloadHook] 取消下载失败: ${currentTaskId}`, error)
    }
  }, [options, isOllama])

  // 重试下载
  const retryDownload = useCallback(async () => {
    if (isOllama) return
    setState(prev => ({
      ...prev,
      retryCount: prev.retryCount + 1,
      error: undefined
    }))
    await startDownload({ forceRestart: true })
  }, [startDownload, isOllama])

  // 设置事件监听
  useEffect(() => {
    if (!window.electronAPI) return

    // Ollama 模式监听
    if (isOllama) {
      const unsubscribeOllamaProgress = window.electronAPI.onOllamaModelProgress((data: any) => {
        if (data.modelId !== modelIdRef.current) return
        
        setState(prev => {
          // 如果已经完成或报错，不再接收后续进度干扰（防止 race condition）
          if (prev.status === 'completed' || prev.status === 'error') {
            return prev;
          }
          
          const percent = data.percent ?? prev.progress;
          return {
            ...prev,
            progress: percent,
            currentFileName: data.message,
            isDownloading: true,
            status: 'downloading',
            downloadProgress: {
              taskId: `ollama-${data.modelId}`,
              modelId: data.modelId,
              percent: percent,
              receivedBytes: 0,
              totalBytes: 0,
              status: 'downloading',
              fileName: data.message
            }
          }
        })
      })

      const unsubscribeOllamaStatus = window.electronAPI.onOllamaModelStatusChanged((data: any) => {
        if (data.modelId !== modelIdRef.current) return
        
        if (data.status === 'downloaded') {
          setState(prev => ({
            ...prev,
            isDownloading: false,
            status: 'completed',
            progress: 100,
            downloadProgress: {
               ...(prev.downloadProgress || {}),
               taskId: `ollama-${data.modelId}`,
               modelId: data.modelId,
               percent: 100,
               status: 'completed'
               } as any
               }))
               captureEvent('模型下载完成', { modelId: modelIdRef.current, platform: 'ollama' })
               optionsRef.current.onDownloadComplete?.()
               } else if (data.status === 'error') {
               toast.error(t('下载失败'))
               setState(prev => ({
               ...prev,
               isDownloading: false,
               status: 'error',
               error: t('下载失败')
               }))
               captureEvent('模型下载失败', { modelId: modelIdRef.current, platform: 'ollama', error: 'Ollama error' })
               optionsRef.current.onDownloadError?.(t('下载失败'))
               }
      })

      cleanupRef.current = [unsubscribeOllamaProgress, unsubscribeOllamaStatus]
      return cleanup
    }

    // llama.cpp 模式监听
    // 下载进度监听
    const unsubscribeProgress = window.electronAPI.onModelDownloadProgress((payload: any) => {
      // 使用 Ref 检查 ID，避免闭包陈旧问题
      if (payload.modelId !== modelIdRef.current) return

      progressRef.current = payload
      setState(prev => {
        const newState = {
          ...prev,
          progress: payload.percent !== undefined ? payload.percent : prev.progress,
          receivedBytes: payload.receivedBytes || prev.receivedBytes,
          totalBytes: payload.totalBytes || prev.totalBytes,
          speedBps: payload.speedBps || prev.speedBps,
          currentFileName: payload.fileName || prev.currentFileName,
          downloadProgress: payload,
          status: (payload.status || 'downloading') as any
        }
        return newState
      })

      optionsRef.current.onDownloadProgress?.(payload)
    })

    // 下载完成监听
    const unsubscribeComplete = window.electronAPI.onModelDownloadComplete((payload: any) => {
      if (payload.modelId !== modelIdRef.current) return

      logger.info(LogCategory.RENDERER, `[DownloadHook] 下载完成: ${modelIdRef.current}`, payload)
      captureEvent('model_download_completed', { modelId: modelIdRef.current, platform: 'llama.cpp' })
      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'completed',
        progress: 100,
        receivedBytes: payload.totalBytes || prev.receivedBytes,
        downloadProgress: payload
      }))

      optionsRef.current.onDownloadComplete?.()
    })

    // 下载错误监听
    const unsubscribeError = window.electronAPI.onModelDownloadError((payload: any) => {
      if (payload.modelId !== modelIdRef.current) return

      const errorMessage = payload.error || t('下载失败')
      logger.error(LogCategory.RENDERER, `[DownloadHook] 下载错误: ${modelIdRef.current}`, payload)
      captureEvent('model_download_failed', { modelId: modelIdRef.current, platform: 'llama.cpp', error: errorMessage })
      
      toast.error(t('下载出错: {message}', { message: errorMessage }))

      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'error',
        error: errorMessage,
        downloadProgress: payload
      }))

      optionsRef.current.onDownloadError?.(errorMessage)
    })

    // 添加到清理列表
    cleanupRef.current = [unsubscribeProgress, unsubscribeComplete, unsubscribeError]

    return cleanup
  }, [cleanup, isOllama]) // 不再依赖 modelId 和 options，只在初始化或 cleanup 变化时重连

  // 检查当前任务状态
  useEffect(() => {
    const checkCurrentTask = async () => {
      if (!window.electronAPI || !modelId) return
      
      // 处理 Ollama 模式的状态同步
      if (isOllama) {
        try {
          // Ollama 模式下，直接使用 checkModelsStatus 或类似的全局状态检查
          const allStatus = await window.electronAPI.checkModelsStatus();
          const status = allStatus[modelId];
          
          if (status && !status.isDownloaded && status.downloadProgress !== undefined) {
            setState(prev => {
              // 如果进度没变且已经在下载中，跳过更新
              if (prev.isDownloading && prev.progress === status.downloadProgress) return prev;
              
              return {
                ...prev,
                isDownloading: true,
                status: 'downloading',
                progress: status.downloadProgress,
                downloadProgress: {
                  taskId: `ollama-${modelId}`,
                  modelId: modelId,
                  percent: status.downloadProgress,
                  receivedBytes: 0,
                  totalBytes: 0,
                  status: 'downloading',
                  fileName: prev.currentFileName || ''
                }
              };
            });
          }
        } catch (error) {
          logger.warn(LogCategory.RENDERER, `[DownloadHook] Ollama 状态检查失败:`, error);
        }
        return;
      }

      try {
        if (taskIdRef.current) {
          if (window.electronAPI.modelDownload?.getTaskStatus) {
            const task = await window.electronAPI.modelDownload.getTaskStatus(taskIdRef.current)
            if (task) {
              setState(prev => {
                // 如果状态已经是完成或错误，且后端也一致，则跳过
                if (prev.status === task.status && prev.progress === task.progress) return prev;
                
                return {
                  ...prev,
                  isDownloading: ['downloading', 'retrying', 'pending'].includes(task.status),
                  isPaused: task.status === 'paused', // 修正暂停状态判定
                  status: task.status,
                  progress: task.progress !== undefined ? task.progress : prev.progress,
                  receivedBytes: task.receivedBytes || 0,
                  totalBytes: task.totalBytes || prev.totalBytes,
                  speedBps: task.speedBps || 0,
                  currentFileName: task.currentFileName || task.fileName,
                  error: task.error
                };
              })
            } else {
              // 任务已结束或不存在
              // 这里不强制重置，因为可能是刚刚完成，状态通过事件已经更新了
              logger.debug(LogCategory.RENDERER, `[DownloadHook] 轮询任务 ${taskIdRef.current} 返回空，可能已完成或已移除`);
            }
          }
        } else {
          // 没有任务ID时，检查该模型是否正在下载
          if (window.electronAPI.modelDownload?.getModelTask) {
            const modelTask = await window.electronAPI.modelDownload.getModelTask(modelId)
            if (modelTask) {
              taskIdRef.current = modelTask.taskId
              setState(prev => ({
                ...prev,
                taskId: modelTask.taskId,
                isDownloading: ['downloading', 'retrying', 'pending'].includes(modelTask.status),
                status: modelTask.status,
                progress: modelTask.progress !== undefined ? modelTask.progress : prev.progress,
                receivedBytes: modelTask.receivedBytes || 0,
                totalBytes: modelTask.totalBytes || prev.totalBytes,
                speedBps: modelTask.speedBps || 0,
                currentFileName: modelTask.currentFileName || modelTask.fileName
              }))
            }
          }
        }
      } catch (error) {
        logger.warn(LogCategory.RENDERER, `[DownloadHook] 检查任务状态轮询异常:`, error)
      }
    }

    checkCurrentTask()
    const interval = setInterval(checkCurrentTask, 2000) // 每2秒检查一次状态

    return () => clearInterval(interval)
  }, [modelId, isOllama])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return {
    state,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    checkDownloadStatus,
    retryDownload
  }
}
