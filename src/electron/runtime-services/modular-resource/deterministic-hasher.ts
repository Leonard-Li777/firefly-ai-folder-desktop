/**
 * 确定性共享资源目录哈希与资产划分 (Deterministic Hasher & Resource Partitioning)
 *
 * 核心职责：
 * 1. 确定性计算资源目录/文件的 SHA-256 哈希 (三端同构标准实现)；
 * 2. 拦截系统保留名称、符号链接、空目录、大小写与 NFC/NFD 折叠冲突；
 * 3. Phase 1 物理提升前基于磁盘存量事实执行静态去重划分 (created vs reused)。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * 系统保留共享命名常量白名单
 * 扫描 userData/modules/_shared/ 或计算资源目录时，必须首先显式跳过这些系统保留目录/文件：
 * - _conflicts（历史冲突隔离根目录）
 * - _staging（同卷解压暂存目录）
 * - *.old-*（单版本原子替换临时备份）
 * - *.uninstalled-*（卸载物理保留备份）
 * - *.deleting-*（Tombstone 待清理目录）
 * - *.incoming-*（已废弃模式残留）
 * - 以 . 开头的隐藏文件/隐藏目录（如 .DS_Store、.gitkeep）
 */
export const SYSTEM_RESERVED_SHARED_NAMES: readonly string[] = ['_conflicts', '_staging']

/**
 * 判断条目名称是否属于系统保留命名
 */
export function isSystemReservedSharedName(name: string): boolean {
  if (name.startsWith('.')) {
    return true
  }
  if (name === '_conflicts' || name === '_staging') {
    return true
  }
  if (
    name.includes('.old-') ||
    name.includes('.uninstalled-') ||
    name.includes('.deleting-') ||
    name.includes('.incoming-')
  ) {
    return true
  }
  return false
}

/**
 * 资源目录非法异常 (大小写/Unicode 折叠冲突、软链接等)
 */
export class ResourceDirInvalidError extends Error {
  readonly code = 'RESOURCE_DIR_INVALID' as const
  readonly relPathA: string
  readonly relPathB: string
  readonly reason: string

  constructor(relPathA: string, relPathB: string, reason: string) {
    super(`Resource directory invalid: ${reason} ('${relPathA}' vs '${relPathB}')`)
    this.name = 'ResourceDirInvalidError'
    this.relPathA = relPathA
    this.relPathB = relPathB
    this.reason = reason
  }
}

/**
 * 空资源目录异常
 */
export class EmptyResourceDirError extends Error {
  readonly code = 'EMPTY_RESOURCE_DIR' as const
  readonly resourceId?: string

  constructor(resourceId?: string) {
    super(
      `Resource directory contains no valid files${resourceId ? ` (resource: ${resourceId})` : ''}`
    )
    this.name = 'EmptyResourceDirError'
    this.resourceId = resourceId
  }
}

/**
 * 共享资源哈希冲突异常
 */
export class ResourceConflictError extends Error {
  readonly code = 'RESOURCE_CONFLICT' as const
  readonly resourceId: string
  readonly expectedSha256: string
  readonly actualSha256: string

  constructor(resourceId: string, expectedSha256: string, actualSha256: string) {
    super(
      `Shared resource '${resourceId}' already exists with conflicting hash (expected: ${expectedSha256}, actual: ${actualSha256})`
    )
    this.name = 'ResourceConflictError'
    this.resourceId = resourceId
    this.expectedSha256 = expectedSha256
    this.actualSha256 = actualSha256
  }
}

/**
 * 单条目路径安全超限异常
 */
export class ZipEntryRejectedError extends Error {
  readonly code = 'ZIP_ENTRY_REJECTED' as const
  readonly entryName: string
  readonly reason: string

  constructor(entryName: string, reason: string) {
    super(`Zip entry rejected: ${reason} (entry: '${entryName}')`)
    this.name = 'ZipEntryRejectedError'
    this.entryName = entryName
    this.reason = reason
  }
}

/**
 * 共享资源声明接口
 */
export interface ResourceDecl {
  resource_id: string
  asset_name?: string
  expected_sha256?: string
}

/**
 * 资产划分结果
 */
export interface PartitionedResources {
  createdResourceIds: string[]
  reusedResourceIds: string[]
}

/**
 * 流式计算单个普通文件的 SHA-256 小写十六进制
 */
export async function computeFileStreamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()))
    stream.on('error', err => reject(err))
  })
}

// 别名导出，方便调用
export { computeFileStreamSha256 as computeFileSha256 }

interface ScannedFileEntry {
  normRelPath: string
  fullPath: string
}

export interface ScanLimits {
  maxNameLength?: number
  maxPathLength?: number
}

/**
 * 递归收集目录下的所有合法文件条目并执行折叠冲突前置拦截
 */
export async function collectValidFilesRecursively(
  rootDir: string,
  currentDir: string,
  foldingMap: Map<string, string>,
  collected: ScannedFileEntry[],
  limits: ScanLimits = {}
): Promise<void> {
  const maxNameLength = limits.maxNameLength ?? 255
  const maxPathLength = limits.maxPathLength ?? 4096
  const dirEntries = await fs.promises.readdir(currentDir, { withFileTypes: true })

  for (const entry of dirEntries) {
    const entryName = entry.name

    // 显式跳过系统保留命名与隐藏文件
    if (isSystemReservedSharedName(entryName)) {
      continue
    }

    // 单段目录/文件名不超过限制字符数 (默认 255)
    if (entryName.length > maxNameLength) {
      throw new ZipEntryRejectedError(
        entryName,
        `Directory or file name exceeds ${maxNameLength} characters limit`
      )
    }

    const fullPath = path.join(currentDir, entryName)
    const stat = await fs.promises.lstat(fullPath)

    // 严格阻断符号链接、连接点与重解析点
    if (stat.isSymbolicLink()) {
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/')
      throw new ResourceDirInvalidError(
        relPath,
        relPath,
        'Symbolic links, junctions, or reparse points are strictly prohibited'
      )
    }

    if (stat.isDirectory()) {
      await collectValidFilesRecursively(rootDir, fullPath, foldingMap, collected, limits)
    } else if (stat.isFile()) {
      const relPath = path.relative(rootDir, fullPath)
      const posixRelPath = relPath.split(path.sep).join('/')

      // 总相对路径字节限制 (默认 4096)
      if (Buffer.byteLength(posixRelPath, 'utf8') > maxPathLength) {
        throw new ZipEntryRejectedError(
          posixRelPath,
          `Total relative path exceeds ${maxPathLength} bytes limit`
        )
      }

      // 相对路径 NFC 规范化与全小写归一
      const normRelPath = posixRelPath.normalize('NFC').toLowerCase()

      // 大小写 / Unicode 规范化折叠冲突硬拦截
      const existingRelPath = foldingMap.get(normRelPath)
      if (existingRelPath !== undefined && existingRelPath !== posixRelPath) {
        throw new ResourceDirInvalidError(
          existingRelPath,
          posixRelPath,
          'Case-folding or Unicode normalization collision detected'
        )
      }

      foldingMap.set(normRelPath, posixRelPath)
      collected.push({ normRelPath, fullPath })
    }
  }
}

/**
 * 确定性计算资源目录或单文件的 SHA-256 哈希 (三端同构标准实现)
 *
 * 核心流程：
 * 1. 若为单文件，直接流式读取并返回其 SHA-256 小写 hex；
 * 2. 递归扫描目录下所有普通文件（阻断 symlink / reparse point / junction）；
 * 3. 显式跳过 SYSTEM_RESERVED_SHARED_NAMES；
 * 4. 相对路径正斜杠标准化、NFC 规范化并全小写；
 * 5. 折叠冲突防御：若同一目录下存在 NFC/NFD 或大小写折叠冲突条目，强行抛出 RESOURCE_DIR_INVALID；
 * 6. 空目录防御：若目录内无任何有效文件，强行抛出 EMPTY_RESOURCE_DIR（杜绝暴露敏感绝对路径）；
 * 7. 按 normRelPath 升序字节排序；
 * 8. 将所有条目的 sha256 + '  ' + normRelPath + '\n' 拼接为清单文本，对其计算最终 SHA-256 并返回十六进制小写字符串。
 *
 * @param resourcePath 目标文件或目录路径
 * @param resourceId 可选的资源标识（用于空目录报错时不暴露物理绝对路径）
 */
export async function computeResourceDirSha256(
  resourcePath: string,
  resourceId?: string,
  limits?: ScanLimits
): Promise<string> {
  const stat = await fs.promises.lstat(resourcePath)

  // 严格阻断根路径符号链接
  if (stat.isSymbolicLink()) {
    const safeDisplay = resourceId || path.basename(resourcePath)
    throw new ResourceDirInvalidError(
      safeDisplay,
      safeDisplay,
      'Symbolic links, junctions, or reparse points are strictly prohibited'
    )
  }

  // 单文件直接计算流式 SHA-256
  if (stat.isFile()) {
    return computeFileStreamSha256(resourcePath)
  }

  if (!stat.isDirectory()) {
    const safeDisplay = resourceId || path.basename(resourcePath)
    throw new ResourceDirInvalidError(
      safeDisplay,
      safeDisplay,
      'Resource path is neither a regular file nor a directory'
    )
  }

  const foldingMap = new Map<string, string>()
  const collectedFiles: ScannedFileEntry[] = []

  await collectValidFilesRecursively(resourcePath, resourcePath, foldingMap, collectedFiles, limits)

  // 空目录防御
  if (collectedFiles.length === 0) {
    throw new EmptyResourceDirError(resourceId || path.basename(resourcePath))
  }

  // 按正斜杠规范化后的 normRelPath 升序排序 (严格 Unicode 代码点顺序，消除宿主 Locale 排序差异)
  collectedFiles.sort((a, b) =>
    a.normRelPath < b.normRelPath ? -1 : a.normRelPath > b.normRelPath ? 1 : 0
  )

  // 清单拼接与最终哈希计算
  const manifestHash = crypto.createHash('sha256')
  for (const item of collectedFiles) {
    const fileSha = await computeFileStreamSha256(item.fullPath)
    manifestHash.update(`${fileSha}  ${item.normRelPath}\n`, 'utf8')
  }

  return manifestHash.digest('hex').toLowerCase()
}

/**
 * Phase 1 物理提升前基于磁盘存量事实的全局静态去重划分机制
 *
 * 核心不变量：
 * 1. 在物理移动任何文件前，基于当前磁盘真实存在性与 computeResourceDirSha256 比对；
 * 2. 静态产出 createdResourceIds 与 reusedResourceIds；
 * 3. 若已存在但哈希冲突，立即抛出 RESOURCE_CONFLICT；
 * 4. 多模块总包内共享同一新资源时，两个模块引用的该资源仅在 createdResourceIds 中出现一次，
 *    绝不发生集合交叉污染或重复。
 *
 * @param resources 清单中声明的所有模块资源集合
 * @param sharedDir 共享资源正式目录 (如 userData/modules/_shared/)
 */
export async function partitionResourcesByDiskState(
  resources: ResourceDecl[],
  sharedDir: string
): Promise<PartitionedResources> {
  const uniqueResources = new Map<string, ResourceDecl>()

  // 1. 全局静态去重并前置核验声明一致性
  for (const res of resources) {
    if (!res.resource_id) {
      continue
    }
    const existing = uniqueResources.get(res.resource_id)
    if (!existing) {
      uniqueResources.set(res.resource_id, res)
    } else {
      if (
        res.expected_sha256 &&
        existing.expected_sha256 &&
        res.expected_sha256.toLowerCase() !== existing.expected_sha256.toLowerCase()
      ) {
        throw new ResourceConflictError(
          res.resource_id,
          res.expected_sha256,
          existing.expected_sha256
        )
      }
    }
  }

  const createdResourceIds: string[] = []
  const reusedResourceIds: string[] = []

  // 2. 遍历独占资源对照磁盘物理事实进行划分
  for (const [resourceId, decl] of uniqueResources.entries()) {
    const targetPath = path.join(sharedDir, resourceId)

    let exists = false
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK)
      exists = true
    } catch {
      exists = false
    }

    if (!exists) {
      createdResourceIds.push(resourceId)
      continue
    }

    // 物理存在，计算当前实际哈希
    const actualSha256 = await computeResourceDirSha256(targetPath, resourceId)

    // 若声明了期望哈希，执行确定性比对
    if (decl.expected_sha256) {
      if (actualSha256.toLowerCase() !== decl.expected_sha256.toLowerCase()) {
        throw new ResourceConflictError(resourceId, decl.expected_sha256, actualSha256)
      }
    }

    reusedResourceIds.push(resourceId)
  }

  // 排序确保输出确定性
  createdResourceIds.sort()
  reusedResourceIds.sort()

  return {
    createdResourceIds,
    reusedResourceIds
  }
}
