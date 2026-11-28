import path from 'node:path'
import cp from 'node:child_process'
import { promisify } from 'node:util'
import { loggingService as logger } from './logging-service'
import { LogCategory, ResourceLocator } from '@firefly/shared'
import { existsAsync, readdirTyped, statOrNull } from '../../infra/fs'

const execFile = promisify(cp.execFile)

export interface PopplerDetectorInfo {
  installed: boolean
  path: string | null
}

interface PopplerProbeCacheEntry {
  info: PopplerDetectorInfo
  fingerprint: string | null
}

export class PopplerDetector {
  private cachedEntry: PopplerProbeCacheEntry | null = null

  /**
   * 显式失效探针缓存（外部二进制安装、替换或删除后调用）
   */
  public invalidateCache(): void {
    this.cachedEntry = null
  }

  private async computeBinaryFingerprint(binPath: string): Promise<string | null> {
    const st = await statOrNull(binPath)
    return st ? `${st.mtimeMs}:${st.size}` : null
  }

  /**
   * 检测系统中或预置 extraResources/bin 中的 pdftoppm 可执行二进制路径
   * 进程生命周期内缓存探测结果，重复探测不再落盘；可通过 `forceRefresh` 或 `invalidateCache()` 重探。
   */
  public async detectPoppler(options?: { forceRefresh?: boolean }): Promise<PopplerDetectorInfo> {
    if (!options?.forceRefresh && this.cachedEntry) {
      return this.cachedEntry.info
    }

    // 1. 优先使用 ResourceLocator 在预置 resources/bin 中定位 pdftoppm
    const presetBin =
      ResourceLocator.resolveBin('poppler/pdftoppm') || ResourceLocator.resolveBin('pdftoppm')
    if (presetBin && (await existsAsync(presetBin))) {
      const fingerprint = await this.computeBinaryFingerprint(presetBin)
      const info: PopplerDetectorInfo = { installed: true, path: presetBin }
      this.cachedEntry = { info, fingerprint }
      logger.info(
        LogCategory.SYSTEM,
        `[PopplerDetector] 🎯 成功通过 ResourceLocator 定位 pdftoppm: ${presetBin}`
      )
      return info
    }

    // 2. 尝试从系统全局 PATH 中探测
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execFile(cmd, ['pdftoppm'], { windowsHide: true })
      const sysPath = stdout.trim().split(/\r?\n/)[0]
      if (sysPath && (await existsAsync(sysPath))) {
        const fingerprint = await this.computeBinaryFingerprint(sysPath)
        const info: PopplerDetectorInfo = { installed: true, path: sysPath }
        this.cachedEntry = { info, fingerprint }
        logger.info(
          LogCategory.SYSTEM,
          `[PopplerDetector] 🎯 识别到系统全局 pdftoppm 路径: ${sysPath}`
        )
        return info
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[PopplerDetector] 系统全局 PATH 探测 pdftoppm 失败: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const notFound: PopplerDetectorInfo = { installed: false, path: null }
    this.cachedEntry = { info: notFound, fingerprint: null }
    return notFound
  }

  /**
   * 异步递归检索指定目录下的二进制可执行文件路径
   */
  public async findExecutableRecursively(dir: string, exeName: string): Promise<string | null> {
    try {
      const items = await readdirTyped(dir)
      for (const item of items) {
        const fullPath = path.join(dir, item.name)
        const stat = await statOrNull(fullPath)
        if (!stat) continue
        if (stat.isDirectory()) {
          const subFound = await this.findExecutableRecursively(fullPath, exeName)
          if (subFound) return subFound
        } else if (item.name.toLowerCase() === exeName.toLowerCase()) {
          return fullPath
        }
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[PopplerDetector] 递归检索可执行文件失败 (${dir}): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return null
  }
}

export const popplerDetector = new PopplerDetector()
