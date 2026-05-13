import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import fixPath from 'fix-path'
import { logger, LogCategory } from '@yonuc/shared'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { t } from '@app/languages'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in LibreOfficeDetector:', e);
  }
}

const execAsync = promisify(exec)

export interface LibreOfficeDetectionResult {
  installed: boolean
  version?: string
  path?: string
  error?: string
}

/**
 * LibreOffice检测器类
 */
export class LibreOfficeDetector {
  /**
   * 检测LibreOffice是否已安装
   */
  async detectLibreOffice(): Promise<LibreOfficeDetectionResult> {
    try {
      logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 开始检测系统LibreOffice安装状态')

      // 根据不同平台使用不同的检测方法
      switch (process.platform) {
        case 'win32':
          return await this.detectLibreOfficeWindows()
        case 'darwin':
          return await this.detectLibreOfficeMacOS()
        case 'linux':
          return await this.detectLibreOfficeLinux()
        default:
          return {
            installed: false,
            error: t('不支持的操作系统平台: {platform}', { platform: process.platform })
          }
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 检测过程发生异常:', error)
      return {
        installed: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Windows平台检测
   */
  private async detectLibreOfficeWindows(): Promise<LibreOfficeDetectionResult> {
    try {
      let libreOfficePath: string | undefined;

      // 方法1：通过注册表查询安装路径
      const regKeys = [
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\LibreOffice\\UNO',
        'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\LibreOffice\\UNO',
        'HKEY_CURRENT_USER\\SOFTWARE\\LibreOffice\\UNO'
      ]

      for (const key of regKeys) {
        if (libreOfficePath) break;
        try {
          const { stdout } = await execAsync(`reg query "${key}" /v "InstallPath"`, { timeout: 5000 })
          if (stdout) {
            const match = stdout.match(/InstallPath\s+REG_SZ\s+(.*)/i)
            if (match && match[1]) {
              const installDir = match[1].trim()
              const sofficePath = path.join(installDir, 'program', 'soffice.exe')
              if (await this.checkFileExists(sofficePath)) {
                libreOfficePath = sofficePath
                break
              }
            }
          }
        } catch (regError) {
          // 忽略失败，尝试下一个注册表键
        }
      }

      // 方法2：检查常见安装路径
      if (!libreOfficePath) {
        const commonPaths = [
          'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
          'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        ]

        for (const filePath of commonPaths) {
          if (await this.checkFileExists(filePath)) {
            libreOfficePath = filePath
            break
          }
        }
      }

      // 方法3：检查 PATH 中是否存在
      if (!libreOfficePath) {
        try {
          const { stdout } = await execAsync('where soffice', { timeout: 2000 })
          const sofficePaths = stdout.trim().split(/\r?\n/).map(p => p.trim()).filter(p => p.length > 0)
          
          // 优先寻找 .exe 结尾的路径（清理可能存在的异常空格，如 . exe）
          for (const rawPath of sofficePaths) {
            const p = rawPath.replace(/\.\s+exe$/i, '.exe').replace(/\.\s+com$/i, '.com')
            if (p.toLowerCase().endsWith('.exe') && await this.checkFileExists(p)) {
              libreOfficePath = p
              break
            }
          }

          // 如果没有 .exe，使用列表中第一个有效路径
          if (!libreOfficePath) {
            for (const rawPath of sofficePaths) {
              const p = rawPath.replace(/\.\s+exe$/i, '.exe').replace(/\.\s+com$/i, '.com')
              if (await this.checkFileExists(p)) {
                libreOfficePath = p
                break
              }
            }
          }
        } catch (whereError) {
          // ignore
        }
      }

      // 如果找到了路径，则保存到系统设置中
      if (libreOfficePath) {
        // 保存路径到系统设置
        ConfigOrchestrator.getInstance().updateValue('LIBREOFFICE_PATH', libreOfficePath)
        logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 已保存路径到系统设置:', libreOfficePath)
        
        return {
          installed: true,
          path: libreOfficePath
        }
      }

      logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] Windows平台未检测到LibreOffice')
      return {
        installed: false,
        error: t('未检测到 LibreOffice，请将其安装到默认路径或确保其在系统 PATH 中')
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] Windows检测异常:', error)
      return {
        installed: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 检查文件是否存在
   */
  private async checkFileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * macOS平台检测
   */
  private async detectLibreOfficeMacOS(): Promise<LibreOfficeDetectionResult> {
    try {
      // 方法1：检查/Applications目录
      const appPath = '/Applications/LibreOffice.app'
      if (await this.checkFileExists(appPath)) {
        logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 在Applications找到LibreOffice')
        
        // 获取可执行文件路径
        const sofficePath = path.join(appPath, 'Contents/MacOS/soffice')
        if (await this.checkFileExists(sofficePath)) {
          // 保存路径到系统设置
          ConfigOrchestrator.getInstance().updateValue('LIBREOFFICE_PATH', sofficePath)
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 已保存路径到系统设置:', sofficePath)
          
          return {
            installed: true,
            path: sofficePath
          }
        }
      }

      // 方法2：通过命令行检测
      try {
        const { stdout } = await execAsync('which soffice', { timeout: 5000 })
        const sofficePath = stdout.trim()
        if (sofficePath) {
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] macOS命令行检测成功:', sofficePath)
          
          // 保存路径到系统设置
          ConfigOrchestrator.getInstance().updateValue('LIBREOFFICE_PATH', sofficePath)
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 已保存路径到系统设置:', sofficePath)
          
          return {
            installed: true,
            path: sofficePath
          }
        }
      } catch {
        // 命令行检测失败
      }

      logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] macOS平台未检测到LibreOffice')
      return { 
        installed: false,
        error: t('未检测到 LibreOffice，请将其安装到默认路径或确保其在系统 PATH 中')
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] macOS检测异常:', error)
      return {
        installed: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * Linux平台检测
   */
  private async detectLibreOfficeLinux(): Promise<LibreOfficeDetectionResult> {
    try {
      // 方法1：通过which命令检测
      try {
        const { stdout: whichOutput } = await execAsync('which soffice', { timeout: 5000 })
        const sofficePath = whichOutput.trim()
        
        if (sofficePath) {
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] Linux检测到soffice路径:', sofficePath)
          
          // 保存路径到系统设置
          ConfigOrchestrator.getInstance().updateValue('LIBREOFFICE_PATH', sofficePath)
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 已保存路径到系统设置:', sofficePath)
          
          return {
            installed: true,
            path: sofficePath
          }
        }
      } catch {
        // which命令失败
      }

      // 方法2：通过dpkg检测（Debian/Ubuntu）
      try {
        const { stdout } = await execAsync('dpkg -l | grep libreoffice', { timeout: 5000 })
        if (stdout.trim()) {
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 通过dpkg检测到LibreOffice')
          
          // 尝试获取路径
          try {
            const { stdout: whichOutput } = await execAsync('which libreoffice', { timeout: 5000 })
            const libreOfficePath = whichOutput.trim()
            if (libreOfficePath) {
              // 保存路径到系统设置
              ConfigOrchestrator.getInstance().updateValue('LIBREOFFICE_PATH', libreOfficePath)
              logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 已保存路径到系统设置:', libreOfficePath)
              
              return {
                installed: true,
                path: libreOfficePath
              }
            }
          } catch {
            // 获取路径失败
          }
          
          return {
            installed: true
          }
        }
      } catch {
        // dpkg检测失败
      }

      // 方法3：通过rpm检测（RedHat/Fedora）
      try {
        const { stdout } = await execAsync('rpm -qa | grep libreoffice', { timeout: 5000 })
        if (stdout.trim()) {
          logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 通过rpm检测到LibreOffice')
          
          // 尝试获取路径
          try {
            const { stdout: whichOutput } = await execAsync('which libreoffice', { timeout: 5000 })
            const libreOfficePath = whichOutput.trim()
            if (libreOfficePath) {
              // 保存路径到系统设置
              ConfigOrchestrator.getInstance().updateValue('LIBREOFFICE_PATH', libreOfficePath)
              logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] 已保存路径到系统设置:', libreOfficePath)
              
              return {
                installed: true,
                path: libreOfficePath
              }
            }
          } catch {
            // 获取路径失败
          }
          
          return {
            installed: true
          }
        }
      } catch {
        // rpm检测失败
      }

      logger.info(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] Linux平台未检测到LibreOffice')
      return { 
        installed: false,
        error: t('未检测到 LibreOffice，请将其安装到默认路径或确保其在系统 PATH 中')
      }
    } catch (error) {
      logger.error(LogCategory.FILE_PROCESSOR, '[LibreOffice检测] Linux检测异常:', error)
      return {
        installed: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 从输出中提取版本号
   */
  private extractVersion(output: string): string | undefined {
    // LibreOffice版本格式：LibreOffice 7.6.4.1 40(Build:1)
    const versionMatch = output.match(/LibreOffice\s+([\d.]+)/i)
    if (versionMatch && versionMatch[1]) {
      return versionMatch[1]
    }

    // 尝试匹配纯数字版本号
    const numericMatch = output.match(/([\d.]+)/)
    if (numericMatch && numericMatch[1]) {
      return numericMatch[1]
    }

    return undefined
  }
}

// 导出单例
export const libreOfficeDetector = new LibreOfficeDetector()
