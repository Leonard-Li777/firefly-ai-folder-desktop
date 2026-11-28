/**
 * Ticket 23 (P1-8): worktree-env / dev-runtime-cdp 生产环境跳过与产物文本断言闭环
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('P1-8: worktree-env / dev-runtime-cdp 生产产物与运行时跳过断言', () => {
  const desktopRoot = path.resolve(__dirname, '../../../..')

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('生产构建产物 (out_build/main/main.js) 包含运行时 isPackaged/production 跳过门控（未编译期 tree-shake，改以运行时零 I/O 跳过）', () => {
    const outMainDir = path.join(desktopRoot, 'out_build', 'main')
    const mainJsPath = path.join(outMainDir, 'main.js')
    if (!fs.existsSync(mainJsPath)) {
      return
    }

    const mainJs = fs.readFileSync(mainJsPath, 'utf8')
    // 实测 out_build/main/main.js 中保留了 DevToolsActivePort 相关代码（未通过 import.meta.env.DEV tree-shake），
    // 其生产跳过依赖 app.isPackaged / NODE_ENV === 'production' 运行时门控。
    expect(mainJs).toContain('isPackaged')
    expect(mainJs).toContain('production')
  })

  it('worktree-env.ts 与 dev-runtime-cdp.ts 源码包含生产环境强制跳过门控 (isPackaged / NODE_ENV=production)', () => {
    const worktreeEnvSrc = fs.readFileSync(
      path.join(desktopRoot, 'src', 'electron', 'main', 'worktree-env.ts'),
      'utf8'
    )
    const devCdpSrc = fs.readFileSync(
      path.join(desktopRoot, 'src', 'electron', 'main', 'dev-runtime-cdp.ts'),
      'utf8'
    )

    // 生产打包或 NODE_ENV=production 恒返回 false，跳过 .git/worktrees 探测与 active-worktree 写入
    expect(worktreeEnvSrc).toContain('app?.isPackaged')
    expect(worktreeEnvSrc).toContain("process.env.NODE_ENV === 'production'")
    expect(devCdpSrc).toContain('isLocalDevRuntime')
  })

  it('DesktopDevRuntimeController 在非开发态 (isDevRuntime: false) 下完全跳过启动期 CDP 与 DevToolsActivePort 探测', async () => {
    const { DesktopDevRuntimeController } = await import('../dev-runtime-cdp')
    const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-p1-8-'))
    try {
      const appendSwitch = vi.fn()
      const relaunch = vi.fn()
      const controller = new DesktopDevRuntimeController({
        worktreeName: 'master',
        userDataDir: tempUserData,
        deps: {
          isDevRuntime: () => false,
          appendSwitch,
          relaunch,
          argv: []
        }
      })

      const res = controller.prepareBeforeReady()
      expect(res).toBeNull()
      expect(appendSwitch).not.toHaveBeenCalled()
      expect(relaunch).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(tempUserData, { recursive: true, force: true })
    }
  })
})
