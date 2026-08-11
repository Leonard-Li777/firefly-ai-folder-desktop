import { LogCategory, logger } from '@firefly/shared'
import { useEffect, useRef } from 'react'

import { AIClassificationResult } from '@firefly/types'
import { t } from '@app/languages'

/**
 * AI分类处理器组件
 * 这个组件在后台运行，处理来自主进程的AI分类请求
 */
export const AIClassificationHandler: React.FC = () => {
  // 使用 useRef 来存储正在处理的请求 ID，避免重复处理
  const processingRequests = useRef<Set<string>>(new Set())

  useEffect(() => {
    logger.info(LogCategory.AI_SERVICE, '[AI Classification Handler] 组件已加载')

    // 处理来自主进程的AI分类请求
    const handleClassificationRequest = async (
      _event: any,
      request: {
        id: string
        modelId: string
        prompt: string
        filename: string
      }
    ) => {
      // 检查是否已经在处理这个请求
      if (processingRequests.current.has(request.id)) {
        logger.info(
          LogCategory.AI_SERVICE,
          '[AI Classification Handler] 请求已在处理中，跳过:',
          request.filename
        )
        return
      }

      // 标记请求为正在处理
      processingRequests.current.add(request.id)

      try {
        logger.info(
          LogCategory.AI_SERVICE,
          '[AI Classification Handler] 收到分类请求:',
          request.filename
        )

        // 直接在渲染进程中进行AI分类，避免循环调用
        logger.info(
          LogCategory.AI_SERVICE,
          '[AI Classification Handler] 开始本地AI分类:',
          request.filename,
          { modelId: request.modelId, promptLength: request.prompt.length }
        )

        // 检查是否有可用的AI模型服务
        if (!(window as any).electronLLM) {
          throw new Error(t('AI模型服务不可用'))
        }

        // 确保AI服务已初始化
        const status = await (window as any).electronLLM.checkStatus()
        if (
          (status as unknown as string) !== 'loaded' &&
          (status as unknown as string) !== 'initialized'
        ) {
          logger.info(
            LogCategory.AI_SERVICE,
            '[AI Classification Handler] AI服务未初始化，尝试初始化...'
          )
          const initResult = await (window as any).electronLLM.initialize()
          if (!initResult.success) {
            throw new Error(t('AI服务初始化失败: {message}', { message: initResult.message }))
          }
        }

        // 使用AI模型进行分类
        const result = await performLocalAIClassification(
          request.modelId,
          request.prompt,
          request.filename
        )

        logger.info(
          LogCategory.AI_SERVICE,
          '[AI Classification Handler] 分类完成:',
          request.filename
        )

        // 发送结果回主进程
        window.electronAPI!.sendAIClassificationResult(request.id, result)
      } catch (error) {
        logger.error(
          LogCategory.AI_SERVICE,
          '[AI Classification Handler] 分类失败:',
          request.filename,
          error
        )

        // 发送错误回主进程
        window.electronAPI!.sendAIClassificationResult(request.id, {
          success: false,
          error: error instanceof Error ? error.message : t('未知错误')
        } as any)
      } finally {
        // 从处理中的请求集合中移除
        processingRequests.current.delete(request.id)
      }
    }

    // 本地AI分类函数
    const performLocalAIClassification = async (
      modelId: string,
      prompt: string,
      filename: string
    ): Promise<AIClassificationResult> => {
      try {
        const audio: string[] = []
        const images: string[] = []

        // 检查文件扩展名，判断是否需要作为多模态输入
        const ext = filename.split('.').pop()?.toLowerCase() || ''
        const audioExtensions = ['wav', 'mp3', 'flac', 'ogg']
        const imageExtensions = ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif']

        if (audioExtensions.includes(ext)) {
          logger.info(
            LogCategory.AI_SERVICE,
            '[AI Classification Handler] 检测到音频文件，准备转换 base64:',
            filename
          )
          try {
            const base64 = await (window.electronAPI!.utils as any).readFileBase64(filename)
            audio.push(base64.replace(/^data:audio\/[a-z]+;base64,/, ''))
          } catch (err) {
            logger.error(
              LogCategory.AI_SERVICE,
              '[AI Classification Handler] 音频转换 base64 失败:',
              err
            )
          }
        } else if (imageExtensions.includes(ext)) {
          logger.info(
            LogCategory.AI_SERVICE,
            '[AI Classification Handler] 检测到图像文件，准备转换 base64:',
            filename
          )
          try {
            const base64 = await (window.electronAPI!.utils as any).readFileBase64(filename)
            images.push(base64.replace(/^data:image\/[a-z]+;base64,/, ''))
          } catch (err) {
            logger.error(
              LogCategory.AI_SERVICE,
              '[AI Classification Handler] 图像转换 base64 失败:',
              err
            )
          }
        }

        // 使用llama-server进行本地分类
        const response = await (window as any).electronLLM!.chat({
          model: modelId,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.4,
          max_tokens: 4096,
          ...(audio.length > 0 ? { audio } : {}),
          ...(images.length > 0 ? { images } : {})
        } as any)

        // 解析AI响应
        const content = (response as any).choices?.[0]?.message?.content || ''

        // 尝试解析JSON响应
        let result: AIClassificationResult
        try {
          result = JSON.parse(content)
        } catch (parseError) {
          // 如果不是JSON格式，使用文本解析
          result = parseTextResponse(content, filename)
        }

        // 验证和优化结果
        return validateAndOptimizeResult(result, filename)
      } catch (error) {
        logger.error(LogCategory.AI_SERVICE, '[AI Classification Handler] 本地AI分类失败:', error)
        throw new Error(
          t('AI分类失败: {error}', {
            error: error instanceof Error ? error.message : t('未知错误')
          })
        )
      }
    }

    // 解析文本响应
    const parseTextResponse = (response: string, filename: string): AIClassificationResult => {
      const lines = response.split('\n')
      let category = t('未知')
      let confidence = 0.5
      const tags: string[] = []
      let summary = ''

      for (const line of lines) {
        const lowerLine = line.toLowerCase()
        if (lowerLine.includes('分类') || lowerLine.includes('category')) {
          category = line.split(':')[1]?.trim() || category
        } else if (lowerLine.includes('置信度') || lowerLine.includes('confidence')) {
          const conf = parseFloat(line.split(':')[1]?.trim() || '0.5')
          confidence = Math.min(Math.max(conf, 0), 1)
        } else if (lowerLine.includes('标签') || lowerLine.includes('tags')) {
          const tagPart = line.split(':')[1]?.trim()
          if (tagPart) {
            tags.push(
              ...tagPart
                .split(',')
                .map(t => t.trim())
                .filter(t => t)
            )
          }
        } else if (lowerLine.includes('摘要') || lowerLine.includes('summary')) {
          summary = line.split(':')[1]?.trim() || summary
        }
      }

      return {
        fileId: filename,
        timestamp: new Date(),
        category: category || t('未知'),
        confidence,
        tags: tags.length > 0 ? tags : [t('未分类')],
        summary: summary || t('文件: {filename}', { filename })
      }
    }

    // 验证和优化结果
    const validateAndOptimizeResult = (result: any, filename: string): AIClassificationResult => {
      const defaultResult: AIClassificationResult = {
        fileId: filename,
        timestamp: new Date(),
        category: t('未知'),
        confidence: 0.3,
        tags: [t('未分类')],
        summary: t('无法自动分类此文件')
      }

      if (!result || typeof result !== 'object') {
        return defaultResult
      }

      // 验证和清理分类结果
      const validatedResult: AIClassificationResult = {
        fileId: filename,
        timestamp: new Date(),
        category:
          typeof result.category === 'string' ? result.category.trim().substring(0, 50) : t('未知'),
        confidence:
          typeof result.confidence === 'number' && !isNaN(result.confidence)
            ? Math.min(Math.max(result.confidence, 0), 1)
            : 0.5,
        tags: Array.isArray(result.tags)
          ? result.tags
              .filter((tag: any) => typeof tag === 'string' && tag.trim())
              .map((tag: string) => tag.trim().substring(0, 20))
              .slice(0, 10)
          : [t('未分类')],
        summary:
          typeof result.summary === 'string'
            ? result.summary.trim().substring(0, 200)
            : t('文件: {filename}', { filename })
      }

      return validatedResult
    }

    // 注册监听器
    const unsubscribe = window.electronAPI!.onAIClassificationRequest(
      handleClassificationRequest as any
    )

    // 清理函数
    return () => {
      unsubscribe()
      // 清空处理中的请求集合
      processingRequests.current.clear()
    }
  }, [])

  // 这个组件不渲染任何UI
  return null
}
