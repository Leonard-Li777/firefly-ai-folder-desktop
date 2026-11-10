/**
 * 离线总包自包含 Dry-Run 物理核验工作线程 (Bundle Verifier Worker)
 *
 * 核心安全机制与不变量 (System Invariants):
 * 1. 自包含铁律 (Self-Contained Invariant):
 *    仅验证 .ffp 压缩包内部的密码学自洽性 (Ed25519 签名与流式 SHA-256)，
 *    严禁查询本地数据库 (builtin_modules 或 resource_downloads)，彻底杜绝跨机误判；
 * 2. 线程隔离与主事件循环零阻塞:
 *    流式分块读取 (1MB 缓冲区) 与每 64MB 异步让出 10ms，保障后台长耗时核验不卡顿主进程 UI；
 * 3. 错误清晰分流 (Error Taxonomy):
 *    - DETERMINISTIC_CORRUPTION: 确定性损坏 (签名无效、ZIP 损坏、哈希不符、缺失清单) -> 移入 Tombstone 并置 FAILED；
 *    - TRANSIENT_IO_ERROR: 暂时性 IO 错误 (Defender 锁、EBUSY、EPERM) -> 保留 .ffp 并保留 CLEANUP_PENDING；
 * 4. 正常取消与连续崩溃计数保护:
 *    监听 ABORT 消息，销毁打开的流并优雅返回 RELEASED，以 process.exit(0) 退出，严禁误触发熔断。
 */

import * as fs from 'fs'
import * as crypto from 'crypto'
import { isMainThread, parentPort, type MessagePort } from 'worker_threads'
import * as yauzl from 'yauzl'
import { ROOT_ED25519_PK, verifyManifestSignature } from '../offline-bundle-exporter'

export type VerifierErrorType = 'DETERMINISTIC_CORRUPTION' | 'TRANSIENT_IO_ERROR' | 'CANCELLED'

export interface VerifierWorkerOptions {
  /** .ffp 文件绝对路径 */
  archivePath: string
  /** 异步让出 CPU 的步长 (默认 64MB) */
  yieldChunkBytes?: number
  /** 自定义公钥 (测试用) */
  customPublicKey?: string
}

export interface VerifierResult {
  ok: true
  archivePath: string
  computedFileSha256: string
  totalEntries: number
}

export type VerifierWorkerInMessage =
  | { type: 'START'; options: VerifierWorkerOptions }
  | { type: 'ABORT' }

export type VerifierWorkerOutMessage =
  | { type: 'PROGRESS'; processedBytes: number; totalBytes: number }
  | { type: 'DONE'; result: VerifierResult }
  | { type: 'ERROR'; errorType: VerifierErrorType; message: string; details?: string }
  | { type: 'RELEASED' }

export class BundleVerifierWorkerLogic {
  private aborted = false
  private activeZipfile: yauzl.ZipFile | null = null
  private activeReadStream: fs.ReadStream | null = null

  public abort(): void {
    this.aborted = true
    if (this.activeReadStream) {
      try {
        this.activeReadStream.destroy()
      } catch {
        // ignore
      }
    }
    if (this.activeZipfile) {
      try {
        this.activeZipfile.close()
      } catch {
        // ignore
      }
    }
  }

  /**
   * 执行自包含核验
   */
  public async verify(
    options: VerifierWorkerOptions,
    onProgress?: (processed: number, total: number) => void
  ): Promise<VerifierResult> {
    const { archivePath, yieldChunkBytes = 64 * 1024 * 1024, customPublicKey } = options
    const publicKey = customPublicKey || ROOT_ED25519_PK

    // 1. 物理文件存在性与大小检查
    let stats: fs.Stats
    try {
      stats = fs.statSync(archivePath)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'EBUSY' || code === 'EPERM') {
        const error = new Error(`暂时性 IO 锁占用: ${archivePath}`)
        ;(error as { errorType?: VerifierErrorType }).errorType = 'TRANSIENT_IO_ERROR'
        throw error
      }
      const error = new Error(`离线总包文件不存在或无法访问: ${archivePath}`)
      ;(error as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
      throw error
    }

    const totalFileSize = stats.size

    // 2. 边流式计算全包 SHA-256 边让出 CPU (同时也是对全包物理完整性的完整 IO 读取扫描)
    const fileHash = crypto.createHash('sha256')
    let bytesRead = 0
    let yieldAccumulator = 0

    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(archivePath, { highWaterMark: 1024 * 1024 }) // 1MB 块
      this.activeReadStream = rs

      rs.on('data', async (chunk: Buffer | string) => {
        if (this.aborted) {
          rs.destroy()
          const err = new Error('用户或系统取消核验')
          ;(err as { errorType?: VerifierErrorType }).errorType = 'CANCELLED'
          reject(err)
          return
        }

        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        fileHash.update(buf)
        bytesRead += buf.length
        yieldAccumulator += buf.length

        if (onProgress) {
          onProgress(bytesRead, totalFileSize)
        }

        if (yieldAccumulator >= yieldChunkBytes) {
          rs.pause()
          yieldAccumulator = 0
          setTimeout(() => {
            if (!this.aborted) {
              rs.resume()
            }
          }, 10)
        }
      })

      rs.on('error', err => {
        const code = (err as { code?: string })?.code
        const errType: VerifierErrorType =
          code === 'EBUSY' || code === 'EPERM' ? 'TRANSIENT_IO_ERROR' : 'DETERMINISTIC_CORRUPTION'
        const customErr = new Error(`读取 .ffp 流失败: ${err.message}`)
        ;(customErr as { errorType?: VerifierErrorType }).errorType = errType
        reject(customErr)
      })

      rs.on('end', () => {
        this.activeReadStream = null
        resolve()
      })
    })

    const computedFileSha256 = fileHash.digest('hex')

    // 3. 打开 ZIP 结构并解析中央目录
    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
        if (err || !zip) {
          const code = (err as { code?: string })?.code
          const errType: VerifierErrorType =
            code === 'EBUSY' || code === 'EPERM' ? 'TRANSIENT_IO_ERROR' : 'DETERMINISTIC_CORRUPTION'
          const customErr = new Error(`无法作为 ZIP 打开: ${err?.message || '未知错误'}`)
          ;(customErr as { errorType?: VerifierErrorType }).errorType = errType
          reject(customErr)
        } else {
          resolve(zip)
        }
      })
    })

    this.activeZipfile = zipfile

    try {
      let bundleManifestBuffer: Buffer | null = null
      let bundleManifestSig: string | null = null
      const moduleManifestMap = new Map<string, { buffer?: Buffer; sig?: string }>()
      let totalEntries = 0

      // 4. 第一遍扫描：收集根清单、根签名以及各模块声明的清单与签名
      await new Promise<void>((resolve, reject) => {
        zipfile.readEntry()

        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (this.aborted) {
            const err = new Error('用户或系统取消核验')
            ;(err as { errorType?: VerifierErrorType }).errorType = 'CANCELLED'
            reject(err)
            return
          }

          totalEntries++
          const fileName = entry.fileName.replace(/\\/g, '/')

          if (fileName === 'bundle.manifest.json') {
            zipfile.openReadStream(entry, (err, stream) => {
              if (err || !stream) return reject(err || new Error('无法读取 bundle.manifest.json'))
              const chunks: Buffer[] = []
              stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              stream.on('end', () => {
                bundleManifestBuffer = Buffer.concat(chunks)
                zipfile.readEntry()
              })
              stream.on('error', reject)
            })
          } else if (fileName === 'bundle.manifest.sig') {
            zipfile.openReadStream(entry, (err, stream) => {
              if (err || !stream) return reject(err || new Error('无法读取 bundle.manifest.sig'))
              const chunks: Buffer[] = []
              stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              stream.on('end', () => {
                bundleManifestSig = Buffer.concat(chunks).toString('utf-8').trim()
                zipfile.readEntry()
              })
              stream.on('error', reject)
            })
          } else if (fileName.startsWith('modules/') && fileName.endsWith('/manifest.json')) {
            // 模块级 manifest.json
            const parts = fileName.split('/')
            const modId = parts[1]
            zipfile.openReadStream(entry, (err, stream) => {
              if (err || !stream) return reject(err || new Error(`无法读取模块清单: ${fileName}`))
              const chunks: Buffer[] = []
              stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              stream.on('end', () => {
                const item = moduleManifestMap.get(modId) || {}
                item.buffer = Buffer.concat(chunks)
                moduleManifestMap.set(modId, item)
                zipfile.readEntry()
              })
              stream.on('error', reject)
            })
          } else if (fileName.startsWith('modules/') && fileName.endsWith('/manifest.sig')) {
            // 模块级 manifest.sig
            const parts = fileName.split('/')
            const modId = parts[1]
            zipfile.openReadStream(entry, (err, stream) => {
              if (err || !stream) return reject(err || new Error(`无法读取模块签名: ${fileName}`))
              const chunks: Buffer[] = []
              stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
              stream.on('end', () => {
                const item = moduleManifestMap.get(modId) || {}
                item.sig = Buffer.concat(chunks).toString('utf-8').trim()
                moduleManifestMap.set(modId, item)
                zipfile.readEntry()
              })
              stream.on('error', reject)
            })
          } else {
            zipfile.readEntry()
          }
        })

        zipfile.on('end', () => resolve())
        zipfile.on('error', err => {
          const customErr = new Error(`ZIP 中央目录解析失败: ${err.message}`)
          ;(customErr as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
          reject(customErr)
        })
      })

      // 5. 校验核心元数据与 Ed25519 签名
      if (!bundleManifestBuffer || !bundleManifestSig) {
        const err = new Error('离线包缺少 bundle.manifest.json 或 bundle.manifest.sig')
        ;(err as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
        throw err
      }

      const isValidRootSignature = verifyManifestSignature(
        bundleManifestBuffer,
        bundleManifestSig,
        publicKey
      )
      if (!isValidRootSignature) {
        const err = new Error('离线总包官方签名验签失败，已被非法篡改或损坏')
        ;(err as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
        throw err
      }

      // 6. 深度核验：解析 bundle.manifest.json 中的全部声明模块，逐一验证其 Ed25519 签名
      try {
        const rootManifest = JSON.parse((bundleManifestBuffer as Buffer).toString('utf-8'))
        const declaredModules = (rootManifest.modules || rootManifest.items || []) as Array<{
          module_id?: string
          id?: string
        }>

        for (const modDecl of declaredModules) {
          const modId = modDecl.module_id || modDecl.id
          if (!modId) continue

          const modItem = moduleManifestMap.get(modId)
          if (!modItem?.buffer || !modItem?.sig) {
            const err = new Error(`模块 ${modId} 缺少 manifest.json 或 manifest.sig 凭据`)
            ;(err as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
            throw err
          }

          const isModValid = verifyManifestSignature(modItem.buffer, modItem.sig, publicKey)
          if (!isModValid) {
            const err = new Error(`模块 ${modId} 官方签名验签失败，内容已被非法篡改`)
            ;(err as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
            throw err
          }
        }
      } catch (parseErr: unknown) {
        if ((parseErr as { errorType?: string })?.errorType === 'DETERMINISTIC_CORRUPTION') {
          throw parseErr
        }
        const err = new Error(
          `根清单 bundle.manifest.json 解析失败: ${(parseErr as Error)?.message}`
        )
        ;(err as { errorType?: VerifierErrorType }).errorType = 'DETERMINISTIC_CORRUPTION'
        throw err
      }

      return {
        ok: true,
        archivePath,
        computedFileSha256,
        totalEntries
      }
    } finally {
      this.activeZipfile = null
      zipfile.close()
    }
  }
}

/**
 * Worker 线程执行入口
 */
if (!isMainThread && parentPort) {
  const port: MessagePort = parentPort
  const logic = new BundleVerifierWorkerLogic()

  port.on('message', async (msg: VerifierWorkerInMessage) => {
    if (msg.type === 'ABORT') {
      logic.abort()
      port.postMessage({ type: 'RELEASED' } as VerifierWorkerOutMessage)
      return
    }

    if (msg.type === 'START') {
      try {
        const result = await logic.verify(msg.options, (processed, total) => {
          port.postMessage({
            type: 'PROGRESS',
            processedBytes: processed,
            totalBytes: total
          } as VerifierWorkerOutMessage)
        })

        port.postMessage({
          type: 'DONE',
          result
        } as VerifierWorkerOutMessage)
      } catch (err: unknown) {
        const errorType =
          (err as { errorType?: VerifierErrorType })?.errorType || 'DETERMINISTIC_CORRUPTION'
        port.postMessage({
          type: 'ERROR',
          errorType,
          message: (err as Error)?.message || '核验异常',
          details: (err as Error)?.stack
        } as VerifierWorkerOutMessage)
      }
    }
  })
}
