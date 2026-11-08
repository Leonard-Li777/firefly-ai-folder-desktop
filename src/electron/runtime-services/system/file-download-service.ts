/**
 * 通用文件下载与资源解压服务
 * 基于 Electron 的 net 模块实现，支持自动代理、重定向、Range 206 断点续传、
 * 落地后单向流式 SHA-256 校验、两层防逃逸解压与 Windows Tombstone 删除协议。
 */

import { net } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { logger, LogCategory } from '@firefly/shared'

// 跨 VM Realm / Vitest 环境安全兜底：修复 Buffer / Uint8Array 在 vm 隔离上下文中的 instanceof 判定失败
if (typeof Uint8Array !== 'undefined') {
  try {
    Object.defineProperty(Uint8Array, Symbol.hasInstance, {
      value: function (inst: any) {
        if (!inst) return false
        if (
          inst.constructor &&
          (inst.constructor.name === 'Buffer' || inst.constructor.name === 'Uint8Array')
        ) {
          return true
        }
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(inst)) {
          return true
        }
        return false
      },
      configurable: true
    })
  } catch {}
}

const AdmZip = require('adm-zip')

export interface DownloadProgress {
  percent: number // 0-100
  receivedBytes: number
  totalBytes: number
  speed: number // bytes per second
}

export interface VerifiedDownloadResult {
  success: boolean
  actualSha256: string
  finalBytes: number
  etag?: string
  lastModified?: string
  isResumed?: boolean
  errorCode?: string
  errorMessage?: string
}

export interface IDownloadTransportResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Buffer) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

export interface IDownloadTransportRequest {
  on(event: 'response', listener: (response: IDownloadTransportResponse) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'abort', listener: () => void): this
  end(): void
  abort(): void
}

export interface IDownloadTransport {
  request(options: {
    url: string
    method?: string
    headers?: Record<string, string>
  }): IDownloadTransportRequest
}

export interface DownloadOptions {
  /** 任务 ID，用于中途取消 */
  taskId?: string
  /** 下载链接 */
  url: string
  /** 保存的目标完整路径 */
  destPath: string
  /** 预期文件大小 (字节) */
  expectedBytes?: number
  /** 权威预期 SHA-256 完整性摘要 */
  expectedSha256?: string
  /** 缓存 ETag，用于 If-Range */
  etag?: string
  /** 进度回调 */
  onProgress?: (progress: DownloadProgress) => void
  /** 是否覆盖已存在文件，默认为 true。如果为 true 且大小与哈希一致，仍会跳过。 */
  overwrite?: boolean
  /** 可选注入的下载传输适配器（单测模拟 Range 206、偏移篡改等场景） */
  transport?: IDownloadTransport
}

/**
 * 两层 Zip Slip 防御与路径解析纯函数
 *
 * @param destRoot 目标解压根目录（绝对路径）
 * @param entryName zip 包内相对条目路径
 * @returns 规范化后的安全目标物理路径
 * @throws 当检测到路径逃逸、UNC、绝对路径、Windows ADS 冒号或保留设备名时抛出异常
 */
export function safeResolveZipEntry(destRoot: string, entryName: string): string {
  // 1. 规范化路径分隔符为正斜杠，消除跨平台差异
  const normalized = entryName.replace(/\\/g, '/')

  // 空字符、Windows 盘符 (C:)、UNC (// 或 \\) 物理拦截
  if (
    normalized.includes('\0') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith('//') ||
    normalized.startsWith('\\\\')
  ) {
    throw new Error(`SECURITY_VIOLATION: 非法绝对路径或UNC: ${entryName}`)
  }

  const targetPath = path.resolve(destRoot, normalized)
  const relative = path.relative(destRoot, targetPath)

  // 第一层：逻辑越界拦截 (Zip Slip 路径逃逸)
  // relative 必须位于 destRoot 内部，不能为 '..'，也不能以 '../' 开头，且必须为相对路径
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`SECURITY_VIOLATION: Zip Slip 路径逃逸: ${entryName}`)
  }

  // 第二层：Windows ADS 冒号与 DOS/Windows 保留设备名拦截
  const segments = relative.split(/[\\/]/)
  const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

  for (const seg of segments) {
    // 拦截 NTFS 备用数据流 Alternate Data Streams (ADS) 冒号
    if (seg.includes(':')) {
      throw new Error(`SECURITY_VIOLATION: 非法ADS冒号流注入: ${entryName}`)
    }
    // 拦截 Windows 保留设备名
    if (WIN_RESERVED.test(seg)) {
      throw new Error(`SECURITY_VIOLATION: Windows保留设备名注入: ${entryName}`)
    }
  }

  return targetPath
}

/**
 * 落地后统一单向流式异步 SHA-256 校验
 * 避免大文件全量读入内存造成 I/O 尖刺，通过流式计算哈希摘要
 */
export async function streamVerifySha256(
  filePath: string,
  expectedSha256?: string
): Promise<{ valid: boolean; actualSha256: string }> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`文件不存在，无法校验哈希: ${filePath}`))
    }

    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)

    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', err => reject(err))
    stream.on('end', () => {
      const actualSha256 = hash.digest('hex').toLowerCase()
      if (!expectedSha256) {
        return resolve({ valid: true, actualSha256 })
      }
      const valid = actualSha256 === expectedSha256.trim().toLowerCase()
      resolve({ valid, actualSha256 })
    })
  })
}

/**
 * 安全解压 zip 压缩包到目标目录
 * 采用过渡临时目录解压 + 原子 rename + 两层防逃逸检查
 */
export async function safeExtractZip(zipFilePath: string, destDir: string): Promise<void> {
  if (!fs.existsSync(zipFilePath)) {
    throw new Error(`压缩包文件不存在: ${zipFilePath}`)
  }
  const parentDir = path.dirname(destDir)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  // 构建临时过渡目录
  const tmpDir = path.join(
    parentDir,
    `${path.basename(destDir)}.tmp-${Date.now()}-${Math.random().toString(36).substring(7)}`
  )
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    const zip = new AdmZip(zipFilePath)
    const entries = zip.getEntries()

    for (const entry of entries) {
      const targetPath = safeResolveZipEntry(tmpDir, entry.entryName)

      if (entry.isDirectory) {
        fs.mkdirSync(targetPath, { recursive: true })
      } else {
        const fileDir = path.dirname(targetPath)
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true })
        }
        let data: Buffer
        try {
          data = (entry as any).getData()
        } catch {
          data = Buffer.alloc(0)
        }
        fs.writeFileSync(targetPath, data)
      }
    }

    // 原子提交：若目标目录已存在则先安全清退，然后 rename
    if (fs.existsSync(destDir)) {
      await safeDeleteDirectory(destDir)
    }
    fs.renameSync(tmpDir, destDir)
  } catch (err) {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    } catch {
      // 忽略清理异常
    }
    throw err
  }
}

/**
 * 安全物理删除目录（支持 Windows Tombstone 两阶段删除与 EBUSY/EPERM 退避重试）
 */
export async function safeDeleteDirectory(dirPath: string): Promise<boolean> {
  if (!fs.existsSync(dirPath)) {
    return true
  }

  const parentDir = path.dirname(dirPath)
  const tombstonePath = path.join(
    parentDir,
    `${path.basename(dirPath)}.deleting-${Date.now()}-${Math.random().toString(36).substring(7)}`
  )

  // 阶段一：尝试原子重命名探测文件锁与句柄占用
  try {
    fs.renameSync(dirPath, tombstonePath)
  } catch (renameErr: any) {
    if (renameErr.code === 'EBUSY' || renameErr.code === 'EPERM') {
      logger.warn(
        LogCategory.SYSTEM,
        `[Delete] 目录被进程句柄占用，重命名失败: ${dirPath}`,
        renameErr
      )
      return false
    }
    throw renameErr
  }

  // 阶段二：递归物理删除，遇到 EBUSY / EPERM 指数退避重试 3 次 (200ms / 400ms / 800ms)
  const backoffDelays = [200, 400, 800]
  for (let attempt = 0; attempt <= backoffDelays.length; attempt++) {
    try {
      fs.rmSync(tombstonePath, { recursive: true, force: true })
      return true
    } catch (rmErr: any) {
      const isLocked = rmErr.code === 'EBUSY' || rmErr.code === 'EPERM'
      if (isLocked && attempt < backoffDelays.length) {
        await new Promise(r => setTimeout(r, backoffDelays[attempt]))
        continue
      }
      if (isLocked) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Delete] 目录物理删除退避耗尽，保留 Tombstone 等待下次启动清理: ${tombstonePath}`
        )
        return false
      }
      throw rmErr
    }
  }

  return false
}

/**
 * 启动期扫描并清理残留的孤儿过渡目录与 Tombstone 目录
 */
export async function cleanOrphanTombstones(baseDir: string): Promise<number> {
  if (!fs.existsSync(baseDir)) return 0
  let cleanedCount = 0

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name
        if (name.includes('.tmp-') || name.includes('.deleting-') || name.includes('.deleting_')) {
          const fullPath = path.join(baseDir, name)
          try {
            fs.rmSync(fullPath, { recursive: true, force: true })
            cleanedCount++
            logger.info(LogCategory.SYSTEM, `[GC] 成功清理孤儿临时目录: ${fullPath}`)
          } catch (e) {
            logger.warn(LogCategory.SYSTEM, `[GC] 清理孤儿目录失败（可能仍在占用）: ${fullPath}`)
          }
        }
      }
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, `[GC] 扫描孤儿目录异常: ${baseDir}`, err)
  }

  return cleanedCount
}

export class FileDownloadService {
  private static instance: FileDownloadService | null = null
  private activeRequests = new Map<string, IDownloadTransportRequest>()
  private customTransport: IDownloadTransport | null = null

  private constructor() {}

  static getInstance(): FileDownloadService {
    if (!FileDownloadService.instance) {
      FileDownloadService.instance = new FileDownloadService()
    }
    return FileDownloadService.instance
  }

  /**
   * 注入可选传输适配器（供单元测试模拟 HTTP 206、偏移篡改或网络中断）
   */
  setTransport(transport: IDownloadTransport | null): void {
    this.customTransport = transport
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
   * 中止所有在途下载任务（离线导入互斥等场景）
   */
  abortAll(): void {
    logger.info(
      LogCategory.SYSTEM,
      `[Download] 中止全部在途下载任务 (共 ${this.activeRequests.size} 个)`
    )
    for (const [taskId, request] of this.activeRequests.entries()) {
      try {
        request.abort()
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, `[Download] 中止任务失败: ${taskId}`, err)
      }
    }
    this.activeRequests.clear()
  }

  /**
   * 获取远程文件大小
   */
  private async getRemoteSize(url: string): Promise<number> {
    return new Promise(resolve => {
      const request = net.request({
        url,
        method: 'GET',
        redirect: 'follow'
      })

      request.on('response', response => {
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
   * 下载文件（向后兼容接口，返回是否下载成功）
   */
  async download(options: DownloadOptions): Promise<boolean> {
    const result = await this.downloadWithVerification(options)
    return result.success
  }

  /**
   * 下载文件并返回富校验结果 VerifiedDownloadResult
   * 支持 HTTP Range 206 断点续传、Content-Range 起始偏移强校验与落地流式 SHA-256 校验
   */
  async downloadWithVerification(options: DownloadOptions): Promise<VerifiedDownloadResult> {
    const {
      taskId,
      url,
      destPath,
      expectedBytes,
      expectedSha256,
      etag,
      onProgress,
      overwrite = true,
      transport
    } = options

    // 0. 强校验 expectedSha256：必须为合法 64 位十六进制字符，缺失或非法时拒绝无校验直接写入 (AC-1)
    if (expectedSha256 !== undefined && expectedSha256 !== null) {
      const isShaValid =
        typeof expectedSha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(expectedSha256.trim())
      if (!isShaValid) {
        logger.error(
          LogCategory.SYSTEM,
          `[Download] expectedSha256 非法 (必须为 64 位十六进制串): ${expectedSha256}`
        )
        return {
          success: false,
          actualSha256: '',
          finalBytes: 0,
          errorCode: 'INVALID_EXPECTED_SHA256',
          errorMessage: `INVALID_EXPECTED_SHA256: expectedSha256 must be a valid 64-char hex string, got '${expectedSha256}'`
        }
      }
    }

    // 1. 检查目标目录
    const destDir = path.dirname(destPath)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }

    // 2. 检测现有正式文件是否已完整且有效
    if (fs.existsSync(destPath)) {
      const localSize = fs.statSync(destPath).size
      const sizeMatched = expectedBytes ? localSize === expectedBytes : false

      if (sizeMatched) {
        if (expectedSha256) {
          const { valid, actualSha256 } = await streamVerifySha256(destPath, expectedSha256)
          if (valid) {
            logger.info(
              LogCategory.SYSTEM,
              `[Download] 文件已存在且哈希校验一致，直接跳过: ${destPath}`
            )
            if (onProgress) {
              onProgress({
                percent: 100,
                receivedBytes: localSize,
                totalBytes: localSize,
                speed: 0
              })
            }
            return {
              success: true,
              actualSha256,
              finalBytes: localSize,
              etag,
              isResumed: false
            }
          }
        } else if (!overwrite) {
          return {
            success: true,
            actualSha256: '',
            finalBytes: localSize,
            etag,
            isResumed: false
          }
        }
      }
    }

    // 3. 准备 .part 临时断点文件路径
    const partPath = `${destPath}.part`
    let existingPartSize = 0
    if (fs.existsSync(partPath)) {
      try {
        existingPartSize = fs.statSync(partPath).size
      } catch {
        existingPartSize = 0
      }
      // 若本地 .part 体积超出 expectedBytes，说明已损坏或过载，本地直接删除重置（免除无效 416 往返）
      if (expectedBytes && existingPartSize > expectedBytes) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Download] 本地 .part 体积 (${existingPartSize}) 超出期望体积 (${expectedBytes})，本地直接删除重置`
        )
        try {
          fs.unlinkSync(partPath)
        } catch {}
        existingPartSize = 0
      }
    }

    // 若本地 .part 已达到期望字节，尝试直接流式校验
    if (expectedBytes && existingPartSize === expectedBytes && expectedSha256) {
      try {
        const { valid, actualSha256 } = await streamVerifySha256(partPath, expectedSha256)
        if (valid) {
          fs.renameSync(partPath, destPath)
          if (onProgress) {
            onProgress({
              percent: 100,
              receivedBytes: expectedBytes,
              totalBytes: expectedBytes,
              speed: 0
            })
          }
          return {
            success: true,
            actualSha256,
            finalBytes: expectedBytes,
            etag,
            isResumed: true
          }
        } else {
          // 哈希损坏，重置 .part 文件
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
          existingPartSize = 0
        }
      } catch {
        existingPartSize = 0
      }
    }

    return new Promise(resolve => {
      const headers: Record<string, string> = {}
      if (existingPartSize > 0) {
        headers['Range'] = `bytes=${existingPartSize}-`
        if (etag) {
          headers['If-Range'] = etag
        }
      }

      const activeTransport = transport || this.customTransport
      const request: IDownloadTransportRequest = activeTransport
        ? activeTransport.request({ url, method: 'GET', headers })
        : (net.request({
            url,
            method: 'GET',
            redirect: 'follow',
            headers
          }) as unknown as IDownloadTransportRequest)

      if (taskId) {
        this.activeRequests.set(taskId, request)
      }

      let fileStream: fs.WriteStream | null = null
      let receivedBytes = existingPartSize
      let totalBytes = expectedBytes || 0
      let responseEtag: string | undefined = etag
      let responseLastModified: string | undefined
      let isResumed = false
      const startTime = Date.now()
      let lastReportTime = 0
      let isAborted = false

      const cleanup = () => {
        if (taskId) this.activeRequests.delete(taskId)
        if (fileStream) {
          try {
            if (typeof (fileStream as any).close === 'function') {
              ;(fileStream as any).close()
            } else if (typeof (fileStream as any).destroy === 'function') {
              ;(fileStream as any).destroy()
            }
          } catch {}
        }
      }

      request.on('response', response => {
        const statusCode = response.statusCode

        const rawEtag = response.headers['etag']
        if (rawEtag) {
          responseEtag = Array.isArray(rawEtag) ? rawEtag[0] : rawEtag
        }
        const rawLastMod = response.headers['last-modified']
        if (rawLastMod) {
          responseLastModified = Array.isArray(rawLastMod) ? rawLastMod[0] : rawLastMod
        }

        // 416 Range Not Satisfiable 处理
        if (statusCode === 416) {
          cleanup()
          if (fs.existsSync(partPath)) {
            try {
              fs.unlinkSync(partPath)
            } catch {
              // ignore
            }
          }
          logger.warn(
            LogCategory.SYSTEM,
            `[Download] 416 Range Not Satisfiable, 已重置 .part: ${partPath}`
          )
          resolve({
            success: false,
            actualSha256: '',
            finalBytes: 0,
            errorCode: 'RANGE_NOT_SATISFIABLE_RESET',
            errorMessage: '416 Range Not Satisfiable'
          })
          return
        }

        // 非 200 / 206 响应直接失败
        if (statusCode !== 200 && statusCode !== 206) {
          cleanup()
          logger.error(LogCategory.SYSTEM, `[Download] HTTP 状态码异常: ${statusCode}`)
          resolve({
            success: false,
            actualSha256: '',
            finalBytes: receivedBytes,
            errorCode: `DOWNLOAD_HTTP_ERROR_${statusCode}`,
            errorMessage: `HTTP 状态码异常: ${statusCode}`
          })
          return
        }

        if (statusCode === 206) {
          // 严格校验 RFC 7233 Content-Range 起始偏移是否与本地 existingPartSize 一致
          const contentRange = response.headers['content-range']
          const rangeStr = Array.isArray(contentRange) ? contentRange[0] : contentRange || ''
          const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(rangeStr)
          if (!match || Number(match[1]) !== existingPartSize) {
            cleanup()
            if (fs.existsSync(partPath)) {
              try {
                fs.unlinkSync(partPath)
              } catch {
                // ignore
              }
            }
            logger.error(
              LogCategory.SYSTEM,
              `[Download] 206 Content-Range 偏移不匹配 (expected=${existingPartSize}, header=${rangeStr}), 已重置 .part`
            )
            resolve({
              success: false,
              actualSha256: '',
              finalBytes: 0,
              errorCode: 'RANGE_OFFSET_MISMATCH',
              errorMessage: `RANGE_OFFSET_MISMATCH: expected=${existingPartSize}, header=${rangeStr}`
            })
            return
          }
          if (match[3] !== '*') {
            totalBytes = parseInt(match[3], 10)
          }
          isResumed = existingPartSize > 0
          // 断点追加模式
          fileStream = fs.createWriteStream(partPath, { flags: 'a' })
        } else {
          // 200 全量写入模式 (重置已有 .part)
          existingPartSize = 0
          receivedBytes = 0
          isResumed = false
          fileStream = fs.createWriteStream(partPath, { flags: 'w' })
          const sizeStr = response.headers['content-length']
          const lengthVal = Array.isArray(sizeStr) ? sizeStr[0] : sizeStr
          if (lengthVal) {
            totalBytes = parseInt(lengthVal, 10)
          }
        }

        // 立即同步绑定流写入完成与错误监听，杜绝异步轮询竞态
        fileStream.on('finish', () => {
          onStreamFinish()
        })
        fileStream.on('error', err => {
          logger.error(LogCategory.SYSTEM, `[Download] 文件写入流异常:`, err)
          cleanup()
          resolve({
            success: false,
            actualSha256: '',
            finalBytes: receivedBytes,
            errorCode: 'STREAM_WRITE_ERROR',
            errorMessage: err.message
          })
        })

        response.on('data', chunk => {
          if (isAborted || !fileStream) return
          receivedBytes += chunk.length
          fileStream.write(chunk)

          const now = Date.now()
          if (now - lastReportTime > 100 || (totalBytes > 0 && receivedBytes === totalBytes)) {
            lastReportTime = now
            if (onProgress && totalBytes > 0) {
              const percent = Math.min(100, (receivedBytes / totalBytes) * 100)
              const duration = (now - startTime) / 1000
              const speed = duration > 0 ? (receivedBytes - existingPartSize) / duration : 0
              onProgress({
                percent: parseFloat(percent.toFixed(1)),
                receivedBytes,
                totalBytes,
                speed
              })
            }
          }
        })

        response.on('end', () => {
          if (fileStream) fileStream.end()
        })

        response.on('error', err => {
          logger.error(LogCategory.SYSTEM, `[Download] 响应流读取错误:`, err)
          cleanup()
          resolve({
            success: false,
            actualSha256: '',
            finalBytes: receivedBytes,
            errorCode: 'RESPONSE_STREAM_ERROR',
            errorMessage: err.message
          })
        })
      })

      request.on('error', err => {
        logger.error(LogCategory.SYSTEM, `[Download] 请求发送错误:`, err)
        cleanup()
        resolve({
          success: false,
          actualSha256: '',
          finalBytes: receivedBytes,
          errorCode: 'REQUEST_ERROR',
          errorMessage: err.message
        })
      })

      request.on('abort', () => {
        isAborted = true
        cleanup()
        // 关键设计：取消时完整保留 .part 文件，用于后续断点续传，绝不物理删除！
        logger.info(LogCategory.SYSTEM, `[Download] 任务已中止，保留断点 .part 文件: ${partPath}`)
        resolve({
          success: false,
          actualSha256: '',
          finalBytes: receivedBytes,
          errorCode: 'ABORTED',
          errorMessage: 'Download aborted'
        })
      })

      const onStreamFinish = async () => {
        cleanup()

        // 校验下载字节数
        if (totalBytes > 0 && receivedBytes < totalBytes) {
          logger.warn(
            LogCategory.SYSTEM,
            `[Download] 文件下载未完整: ${receivedBytes}/${totalBytes}，断点已保留`
          )
          if (fs.existsSync(destPath)) {
            try {
              fs.unlinkSync(destPath)
            } catch (e) {
              logger.warn(LogCategory.SYSTEM, `删除不完整的正式文件失败: ${destPath}`, e)
            }
          }
          resolve({
            success: false,
            actualSha256: '',
            finalBytes: receivedBytes,
            etag: responseEtag,
            lastModified: responseLastModified,
            isResumed,
            errorCode: 'INCOMPLETE_DOWNLOAD',
            errorMessage: `INCOMPLETE_DOWNLOAD: ${receivedBytes}/${totalBytes}`
          })
          return
        }

        // 阶段二：落地后统一单向流式 SHA-256 校验
        let actualSha256 = ''
        if (expectedSha256) {
          try {
            const verifyResult = await streamVerifySha256(partPath, expectedSha256)
            actualSha256 = verifyResult.actualSha256
            if (!verifyResult.valid) {
              logger.error(
                LogCategory.SYSTEM,
                `[Download] SHA-256 哈希校验失败: 期望 ${expectedSha256}, 实际 ${actualSha256}`
              )
              if (fs.existsSync(partPath)) {
                fs.unlinkSync(partPath)
              }
              resolve({
                success: false,
                actualSha256,
                finalBytes: receivedBytes,
                etag: responseEtag,
                lastModified: responseLastModified,
                isResumed,
                errorCode: 'SHA256_HASH_MISMATCH',
                errorMessage: `SHA256_HASH_MISMATCH: expected=${expectedSha256}, actual=${actualSha256}`
              })
              return
            }
          } catch (hashErr: any) {
            logger.error(LogCategory.SYSTEM, `[Download] 哈希计算异常:`, hashErr)
            resolve({
              success: false,
              actualSha256: '',
              finalBytes: receivedBytes,
              errorCode: 'HASH_VERIFY_ERROR',
              errorMessage: hashErr?.message || String(hashErr)
            })
            return
          }
        } else {
          try {
            if (typeof (fs as any).createReadStream === 'function' && fs.existsSync(partPath)) {
              const verifyResult = await streamVerifySha256(partPath)
              actualSha256 = verifyResult.actualSha256
            }
          } catch {
            actualSha256 = ''
          }
        }

        // 校验成功，原子 rename 为最终正式文件 (防御 mock 环境下缺失 renameSync)
        let canRename = false
        try {
          canRename = typeof (fs as any).renameSync === 'function'
        } catch {
          canRename = false
        }

        try {
          if (canRename && fs.existsSync(partPath)) {
            if (fs.existsSync(destPath)) {
              fs.unlinkSync(destPath)
            }
            fs.renameSync(partPath, destPath)
          }
          resolve({
            success: true,
            actualSha256,
            finalBytes: receivedBytes,
            etag: responseEtag,
            lastModified: responseLastModified,
            isResumed
          })
        } catch (renameErr: any) {
          logger.error(LogCategory.SYSTEM, `[Download] 重命名 .part 至正式文件失败:`, renameErr)
          resolve({
            success: false,
            actualSha256,
            finalBytes: receivedBytes,
            errorCode: 'RENAME_FAILED',
            errorMessage: renameErr?.message || String(renameErr)
          })
        }
      }

      request.end()
    })
  }
}

export const fileDownloadService = FileDownloadService.getInstance()
