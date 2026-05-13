/**
 * 通用文件下载服务
 * 基于 Electron 的 net 模块实现，支持自动代理、重定向和进度报告
 */

import { net } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { logger, LogCategory } from '@yonuc/shared'

export interface DownloadProgress {
  percent: number       // 0-100
  receivedBytes: number
  totalBytes: number
  speed: number         // bytes per second
}

export interface DownloadOptions {
  /** 任务 ID，用于中途取消 */
  taskId?: string
  /** 下载链接 */
  url: string
  /** 保存的目标完整路径 */
  destPath: string
  /** 进度回调 */
  onProgress?: (progress: DownloadProgress) => void
  /** 是否覆盖已存在文件，默认为 true。如果为 true 且大小一致，仍会跳过。 */
  overwrite?: boolean
}

export class FileDownloadService {
  private static instance: FileDownloadService | null = null
  private activeRequests = new Map<string, Electron.ClientRequest>()

  private constructor() {}

  static getInstance(): FileDownloadService {
    if (!FileDownloadService.instance) {
      FileDownloadService.instance = new FileDownloadService()
    }
    return FileDownloadService.instance
  }

  /**
   * 取消下载任务
   */
  cancel(taskId: string): void {
    const request = this.activeRequests.get(taskId)
    if (request) {
      logger.info(LogCategory.SYSTEM, `[Download] 取消任务: ${taskId}`)
      request.abort()
      this.activeRequests.delete(taskId)
    }
  }

  /**
   * 获取远程文件大小
   */
  private async getRemoteSize(url: string): Promise<number> {
    return new Promise((resolve) => {
      const request = net.request({
        url,
        method: 'GET',
        redirect: 'follow'
      })

      request.on('response', (response) => {
        const sizeStr = response.headers['content-length']
        const size = Array.isArray(sizeStr) 
          ? parseInt(sizeStr[0] || '0', 10) 
          : parseInt((sizeStr as string) || '0', 10)
        request.abort()
        resolve(size)
      })

      request.on('error', () => resolve(0))
      request.end()
    })
  }

  /**
   * 下载文件
   * @returns 返回是否下载成功
   */
  async download(options: DownloadOptions): Promise<boolean> {
    const { taskId, url, destPath, onProgress, overwrite = true } = options

    // 1. 检查目标目录
    const destDir = path.dirname(destPath)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }

    // 2. 检测现有文件大小是否一致
    if (fs.existsSync(destPath)) {
      const localSize = fs.statSync(destPath).size
      const remoteSize = await this.getRemoteSize(url)
      
      if (remoteSize > 0 && localSize === remoteSize) {
        logger.info(LogCategory.SYSTEM, `[Download] 大小一致，跳过。`)
        if (onProgress) onProgress({ percent: 100, receivedBytes: remoteSize, totalBytes: remoteSize, speed: 0 })
        return true
      }
      if (!overwrite && localSize > 0) return true
    }

    return new Promise((resolve) => {
      const fileStream = fs.createWriteStream(destPath)
      let receivedBytes = 0
      let totalBytes = 0
      const startTime = Date.now()
      let lastReportTime = 0

      const request = net.request({
        url,
        method: 'GET',
        redirect: 'follow'
      })

      if (taskId) {
        this.activeRequests.set(taskId, request)
      }

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          fileStream.close()
          resolve(false)
          return
        }

        const sizeStr = response.headers['content-length']
        totalBytes = Array.isArray(sizeStr) 
          ? parseInt(sizeStr[0] || '0', 10) 
          : parseInt((sizeStr as string) || '0', 10)
        
        response.on('data', (chunk) => {
          receivedBytes += chunk.length
          fileStream.write(chunk)

          const now = Date.now()
          if (now - lastReportTime > 100 || receivedBytes === totalBytes) {
            lastReportTime = now
            if (onProgress && totalBytes > 0) {
              const percent = Math.min(100, (receivedBytes / totalBytes) * 100)
              const duration = (now - startTime) / 1000
              const speed = duration > 0 ? receivedBytes / duration : 0
              onProgress({ percent: parseFloat(percent.toFixed(1)), receivedBytes, totalBytes, speed })
            }
          }
        })

        response.on('end', () => fileStream.end())
      })

      const cleanup = () => {
        if (taskId) this.activeRequests.delete(taskId)
        fileStream.close()
      }

      request.on('error', (err) => {
        cleanup()
        resolve(false)
      })

      request.on('abort', () => {
        cleanup()
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath)
        resolve(false)
      })

      fileStream.on('finish', () => {
        if (taskId) this.activeRequests.delete(taskId)
        
        // 校验下载完整性
        if (totalBytes > 0 && receivedBytes < totalBytes) {
          logger.error(LogCategory.SYSTEM, `[Download] 文件下载不完整: ${receivedBytes}/${totalBytes}`)
          if (fs.existsSync(destPath)) {
            try {
              fs.unlinkSync(destPath)
            } catch (e) {}
          }
          resolve(false)
        } else {
          resolve(true)
        }
      })

      request.end()
    })
  }
}

export const fileDownloadService = FileDownloadService.getInstance()
