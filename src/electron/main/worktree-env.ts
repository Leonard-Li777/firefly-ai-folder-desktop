import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

export interface WorktreeEnvInfo {
  worktreeName: string
  region: string
  isProd: boolean
  appName: string
  userDataDir: string
}

let cachedInfo: WorktreeEnvInfo | null = null

/**
 * 推导当前运行环境所属的 Worktree 名称
 */
/**
 * 推导当前运行环境所属的 Worktree 名称
 */
export function detectWorktreeName(): string {
  if (process.env.WORKTREE_NAME && process.env.WORKTREE_NAME.trim()) {
    return sanitizeName(process.env.WORKTREE_NAME.trim())
  }

  // 1. 优先从命令行启动参数（如外部唤起的 firefly:// 协议链接）中提取目标 worktree
  try {
    const deepLinkArg = process.argv.find(arg => arg.startsWith('firefly://'))
    if (deepLinkArg) {
      const parsed = new URL(deepLinkArg)
      const qWorktree = parsed.searchParams.get('worktree')
      if (qWorktree && qWorktree.trim()) {
        const sanitized = sanitizeName(qWorktree.trim())
        console.log(`🔗 [Worktree] 从深链接参数中解析到目标 Worktree: ${sanitized}`)
        return sanitized
      }
    }
  } catch {}

  try {
    let currentDir = process.cwd()
    for (let i = 0; i < 4; i++) {
      const gitPath = path.join(currentDir, '.git')
      if (fs.existsSync(gitPath)) {
        const stat = fs.statSync(gitPath)
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, 'utf-8').trim()
          // 适配主工程与子模块 worktree 路径：
          // 例如: .git/worktrees/pay 或 .git/worktrees/pay/modules/apps/desktop
          const match = content.match(/worktrees[/\\]([^/\r\n\\]+)/i)
          if (match && match[1]) {
            return sanitizeName(match[1])
          }
          // 检查上一级目录名是否形如 xxx.worktrees/pay
          const topWorktreeMatch = currentDir.match(/worktrees[/\\]([^/\r\n\\]+)/i)
          if (topWorktreeMatch && topWorktreeMatch[1]) {
            return sanitizeName(topWorktreeMatch[1])
          }
          return sanitizeName(path.basename(currentDir))
        } else if (stat.isDirectory()) {
          // 主仓库并且不是以 worktrees 命名的目录
          const topWorktreeMatch = currentDir.match(/worktrees[/\\]([^/\r\n\\]+)/i)
          if (topWorktreeMatch && topWorktreeMatch[1]) {
            return sanitizeName(topWorktreeMatch[1])
          }
          return 'main'
        }
      }
      const parent = path.dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  } catch {
    // ignore
  }

  // 2. 开发环境下若外部未带 worktree 参数启动，尝试路由到最近活跃的开发实例
  if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
    try {
      const activeFile = path.join(app.getPath('appData'), 'firefly-ai-folder', 'active-worktrees.json')
      if (fs.existsSync(activeFile)) {
        const raw = fs.readFileSync(activeFile, 'utf-8')
        const activeMap = JSON.parse(raw)
        let latestWorktree = ''
        let latestTime = 0
        for (const [wt, info] of Object.entries<any>(activeMap)) {
          if (info && info.lastActive > latestTime) {
            latestTime = info.lastActive
            latestWorktree = wt
          }
        }
        if (latestWorktree) {
          console.log(`🎯 [Worktree] 外部无参数唤起，自动回退到最近活跃 Worktree: ${latestWorktree}`)
          return latestWorktree
        }
      }
    } catch {}
  }

  return 'main'
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
}

/**
 * 注册当前 Worktree 实例为活跃状态（记录 PID 与时间戳）
 */
export function touchActiveWorktree(worktreeName: string): void {
  try {
    const commonDir = path.join(app.getPath('appData'), 'firefly-ai-folder')
    if (!fs.existsSync(commonDir)) {
      fs.mkdirSync(commonDir, { recursive: true })
    }
    const activeFile = path.join(commonDir, 'active-worktrees.json')
    let map: Record<string, any> = {}
    if (fs.existsSync(activeFile)) {
      try {
        map = JSON.parse(fs.readFileSync(activeFile, 'utf-8'))
      } catch {}
    }
    map[worktreeName] = {
      pid: process.pid,
      lastActive: Date.now()
    }
    fs.writeFileSync(activeFile, JSON.stringify(map, null, 2), 'utf-8')
  } catch {}
}

/**
 * 解析并获取主版本号标识（如 'v4'）
 */
function getAppMajorVersion(): string {
  try {
    // 优先尝试从 apps/desktop/package.json 中直接解析
    const candidatePaths = [
      path.resolve(__dirname, '../../package.json'),
      path.resolve(__dirname, '../../../package.json'),
      path.resolve(process.cwd(), 'package.json')
    ]
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8')
        const pkg = JSON.parse(raw)
        if (pkg.version) {
          const match = String(pkg.version).match(/\d+/)
          if (match) return `v${match[0]}`
        }
      }
    }
  } catch {}

  try {
    const v = app.getVersion()
    if (v) {
      const match = v.match(/\d+/)
      if (match) return `v${match[0]}`
    }
  } catch {}

  return 'v4'
}

/**
 * 初始化并隔离当前 Worktree 实例的 app.name 与 userData 路径
 * 必须在 main/index.ts 顶部尽早调用！
 */
export function initWorktreeEnvironment(): WorktreeEnvInfo {
  if (cachedInfo) return cachedInfo

  let isProd = app.isPackaged || process.env.NODE_ENV === 'production'
  const rawRegion = (process.env.BUILD_REGION || 'CN').trim().toLowerCase()
  const region = rawRegion === 'cn' ? 'cn' : 'intl'

  // 检查深链接中是否指明了环境
  try {
    const deepLinkArg = process.argv.find(arg => arg.startsWith('firefly://'))
    if (deepLinkArg) {
      const parsed = new URL(deepLinkArg)
      const qEnv = parsed.searchParams.get('env')
      if (qEnv === 'prod') {
        isProd = true
      } else if (qEnv === 'dev') {
        isProd = false
      }
    }
  } catch {}

  const rawEnv = (process.env.APP_ENV || (isProd ? 'production' : 'development')).trim().toLowerCase()
  let appEnv = 'development'
  if (rawEnv.includes('prod')) appEnv = 'production'
  else if (rawEnv.includes('can') || rawEnv.includes('gray')) appEnv = 'canary'
  else appEnv = 'development'

  const worktreeName = detectWorktreeName()
  const majorVersion = getAppMajorVersion()

  // 生产打包时: firefly-ai-folder-v4-[cn|intl]
  // 开发运行时: firefly-ai-folder-v4-[cn|intl]-[development|canary|production]-[worktree]
  const appName = isProd
    ? `firefly-ai-folder-${majorVersion}-${region}`
    : `firefly-ai-folder-${majorVersion}-${region}-${appEnv}-${worktreeName}`

  app.setName(appName)

  const appDataDir = app.getPath('appData')
  const userDataDir = path.join(appDataDir, appName)
  app.setPath('userData', userDataDir)

  if (!fs.existsSync(userDataDir)) {
    try {
      fs.mkdirSync(userDataDir, { recursive: true })
    } catch {}
  }

  process.env.APP_NAME = appName
  process.env.WORKTREE_NAME = worktreeName

  cachedInfo = {
    worktreeName,
    region,
    isProd,
    appName,
    userDataDir
  }

  return cachedInfo
}