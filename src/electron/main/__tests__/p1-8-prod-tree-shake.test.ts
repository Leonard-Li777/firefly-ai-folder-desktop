/**
 * Ticket 23 (P1-8): worktree-env / dev-runtime-cdp 生产环境跳过与产物文本断言闭环
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('P1-8: worktree-env / dev-runtime-cdp 生产产物与运行时跳过断言', () => {
  const desktopRoot = path.resolve(__dirname, '../../../..')

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('生产构建产物 (out_build/main) 明文 chunk 中不包含 dev-runtime-cdp 调试探测代码', () => {
    const outMainDir = path.join(desktopRoot, 'out_build', 'main')
    if (!fs.existsSync(outMainDir)) {
      // 未执行生产构建时仅校验源码门控存在，不阻塞无产物环境的单测
      return
    }

    const mainJsPath = path.join(outMainDir, 'main.js')
    if (fs.existsSync(mainJsPath)) {
      const mainJs = fs.readFileSync(mainJsPath, 'utf8')
      // 生产主入口经 bytecode-loader 加载字节码，明文引导壳不含 dev-runtime-cdp / worktree 调试逻辑
      expect(mainJs).not.toContain('dev-runtime-cdp')
      expect(mainJs).not.toContain('DevToolsActivePort')
    }

    const jsFiles = fs.readdirSync(outMainDir).filter(f => f.endsWith('.js'))
    for (const file of jsFiles) {
      const content = fs.readFileSync(path.join(outMainDir, file), 'utf8')
      expect(content).not.toContain('DevToolsActivePort')
      expect(content).not.toContain('publishWorkspaceDevRuntimeMirror')
    }
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

  it('DesktopDevRuntimeController 在非开发态 (isDevRuntime: false) 下完全跳过启动期 CDP 探测', async () => {
    const { DesktopDevRuntimeController } = await import('../dev-runtime-cdp')
    const appendSwitch = vi.fn()
    const relaunch = vi.fn()
    const controller = new DesktopDevRuntimeController({
      isDevRuntime: () => false,
      appendSwitch,
      relaunch
    })

    const switchRes = controller.configureDebuggingSwitch()
    expect(switchRes).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })
})
