import * as path from 'node:path'

export class ExifToolWorkerService {
  private static instance: ExifToolWorkerService
  private isLoaded = false

  private constructor() {}

  public static getInstance(): ExifToolWorkerService {
    if (!ExifToolWorkerService.instance) {
      ExifToolWorkerService.instance = new ExifToolWorkerService()
    }
    return ExifToolWorkerService.instance
  }

  /**
   * 提取文件全量 EXIF/元数据属性
   * @param filePath 物理文件路径
   */
  public async extractMetadata(filePath: string): Promise<Record<string, any>> {
    const tStart = Date.now()
    try {
      const moduleName = 'exiftool-vendored'
      const { exiftool } = (await import(/* @vite-ignore */ moduleName as any)) as any
      const tags: Record<string, any> = await exiftool.read(filePath)
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
   * 关闭守护进程池
   */
  public async shutdown(): Promise<void> {
    try {
      const moduleName = 'exiftool-vendored'
      const { exiftool } = (await import(moduleName as any)) as any
      await exiftool.end()
    } catch (err) {
      console.error('[ExifToolWorkerService] 关闭 ExifTool 进程池异常:', err)
    }
  }
}

export const exiftoolWorkerService = ExifToolWorkerService.getInstance()
