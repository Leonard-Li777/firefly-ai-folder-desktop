import { useState, useEffect, useRef, useCallback } from 'react'
import { DownloadProgressEvent } from '@firefly/types/types'
import { logger, LogCategory } from '@firefly/shared'
import { t } from '@app/languages'
import { toast } from '../components/common/Toast'
import { useSettingsStore } from '../stores/settings-store'
import { captureEvent } from '../lib/posthog'

// PRD-0042：本地模型下载已外置到 Tier 2 引擎，preload 已删除 modelDownload 块。
// 用本地可选类型访问，保留旧调用点的“接口不可用”降级语义，避免 ElectronAPI 类型断裂。
type ModelDownloadBridge = {
  checkDownloadStatus?: (
    modelId: string,
    source?: string
  ) => Promise<{
    isDownloaded: boolean
    hasPartialFiles: boolean
    downloadProgress: number
    missingFiles: string[]
    existingFiles: Array<{ name: string; size: number; expectedSize: number }>
  }>
  startDownload?: (
    modelId: string,
    options?: { autoRetry?: boolean; source?: string }
  ) => Promise<{ taskId: string; totalBytes: number }>
  pauseDownload?: (taskId: string) => Promise<void>
  resumeDownload?: (taskId: string) => Promise<void>
  cancelDownload?: (taskId: string) => Promise<void>
  getTaskStatus?: (taskId: string) => Promise<{
    status: ModelDownloadState['status'] | 'paused'
    progress?: number
    receivedBytes?: number
    totalBytes?: number
    speedBps?: number
    currentFileName?: string
    fileName?: string
    fileIndex?: number
    totalFiles?: number
    error?: string
  } | null>
  getModelTask?: (
    modelId: string,
    source?: string
  ) => Promise<{
    taskId: string
    status: ModelDownloadState['status'] | 'paused'
    progress?: number
    receivedBytes?: number
    totalBytes?: number
    speedBps?: number
    currentFileName?: string
    fileName?: string
    fileIndex?: number
    totalFiles?: number
  } | null>
}

const getModelDownloadBridge = (): ModelDownloadBridge | undefined =>
  (window.electronAPI as typeof window.electronAPI & { modelDownload?: ModelDownloadBridge })
    ?.modelDownload

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
  fileIndex?: number
  totalFiles?: number
}

export interface UseModelDownloadOptions {
  autoStart?: boolean
  source?: string
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
    targetModelId?: string | { forceRestart?: boolean; autoRetry?: boolean; source?: string },
    options?: { forceRestart?: boolean; autoRetry?: boolean; source?: string }
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
    status: 'pending',
    fileIndex: 0,
    totalFiles: 1
  })

  const progressRef = useRef<DownloadProgressEvent | null>(null)
  const taskIdRef = useRef<string | undefined>(undefined)
  const cleanupRef = useRef<(() => void)[]>([])

  // 使用 Ref 存储最新的 options 和 modelId，避免 useEffect 频繁触发
  const optionsRef = useRef(options)
  const modelIdRef = useRef(modelId)
  const sourceRef = useRef(options.source)

  useEffect(() => {
    optionsRef.current = options
    sourceRef.current = options.source
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
      const modelDownload = getModelDownloadBridge()
      if (!modelDownload?.checkDownloadStatus) {
        throw new Error(t('IPC 接口不可用: modelDownload.checkDownloadStatus'))
      }
      const status = await modelDownload.checkDownloadStatus(
        modelId,
        sourceRef.current
      )
      logger.info(
        LogCategory.RENDERER,
        `[DownloadHook] 检查下载状态完成: ${modelId} source: ${sourceRef.current}`,
        status
      )
      return status
    } catch (error) {
      logger.error(
        LogCategory.RENDERER,
        `[DownloadHook] 检查下载状态失败: ${modelId} source: ${sourceRef.current}`,
        error
      )
      throw error
    }
  }, [modelId, isOllama])

  // 开始下载
  const startDownload = useCallback(
    async (
      targetModelId?: string | { forceRestart?: boolean; autoRetry?: boolean; source?: string },
      downloadOptions?: { forceRestart?: boolean; autoRetry?: boolean; source?: string }
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
        logger.info(
          LogCategory.RENDERER,
          `[DownloadHook] 尝试开始下载模型 (${isOllama ? 'Ollama' : 'llama.cpp'}), ID: "${finalModelId}"`
        )

        captureEvent('model_download_started', {
          modelId: finalModelId,
          platform: isOllama ? 'ollama' : 'llama.cpp'
        })
        modelIdRef.current = finalModelId // 确保同步

        setState(prev => ({
          ...prev,
          isDownloading: true,
          isPaused: false,
          status: 'downloading',
          error: undefined,
          modelId: finalModelId // 确保状态中的 modelId 同步
        }))

        // Ollama 内置推理已清退（PRD-0042）：残留 AI_ENGINE=ollama 时直接抛错，
  // 不再调用已删除的 ollama:* IPC（主进程 ollama-ipc-handler 已删）。
        if (isOllama) {
          throw new Error(t('IPC 接口不可用: ollama.pullModel（已清退，AI_ENGINE=ollama 请改用本地 Tier 2 引擎）'))
        }

        // llama.cpp 模式逻辑
        // 如果是强制重新下载，先取消现有任务
        if (finalOptions?.forceRestart && taskIdRef.current) {
          try {
            const cancelApi = getModelDownloadBridge()?.cancelDownload
            if (cancelApi) {
              await cancelApi(taskIdRef.current)
            }
          } catch (err) {
            logger.warn(
              LogCategory.RENDERER,
              `[DownloadHook] 取消现有任务失败: ${taskIdRef.current}`,
              err
            )
          }
        }

        const startApi = getModelDownloadBridge()?.startDownload
        if (!startApi) {
          throw new Error(t('IPC 接口不可用: modelDownload.startDownload'))
        }

        const task = await startApi(finalModelId, {
          autoRetry: finalOptions?.autoRetry !== false,
          source: finalOptions?.source || sourceRef.current
        })

        taskIdRef.current = task.taskId
        setState(prev => ({
          ...prev,
          taskId: task.taskId,
          totalBytes: task.totalBytes
        }))

        options.onDownloadStart?.()
      } catch (error: any) {
        const errorMessage = error?.message || (typeof error === 'string' ? error : t('未知错误'))
        logger.error(LogCategory.RENDERER, `[DownloadHook] '开始下载失败: ${finalModelId}`, error)

        // 添加 Toast 提示
        let displayError = errorMessage
        if (
          errorMessage.includes(t('Ollama 未安装')) ||
          errorMessage.includes('Ollama not installed')
        ) {
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
    },
    [modelId, options, isOllama]
  )

  // 暂停下载
  const pauseDownload = useCallback(async () => {
    if (isOllama || !taskIdRef.current) return

    try {
      const pauseApi = getModelDownloadBridge()?.pauseDownload
      if (pauseApi) {
        await pauseApi(taskIdRef.current)
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
      const resumeApi = getModelDownloadBridge()?.resumeDownload
      if (resumeApi) {
        await resumeApi(taskIdRef.current)
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

    const currentTaskId = taskIdRef.current
    try {
      const cancelApi = getModelDownloadBridge()?.cancelDownload
      if (cancelApi) {
        await cancelApi(currentTaskId)
      }

      // 立即更新本地状态，不再等待事件，防止 UI 延迟
      taskIdRef.current = undefined
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

    // 如果未处于下载或拉取中，直接清理所有监听，不重复注册
    if (!state.isDownloading) {
      cleanup()
      return
    }

    // Ollama 进度/状态监听已随 ollama-ipc-handler 清退（PRD-0042）：
    // 残留 isOllama 分支不再注册任何监听，直接走 llama.cpp 模式监听路径。

    // llama.cpp 模式监听
    // 下载进度监听
    const unsubscribeProgress = window.electronAPI.onModelDownloadProgress((payload: any) => {
      // 使用 Ref 检查 ID，避免闭包陈旧问题
      if (payload.modelId !== modelIdRef.current) return
      if (sourceRef.current && payload.source && payload.source !== sourceRef.current) return

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
          status: (payload.status || 'downloading') as any,
          fileIndex: payload.fileIndex ?? prev.fileIndex,
          totalFiles: payload.totalFiles ?? prev.totalFiles
        }
        return newState
      })

      optionsRef.current.onDownloadProgress?.(payload)
    })

    // 下载完成监听
    const unsubscribeComplete = window.electronAPI.onModelDownloadComplete((payload: any) => {
      if (payload.modelId !== modelIdRef.current) return
      if (sourceRef.current && payload.source && payload.source !== sourceRef.current) return

      logger.info(LogCategory.RENDERER, `[DownloadHook] 下载完成: ${modelIdRef.current}`, payload)
      captureEvent('model_download_completed', {
        modelId: modelIdRef.current,
        platform: 'llama.cpp'
      })
      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'completed',
        progress: 100,
        receivedBytes: payload.totalBytes || prev.receivedBytes,
        downloadProgress: payload,
        fileIndex: payload.fileIndex ?? prev.fileIndex,
        totalFiles: payload.totalFiles ?? prev.totalFiles
      }))

      optionsRef.current.onDownloadComplete?.()
    })

    // 下载错误监听
    const unsubscribeError = window.electronAPI.onModelDownloadError((payload: any) => {
      if (payload.modelId !== modelIdRef.current) return
      if (sourceRef.current && payload.source && payload.source !== sourceRef.current) return

      const errorMessage =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message || payload.error?.details || t('下载失败')
      logger.error(LogCategory.RENDERER, `[DownloadHook] 下载错误: ${modelIdRef.current}`, payload)
      captureEvent('model_download_failed', {
        modelId: modelIdRef.current,
        platform: 'llama.cpp',
        error: errorMessage
      })

      toast.error(t('下载出错: {message}', { message: errorMessage }))

      setState(prev => ({
        ...prev,
        isDownloading: false,
        isPaused: false,
        status: 'error',
        error: errorMessage,
        downloadProgress: payload,
        fileIndex: payload.fileIndex ?? prev.fileIndex,
        totalFiles: payload.totalFiles ?? prev.totalFiles
      }))

      optionsRef.current.onDownloadError?.(errorMessage)
    })

    // 添加到清理列表
    cleanupRef.current = [unsubscribeProgress, unsubscribeComplete, unsubscribeError]

    return cleanup
  }, [cleanup, isOllama, state.isDownloading])

  // 检查当前任务状态
  useEffect(() => {
    const checkCurrentTask = async () => {
      if (!window.electronAPI || !modelId) return

      // 处理 Ollama 模式的状态同步
      if (isOllama) {
        try {
          // Ollama 模式下，直接使用 checkModelsStatus 或类似的全局状态检查
          const allStatus = await window.electronAPI.checkModelsStatus()
          const status = allStatus[`${modelId}@ollama`] || allStatus[modelId]

          if (status && !status.isDownloaded && status.downloadProgress !== undefined) {
            setState(prev => {
              // 如果进度没变且已经在下载中，跳过更新
              if (prev.isDownloading && prev.progress === status.downloadProgress) return prev

              return {
                ...prev,
                isDownloading: true,
                status: 'downloading',
                progress: status.downloadProgress || 0,
                downloadProgress: {
                  taskId: `ollama-${modelId}`,
                  modelId: modelId,
                  percent: status.downloadProgress || 0,
                  receivedBytes: 0,
                  totalBytes: 0,
                  status: 'downloading',
                  fileName: prev.currentFileName || ''
                }
              }
            })
          }
        } catch (error) {
          logger.warn(LogCategory.RENDERER, `[DownloadHook] Ollama 状态检查失败:`, error)
        }
        return
      }

      try {
        if (taskIdRef.current) {
          const getTaskStatus = getModelDownloadBridge()?.getTaskStatus
          if (getTaskStatus) {
            const task = await getTaskStatus(taskIdRef.current)
            if (task) {
              setState(prev => {
                // 如果状态已经是完成或错误，且后端也一致，则跳过
                if (prev.status === task.status && prev.progress === task.progress) return prev

return {
                  ...prev,
                  isDownloading: ['downloading', 'retrying', 'pending'].includes(task.status),
                  isPaused: task.status === 'paused', // 修正暂停状态判定
                  // ModelDownloadState['status'] 不含 'paused'，暂停以 isPaused 表达，status 回落 pending
                  status: task.status === 'paused' ? 'pending' : task.status,
                  progress: task.progress !== undefined ? task.progress : prev.progress,
                  receivedBytes: task.receivedBytes || 0,
                  totalBytes: task.totalBytes || prev.totalBytes,
                  speedBps: task.speedBps || 0,
                  currentFileName: task.currentFileName || task.fileName,
                  fileIndex: task.fileIndex ?? prev.fileIndex,
                  totalFiles: task.totalFiles ?? prev.totalFiles,
                  error: task.error
                }
              })
            } else {
              // 任务已结束或不存在
              // 这里不强制重置，因为可能是刚刚完成，状态通过事件已经更新了
              logger.debug(
                LogCategory.RENDERER,
                `[DownloadHook] 轮询任务 ${taskIdRef.current} 返回空，可能已完成或已移除`
              )
            }
          }
        } else {
          // 没有任务ID时，检查该模型是否正在下载
          const getModelTask = getModelDownloadBridge()?.getModelTask
          if (getModelTask) {
            const modelTask = await getModelTask(
              modelId,
              sourceRef.current
            )
            if (modelTask) {
              taskIdRef.current = modelTask.taskId
              setState(prev => ({
                ...prev,
                taskId: modelTask.taskId,
                isDownloading: ['downloading', 'retrying', 'pending'].includes(modelTask.status),
                isPaused: modelTask.status === 'paused',
                status: modelTask.status === 'paused' ? 'pending' : modelTask.status,
                progress: modelTask.progress !== undefined ? modelTask.progress : prev.progress,
                receivedBytes: modelTask.receivedBytes || 0,
                totalBytes: modelTask.totalBytes || prev.totalBytes,
                speedBps: modelTask.speedBps || 0,
                currentFileName: modelTask.currentFileName || modelTask.fileName,
                fileIndex: modelTask.fileIndex ?? prev.fileIndex,
                totalFiles: modelTask.totalFiles ?? prev.totalFiles
              }))
            }
          }
        }
      } catch (error) {
        logger.warn(LogCategory.RENDERER, `[DownloadHook] 检查任务状态轮询异常:`, error)
      }
    }

    checkCurrentTask()

    // 性能优化：仅在当前模型处于活跃下载/重试/等待状态时，才启动 2 秒轮询保底；未下载/已完成模型不常驻定时器
    if (state.isDownloading || ['downloading', 'pending', 'retrying'].includes(state.status)) {
      const interval = setInterval(checkCurrentTask, 2000)
      return () => clearInterval(interval)
    }
  }, [modelId, isOllama, state.isDownloading, state.status])

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
