import * as path from 'node:path'
import * as fs from 'node:fs'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'
import { ResourceLocator } from '@firefly/shared'

const execFileAsync = promisify(cp.execFile)

export class ExifToolWorkerService {
  private static instance: ExifToolWorkerService

  private constructor() {}

  public static getInstance(): ExifToolWorkerService {
    if (!ExifToolWorkerService.instance) {
      ExifToolWorkerService.instance = new ExifToolWorkerService()
    }
    return ExifToolWorkerService.instance
  }

  /**
   * 定位 ExifTool 可执行文件
   */
  public findExifToolExecutable(): string | null {
    try {
      const bin =
        ResourceLocator.resolveBin('exiftool/exiftool') || ResourceLocator.resolveBin('exiftool')
      if (bin && fs.existsSync(bin)) return bin
    } catch {}

    const exeName = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool'
    const root = process.cwd()
    const candidates = [
      path.join(root, 'apps', 'omni', 'build', 'extraResources', 'bin', 'exiftool', exeName),
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'exiftool', exeName),
      path.join(root, 'build', 'extraResources', 'bin', 'exiftool', exeName)
    ]

    for (const cand of candidates) {
      if (cand && fs.existsSync(cand)) return cand
    }

    return null
  }

  /**
   * 提取文件全量 EXIF/元数据属性
   * @param filePath 物理文件路径
   */
  public async extractMetadata(filePath: string): Promise<Record<string, any>> {
    const tStart = Date.now()
    try {
      const binPath = this.findExifToolExecutable()
      let tags: Record<string, any> = {}

      if (binPath) {
        const { env, cwd } = ResourceLocator.getBinExecutionEnv(binPath)
        const { stdout } = await execFileAsync(binPath, ['-json', filePath], {
          timeout: 5000,
          maxBuffer: 10 * 1024 * 1024,
          env,
          cwd
        })
        const parsed = JSON.parse(stdout)
        if (Array.isArray(parsed) && parsed.length > 0) {
          tags = parsed[0]
        }
      } else {
        // 全局 PATH 兜底
        const sysExe = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool'
        const { stdout } = await execFileAsync(sysExe, ['-json', filePath], {
          timeout: 5000,
          maxBuffer: 10 * 1024 * 1024
        })
        const parsed = JSON.parse(stdout)
        if (Array.isArray(parsed) && parsed.length > 0) {
          tags = parsed[0]
        }
      }

      const cleanMetadata: Record<string, any> = {}
      const totalKeys = Object.keys(tags || {}).length

      // 过滤辅助属性
      for (const [key, value] of Object.entries(tags)) {
        if (
          key === 'errors' ||
          key.startsWith('SourceFile') ||
          key.startsWith('Directory') ||
          key.startsWith('FileName')
        ) {
          continue
        }
        cleanMetadata[key] = value
      }

      const validKeys = Object.keys(cleanMetadata).length
      const durationMs = Date.now() - tStart

      if (validKeys > 0) {
        // 抓取关键核心指标预览
        const previewKeys = [
          'FileType',
          'ImageWidth',
          'ImageHeight',
          'CreateDate',
          'Author',
          'Creator',
          'Title'
        ]
          .filter(k => cleanMetadata[k] !== undefined)
          .map(k => `${k}=${cleanMetadata[k]}`)
          .join(', ')

        console.debug(
          `[ExifToolWorkerService][debug] ✅ 元数据提取完成 (耗时=${durationMs}ms): file="${path.basename(filePath)}", 原始Key=${totalKeys}, 有效Key=${validKeys}${previewKeys ? `, 核心指标: [${previewKeys}]` : ''}`
        )
      } else {
        console.debug(
          `[ExifToolWorkerService][debug] ⚠️ 未从文件提取到有效 Exif 元数据 (耗时=${durationMs}ms, rawKeys=${totalKeys}, file="${path.basename(filePath)}")`
        )
      }

      return cleanMetadata
    } catch (err: any) {
      console.warn(`[ExifToolWorkerService] 提取文件元数据失败: ${filePath}`, err?.message || err)
      return {}
    }
  }

  /**
   * 关闭进程池
   */
  public async shutdown(): Promise<void> {}
}

export const exiftoolWorkerService = ExifToolWorkerService.getInstance()
