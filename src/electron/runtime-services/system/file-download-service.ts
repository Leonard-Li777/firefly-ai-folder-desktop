/**
 * 通用文件下载与资源解压服务
 * 基于 Electron 的 net 模块实现，支持自动代理、重定向、Range 206 断点续传、
 * 固定 4MiB 块网格并发下载、流式 SHA-256 校验、两层防逃逸解压与 Windows 意图日志自愈协议。
 *
 * @doc-anchor: docs/specs/plugin-download-multithread-hash-verify-and-preset-fallback-spec.md
 */

import { net, app as electronApp } from 'electron'
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

export interface DownloadWatchdogOptions {
  taskId?: string
  connectTimeoutMs?: number // 默认 15000ms: TCP/TLS 握手
  ttfbTimeoutMs?: number // 默认 15000ms: 握手成功至收到响应头
  stallTimeoutMs?: number // 默认 30000ms: 连续 chunk 最大间隔
  signal?: AbortSignal
}

/**
 * 挂载连接、首字节 (TTFB) 与流传输停滞三重独立看门狗定时器
 * 支持连接池复用已连接 socket 检测，防 CONNECT 误报；在 error/abort/end 及 signal 时统一清理防泄漏。
 */
export function attachDownloadWatchdogs(
  req: any,
  opts: DownloadWatchdogOptions,
  onTimeout: (stage: 'CONNECT_TIMEOUT' | 'TTFB_TIMEOUT' | 'STALL_TIMEOUT') => void
): () => void {
  let settled = false
  let currentTimer: ReturnType<typeof setTimeout> | null = null
  let currentSocket: any = null
  let currentResponse: any = null

  const clearAll = () => {
    if (currentTimer) {
      clearTimeout(currentTimer)
      currentTimer = null
    }
    if (currentSocket) {
      if (typeof currentSocket.removeAllListeners === 'function') {
        currentSocket.removeAllListeners('connect')
        currentSocket.removeAllListeners('secureConnect')
      }
      currentSocket = null
    }
    if (currentResponse) {
      if (typeof currentResponse.removeAllListeners === 'function') {
        currentResponse.removeAllListeners('data')
        currentResponse.removeAllListeners('end')
      }
      currentResponse = null
    }
  }

  const arm = (ms: number, stage: 'CONNECT_TIMEOUT' | 'TTFB_TIMEOUT' | 'STALL_TIMEOUT') => {
    if (currentTimer) clearTimeout(currentTimer)
    currentTimer = setTimeout(() => {
      if (settled) return
      settled = true
      clearAll()
      try {
        if (typeof req.abort === 'function') req.abort()
      } catch {}
      onTimeout(stage)
    }, ms)
  }

  // 1. 启动独立连接超时看门狗
  arm(opts.connectTimeoutMs ?? 15000, 'CONNECT_TIMEOUT')

  if (typeof req.on === 'function') {
    req.on('socket', (socket: any) => {
      currentSocket = socket
      const startTtfb = () => {
        if (!settled) {
          // 2. 握手完成，启动独立首字节 (TTFB) 超时看门狗
          arm(opts.ttfbTimeoutMs ?? 15000, 'TTFB_TIMEOUT')
        }
      }

      // 连接池复用已连接 socket：直接进入 TTFB 阶段，防 CONNECT 误报
      if (socket && (socket.remoteAddress || socket.readyState === 'open')) {
        startTtfb()
        return
      }

      if (socket && typeof socket.once === 'function') {
        socket.once('connect', () => {
          if (socket.encrypted) {
            socket.once('secureConnect', startTtfb)
          } else {
            startTtfb()
          }
        })
      }
    })

    req.on('response', (response: any) => {
      currentResponse = response
      // 3. 响应头到达，启动流传输停滞看门狗
      arm(opts.stallTimeoutMs ?? 30000, 'STALL_TIMEOUT')
      if (typeof response.on === 'function') {
        response.on('data', () => {
          if (!settled) {
            arm(opts.stallTimeoutMs ?? 30000, 'STALL_TIMEOUT')
          }
        })
        response.on('end', () => {
          settled = true
          clearAll()
        })
      }
    })

    req.on('error', () => {
      settled = true
      clearAll()
    })
    req.on('abort', () => {
      settled = true
      clearAll()
    })
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      settled = true
      clearAll()
      try {
        if (typeof req.abort === 'function') req.abort()
      } catch {}
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          settled = true
          clearAll()
          try {
            if (typeof req.abort === 'function') req.abort()
          } catch {}
        },
        { once: true }
      )
    }
  }

  return clearAll
}

/**
 * 校验分片下载响应的 Range 206 协议契约
 * 杜绝假 200/HTML 报错页或私网登录页污染 4MiB 块网格
 */
export function assertPartialResponse(
  res: any,
  start: number,
  end: number,
  expectedBytes?: number
): void {
  const statusCode = res.statusCode
  if (statusCode !== 206) {
    throw new Error(`RANGE_NOT_SUPPORTED: Expected HTTP 206, got ${statusCode}`)
  }

  const rawContentRange = res.headers?.['content-range'] || res.headers?.['Content-Range']
  const contentRange = Array.isArray(rawContentRange) ? rawContentRange[0] : rawContentRange
  if (contentRange && typeof contentRange === 'string') {
    const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
    if (match) {
      const actualStart = parseInt(match[1], 10)
      const actualEnd = parseInt(match[2], 10)
      const actualTotal = match[3] !== '*' ? parseInt(match[3], 10) : undefined

      if (actualStart !== start || actualEnd !== end) {
        throw new Error(
          `RANGE_MISMATCH: Requested bytes ${start}-${end}, got ${actualStart}-${actualEnd}`
        )
      }
      if (expectedBytes && actualTotal && actualTotal !== expectedBytes) {
        throw new Error(`RANGE_TOTAL_MISMATCH: Expected total ${expectedBytes}, got ${actualTotal}`)
      }
    }
  }

  const rawLength = res.headers?.['content-length'] || res.headers?.['Content-Length']
  const contentLength = rawLength
    ? parseInt(Array.isArray(rawLength) ? rawLength[0] : rawLength, 10)
    : undefined
  const expectedBlockLen = end - start + 1
  if (contentLength !== undefined && !isNaN(contentLength) && contentLength !== expectedBlockLen) {
    throw new Error(
      `RANGE_LENGTH_MISMATCH: Expected block length ${expectedBlockLen}, got ${contentLength}`
    )
  }
}

export interface ChunkDownloadOptions {
  taskId: string
  assetId?: string
  urls: string[]
  destPath: string
  expectedBytes: number
  expectedSha256: string
  maxConcurrency?: number
  maxInflightBlocks?: number
  maxRedownloadRetries?: number
  router?: DualTrackSourceRouter
  transport?: IDownloadTransport
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
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
/**
 * Windows 强化重命名操作（遭遇 EBUSY / EPERM / EACCES / ENOTEMPTY 时指数退避重试，最大预算 8 秒）
 */
export async function renameWithRetry(
  oldPath: string,
  newPath: string,
  maxWaitMs: number = 8000
): Promise<void> {
  const startTime = Date.now()
  let delay = 50
  while (true) {
    try {
      await fs.promises.rename(oldPath, newPath)
      return
    } catch (err: any) {
      const isLockError = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err?.code)
      const elapsed = Date.now() - startTime
      if (!isLockError || elapsed + delay >= maxWaitMs) {
        throw err
      }
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(1000, delay * 2)
    }
  }
}

export interface DirSwitchIntent {
  readonly state: 'prepared' | 'old-moved' | 'new-moved'
  readonly targetDir: string
  readonly trashDir: string
  readonly stagingDir: string
  readonly updatedAt: number
}

function resolveDefaultIntentsDir(targetDir: string): string {
  try {
    if (typeof (electronApp as any)?.getPath === 'function') {
      const userData = (electronApp as any).getPath('userData')
      if (userData) return path.join(userData, 'intents')
    }
  } catch {}
  return path.join(path.dirname(targetDir), '.intents')
}

export async function writeDirSwitchIntent(
  intentFile: string,
  intent: DirSwitchIntent
): Promise<void> {
  const dir = path.dirname(intentFile)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const tmpFile = `${intentFile}.tmp-${Date.now()}`
  await fs.promises.writeFile(tmpFile, JSON.stringify(intent, null, 2), 'utf-8')
  await fs.promises.rename(tmpFile, intentFile)
}

export async function atomicDirectorySwitch(
  stagingDir: string,
  targetDir: string,
  intentsDir?: string
): Promise<void> {
  const resolvedIntentsDir = intentsDir || resolveDefaultIntentsDir(targetDir)
  const targetHash = crypto.createHash('sha256').update(targetDir).digest('hex').slice(0, 16)
  const intentFile = path.join(resolvedIntentsDir, `dir-switch-${targetHash}.json`)
  const trashDir = `${targetDir}.trash-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`

  let intent: DirSwitchIntent = {
    state: 'prepared',
    targetDir,
    trashDir,
    stagingDir,
    updatedAt: Date.now()
  }
  await writeDirSwitchIntent(intentFile, intent)

  // 步骤 1：若目标目录已存在，重命名为 trashDir
  if (fs.existsSync(targetDir)) {
    await renameWithRetry(targetDir, trashDir)
    intent = { ...intent, state: 'old-moved', updatedAt: Date.now() }
    await writeDirSwitchIntent(intentFile, intent)
  }

  // 步骤 2：将 stagingDir 重命名为 targetDir
  await renameWithRetry(stagingDir, targetDir)
  intent = { ...intent, state: 'new-moved', updatedAt: Date.now() }
  await writeDirSwitchIntent(intentFile, intent)

  // 步骤 3：异步清理 trashDir，并删除意图日志
  if (fs.existsSync(trashDir)) {
    try {
      await fs.promises.rm(trashDir, { recursive: true, force: true })
    } catch {
      // 忽略清理异常，后续由启动期自愈或后台 GC 处理
    }
  }
  try {
    if (fs.existsSync(intentFile)) {
      await fs.promises.unlink(intentFile)
    }
  } catch {}
}

export async function reconcileDirSwitchIntents(intentsDir: string): Promise<number> {
  if (!fs.existsSync(intentsDir)) return 0
  let reconciled = 0
  try {
    const files = fs
      .readdirSync(intentsDir)
      .filter(f => f.startsWith('dir-switch-') && f.endsWith('.json'))
    for (const f of files) {
      const intentPath = path.join(intentsDir, f)
      try {
        const raw = fs.readFileSync(intentPath, 'utf-8')
        const intent: DirSwitchIntent = JSON.parse(raw)
        const targetExists = fs.existsSync(intent.targetDir)
        const trashExists = fs.existsSync(intent.trashDir)
        const stagingExists = fs.existsSync(intent.stagingDir)

        if (targetExists) {
          // targetDir 健全：静默清理残余 trashDir / stagingDir
          if (trashExists) {
            try {
              fs.rmSync(intent.trashDir, { recursive: true, force: true })
            } catch {}
          }
          if (stagingExists) {
            try {
              fs.rmSync(intent.stagingDir, { recursive: true, force: true })
            } catch {}
          }
        } else {
          // targetDir 缺失
          if (trashExists && stagingExists) {
            // 补完切换：将 stagingDir 重命名为 targetDir
            await renameWithRetry(intent.stagingDir, intent.targetDir)
            try {
              fs.rmSync(intent.trashDir, { recursive: true, force: true })
            } catch {}
          } else if (trashExists && !stagingExists) {
            // 崩溃回滚：将 trashDir 重命名回 targetDir
            await renameWithRetry(intent.trashDir, intent.targetDir)
          } else if (!trashExists && stagingExists) {
            // 仅 staging 存在：补完
            await renameWithRetry(intent.stagingDir, intent.targetDir)
          }
        }
        try {
          fs.unlinkSync(intentPath)
        } catch {}
        reconciled++
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, `[IntentReconcile] 处理意图日志异常: ${intentPath}`, err)
      }
    }
  } catch (scanErr) {
    logger.warn(LogCategory.SYSTEM, `[IntentReconcile] 扫描意图目录异常: ${intentsDir}`, scanErr)
  }
  return reconciled
}

export interface DiskSpaceCheckResult {
  sufficient: boolean
  requiredBytes: number
  availableBytes: number
}

export function checkDiskSpace(
  targetPath: string,
  options: {
    archiveBytes: number
    existingPartDiskBytes?: number
    maxUncompressedBytes: number
    extraBufferBytes?: number
    isLocalPreset?: boolean
  }
): DiskSpaceCheckResult {
  const existingPart = options.existingPartDiskBytes ?? 0
  const archiveCost = options.isLocalPreset ? 0 : Math.max(0, options.archiveBytes - existingPart)
  const extraBuffer = options.extraBufferBytes ?? 50 * 1024 * 1024 // 50MB
  const requiredBytes = archiveCost + options.maxUncompressedBytes + extraBuffer

  let checkDir = targetPath
  while (!fs.existsSync(checkDir)) {
    const parent = path.dirname(checkDir)
    if (parent === checkDir) break
    checkDir = parent
  }

  let availableBytes = Number.MAX_SAFE_INTEGER
  try {
    if (typeof (fs as any).statfsSync === 'function') {
      const stats = (fs as any).statfsSync(checkDir)
      availableBytes = stats.bavail * stats.bsize
    }
  } catch {}

  return {
    sufficient: availableBytes >= requiredBytes,
    requiredBytes,
    availableBytes
  }
}

export async function cleanOldTrashAndOrphanParts(
  baseDir: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): Promise<number> {
  if (!fs.existsSync(baseDir)) return 0
  let cleaned = 0
  const now = Date.now()

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(baseDir, entry.name)
      if (entry.isDirectory()) {
        if (
          entry.name.includes('.trash-') ||
          entry.name.includes('.deleting-') ||
          entry.name.startsWith('.tombstone-')
        ) {
          if (entry.name.startsWith('.tombstone-')) {
            logger.warn(
              LogCategory.SYSTEM,
              `[GC] 检测到历史遗留 .tombstone- 目录并兼容清理: ${fullPath}`
            )
          }
          try {
            const st = fs.statSync(fullPath)
            if (now - st.mtimeMs > maxAgeMs) {
              fs.rmSync(fullPath, { recursive: true, force: true })
              cleaned++
            }
          } catch {}
        }
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.part') || entry.name.endsWith('.meta.json')) {
          try {
            const st = fs.statSync(fullPath)
            if (now - st.mtimeMs > maxAgeMs) {
              fs.unlinkSync(fullPath)
              cleaned++
            }
          } catch {}
        }
      }
    }
  } catch {}
  return cleaned
}

export function isSourceCooledDown(until: number, now = Date.now()): boolean {
  return until > now && until - now <= 15 * 60 * 1000
}

export class DualTrackSourceRouter {
  private sourcesState = new Map<
    string,
    {
      concurrency: number
      cooldownUntil: number
      consecutive429Count: number
    }
  >()

  getConcurrency(url: string, defaultConcurrency = 8): number {
    return this.sourcesState.get(url)?.concurrency ?? defaultConcurrency
  }

  isCooling(url: string, now = Date.now()): boolean {
    const state = this.sourcesState.get(url)
    if (!state) return false
    return isSourceCooledDown(state.cooldownUntil, now)
  }

  handle429(
    url: string,
    retryAfterSeconds?: number,
    now = Date.now()
  ): {
    newConcurrency: number
    cooledDown: boolean
    cooldownUntil: number
  } {
    let state = this.sourcesState.get(url)
    if (!state) {
      state = { concurrency: 8, cooldownUntil: 0, consecutive429Count: 0 }
      this.sourcesState.set(url, state)
    }

    state.consecutive429Count++
    if (state.concurrency > 1) {
      // AIMD 乘性减并发 8 -> 4 -> 2 -> 1
      state.concurrency = Math.max(1, Math.floor(state.concurrency / 2))
      return {
        newConcurrency: state.concurrency,
        cooledDown: false,
        cooldownUntil: 0
      }
    }

    // 单并发下再次 429 -> 进入 15 分钟冷却
    const delayMs =
      retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 15 * 60 * 1000
    state.cooldownUntil = now + Math.min(delayMs, 15 * 60 * 1000)
    return {
      newConcurrency: 1,
      cooledDown: true,
      cooldownUntil: state.cooldownUntil
    }
  }

  recordSuccess(url: string): void {
    const state = this.sourcesState.get(url)
    if (state) {
      state.consecutive429Count = 0
      state.cooldownUntil = 0
    }
  }

  reportFailure(url: string, failureReason?: string, now = Date.now()): void {
    let state = this.sourcesState.get(url)
    if (!state) {
      state = { concurrency: 8, cooldownUntil: 0, consecutive429Count: 0 }
      this.sourcesState.set(url, state)
    }
    if (state.concurrency > 1) {
      state.concurrency = Math.max(1, Math.floor(state.concurrency / 2))
    } else {
      // 连续失败进入 3 分钟冷却，让其他备用镜像源优先处理
      state.cooldownUntil = now + 3 * 60 * 1000
    }
  }

  selectBestSource(
    urls: readonly string[],
    now = Date.now()
  ): { url: string; concurrency: number } {
    if (urls.length === 0) {
      throw new Error('No candidate URLs provided')
    }

    // 1. 查找未冷却的源
    for (const url of urls) {
      if (!this.isCooling(url, now)) {
        return {
          url,
          concurrency: this.getConcurrency(url, 8)
        }
      }
    }

    // 2. 全源冷却保底：若所有源均处于冷却中，选择 cooldownUntil 最早到期的源解除冷却，并以单并发（concurrency = 1）重试，严禁全源死锁挂起
    let earliestUrl = urls[0]
    let earliestUntil = this.sourcesState.get(earliestUrl)?.cooldownUntil ?? Infinity
    for (const url of urls) {
      const until = this.sourcesState.get(url)?.cooldownUntil ?? Infinity
      if (until < earliestUntil) {
        earliestUntil = until
        earliestUrl = url
      }
    }

    return {
      url: earliestUrl,
      concurrency: 1
    }
  }
}

export async function safeExtractZip(
  zipFilePath: string,
  destDir: string,
  intentsDir?: string
): Promise<void> {
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

    // 原子提交：通过 atomicDirectorySwitch 强化，带意图日志与 renameWithRetry
    await atomicDirectorySwitch(tmpDir, destDir, intentsDir)
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
        if (
          name.includes('.tmp-') ||
          name.includes('.deleting-') ||
          name.includes('.deleting_') ||
          name.startsWith('.tombstone-')
        ) {
          const fullPath = path.join(baseDir, name)
          if (name.startsWith('.tombstone-')) {
            logger.warn(
              LogCategory.SYSTEM,
              `[GC] 检测到历史遗留 .tombstone- 目录并兼容清理: ${fullPath}`
            )
          }
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

      let clearWatchdogs: (() => void) | null = null

      const cleanup = () => {
        if (clearWatchdogs) {
          clearWatchdogs()
          clearWatchdogs = null
        }
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

      clearWatchdogs = attachDownloadWatchdogs(
        request,
        {
          taskId,
          signal: (options as any)?.signal
        },
        stage => {
          isAborted = true
          cleanup()
          resolve({
            success: false,
            actualSha256: '',
            finalBytes: receivedBytes,
            errorCode: stage,
            errorMessage: `Download watchdog triggered: ${stage}`
          })
        }
      )

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

  /**
   * 固定 4MiB 块网格高弹性并发断点续传下载器 (Ticket 02)
   */
  async downloadWithFixedBlocks(options: ChunkDownloadOptions): Promise<VerifiedDownloadResult> {
    const {
      taskId,
      assetId,
      urls,
      destPath,
      expectedBytes,
      expectedSha256,
      maxConcurrency = 4,
      maxInflightBlocks = 4,
      transport,
      signal,
      onProgress
    } = options

    const FIXED_BLOCK_SIZE = 4 * 1024 * 1024 // 4MiB
    const blockCount = Math.ceil(expectedBytes / FIXED_BLOCK_SIZE)
    const destDir = path.dirname(destPath)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }

    // 1. 若目标正式文件已存在且哈希校验吻合，直接完成
    if (fs.existsSync(destPath) && fs.statSync(destPath).size === expectedBytes) {
      const verify = await streamVerifySha256(destPath, expectedSha256)
      if (verify.valid) {
        onProgress?.({
          percent: 100,
          receivedBytes: expectedBytes,
          totalBytes: expectedBytes,
          speed: 0
        })
        return { success: true, actualSha256: verify.actualSha256, finalBytes: expectedBytes }
      }
    }

    const partPath = `${destPath}.part`
    const metaPath = `${partPath}.meta.json`
    const completedBlocks = new Set<number>()

    // 2. 读取或恢复单 Manifest 元数据
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        if (
          meta.version === 1 &&
          meta.expectedBytes === expectedBytes &&
          meta.expectedSha256?.toLowerCase() === expectedSha256.toLowerCase() &&
          Array.isArray(meta.completedBlocks)
        ) {
          for (const b of meta.completedBlocks) {
            completedBlocks.add(b)
          }
        } else {
          // 元数据不匹配或损坏，清理
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
          fs.unlinkSync(metaPath)
        }
      } catch {
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
        try {
          fs.unlinkSync(metaPath)
        } catch {}
      }
    }

    // 3. 打开文件句柄 (O_RDWR | O_CREAT)
    const fileHandle = await fs.promises.open(partPath, fs.constants.O_RDWR | fs.constants.O_CREAT)

    try {
      const stat = await fileHandle.stat()
      if (stat.size === 0 && expectedBytes > 0) {
        await fileHandle.truncate(expectedBytes)
      }

      // 4. 计算待下载块列表
      const pendingBlocks: number[] = []
      for (let i = 0; i < blockCount; i++) {
        if (!completedBlocks.has(i)) {
          pendingBlocks.push(i)
        }
      }

      // 5. 串行写盘队列与背压信号量
      let writeQueue = Promise.resolve()
      let uncommittedBatchCount = 0

      const enqueueWrite = (offset: number, buffer: Buffer): Promise<void> => {
        return new Promise((resolveWrite, rejectWrite) => {
          writeQueue = writeQueue.then(async () => {
            try {
              let written = 0
              while (written < buffer.length) {
                const res = await fileHandle.write(
                  buffer,
                  written,
                  buffer.length - written,
                  offset + written
                )
                if (res.bytesWritten === 0) {
                  throw new Error('Disk write failed (bytesWritten === 0)')
                }
                written += res.bytesWritten
              }
              resolveWrite()
            } catch (err) {
              rejectWrite(err)
            }
          })
        })
      }

      const flushMeta = async (force = false) => {
        if (force || uncommittedBatchCount >= 8) {
          await fileHandle.datasync()
          const metaContent = {
            version: 1,
            assetId: assetId || taskId,
            expectedBytes,
            expectedSha256,
            blockSize: FIXED_BLOCK_SIZE,
            blockCount,
            completedBlocks: Array.from(completedBlocks).sort((a, b) => a - b)
          }
          const tmpMeta = `${metaPath}.tmp-${Date.now()}`
          fs.writeFileSync(tmpMeta, JSON.stringify(metaContent, null, 2), 'utf-8')
          fs.renameSync(tmpMeta, metaPath)
          uncommittedBatchCount = 0
        }
      }

      let activeInflight = 0
      let committedBytes = completedBlocks.size * FIXED_BLOCK_SIZE
      if (completedBlocks.has(blockCount - 1)) {
        committedBytes =
          (completedBlocks.size - 1) * FIXED_BLOCK_SIZE +
          (expectedBytes - (blockCount - 1) * FIXED_BLOCK_SIZE)
      }

      const activeTransport = transport || this.customTransport
      const sourceRouter = options.router || new DualTrackSourceRouter()
      let currentSource = sourceRouter.selectBestSource(urls)
      let activeUrl = currentSource.url

      // Worker 循环执行未完成块
      const workerRun = async () => {
        while (pendingBlocks.length > 0) {
          if (signal?.aborted) throw new Error('DOWNLOAD_ABORTED')

          const effectiveConcurrency = sourceRouter.getConcurrency(activeUrl, maxConcurrency)
          while (activeInflight >= Math.min(maxInflightBlocks, effectiveConcurrency)) {
            await new Promise(r => setTimeout(r, 20))
          }

          const blockIndex = pendingBlocks.shift()
          if (blockIndex === undefined) break

          activeInflight++
          const start = blockIndex * FIXED_BLOCK_SIZE
          const end = Math.min(start + FIXED_BLOCK_SIZE - 1, expectedBytes - 1)
          const rangeLength = end - start + 1

          try {
            const blockBuffer = await new Promise<Buffer>((resolveNet, rejectNet) => {
              const headers: Record<string, string> = {
                Range: `bytes=${start}-${end}`,
                'Accept-Encoding': 'identity'
              }

              const req = activeTransport
                ? activeTransport.request({ url: activeUrl, method: 'GET', headers })
                : (net.request({
                    url: activeUrl,
                    method: 'GET',
                    headers
                  }) as unknown as IDownloadTransportRequest)

              let clearWorkerWatchdogs: (() => void) | null = null
              clearWorkerWatchdogs = attachDownloadWatchdogs(
                req,
                {
                  taskId: `${taskId}:block:${blockIndex}`,
                  signal: options.signal
                },
                stage => {
                  const timeoutErr: any = new Error(`Download block watchdog timed out: ${stage}`)
                  timeoutErr.errorCode = stage
                  timeoutErr.isTimeout = true
                  rejectNet(timeoutErr)
                }
              )

              const chunks: Buffer[] = []
              req.on('response', (res: IDownloadTransportResponse) => {
                if (res.statusCode === 429) {
                  if (clearWorkerWatchdogs) clearWorkerWatchdogs()
                  const retryHeader =
                    (res as any).headers?.['retry-after'] || (res as any).headers?.['Retry-After']
                  const retrySec = retryHeader
                    ? parseInt(Array.isArray(retryHeader) ? retryHeader[0] : retryHeader, 10)
                    : undefined
                  const res429 = sourceRouter.handle429(activeUrl, retrySec)
                  const err429: any = new Error('HTTP_429_TOO_MANY_REQUESTS')
                  err429.is429 = true
                  err429.routerResult = res429
                  rejectNet(err429)
                  return
                }

                try {
                  // 深度核验 Range 206 契约，防假 200/HTML 污染分片
                  assertPartialResponse(res, start, end, expectedBytes)
                } catch (rangeErr) {
                  if (clearWorkerWatchdogs) clearWorkerWatchdogs()
                  try {
                    if (typeof req.abort === 'function') req.abort()
                  } catch {}
                  rejectNet(rangeErr)
                  return
                }

                res.on('data', c => chunks.push(c))
                res.on('end', () => {
                  if (clearWorkerWatchdogs) clearWorkerWatchdogs()
                  resolveNet(Buffer.concat(chunks))
                })
                res.on('error', err => {
                  if (clearWorkerWatchdogs) clearWorkerWatchdogs()
                  rejectNet(err)
                })
              })
              req.on('error', err => {
                if (clearWorkerWatchdogs) clearWorkerWatchdogs()
                rejectNet(err)
              })
              req.end()
            })

            if (blockBuffer.length !== rangeLength) {
              throw new Error(
                `Block ${blockIndex} length mismatch: expected ${rangeLength}, got ${blockBuffer.length}`
              )
            }

            // 排队串行写入操作系统
            await enqueueWrite(start, blockBuffer)
            completedBlocks.add(blockIndex)
            uncommittedBatchCount++
            committedBytes += rangeLength

            onProgress?.({
              percent: Math.min(99, Math.round((committedBytes / expectedBytes) * 100)),
              receivedBytes: committedBytes,
              totalBytes: expectedBytes,
              speed: 0
            })

            await flushMeta(false)
          } catch (err: any) {
            if (err?.is429) {
              // 429 降并发并将块放回未完成队列
              pendingBlocks.unshift(blockIndex)
              const best = sourceRouter.selectBestSource(urls)
              activeUrl = best.url
              await new Promise(r => setTimeout(r, 50))
            } else if (err?.isTimeout || err?.message?.includes('RANGE')) {
              // 看门狗超时或非 206 假响应：向 router 报告失败，重入块并尝试切源
              sourceRouter.reportFailure(activeUrl, err.errorCode || 'NETWORK_FAILURE')
              pendingBlocks.unshift(blockIndex)
              const best = sourceRouter.selectBestSource(urls)
              activeUrl = best.url
              await new Promise(r => setTimeout(r, 100))
            } else {
              throw err
            }
          } finally {
            activeInflight--
          }
        }
      }

      if (pendingBlocks.length > 0) {
        const workers = Array.from({ length: Math.min(maxConcurrency, pendingBlocks.length) }, () =>
          workerRun()
        )
        await Promise.all(workers)
      }

      await writeQueue
      await flushMeta(true)
    } finally {
      await fileHandle.close()
    }

    // 6. 全量整包 SHA-256 流式校验
    const finalVerify = await streamVerifySha256(partPath, expectedSha256)
    if (!finalVerify.valid) {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath)
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath)
      return {
        success: false,
        actualSha256: finalVerify.actualSha256,
        finalBytes: 0,
        errorCode: 'CHECKSUM_MISMATCH',
        errorMessage: `CHECKSUM_MISMATCH: expected ${expectedSha256}, got ${finalVerify.actualSha256}`
      }
    }

    // 原子重命名为最终正式目标文件 (带 Windows EBUSY 退避)
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath)
    }
    await renameWithRetry(partPath, destPath)
    if (fs.existsSync(metaPath)) {
      try {
        fs.unlinkSync(metaPath)
      } catch {}
    }

    onProgress?.({
      percent: 100,
      receivedBytes: expectedBytes,
      totalBytes: expectedBytes,
      speed: 0
    })
    return {
      success: true,
      actualSha256: finalVerify.actualSha256,
      finalBytes: expectedBytes
    }
  }
}

export const fileDownloadService = FileDownloadService.getInstance()
