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
export function detectWorktreeName(): string {
  if (process.env.WORKTREE_NAME && process.env.WORKTREE_NAME.trim()) {
    return sanitizeName(process.env.WORKTREE_NAME.trim())
  }

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

  return 'main'
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
}

/**
 * 初始化并隔离当前 Worktree 实例的 app.name 与 userData 路径
 * 必须在 main/index.ts 顶部尽早调用！
 */
export function initWorktreeEnvironment(): WorktreeEnvInfo {
  if (cachedInfo) return cachedInfo

  const isProd = app.isPackaged || process.env.NODE_ENV === 'production'
  const region = (process.env.BUILD_REGION || 'CN').toLowerCase()
  const worktreeName = detectWorktreeName()

  const appName = isProd
    ? `firefly-ai-folder-${region}`
    : `firefly-ai-folder-${region}-${worktreeName}`

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