/**
 * Magika Service - AI 驱动的文件类型检测服务
 * 基于 Google Magika (magika-cli) 实现高精度文件识别
 */

import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { LogCategory, logger } from '@firefly/shared'
import { MagikaOutput, FileCategory } from '@firefly/types'

export class MagikaService {
  private static instance: MagikaService

  private constructor() {}

  public static getInstance(): MagikaService {
    if (!MagikaService.instance) {
      MagikaService.instance = new MagikaService()
    }
    return MagikaService.instance
  }

  /**
   * 确保 Magika 二进制文件已部署到 userData 目录 (仅限开发环境)
   */
  public async ensureMagikaDeployed(): Promise<void> {
    if (app.isPackaged) return

    const isWin = process.platform === 'win32'
    const executable = isWin ? 'magika.exe' : 'magika'
    const destPath = path.join(app.getPath('userData'), 'bin', executable)

    if (fs.existsSync(destPath)) {
      return
    }

    const sourcePath = this.resolveMagikaBinaryPath()
    if (sourcePath && fs.existsSync(sourcePath)) {
      try {
        logger.debug(
          LogCategory.SYSTEM,
          `[Magika] 正在将 Magika 从 ${sourcePath} 部署到 ${destPath}...`
        )
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(sourcePath, destPath)
        if (process.platform !== 'win32') {
          fs.chmodSync(destPath, 0o755)
        }
        logger.debug(LogCategory.SYSTEM, '[Magika] Magika 部署至 userData 目录成功')
      } catch (err) {
        logger.error(LogCategory.SYSTEM, '[Magika] 部署 Magika 到 userData 目录失败:', err)
      }
    } else {
      logger.error(LogCategory.SYSTEM, `[Magika] 未找到 Magika 源文件，跳过 userData 部署`)
    }
  }

  /**
   * 递归搜索可执行文件 (针对 .tar.xz 解压后的嵌套结构)
   */
  private findExecutableRecursively(dir: string, executable: string): string | null {
    if (!fs.existsSync(dir)) return null

    const items = fs.readdirSync(dir, { withFileTypes: true })

    // 优先在当前层级查找
    for (const item of items) {
      if (!item.isDirectory() && item.name === executable) {
        return path.join(dir, item.name)
      }
    }

    // 递归子目录
    for (const item of items) {
      if (item.isDirectory()) {
        const found = this.findExecutableRecursively(path.join(dir, item.name), executable)
        if (found) return found
      }
    }

    return null
  }

  /**
   * 获取真实的硬件架构 (处理 macOS Rosetta 2 情况)
   */
  private getRealArch(): string {
    const arch = process.arch
    if (process.platform === 'darwin' && arch === 'x64') {
      try {
        const isArm =
          child_process.execSync('sysctl -n hw.optional.arm64', { encoding: 'utf-8' }).trim() ===
          '1'
        if (isArm) return 'arm64'
      } catch (e) {
        // 忽略错误
      }
    }
    return arch
  }

  /**
   * 解析 Magika 二进制文件路径
   */
  private resolveMagikaBinaryPath(): string | null {
    const executable = process.platform === 'win32' ? 'magika.exe' : 'magika'
    const platform = process.platform
    const arch = this.getRealArch()
    const prefix = 'magika-bin-'

    logger.debug(
      LogCategory.SYSTEM,
      `[Magika] 路径解析: platform=${platform}, arch=${arch}, cwd=${process.cwd()}, isPackaged=${app.isPackaged}`
    )

    const getMatchedSubDir = (binDir: string) => {
      if (!fs.existsSync(binDir)) {
        logger.warn(LogCategory.SYSTEM, `[Magika] bin目录不存在: ${binDir}`)
        return null
      }
      const subDirs = fs.readdirSync(binDir)
      logger.debug(LogCategory.SYSTEM, `[Magika] bin目录内容: ${JSON.stringify(subDirs)}`)
      const currentArch = arch === 'x64' ? 'x64' : 'arm64'

      const matched = subDirs.find(d => {
        if (!d.toLowerCase().startsWith(prefix)) return false

        let platMatch = false
        if (platform === 'win32' && (d.includes('win32') || d.includes('win'))) platMatch = true
        if (
          platform === 'darwin' &&
          (d.includes('darwin') || d.includes('macos') || d.includes('mac'))
        )
          platMatch = true
        if (platform === 'linux' && (d.includes('linux') || d.includes('ubuntu'))) platMatch = true
        if (!platMatch) return false

        let archMatch = false
        if (currentArch === 'arm64' && (d.includes('arm64') || d.includes('aarch64')))
          archMatch = true
        if (
          currentArch === 'x64' &&
          (d.includes('x64') || d.includes('amd64') || d.includes('x86_64'))
        )
          archMatch = true

        return archMatch
      })
      logger.debug(LogCategory.SYSTEM, `[Magika] 匹配到子目录: ${matched || '(无)'}`)
      return matched || null
    }

    // 1. 生产环境 (resources/bin)
    if (app.isPackaged) {
      const binDir = path.join(process.resourcesPath, 'bin')
      logger.debug(LogCategory.SYSTEM, `[Magika] 尝试生产路径: ${binDir}`)
      const matchedSubDir = getMatchedSubDir(binDir)
      if (matchedSubDir) {
        const execPath = this.findExecutableRecursively(
          path.join(binDir, matchedSubDir),
          executable
        )
        logger.debug(LogCategory.SYSTEM, `[Magika] 生产路径结果: ${execPath || '(未找到)'}`)
        if (execPath) return execPath
      }
    }

    // 2. 开发环境：从 __dirname 向上查找 monorepo 根目录（包含 pnpm-workspace.yaml）
    let monorepoRoot = path.resolve(__dirname)
    while (monorepoRoot !== path.dirname(monorepoRoot)) {
      if (fs.existsSync(path.join(monorepoRoot, 'pnpm-workspace.yaml'))) break
      monorepoRoot = path.dirname(monorepoRoot)
    }
    const devBinDir = path.join(monorepoRoot, 'apps/desktop/build/extraResources/bin')
    logger.debug(LogCategory.SYSTEM, `[Magika] 尝试开发路径: ${devBinDir}`)
    const matchedDevSubDir = getMatchedSubDir(devBinDir)
    if (matchedDevSubDir) {
      const execPath = this.findExecutableRecursively(
        path.join(devBinDir, matchedDevSubDir),
        executable
      )
      logger.debug(LogCategory.SYSTEM, `[Magika] 开发路径结果: ${execPath || '(未找到)'}`)
      if (execPath) return execPath
    }

    // 3. userData/bin fallback
    const userDataBin = path.join(app.getPath('userData'), 'bin', executable)
    logger.debug(
      LogCategory.SYSTEM,
      `[Magika] 尝试userData路径: ${userDataBin}, 存在=${fs.existsSync(userDataBin)}`
    )
    if (fs.existsSync(userDataBin)) {
      return userDataBin
    }

    logger.warn(LogCategory.SYSTEM, `[Magika] 所有路径均未找到二进制文件`)
    return null
  }

  /**
   * 检测文件类型
   */
  public async identifyFile(filePath: string): Promise<FileCategory> {
    const magikaPath = this.resolveMagikaBinaryPath()

    if (!magikaPath) {
      logger.warn(LogCategory.SYSTEM, '[Magika] 未找到二进制文件，使用扩展名兜底', { filePath })
      return this.getMockCategory(filePath)
    }

    logger.debug(LogCategory.SYSTEM, `[Magika] 开始识别: ${filePath}, 二进制路径: ${magikaPath}`)

    try {
      const output = await this.runMagika([filePath, '--json'])
      logger.debug(LogCategory.SYSTEM, `[Magika] 原始输出:`, {
        output: JSON.stringify(output).slice(0, 500)
      })
      if (output && output.length > 0) {
        const result = output[0].result
        if (result && result.status === 'ok') {
          const finalOutput = result.value.output
          const category: FileCategory = {
            description: finalOutput.description,
            extensions: finalOutput.extensions,
            group: finalOutput.group,
            is_text: finalOutput.is_text,
            label: finalOutput.label,
            mime_type: finalOutput.mime_type,
            score: result.value.score
          }
          logger.debug(LogCategory.SYSTEM, `[Magika] 识别结果:`, {
            label: category.label,
            extensions: category.extensions,
            mime_type: category.mime_type
          })
          return category
        } else {
          logger.warn(LogCategory.SYSTEM, `[Magika] 识别状态异常:`, {
            status: result?.status,
            filePath
          })
        }
      } else {
        logger.warn(LogCategory.SYSTEM, `[Magika] 输出为空`, { filePath })
      }
    } catch (err) {
      logger.error(LogCategory.SYSTEM, `[Magika] 执行识别失败: ${filePath}`, err)
    }

    logger.debug(LogCategory.SYSTEM, `[Magika] 使用扩展名兜底: ${filePath}`)
    return this.getMockCategory(filePath)
  }

  /**
   * 批量检测文件类型
   */
  public async identifyFiles(filePaths: string[]): Promise<Map<string, FileCategory>> {
    const results = new Map<string, FileCategory>()
    const magikaPath = this.resolveMagikaBinaryPath()

    if (!magikaPath) {
      for (const p of filePaths) {
        results.set(p, this.getMockCategory(p))
      }
      return results
    }

    try {
      // 批量调用 magika
      const outputs = await this.runMagika([...filePaths, '--json'])
      if (outputs) {
        for (const out of outputs) {
          if (out.result.status === 'ok') {
            const finalOutput = out.result.value.output
            results.set(out.path, {
              description: finalOutput.description,
              extensions: finalOutput.extensions,
              group: finalOutput.group,
              is_text: finalOutput.is_text,
              label: finalOutput.label,
              mime_type: finalOutput.mime_type,
              score: out.result.value.score
            })
          } else {
            results.set(out.path, this.getMockCategory(out.path))
          }
        }
      }
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[Magika] 批量识别失败:', err)
      for (const p of filePaths) {
        if (!results.has(p)) results.set(p, this.getMockCategory(p))
      }
    }

    return results
  }

  /**
   * 执行 Magika 命令
   */
  private async runMagika(args: string[]): Promise<MagikaOutput[] | null> {
    const magikaPath = this.resolveMagikaBinaryPath()
    if (!magikaPath) return null

    return new Promise((resolve, reject) => {
      logger.debug(LogCategory.SYSTEM, `[Magika] 执行命令: ${magikaPath} ${args.join(' ')}`)
      child_process.execFile(
        magikaPath,
        args,
        { maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            logger.error(LogCategory.SYSTEM, `[Magika] 进程错误:`, {
              code: error.code,
              signal: error.signal,
              message: error.message,
              stderr: stderr?.slice(0, 500)
            })
            reject(error)
            return
          }
          if (stderr) {
            logger.warn(LogCategory.SYSTEM, `[Magika] stderr:`, { stderr: stderr.slice(0, 300) })
          }
          try {
            const parsed = JSON.parse(stdout)
            resolve(Array.isArray(parsed) ? parsed : [parsed])
          } catch (parseErr) {
            logger.error(LogCategory.SYSTEM, `[Magika] JSON解析失败:`, {
              stdout: stdout.slice(0, 500)
            })
            reject(new Error(`Failed to parse Magika output: ${stdout}`))
          }
        }
      )
    })
  }

  /**
   * 根据扩展名构造 Mock 返回 (兜底方案)
   */
  private getMockCategory(filePath: string): FileCategory {
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    logger.debug(
      LogCategory.SYSTEM,
      `[Magika] getMockCategory 兜底: ${filePath}, 扩展名: ${ext || '(无)'}`
    )
    return {
      description: '',
      extensions: [ext],
      group: '',
      is_text: true,
      label: '',
      mime_type: '',
      score: 0
    }
  }
}

export const magikaService = MagikaService.getInstance()
