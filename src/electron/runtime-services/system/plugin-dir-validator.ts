/**
 * 插件存储目录校验管线与无副作用试探器 (PluginDirValidator)
 *
 * 严格落实 11 步路径校验防御管线与零副作用试探铁律：
 * 1. 去首尾空白
 * 2. 路径非空校验 (EMPTY_PATH)
 * 3. 绝对路径校验 (PATH_NOT_ABSOLUTE)
 * 4. UNC 路径拦截 (UNC_PATH_FORBIDDEN)
 * 5. 纯 ASCII 强门禁 (PATH_NOT_ASCII)
 * 6. 空白字符强拦截 (PATH_HAS_WHITESPACE)
 * 7. 非法字符及段尾点拦截 (PATH_ILLEGAL_CHAR)
 * 8. Windows 保留设备名拦截 (PATH_RESERVED_DEVICE_NAME)
 * 9. 长度预算核查 <= 150 (PATH_TOO_LONG)
 * 10. 根目录/系统目录/嵌套同源校验 (SYSTEM_DIR_FORBIDDEN, NESTED_PATH_FORBIDDEN, SAME_AS_CURRENT)
 * 11. 零副作用可写性安全试探 & 动态空间预检 (PATH_NOT_A_DIRECTORY, PATH_NOT_WRITABLE, INSUFFICIENT_SPACE)
 *
 * @doc-anchor: docs/specs/custom-plugin-directory-and-mirror-download-spec.md §3.1 ~ §3.4
 */

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { isSubPath, isPathEqual } from '@firefly/shared'
import type { PluginDirErrorCode, ValidatePluginDirResult } from '@firefly/types/config-types'

export class ModularResourceError extends Error {
  constructor(
    public readonly code: PluginDirErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`)
    this.name = 'ModularResourceError'
  }
}

/** Windows 保留设备名称集合（忽略大小写，包含带扩展名形式如 CON.txt、COM1.dat） */
export const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

export function isReservedDeviceName(segment: string): boolean {
  if (!segment) return false
  const baseName = segment.split('.')[0].toLowerCase()
  return RESERVED_DEVICE_NAMES.has(baseName)
}

/** 安全线性正则，消除 ReDoS 风险 */
export const RESERVED_DEVICE_REG = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^.]+)?$/i

/**
 * 获取指定路径所在磁盘的剩余可用空间
 */
export function getDiskFreeSpace(dirPath: string): { freeBytes: number; totalBytes: number } {
  let checkDir = path.resolve(dirPath)
  while (!fs.existsSync(checkDir)) {
    const parent = path.dirname(checkDir)
    if (parent === checkDir) break
    checkDir = parent
  }

  let freeBytes = Number.MAX_SAFE_INTEGER
  let totalBytes = Number.MAX_SAFE_INTEGER
  try {
    if (typeof (fs as any).statfsSync === 'function') {
      const stats = (fs as any).statfsSync(checkDir)
      freeBytes = Number(stats.bavail) * Number(stats.bsize)
      totalBytes = Number(stats.blocks) * Number(stats.bsize)
    }
  } catch {
    // 回退兜底
  }

  return { freeBytes, totalBytes }
}

/**
 * 步骤 11：零副作用可写性安全试探与动态空间预检
 *
 * 在静态规则未完全通过前严禁调用！
 * 若目标目录不存在，仅在最近已存在的父祖先目录试探写权限，严禁擅自提前递归创建多级目录。
 */
export async function probeDirectoryWritableAndSpace(
  targetPath: string,
  totalSourceBytes: number
): Promise<{ writable: boolean; freeBytes: number }> {
  const resolved = path.resolve(targetPath)
  const exists = fs.existsSync(resolved)

  // 若目标路径已存在，首先检查是否为普通文件
  if (exists) {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      throw new ModularResourceError(
        'PATH_NOT_A_DIRECTORY',
        'Target path exists but is a regular file.'
      )
    }
  }

  // 若目标目录尚不存在，仅寻找其最近一级已存在的父祖先目录试探写权限
  let testParent = resolved
  if (!exists) {
    let curr = resolved
    while (!fs.existsSync(curr)) {
      const parent = path.dirname(curr)
      if (parent === curr) break
      curr = parent
    }
    testParent = curr
  }

  // 1. 动态空间预检：requiredBytes = totalBytes + max(512MB, totalBytes * 5%)
  const stats = getDiskFreeSpace(testParent)
  const extraBuffer = Math.max(512 * 1024 * 1024, Math.ceil(totalSourceBytes * 0.05))
  const requiredBytes = totalSourceBytes + extraBuffer
  if (stats.freeBytes < requiredBytes) {
    throw new ModularResourceError(
      'INSUFFICIENT_SPACE',
      `Target disk requires at least ${requiredBytes} bytes, but only ${stats.freeBytes} bytes available.`
    )
  }

  // 2. 独占创建临时试探文件并写入数据
  const testFile = path.join(
    testParent,
    `.probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  )
  try {
    const fd = fs.openSync(
      testFile,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o666
    )
    fs.writeSync(fd, Buffer.from('firefly-write-test'))
    fs.closeSync(fd)
    return { writable: true, freeBytes: stats.freeBytes }
  } catch (err: any) {
    throw new ModularResourceError(
      'PATH_NOT_WRITABLE',
      `Target path is not writable: ${err?.message || 'Access denied'}`
    )
  } finally {
    try {
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile)
      }
    } catch {
      // 忽略清理异常
    }
  }
}

/**
 * 获取系统受保护核心目录列表（Windows 平台与通用保护路径）
 */
function getSystemProtectedPaths(): string[] {
  const protectedPaths: string[] = []

  // Windows 常用系统环境变量
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) protectedPaths.push(path.resolve(process.env.SystemRoot))
    if (process.env.windir) protectedPaths.push(path.resolve(process.env.windir))
    if (process.env.ProgramFiles) protectedPaths.push(path.resolve(process.env.ProgramFiles))
    if (process.env['ProgramFiles(x86)']) {
      protectedPaths.push(path.resolve(process.env['ProgramFiles(x86)']))
    }
    if (process.env.CommonProgramFiles) {
      protectedPaths.push(path.resolve(process.env.CommonProgramFiles))
    }
    if (process.env['CommonProgramFiles(x86)']) {
      protectedPaths.push(path.resolve(process.env['CommonProgramFiles(x86)']))
    }
  }

  // Electron 标准特殊路径（桌面、下载等易清理通用目录）
  try {
    if (typeof app !== 'undefined' && typeof app.getPath === 'function') {
      try {
        protectedPaths.push(path.resolve(app.getPath('desktop')))
      } catch {}
      try {
        protectedPaths.push(path.resolve(app.getPath('downloads')))
      } catch {}
    }
  } catch {}

  return protectedPaths
}

export interface ValidatePluginDirectoryOptions {
  totalSourceBytes?: number
  currentInstalledModuleIds?: string[]
  skipProbe?: boolean
}

/**
 * 执行完整的 11 步插件目录校验管线
 */
export async function validatePluginDirectory(
  rawPath: string | null | undefined,
  currentRootDir: string | null | undefined,
  options?: ValidatePluginDirectoryOptions
): Promise<ValidatePluginDirResult> {
  const totalSourceBytes = options?.totalSourceBytes ?? 0
  const currentInstalledModuleIds = options?.currentInstalledModuleIds ?? []

  try {
    // 步骤 1: 去除首尾空白并规范化
    const trimmed = (rawPath ?? '').trim()

    // 步骤 2: 路径非空校验 (EMPTY_PATH)
    if (!trimmed) {
      throw new ModularResourceError('EMPTY_PATH', 'Plugin directory path cannot be empty.')
    }

    // 步骤 3: 绝对路径校验 (PATH_NOT_ABSOLUTE)
    if (!path.isAbsolute(trimmed)) {
      throw new ModularResourceError(
        'PATH_NOT_ABSOLUTE',
        'Plugin directory must be an absolute path.'
      )
    }

    // 步骤 4: UNC 路径拦截 (UNC_PATH_FORBIDDEN)
    if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
      throw new ModularResourceError(
        'UNC_PATH_FORBIDDEN',
        'UNC network paths (\\\\server\\share) are not supported.'
      )
    }

    // 步骤 5: 纯 ASCII 强门禁 (PATH_NOT_ASCII)
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i)
      if (code < 0x20 || code > 0x7e) {
        throw new ModularResourceError(
          'PATH_NOT_ASCII',
          'Path must consist of pure ASCII characters (no Chinese or special Unicode characters).'
        )
      }
    }

    // 步骤 6: 空白字符强拦截 (PATH_HAS_WHITESPACE)
    if (/\s/.test(trimmed)) {
      throw new ModularResourceError(
        'PATH_HAS_WHITESPACE',
        'Path must not contain any spaces, tabs, or whitespace.'
      )
    }

    // 步骤 7: 非法字符及段尾点拦截 (PATH_ILLEGAL_CHAR)
    // 盘符（如 C:）冒号是合法的，但在盘符后禁止出现任何冒号；全路径禁止 * ? < > " |
    const normalizedSlash = trimmed.replace(/\\/g, '/')
    const segments = normalizedSlash.split('/')

    // 盘符检查
    let startIndex = 0
    if (/^[a-zA-Z]:$/.test(segments[0])) {
      startIndex = 1
    }

    for (let i = startIndex; i < segments.length; i++) {
      const seg = segments[i]
      if (seg === '' && i === segments.length - 1) {
        // 允许末尾有单个斜杠，但内部不允许空段
        continue
      }
      if (seg === '') {
        throw new ModularResourceError('PATH_ILLEGAL_CHAR', 'Path contains illegal empty segments.')
      }
      // 禁止包含非法字符 * ? < > " | :
      if (/[*?<>"|:]/.test(seg)) {
        throw new ModularResourceError(
          'PATH_ILLEGAL_CHAR',
          `Path segment "${seg}" contains illegal characters.`
        )
      }
      // 禁止段尾以点结尾
      if (seg.endsWith('.')) {
        throw new ModularResourceError(
          'PATH_ILLEGAL_CHAR',
          `Path segment "${seg}" cannot end with a dot.`
        )
      }
    }

    // 步骤 8: Windows 保留设备名拦截 (PATH_RESERVED_DEVICE_NAME)
    for (let i = startIndex; i < segments.length; i++) {
      const seg = segments[i]
      if (!seg) continue
      if (isReservedDeviceName(seg)) {
        throw new ModularResourceError(
          'PATH_RESERVED_DEVICE_NAME',
          `Path segment "${seg}" uses a reserved Windows device name.`
        )
      }
    }

    // 步骤 9: 长度预算核查 <= 150 (PATH_TOO_LONG)
    const resolved = path.resolve(trimmed)
    if (resolved.length > 150) {
      throw new ModularResourceError(
        'PATH_TOO_LONG',
        `Path length (${resolved.length}) exceeds the 150 characters budget limit.`
      )
    }

    // 步骤 10: 根目录/系统目录/嵌套同源校验
    const parsed = path.parse(resolved)
    // 盘符根目录 (如 C:\, D:\)
    if (parsed.root.toLowerCase() === resolved.toLowerCase() || /^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
      throw new ModularResourceError(
        'SYSTEM_DIR_FORBIDDEN',
        'Drive root cannot be used as the plugin directory.'
      )
    }

    // 系统保护目录检验
    const protectedPaths = getSystemProtectedPaths()
    for (const p of protectedPaths) {
      if (isPathEqual(p, resolved) || isSubPath(p, resolved)) {
        throw new ModularResourceError(
          'SYSTEM_DIR_FORBIDDEN',
          `Target path is located in a protected system directory: ${p}`
        )
      }
    }

    // 特殊目录名称检验（回收站、卷信息等）
    const lowerResolved = resolved.toLowerCase()
    if (
      lowerResolved.includes('$recycle.bin') ||
      lowerResolved.includes('system volume information') ||
      lowerResolved.includes('recovery')
    ) {
      throw new ModularResourceError(
        'SYSTEM_DIR_FORBIDDEN',
        'System volume or recovery directories cannot be used.'
      )
    }

    // 与当前生效根目录比对
    if (currentRootDir) {
      const resolvedCurrent = path.resolve(currentRootDir)
      if (isPathEqual(resolvedCurrent, resolved)) {
        throw new ModularResourceError(
          'SAME_AS_CURRENT',
          'Target path is identical to the current plugin directory.'
        )
      }
      if (isSubPath(resolvedCurrent, resolved) || isSubPath(resolved, resolvedCurrent)) {
        throw new ModularResourceError(
          'NESTED_PATH_FORBIDDEN',
          'Target directory cannot be nested inside or be an ancestor of the current plugin directory.'
        )
      }
    }

    // 步骤 11: 零副作用可写性安全试探 & 动态空间预检
    let freeBytes = 0
    if (!options?.skipProbe) {
      const probeResult = await probeDirectoryWritableAndSpace(resolved, totalSourceBytes)
      freeBytes = probeResult.freeBytes
    } else {
      const stats = getDiskFreeSpace(resolved)
      freeBytes = stats.freeBytes
    }

    // 冲突模块检测
    let hasConflictModules = false
    let conflictModuleIds: string[] = []
    const targetSharedDir = path.join(resolved, '_shared')
    if (fs.existsSync(targetSharedDir) && currentInstalledModuleIds.length > 0) {
      try {
        const entries = fs.readdirSync(targetSharedDir, { withFileTypes: true })
        const existingDirs = new Set(entries.filter(e => e.isDirectory()).map(e => e.name))
        conflictModuleIds = currentInstalledModuleIds.filter(id => existingDirs.has(id))
        hasConflictModules = conflictModuleIds.length > 0
      } catch {
        // 忽略读取异常
      }
    }

    // 预估迁移耗时（按平均 80MB/s 写入估算）
    const estimatedDurationSeconds = Math.max(1, Math.ceil(totalSourceBytes / (80 * 1024 * 1024)))

    return {
      valid: true,
      diagnostics: {
        targetDiskFreeBytes: freeBytes,
        currentDirUsedBytes: totalSourceBytes,
        estimatedDurationSeconds,
        hasConflictModules,
        conflictModuleIds: hasConflictModules ? conflictModuleIds : undefined
      }
    }
  } catch (err: any) {
    if (err instanceof ModularResourceError) {
      return {
        valid: false,
        errorCode: err.code,
        errorMessage: err.message
      }
    }
    return {
      valid: false,
      errorCode: 'PATH_NOT_WRITABLE',
      errorMessage: err?.message || 'Unknown validation error'
    }
  }
}
