// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('@voerkai18n/react', async importOriginal => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useVoerkaI18n: () => ({
      t: (str: string, vars?: any) => {
        if (!vars) return str
        let res = str
        for (const [k, v] of Object.entries(vars)) {
          res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
        return res
      },
      activeLanguage: 'zh-CN',
      changeLanguage: vi.fn()
    })
  }
})

vi.mock('../../lib/posthog', () => ({
  captureEvent: vi.fn()
}))

const configMocks = vi.hoisted(() => ({
  completeSetup: vi.fn().mockResolvedValue(true)
}))

vi.mock('@stores/config-store', () => ({
  useWelcomeStore: {
    getState: () => ({
      completeSetup: configMocks.completeSetup
    })
  }
}))

vi.mock('@stores/settings-store', () => ({
  useSettingsStore: () => ({
    getConfigValue: vi.fn(() => 'zh-CN'),
    updateConfigValue: vi.fn().mockResolvedValue(true)
  })
}))

vi.mock('../common/Header', () => ({
  Header: () => <div data-testid="mock-header">Header</div>
}))

// Step 3 复用插件中心的目录 store；这里只替换渲染层门面，不改动真实 store
vi.mock('@stores/plugin-center-store', () => ({
  usePluginCenterStore: (selector: any) =>
    selector({
      dirInfo: {
        currentPath: 'D:\\FireflyModules',
        currentDir: 'D:\\FireflyModules',
        usedBytes: 512 * 1024 * 1024,
        freeBytes: 80 * 1024 * 1024 * 1024,
        defaultDirNonAscii: false
      },
      dirPhase: 'STABLE',
      dirMigrationProgress: null,
      loadDirInfo: vi.fn().mockResolvedValue(null),
      pickDirectory: vi.fn().mockResolvedValue(null),
      validatePluginDir: vi.fn().mockResolvedValue({ valid: true }),
      changePluginDir: vi.fn().mockResolvedValue({ success: true }),
      subscribeDirMigrationProgress: vi.fn(() => () => undefined)
    }),
  formatPluginErrorMessage: () => '插件操作发生未知异常，请稍后重试。'
}))

import { WelcomeWizard } from '../WelcomeWizard'

/**
 * 5 步顺序（用户确认）：
 * ①语言 → ②AI 引擎与智能能力装配 → ③选择插件安装目录 → ④插件怎么装 → ⑤安装与就绪
 */
describe('WelcomeWizard 五步流转测试 (能力 -> 目录 -> 安装方式 -> 安装 + 顶部 stepper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, {
      electronAPI: {
        detectSystemResources: vi.fn().mockResolvedValue({
          totalMemGB: 16,
          totalMemMB: 16384,
          gpuName: 'NVIDIA RTX 4070',
          vramGB: 8,
          isGpuSupported: true,
          storageFreeGB: 50
        }),
        modularResource: {
          install: vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' }),
          smokeTest: vi.fn().mockResolvedValue({ success: true, latency_ms: 100 }),
          updateState: vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' }),
          abortAll: vi.fn().mockResolvedValue(true),
          importOfflinePackage: vi.fn().mockResolvedValue(null),
          applyInitialPluginDir: vi.fn().mockResolvedValue({ success: true }),
          onProgress: vi.fn(() => () => undefined)
        },
        llmGateway: { setDesiredMode: vi.fn().mockResolvedValue(true) }
      }
    })
  })

  /** Step 1 -> Step 2（能力装配），并等硬件探测落定 */
  const goToStep2 = async () => {
    fireEvent.click(screen.getByText('继续'))
    await waitFor(() => expect(screen.getByText('AI 引擎与智能能力装配')).toBeDefined())
    await waitFor(() => expect(screen.getByText('16 GB')).toBeDefined())
  }

  /** Step 2 -> Step 3（安装目录） */
  const goToStep3 = async () => {
    fireEvent.click(screen.getByTestId('welcome-step2-next-btn'))
    await waitFor(() => expect(screen.getByText('选择插件安装目录')).toBeDefined())
  }

  /** Step 3 -> Step 4（插件怎么装） */
  const goToStep4 = async () => {
    fireEvent.click(screen.getByTestId('welcome-step3-next-btn'))
    await waitFor(() => expect(screen.getByText('插件怎么装？')).toBeDefined())
  }

  it('初始进入 Step 1 语言选择，顶部始终显示 5 格 stepper 与进度标题', async () => {
    // 容器挂载后会异步探测硬件并 setState；用 act 冲刷 Promise，避免 act(...) 警告
    await act(async () => {
      render(<WelcomeWizard onComplete={vi.fn()} />)
    })

    expect(screen.getByText('欢迎使用 - 初始设置')).toBeDefined()
    const stepper = screen.getByTestId('welcome-stepper')
    expect(stepper).toBeDefined()
    expect(screen.getByTestId('welcome-stepper-caption').textContent).toContain('第 1 步 / 共 5 步')
    for (let step = 1; step <= 5; step++) {
      expect(screen.getByTestId(`welcome-stepper-item-${step}`)).toBeDefined()
    }
    expect(screen.getByTestId('welcome-stepper-item-1').getAttribute('aria-current')).toBe('step')
    expect(stepper.textContent).toContain('能力装配')
    expect(stepper.textContent).toContain('安装目录')
    expect(stepper.textContent).toContain('插件安装方式')
  })

  it('Step 1 -> Step 2 进入「能力装配」，安装方式页不再排在第二位', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />)

    await goToStep2()

    expect(screen.queryByText('插件怎么装？')).toBeNull()
    expect(screen.getByTestId('welcome-engine-gemma-card')).toBeDefined()
    expect(screen.getByTestId('welcome-step2-later-method-hint').textContent).toContain(
      '现在还不会下载文件'
    )
    expect(screen.getByTestId('welcome-stepper-caption').textContent).toContain('第 2 步 / 共 5 步')

    fireEvent.click(screen.getByTestId('welcome-step2-back-btn'))
    expect(screen.getByText('欢迎使用 - 初始设置')).toBeDefined()
  })

  it('完整五步正向流转：选择不下盘，安装页才写入，最终按钮才落地首次运行配置', async () => {
    const onComplete = vi.fn()
    const modular = (window as any).electronAPI.modularResource
    render(<WelcomeWizard onComplete={onComplete} />)

    await goToStep2()
    expect(modular.install).not.toHaveBeenCalled()

    // Step 2 -> Step 3：目录页应有足够空间 / SSD 文案
    await goToStep3()
    expect(screen.getByTestId('welcome-step3-space-hint').textContent).toContain('固态硬盘（SSD）')
    expect(modular.install).not.toHaveBeenCalled()
    expect(configMocks.completeSetup).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()

    // Step 3 -> Step 4：安装方式页排在目录之后
    await goToStep4()
    expect(screen.getByTestId('welcome-method-online-card')).toBeDefined()
    expect(screen.getByTestId('welcome-method-offline-card')).toBeDefined()
    expect(modular.install).not.toHaveBeenCalled()

    // Step 4 -> Step 5：在线方式进入页面即开始下载
    fireEvent.click(screen.getByTestId('welcome-step4-next-btn'))
    await waitFor(() => expect(screen.getByTestId('welcome-step5-container')).toBeDefined())
    await waitFor(() => {
      expect(screen.getByText('主检索引擎安装完成，可以开始使用了！')).toBeDefined()
    })
    expect(modular.install).toHaveBeenCalledWith('engine_gemma_unified')
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('welcome-enter-app-btn').textContent).toContain(
      '开启智能文件管理之旅'
    )
    expect(configMocks.completeSetup).not.toHaveBeenCalled()

    // 最终按钮：点击后才完成向导
    fireEvent.click(screen.getByTestId('welcome-enter-app-btn'))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(configMocks.completeSetup).toHaveBeenCalledTimes(1)
  })

  it('Step 4 选离线总包 -> Step 5 展示「选择离线安装包」按钮，不自动导入', async () => {
    const modular = (window as any).electronAPI.modularResource
    render(<WelcomeWizard onComplete={vi.fn()} />)

    await goToStep2()
    await goToStep3()
    await goToStep4()

    fireEvent.click(screen.getByTestId('welcome-method-offline-card'))
    expect(screen.getByTestId('welcome-step4-offline-hint')).toBeDefined()

    fireEvent.click(screen.getByTestId('welcome-step4-next-btn'))
    await waitFor(() => expect(screen.getByTestId('welcome-step5-select-package-card')).toBeDefined())
    expect(screen.getByTestId('welcome-step5-select-package-btn')).toBeDefined()
    expect(modular.importOfflinePackage).not.toHaveBeenCalled()
    expect(modular.install).not.toHaveBeenCalled()
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('跨步骤选择提升到共享状态：Step 2 选轻巧引擎、Step 4 选离线，来回切换不丢失', async () => {
    render(<WelcomeWizard onComplete={vi.fn()} />)

    await goToStep2()
    fireEvent.click(screen.getByTestId('welcome-engine-classic-card'))
    expect(screen.getByTestId('welcome-engine-classic-card').className).toContain('border-primary')

    await goToStep3()
    await goToStep4()
    fireEvent.click(screen.getByTestId('welcome-method-offline-card'))
    expect(screen.getByTestId('welcome-method-offline-card').className).toContain(
      'border-emerald-500'
    )

    // 一路返回到 Step 2 再走回来，两项选择都还在
    fireEvent.click(screen.getByTestId('welcome-step4-back-btn'))
    await waitFor(() => expect(screen.getByText('选择插件安装目录')).toBeDefined())
    fireEvent.click(screen.getByTestId('welcome-step3-back-btn'))
    await waitFor(() => expect(screen.getByText('AI 引擎与智能能力装配')).toBeDefined())
    expect(screen.getByTestId('welcome-engine-classic-card').className).toContain('border-primary')

    await goToStep3()
    await goToStep4()
    expect(screen.getByTestId('welcome-method-offline-card').className).toContain(
      'border-emerald-500'
    )
  })

  it('Step 5 返回 Step 4（安装方式）再进入时保留已就绪态，不重复安装', async () => {
    const modular = (window as any).electronAPI.modularResource
    render(<WelcomeWizard onComplete={vi.fn()} />)

    await goToStep2()
    await goToStep3()
    await goToStep4()
    fireEvent.click(screen.getByTestId('welcome-step4-next-btn'))

    await waitFor(() => {
      expect(screen.getByText('主检索引擎安装完成，可以开始使用了！')).toBeDefined()
    })
    const callsAfterFirstRun = modular.install.mock.calls.length
    expect(callsAfterFirstRun).toBeGreaterThan(0)

    fireEvent.click(screen.getByTestId('welcome-step5-back-btn'))
    await waitFor(() => expect(screen.getByText('插件怎么装？')).toBeDefined())
    fireEvent.click(screen.getByTestId('welcome-step4-next-btn'))

    await waitFor(() => expect(screen.getByTestId('welcome-step5-container')).toBeDefined())
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(false)
    expect(modular.install.mock.calls.length).toBe(callsAfterFirstRun)
  })

  it('文件大小标签使用主题语义色（明暗模式均可读）', async () => {
    render(<WelcomeWizard initialStep={2} onComplete={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('242.2 MiB')).toBeDefined())
    for (const sizeLabel of ['242.2 MiB', '304.4 MiB']) {
      const classes = screen.getByText(sizeLabel).className.split(/\s+/)
      expect(classes.some(c => /^bg-(muted|card|secondary)/.test(c))).toBe(true)
      expect(classes.some(c => /^text-(foreground|muted-foreground)$/.test(c))).toBe(true)
    }
  })

  it('硬件探测自适应看板：展示内存与显卡，且不再展示多余的生成式条目', async () => {
    const { unmount } = render(<WelcomeWizard initialStep={2} onComplete={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByText('16 GB')).toBeDefined()
    )
    expect(screen.queryByText('智能起名与总结')).toBeNull()
    expect(screen.queryByText('轻巧办公版（无需独立显卡，低内存占用）')).toBeNull()
    unmount()

    ;(window as any).electronAPI.detectSystemResources.mockResolvedValue({
      totalMemGB: 32,
      totalMemMB: 32768,
      gpuName: 'NVIDIA GeForce RTX 4080',
      vramGB: 16,
      isGpuSupported: true,
      storageFreeGB: 120
    })
    render(<WelcomeWizard initialStep={2} onComplete={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByText('32 GB')).toBeDefined()
    )
    expect(screen.queryByText('专业深度版（需独立显卡，深度整理）')).toBeNull()
  })

  it('initialStep 支持直接落到 2 / 3 / 4 / 5 任意一页', async () => {
    const cases: Array<[2 | 3 | 4 | 5, string]> = [
      [2, 'AI 引擎与智能能力装配'],
      [3, '选择插件安装目录'],
      [4, '插件怎么装？'],
      [5, '正在为你装好智能文件管理']
    ]

    for (const [step, title] of cases) {
      const { unmount } = render(<WelcomeWizard initialStep={step} onComplete={vi.fn()} />)
      expect(screen.getByText(title)).toBeDefined()
      expect(screen.getByTestId('welcome-stepper-caption').textContent).toContain(
        `第 ${step} 步 / 共 5 步`
      )
      unmount()
    }
  })
})
