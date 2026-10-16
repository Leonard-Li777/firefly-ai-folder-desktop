/**
 * 外部播放器/阅读器时间戳深链调度器（External App Launcher）
 * apps/desktop/src/electron/runtime-services/system/external-app-launcher.ts
 *
 * 依据 Spec §3.1 / §4.1 实现：
 * 1. 外部应用探测与参数矩阵（PotPlayer, VLC, mpv, MPC-HC, SumatraPDF, Edge, Chrome, Acrobat, VS Code, Cursor）
 * 2. 安全防注入机制：shell: false 强制设定、参数数组传递、Node.js 原生 pathToFileURL 构造
 * 3. 异步错误捕获与进程解引用：child.on('error') 监听 + child.unref() + 降级 shell.openPath
 */

import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { shell } from 'electron'
import type { FileCategory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'

export type ExternalAppKind =
  | 'potplayer'
  | 'vlc'
  | 'mpv'
  | 'mpc_hc'
  | 'iina'
  | 'sumatrapdf'
  | 'edge'
  | 'chrome'
  | 'acrobat'
  | 'vscode'
  | 'cursor'
  | 'system_default'

export interface DeepLinkTargetPayload {
  /** 本地绝对文件路径 (必须校验存在) */
  filePath: string
  /** 权威分类枚举 (复用 @firefly/types)、扩展分类字符串或分类对象 */
  category?: FileCategory | string | { label?: string } | null
  /** 视频/音频跳转目标秒数 */
  seekSeconds?: number
  /** PDF 跳转目标页码 (从 1 开始) */
  pageNumber?: number
  /** 代码文件跳转目标行号 (从 1 开始) */
  lineNumber?: number
}

export interface LaunchOutcome {
  success: boolean
  appUsed: ExternalAppKind
  commandExecuted?: string
  fallbackToDefault: boolean
  error?: string
}

export interface ResolvedAppCommand {
  kind: ExternalAppKind
  exe: string
  args: string[]
}

export interface ExternalAppLauncherOptions {
  spawn?: typeof spawn
  openPath?: (targetPath: string) => Promise<string>
  fileExists?: (targetPath: string) => boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * 将浮点秒数格式化为 HH:MM:SS 格式（供 PotPlayer 与 MPC-HC 使用）
 */
export function formatHms(seconds: number): string {
  const safeSec = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(safeSec / 3600)
  const m = Math.floor((safeSec % 3600) / 60)
  const s = safeSec % 60
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':')
}

export class ExternalAppLauncher {
  private readonly spawnFn: typeof spawn
  private readonly openPathFn: (targetPath: string) => Promise<string>
  private readonly fileExistsFn: (targetPath: string) => boolean
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv

  constructor(options?: ExternalAppLauncherOptions) {
    this.spawnFn = options?.spawn ?? spawn
    this.openPathFn = options?.openPath ?? (async (p: string) => shell.openPath(p))
    this.fileExistsFn = options?.fileExists ?? fs.existsSync
    this.platform = options?.platform ?? process.platform
    this.env = options?.env ?? process.env
  }

  /**
   * 唤起外部应用并跳转到指定时间戳、页码或行号
   */
  async launch(payload: DeepLinkTargetPayload): Promise<LaunchOutcome> {
    const { filePath, category, seekSeconds, pageNumber, lineNumber } = payload

    if (!filePath || !path.isAbsolute(filePath) || !this.fileExistsFn(filePath)) {
      return {
        success: false,
        appUsed: 'system_default',
        fallbackToDefault: false,
        error: `File does not exist or invalid path: ${filePath}`
      }
    }

    const appCommand = this.resolveAppCommand(category, filePath, {
      seekSeconds,
      pageNumber,
      lineNumber
    })

    if (!appCommand) {
      logger.info(
        LogCategory.MAIN,
        `[ExternalAppLauncher] 未探测到支持精准跳转的外部程序，降级使用系统默认打开: ${filePath}`
      )
      const openResult = await this.openPathFn(filePath)
      return {
        success: !openResult,
        appUsed: 'system_default',
        fallbackToDefault: true,
        error: openResult || undefined
      }
    }

    try {
      const child = this.spawnFn(appCommand.exe, appCommand.args, {
        shell: false,
        detached: true,
        stdio: 'ignore'
      })

      child.on('error', (err: Error) => {
        logger.warn(
          LogCategory.MAIN,
          `[ExternalAppLauncher] 子进程唤起失败 (${appCommand.kind}): ${err.message}，降级调用 shell.openPath`
        )
        this.openPathFn(filePath).catch(e => {
          logger.error(LogCategory.MAIN, `[ExternalAppLauncher] 默认打开失败: ${e}`)
        })
      })

      child.unref()

      return {
        success: true,
        appUsed: appCommand.kind,
        commandExecuted: `${appCommand.exe} ${appCommand.args.join(' ')}`,
        fallbackToDefault: false
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.MAIN,
        `[ExternalAppLauncher] spawn 抛出异常 (${appCommand.kind}): ${msg}，降级为系统默认打开`
      )
      const openResult = await this.openPathFn(filePath)
      return {
        success: !openResult,
        appUsed: 'system_default',
        fallbackToDefault: true,
        error: msg
      }
    }
  }

  /**
   * 解析目标介质对应的最佳可用外部程序及其命令行参数
   */
  public resolveAppCommand(
    category: FileCategory | string | { label?: string } | unknown,
    filePath: string,
    targets: { seekSeconds?: number; pageNumber?: number; lineNumber?: number }
  ): ResolvedAppCommand | null {
    const isWin = this.platform === 'win32'
    const isMac = this.platform === 'darwin'

    const ext = path.extname(filePath).toLowerCase()
    let catStr = ''
    if (typeof category === 'string') {
      catStr = category.toLowerCase()
    } else if (category && typeof category === 'object' && 'label' in category) {
      catStr = String((category as { label?: unknown }).label ?? '').toLowerCase()
    } else if (category != null) {
      catStr = String(category).toLowerCase()
    }

    const isVideoOrAudio =
      catStr === 'video' ||
      catStr === 'audio' ||
      ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.mp3', '.flac', '.wav', '.m4a'].includes(ext)
    const isPdf = catStr === 'pdf' || catStr === 'document' || ext === '.pdf'
    const isCodeOrDoc =
      catStr === 'code' ||
      ['.ts', '.tsx', '.js', '.jsx', '.rs', '.py', '.go', '.java', '.c', '.cpp', '.h', '.json', '.md', '.txt', '.toml', '.yaml', '.yml'].includes(ext)

    if (isVideoOrAudio) {
      return this.resolveMediaCommand(filePath, targets.seekSeconds, isWin, isMac)
    }

    if (isPdf) {
      return this.resolvePdfCommand(filePath, targets.pageNumber, isWin, isMac)
    }

    if (isCodeOrDoc) {
      return this.resolveCodeCommand(filePath, targets.lineNumber, isWin, isMac)
    }

    return null
  }

  private resolveMediaCommand(
    filePath: string,
    seekSeconds: number | undefined,
    isWin: boolean,
    isMac: boolean
  ): ResolvedAppCommand | null {
    const hasSeek = seekSeconds !== undefined && Number.isFinite(seekSeconds) && seekSeconds >= 0
    const hms = hasSeek ? formatHms(seekSeconds!) : '00:00:00'
    const sec = hasSeek ? Math.floor(seekSeconds!) : 0

    if (isWin) {
      // 1. PotPlayer
      const potCandidates = [
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'DAUM', 'PotPlayer', 'PotPlayer64.exe'),
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'DAUM', 'PotPlayer', 'PotPlayerMini64.exe'),
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'DAUM', 'PotPlayer', 'PotPlayerMini64.exe'),
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'DAUM', 'PotPlayer', 'PotPlayer.exe'),
        path.join(this.env['LOCALAPPDATA'] || '', 'Programs', 'PotPlayer', 'PotPlayer64.exe')
      ]
      for (const cand of potCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'potplayer',
            exe: cand,
            args: hasSeek ? [filePath, `/seek=${hms}`] : [filePath]
          }
        }
      }

      // 2. VLC
      const vlcCandidates = [
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'VideoLAN', 'VLC', 'vlc.exe'),
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'VideoLAN', 'VLC', 'vlc.exe')
      ]
      for (const cand of vlcCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'vlc',
            exe: cand,
            args: hasSeek ? [`--start-time=${sec}`, filePath] : [filePath]
          }
        }
      }

      // 3. mpv
      const mpvCandidates = [
        path.join(this.env['LOCALAPPDATA'] || '', 'Programs', 'mpv', 'mpv.exe'),
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'mpv', 'mpv.exe')
      ]
      for (const cand of mpvCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'mpv',
            exe: cand,
            args: hasSeek ? [`--start=${sec}`, filePath] : [filePath]
          }
        }
      }

      // 4. MPC-HC
      const mpcCandidates = [
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'MPC-HC', 'mpc-hc64.exe'),
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'MPC-HC', 'mpc-hc.exe')
      ]
      for (const cand of mpcCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'mpc_hc',
            exe: cand,
            args: hasSeek ? [filePath, '/startpos', hms] : [filePath]
          }
        }
      }
    } else if (isMac) {
      if (this.fileExistsFn('/Applications/IINA.app')) {
        return {
          kind: 'iina',
          exe: '/usr/bin/open',
          args: hasSeek
            ? ['-b', 'com.colliderli.iina', '--args', `--mpv-start=${sec}`, filePath]
            : ['-b', 'com.colliderli.iina', filePath]
        }
      }
      if (this.fileExistsFn('/Applications/VLC.app')) {
        return {
          kind: 'vlc',
          exe: '/usr/bin/open',
          args: hasSeek
            ? ['-a', 'VLC', '--args', `--start-time=${sec}`, filePath]
            : ['-a', 'VLC', filePath]
        }
      }
    }

    return null
  }

  private resolvePdfCommand(
    filePath: string,
    pageNumber: number | undefined,
    isWin: boolean,
    isMac: boolean
  ): ResolvedAppCommand | null {
    const hasPage = pageNumber !== undefined && Number.isFinite(pageNumber) && pageNumber >= 1
    const page = hasPage ? Math.floor(pageNumber!) : 1
    const fileUrl = pathToFileURL(filePath).href + (hasPage ? `#page=${page}` : '')

    if (isWin) {
      // 1. SumatraPDF
      const sumatraCandidates = [
        path.join(this.env['LOCALAPPDATA'] || '', 'SumatraPDF', 'SumatraPDF.exe'),
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'SumatraPDF', 'SumatraPDF.exe')
      ]
      for (const cand of sumatraCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'sumatrapdf',
            exe: cand,
            args: hasPage ? ['-page', String(page), filePath] : [filePath]
          }
        }
      }

      // 2. Edge
      const edgeCandidates = [
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
      for (const cand of edgeCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'edge',
            exe: cand,
            args: [fileUrl]
          }
        }
      }

      // 3. Chrome
      const chromeCandidates = [
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(this.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
      for (const cand of chromeCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'chrome',
            exe: cand,
            args: [fileUrl]
          }
        }
      }

      // 4. Adobe Acrobat
      const acrobatCandidates = [
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'Adobe', 'Acrobat DC', 'Acrobat', 'Acrobat.exe'),
        path.join(this.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Adobe', 'Acrobat Reader DC', 'Reader', 'AcroRd32.exe')
      ]
      for (const cand of acrobatCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'acrobat',
            exe: cand,
            args: hasPage ? ['/A', `page=${page}`, filePath] : [filePath]
          }
        }
      }
    } else if (isMac) {
      if (this.fileExistsFn('/Applications/Microsoft Edge.app')) {
        return {
          kind: 'edge',
          exe: '/usr/bin/open',
          args: ['-a', 'Microsoft Edge', fileUrl]
        }
      }
      if (this.fileExistsFn('/Applications/Google Chrome.app')) {
        return {
          kind: 'chrome',
          exe: '/usr/bin/open',
          args: ['-a', 'Google Chrome', fileUrl]
        }
      }
    }

    return null
  }

  private resolveCodeCommand(
    filePath: string,
    lineNumber: number | undefined,
    isWin: boolean,
    isMac: boolean
  ): ResolvedAppCommand | null {
    const hasLine = lineNumber !== undefined && Number.isFinite(lineNumber) && lineNumber >= 1
    const line = hasLine ? Math.floor(lineNumber!) : 1
    const targetWithLine = `${filePath}:${line}`

    if (isWin) {
      // 1. VS Code (必须直接指向 Code.exe 二进制，严禁使用 code.cmd 防 CVE-2024-27980)
      const codeCandidates = [
        path.join(this.env['LOCALAPPDATA'] || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(this.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe')
      ]
      for (const cand of codeCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'vscode',
            exe: cand,
            args: hasLine ? ['-g', targetWithLine] : [filePath]
          }
        }
      }

      // 2. Cursor
      const cursorCandidates = [
        path.join(this.env['LOCALAPPDATA'] || '', 'Programs', 'cursor', 'Cursor.exe'),
        path.join(this.env['LOCALAPPDATA'] || '', 'cursor', 'Cursor.exe')
      ]
      for (const cand of cursorCandidates) {
        if (this.fileExistsFn(cand)) {
          return {
            kind: 'cursor',
            exe: cand,
            args: hasLine ? ['-g', targetWithLine] : [filePath]
          }
        }
      }
    } else if (isMac) {
      if (this.fileExistsFn('/Applications/Visual Studio Code.app')) {
        return {
          kind: 'vscode',
          exe: '/usr/bin/open',
          args: hasLine
            ? ['-a', 'Visual Studio Code', '--args', '-g', targetWithLine]
            : ['-a', 'Visual Studio Code', filePath]
        }
      }
      if (this.fileExistsFn('/Applications/Cursor.app')) {
        return {
          kind: 'cursor',
          exe: '/usr/bin/open',
          args: hasLine
            ? ['-a', 'Cursor', '--args', '-g', targetWithLine]
            : ['-a', 'Cursor', filePath]
        }
      }
    }

    return null
  }
}

export const externalAppLauncher = new ExternalAppLauncher()
