import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import * as path from 'path'
import { LogCategory, logger, getExifToolPath } from '@firefly/shared'
import { existsAsync, readdirTyped, safeUnlink, statOrNull } from '../../../infra/fs'

export interface SpawnAsyncResult {
  status: number | null
  error: Error | null
}

/**
 * 异步执行外部命令（替代 spawnSync，保持原退出码与错误处理语义）
 */
export async function spawnAsync(
  command: string,
  args: readonly string[],
  options?: { windowsHide?: boolean; timeoutMs?: number }
): Promise<SpawnAsyncResult> {
  return await new Promise<SpawnAsyncResult>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: SpawnAsyncResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        windowsHide: options?.windowsHide ?? true,
        stdio: 'ignore'
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      logger.warn(LogCategory.FILE_ORGANIZATION, `[spawnAsync] 启动外部程序失败 [${command}]:`, error)
      finish({ status: null, error })
      return
    }

    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        const timeoutErr = new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`)
        logger.warn(LogCategory.FILE_ORGANIZATION, `[spawnAsync] 外部程序超时 [${command}]:`, timeoutErr)
        finish({ status: null, error: timeoutErr })
      }, options.timeoutMs)
    }

    child.once('error', err => {
      logger.warn(LogCategory.FILE_ORGANIZATION, `[spawnAsync] 外部程序执行异常 [${command}]:`, err)
      finish({ status: null, error: err })
    })

    child.once('close', code => {
      finish({ status: code, error: null })
    })
  })
}

/**
 * 辅助工具：快速原子移动文件 (同卷优先 rename，跨卷降级 copyFile + unlink)
 */
export async function moveFileAtomically(src: string, dest: string): Promise<void> {
  try {
    await safeUnlink(dest)
  } catch {}
  try {
    await fsp.rename(src, dest)
  } catch {
    await fsp.copyFile(src, dest)
    try {
      await safeUnlink(src)
    } catch {}
  }
}

/**
 * 通过文件头魔数嗅探真实扩展名（使用 FileHandle.read，用后立即 close 确保句柄零泄漏）
 */
export async function detectExtensionFromMagicBytes(filePath: string): Promise<string> {
  let properExt = ''
  const buffer = Buffer.alloc(32)
  const handle = await fsp.open(filePath, 'r')
  try {
    await handle.read(buffer, 0, 32, 0)
  } finally {
    await handle.close()
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) properExt = '.jpg'
  else if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  )
    properExt = '.png'
  else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) properExt = '.gif'
  else if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  )
    properExt = '.pdf'
  else if (buffer[0] === 0x50 && buffer[1] === 0x4b) properExt = '.zip'
  else if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  )
    properExt = '.webp'

  return properExt
}

/**
 * 清理单个图片文件的 Exif 隐私信息，生成副本到 outFilePath
 */
export async function cleanExifForFile(
  filePath: string,
  outFilePath: string,
  omniApiUrl: string
): Promise<boolean> {
  let cleanExifSucceeded = false

  // 核心方案：高保真/无损 Exif 隐私清除策略
  // 1. 若图片存在非正向 Orientation（例如手机/相机拍摄的竖图，Orientation = 6 / 8 / 3 等），
  //    必须先物理旋转像素至正向，再剥离元数据，否则剔除 Exif 后看图软件会倒转；
  // 2. 若图片无需物理旋转（Orientation = 1 或普通横图），优先采用 ExifTool 进行 100% 原始字节无损剔除（不重编码像素，0 画质损失，文件体积绝不膨胀）；
  // 3. 若使用 Sharp 重新输出，自适应合理参数，避免 quality 95 导致原低质图片体积反而膨胀。
  try {
    const sharpModule = require('sharp')
    const ext = path.extname(filePath).toLowerCase()

    // 探测内置 ExifTool 二进制：统一走 @firefly/shared 的 ResourceLocator，
    // 唯一权威来源是 extraResources/bin/exiftool（安装包内置），
    // 严禁回锚 node_modules/exiftool-vendored.exe 副本（打包体积黑洞，运行时不保证存在）
    const findExifTool = () => getExifToolPath()

    const meta = await sharpModule(filePath)
      .metadata()
      .catch(() => null)
    const needsRotation = meta?.orientation && meta.orientation > 1

    if (!needsRotation) {
      // 方案 A（无损优先）：图片本就是正向朝向，无需像素重编码。使用 ExifTool 直接剔除元数据
      const exifToolPath = findExifTool()
      if (exifToolPath) {
        try {
          await safeUnlink(outFilePath)
        } catch {}
        await fsp.copyFile(filePath, outFilePath)
        // windowsHide: exiftool 为控制台程序，逐文件调用时缺省会反复闪出控制台窗口
        const res = await spawnAsync(exifToolPath, ['-all=', '-overwrite_original', outFilePath], {
          windowsHide: true
        })
        if (res.status === 0 && (await existsAsync(outFilePath))) {
          cleanExifSucceeded = true
        }
      }
    }

    // 方案 B：需要物理正向旋转，或 ExifTool 未就绪时，使用 Sharp 物理校正 + 完全清空元数据
    if (!cleanExifSucceeded) {
      const pipeline = sharpModule(filePath).rotate() // 物理正向校准像素，不调用 withMetadata() 从而丢弃所有元数据

      let cleanBuffer: Buffer
      if (ext === '.jpg' || ext === '.jpeg') {
        // 使用 mozjpeg 智能压缩，既保障肉眼无损画质，又防止体积比原图膨胀
        cleanBuffer = await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
      } else if (ext === '.png') {
        cleanBuffer = await pipeline.png({ compressionLevel: 9 }).toBuffer()
      } else if (ext === '.webp') {
        cleanBuffer = await pipeline.webp({ quality: 90, effort: 6 }).toBuffer()
      } else {
        cleanBuffer = await pipeline.toBuffer()
      }

      try {
        await safeUnlink(outFilePath)
      } catch {}
      await fsp.writeFile(outFilePath, cleanBuffer)
      cleanExifSucceeded = true
    }
  } catch (sharpErr: any) {
    logger.warn(
      LogCategory.FILE_ORGANIZATION,
      `本地物理校正与擦除 Exif 异常 [${filePath}], 尝试降级至 Omni:`,
      sharpErr
    )
    // 降级调用 Omni 服务
    try {
      const resp = await fetch(`${omniApiUrl}/api/cleanup/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clean_exif', paths: [filePath] }),
        signal: AbortSignal.timeout(15000)
      })
      if (resp.ok) {
        const fixRes = (await resp.json()) as any
        if (fixRes.success_count > 0) {
          const srcDir = path.dirname(filePath)
          const ext = path.extname(filePath)
          const stem = path.basename(filePath, ext)
          const cleanedCandidates = [
            path.join(srcDir, `${stem}.czkawka_cleaned_exif${ext}`),
            path.join(srcDir, `${stem.toLowerCase()}.czkawka_cleaned_exif${ext.toLowerCase()}`),
            path.join(srcDir, `${stem.toUpperCase()}.czkawka_cleaned_exif${ext.toUpperCase()}`)
          ]
          for (const cand of cleanedCandidates) {
            if (await existsAsync(cand)) {
              try {
                await safeUnlink(outFilePath)
              } catch {}
              await fsp.copyFile(cand, outFilePath)
              try {
                await safeUnlink(cand)
              } catch {}
              cleanExifSucceeded = true
              break
            }
          }
        }
      }
    } catch {}
  }

  return cleanExifSucceeded
}

/**
 * 调用 Omni Czkawka 引擎服务执行视频转码优化
 */
export async function optimizeVideoForFile(
  filePath: string,
  outDir: string,
  omniApiUrl: string
): Promise<{ omniTranscoded: boolean; finalTranscodedPath: string; failMessage: string }> {
  let omniTranscoded = false
  let finalTranscodedPath = ''
  let failMessage = ''

  const ext = path.extname(filePath)
  const stem = path.basename(filePath, ext)
  const originalFileName = path.basename(filePath)

  // 步骤 1：直接调用 Omni Czkawka 引擎服务执行视频转码
  logger.debug(LogCategory.FILE_ORGANIZATION, `[视频优化] 向 Omni 发起转码请求: ${filePath}`)
  try {
    const resp = await fetch(`${omniApiUrl}/api/cleanup/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'optimize', paths: [filePath] }),
      signal: AbortSignal.timeout(600000)
    })
    if (resp.ok) {
      const fixRes = (await resp.json()) as any
      logger.debug(LogCategory.FILE_ORGANIZATION, `[视频优化] Omni 转码返回结果:`, fixRes)
      if (fixRes.success_count > 0) {
        // czkawka 在 overwrite_original = false 时，生成的优化视频位于同目录，名为 *.czkawka_optimized.mp4
        const srcDir = path.dirname(filePath)
        const optimizedCandidate = path.join(srcDir, `${stem}.czkawka_optimized.mp4`)
        const actualOutFile = path.join(outDir, `${stem}.mp4`)

        const optStat = await statOrNull(optimizedCandidate)
        if (optStat && optStat.size > 0) {
          await moveFileAtomically(optimizedCandidate, actualOutFile)
          finalTranscodedPath = actualOutFile
          omniTranscoded = true
          logger.debug(
            LogCategory.FILE_ORGANIZATION,
            `[视频优化] 捕获并移动优化视频成功: ${actualOutFile}`
          )
        } else {
          // 尝试扫描同目录下以 stem 开头且不为原文件的生成文件
          const entries = await readdirTyped(srcDir)
          const candNames = entries
            .map(e => e.name)
            .filter(name => name.startsWith(stem) && name !== originalFileName)
          for (const candName of candNames) {
            const candFull = path.join(srcDir, candName)
            const candStat = await statOrNull(candFull)
            if (candStat && candStat.isFile()) {
              const candExt = path.extname(candName) || '.mp4'
              const targetOut = path.join(outDir, `${stem}${candExt}`)
              await moveFileAtomically(candFull, targetOut)
              finalTranscodedPath = targetOut
              omniTranscoded = true
              logger.debug(
                LogCategory.FILE_ORGANIZATION,
                `[视频优化] 捕获候选转码文件成功: ${targetOut}`
              )
              break
            }
          }
        }
      } else if (fixRes.errors && fixRes.errors.length > 0) {
        failMessage = fixRes.errors.join('; ')
        logger.warn(LogCategory.FILE_ORGANIZATION, `[视频优化] Omni 转码返回错误: ${failMessage}`)
      }
    } else {
      logger.warn(
        LogCategory.FILE_ORGANIZATION,
        `[视频优化] Omni 转码 HTTP 请求失败: status=${resp.status}`
      )
      failMessage = `Omni 服务响应异常 (HTTP ${resp.status})`
    }
  } catch (e: any) {
    logger.warn(
      LogCategory.FILE_ORGANIZATION,
      `[视频优化] Omni 视频转码接口调用异常 [${filePath}]:`,
      e
    )
    failMessage = e?.message || '请求 Omni 视频转码服务超时或失败'
  }

  return { omniTranscoded, finalTranscodedPath, failMessage }
}
