/**
 * 离线总包流式解包与双向核验工作线程 (Bundle Extractor Worker)
 *
 * 核心安全机制与不变量 (System Invariants):
 * 1. 线程隔离：数 GB 资产流式解压、边写边算哈希与校验 100% 运行于独立的 worker_threads 中；
 * 2. 路径域明确：expectedAssets[].relPath 严格为 ZIP 内条目相对路径（POSIX 正斜杠 '/'，禁盘符与 '..'）；
 * 3. 折叠冲突硬拒绝 (Case-Folding Collision Guard)：启动前在 ZIP 相对路径域执行 NFC + 小写查重，碰撞立即抛出 RESOURCE_DIR_INVALID；
 * 4. 白名单恰好出现一次：跳过已验签的 mainHandledEntries，解包完成断言每个白名单条目在 ZIP 中必须恰好出现 1 次；
 * 5. 配额断路器与零除防御：条目 ≤4096，单文件 ≤2GB，总解压 ≤8GB；仅在 compressed_size > 0 && uncompressed_size > 1MB 时判定压缩比 ≤100；
 * 6. 夹带走私阻断与双向完备性：未知条目立即阻断 (ZIP_ENTRY_REJECTED)，遍历结束断言声明资产 100% 出现且哈希相符；
 * 7. 取消协议与防主进程闪退：用户取消时关闭活跃句柄并发送 RELEASED/RELEASE_TIMEOUT 消息后自然返回，严禁在 worker 内部调用 process.exit()。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { isMainThread, parentPort, type MessagePort } from 'worker_threads'
import * as yauzl from 'yauzl'

/**
 * 解包链路强类型错误码枚举
 */
export type BundleExtractorErrorCode =
  | 'CANCELLED'
  | 'ZIP_ENTRY_REJECTED'
  | 'RESOURCE_DIR_INVALID'
  | 'QUOTA_EXCEEDED'
  | 'ASSET_HASH_MISMATCH'
  | 'IO_FAILURE'
  | 'UNSUPPORTED_FORMAT'

/**
 * 待解包资产条目声明
 */
export interface ExpectedAssetEntry {
  /** ZIP 内条目相对路径，严格使用 POSIX 正斜杠 '/'，严禁盘符与 '..' */
  relPath: string
  /** 声明的期望 SHA-256 (Hex) */
  expectedSha256?: string
  /** 声明的最大解压字节数 */
  maxSizeBytes?: number
}

/**
 * 解包配额上限配置
 */
export interface BundleExtractorLimits {
  /** 最大总条目数 (默认 4096) */
  maxEntries?: number
  /** 单文件最大解压字节数 (默认 2GB = 2 * 1024 * 1024 * 1024) */
  maxSingleFileBytes?: number
  /** 总解压字节数上限 (默认 8GB = 8 * 1024 * 1024 * 1024) */
  maxTotalBytes?: number
  /** 最大压缩比限制 (默认 100，仅当 compressedSize > 0 && uncompressedSize > 1MB 时触发) */
  maxCompressionRatio?: number
  /** 异步让出 CPU 的字节步长 (默认 64MB = 64 * 1024 * 1024) */
  yieldChunkBytes?: number
}

/**
 * Worker 解包入参契约
 */
export interface BundleExtractorWorkerOptions {
  /** 离线总包 .ffp / .zip 物理绝对路径 */
  archivePath: string
  /** 目标暂存目录 (userData/modules/_staging/<jobId>/) */
  stagingDir: string
  /** 预期的物理资产清单 */
  expectedAssets: ExpectedAssetEntry[]
  /** 主进程已验签并处理的条目白名单 (例如 bundle.manifest.json, modules/<id>/manifest.json 等) */
  mainHandledEntries: string[]
  /** 配额限制 */
  limits?: BundleExtractorLimits
}

/**
 * 已解压资产结果
 */
export interface ExtractedAssetResult {
  relPath: string
  actualSha256: string
  sizeBytes: number
  targetPhysicalPath: string
}

/**
 * Worker 解包最终成功结果
 */
export interface BundleExtractorResult {
  ok: true
  totalEntries: number
  totalExtractedBytes: number
  extractedAssets: ExtractedAssetResult[]
}

/**
 * 消息通信协议定义
 */
export type ExtractorWorkerInMessage =
  | { type: 'START'; options: BundleExtractorWorkerOptions }
  | { type: 'ABORT' }

export type ExtractorWorkerOutMessage =
  | { type: 'PROGRESS'; processedBytes: number; totalBytes: number; currentEntry?: string }
  | { type: 'RELEASED' }
  | { type: 'RELEASE_TIMEOUT' }
  | { type: 'SUCCESS'; result: BundleExtractorResult }
  | { type: 'ERROR'; error: { code: BundleExtractorErrorCode; message: string; details?: string } }

/**
 * 解包过程专用结构化异常
 */
export class BundleExtractorError extends Error {
  readonly code: BundleExtractorErrorCode
  readonly details?: string

  constructor(code: BundleExtractorErrorCode, message: string, details?: string) {
    super(message)
    this.name = 'BundleExtractorError'
    this.code = code
    this.details = details
  }
}

/**
 * 安全关闭 ZipFile 句柄辅助函数
 */
function safeCloseZip(zipfile: yauzl.ZipFile | null): void {
  if (zipfile) {
    try {
      zipfile.close()
    } catch {
      // 忽略 ZipFile 重复关闭或状态异常
    }
  }
}

/**
 * 安全销毁流辅助函数 (避免 any)
 */
function safelyDestroyStream(streamObj: unknown): void {
  if (
    streamObj &&
    typeof streamObj === 'object' &&
    'destroy' in streamObj &&
    typeof (streamObj as { destroy: () => void }).destroy === 'function'
  ) {
    try {
      const destroyable = streamObj as { destroy: () => void }
      destroyable.destroy()
    } catch {
      // 忽略已被销毁流的关闭异常
    }
  }
}

/**
 * 路径格式防逃逸与绝对路径检查 (Zip Slip 防御)
 */
function assertValidZipEntryPath(rawPath: string): void {
  if (
    !rawPath ||
    rawPath.includes('..') ||
    rawPath.startsWith('/') ||
    rawPath.startsWith('\\') ||
    rawPath.includes('\\') ||
    path.isAbsolute(rawPath) ||
    /^[a-zA-Z]:/.test(rawPath) ||
    rawPath.includes(':')
  ) {
    throw new BundleExtractorError(
      'ZIP_ENTRY_REJECTED',
      `检测到非法或潜在 Zip-Slip 目录逃逸路径: ${rawPath}`
    )
  }
}

/**
 * 流式解包与双向核验核心例程
 *
 * 可在 Worker 线程中直接调用，亦可传递 port 接收中止消息和通知进度。
 */
export async function runBundleExtractorRoutine(
  options: BundleExtractorWorkerOptions,
  port?: MessagePort | null,
  externalSignal?: AbortSignal
): Promise<BundleExtractorResult> {
  const { archivePath, stagingDir, expectedAssets, mainHandledEntries, limits } = options

  const maxEntries = limits?.maxEntries ?? 4096
  const maxSingleFileBytes = limits?.maxSingleFileBytes ?? 2 * 1024 * 1024 * 1024 // 2GB
  const maxTotalBytes = limits?.maxTotalBytes ?? 8 * 1024 * 1024 * 1024 // 8GB
  const maxCompressionRatio = limits?.maxCompressionRatio ?? 100
  const yieldChunkBytes = limits?.yieldChunkBytes ?? 64 * 1024 * 1024 // 64MB

  // 1. 路径域明确与前置折叠冲突硬拒绝 (Case-Folding Collision Guard)
  // expectedAssets[].relPath 严格为 ZIP 内条目相对路径，执行 NFC + 小写查重
  const normExpectedMap = new Map<string, ExpectedAssetEntry>()
  for (const asset of expectedAssets) {
    assertValidZipEntryPath(asset.relPath)
    const normRel = asset.relPath.normalize('NFC').toLowerCase()
    if (normExpectedMap.has(normRel)) {
      throw new BundleExtractorError(
        'RESOURCE_DIR_INVALID',
        `检测到预期资产内部大小写/NFC折叠冲突路径: ${asset.relPath}`,
        `normalized: ${normRel}`
      )
    }
    normExpectedMap.set(normRel, asset)
  }

  // 检查 mainHandledEntries 格式及与 expectedAssets 集合不相交
  const normWhiteMap = new Map<string, number>()
  for (const whiteEntry of mainHandledEntries) {
    assertValidZipEntryPath(whiteEntry)
    const normWhite = whiteEntry.normalize('NFC').toLowerCase()
    if (normWhiteMap.has(normWhite)) {
      throw new BundleExtractorError(
        'ZIP_ENTRY_REJECTED',
        `白名单集合包含重复定义条目: ${whiteEntry}`
      )
    }
    if (normExpectedMap.has(normWhite)) {
      throw new BundleExtractorError(
        'ZIP_ENTRY_REJECTED',
        `白名单条目与预期资产条目存在重合交集: ${whiteEntry}`
      )
    }
    normWhiteMap.set(normWhite, 0) // 初始计数 0
  }

  // 2. 状态变量管理
  let isAborted = false
  let activeReadStream: yauzl.ZipFile | unknown = null
  let activeWriteStream: fs.WriteStream | null = null
  let activeZipFile: yauzl.ZipFile | null = null

  // 统一的中止处理闭包
  const handleAbort = async (): Promise<void> => {
    if (isAborted) return
    isAborted = true

    safelyDestroyStream(activeReadStream)
    const ws = activeWriteStream
    if (ws) {
      safelyDestroyStream(ws)
    }

    if (activeZipFile) {
      try {
        activeZipFile.close()
      } catch {
        // 忽略关闭异常
      }
    }

    // 监听 close 事件或 500ms 超时通知
    if (port) {
      if (!ws || ws.closed || ws.destroyed) {
        port.postMessage({ type: 'RELEASED' } satisfies ExtractorWorkerOutMessage)
      } else {
        let released = false
        const timer = setTimeout(() => {
          if (!released) {
            released = true
            port.postMessage({ type: 'RELEASE_TIMEOUT' } satisfies ExtractorWorkerOutMessage)
          }
        }, 500)

        ws.once('close', () => {
          if (!released) {
            released = true
            clearTimeout(timer)
            port.postMessage({ type: 'RELEASED' } satisfies ExtractorWorkerOutMessage)
          }
        })
      }
    }
  }

  // 监听外部 AbortSignal
  if (externalSignal) {
    if (externalSignal.aborted) {
      await handleAbort()
      throw new BundleExtractorError('CANCELLED', '用户已取消解包')
    }
    externalSignal.addEventListener('abort', () => {
      void handleAbort()
    })
  }

  // 监听 port 中的消息
  if (port) {
    port.on('message', (msg: ExtractorWorkerInMessage) => {
      if (msg && typeof msg === 'object' && msg.type === 'ABORT') {
        void handleAbort()
      }
    })
  }

  // 3. 打开 ZIP 文件并以 lazyEntries 逐项流式核验
  return new Promise<BundleExtractorResult>((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false },
      (openErr, zipfile: yauzl.ZipFile) => {
        if (openErr || !zipfile) {
          reject(
            new BundleExtractorError(
              'UNSUPPORTED_FORMAT',
              `无法打开离线总包文件: ${openErr?.message ?? '未知错误'}`
            )
          )
          return
        }

        activeZipFile = zipfile

        let entryCount = 0
        let totalExtractedBytes = 0
        let bytesSinceLastYield = 0
        const extractedAssets: ExtractedAssetResult[] = []

        // 处理中止后的快速清理与拒绝
        const checkAborted = (): boolean => {
          if (isAborted) {
            safeCloseZip(zipfile)
            reject(new BundleExtractorError('CANCELLED', '解包过程被用户主动中止'))
            return true
          }
          return false
        }

        zipfile.on('error', (err: Error) => {
          if (isAborted) return
          safeCloseZip(zipfile)
          reject(
            new BundleExtractorError(
              'UNSUPPORTED_FORMAT',
              `ZIP 解析异常: ${err.message}`,
              err.stack
            )
          )
        })

        zipfile.on('end', () => {
          if (isAborted) return
          safeCloseZip(zipfile)

          // A. 白名单恰好出现一次断言
          for (const [whiteNorm, count] of normWhiteMap.entries()) {
            if (count !== 1) {
              reject(
                new BundleExtractorError(
                  'ZIP_ENTRY_REJECTED',
                  `白名单条目在总包中未恰好出现 1 次 (实际出现 ${count} 次): ${whiteNorm}`
                )
              )
              return
            }
          }

          // B. 预期资产双向完备性断言
          if (normExpectedMap.size > 0) {
            const missing = Array.from(normExpectedMap.values())
              .map(a => a.relPath)
              .join(', ')
            reject(
              new BundleExtractorError(
                'ASSET_HASH_MISMATCH',
                `离线总包中缺失声明的物理资产条目: ${missing}`
              )
            )
            return
          }

          resolve({
            ok: true,
            totalEntries: entryCount,
            totalExtractedBytes,
            extractedAssets
          })
        })

        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (checkAborted()) return

          entryCount++
          if (entryCount > maxEntries) {
            safeCloseZip(zipfile)
            reject(
              new BundleExtractorError(
                'QUOTA_EXCEEDED',
                `总条目数超出安全上限 (${entryCount} > ${maxEntries})`
              )
            )
            return
          }

          // 目录条目直接跳过
          if (entry.fileName.endsWith('/')) {
            zipfile.readEntry()
            return
          }

          // 校验条目名防 Zip Slip
          try {
            assertValidZipEntryPath(entry.fileName)
          } catch (err) {
            safeCloseZip(zipfile)
            reject(err)
            return
          }

          const normEntry = entry.fileName.normalize('NFC').toLowerCase()

          // 1. 白名单跳过分支
          const whiteCount = normWhiteMap.get(normEntry)
          if (whiteCount !== undefined) {
            normWhiteMap.set(normEntry, whiteCount + 1)
            // 安全跳过，继续下一条目
            zipfile.readEntry()
            return
          }

          // 2. 预期资产分支
          const expectedAsset = normExpectedMap.get(normEntry)
          if (expectedAsset !== undefined) {
            const asset = expectedAsset
            normExpectedMap.delete(normEntry) // 消费此项

            // 零除与解压炸弹防御：仅在 compressed_size > 0 && uncompressed_size > 1MB 时判定压缩比
            if (entry.compressedSize > 0 && entry.uncompressedSize > 1024 * 1024) {
              const ratio = entry.uncompressedSize / entry.compressedSize
              if (ratio > maxCompressionRatio) {
                safeCloseZip(zipfile)
                reject(
                  new BundleExtractorError(
                    'QUOTA_EXCEEDED',
                    `检测到潜在解压炸弹: 条目 ${entry.fileName} 压缩比超过限制 (${ratio.toFixed(1)} > ${maxCompressionRatio})`
                  )
                )
                return
              }
            }

            // 单文件解压上限防御与资产限定上限防御
            const effectiveMaxSingle = asset.maxSizeBytes
              ? Math.min(maxSingleFileBytes, asset.maxSizeBytes)
              : maxSingleFileBytes
            if (entry.uncompressedSize > effectiveMaxSingle) {
              safeCloseZip(zipfile)
              reject(
                new BundleExtractorError(
                  'QUOTA_EXCEEDED',
                  `条目 ${entry.fileName} 解压体积超出上限 (${entry.uncompressedSize} > ${effectiveMaxSingle} bytes)`
                )
              )
              return
            }

            // 总解压体积上限防御
            if (totalExtractedBytes + entry.uncompressedSize > maxTotalBytes) {
              safeCloseZip(zipfile)
              reject(
                new BundleExtractorError(
                  'QUOTA_EXCEEDED',
                  `总解压体积累计超出 8GB 限制 (${totalExtractedBytes + entry.uncompressedSize} bytes)`
                )
              )
              return
            }

            // 计算目标落地物理路径
            const targetPath = path.resolve(stagingDir, entry.fileName)
            const stagingResolved = path.resolve(stagingDir)
            if (
              targetPath !== stagingResolved &&
              !targetPath.startsWith(stagingResolved + path.sep)
            ) {
              safeCloseZip(zipfile)
              reject(
                new BundleExtractorError(
                  'ZIP_ENTRY_REJECTED',
                  `路径解析超出暂存目录范围: ${entry.fileName}`
                )
              )
              return
            }

            // 建立目标父目录
            try {
              fs.mkdirSync(path.dirname(targetPath), { recursive: true })
            } catch (mkdirErr) {
              safeCloseZip(zipfile)
              reject(
                new BundleExtractorError(
                  'IO_FAILURE',
                  `无法创建解包目录: ${(mkdirErr as Error)?.message}`
                )
              )
              return
            }

            // 打开流式解包读取句柄
            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr || !readStream) {
                safeCloseZip(zipfile)
                reject(
                  new BundleExtractorError(
                    'IO_FAILURE',
                    `无法读取条目流: ${entry.fileName} (${streamErr?.message})`
                  )
                )
                return
              }

              if (checkAborted()) {
                safelyDestroyStream(readStream)
                return
              }

              activeReadStream = readStream
              const writeStream = fs.createWriteStream(targetPath, {
                highWaterMark: 1024 * 1024 // 1MB 缓冲区
              })
              activeWriteStream = writeStream
              const hash = crypto.createHash('sha256')
              let entryExtractedBytes = 0

              readStream.on('data', (chunk: Buffer) => {
                if (isAborted) return
                hash.update(chunk)
                entryExtractedBytes += chunk.length
                totalExtractedBytes += chunk.length
                bytesSinceLastYield += chunk.length

                // P1-1 & P1-2: 实时流式配额断路器 (防御恶意伪造 Zip 头部真实字节超限)
                if (entryExtractedBytes > effectiveMaxSingle) {
                  safelyDestroyStream(readStream)
                  safelyDestroyStream(writeStream)
                  safeCloseZip(zipfile)
                  reject(
                    new BundleExtractorError(
                      'QUOTA_EXCEEDED',
                      `流式解压实时体积超出上限: ${entry.fileName} (${entryExtractedBytes} > ${effectiveMaxSingle} bytes)`
                    )
                  )
                  return
                }

                if (totalExtractedBytes > maxTotalBytes) {
                  safelyDestroyStream(readStream)
                  safelyDestroyStream(writeStream)
                  safeCloseZip(zipfile)
                  reject(
                    new BundleExtractorError(
                      'QUOTA_EXCEEDED',
                      `总解压体积累计超出安全上限 (${totalExtractedBytes} > ${maxTotalBytes} bytes)`
                    )
                  )
                  return
                }

                // 每处理 yieldChunkBytes (默认64MB) 异步让出 10ms CPU/IO 片段，主事件循环零卡顿
                if (bytesSinceLastYield >= yieldChunkBytes) {
                  bytesSinceLastYield = 0
                  readStream.pause()
                  setTimeout(() => {
                    if (!isAborted) {
                      readStream.resume()
                    }
                  }, 10)
                }

                if (port) {
                  port.postMessage({
                    type: 'PROGRESS',
                    processedBytes: totalExtractedBytes,
                    totalBytes: totalExtractedBytes,
                    currentEntry: entry.fileName
                  } satisfies ExtractorWorkerOutMessage)
                }
              })

              readStream.on('error', (err: Error) => {
                safelyDestroyStream(writeStream)
                if (isAborted) return
                safeCloseZip(zipfile)
                reject(
                  new BundleExtractorError(
                    'IO_FAILURE',
                    `解压流读取异常: ${entry.fileName} (${err.message})`
                  )
                )
              })

              writeStream.on('error', (err: Error) => {
                safelyDestroyStream(readStream)
                if (isAborted) return
                safeCloseZip(zipfile)
                reject(
                  new BundleExtractorError(
                    'IO_FAILURE',
                    `解压写入磁盘异常: ${targetPath} (${err.message})`
                  )
                )
              })

              writeStream.on('finish', () => {
                activeReadStream = null
                activeWriteStream = null

                if (isAborted) return

                // 强制刷盘 (以 r+ 模式获取真实写权限句柄 fsync)
                try {
                  const fd = fs.openSync(targetPath, 'r+')
                  fs.fsyncSync(fd)
                  fs.closeSync(fd)
                } catch {
                  // 容错放行 (部分平台对已关闭的 writeStream 句柄可能受限)
                }

                const actualSha256 = hash.digest('hex').toLowerCase()

                // 校验期望哈希
                if (asset.expectedSha256) {
                  const expectedNorm = asset.expectedSha256.trim().toLowerCase()
                  if (actualSha256 !== expectedNorm) {
                    safeCloseZip(zipfile)
                    reject(
                      new BundleExtractorError(
                        'ASSET_HASH_MISMATCH',
                        `条目 ${asset.relPath} SHA-256 校验不匹配 (期望: ${expectedNorm}, 实际: ${actualSha256})`
                      )
                    )
                    return
                  }
                }

                extractedAssets.push({
                  relPath: asset.relPath,
                  actualSha256,
                  sizeBytes: entryExtractedBytes,
                  targetPhysicalPath: targetPath
                })

                // 继续下一个条目
                zipfile.readEntry()
              })

              readStream.pipe(writeStream)
            })
            return
          }

          // 3. 夹带走私阻断：非白名单且非预期资产的未知条目立即拒绝
          safeCloseZip(zipfile)
          reject(
            new BundleExtractorError(
              'ZIP_ENTRY_REJECTED',
              `离线总包包含未在清单中声明的未知条目 (走私阻断): ${entry.fileName}`
            )
          )
        })

        // 启动第一个条目读取
        zipfile.readEntry()
      }
    )
  })
}

/**
 * Worker 线程初始化监听器
 */
export function initWorkerListener(port: MessagePort): void {
  port.on('message', async (msg: ExtractorWorkerInMessage) => {
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'START') {
      try {
        const result = await runBundleExtractorRoutine(msg.options, port)
        port.postMessage({
          type: 'SUCCESS',
          result
        } satisfies ExtractorWorkerOutMessage)
      } catch (err) {
        const extractorErr =
          err instanceof BundleExtractorError
            ? err
            : new BundleExtractorError(
                'UNSUPPORTED_FORMAT',
                (err as Error)?.message ?? '未知解包异常',
                (err as Error)?.stack
              )

        port.postMessage({
          type: 'ERROR',
          error: {
            code: extractorErr.code,
            message: extractorErr.message,
            details: extractorErr.details
          }
        } satisfies ExtractorWorkerOutMessage)
      }
    }
  })
}

// 当直接由 worker_threads 启动此脚本时自动初始化
if (!isMainThread && parentPort) {
  initWorkerListener(parentPort)
}
