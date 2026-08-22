import path from 'node:path'
import { existsSync } from 'node:fs'
import cp from 'node:child_process'
import { promisify } from 'node:util'
import { loggingService as logger } from './logging-service'
import { LogCategory, ResourceLocator } from '@firefly/shared'

const execFile = promisify(cp.execFile)

export interface PopplerDetectorInfo {
  installed: boolean
  path: string | null
}

export class PopplerDetector {
  private cachedInfo: PopplerDetectorInfo | null = null

  /**
   * 检测系统中或预置 extraResources/bin 中的 pdftoppm 可执行二进制路径
   */
  public async detectPoppler(): Promise<PopplerDetectorInfo> {
    if (
      this.cachedInfo &&
      this.cachedInfo.installed &&
      this.cachedInfo.path &&
      existsSync(this.cachedInfo.path)
    ) {
      return this.cachedInfo
    }

    // 1. 优先使用 ResourceLocator 在预置 resources/bin 中定位 pdftoppm
    const presetBin =
      ResourceLocator.resolveBin('poppler/pdftoppm') || ResourceLocator.resolveBin('pdftoppm')
    if (presetBin && existsSync(presetBin)) {
      this.cachedInfo = { installed: true, path: presetBin }
      logger.info(
        LogCategory.SYSTEM,
        `[PopplerDetector] 🎯 成功通过 ResourceLocator 定位 pdftoppm: ${presetBin}`
      )
      return this.cachedInfo
    }

    // 2. 尝试从系统全局 PATH 中探测
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execFile(cmd, ['pdftoppm'])
      const sysPath = stdout.trim().split(/\r?\n/)[0]
      if (sysPath && existsSync(sysPath)) {
        this.cachedInfo = { installed: true, path: sysPath }
        logger.info(
          LogCategory.SYSTEM,
          `[PopplerDetector] 🎯 识别到系统全局 pdftoppm 路径: ${sysPath}`
        )
        return this.cachedInfo
      }
    } catch {
      // 全局未探测到
    }

    this.cachedInfo = { installed: false, path: null }
    return this.cachedInfo
  }

  /**
   * 递归检索指定目录下的二进制可执行文件路径
   */
  private findExecutableRecursively(dir: string, exeName: string): string | null {
    try {
      const items = require('node:fs').readdirSync(dir)
      for (const item of items) {
        const fullPath = path.join(dir, item)
        const stat = require('node:fs').statSync(fullPath)
        if (stat.isDirectory()) {
          const subFound = this.findExecutableRecursively(fullPath, exeName)
          if (subFound) return subFound
        } else if (item.toLowerCase() === exeName.toLowerCase()) {
          return fullPath
        }
      }
    } catch {
      // ignore
    }
    return null
  }
}

export const popplerDetector = new PopplerDetector()
