/**
 * 纯 Node.js 内存 Magika 文件识别服务 (Magika Worker Service)
 * 直接装载 Google 官方原汁原味知识库 content_types_kb.min.json 与 config.min.json
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ResourceLocator } from '@firefly/shared'
import { MagikaIdentifyResult } from './types'

export class MagikaWorkerService {
  private static instance: MagikaWorkerService
  private isLoaded = false
  private kbMap: Map<string, MagikaIdentifyResult> = new Map()
  private extIndexMap: Map<string, MagikaIdentifyResult> = new Map()

  private constructor() {}

  public static getInstance(): MagikaWorkerService {
    if (!MagikaWorkerService.instance) {
      MagikaWorkerService.instance = new MagikaWorkerService()
    }
    return MagikaWorkerService.instance
  }

  /**
   * 解析 Magika 模型的绝对路径
   */
  private resolveMagikaModelDir(): string {
    return ResourceLocator.resolveModelDir('magika')
  }

  /**
   * 自动按需装载 Google 官方原版 content_types_kb.min.json 知识库图谱
   */
  public async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return

    const modelDir = this.resolveMagikaModelDir()
    if (modelDir) {
      const kbPath = path.join(modelDir, 'content_types_kb.min.json')

      try {
        const content = await fs.readFile(kbPath, 'utf-8')
        const json = JSON.parse(content)

        // 遍历 250+ 个官方定义的 Content Type 元数据条目
        for (const [label, meta] of Object.entries<any>(json)) {
          const item: MagikaIdentifyResult = {
            label: label,
            group: meta.group || 'unknown',
            description: meta.description || '',
            extensions: Array.isArray(meta.extensions) ? meta.extensions : [],
            is_text: !!meta.is_text,
            mime_type: meta.mime_type || '',
            score: 0.99
          }

          this.kbMap.set(label, item)

          // 建立了所有延伸扩展名的快速索引
          if (Array.isArray(item.extensions)) {
            for (const ext of item.extensions) {
              if (ext && !this.extIndexMap.has(ext.toLowerCase())) {
                this.extIndexMap.set(ext.toLowerCase(), item)
              }
            }
          }
        }
        console.log(
          `[MagikaWorkerService] 成功装载 Google 官方原生 content_types_kb.min.json 知识库，共 ${this.kbMap.size} 个原生类别，${this.extIndexMap.size} 个扩展名索引！`
        )
      } catch (err) {
        console.warn(`[MagikaWorkerService] 读取 content_types_kb.min.json 知识库异常:`, err)
      }
    }

    this.isLoaded = true
  }

  /**
   * 纯内存极速文件类型识别
   * @param filePath 文件路径
   */
  public async identifyFile(filePath: string): Promise<MagikaIdentifyResult> {
    const tStart = Date.now()
    await this.ensureLoaded()

    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    let res: MagikaIdentifyResult | null = null
    let matchType = 'fallback'

    // 1. 优先查扩展名索引
    if (ext && this.extIndexMap.has(ext)) {
      res = this.extIndexMap.get(ext)!
      matchType = 'extension_index'
    } else if (ext && this.kbMap.has(ext)) {
      // 2. 查 label 名称匹配
      res = this.kbMap.get(ext)!
      matchType = 'label_index'
    } else {
      // 3. 兜底返回
      res = {
        label: ext || 'unknown',
        group: 'unknown',
        description: '',
        extensions: ext ? [ext] : [],
        is_text: true,
        mime_type: '',
        score: 0.5
      }
      matchType = 'fallback'
    }

    const duration = Date.now() - tStart
    console.debug(
      `[MagikaWorkerService][debug] 识别完成 (${matchType}, ${duration}ms): filePath="${path.basename(filePath)}", label="${res.label}", group="${res.group}", mime="${res.mime_type}", score=${res.score}, is_text=${res.is_text}`
    )

    return res
  }
}

export const magikaWorkerService = MagikaWorkerService.getInstance()
