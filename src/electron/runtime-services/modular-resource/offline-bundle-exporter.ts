/**
 * 离线总包导出流水线与边写边算流式哈希 (Offline Bundle Exporter)
 *
 * 核心不变量与架构准则：
 * 1. 严格审查 Ed25519 官方根公钥签名，绝对严禁使用测试私钥伪造补签；
 * 2. 细粒度任务互斥锁、与后台校验读写解耦及 2000ms 有界等待取消优先协议；
 * 3. 磁盘临时文件 <targetPath>.partial 预占位前置与同路径陈旧任务原子 supersede；
 * 4. 边写边算流式哈希 (Streaming Hash-on-Write)：Zip 写入临时文件时挂接 PassThrough 实时计算 SHA-256；
 * 5. fsync 强制刷盘后快速 Dry-Run 校验并原子重命名；
 * 6. 1ms 内在内存直接刷出同级旁路 <targetPath>.sha256 文本文件，零二次读盘，杜绝杀软独占锁。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import JSZip from 'jszip'
import * as yauzl from 'yauzl'
import { PluginPathResolver } from '@firefly/shared'
import { computeFileStreamSha256, computeResourceDirSha256 } from './deterministic-hasher'
import type { OfflinePackageDao } from './offline-package-dao'

/**
 * 官方 Ed25519 根公钥常量 (SPKI PEM 格式)
 */
export const ROOT_ED25519_PK = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbEbqhO4NMnk/Y57Hf9vEFv8RNZIzJx20H25Om97twHs=
-----END PUBLIC KEY-----`

/**
 * 使用 Ed25519 验签 manifest
 */
export function verifyManifestSignature(
  manifestContent: string | Buffer,
  signatureHex: string,
  publicKeyPem: string = ROOT_ED25519_PK
): boolean {
  try {
    const data = Buffer.isBuffer(manifestContent)
      ? manifestContent
      : Buffer.from(manifestContent, 'utf-8')
    const sig = Buffer.from(signatureHex.trim(), 'hex')
    return crypto.verify(null, data, publicKeyPem, sig)
  } catch {
    return false
  }
}

export { verifyManifestSignature as verifyManifest }

/**
 * 导出错误码字典 (与 Spec §4.1 对齐)
 */
export type OfflineBundleExportErrorCode =
  | 'EMPTY_SOURCE'
  | 'SIGNATURE_INVALID'
  | 'SOURCE_RESOURCE_CORRUPTED'
  | 'IO_FAILURE'
  | 'CANCELLED'
  | 'BUSY'

/**
 * 离线总包导出异常类
 */
export class OfflineBundleExportError extends Error {
  readonly code: OfflineBundleExportErrorCode
  readonly moduleId?: string
  readonly details?: Record<string, unknown>

  constructor(
    code: OfflineBundleExportErrorCode,
    message: string,
    options?: { moduleId?: string; details?: Record<string, unknown> }
  ) {
    super(message)
    this.name = 'OfflineBundleExportError'
    this.code = code
    this.moduleId = options?.moduleId
    this.details = options?.details
  }
}

/**
 * 模块导出声明元数据
 */
export interface ModuleExportDeclaration {
  id: string
  version: string
  install_state: string
  manifestPath: string
  sigPath: string
  resources: Array<{
    resource_id: string
    asset_name: string
    target_local_path: string
    expected_sha256?: string
    size?: number
  }>
}

/**
 * 根总包清单结构 bundle.manifest.json (不可信索引，删除自指哈希)
 */
export interface BundleManifestModuleItem {
  module_id: string
  version: string
  manifest_sha256: string
}

export interface BundleManifest {
  format_version: number
  bundle_type: 'full_offline_bundle'
  signature_profile: 'official-root-v1'
  created_at: string
  producer_app_version: string
  modules: BundleManifestModuleItem[]
}

/**
 * 导出选项
 */
export interface ExportBundleOptions {
  targetPath: string
  producerAppVersion?: string
  abortSignal?: AbortSignal
  rootPublicKey?: string
}

/**
 * 导出成功结果
 */
export interface ExportBundleResult {
  ok: true
  jobId: string
  moduleCount: number
  totalBytes: number
  filePath: string
  sha256: string
  signatureProfile: 'official-root-v1'
}

/**
 * 后台校验锁状态契约
 */
export interface BackgroundVerificationLockState {
  active: boolean
  isLocked?: boolean
  jobId?: string | null
  archivePath?: string | null
  abortController?: AbortController | null
}

/**
 * 导出上下文依赖接口
 */
export interface BundleExporterContext {
  dao: OfflinePackageDao
  modulesSharedDir: string
  getExportableModules: () => Promise<ModuleExportDeclaration[]>
  backgroundVerificationLock?: BackgroundVerificationLockState
}

function safelyDestroyStream(stream: unknown): void {
  if (stream && typeof (stream as { destroy?: () => void }).destroy === 'function') {
    ;(stream as { destroy: () => void }).destroy()
  }
}

/**
 * 离线总包导出器
 */
export class OfflineBundleExporter {
  private bundleJobLock: 'IDLE' | 'EXPORTING' | 'IMPORTING' = 'IDLE'

  constructor(private readonly ctx: BundleExporterContext) {}

  /**
   * 获取当前任务写锁状态
   */
  getLockStatus(): 'IDLE' | 'EXPORTING' | 'IMPORTING' {
    return this.bundleJobLock
  }

  /**
   * 仅供单元测试注入锁状态
   * @internal
   */
  _setJobLockForTesting(lock: 'IDLE' | 'EXPORTING' | 'IMPORTING'): void {
    this.bundleJobLock = lock
  }

  /**
   * 执行离线总包导出全流程
   */
  async exportOfflineBundle(options: ExportBundleOptions): Promise<ExportBundleResult> {
    const {
      targetPath,
      producerAppVersion = '1.0.0',
      abortSignal,
      rootPublicKey = ROOT_ED25519_PK
    } = options
    const nowMs = Date.now()

    // 1. 细粒度任务互斥锁管理与取消优先协同协议
    await this.acquireExportLock()

    let newJobId: string | null = null
    const partialPath = `${targetPath}.partial`
    const sidecarShaPath = `${targetPath}.sha256`

    try {
      if (abortSignal?.aborted) {
        throw new OfflineBundleExportError('CANCELLED', '用户取消了离线包导出操作')
      }

      // 2. 就绪模块物理盘点与防伪签名审查 (Zero Mock, Zero Fake SK)
      const exportableModules = await this.ctx.getExportableModules()
      if (exportableModules.length === 0) {
        throw new OfflineBundleExportError(
          'EMPTY_SOURCE',
          '当前没有已下载就绪的插件可供导出，请先在插件中心下载所需插件'
        )
      }

      // 预先盘点并加载所有模块原始字节与资源
      const validatedModules: Array<{
        decl: ModuleExportDeclaration
        rawManifestBytes: Buffer
        rawSigString: string
        manifestSha256: string
        validatedAssets: Array<{
          assetName: string
          physicalPath: string
          isDirectory: boolean
        }>
      }> = []

      for (const mod of exportableModules) {
        if (abortSignal?.aborted) {
          throw new OfflineBundleExportError('CANCELLED', '用户取消了离线包导出操作')
        }

        // 检查 manifest.json 与 manifest.sig 是否存在
        if (!fs.existsSync(mod.manifestPath)) {
          throw new OfflineBundleExportError(
            'SOURCE_RESOURCE_CORRUPTED',
            `模块 ${mod.id} 的清单文件不存在: ${mod.manifestPath}`,
            { moduleId: mod.id }
          )
        }
        if (!fs.existsSync(mod.sigPath)) {
          throw new OfflineBundleExportError(
            'SIGNATURE_INVALID',
            `模块 ${mod.id} 缺少官方原始签名文件 manifest.sig`,
            { moduleId: mod.id }
          )
        }

        const rawManifestBytes = await fs.promises.readFile(mod.manifestPath)
        const rawSigString = (await fs.promises.readFile(mod.sigPath, 'utf8')).trim()

        // 严格官方公钥验签 (严禁使用测试私钥伪造补签)
        const isVerified = verifyManifestSignature(rawManifestBytes, rawSigString, rootPublicKey)
        if (!isVerified) {
          throw new OfflineBundleExportError(
            'SIGNATURE_INVALID',
            `模块 ${mod.id} 未通过官方根公钥签名验证，禁止导出非受信模块`,
            { moduleId: mod.id }
          )
        }

        const manifestSha256 = crypto
          .createHash('sha256')
          .update(rawManifestBytes)
          .digest('hex')
          .toLowerCase()

        // 校验关联物理资产
        const validatedAssets: Array<{
          assetName: string
          physicalPath: string
          isDirectory: boolean
        }> = []

        const normalizedSharedDir = path.resolve(this.ctx.modulesSharedDir)
        const pluginsRootDir =
          path.basename(normalizedSharedDir) === '_shared'
            ? path.dirname(normalizedSharedDir)
            : normalizedSharedDir

        for (const res of mod.resources) {
          let physicalPath: string
          if (path.isAbsolute(res.target_local_path)) {
            physicalPath = res.target_local_path
          } else {
            const posixRel = res.target_local_path.replace(/\\/g, '/').replace(/^\/+/, '')
            const targetRoot =
              posixRel.startsWith('modules/_shared/') || posixRel.startsWith('_shared/')
                ? pluginsRootDir
                : normalizedSharedDir
            physicalPath = PluginPathResolver.resolvePhysicalPathForRoot(
              targetRoot,
              res.target_local_path
            )
          }

          if (!fs.existsSync(physicalPath)) {
            throw new OfflineBundleExportError(
              'SOURCE_RESOURCE_CORRUPTED',
              `模块 ${mod.id} 关联的物理资产不存在: ${physicalPath}`,
              { moduleId: mod.id, details: { resourceId: res.resource_id } }
            )
          }

          const stat = await fs.promises.lstat(physicalPath)
          const isDir = stat.isDirectory()

          // 计算资产真实物理哈希
          let actualSha256: string
          if (isDir) {
            actualSha256 = await computeResourceDirSha256(physicalPath, res.resource_id)
          } else {
            actualSha256 = await computeFileStreamSha256(physicalPath)
          }

          if (
            res.expected_sha256 &&
            actualSha256.toLowerCase() !== res.expected_sha256.toLowerCase()
          ) {
            throw new OfflineBundleExportError(
              'SOURCE_RESOURCE_CORRUPTED',
              `模块 ${mod.id} 资产 ${res.resource_id} 哈希损坏 (预期: ${res.expected_sha256}, 实际: ${actualSha256})`,
              {
                moduleId: mod.id,
                details: {
                  resourceId: res.resource_id,
                  expectedSha256: res.expected_sha256,
                  actualSha256
                }
              }
            )
          }

          validatedAssets.push({
            assetName: res.asset_name || path.basename(physicalPath),
            physicalPath,
            isDirectory: isDir
          })
        }

        validatedModules.push({
          decl: mod,
          rawManifestBytes,
          rawSigString,
          manifestSha256,
          validatedAssets
        })
      }

      // 3. 磁盘临时占位前置与同路径原子 Supersede 铁律
      // 3.1 磁盘临时文件创建 (若不可写或磁盘满抛出 IO_FAILURE，零数据库副作用)
      try {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
        const partialHandle = await fs.promises.open(partialPath, 'w')
        await partialHandle.close()
      } catch (err: unknown) {
        const error = err as Error
        throw new OfflineBundleExportError(
          'IO_FAILURE',
          `无法在目标路径创建临时导出文件: ${error.message}`,
          { details: { targetPath: partialPath, reason: error.message } }
        )
      }

      // 3.2 开启协调表原子 Supersede 事务并登记新 EXPORTING 任务
      newJobId = crypto.randomUUID()
      this.ctx.dao.supersedeAndCreateExportJob(
        targetPath,
        {
          job_id: newJobId,
          job_type: 'EXPORT',
          status: 'EXPORTING',
          archive_path: targetPath,
          total_modules: validatedModules.length,
          created_resource_ids: [],
          reused_resource_ids: [],
          created_at: nowMs,
          updated_at: nowMs
        },
        nowMs
      )

      // 4. 构建 Zip 包并边写边算流式哈希 (Streaming Hash-on-Write)
      const zip = new JSZip()

      // 4.1 构建根总包元数据 bundle.manifest.json (不可信索引，删除自指哈希)
      const rootManifest: BundleManifest = {
        format_version: 1,
        bundle_type: 'full_offline_bundle',
        signature_profile: 'official-root-v1',
        created_at: new Date(nowMs).toISOString(),
        producer_app_version: producerAppVersion,
        modules: validatedModules.map(m => ({
          module_id: m.decl.id,
          version: m.decl.version,
          manifest_sha256: m.manifestSha256
        }))
      }

      zip.file('bundle.manifest.json', JSON.stringify(rootManifest, null, 2), {
        compression: 'DEFLATE'
      })

      // 4.2 模块清单与签名以原始字节写入，物理资产以 STORE 写入
      for (const m of validatedModules) {
        const modPrefix = `modules/${m.decl.id}`
        // 原始磁盘字节写入，严禁往返破坏格式
        zip.file(`${modPrefix}/manifest.json`, m.rawManifestBytes, {
          compression: 'DEFLATE'
        })
        zip.file(`${modPrefix}/manifest.sig`, m.rawSigString, {
          compression: 'DEFLATE'
        })

        // 打包物理资产
        for (const asset of m.validatedAssets) {
          const assetZipRelPath = `${modPrefix}/assets/${asset.assetName}`
          if (asset.isDirectory) {
            await this.addDirectoryToZipRecursively(zip, asset.physicalPath, assetZipRelPath)
          } else {
            // 普通文件通过流式挂接，设置 compression 为 STORE
            zip.file(assetZipRelPath, fs.createReadStream(asset.physicalPath), {
              compression: 'STORE'
            })
          }
        }
      }

      // 4.3 流式边写边算 SHA-256
      const { calculatedSha256, totalBytes } = await this.streamZipAndHashToFile(
        zip,
        partialPath,
        abortSignal
      )

      // 4.4 fsync 强制落盘
      const fd = await fs.promises.open(partialPath, 'r+')
      try {
        await fd.sync()
      } finally {
        await fd.close()
      }

      // 4.5 执行快速 Dry-Run 结构校验
      await this.verifyZipStructure(partialPath)

      // 4.6 原子重命名 <targetPath>.partial ➔ <targetPath>
      await fs.promises.rename(partialPath, targetPath)

      // 4.7 1ms 内在内存直接刷出同级旁路 <targetPath>.sha256 文本文件 (零二次读盘，杜绝杀软独占锁)
      const sha256Content = `${calculatedSha256}  ${path.basename(targetPath)}\n`
      await fs.promises.writeFile(sidecarShaPath, sha256Content, 'utf8')

      // 4.8 更新协调表为 FINISHED
      this.ctx.dao.updateJobStatus(newJobId, 'FINISHED', { nowMs: Date.now() })

      return {
        ok: true,
        jobId: newJobId,
        moduleCount: validatedModules.length,
        totalBytes,
        filePath: targetPath,
        sha256: calculatedSha256,
        signatureProfile: 'official-root-v1'
      }
    } catch (err: unknown) {
      const error = err as Error
      // 导出中途取消或报错：清理临时半成品，更新协调表为 FAILED
      try {
        if (fs.existsSync(partialPath)) {
          await fs.promises.rm(partialPath, { force: true })
        }
      } catch {
        // 忽略清理临时文件失败
      }

      if (newJobId) {
        try {
          this.ctx.dao.updateJobStatus(newJobId, 'FAILED', { nowMs: Date.now() })
        } catch {
          // 忽略更新 DAO 失败
        }
      }

      if (err instanceof OfflineBundleExportError) {
        throw err
      }
      throw new OfflineBundleExportError('IO_FAILURE', `离线总包导出失败: ${error.message}`, {
        details: { reason: error.message }
      })
    } finally {
      this.bundleJobLock = 'IDLE'
    }
  }

  /**
   * 递归将物理目录内容追加至 zip
   */
  private async addDirectoryToZipRecursively(
    zip: JSZip,
    localDirPath: string,
    zipDirPath: string
  ): Promise<void> {
    const entries = await fs.promises.readdir(localDirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(localDirPath, entry.name)
      const targetZipPath = `${zipDirPath}/${entry.name}`

      if (entry.isDirectory()) {
        await this.addDirectoryToZipRecursively(zip, fullPath, targetZipPath)
      } else if (entry.isFile()) {
        zip.file(targetZipPath, fs.createReadStream(fullPath), {
          compression: 'STORE'
        })
      }
    }
  }

  /**
   * 将 Zip 流式写入文件并挂接计算 SHA-256
   */
  private async streamZipAndHashToFile(
    zip: JSZip,
    targetFilePath: string,
    abortSignal?: AbortSignal
  ): Promise<{ calculatedSha256: string; totalBytes: number }> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      let totalBytes = 0

      const writeStream = fs.createWriteStream(targetFilePath, { flags: 'w' })
      const nodeStream = zip.generateNodeStream({
        type: 'nodebuffer',
        streamFiles: true
      })

      const onAbort = () => {
        safelyDestroyStream(nodeStream)
        writeStream.destroy()
        reject(new OfflineBundleExportError('CANCELLED', '用户取消了离线包导出操作'))
      }

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort()
          return
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      nodeStream.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        totalBytes += chunk.length
      })

      nodeStream.on('error', err => {
        writeStream.destroy()
        reject(err)
      })

      writeStream.on('error', err => {
        safelyDestroyStream(nodeStream)
        reject(err)
      })

      writeStream.on('finish', () => {
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort)
        }
        const calculatedSha256 = hash.digest('hex').toLowerCase()
        resolve({ calculatedSha256, totalBytes })
      })

      nodeStream.pipe(writeStream)
    })
  }

  /**
   * 快速 Dry-Run 结构校验 (验证 ZIP 文件的完整性与根清单存在)
   */
  async verifyZipStructure(zipFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) {
          return reject(
            new OfflineBundleExportError('IO_FAILURE', `ZIP 结构校验失败: ${err?.message}`)
          )
        }

        let foundRootManifest = false

        zipfile.on('entry', entry => {
          if (entry.fileName === 'bundle.manifest.json') {
            foundRootManifest = true
          }
          zipfile.readEntry()
        })

        zipfile.on('end', () => {
          zipfile.close()
          if (!foundRootManifest) {
            reject(
              new OfflineBundleExportError(
                'IO_FAILURE',
                '导出的 ZIP 文件缺失根目录 bundle.manifest.json 清单'
              )
            )
          } else {
            resolve()
          }
        })

        zipfile.on('error', zipErr => {
          zipfile.close()
          reject(new OfflineBundleExportError('IO_FAILURE', `ZIP 校验过程抛错: ${zipErr.message}`))
        })

        zipfile.readEntry()
      })
    })
  }

  /**
   * 获取并协商导出互斥写锁 (取消优先与 2000ms 有界等待)
   */
  private async acquireExportLock(): Promise<void> {
    if (this.bundleJobLock !== 'IDLE') {
      throw new OfflineBundleExportError('BUSY', '已有离线包任务正在执行中，系统处于互斥保护中')
    }

    const bgLock = this.ctx.backgroundVerificationLock
    if (bgLock && bgLock.active) {
      if (bgLock.abortController) {
        bgLock.abortController.abort()
      }

      // 2000ms 有界等待，每 50ms 轮询一次
      const maxWaitMs = 2000
      const pollIntervalMs = 50
      const startTime = Date.now()

      while (bgLock.active && Date.now() - startTime < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      }

      if (bgLock.active) {
        throw new OfflineBundleExportError('BUSY', '后台正在释放文件句柄，请稍候重试', {
          details: { troubleshootingHint: '后台正在释放文件句柄，请稍候重试' }
        })
      }
    }

    this.bundleJobLock = 'EXPORTING'
  }
}
