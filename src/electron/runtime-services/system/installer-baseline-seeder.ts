/**
 * 差分基线播种器 (Installer Baseline Seeder) — 工单 06 · P0-2 · A1 裁决(B 路径)
 *
 * 为什么需要它：
 *   electron-updater 的 Blockmap 差分引擎在下载新版本时，需要读取"上一次安装的完整安装包"
 *   作为推导起点。该基线路径在 electron-updater 内部是硬编码的：
 *
 *     oldFile = path.join(downloadedUpdateHelper.cacheDir, "installer.exe")
 *     cacheDir = path.join(getAppCacheDir() /* Windows = %LOCALAPPDATA% *\/, updaterCacheDirName)
 *
 *   （见 electron-updater 6.3.9：NsisUpdater.js:49 传 CURRENT_APP_INSTALLER_FILE_NAME="installer.exe"，
 *     AppUpdater.js:580/604 组 oldFile，AppUpdater.js:502 组 cacheDir，AppAdapter.getAppCacheDir 取 LOCALAPPDATA）
 *
 *   首发安装或清理后该基线不存在 → 差分必然退化全量（~750MB）。
 *
 * 播种来源（A1 裁决 · B 路径，用户选定）：
 *   1. ProgramData 共享只读副本：$COMMONAPPDATA\firefly-ai-folder\installer\installer-<version>.exe
 *      （由 installer.nsh 的 customInstall 写入；ProgramData 父目录默认继承 Users 读 ACL，无需 AccessControl 插件）
 *   2. 安装目录版本化副本：$INSTDIR\installer\installer-<version>.exe（回退来源）
 *
 * 播种目标：
 *   %LOCALAPPDATA%\<updaterCacheDirName>\installer.exe   ← 差分引擎固定读取此路径
 *
 * 关键约束（严禁违反）：
 *   - 播种文件名必须精确为 "installer.exe"（差分引擎硬编码常量，非 installer-<version>.exe）
 *   - 播种到 cacheDir 根，绝不放入 pending 子目录（pending 是"已下载的新版包"，sha512 语义相反）
 *   - 严禁静默降级：任何失败必须 logger.warn/error 显式上报（遵守 AGENTS.md 系统不变量）
 */
import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { logger, LogCategory } from '@firefly/shared'

/** 差分引擎硬编码的基线文件名（electron-updater builder-util-runtime CURRENT_APP_INSTALLER_FILE_NAME） */
const DIFF_BASELINE_FILE_NAME = 'installer.exe'

/** 安装器写副本的共享只读目录（相对 $COMMONAPPDATA） */
const PROGRAM_DATA_APP_DIR = 'firefly-ai-folder'
const INSTALLER_SUBDIR = 'installer'

/**
 * 解析 electron-updater 的 updaterCacheDirName（单一事实源：app-update.yml 的 updaterCacheDirName）。
 * 生成侧：generate-channel-manifest.js / forge.config.ts 均为 `${APP_NAME}-updater`，
 * 其中 APP_NAME = `firefly-ai-folder_${MAJOR_VERSION}_${BUILD_REGION}`（如 firefly-ai-folder_v4_cn）。
 *
 * 运行时无法直接读 app-update.yml 的该字段（electron-updater 未暴露 getter），故按同一规则在客户端重建，
 * 并在模块注释中锁定与生成侧的一致性契约。严禁在此私造第二套命名。
 */
export function resolveUpdaterCacheDirName(
  region: 'cn' | 'intl' = process.env.BUILD_REGION?.trim().toLowerCase() === 'intl' ? 'intl' : 'cn'
): string {
  // 与 generate-channel-manifest.js:209 保持同源：firefly-ai-folder_v4_<channel>
  const majorVersion = 'v4' // 与 forge.config.ts MAJOR_VERSION 首数字一致
  const appName = `firefly-ai-folder_${majorVersion}_${region}`
  return `${appName}-updater`
}

/**
 * 计算 electron-updater 真实差分缓存根目录（Windows = %LOCALAPPDATA%\<updaterCacheDirName>）。
 * 这是差分引擎读取 installer.exe 基线的目录，也是播种的目标父目录。
 */
export function computeUpdaterCacheDir(
  localAppDataDir: string,
  region: 'cn' | 'intl' = 'cn'
): string {
  return path.join(localAppDataDir, resolveUpdaterCacheDirName(region))
}

/** 计算 ProgramData 共享只读副本目录 */
export function computeProgramDataInstallerDir(programDataDir: string): string {
  return path.join(programDataDir, PROGRAM_DATA_APP_DIR, INSTALLER_SUBDIR)
}

/** 流式计算 sha512（base64，与 electron-updater 一致），杜绝大文件内存溢出 */
async function streamSha512Base64(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
    stream.on('error', reject)
  })
}

export interface SeedBaselineOptions {
  /** 当前已安装版本号（用于定位 installer-<version>.exe 副本） */
  currentVersion: string
  /** %LOCALAPPDATA% 绝对路径 */
  localAppDataDir: string
  /** %COMMONAPPDATA% 绝对路径（ProgramData） */
  programDataDir: string
  /** 安装目录（$INSTDIR，回退来源） */
  installDir: string
  /** 区域，决定 cacheDir 目录名 */
  region?: 'cn' | 'intl'
  /** 期望的基线 sha512(base64)，可选；提供时播种后校验，不匹配则拒绝播种 */
  expectedSha512?: string
}

export interface SeedBaselineResult {
  seeded: boolean
  targetPath: string
  sourcePath: string | null
  reason: string
}

/**
 * 播种差分基线：从共享只读副本或安装目录副本，将当前已安装版本的安装包
 * 复制为 <cacheDir>\installer.exe（差分引擎固定读取路径）。
 *
 * 失败语义（B 路径）：任何一步失败 → logger.warn 显式上报 + 返回 { seeded:false }，
 * 调用方继续正常流程（差分退化为全量下载），绝不静默吞异常、绝不上抛阻断启动。
 */
export async function seedBaselineInstaller(
  opts: SeedBaselineOptions
): Promise<SeedBaselineResult> {
  const { currentVersion, localAppDataDir, programDataDir, installDir } = opts
  const region = opts.region ?? 'cn'
  const cacheDir = computeUpdaterCacheDir(localAppDataDir, region)
  const targetPath = path.join(cacheDir, DIFF_BASELINE_FILE_NAME)

  // 候选来源（优先 ProgramData 共享副本，回退安装目录副本）
  const candidates: string[] = [
    path.join(computeProgramDataInstallerDir(programDataDir), `installer-${currentVersion}.exe`),
    path.join(installDir, INSTALLER_SUBDIR, `installer-${currentVersion}.exe`)
  ]

  try {
    const sourcePath = candidates.find(p => fs.existsSync(p))
    if (!sourcePath) {
      logger.warn(
        LogCategory.SYSTEM,
        `[BaselineSeeder] 未找到差分基线来源副本 (version=${currentVersion})，差分将退化全量。已探测: ${candidates.join(', ')}`
      )
      return { seeded: false, targetPath, sourcePath: null, reason: 'no-source-candidate' }
    }

    // 可选：来源 sha512 校验（调用方从频道元数据取得期望值时启用）
    if (opts.expectedSha512) {
      const actual = await streamSha512Base64(sourcePath)
      if (actual !== opts.expectedSha512) {
        logger.warn(
          LogCategory.SYSTEM,
          `[BaselineSeeder] 来源副本 sha512 与期望不符，拒绝播种 (source=${sourcePath})`
        )
        return { seeded: false, targetPath, sourcePath, reason: 'sha512-mismatch' }
      }
    }

    fs.mkdirSync(cacheDir, { recursive: true })
    // 若目标已存在同名同尺寸文件，跳过复制（幂等）
    if (fs.existsSync(targetPath)) {
      const srcStat = fs.statSync(sourcePath)
      const dstStat = fs.statSync(targetPath)
      if (srcStat.size === dstStat.size) {
        logger.debug(
          LogCategory.SYSTEM,
          `[BaselineSeeder] 差分基线已存在且尺寸一致，跳过播种: ${targetPath}`
        )
        return { seeded: true, targetPath, sourcePath, reason: 'already-seeded' }
      }
    }

    await fs.promises.copyFile(sourcePath, targetPath)
    logger.info(
      LogCategory.SYSTEM,
      `[BaselineSeeder] 差分基线播种成功: ${sourcePath} -> ${targetPath}`
    )
    return { seeded: true, targetPath, sourcePath, reason: 'seeded' }
  } catch (err: any) {
    // 严禁静默降级：显式上报播种失败原因
    logger.warn(
      LogCategory.SYSTEM,
      `[BaselineSeeder] 差分基线播种失败 (version=${currentVersion}): ${err?.message || err}`
    )
    return {
      seeded: false,
      targetPath,
      sourcePath: null,
      reason: `error:${err?.code || err?.message || 'unknown'}`
    }
  }
}
