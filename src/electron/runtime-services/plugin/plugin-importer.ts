/**
 * 本地开发插件导入器与四步防穿透沙箱管线 (PluginImporter)
 *
 * 遵循规格：plugin-lifecycle-developer-mode-and-archive-parser-spec.md §3.3、§3.4 与 §2.5
 * 1. 原生文件选择：主进程 dialog 弹出，渲染进程不感知绝对路径；
 * 2. Step 1 (命名正则与非法字符)：白名单正则 ^[a-z0-9][a-z0-9._-]{0,63}$，严禁 Windows 保留名、NTFS 冒号与尾随点/空；
 * 3. Step 2 (软链接防穿透)：fs.lstat 深度遍历严格拦截软链接与 Junction；
 * 4. Step 3 (临时沙箱原子校验)：拷贝至 .tmp-<uuid>，基于 @firefly/shared 的 isSubPath 原生防越界；
 * 5. Step 4 (同名官方冲突阻断与文件锁避让)：官方插件严禁覆盖 (OFFICIAL_ID_CONFLICT)，旧版本先移动至 .trash 规避 EBUSY；
 * 6. 开发者模式持久化：导入即落库为 availability='draft' 与 install_state='installed_inactive'。
 */

import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { dialog, app, type BrowserWindow } from 'electron'
import { isSubPath, logger, LogCategory } from '@firefly/shared'
import {
  getModularResourceDao,
  type BuiltinModuleRecord
} from '../database/dao/modular-resource-dao'

export const SIDECAR_PERMISSIONS_WHITELIST = ['vfs:read-user-selected', 'omni:emit-tags'] as const

export type SidecarPermission = (typeof SIDECAR_PERMISSIONS_WHITELIST)[number]

const WINDOWS_RESERVED_NAMES = new Set([
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

const ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface PluginManifest {
  id: string
  name: string
  version: string
  category?: string
  description?: string
  entry?: string
  permissions?: string[]
  author?: string
  icon?: string
}

export interface ImportPluginOptions {
  targetBaseDir?: string
  dao?: ReturnType<typeof getModularResourceDao>
  isPackaged?: boolean
  devModeEffective?: boolean
}

export class PluginImporter {
  private readonly targetBaseDir: string
  private readonly dao: ReturnType<typeof getModularResourceDao>
  private readonly isPackaged: boolean
  private readonly devModeEffective: boolean

  constructor(options?: ImportPluginOptions) {
    this.targetBaseDir =
      options?.targetBaseDir ??
      (typeof app !== 'undefined'
        ? path.join(app.getPath('userData'), 'modules')
        : path.join(process.cwd(), 'modules'))
    this.dao = options?.dao ?? getModularResourceDao()
    this.isPackaged =
      options?.isPackaged ?? (typeof app !== 'undefined' && app.isPackaged ? app.isPackaged : false)
    this.devModeEffective = options?.devModeEffective ?? !this.isPackaged
  }

  /**
   * 校验 manifest.json 格式与安全约束
   */
  public validateManifest(raw: any): PluginManifest {
    if (!raw || typeof raw !== 'object') {
      throw new Error('无效的 manifest.json：内容必须为 JSON 对象')
    }

    const id = String(raw.id || '').trim()
    if (!id) {
      throw new Error('插件 ID 不能为空')
    }

    if (id.includes(':')) {
      throw new Error(`插件 ID "${id}" 包含非法字符：严禁包含冒号或 NTFS ADS 流标记`)
    }

    if (!ID_REGEX.test(id)) {
      throw new Error(
        `插件 ID "${id}" 命名不符合规范：必须为 1~64 位小写字母、数字、点、下划线或连字符，且以字母或数字开头`
      )
    }

    if (id.endsWith('.') || id.endsWith(' ')) {
      throw new Error(`插件 ID "${id}" 不合法：严禁以点或空格结尾`)
    }

    // 提取纯文件名根判断 Windows 保留名（例如 con.app 的根为 con）
    const baseName = id.split('.')[0].toLowerCase()
    if (WINDOWS_RESERVED_NAMES.has(baseName) || WINDOWS_RESERVED_NAMES.has(id.toLowerCase())) {
      throw new Error(
        `插件 ID "${id}" 包含 Windows 保留设备名 (如 CON, AUX, NUL, COM1-9)，已被系统阻断`
      )
    }

    const name = String(raw.name || id).trim()
    const version = String(raw.version || '0.1.0').trim()

    // 校验权限声明白名单
    const declaredPermissions: string[] = Array.isArray(raw.permissions) ? raw.permissions : []
    const allowedSet = new Set<string>(SIDECAR_PERMISSIONS_WHITELIST)
    for (const p of declaredPermissions) {
      if (!allowedSet.has(p)) {
        throw new Error(
          `插件声明了未授权的权限 "${p}"：第三方开发插件仅限开放 ${SIDECAR_PERMISSIONS_WHITELIST.join(', ')}`
        )
      }
    }

    return {
      id,
      name,
      version,
      category: raw.category || 'tool',
      description: raw.description || '',
      entry: raw.entry || 'dist/index.js',
      permissions: declaredPermissions,
      author: raw.author || 'Local Developer',
      icon: raw.icon
    }
  }

  /**
   * 深度扫描源目录，严防软链接与 Junction 挂载点越界逃逸
   */
  public async scanNoSymlinks(dirPath: string): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const stat = await fs.promises.lstat(fullPath)
      if (stat.isSymbolicLink()) {
        throw new Error(
          `SYMLINK_NOT_ALLOWED: 检测到非法软链接或快捷方式 "${entry.name}"，禁止通过软链接越界逃逸`
        )
      }
      if (entry.isDirectory()) {
        await this.scanNoSymlinks(fullPath)
      }
    }
  }

  /**
   * 递归拷贝目录（保持安全边界）
   */
  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true })
    const entries = await fs.promises.readdir(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      const stat = await fs.promises.lstat(srcPath)

      if (stat.isSymbolicLink()) {
        throw new Error(`SYMLINK_NOT_ALLOWED: 严禁拷贝软链接 "${entry.name}"`)
      }

      if (stat.isDirectory()) {
        await this.copyDirRecursive(srcPath, destPath)
      } else {
        await fs.promises.copyFile(srcPath, destPath)
      }
    }
  }

  /**
   * 从指定源目录导入本地插件
   */
  public async importFromDirectory(sourceDir: string): Promise<BuiltinModuleRecord> {
    // 步骤 0：生产打包态防残留熔断
    if (this.isPackaged && !this.devModeEffective) {
      throw new Error('DEV_MODE_LOCKED: 生产环境下开发者模式已关闭，禁止导入未签名本地插件')
    }

    // 步骤 1：读取并校验 manifest.json
    const manifestPath = path.join(sourceDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`未找到 manifest.json 文件: ${manifestPath}`)
    }

    let manifestRaw: any
    try {
      const content = await fs.promises.readFile(manifestPath, 'utf-8')
      manifestRaw = JSON.parse(content)
    } catch (parseErr: any) {
      throw new Error(`manifest.json 格式解析错误: ${parseErr?.message}`)
    }

    const manifest = this.validateManifest(manifestRaw)

    // 步骤 2：防符号链接穿透
    await this.scanNoSymlinks(sourceDir)

    // 步骤 3：官方同名冲突强阻断
    const existing = this.dao.modules.findByIdSync(manifest.id)
    if (existing && existing.author_code === 'official') {
      throw new Error(
        `OFFICIAL_ID_CONFLICT: 插件 ID "${manifest.id}" 为官方内置受保护插件，严禁被第三方本地插件覆盖替换`
      )
    }

    const unpackedRoot = path.join(this.targetBaseDir, 'unpacked')
    await fs.promises.mkdir(unpackedRoot, { recursive: true })

    const finalTargetDir = path.join(unpackedRoot, manifest.id)
    // 路径边界安全核验 (parent, child)
    if (!isSubPath(unpackedRoot, finalTargetDir)) {
      throw new Error(`PATH_TRAVERSAL_DETECTED: 目标路径脱离解压沙箱边界`)
    }

    // 若旧本地插件目录已存在，采用移动至 .trash 避让 Windows 文件锁
    if (fs.existsSync(finalTargetDir)) {
      const trashDir = path.join(this.targetBaseDir, '.trash', `${manifest.id}-${randomUUID()}`)
      await fs.promises.mkdir(path.dirname(trashDir), { recursive: true })
      try {
        await fs.promises.rename(finalTargetDir, trashDir)
        // 异步静默清理 trash
        fs.promises.rm(trashDir, { recursive: true, force: true }).catch(() => {})
      } catch (renameErr) {
        logger.warn(
          LogCategory.SYSTEM,
          `[PluginImporter] 移动旧目录至 .trash 失败，尝试直接删除:`,
          renameErr
        )
        await fs.promises.rm(finalTargetDir, { recursive: true, force: true })
      }
    }

    // 步骤 4：临时隔离沙箱拷贝
    const tempDir = path.join(unpackedRoot, `.tmp-${randomUUID()}`)
    try {
      await this.copyDirRecursive(sourceDir, tempDir)
      // 原子 rename 到最终沙箱目录
      await fs.promises.rename(tempDir, finalTargetDir)
    } catch (copyErr) {
      // 出错清理临时目录
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw copyErr
    }

    // 步骤 5：数据持久化登记入库
    this.dao.modules.upsertModuleSync({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      catalog_version: 1,
      category: (manifest.category as any) || 'tool',
      author_code: 'third_party',
      author_name: manifest.author || 'Local Developer',
      availability: 'draft',
      delist_reason: null,
      total_bytes: 0,
      install_state: 'installed_inactive',
      install_path: finalTargetDir,
      catalog_meta_json: JSON.stringify(manifest)
    })

    const record = this.dao.modules.findByIdSync(manifest.id)!
    logger.info(
      LogCategory.SYSTEM,
      `[PluginImporter] 成功导入本地插件: ${manifest.id} -> ${finalTargetDir}`
    )
    return record
  }

  /**
   * 主进程弹出原生文件选择对话框并完成导入管线
   */
  public async pickAndImportLocalPlugin(
    parentWindow?: BrowserWindow
  ): Promise<{ canceled: boolean; module?: BuiltinModuleRecord; error?: string }> {
    try {
      const res = await dialog.showOpenDialog(parentWindow as any, {
        title: '选择本地未打包插件开发目录',
        properties: ['openDirectory', 'dontAddToRecent']
      })

      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true }
      }

      const selectedDir = res.filePaths[0]
      const record = await this.importFromDirectory(selectedDir)
      return { canceled: false, module: record }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[PluginImporter] 导入本地插件失败:', err)
      return { canceled: false, error: err?.message || '导入本地插件失败' }
    }
  }
}
