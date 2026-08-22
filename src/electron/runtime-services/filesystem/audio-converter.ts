import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execFile } from 'child_process'
import fixPath from 'fix-path'
import { t } from '@app/languages'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in AudioConverter:', e)
  }
}
import * as crypto from 'crypto'
import { logger, LogCategory } from '@firefly/shared'
import { ffmpegService } from '../system/ffmpeg-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

/**
 * 音频转换工具
 * 负责将各种格式的音频转换为 AI 专用的标准格式
 */
export class AudioConverter {
  private static instance: AudioConverter | null = null
  private tempDir: string

  private constructor() {
    this.tempDir = path.join(app.getPath('temp'), 'firefly-ai-audio-cache')
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }
  }

  static getInstance(): AudioConverter {
    if (!AudioConverter.instance) {
      AudioConverter.instance = new AudioConverter()
    }
    return AudioConverter.instance
  }

  /**
   * 转换为标准 AI 音频格式 (16kHz, mono, pcm_s16le WAV)
   * 限制输出时长以避免 AI 上下文超限
   * @param inputPath 输入文件路径
   * @returns 转换后的文件路径
   */
  async convertToStandard(inputPath: string): Promise<string> {
    const ffmpegPath = ffmpegService.getFfmpegPath()
    if (!ffmpegPath) {
      throw new Error(t('FFmpeg 未就绪（未检测到系统 FFmpeg），无法转换音频'))
    }

    // 从配置中获取截取时长，默认为 30 秒
    const DURATION_LIMIT =
      ConfigOrchestrator.getInstance().getValue<number>('AUDIO_ANALYSIS_DURATION') || 30

    // 1. 生成基于路径和截断参数的哈希文件名
    const hash = crypto
      .createHash('md5')
      .update(inputPath)
      .update(`duration_${DURATION_LIMIT}`) // 如果未来调整了限制，将生成新缓存
      .digest('hex')
    const outputPath = path.join(this.tempDir, `${hash}.wav`)

    // 2. 如果文件已存在，直接复用
    if (fs.existsSync(outputPath)) {
      logger.debug(LogCategory.FILE_PROCESSOR, `[AudioConverter] 复用已有的转换文件: ${outputPath}`)
      return outputPath
    }

    // 3. 执行转换
    // -t 参数限制输出时长，从而控制文件大小
    return new Promise((resolve, reject) => {
      const args = [
        '-i',
        inputPath,
        '-t',
        DURATION_LIMIT.toString(),
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-y',
        outputPath
      ]

      logger.info(
        LogCategory.FILE_PROCESSOR,
        `[AudioConverter] 开始转换音频(截断时长 ${DURATION_LIMIT}s): ${inputPath} -> ${outputPath}`
      )

      execFile(ffmpegPath, args, (error, stdout, stderr) => {
        if (error) {
          logger.error(
            LogCategory.FILE_PROCESSOR,
            `[AudioConverter] 转换音频失败: ${error.message}`,
            { stderr }
          )
          reject(new Error(`音频转换失败: ${error.message}`))
          return
        }

        if (fs.existsSync(outputPath)) {
          logger.info(LogCategory.FILE_PROCESSOR, `[AudioConverter] 音频转换成功: ${outputPath}`)
          resolve(outputPath)
        } else {
          reject(new Error('音频转换成功但未找到输出文件'))
        }
      })
    })
  }

  /**
   * 清理缓存目录
   */
  clearCache(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir)
        for (const file of files) {
          fs.unlinkSync(path.join(this.tempDir, file))
        }
        logger.info(LogCategory.FILE_PROCESSOR, '[AudioConverter] 音频缓存已清理')
      }
    } catch (e) {
      logger.error(LogCategory.FILE_PROCESSOR, '[AudioConverter] 清理缓存失败:', e)
    }
  }
}

export const audioConverter = AudioConverter.getInstance()
