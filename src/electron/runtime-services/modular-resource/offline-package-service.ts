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
import { logger, LogCategory } from '@firefly/shared'
import type { ModularResourceService, BuiltinModuleView } from '../system/modular-resource-service'
import { fileDownloadService, safeResolveZipEntry } from '../system/file-download-service'

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
    const baseDir = service.getBaseDir()
    const moduleSharedDir = path.join(baseDir, 'modules', '_shared', moduleId)

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
    const originalSigPath = path.join(moduleSharedDir, 'manifest.sig')
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
   * 导入离线插件包 (.ffp / .zip)
   *
   * 严格遵循 Sign-Then-Extract 流水线：
   * 1. 掐断在线下载流；
   * 2. 读取 manifest.json 与 manifest.sig 并执行 Ed25519 验签；
   * 3. Zip-Slip 路径逃逸断言与 2GB 配额检查；
   * 4. 解压至临时目录并比对各资源 SHA-256；
   * 5. 原子移动并单事务持久化入库。
   */
  async importOfflinePackage(
    archivePath: string,
    options?: {
      rootPublicKey?: string
    }
  ): Promise<BuiltinModuleView> {
    if (!fs.existsSync(archivePath)) {
      throw new Error(`离线插件包文件不存在: ${archivePath}`)
    }

    // 阶段 0：离线导入互斥，掐断后台在途下载网络流
    try {
      fileDownloadService.abortAll()
    } catch {}

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
      throw new Error('离线插件包损坏：缺少 manifest.json 或 manifest.sig 元数据文件')
    }

    const manifestBuffer = await manifestFile.async('nodebuffer')
    const manifestStr = manifestBuffer.toString('utf-8')
    const sigHex = (await sigFile.async('nodebuffer')).toString('utf-8').trim()

    // 阶段 2：官方根公钥验签 (Ed25519)
    const pubKey = options?.rootPublicKey ?? ROOT_ED25519_PK
    const isValid = verifyManifestSignature(manifestBuffer, sigHex, pubKey)
    if (!isValid) {
      throw new OfflinePackageVerificationError(
        '官方公钥验签失败：离线安装包已被篡改或非官方授权签名'
      )
    }

    const manifest: OfflinePackageManifest = JSON.parse(manifestStr)
    const moduleId = manifest.module?.module_id
    if (!moduleId) {
      throw new Error('manifest.json 中未定义 module_id')
    }

    // Zip-Slip 前置校验：统一调用 safeResolveZipEntry 校验 manifest.resources 中声明的 target_local_path
    for (const res of manifest.resources || []) {
      try {
        safeResolveZipEntry(process.cwd(), res.target_local_path)
      } catch {
        throw new ZipSlipSecurityError(
          `检测到潜在的 Zip-Slip 目录逃逸路径: ${res.target_local_path}`
        )
      }
    }

    const service = this.getService()
    const baseDir = service.getBaseDir()
    const stagingDir = path.join(
      baseDir,
      'modules',
      '_shared',
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

      // 阶段 4：落地流式校验 SHA-256
      for (const res of manifest.resources) {
        const expectedSha = res.expected_sha256?.trim().toLowerCase()
        if (!expectedSha) continue

        const extractedResPath = path.resolve(stagingDir, res.target_local_path)
        if (!fs.existsSync(extractedResPath)) {
          throw new Error(`离线包中缺失资源声明的物理文件: ${res.target_local_path}`)
        }

        const stat = fs.statSync(extractedResPath)
        if (stat.isFile()) {
          const actualSha = computeFileSha256(extractedResPath).toLowerCase()
          if (actualSha !== expectedSha) {
            throw new Error(
              `资源 SHA-256 校验失败: ${res.resource_id} (期望: ${expectedSha}, 实际: ${actualSha})`
            )
          }
        }
      }

      // 阶段 5：物理迁移与持久化入库
      // 将 staging 目录下的资源移动到 baseDir 对应的真实路径
      for (const res of manifest.resources) {
        const extractedResPath = path.resolve(stagingDir, res.target_local_path)
        const targetPhysicalPath = service.resolvePhysicalPath(res.target_local_path)
        const targetParentDir = path.dirname(targetPhysicalPath)
        if (!fs.existsSync(targetParentDir)) {
          fs.mkdirSync(targetParentDir, { recursive: true })
        }

        // 若已存在旧目录或文件，先使用 rmSync 清理
        if (fs.existsSync(targetPhysicalPath)) {
          fs.rmSync(targetPhysicalPath, { recursive: true, force: true })
        }

        // 尝试重命名，跨盘符则复制
        try {
          fs.renameSync(extractedResPath, targetPhysicalPath)
        } catch {
          fs.cpSync(extractedResPath, targetPhysicalPath, { recursive: true })
          fs.rmSync(extractedResPath, { recursive: true, force: true })
        }
      }

      // 缓存 manifest.sig 与 manifest.json 到 modules/_shared/<moduleId>/
      const finalModuleSharedDir = path.join(baseDir, 'modules', '_shared', moduleId)
      if (!fs.existsSync(finalModuleSharedDir)) {
        fs.mkdirSync(finalModuleSharedDir, { recursive: true })
      }
      fs.writeFileSync(path.join(finalModuleSharedDir, 'manifest.json'), manifestStr, 'utf8')
      fs.writeFileSync(path.join(finalModuleSharedDir, 'manifest.sig'), sigHex, 'utf8')

      // 阶段 6：数据库单事务持久化
      const db = service.getDb()
      const dao = service.getDao()

      const tx = db.transaction(() => {
        // 1. 写入/更新 resource_downloads
        for (const res of manifest.resources) {
          const absPath = service.resolvePhysicalPath(res.target_local_path)
          const bytes = fs.existsSync(absPath) ? fs.statSync(absPath).size : (res.size ?? 0)
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

        // 2. 写入/更新 builtin_modules
        const existingMod = dao.modules.findByIdSync(moduleId)
        const slot = manifest.module.capability_slot ?? existingMod?.capability_slot ?? 'general'
        const policy = manifest.module.slot_policy ?? existingMod?.slot_policy ?? 'multi_active'
        const backend = (manifest.module.backend_type ??
          existingMod?.backend_type ??
          'builtin') as any

        // 决定初始安装状态：
        // 若为 base_embedding 或 base_ai_engine 且当前系统没有任何已激活的基础引擎，则自动激活
        let targetInstallState = 'installed_inactive'
        if (slot === 'base_embedding' || slot === 'base_ai_engine') {
          const activeEngine = dao.modules.findActiveBySlotSync(slot as any)
          if (!activeEngine) {
            targetInstallState = 'active'
          }
        }

        dao.modules.upsertModuleSync({
          id: moduleId,
          version: manifest.module.version,
          capability_slot: slot as any,
          slot_policy: policy as any,
          backend_type: backend,
          install_state: targetInstallState as any,
          user_config: existingMod?.user_config ?? null,
          user_consent: existingMod?.user_consent ?? 0
        })

        // 3. 关联 module_resource_downloads (两表记录均已就绪，满足外键约束)
        for (const res of manifest.resources) {
          dao.resources.bindResourceToModuleSync(moduleId, res.resource_id)
        }
      })

      tx()

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
