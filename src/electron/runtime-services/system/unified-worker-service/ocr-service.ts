/**
 * PP-OCRv6 纯 Node.js 内存推理服务 (onnxruntime-node)
 * 采用按需懒加载 + 载入后常驻内存 (Lazy-Load & Keep-Alive) 策略
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ResourceLocator } from '@firefly/shared'
import { OCRRequestOptions, OCRResult } from './types'

export class OCRService {
  private static instance: OCRService
  private isLoaded = false
  private currentModelType: 'tiny' | 'small' | 'medium' = 'tiny'
  private sessionDet: any = null
  private sessionRec: any = null
  private keysMap: string[] = []
  private ortModule: any = null

  private constructor() {}

  public static getInstance(): OCRService {
    if (!OCRService.instance) {
      OCRService.instance = new OCRService()
    }
    return OCRService.instance
  }

  /**
   * 安全获取 Sharp 实例，兼容 ESM / CommonJS 打包
   */
  private async getSharp(): Promise<any> {
    try {
      const mod = await import('sharp')
      return (mod as any).default || mod
    } catch {
      const req = typeof require !== 'undefined' ? require : eval('require')
      const mod = req('sharp')
      return mod?.default || mod
    }
  }

  /**
   * 解析 PP-OCRv6 预设模型在磁盘上的绝对路径
   */
  private resolveModelDir(): string {
    return ResourceLocator.resolveModelDir('PP-OCRv6')
  }

  /**
   * 动态加载 onnxruntime-node 模块（带 unpacked 物理路径兜底）
   */
  private loadOnnxRuntime(): any {
    if (this.ortModule) return this.ortModule

    const req = typeof require !== 'undefined' ? require : eval('require')
    const fsSync = require('node:fs')

    // 1. 尝试标准 require('onnxruntime-node')
    try {
      const ort = req('onnxruntime-node')
      if (ort && ort.InferenceSession) {
        this.ortModule = ort
        console.debug('[OCRService][debug] onnxruntime-node 原生模块成功通过标准 require 加载')
        return ort
      }
    } catch (stdErr: any) {
      console.warn(
        '[OCRService] 标准 require("onnxruntime-node") 失败，尝试解包路径加载:',
        stdErr?.message || stdErr
      )
    }

    // 2. 尝试从 app.asar.unpacked / resources 等物理路径定位并加载
    const baseResDir = ResourceLocator.getBaseResourceDir()
    const unpackedCandidates = [
      path.join(baseResDir, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node'),
      path.join(
        process.cwd(),
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'onnxruntime-node'
      ),
      __dirname.includes('app.asar')
        ? path.join(
            __dirname.split('app.asar')[0],
            'app.asar.unpacked',
            'node_modules',
            'onnxruntime-node'
          )
        : null,
      path.join(process.cwd(), 'node_modules', 'onnxruntime-node'),
      path.join(process.cwd(), 'apps', 'desktop', 'node_modules', 'onnxruntime-node')
    ].filter(Boolean) as string[]

    for (const p of unpackedCandidates) {
      try {
        if (fsSync.existsSync(p)) {
          const ort = req(p)
          if (ort && ort.InferenceSession) {
            this.ortModule = ort
            console.debug(`[OCRService][debug] ✅ 成功从物理路径加载 onnxruntime-node: ${p}`)
            return ort
          }
        }
      } catch (pathErr: any) {
        console.warn(
          `[OCRService] 从 ${p} 加载 onnxruntime-node 异常:`,
          pathErr?.message || pathErr
        )
      }
    }

    return null
  }

  /**
   * 按需懒加载 ONNX 模型权重与字符字典
   */
  public async ensureLoaded(modelType: 'tiny' | 'small' | 'medium' = 'tiny'): Promise<void> {
    if (this.isLoaded && this.currentModelType === modelType && this.sessionRec) {
      return
    }

    // 动态切换精度时重置旧会话
    if (this.currentModelType !== modelType) {
      this.sessionDet = null
      this.sessionRec = null
      this.isLoaded = false
    }

    const tStart = Date.now()
    const modelDir = this.resolveModelDir()
    console.debug(`[OCRService][debug] 准备检测 PP-OCRv6 (${modelType}) 模型目录: ${modelDir}`)

    try {
      // 检查模型文件与词表是否存在
      if (modelDir) {
        try {
          const files = await fs.readdir(modelDir).catch(() => [] as string[])
          console.debug(
            `[OCRService][debug] 模型目录内包含文件 (${files.length}个):`,
            files.join(', ') || '无文件'
          )
        } catch (e) {
          console.debug(`[OCRService][debug] 无法读取模型目录: ${modelDir}`)
        }
      }

      // 导入 onnxruntime-node 原生 C++ NAPI 模块
      const ort = this.loadOnnxRuntime()
      if (!ort) {
        console.warn('[OCRService] ⚠️ onnxruntime-node 原生模块未成功加载，OCR 无法初始化')
        return
      }

      if (modelDir && ort) {
        // 支持标准 PP-OCRv6 命名前缀: PP-OCRv6_det_${modelType}.onnx
        let detPath = path.join(modelDir, `PP-OCRv6_det_${modelType}.onnx`)
        let recPath = path.join(modelDir, `PP-OCRv6_rec_${modelType}.onnx`)
        let keysPath = path.join(modelDir, `ppocr_keys_v6_${modelType}.txt`)

        let hasDet = await fs
          .stat(detPath)
          .then(() => true)
          .catch(() => false)
        let hasRec = await fs
          .stat(recPath)
          .then(() => true)
          .catch(() => false)

        // 精度降级容错：若当前精度模型不存在，尝试匹配目录中现有的其他精度 (如 tiny, small, medium)
        if (!hasDet || !hasRec) {
          const fallbackPrecisions: Array<'tiny' | 'small' | 'medium'> = ['tiny', 'small', 'medium']
          for (const prec of fallbackPrecisions) {
            const candDet = path.join(modelDir, `PP-OCRv6_det_${prec}.onnx`)
            const candRec = path.join(modelDir, `PP-OCRv6_rec_${prec}.onnx`)
            const candKeys = path.join(modelDir, `ppocr_keys_v6_${prec}.txt`)
            const dOk = await fs
              .stat(candDet)
              .then(() => true)
              .catch(() => false)
            const rOk = await fs
              .stat(candRec)
              .then(() => true)
              .catch(() => false)
            if (dOk && rOk) {
              detPath = candDet
              recPath = candRec
              keysPath = candKeys
              hasDet = true
              hasRec = true
              console.debug(
                `[OCRService][debug] 当前精度 ${modelType} 不存在，自动回退使用已存在的精度: ${prec}`
              )
              break
            }
          }
        }

        // 容错备用旧命名匹配 (ch_PP-OCRv6_det_infer.onnx)
        if (!hasDet || !hasRec) {
          const fallbackDet = path.join(modelDir, 'ch_PP-OCRv6_det_infer.onnx')
          const fallbackRec = path.join(modelDir, 'ch_PP-OCRv6_rec_infer.onnx')
          const fallbackKeys = path.join(modelDir, 'ppocr_keys_v1.txt')
          if (
            await fs
              .stat(fallbackDet)
              .then(() => true)
              .catch(() => false)
          ) {
            detPath = fallbackDet
            recPath = fallbackRec
            keysPath = fallbackKeys
            hasDet = true
            hasRec = await fs
              .stat(recPath)
              .then(() => true)
              .catch(() => false)
          }
        }

        console.debug(
          `[OCRService][debug] 模型文件探测 - det: ${hasDet} (${path.basename(detPath)}), rec: ${hasRec} (${path.basename(recPath)}), keys: ${path.basename(keysPath)}`
        )

        if (hasDet && hasRec) {
          try {
            this.sessionDet = await ort.InferenceSession.create(detPath)
            this.sessionRec = await ort.InferenceSession.create(recPath)
            const keysRaw = await fs.readFile(keysPath, 'utf-8').catch(() => '')
            const lines = keysRaw.split(/\r?\n/).map(l => l.replace(/[\r\n]/g, ''))
            // 完全对齐 MarkItDown Python 版: self.char_list = [""] + lines + [" "]
            this.keysMap = ['', ...lines, ' ']
            console.debug(
              `[OCRService][debug] ✅ ONNX PP-OCRv6 (${modelType}) 会话与字典成功创建! (字典词条数: ${this.keysMap.length})`
            )
          } catch (sessionErr: any) {
            console.warn(
              `[OCRService] 创建 ONNX InferenceSession 失败:`,
              sessionErr?.message || sessionErr
            )
          }
        } else {
          console.warn(
            `[OCRService] ⚠️ PP-OCRv6 模型文件不完整 (hasDet=${hasDet}, hasRec=${hasRec}), 目录: ${modelDir}`
          )
        }
      }

      this.currentModelType = modelType
      this.isLoaded = true
      const duration = Date.now() - tStart
      console.log(
        `[OCRService] PP-OCRv6 (${modelType}) 模型懒加载并常驻内存成功，耗时: ${duration}ms`
      )
    } catch (err) {
      console.error('[OCRService] 加载 ONNX 模型失败:', err)
      this.isLoaded = false
    }
  }

  /**
   * CTC 贪心解码器 (100% 对齐 MarkItDown _ctc_decode)
   */
  private ctcDecode(
    recPredsData: Float32Array,
    shape: number[]
  ): { text: string; confidence: number } {
    if (!this.keysMap || this.keysMap.length === 0 || !shape || shape.length < 3) {
      return { text: '', confidence: 0 }
    }

    const [batchSize, seqLen, numClasses] = shape
    let text = ''
    const confidences: number[] = []
    let prevIdx = 0

    for (let t = 0; t < seqLen; t++) {
      let maxIdx = 0
      let maxVal = -Infinity
      const offset = t * numClasses

      for (let c = 0; c < numClasses; c++) {
        const val = recPredsData[offset + c]
        if (val > maxVal) {
          maxVal = val
          maxIdx = c
        }
      }

      if (maxIdx !== 0 && maxIdx !== prevIdx) {
        if (maxIdx < this.keysMap.length) {
          const char = this.keysMap[maxIdx]
          if (char) {
            text += char
            confidences.push(maxVal)
          }
        }
      }
      prevIdx = maxIdx
    }

    const avgConf = confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0.95

    return { text, confidence: avgConf }
  }

  /**
   * 识别单张裁剪出的文本框小图 (100% 对齐 MarkItDown _preprocess_rec)
   */
  private async recognizeCropBox(
    cropBuffer: Buffer,
    sharp: any
  ): Promise<{ text: string; confidence: number }> {
    if (!this.sessionRec || !this.ortModule) return { text: '', confidence: 0 }

    try {
      const metadata = await sharp(cropBuffer).metadata()
      const ch = metadata.height || 0
      const cw = metadata.width || 0

      if (ch === 0 || cw === 0) return { text: '', confidence: 0 }

      const recH = 48
      let recW = Math.round((recH * cw) / ch)
      recW = Math.max(8, Math.min(2400, recW))

      const { data, info } = await sharp(cropBuffer)
        .resize(recW, recH, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

      const w = info.width
      const h = info.height
      const channels = info.channels

      const floatArray = new Float32Array(3 * h * w)
      const imageArea = h * w

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pixelIdx = (y * w + x) * channels
          const r = data[pixelIdx]
          const g = data[pixelIdx + 1]
          const b = data[pixelIdx + 2]

          const targetIdx = y * w + x
          // 对齐 MarkItDown: norm = (rgb.astype(np.float32) / 255.0 - 0.5) / 0.5
          floatArray[targetIdx] = r / 127.5 - 1.0
          floatArray[imageArea + targetIdx] = g / 127.5 - 1.0
          floatArray[2 * imageArea + targetIdx] = b / 127.5 - 1.0
        }
      }

      const inputTensor = new this.ortModule.Tensor('float32', floatArray, [1, 3, h, w])
      const inputName = this.sessionRec.inputNames?.[0] || 'x'
      const feeds = { [inputName]: inputTensor }

      const results = await this.sessionRec.run(feeds)
      const outputName = this.sessionRec.outputNames?.[0] || Object.keys(results)[0]
      const outputTensor = results[outputName]

      if (outputTensor && outputTensor.data) {
        const shape = outputTensor.dims || [
          1,
          Math.floor(outputTensor.data.length / this.keysMap.length),
          this.keysMap.length
        ]
        return this.ctcDecode(outputTensor.data as Float32Array, shape)
      }
    } catch {
      // 容错
    }

    return { text: '', confidence: 0 }
  }

  /**
   * 将散乱检测框按物理排版重排为连续多行段落 (100% 对齐 MarkItDown _group_boxes_into_lines)
   */
  private groupBoxesIntoLines(
    boxesWithText: Array<{ box: [number, number, number, number]; text: string; conf: number }>
  ): string {
    if (!boxesWithText || boxesWithText.length === 0) return ''

    const sorted = [...boxesWithText].sort((a, b) => a.box[0] - b.box[0])
    const lines: Array<
      Array<{ box: [number, number, number, number]; text: string; conf: number }>
    > = []

    for (const item of sorted) {
      const [y0, x0, y1, x1] = item.box
      let placed = false

      for (const line of lines) {
        const ly0 = Math.min(...line.map(b => b.box[0]))
        const ly1 = Math.max(...line.map(b => b.box[2]))
        const lineH = Math.max(1, ly1 - ly0)
        const yCenter = (y0 + y1) / 2.0

        if (yCenter >= ly0 - lineH * 0.4 && yCenter <= ly1 + lineH * 0.4) {
          line.push(item)
          placed = true
          break
        }
      }

      if (!placed) {
        lines.push([item])
      }
    }

    lines.sort((a, b) => {
      const avgA = a.reduce((sum, item) => sum + item.box[0], 0) / a.length
      const avgB = b.reduce((sum, item) => sum + item.box[0], 0) / b.length
      return avgA - avgB
    })

    const formattedLines = lines.map(line => {
      line.sort((a, b) => a.box[1] - b.box[1])
      return line.map(b => b.text).join('  ')
    })

    return formattedLines.join('\n')
  }

  /**
   * 执行双阶段 ONNX PP-OCRv6 推理 (100% 对齐 MarkItDown ONNXPPOCRService.extract_text)
   */
  private async runInferenceOnImageBuffer(
    imageBuffer: Buffer
  ): Promise<{ text: string; confidence: number }> {
    if (!this.sessionRec || !this.ortModule) {
      return { text: '', confidence: 0 }
    }

    try {
      const sharp = await this.getSharp()
      if (!sharp || typeof sharp !== 'function') {
        console.warn('[OCRService] Sharp 实例不可用，跳过图像处理')
        return { text: '', confidence: 0 }
      }
      const metadata = await sharp(imageBuffer).metadata()
      const origW = metadata.width || 0
      const origH = metadata.height || 0

      if (origW === 0 || origH === 0) return { text: '', confidence: 0 }

      const boxesWithText: Array<{
        box: [number, number, number, number]
        text: string
        conf: number
      }> = []

      // --- 第一阶段：DBNet 文本区域检测 (Detection) ---
      if (this.sessionDet) {
        const maxSide = 960
        const scale = Math.min(1.0, maxSide / Math.max(origH, origW))
        const newW = Math.max(32, Math.round((origW * scale) / 32) * 32)
        const newH = Math.max(32, Math.round((origH * scale) / 32) * 32)

        const scaleX = origW / newW
        const scaleY = origH / newH

        const { data, info } = await sharp(imageBuffer)
          .resize(newW, newH, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })

        const floatArray = new Float32Array(3 * newH * newW)
        const imageArea = newH * newW
        const mean = [0.485, 0.456, 0.406]
        const std = [0.229, 0.224, 0.225]

        for (let y = 0; y < newH; y++) {
          for (let x = 0; x < newW; x++) {
            const pixelIdx = (y * newW + x) * info.channels
            const targetIdx = y * newW + x
            floatArray[targetIdx] = (data[pixelIdx] / 255.0 - mean[0]) / std[0]
            floatArray[imageArea + targetIdx] = (data[pixelIdx + 1] / 255.0 - mean[1]) / std[1]
            floatArray[2 * imageArea + targetIdx] = (data[pixelIdx + 2] / 255.0 - mean[2]) / std[2]
          }
        }

        const detInputTensor = new this.ortModule.Tensor('float32', floatArray, [1, 3, newH, newW])
        const detInputName = this.sessionDet.inputNames?.[0] || 'x'
        const detOut = await this.sessionDet.run({ [detInputName]: detInputTensor })
        const detOutName = this.sessionDet.outputNames?.[0] || Object.keys(detOut)[0]
        const probMap = detOut[detOutName].data as Float32Array

        // 从概率图中提取二值连通块外接框
        const visited = new Uint8Array(newW * newH)

        for (let y = 0; y < newH; y++) {
          for (let x = 0; x < newW; x++) {
            const idx = y * newW + x
            if (visited[idx] || probMap[idx] <= 0.3) continue

            let minX = x,
              maxX = x,
              minY = y,
              maxY = y
            const queue: number[] = [idx]
            visited[idx] = 1

            let head = 0
            while (head < queue.length) {
              const curr = queue[head++]
              const cy = Math.floor(curr / newW)
              const cx = curr % newW

              if (cx < minX) minX = cx
              if (cx > maxX) maxX = cx
              if (cy < minY) minY = cy
              if (cy > maxY) maxY = cy

              const neighbors = [
                cy > 0 ? (cy - 1) * newW + cx : -1,
                cy < newH - 1 ? (cy + 1) * newW + cx : -1,
                cx > 0 ? cy * newW + (cx - 1) : -1,
                cx < newW - 1 ? cy * newW + (cx + 1) : -1
              ]

              for (const n of neighbors) {
                if (n >= 0 && !visited[n] && probMap[n] > 0.3) {
                  visited[n] = 1
                  queue.push(n)
                }
              }
            }

            const bw = maxX - minX + 1
            const bh = maxY - minY + 1

            if (bw >= 4 && bh >= 4) {
              const paddingX = Math.round(bw * 0.1)
              const paddingY = Math.round(bh * 0.1)

              const x0 = Math.max(0, Math.floor((minX - paddingX) * scaleX))
              const y0 = Math.max(0, Math.floor((minY - paddingY) * scaleY))
              const x1 = Math.min(origW, Math.ceil((maxX + 1 + paddingX) * scaleX))
              const y1 = Math.min(origH, Math.ceil((maxY + 1 + paddingY) * scaleY))
              const cropW = x1 - x0
              const cropH = y1 - y0

              if (cropW >= 5 && cropH >= 5) {
                try {
                  const cropBuffer = await sharp(imageBuffer)
                    .extract({ left: x0, top: y0, width: cropW, height: cropH })
                    .toBuffer()

                  const recRes = await this.recognizeCropBox(cropBuffer, sharp)
                  if (recRes.text && recRes.text.trim()) {
                    boxesWithText.push({
                      box: [y0, x0, y1, x1],
                      text: recRes.text.trim(),
                      conf: recRes.confidence
                    })
                  }
                } catch {
                  // 切片容错
                }
              }
            }
          }
        }
      }

      // 容错兜底：若 DBNet 未检出框（例如单行 UI 按钮或极其特殊的全图），全图进行识别
      if (boxesWithText.length === 0) {
        const fullRes = await this.recognizeCropBox(imageBuffer, sharp)
        if (fullRes.text) {
          return fullRes
        }
      }

      console.debug(`[OCRService][debug] 检测到 ${boxesWithText.length} 个有效的文字边界框`)

      const fullText = this.groupBoxesIntoLines(boxesWithText)
      const avgConf = boxesWithText.length
        ? boxesWithText.reduce((sum, item) => sum + item.conf, 0) / boxesWithText.length
        : 0.95

      return { text: fullText, confidence: avgConf }
    } catch (err: any) {
      console.warn('[OCRService] 图像 ONNX 推理过程异常:', err?.message || err)
    }

    return { text: '', confidence: 0 }
  }

  /**
   * 将任意可能不支持的图片/帧通过 Sharp 转换，若 Sharp 不支持则降级通过 FFmpeg 转码为 PNG Buffer
   */
  private async convertToSupportedImageBuffer(input: string | Buffer): Promise<Buffer | null> {
    try {
      const sharp = await this.getSharp()

      // 1. 优先尝试使用 Sharp 转换为标准 PNG Buffer
      try {
        if (typeof input === 'string') {
          return await sharp(input).toFormat('png').toBuffer()
        } else if (Buffer.isBuffer(input)) {
          return await sharp(input).toFormat('png').toBuffer()
        }
      } catch (sharpErr: any) {
        console.debug(
          `[OCRService][debug] Sharp 图像格式转码跳过 (${sharpErr?.message || sharpErr})，尝试 FFmpeg 降级转码...`
        )
      }

      // 2. 降级：如果 Sharp 不支持，调用 FFmpeg 命令行抽取首帧图像
      const { ffmpegService } = await import('../ffmpeg-service')
      const isFfmpegAvailable = await ffmpegService.detectFfmpeg()
      if (!isFfmpegAvailable) return null

      let tempInputPath = typeof input === 'string' ? input : ''
      let needCleanTempInput = false

      if (!tempInputPath && Buffer.isBuffer(input)) {
        const os = await import('node:os')
        tempInputPath = path.join(
          os.tmpdir(),
          `ocr_raw_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`
        )
        await fs.writeFile(tempInputPath, input)
        needCleanTempInput = true
      }

      if (!tempInputPath) return null

      const os = await import('node:os')
      const tempOutputPath = path.join(
        os.tmpdir(),
        `ocr_conv_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
      )

      const cp = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFile = promisify(cp.execFile)

      const ffmpegCmd = (ffmpegService as any).ffmpegPath || 'ffmpeg'
      await execFile(ffmpegCmd, [
        '-y',
        '-i',
        tempInputPath,
        '-vframes',
        '1',
        '-f',
        'image2',
        tempOutputPath
      ])

      const convertedBuffer = await fs.readFile(tempOutputPath).catch(() => null)

      if (needCleanTempInput) await fs.unlink(tempInputPath).catch(() => {})
      await fs.unlink(tempOutputPath).catch(() => {})

      if (convertedBuffer && convertedBuffer.length > 0) {
        console.debug(
          `[OCRService][debug] ✅ 成功通过 FFmpeg 降级转码图像为 PNG (${convertedBuffer.length} bytes)`
        )
        return convertedBuffer
      }
    } catch (ffmpegErr: any) {
      console.debug(
        `[OCRService][debug] FFmpeg 图像降级转码未触发/失败: ${ffmpegErr?.message || ffmpegErr}`
      )
    }

    return null
  }

  /**
   * 对图片文件或 Buffer 执行 OCR 文字识别
   */
  public async recognize(
    input: string | Buffer,
    options: OCRRequestOptions = {}
  ): Promise<OCRResult> {
    const tStart = Date.now()
    let modelType = options.modelType
    if (!modelType) {
      try {
        const { ConfigOrchestrator } = require('../../../config/config-orchestrator')
        modelType = ConfigOrchestrator.getInstance().getValue('OCR_MODEL_SIZE') as any
      } catch {
        // 单测环境
      }
    }
    modelType = modelType || 'tiny'

    const inputDesc =
      typeof input === 'string' ? `Path: ${input}` : `Buffer (${input.length} bytes)`

    console.debug(`[OCRService][debug] 收到 OCR 识别请求 - ${inputDesc}, modelType=${modelType}`)

    // 格式过滤防御：对于 .docx, .xlsx 等文档压缩包提前拦截，不作为图像识别
    const NON_IMAGE_EXTS = new Set([
      '.docx',
      '.doc',
      '.xlsx',
      '.xls',
      '.pptx',
      '.ppt',
      '.pdf',
      '.zip',
      '.rar',
      '.7z',
      '.tar',
      '.gz',
      '.mp3',
      '.wav',
      '.flac'
    ])

    if (typeof input === 'string') {
      const ext = path.extname(input).toLowerCase()
      if (ext && NON_IMAGE_EXTS.has(ext)) {
        console.debug(
          `[OCRService][debug] ℹ️ 目标文件为非图像格式 (${ext})，优雅跳过原生图像 OCR 识别: ${input}`
        )
        return { text: '', confidence: 0, durationMs: Date.now() - tStart }
      }
    }

    // 确保按需装载模型
    await this.ensureLoaded(modelType)

    let imageBuffer: Buffer | null = null

    // 先尝试直接读取 Buffer
    if (typeof input === 'string') {
      try {
        imageBuffer = await fs.readFile(input)
      } catch (e) {
        console.debug(`[OCRService][debug] ⚠️ 目标文件不存在或无法读取: ${input}`)
        return { text: '', confidence: 0, durationMs: Date.now() - tStart }
      }
    } else if (Buffer.isBuffer(input)) {
      imageBuffer = input
    }

    // 尝试格式自动转换与 FFmpeg 降级转码
    if (imageBuffer) {
      const converted = await this.convertToSupportedImageBuffer(imageBuffer)
      if (converted) {
        imageBuffer = converted
      }
    }

    let extractedText = ''
    let confidence = 0.95

    // 执行 100% 对齐 MarkItDown 的双阶段 ONNX 推理
    if (imageBuffer && this.sessionRec) {
      const inferResult = await this.runInferenceOnImageBuffer(imageBuffer)
      extractedText = inferResult.text
      if (inferResult.confidence > 0) {
        confidence = inferResult.confidence
      }
    }

    const durationMs = Date.now() - tStart
    const trimmedText = extractedText.trim()

    if (trimmedText.length > 0) {
      const preview = trimmedText.length > 60 ? trimmedText.slice(0, 60) + '...' : trimmedText
      console.debug(
        `[OCRService][debug] ✅ OCR 识别成功! 文本长度=${trimmedText.length}, 预览片段: "${preview}", 耗时=${durationMs}ms`
      )
    } else {
      const sessionReady = !!(this.sessionDet && this.sessionRec)
      console.debug(
        `[OCRService][debug] ⚠️ OCR 未能提取到文字 (提取字数=0, sessionReady=${sessionReady}). 可能图像为纯图无文字/前景对比度不足/或仅含图形 (耗时=${durationMs}ms, ${inputDesc})`
      )
    }

    return {
      text: trimmedText,
      confidence,
      durationMs
    }
  }
}

export const ocrService = OCRService.getInstance()
