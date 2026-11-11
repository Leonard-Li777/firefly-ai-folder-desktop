/**
 * 客户端原生离线插件包 (.ffp / .zip) 验签与导入导出服务
 *
 * 核心安全机制：
 * 1. 导出：原包原签透传导出 (Sign-Preserving Export)，不持有官方私钥，仅对已完成下载的官方内置模块生效；
 * 2. 导入：Sign-Then-Extract 严格离线流水线
 *    - 中央目录只读解析：在不解压全局文件前提下流式读取 manifest.json 与 manifest.sig；
 *    - 官方根公钥验签：使用 ROOT_ED25519_PK 强校验 Ed25519 签名，验签失败直接终止；
 *    - 两层防逃逸解压：Zip-Slip 目录逃逸断言与单文件 2GB 解压配额限制；
 *    - 落地流式校验：解压物理资产逐一核对 manifest 声明的 SHA-256；
 *    - 状态持久化：主库单事务内写入 resource_downloads 与 builtin_modules。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import JSZip from 'jszip'
import * as yauzl from 'yauzl'
import {
  logger,
  LogCategory,
  PluginPathResolver,
  SecurityViolationError,
  computeDirectoryReadyDigest,
  writeReadyMarker,
  invalidateReadyMarkers,
  normalizeCapabilitySlot
} from '@firefly/shared'
import type { ModularResourceService, BuiltinModuleView } from '../system/modular-resource-service'
import {
  fileDownloadService,
  safeResolveZipEntry,
  safeExtractZip
} from '../system/file-download-service'
import { computeFileStreamSha256, computeResourceDirSha256 } from './deterministic-hasher'
import type { BundleManifest } from './offline-bundle-exporter'

/**
 * 官方 Ed25519 根公钥常量 (SPKI PEM 格式)
 */
export const ROOT_ED25519_PK = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbEbqhO4NMnk/Y57Hf9vEFv8RNZIzJx20H25Om97twHs=
-----END PUBLIC KEY-----`

/**
 * 测试/开发环境下的签名私钥 (仅用于单元测试与本地开发自签)
 */
export const TEST_ED25519_SK = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKGwIbpF/QyjrXzc8FBbw/oB5szFDqGQVkLLSFbqB2Cc
-----END PRIVATE KEY-----`

function computePathTotalBytesSync(targetPath: string): number {
  const st = fs.lstatSync(targetPath)
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  let total = 0
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(targetPath, entry.name)
    const itemStat = fs.lstatSync(full)
    if (itemStat.isSymbolicLink()) continue
    if (itemStat.isFile()) {
      total += itemStat.size
    } else if (itemStat.isDirectory()) {
      total += computePathTotalBytesSync(full)
    }
  }
  return total
}

/**
 * 单文件解压配额限制 (2GB)
 */
export const MAX_SINGLE_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * 签名校验失败异常
 */
export class OfflinePackageVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflinePackageVerificationError'
  }
}

/**
 * Zip Slip 逃逸安全异常
 */
export class ZipSlipSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipSlipSecurityError'
  }
}

export interface OfflinePackageManifest {
  version: number
  created_at: string
  module: {
    module_id: string
    name: string
    version: string
    capability_slot?: string
    slot_policy?: string
    backend_type?: string
    description?: string
    author?: string
    tags?: string[]
    contributes?: any
  }
  resources: Array<{
    resource_id: string
    asset_name: string
    target_local_path: string
    expected_sha256?: string
    size?: number
  }>
}

/**
 * 使用 Ed25519 签名 manifest
 */
export function signManifest(
  manifestContent: string | Buffer,
  privateKeyPem: string = TEST_ED25519_SK
): string {
  const data = Buffer.isBuffer(manifestContent)
    ? manifestContent
    : Buffer.from(manifestContent, 'utf-8')
  const sig = crypto.sign(null, data, privateKeyPem)
  return sig.toString('hex')
}

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
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[OfflinePackage] Ed25519 签名验证内部异常:', err)
    return false
  }
}

/**
 * 计算文件的 SHA-256
 */
export function computeFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256')
  const data = fs.readFileSync(filePath)
  hash.update(data)
  return hash.digest('hex')
}

export class OfflinePackageService {
  private static instance: OfflinePackageService | null = null
  private serviceProvider?: () => ModularResourceService
  private serviceInstance?: ModularResourceService

  constructor(serviceOrProvider?: ModularResourceService | (() => ModularResourceService)) {
    if (typeof serviceOrProvider === 'function') {
      this.serviceProvider = serviceOrProvider
    } else if (serviceOrProvider) {
      this.serviceInstance = serviceOrProvider
    }
  }

  static getInstance(service?: ModularResourceService): OfflinePackageService {
    if (!OfflinePackageService.instance) {
      OfflinePackageService.instance = new OfflinePackageService(service)
    }
    return OfflinePackageService.instance
  }

  private getService(): ModularResourceService {
    if (this.serviceInstance) return this.serviceInstance
    if (this.serviceProvider) return this.serviceProvider()
    const { modularResourceService } = require('../system/modular-resource-service')
    return modularResourceService
  }

  /**
   * 导出离线插件包 (.ffp / .zip)
   *
   * 规范要求：
   * 1. 仅对所有绑定的物理资源均处于 completed 状态的模块生效；
   * 2. 原包原签透传：优先复用 modules/_shared/<module_id>/manifest.sig，若为测试环境或没有原版签名可允许传入测试私钥签名。
   */
  async exportOfflinePackage(
    moduleId: string,
    targetFilePath: string,
    options?: {
      signerPrivateKey?: string
    }
  ): Promise<string> {
    const service = this.getService()
    const dao = service.getDao()
    const mod = dao.modules.findByIdSync(moduleId)
    if (!mod) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    const boundResources = dao.resources.findResourcesByModuleSync(moduleId)
    if (boundResources.length === 0) {
      throw new Error(`模块未关联任何物理资源: ${moduleId}`)
    }

    // 检查是否所有绑定的物理资源均处于 completed 状态
    for (const res of boundResources) {
      if (res.download_state !== 'completed') {
        throw new Error(
          `模块绑定的资源尚未完成下载 (${res.resource_id}: ${res.download_state})，无法导出`
        )
      }
      const absPath = service.resolvePhysicalPath(res.target_local_path)
      if (!fs.existsSync(absPath)) {
        throw new Error(`资源物理文件不存在: ${absPath}`)
      }
    }

    const zip = new JSZip()
    const pluginsRootDir = service.getPluginsRootDir()
    const ssotManifestDir = PluginPathResolver.getModuleManifestDirForRoot(pluginsRootDir, moduleId)
    const legacyManifestDir = path.join(pluginsRootDir, '_shared', moduleId)
    const moduleManifestDir = fs.existsSync(path.join(ssotManifestDir, 'manifest.sig'))
      ? ssotManifestDir
      : legacyManifestDir

    // 构建 Manifest
    const manifest: OfflinePackageManifest = {
      version: 1,
      created_at: new Date().toISOString(),
      module: {
        module_id: mod.id,
        name: (mod as any).name ?? mod.id,
        version: mod.version,
        capability_slot: mod.capability_slot ?? undefined,
        slot_policy: mod.slot_policy ?? undefined,
        backend_type: mod.backend_type ?? undefined,
        description: (mod as any).description ?? undefined,
        author: (mod as any).author_name ?? undefined,
        tags: (mod as any).tags ? JSON.parse((mod as any).tags) : undefined,
        contributes: (mod as any).contributes ?? undefined
      },
      resources: boundResources.map(res => ({
        resource_id: res.resource_id,
        asset_name: res.asset_name,
        target_local_path: res.target_local_path,
        expected_sha256: res.expected_sha256 ?? undefined,
        size: res.expected_bytes ?? undefined
      }))
    }

    const manifestJsonStr = JSON.stringify(manifest, null, 2)
    zip.file('manifest.json', manifestJsonStr)

    // 签名保护：优先复用官方原版 manifest.sig
    const originalSigPath = path.join(moduleManifestDir, 'manifest.sig')
    let sigHex = ''
    if (fs.existsSync(originalSigPath)) {
      sigHex = fs.readFileSync(originalSigPath, 'utf8').trim()
    } else {
      // 降级使用传入私钥或开发/测试私钥生成签名
      sigHex = signManifest(manifestJsonStr, options?.signerPrivateKey ?? TEST_ED25519_SK)
    }
    zip.file('manifest.sig', sigHex)

    // 打包资源文件
    for (const res of boundResources) {
      const absPath = service.resolvePhysicalPath(res.target_local_path)
      const stat = fs.statSync(absPath)
      if (stat.isDirectory()) {
        const addFolderToZip = (folderPath: string, zipSubDir: any) => {
          const files = fs.readdirSync(folderPath)
          for (const f of files) {
            const fullPath = path.join(folderPath, f)
            const fStat = fs.statSync(fullPath)
            if (fStat.isDirectory()) {
              addFolderToZip(fullPath, zipSubDir.folder(f))
            } else {
              zipSubDir.file(f, fs.readFileSync(fullPath))
            }
          }
        }
        const relPath = path.normalize(res.target_local_path).replace(/\\/g, '/')
        addFolderToZip(absPath, zip.folder(relPath))
      } else {
        const relPath = path.normalize(res.target_local_path).replace(/\\/g, '/')
        zip.file(relPath, fs.readFileSync(absPath))
      }
    }

    // 生成 Zip 产物并写入目标路径
    const targetDir = path.dirname(targetFilePath)
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    })
    fs.writeFileSync(targetFilePath, buffer)

    logger.info(LogCategory.SYSTEM, `[OfflinePackage] 导出离线插件包成功: ${targetFilePath}`)
    return targetFilePath
  }

  /**
   * 仅读取 ZIP 中指定的小型元数据条目（不加载资产字节到内存）
   */
  private async inspectArchiveMetadata(archivePath: string): Promise<{
    isFullBundle: boolean
    entryNames: Set<string>
    readSmallEntry: (entryName: string) => Promise<Buffer | null>
  }> {
    const MAX_META_BYTES = 10 * 1024 * 1024
    const entryNames = new Set<string>()
    await new Promise<void>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
        if (err || !zipfile) {
          return reject(new Error(`无法打开离线包文件: ${err?.message || '未知错误'}`))
        }
        zipfile.on('entry', entry => {
          if (!entry.fileName.endsWith('/')) {
            entryNames.add(entry.fileName)
          }
          zipfile.readEntry()
        })
        zipfile.on('end', () => resolve())
        zipfile.on('error', zipErr => reject(zipErr))
        zipfile.readEntry()
      })
    })

    const readSmallEntry = (targetName: string): Promise<Buffer | null> => {
      if (!entryNames.has(targetName)) return Promise.resolve(null)
      return new Promise((resolve, reject) => {
        yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
          if (err || !zipfile) {
            return reject(new Error(`读取离线包元数据失败: ${err?.message || '未知错误'}`))
          }
          let found = false
          const safeClose = () => {
            try {
              zipfile.close()
            } catch {}
          }
          zipfile.on('entry', entry => {
            if (entry.fileName !== targetName) {
              zipfile.readEntry()
              return
            }
            found = true
            if (entry.uncompressedSize > MAX_META_BYTES) {
              safeClose()
              return reject(new Error(`清单元数据超出安全上限: ${targetName}`))
            }
            zipfile.openReadStream(entry, (streamErr, stream) => {
              if (streamErr || !stream) {
                safeClose()
                return reject(streamErr || new Error(`无法读取条目: ${targetName}`))
              }
              const chunks: Buffer[] = []
              let total = 0
              stream.on('data', (chunk: Buffer) => {
                total += chunk.length
                if (total > MAX_META_BYTES) {
                  stream.destroy()
                  safeClose()
                  reject(new Error(`清单元数据实际体积超出安全上限: ${targetName}`))
                  return
                }
                chunks.push(chunk)
              })
              stream.on('end', () => {
                safeClose()
                resolve(Buffer.concat(chunks))
              })
              stream.on('error', sErr => {
                safeClose()
                reject(sErr)
              })
            })
          })
          zipfile.on('end', () => {
            safeClose()
            if (!found) resolve(null)
          })
          zipfile.on('error', zipErr => {
            safeClose()
            reject(zipErr)
          })
          zipfile.readEntry()
        })
      })
    }

    return {
      isFullBundle: entryNames.has('bundle.manifest.json'),
      entryNames,
      readSmallEntry
    }
  }

  /**
   * 流式将 ZIP 资产解压至 stagingDir（防 Zip-Slip、防解压炸弹、单文件 ≤ 2GB）
   */
  private async extractArchiveStreamingToStaging(
    archivePath: string,
    stagingDir: string
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
        if (err || !zipfile) {
          return reject(new Error(`无法流式读取离线包: ${err?.message || '未知错误'}`))
        }
        let settled = false
        const fail = (error: Error) => {
          if (settled) return
          settled = true
          try {
            zipfile.close()
          } catch {}
          reject(error)
        }

        zipfile.on('error', zipErr => fail(zipErr))
        zipfile.on('end', () => {
          if (settled) return
          settled = true
          try {
            zipfile.close()
          } catch {}
          resolve()
        })

        zipfile.on('entry', entry => {
          if (settled) return
          if (entry.fileName.endsWith('/')) {
            zipfile.readEntry()
            return
          }

          let outPath: string
          try {
            outPath = safeResolveZipEntry(stagingDir, entry.fileName)
          } catch {
            fail(
              new ZipSlipSecurityError(`路径解析超出目标解压目录或非法路径注入: ${entry.fileName}`)
            )
            return
          }

          if (entry.compressedSize > 0 && entry.uncompressedSize > 1024 * 1024) {
            const ratio = entry.uncompressedSize / entry.compressedSize
            if (ratio > 100) {
              fail(new Error(`检测到潜在解压炸弹: ${entry.fileName} (压缩比 ${ratio.toFixed(1)})`))
              return
            }
          }

          if (entry.uncompressedSize > MAX_SINGLE_FILE_SIZE_BYTES) {
            fail(
              new Error(
                `单文件超出 2GB 解压配额限制: ${entry.fileName} (${entry.uncompressedSize} bytes)`
              )
            )
            return
          }

          fs.mkdirSync(path.dirname(outPath), { recursive: true })
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              fail(streamErr || new Error(`无法读取解压流: ${entry.fileName}`))
              return
            }
            const writeStream = fs.createWriteStream(outPath)
            let actualBytes = 0
            readStream.on('data', (chunk: Buffer) => {
              actualBytes += chunk.length
              if (actualBytes > MAX_SINGLE_FILE_SIZE_BYTES) {
                readStream.destroy()
                writeStream.destroy()
                fail(new Error(`单文件流式解压超出 2GB 配额限制: ${entry.fileName}`))
              }
            })
            readStream.on('error', rErr => {
              writeStream.destroy()
              fail(rErr)
            })
            writeStream.on('error', wErr => {
              readStream.destroy()
              fail(wErr)
            })
            writeStream.on('finish', () => {
              if (!settled) zipfile.readEntry()
            })
            readStream.pipe(writeStream)
          })
        })

        zipfile.readEntry()
      })
    })
  }

  /**
   * 校验并物化单个资源到目标物理路径（兼容目录资产与需二次解包的 .zip 资产）
   */
  private async verifyAndMaterializeResource(
    service: ModularResourceService,
    stagingDir: string,
    moduleId: string,
    res: OfflinePackageManifest['resources'][number]
  ): Promise<void> {
    const safeAssetName = res.asset_name
      ? res.asset_name.replace(/\\/g, '/').replace(/^\/+/, '')
      : ''
    let extractedResPath: string | null = null

    if (safeAssetName) {
      try {
        const candidateAssetPath = safeResolveZipEntry(
          path.join(stagingDir, 'modules', moduleId, 'assets'),
          safeAssetName
        )
        if (fs.existsSync(candidateAssetPath)) {
          extractedResPath = candidateAssetPath
        }
      } catch {
        throw new ZipSlipSecurityError(`检测到潜在的资产文件名逃逸路径: ${res.asset_name}`)
      }
    }

    if (!extractedResPath) {
      const fallbackPath = safeResolveZipEntry(stagingDir, res.target_local_path)
      if (fs.existsSync(fallbackPath)) {
        extractedResPath = fallbackPath
      }
    }

    if (!extractedResPath) {
      throw new Error(`离线包中缺失资源声明的物理文件: ${res.target_local_path}`)
    }

    const expectedSha = res.expected_sha256?.trim().toLowerCase()
    const stat = fs.statSync(extractedResPath)
    if (expectedSha) {
      const actualSha = stat.isFile()
        ? (await computeFileStreamSha256(extractedResPath)).toLowerCase()
        : (await computeResourceDirSha256(extractedResPath, res.resource_id)).toLowerCase()
      if (actualSha !== expectedSha) {
        throw new Error(
          `资源 SHA-256 校验失败: ${res.resource_id} (期望: ${expectedSha}, 实际: ${actualSha})`
        )
      }
    }

    const targetPhysicalPath = service.resolvePhysicalPath(res.target_local_path)
    const targetParentDir = path.dirname(targetPhysicalPath)
    if (!fs.existsSync(targetParentDir)) {
      fs.mkdirSync(targetParentDir, { recursive: true })
    }

    if (fs.existsSync(targetPhysicalPath)) {
      await invalidateReadyMarkers(targetPhysicalPath)
      fs.rmSync(targetPhysicalPath, { recursive: true, force: true })
    }

    const lowerSource = extractedResPath.toLowerCase()
    const lowerTarget = targetPhysicalPath.toLowerCase()
    if (stat.isFile() && lowerSource.endsWith('.zip') && !lowerTarget.endsWith('.zip')) {
      await safeExtractZip(extractedResPath, targetPhysicalPath)
    } else {
      try {
        fs.renameSync(extractedResPath, targetPhysicalPath)
      } catch {
        fs.cpSync(extractedResPath, targetPhysicalPath, { recursive: true })
        fs.rmSync(extractedResPath, { recursive: true, force: true })
      }
    }

    if (fs.existsSync(targetPhysicalPath) && fs.statSync(targetPhysicalPath).isDirectory()) {
      await invalidateReadyMarkers(targetPhysicalPath)
      const digestResult = await computeDirectoryReadyDigest(targetPhysicalPath)
      await writeReadyMarker(targetPhysicalPath, {
        resourceId: res.resource_id,
        sharedSubDir: path.basename(targetPhysicalPath),
        digestResult
      })
    }
  }

  /**
   * 标准化解析单模块 manifest.json（兼容 { module: { module_id } } 与扁平 { id } 结构）
   */
  private parseNormalizedModuleManifest(
    rawBytes: Buffer,
    expectedModuleId?: string
  ): {
    moduleId: string
    name: string
    version: string
    capability_slot?: string
    slot_policy?: string
    backend_type?: string
    resources: OfflinePackageManifest['resources']
  } {
    const parsed = JSON.parse(rawBytes.toString('utf-8')) as Record<string, any>
    const modBlock = parsed.module && typeof parsed.module === 'object' ? parsed.module : parsed
    const moduleId = String(modBlock.module_id ?? modBlock.id ?? '').trim()
    if (!moduleId) {
      throw new Error('manifest.json 中未定义 module_id')
    }
    if (expectedModuleId && moduleId !== expectedModuleId) {
      throw new OfflinePackageVerificationError(
        `模块身份不匹配：预期 ${expectedModuleId}，清单声明为 ${moduleId}`
      )
    }
    return {
      moduleId,
      name: String(modBlock.name ?? moduleId),
      version: String(modBlock.version ?? '1.0.0'),
      capability_slot: modBlock.capability_slot,
      slot_policy: modBlock.slot_policy,
      backend_type: modBlock.backend_type,
      resources: Array.isArray(parsed.resources) ? parsed.resources : []
    }
  }

  /**
   * 导入全量离线总包 (bundle.manifest.json + modules/<id>/...)
   */
  private async importFullOfflineBundle(
    archivePath: string,
    readSmallEntry: (entryName: string) => Promise<Buffer | null>,
    options?: {
      rootPublicKey?: string
      preferredEngineId?: string
    }
  ): Promise<BuiltinModuleView> {
    const bundleManifestBuf = await readSmallEntry('bundle.manifest.json')
    if (!bundleManifestBuf) {
      throw new Error('离线总包损坏：缺少 bundle.manifest.json')
    }

    const bundleManifest = JSON.parse(bundleManifestBuf.toString('utf-8')) as BundleManifest
    if (
      bundleManifest.bundle_type !== 'full_offline_bundle' ||
      !Array.isArray(bundleManifest.modules) ||
      bundleManifest.modules.length === 0
    ) {
      throw new Error('离线总包格式无效：bundle.manifest.json 缺少有效的 modules 清单')
    }

    const pubKey = options?.rootPublicKey ?? ROOT_ED25519_PK
    const seenModuleIds = new Set<string>()
    const service = this.getService()
    const pluginsRootDir = service.getPluginsRootDir()

    const verifiedModules: Array<{
      rawManifestBytes: Buffer
      sigHex: string
      meta: ReturnType<OfflinePackageService['parseNormalizedModuleManifest']>
    }> = []

    // 阶段 1：Sign-Then-Extract —— 在写入任何资产前先对全量模块清单执行 Ed25519 验签与路径安全校验
    for (const item of bundleManifest.modules) {
      const modId = String(item.module_id || '').trim()
      if (!modId || seenModuleIds.has(modId)) {
        throw new Error(`离线总包清单存在非法或重复模块 ID: ${item.module_id}`)
      }
      seenModuleIds.add(modId)

      const rawManifestBytes = await readSmallEntry(`modules/${modId}/manifest.json`)
      const sigBuf = await readSmallEntry(`modules/${modId}/manifest.sig`)
      if (!rawManifestBytes || !sigBuf) {
        throw new Error(`离线总包损坏：模块 ${modId} 缺少 manifest.json 或 manifest.sig`)
      }

      if (item.manifest_sha256) {
        const actualManifestSha = crypto
          .createHash('sha256')
          .update(rawManifestBytes)
          .digest('hex')
          .toLowerCase()
        if (actualManifestSha !== item.manifest_sha256.trim().toLowerCase()) {
          throw new OfflinePackageVerificationError(
            `离线总包损坏：模块 ${modId} 清单哈希与索引声明不一致`
          )
        }
      }

      const sigHex = sigBuf.toString('utf-8').trim()
      if (!verifyManifestSignature(rawManifestBytes, sigHex, pubKey)) {
        throw new OfflinePackageVerificationError(
          `官方公钥验签失败：模块 ${modId} 的离线安装包已被篡改或非官方授权签名`
        )
      }

      const meta = this.parseNormalizedModuleManifest(rawManifestBytes, modId)
      for (const res of meta.resources) {
        try {
          safeResolveZipEntry(process.cwd(), res.target_local_path)
          PluginPathResolver.resolvePhysicalPathForRoot(pluginsRootDir, res.target_local_path)
        } catch (err) {
          if (err instanceof SecurityViolationError || err instanceof ZipSlipSecurityError) {
            throw new ZipSlipSecurityError(
              `检测到潜在的 Zip-Slip 目录逃逸路径: ${res.target_local_path}`
            )
          }
          throw new ZipSlipSecurityError(
            `检测到潜在的 Zip-Slip 目录逃逸路径: ${res.target_local_path}`
          )
        }
      }

      verifiedModules.push({ rawManifestBytes, sigHex, meta })
    }

    const stagingDir = path.join(
      pluginsRootDir,
      '_staging',
      `bundle.import-${Date.now()}-${Math.random().toString(36).substring(7)}`
    )

    try {
      fs.mkdirSync(stagingDir, { recursive: true })

      // 阶段 2：流式解压至临时暂存目录
      await this.extractArchiveStreamingToStaging(archivePath, stagingDir)

      // 阶段 3：资源去重校验与安全物化
      const materializedResources = new Set<string>()
      for (const { rawManifestBytes, sigHex, meta } of verifiedModules) {
        for (const res of meta.resources) {
          if (!materializedResources.has(res.resource_id)) {
            await this.verifyAndMaterializeResource(service, stagingDir, meta.moduleId, res)
            materializedResources.add(res.resource_id)
          }
        }

        const finalManifestDir = PluginPathResolver.getModuleManifestDirForRoot(
          pluginsRootDir,
          meta.moduleId
        )
        if (!fs.existsSync(finalManifestDir)) {
          fs.mkdirSync(finalManifestDir, { recursive: true })
        }
        fs.writeFileSync(path.join(finalManifestDir, 'manifest.json'), rawManifestBytes)
        fs.writeFileSync(path.join(finalManifestDir, 'manifest.sig'), sigHex, 'utf8')
      }

      // 阶段 4：数据库单事务持久化与基础检索引擎自动激活
      const db = service.getDb()
      const dao = service.getDao()
      let autoActivatedSlotModuleId: string | null = null
      let primaryBaseEngineId: string | null = null

      const tx = db.transaction(() => {
        const upsertedResources = new Set<string>()
        for (const { meta } of verifiedModules) {
          for (const res of meta.resources) {
            if (upsertedResources.has(res.resource_id)) continue
            upsertedResources.add(res.resource_id)
            const absPath = service.resolvePhysicalPath(res.target_local_path)
            const bytes = fs.existsSync(absPath)
              ? computePathTotalBytesSync(absPath)
              : (res.size ?? 0)
            dao.resources.createOrGetTaskSync({
              resource_id: res.resource_id,
              asset_name: res.asset_name,
              target_local_path: res.target_local_path,
              active_source_key: 'auto',
              download_state: 'completed',
              expected_bytes: bytes,
              expected_sha256: res.expected_sha256 ?? ''
            })
            dao.resources.markVerifiedSync(res.resource_id, true, res.expected_sha256)
          }
        }

        // 检查当前是否已有激活的基础语义引擎（统一归一化别名槽位防止击穿 ux_exclusive_active_slot）
        const activeBaseEmbedding = dao.modules.findActiveBySlotSync('base_embedding')

        // 预先选出本次导入中应激活的基础检索引擎（避免同槽位双活触发 ux_exclusive_active_slot）
        const baseCandidates = verifiedModules.filter(({ meta }) => {
          const existingMod = dao.modules.findByIdSync(meta.moduleId)
          const slot = normalizeCapabilitySlot(
            meta.capability_slot ?? existingMod?.capability_slot ?? 'general'
          )
          return slot === 'base_embedding'
        })

        let chosenAutoActivateId: string | null = null
        if (baseCandidates.length > 0) {
          const preferred = options?.preferredEngineId
            ? baseCandidates.find(c => c.meta.moduleId === options.preferredEngineId)
            : undefined
          const fallbackDefault =
            baseCandidates.find(c => c.meta.moduleId === 'engine_gemma_unified') ??
            baseCandidates[0]
          primaryBaseEngineId = (preferred ?? fallbackDefault).meta.moduleId

          if (!activeBaseEmbedding) {
            chosenAutoActivateId = primaryBaseEngineId
          } else {
            primaryBaseEngineId = activeBaseEmbedding.id
          }
        }

        for (const { meta } of verifiedModules) {
          const existingMod = dao.modules.findByIdSync(meta.moduleId)
          const slot = normalizeCapabilitySlot(
            meta.capability_slot ?? existingMod?.capability_slot ?? 'general'
          )
          const policy = meta.slot_policy ?? existingMod?.slot_policy ?? 'multi_active'
          const backend = (meta.backend_type ?? existingMod?.backend_type ?? 'builtin') as any

          let targetInstallState =
            existingMod?.install_state === 'active' ? 'active' : 'installed_inactive'
          if (chosenAutoActivateId === meta.moduleId) {
            targetInstallState = 'active'
            autoActivatedSlotModuleId = meta.moduleId
          }

          dao.modules.upsertModuleSync({
            id: meta.moduleId,
            version: meta.version,
            capability_slot: slot as any,
            slot_policy: policy as any,
            backend_type: backend,
            install_state: targetInstallState as any,
            user_config: existingMod?.user_config ?? null,
            user_consent: existingMod?.user_consent ?? 0
          })

          for (const res of meta.resources) {
            dao.resources.bindResourceToModuleSync(meta.moduleId, res.resource_id)
          }
        }
      })

      tx()

      if (autoActivatedSlotModuleId) {
        await service.notifyRuntimePluginTopologyChanged?.({
          moduleId: autoActivatedSlotModuleId,
          reason: 'offline_bundle_import',
          restartPolicy: 'ensure-running'
        })
      }

      const returnModuleId = primaryBaseEngineId ?? verifiedModules[0].meta.moduleId
      logger.info(
        LogCategory.SYSTEM,
        `[OfflinePackage] 离线总包导入成功 (共 ${verifiedModules.length} 个模块, 主返回=${returnModuleId})`
      )
      return service.getModule(returnModuleId)!
    } finally {
      if (fs.existsSync(stagingDir)) {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true })
        } catch {}
      }
    }
  }

  /**
   * 导入离线插件包 / 离线总包 (.ffp / .zip)
   *
   * 严格遵循 Sign-Then-Extract 流水线：
   * 1. 掐断在线下载流；
   * 2. 识别全量离线总包 (bundle.manifest.json) 或单模块包，读取清单与 manifest.sig 并执行 Ed25519 验签；
   * 3. Zip-Slip 路径逃逸断言与 2GB 配额检查；
   * 4. 解压至临时目录并比对各资源 SHA-256；
   * 5. 原子移动并单事务持久化入库。
   */
  async importOfflinePackage(
    archivePath: string,
    options?: {
      rootPublicKey?: string
      preferredEngineId?: string
    }
  ): Promise<BuiltinModuleView> {
    if (!fs.existsSync(archivePath)) {
      throw new Error(`离线插件包文件不存在: ${archivePath}`)
    }

    // 阶段 0：离线导入互斥，掐断后台在途下载网络流
    try {
      fileDownloadService.abortAll()
    } catch {}

    const inspected = await this.inspectArchiveMetadata(archivePath)
    if (inspected.isFullBundle) {
      return await this.importFullOfflineBundle(archivePath, inspected.readSmallEntry, options)
    }

    const fileBuffer = fs.readFileSync(archivePath)
    const zip = await JSZip.loadAsync(fileBuffer, {
      decodeFileName: (bytes: string[] | Buffer | Uint8Array) =>
        Array.isArray(bytes)
          ? Buffer.from(
              bytes.map(b => (typeof b === 'number' ? (b as number) : parseInt(b, 10)))
            ).toString('utf-8')
          : Buffer.from(bytes).toString('utf-8')
    })

    // 阶段 1：中央目录只读解析
    const manifestFile = zip.file('manifest.json')
    const sigFile = zip.file('manifest.sig')
    if (!manifestFile || !sigFile) {
      throw new Error(
        '离线插件包损坏：缺少 bundle.manifest.json 或 manifest.json / manifest.sig 元数据文件'
      )
    }

    const manifestBuffer = await manifestFile.async('nodebuffer')
    const sigHex = (await sigFile.async('nodebuffer')).toString('utf-8').trim()

    // 阶段 2：官方根公钥验签 (Ed25519)
    const pubKey = options?.rootPublicKey ?? ROOT_ED25519_PK
    const isValid = verifyManifestSignature(manifestBuffer, sigHex, pubKey)
    if (!isValid) {
      throw new OfflinePackageVerificationError(
        '官方公钥验签失败：离线安装包已被篡改或非官方授权签名'
      )
    }

    const manifestMeta = this.parseNormalizedModuleManifest(manifestBuffer)
    const moduleId = manifestMeta.moduleId

    // Zip-Slip 前置校验：统一调用 safeResolveZipEntry 校验 manifest.resources 中声明的 target_local_path
    for (const res of manifestMeta.resources) {
      try {
        safeResolveZipEntry(process.cwd(), res.target_local_path)
      } catch {
        throw new ZipSlipSecurityError(
          `检测到潜在的 Zip-Slip 目录逃逸路径: ${res.target_local_path}`
        )
      }
    }

    const service = this.getService()
    const pluginsRootDir = service.getPluginsRootDir()
    const stagingDir = path.join(
      pluginsRootDir,
      '_staging',
      `${moduleId}.import-${Date.now()}-${Math.random().toString(36).substring(7)}`
    )

    try {
      fs.mkdirSync(stagingDir, { recursive: true })

      // 阶段 3：两层防逃逸解压与 2GB 限制
      const entries = Object.keys(zip.files)
      for (const entryName of entries) {
        const entry = zip.files[entryName]
        if (entry.dir) continue

        // 统一使用 safeResolveZipEntry 进行安全路径解析与防逃逸拦截
        let outPath: string
        try {
          outPath = safeResolveZipEntry(stagingDir, entryName)
        } catch {
          throw new ZipSlipSecurityError(`路径解析超出目标解压目录或非法路径注入: ${entryName}`)
        }

        // 解压单文件大小配额检查
        const entryBuffer = await entry.async('nodebuffer')
        if (entryBuffer.length > MAX_SINGLE_FILE_SIZE_BYTES) {
          throw new Error(`单文件超出 2GB 解压配额限制: ${entryName} (${entryBuffer.length} bytes)`)
        }

        const entryDir = path.dirname(outPath)
        if (!fs.existsSync(entryDir)) {
          fs.mkdirSync(entryDir, { recursive: true })
        }
        fs.writeFileSync(outPath, entryBuffer)
      }

      // 阶段 4 & 5：落地校验 SHA-256 与物理迁移
      for (const res of manifestMeta.resources) {
        await this.verifyAndMaterializeResource(service, stagingDir, moduleId, res)
      }

      // 缓存 manifest.sig 与 manifest.json 到 SSOT 隔离清单目录 `_module_manifests/<moduleId>/`
      const finalManifestDir = PluginPathResolver.getModuleManifestDirForRoot(
        pluginsRootDir,
        moduleId
      )
      if (!fs.existsSync(finalManifestDir)) {
        fs.mkdirSync(finalManifestDir, { recursive: true })
      }
      fs.writeFileSync(path.join(finalManifestDir, 'manifest.json'), manifestBuffer)
      fs.writeFileSync(path.join(finalManifestDir, 'manifest.sig'), sigHex, 'utf8')

      // 阶段 6：数据库单事务持久化
      const db = service.getDb()
      const dao = service.getDao()
      let autoActivatedSlotModuleId: string | null = null

      const tx = db.transaction(() => {
        // 1. 写入/更新 resource_downloads
        for (const res of manifestMeta.resources) {
          const absPath = service.resolvePhysicalPath(res.target_local_path)
          const bytes = fs.existsSync(absPath)
            ? computePathTotalBytesSync(absPath)
            : (res.size ?? 0)
          dao.resources.createOrGetTaskSync({
            resource_id: res.resource_id,
            asset_name: res.asset_name,
            target_local_path: res.target_local_path,
            active_source_key: 'auto',
            download_state: 'completed',
            expected_bytes: bytes,
            expected_sha256: res.expected_sha256 ?? ''
          })
          dao.resources.markVerifiedSync(res.resource_id, true, res.expected_sha256)
        }

        // 2. 写入/更新 builtin_modules（入口强制归一化能力槽位，防止别名击穿 ux_exclusive_active_slot）
        const existingMod = dao.modules.findByIdSync(moduleId)
        const slot = normalizeCapabilitySlot(
          manifestMeta.capability_slot ?? existingMod?.capability_slot ?? 'general'
        )
        const policy = manifestMeta.slot_policy ?? existingMod?.slot_policy ?? 'multi_active'
        const backend = (manifestMeta.backend_type ?? existingMod?.backend_type ?? 'builtin') as any

        // 决定初始安装状态：
        // 若为 base_embedding 且当前系统没有任何已激活的基础引擎，则自动激活
        let targetInstallState =
          existingMod?.install_state === 'active' ? 'active' : 'installed_inactive'
        if (slot === 'base_embedding') {
          const activeEngine = dao.modules.findActiveBySlotSync('base_embedding')
          if (!activeEngine) {
            targetInstallState = 'active'
            autoActivatedSlotModuleId = moduleId
          }
        }

        dao.modules.upsertModuleSync({
          id: moduleId,
          version: manifestMeta.version,
          capability_slot: slot as any,
          slot_policy: policy as any,
          backend_type: backend,
          install_state: targetInstallState as any,
          user_config: existingMod?.user_config ?? null,
          user_consent: existingMod?.user_consent ?? 0
        })

        // 3. 关联 module_resource_downloads (两表记录均已就绪，满足外键约束)
        for (const res of manifestMeta.resources) {
          dao.resources.bindResourceToModuleSync(moduleId, res.resource_id)
        }
      })

      tx()

      if (autoActivatedSlotModuleId) {
        await service.notifyRuntimePluginTopologyChanged?.({
          moduleId: autoActivatedSlotModuleId,
          reason: 'offline_bundle_import',
          restartPolicy: 'ensure-running'
        })
      }

      logger.info(LogCategory.SYSTEM, `[OfflinePackage] 离线插件包导入成功: ${moduleId}`)
      return service.getModule(moduleId)!
    } finally {
      // 清理临时 staging 目录
      if (fs.existsSync(stagingDir)) {
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true })
        } catch {}
      }
    }
  }
}

export const offlinePackageService = OfflinePackageService.getInstance()
