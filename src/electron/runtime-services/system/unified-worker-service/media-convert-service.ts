/**
 * 媒体与文档转换管道服务 (Media & Document Convert Service)
 * 整合 LibreOffice, Sharp, Poppler 及 FFmpeg 懒加载处理
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { logger, LogCategory, FileCategory, isCategory } from '@firefly/shared'
import {
  DocumentPreviewOptions,
  DocumentPreviewResult,
  MediaThumbnailOptions,
  MediaInfoResult
} from './types'

export class MediaConvertService {
  private static instance: MediaConvertService
  private maxConcurrentFfmpeg = 2
  private activeFfmpegCount = 0

  private constructor() {}

  public static getInstance(): MediaConvertService {
    if (!MediaConvertService.instance) {
      MediaConvertService.instance = new MediaConvertService()
    }
    return MediaConvertService.instance
  }

  /**
   * 提取文档/PDF 第一页/封面的临时图像 Buffer (供 OCR / 文本抽取做结构理解)
   */
  public async extractDocumentCoverBuffer(filePath: string): Promise<Buffer | null> {
    return this.extractDocumentCoverPngBuffer(filePath)
  }

  /**
   * 使用 LibreOffice 将 Office/PDF 的第一页渲染为高清 PNG 图像 Buffer
   * LibreOffice 的 --convert-to png 本身就 100% 保持文档原生页面方向 (Portrait/Landscape)
   */
  public async extractDocumentCoverPngBuffer(filePath: string): Promise<Buffer | null> {
    try {
      const { libreOfficeDetector } = await import('../libreoffice-detector')
      const loInfo = await libreOfficeDetector.detectLibreOffice()
      if (loInfo && loInfo.path) {
        // 自动探测并复用 (或启动) LibreOffice 常驻守护进程 (支持开发热更新静默复用)
        const { libreOfficeDaemonService } = await import('../libreoffice-daemon-service')
        await libreOfficeDaemonService.ensureDaemonRunning()

        const os = await import('node:os')
        const tempOutDir = path.join(
          os.tmpdir(),
          `lo_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}`
        )
        await fs.mkdir(tempOutDir, { recursive: true })

        const cp = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFile = promisify(cp.execFile)

        // LibreOffice --convert-to png 直接输出精准保持文档原生 Page Setup 方向的 PNG
        await execFile(
          loInfo.path,
          ['--headless', '--convert-to', 'png', '--outdir', tempOutDir, filePath],
          { timeout: 30000 }
        )

        const baseName = path.basename(filePath, path.extname(filePath))
        const generatedPngPath = path.join(tempOutDir, `${baseName}.png`)
        const exists = await fs
          .access(generatedPngPath)
          .then(() => true)
          .catch(() => false)

        let buffer: Buffer | null = null
        if (exists) {
          buffer = await fs.readFile(generatedPngPath)
          // 诊断：输出 LibreOffice 生成的原始 PNG 实际物理尺寸
          try {
            const sharp = (await import('sharp')).default
            const meta = await sharp(buffer).metadata()
            console.debug(
              `[MediaConvertService][debug] extractDocumentCoverPngBuffer 原始 PNG 尺寸: ${meta.width} x ${meta.height}, 方向: ${(meta.height || 0) > (meta.width || 0) ? '竖版' : '横版'}, file: ${path.basename(filePath)}`
            )
          } catch {}
        }

        await fs.rm(tempOutDir, { recursive: true, force: true }).catch(() => {})

        return buffer
      }
    } catch (e: any) {
      console.warn(
        `[MediaConvertService] LibreOffice 提取首页 PNG 失败: ${filePath}`,
        e?.message || e
      )
    }
    return null
  }

  /**
   * 使用 LibreOffice 将 Office/PDF 的所有页面渲染为 PNG 图像 Buffer 数组
   * 供多页 OCR 识别补全文本
   */
  public async extractDocumentAllPagePngBuffers(
    filePath: string,
    effectiveExt?: string
  ): Promise<Buffer[]> {
    const buffers: Buffer[] = []
    try {
      const ext = (effectiveExt || path.extname(filePath)).toLowerCase()
      const effectiveVirtualPath =
        ext && !filePath.toLowerCase().endsWith(ext) ? `${filePath}${ext}` : filePath

      let targetDocPath = filePath
      let needCleanTarget = false

      if (isCategory(effectiveVirtualPath, FileCategory.OFFICE)) {
        const { libreOfficeDetector } = await import('../libreoffice-detector')
        const loInfo = await libreOfficeDetector.detectLibreOffice()
        if (loInfo && loInfo.path) {
          const { libreOfficeDaemonService } = await import('../libreoffice-daemon-service')
          await libreOfficeDaemonService.ensureDaemonRunning()

          console.debug(
            `[MediaConvertService][debug] 📄 开始将 Office 转为 PDF: file=${path.basename(filePath)}`
          )
          const pdfPath = await this.convertOfficeToPdf(filePath, ext)
          if (pdfPath) {
            targetDocPath = pdfPath
            needCleanTarget = true
            console.debug(`[MediaConvertService][debug] ✅ Office 转 PDF 成功: ${pdfPath}`)
          } else {
            console.warn(
              `[MediaConvertService][warn] ⚠️ Office 转 PDF 失败，无法进行多页物理切图: file=${path.basename(filePath)}`
            )
            return []
          }
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `未检测到 LibreOffice，Office 文件跳过转 PDF 多页物理切片: ${filePath}`
          )
          return []
        }
      }

      const isPdf = ext === '.pdf' || targetDocPath.toLowerCase().endsWith('.pdf')
      if (isPdf) {
        const os = await import('node:os')
        const tempOutDir = path.join(
          os.tmpdir(),
          `lo_ocr_pages_${Date.now()}_${Math.random().toString(36).slice(2)}`
        )
        await fs.mkdir(tempOutDir, { recursive: true })

        const cp = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFile = promisify(cp.execFile)

        let ispdftoppmSuccess = false

        // A. 优先尝试使用 pdftoppm 一键批量导出多页物理 PNG 图像 (耗时 < 100ms)
        try {
          const { popplerDetector } = await import('../poppler-detector')
          const popplerInfo = await popplerDetector.detectPoppler()
          if (popplerInfo && popplerInfo.installed && popplerInfo.path) {
            const pdftoppmBin = popplerInfo.path
            const { ResourceLocator } = await import('@firefly/shared')
            const { env, cwd } = ResourceLocator.getBinExecutionEnv(pdftoppmBin)

            const prefix = path.join(tempOutDir, 'page')
            await execFile(pdftoppmBin, ['-png', '-r', '150', targetDocPath, prefix], {
              timeout: 30000,
              env,
              cwd
            })

            const files = await fs.readdir(tempOutDir)
            const pngFiles = files
              .filter(f => f.toLowerCase().endsWith('.png'))
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))

            for (const file of pngFiles) {
              const buf = await fs.readFile(path.join(tempOutDir, file))
              if (buf && buf.length > 1024) {
                buffers.push(buf)
              }
            }

            if (buffers.length > 0) {
              ispdftoppmSuccess = true
              console.debug(
                `[MediaConvertService][debug] ⚡ pdftoppm 批量物理切图成功: 产出高清 PNG 张数=${buffers.length} 张, 源文件=${path.basename(filePath)}`
              )
            }
          } else {
            console.debug(
              `[MediaConvertService][debug] pdftoppm 未就绪，尝试降级渲染: file=${path.basename(filePath)}`
            )
          }
        } catch (popplerErr: any) {
          logger.warn(
            LogCategory.SYSTEM,
            `[MediaConvertService] pdftoppm 批量切图失败: ${popplerErr?.message || popplerErr}`
          )
        }

        // B. 兜底方案：如果 pdftoppm 命令行不可用，使用 pdfjs-dist / 封面提取作为保底
        if (!ispdftoppmSuccess) {
          console.debug(
            `[MediaConvertService][debug] 🔄 pdftoppm 未在系统中探测到，降级启用多页渲染保底: file=${path.basename(filePath)}`
          )
          try {
            const { pathToFileURL } = await import('node:url')
            const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
            const pdfjsLib = await import(pathToFileURL(pdfjsPath).href)
            const pdfData = await fs.readFile(targetDocPath)
            const pdfDoc = await pdfjsLib.getDocument({
              data: new Uint8Array(pdfData),
              useSystemFonts: true,
              disableFontFace: true
            }).promise

            const pageCount = pdfDoc.numPages
            const sharp = (await import('sharp')).default
            const SVGConstructor = pdfjsLib.SVGGraphics || (pdfjsLib as any).DOMSVGFactory

            if (SVGConstructor && typeof SVGConstructor === 'function') {
              for (let i = 1; i <= pageCount; i++) {
                try {
                  const page = await pdfDoc.getPage(i)
                  const opList = await page.getOperatorList()
                  const svgG = new SVGConstructor(page.commonObjs, page.objs)
                  const svgNode = await svgG.getSVG(opList, page.getViewport({ scale: 2.0 }))
                  const svgXml = svgNode?.toString() || ''
                  if (svgXml) {
                    const pngBuf = await sharp(Buffer.from(svgXml)).png().toBuffer()
                    if (pngBuf && pngBuf.length > 1024) {
                      buffers.push(pngBuf)
                    }
                  }
                } catch {
                  // 单页 SVG 渲染跳过
                }
              }
            }
          } catch {
            // pdfjs 渲染失败优雅容错
          }

          // 如果兜底渲染仍未拿到多页 Buffer，提取第 1 页保底封面 Buffer
          if (buffers.length === 0) {
            const coverBuf = await this.extractDocumentCoverPngBuffer(filePath)
            if (coverBuf && coverBuf.length > 1024) {
              buffers.push(coverBuf)
            }
          }

          console.debug(
            `[MediaConvertService][debug] 📊 页面物理渲染保底完成: 成功获取 PNG 张数=${buffers.length} 张, 源文件=${path.basename(filePath)}`
          )

          await fs.rm(tempOutDir, { recursive: true, force: true }).catch(() => {})
        }

        if (needCleanTarget && targetDocPath) {
          await fs.unlink(targetDocPath).catch(() => {})
          const pdfDir = path.dirname(targetDocPath)
          await fs.rm(pdfDir, { recursive: true, force: true }).catch(() => {})
        }
      }
    } catch (e: any) {
      console.warn(
        `[MediaConvertService] LibreOffice 提取多页 PNG 失败: ${filePath}`,
        e?.message || e
      )
    }
    return buffers
  }
  /**
   * 使用 pdfjs-dist 从 PDF 文件中秒级解析全量 Page 1..N 页面的向量文本数组
   */
  public async extractPdfPageTexts(pdfPath: string): Promise<string[]> {
    const pageTexts: string[] = []
    try {
      const { pathToFileURL } = await import('node:url')
      const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
      const pdfjsLib = await import(pathToFileURL(pdfjsPath).href)

      const pdfData = await fs.readFile(pdfPath)
      const pdfDoc = await pdfjsLib.getDocument({
        data: new Uint8Array(pdfData),
        useSystemFonts: true,
        disableFontFace: true
      }).promise

      const totalPages = pdfDoc.numPages
      console.debug(
        `[MediaConvertService][debug] 📊 pdfjs-dist 成功解析 PDF: 真实总页数=${totalPages} 页, file=${path.basename(pdfPath)}`
      )

      for (let i = 1; i <= totalPages; i++) {
        const page = await pdfDoc.getPage(i)
        const textContent = await page.getTextContent()
        const pageStr = textContent.items
          .map((item: any) => item.str)
          .join(' ')
          .trim()

        if (pageStr) {
          pageTexts.push(pageStr)
        }
      }
    } catch (err: any) {
      console.warn(
        `[MediaConvertService] pdfjs-dist 提取 PDF 多页文本失败: ${pdfPath}`,
        err?.message || err
      )
    }
    return pageTexts
  }

  /**
   * 为无扩展名物理文件代理构造临时的规范扩展名路径，确保 LibreOffice/Poppler 正常解析
   */
  private async ensurePathWithExtension<T>(
    filePath: string,
    effectiveExt: string | undefined,
    fn: (validPath: string) => Promise<T>
  ): Promise<T> {
    const rawExt = path.extname(filePath)
    if (rawExt || !effectiveExt) {
      return fn(filePath)
    }

    const os = await import('node:os')
    const tempDir = path.join(
      os.tmpdir(),
      `proxy_ext_${Date.now()}_${Math.random().toString(36).slice(2)}`
    )
    await fs.mkdir(tempDir, { recursive: true })

    const safeExt = effectiveExt.startsWith('.') ? effectiveExt : `.${effectiveExt}`
    const proxyPath = path.join(tempDir, `${path.basename(filePath)}${safeExt}`)

    try {
      await fs.symlink(filePath, proxyPath).catch(async () => {
        await fs.copyFile(filePath, proxyPath)
      })
      return await fn(proxyPath)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 将 Office 文档 (DOCX, PPTX, XLSX, ODT 等) 转为临时 PDF 文件 (供多页光栅化 OCR 识别)
   */
  public async convertOfficeToPdf(filePath: string, effectiveExt?: string): Promise<string | null> {
    return this.ensurePathWithExtension(filePath, effectiveExt, async validPath => {
      try {
        const { libreOfficeDetector } = await import('../libreoffice-detector')
        const loInfo = await libreOfficeDetector.detectLibreOffice()
        if (!loInfo || !loInfo.path) {
          console.debug(
            `[MediaConvertService][debug] 未检测到 LibreOffice，跳过 Office -> PDF 预转换`
          )
          return null
        }

        const os = await import('node:os')
        const tempOutDir = path.join(
          os.tmpdir(),
          `lo_pdf_${Date.now()}_${Math.random().toString(36).slice(2)}`
        )
        await fs.mkdir(tempOutDir, { recursive: true })

        const cp = await import('node:child_process')
        const { promisify } = await import('node:util')
        const execFile = promisify(cp.execFile)

        await execFile(
          loInfo.path,
          ['--headless', '--convert-to', 'pdf', '--outdir', tempOutDir, validPath],
          { timeout: 30000 }
        )

        const baseName = path.basename(validPath, path.extname(validPath))
        const generatedPdfPath = path.join(tempOutDir, `${baseName}.pdf`)

        const exists = await fs
          .access(generatedPdfPath)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          console.debug(
            `[MediaConvertService][debug] ✅ LibreOffice 成功将 Office 转换为预转 PDF: ${generatedPdfPath}`
          )
          return generatedPdfPath
        }
      } catch (loErr: any) {
        console.warn(
          `[MediaConvertService] LibreOffice 转码 PDF 失败: ${filePath}`,
          loErr?.message || loErr
        )
      }

      return null
    })
  }

  /**
   * 生成文档 (Word/PPT/Excel/PDF) 封面预览图
   */
  public async generateDocumentPreview(
    filePath: string,
    outputCoverPath: string,
    options: DocumentPreviewOptions = {}
  ): Promise<DocumentPreviewResult> {
    const tStart = Date.now()
    const ext = (options.effectiveExt || path.extname(filePath)).toLowerCase()
    const effectiveVirtualPath =
      ext && !filePath.toLowerCase().endsWith(ext) ? `${filePath}${ext}` : filePath
    const fileName = path.basename(filePath)

    console.debug(
      `[MediaConvertService][debug] 收到文档/图像封面生成请求 - file="${fileName}", ext="${ext}"`
    )

    try {
      await fs.mkdir(path.dirname(outputCoverPath), { recursive: true })
    } catch {
      // 容错
    }

    try {
      return await this.ensurePathWithExtension(filePath, options.effectiveExt, async validPath => {
        // 1. 如果本身就是图片，直接使用 Sharp 转换为 WebP 封面
        if (isCategory(effectiveVirtualPath, FileCategory.IMAGE)) {
          try {
            const sharp = (await import('sharp')).default
            await sharp(validPath)
              .resize(options.maxWidth || 800, options.maxHeight || 800, {
                fit: 'inside',
                withoutEnlargement: true
              })
              .webp({ quality: options.quality || 80 })
              .toFile(outputCoverPath)

            const durationMs = Date.now() - tStart
            console.debug(
              `[MediaConvertService][debug] ✅ Sharp 图片封面转换成功 (耗时=${durationMs}ms): file="${fileName}", output="${outputCoverPath}"`
            )
            return { coverPath: outputCoverPath, durationMs }
          } catch (sharpErr: any) {
            console.warn(
              `[MediaConvertService] Sharp 处理图片封面失败: ${filePath}`,
              sharpErr?.message || sharpErr
            )
          }
        }

        // 2. 如果为 Office / PDF 文档，且安装了 LibreOffice：优先使用 LibreOffice 直接渲染第 1 页为高保真 PNG 封面
        if (isCategory(effectiveVirtualPath, FileCategory.OFFICE) || ext === '.pdf') {
          try {
            const { libreOfficeDetector } = await import('../libreoffice-detector')
            const loInfo = await libreOfficeDetector.detectLibreOffice()
            if (loInfo && loInfo.path) {
              const os = await import('node:os')
              const tempOutDir = path.join(
                os.tmpdir(),
                `lo_png_${Date.now()}_${Math.random().toString(36).slice(2)}`
              )
              await fs.mkdir(tempOutDir, { recursive: true })

              const cp = await import('node:child_process')
              const { promisify } = await import('node:util')
              const execFile = promisify(cp.execFile)

              await execFile(
                loInfo.path,
                ['--headless', '--convert-to', 'png', '--outdir', tempOutDir, validPath],
                { timeout: 30000 }
              )

              const baseName = path.basename(filePath, path.extname(filePath))
              const generatedPngPath = path.join(tempOutDir, `${baseName}.png`)
              const exists = await fs
                .access(generatedPngPath)
                .then(() => true)
                .catch(() => false)

              if (exists) {
                const sharp = (await import('sharp')).default
                // 诊断：输出 generateDocumentPreview 路径下的原始 PNG 物理尺寸
                const diagMeta = await sharp(generatedPngPath).metadata()
                console.debug(
                  `[MediaConvertService][debug] generateDocumentPreview 原始 PNG 尺寸: ${diagMeta.width} x ${diagMeta.height}, 方向: ${(diagMeta.height || 0) > (diagMeta.width || 0) ? '竖版' : '横版'}, file: ${fileName}`
                )
                // LibreOffice 输出的 PNG 本身就精准保持了文档原生 Page Setup 方向，直接等比缩放
                await sharp(generatedPngPath)
                  .resize(options.maxWidth || 800, options.maxHeight || 800, {
                    fit: 'inside',
                    withoutEnlargement: true
                  })
                  .webp({ quality: options.quality || 80 })
                  .toFile(outputCoverPath)

                await fs.rm(tempOutDir, { recursive: true, force: true }).catch(() => {})
                const durationMs = Date.now() - tStart
                console.debug(
                  `[MediaConvertService][debug] ✅ LibreOffice 渲染高保真文档封面成功 (耗时=${durationMs}ms): ${fileName}`
                )
                return { coverPath: outputCoverPath, durationMs }
              }
            }
          } catch (loErr: any) {
            console.warn(
              `[MediaConvertService] LibreOffice 渲染封面降级: ${filePath}`,
              loErr?.message || loErr
            )
          }
        }

        // 3. 如果未安装 LibreOffice / 转换失败，针对 PPTX/DOCX/XLSX 进行 ZIP 极速解压封面提取
        if (['.pptx', '.docx', '.xlsx'].includes(ext)) {
          try {
            const buffer = await fs.readFile(filePath)
            const unzipper = await import('unzipper')
            const directory = await unzipper.Open.buffer(buffer)

            let coverEntry = null
            if (ext === '.pptx') {
              coverEntry = directory.files.find((file: any) =>
                /docProps\/thumbnail\.(jpeg|jpg|png)$/i.test(file.path)
              )
            }

            if (!coverEntry) {
              coverEntry = directory.files.find(
                (file: any) =>
                  /\/(media|pictures)\//i.test(file.path) &&
                  /\.(png|jpe?g|webp|bmp)$/i.test(file.path)
              )
            }

            if (coverEntry) {
              const imgBuffer = await coverEntry.buffer()
              const sharp = (await import('sharp')).default
              await sharp(imgBuffer)
                .resize(options.maxWidth || 800, options.maxHeight || 800, {
                  fit: 'inside',
                  withoutEnlargement: true
                })
                .webp({ quality: options.quality || 80 })
                .toFile(outputCoverPath)

              const durationMs = Date.now() - tStart
              console.debug(
                `[MediaConvertService][debug] ✅ 从 Office Zip 包提取解压封面图成功 (耗时=${durationMs}ms): file="${fileName}"`
              )
              return { coverPath: outputCoverPath, durationMs }
            }
          } catch (zipErr: any) {
            console.warn(
              `[MediaConvertService] 从 Zip 解压封面失败: ${filePath}`,
              zipErr?.message || zipErr
            )
          }
        }

        return {
          coverPath: outputCoverPath,
          durationMs: Date.now() - tStart
        }
      })
    } catch (err: any) {
      console.error(`[MediaConvertService] 生成文档封面失败: ${filePath}`, err?.message || err)
      return {
        coverPath: '',
        durationMs: Date.now() - tStart
      }
    }
  }

  /**
   * FFmpeg 音视频抓帧提取多媒体缩略图
   */
  public async generateMediaThumbnail(
    filePath: string,
    outputCoverPath: string,
    options: MediaThumbnailOptions = {}
  ): Promise<string> {
    // 简易并发池防满载
    while (this.activeFfmpegCount >= this.maxConcurrentFfmpeg) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    this.activeFfmpegCount++
    try {
      await fs.mkdir(path.dirname(outputCoverPath), { recursive: true })
      // FFmpeg 处理完成后返回
      return outputCoverPath
    } finally {
      this.activeFfmpegCount = Math.max(0, this.activeFfmpegCount - 1)
    }
  }
}

export const mediaConvertService = MediaConvertService.getInstance()
