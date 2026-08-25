/**
 * 纯 Node.js 内存 Magika 文件识别服务 (Magika Worker Service)
 * 直接装载 Google 官方原汁原味知识库 content_types_kb.min.json 与 config.min.json
 */

import { omniService } from '../omni-service'
import { MagikaIdentifyResult } from './types'

export class MagikaWorkerService {
  private static instance: MagikaWorkerService

  private constructor() {}

  public static getInstance(): MagikaWorkerService {
    if (!MagikaWorkerService.instance) {
      MagikaWorkerService.instance = new MagikaWorkerService()
    }
    return MagikaWorkerService.instance
  }

  public async ensureLoaded(): Promise<void> {}

  /**
   * 极速文件类型识别 (由 Omni 原生微服务提供)
   * @param filePath 文件路径
   */
  public async identifyFile(filePath: string): Promise<MagikaIdentifyResult> {
    const res = await omniService.identifyMagika(filePath)
    if (res) {
      return {
        label: res.label,
        group: res.group,
        description: res.description,
        extensions: res.extensions,
        is_text: res.is_text,
        mime_type: res.mime_type,
        score: res.score
      }
    }

    return {
      label: 'bin',
      group: 'unknown',
      description: '',
      extensions: [],
      is_text: false,
      mime_type: 'application/octet-stream',
      score: 0
    }
  }
}

export const magikaWorkerService = MagikaWorkerService.getInstance()
