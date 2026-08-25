import { omniService } from '../omni-service'

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
   * 提取文件全量 EXIF/元数据属性 (由 Omni 原生微服务提供)
   * @param filePath 物理文件路径
   */
  public async extractMetadata(filePath: string): Promise<Record<string, any>> {
    try {
      const omniData = await omniService.extract(filePath)
      if (omniData && omniData.metadata && Object.keys(omniData.metadata).length > 0) {
        return omniData.metadata
      }
      return {}
    } catch (err: any) {
      console.warn(`[ExifToolWorkerService] 提取文件元数据失败: ${filePath}`, err?.message || err)
      return {}
    }
  }

  /**
   * 关闭服务
   */
  public async shutdown(): Promise<void> {}
}

export const exiftoolWorkerService = ExifToolWorkerService.getInstance()
