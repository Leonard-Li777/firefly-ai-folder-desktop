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
      }
    })
  }
})

import { WelcomeStep5InstallReady } from '../WelcomeStep5InstallReady'
import {
  DEFAULT_HARDWARE,
  DEFAULT_WELCOME_SELECTION,
  type WelcomeSelection
} from '../welcome-types'

const onlineSelection: WelcomeSelection = {
  ...DEFAULT_WELCOME_SELECTION,
  selectedOptionals: {
    perception_nsfw: true,
    asr_sensevoice_onnx: true,
    tts_m5_onnx: true
  }
}

describe('WelcomeStep5InstallReady (欢迎向导第五步：安装与就绪)', () => {
  let api: any

  beforeEach(() => {
    api = {
      install: vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' }),
      smokeTest: vi.fn().mockResolvedValue({ success: true, latency_ms: 100 }),
      updateState: vi.fn().mockResolvedValue({ id: 'mock', install_state: 'active' }),
      abortAll: vi.fn().mockResolvedValue(true),
      importOfflinePackage: vi.fn().mockResolvedValue({
        id: 'engine_gemma_unified',
        capability_slot: 'base_embedding',
        state: 'active'
      }),
      list: vi.fn().mockResolvedValue([]),
      onProgress: vi.fn(() => () => undefined)
    }
    Object.assign(window, {
      electronAPI: {
        modularResource: api,
        llmGateway: { setDesiredMode: vi.fn().mockResolvedValue(true) }
      }
    })
  })

  const setup = (overrides: any = {}) => {
    const props = {
      selection: onlineSelection,
      hardware: { ...DEFAULT_HARDWARE },
      pluginDir: 'E:\\FireflyAI',
      onBack: vi.fn(),
      onFinish: vi.fn(),
      onReady: vi.fn(),
      ...overrides
    }
    render(<WelcomeStep5InstallReady {...props} />)
    return props
  }

  const waitReady = async () => {
    await waitFor(() => {
      expect(screen.getByText('主检索引擎安装完成，可以开始使用了！')).toBeDefined()
    })
  }

  it('在线安装：进入本页自动开始安装，主引擎 + 自检 + 激活 + 底座同步依次执行', async () => {
    setup()

    await waitReady()

    expect(api.install).toHaveBeenCalledWith('engine_gemma_unified')
    expect(api.smokeTest).toHaveBeenCalledWith({ profile: 'gemma_unified' })
    expect(api.updateState).toHaveBeenCalledWith('engine_gemma_unified', { active: true })
    expect((window as any).electronAPI.llmGateway.setDesiredMode).toHaveBeenCalledWith('cpu')
    expect(screen.getByTestId('welcome-step5-container').textContent).toContain('安装到')
  })

  it('主引擎与选配插件均完成安装后解锁最终按钮', async () => {
    const props = setup()

    await waitReady()

    const finalBtn = screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement
    expect(finalBtn.disabled).toBe(false)
    expect(finalBtn.textContent).toContain('开启智能文件管理之旅')

    // 主引擎 + 3 个选配插件全部真实安装并调用
    for (const optId of ['perception_nsfw', 'asr_sensevoice_onnx', 'tts_m5_onnx']) {
      expect(api.install).toHaveBeenCalledWith(optId)
    }
    expect(props.onReady).toHaveBeenCalledTimes(1)

    fireEvent.click(finalBtn)
    expect(props.onFinish).toHaveBeenCalledTimes(1)
  })

  it('安装未就绪前最终按钮禁用，返回按钮也不可点；就绪后返回可点', async () => {
    let resolveFirstInstall: any
    let isFirst = true
    api.install = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          if (isFirst) {
            isFirst = false
            resolveFirstInstall = resolve
          } else {
            resolve({ id: 'mock' })
          }
        })
    )

    const props = setup()
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('welcome-step5-back-btn') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveFirstInstall({ id: 'mock' })
    })
    await waitReady()

    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('welcome-step5-back-btn'))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })

  it('在线展示态：进入本页直接是下载进度界面，没有离线选包按钮', async () => {
    setup()

    expect(screen.getByTestId('welcome-step5-container').textContent).toContain(
      '正在装好主检索引擎，请稍候...'
    )
    expect(screen.queryByTestId('welcome-step5-select-package-card')).toBeNull()
    expect(screen.queryByTestId('welcome-step5-select-package-btn')).toBeNull()
    expect(api.install).toHaveBeenCalledWith('engine_gemma_unified')

    await waitReady()
  })

  it('离线展示态：先给「选择离线安装包」按钮，不自动弹文件框、不自动导入', async () => {
    setup({ selection: { ...onlineSelection, installMethod: 'offline' } })

    expect(screen.getByTestId('welcome-step5-select-package-card')).toBeDefined()
    expect(screen.getByText('请挑选离线安装包')).toBeDefined()
    expect(screen.getByTestId('welcome-step5-select-package-btn')).toBeDefined()
    expect(screen.queryByText('正在校验并导入离线安装包，请稍候...')).toBeNull()
    expect(api.importOfflinePackage).not.toHaveBeenCalled()
    expect(api.abortAll).not.toHaveBeenCalled()
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(true)
    // 待选包时不算忙碌，用户能返回 Step 4 改成在线安装
    expect((screen.getByTestId('welcome-step5-back-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('离线点选包按钮后才导入：先中断在途下载，再导入 + 自检，不走在线 install 主引擎', async () => {
    setup({ selection: { ...onlineSelection, installMethod: 'offline' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step5-select-package-btn'))
    })
    await waitReady()

    expect(api.abortAll).toHaveBeenCalledTimes(1)
    expect(api.importOfflinePackage).toHaveBeenCalledWith({
      preferredEngineId: 'engine_gemma_unified'
    })
    expect(api.smokeTest).toHaveBeenCalledWith({ profile: 'gemma_unified' })
    expect(api.install).not.toHaveBeenCalledWith('engine_gemma_unified')
    expect(screen.getByTestId('welcome-step5-container').textContent).toContain('导入离线安装包')
  })

  it('离线文件框点取消：退回选包态并给温和提示，不会连弹文件框，可再点一次', async () => {
    api.importOfflinePackage.mockResolvedValue(null)
    setup({ selection: { ...onlineSelection, installMethod: 'offline' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step5-select-package-btn'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('welcome-step5-select-package-error').textContent).toContain(
        '再选一次'
      )
    })
    expect(screen.getByTestId('welcome-step5-select-package-btn')).toBeDefined()
    expect(api.importOfflinePackage).toHaveBeenCalledTimes(1)

    api.importOfflinePackage.mockResolvedValue({
      id: 'engine_gemma_unified',
      capability_slot: 'base_embedding',
      state: 'active'
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step5-select-package-btn'))
    })
    await waitReady()
    expect(api.importOfflinePackage).toHaveBeenCalledTimes(2)
  })

  it('离线导入失败：重试退回选包态，不自动重新弹文件框', async () => {
    api.importOfflinePackage.mockRejectedValue(new Error('安装包损坏'))
    setup({ selection: { ...onlineSelection, installMethod: 'offline' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step5-select-package-btn'))
    })
    await waitFor(() => expect(screen.getByText('安装包损坏')).toBeDefined())

    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step5-retry-btn'))
    })
    expect(screen.getByTestId('welcome-step5-select-package-btn')).toBeDefined()
    expect(api.importOfflinePackage).toHaveBeenCalledTimes(1)
  })

  it('自检失败：展示错误与重试入口，最终按钮保持禁用', async () => {
    api.smokeTest.mockResolvedValue({ success: false, error: '自检未通过' })

    setup()

    await waitFor(() => {
      expect(screen.getByText('自检未通过')).toBeDefined()
    })
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('welcome-step5-retry-btn')).toBeDefined()

    // 重试后自检通过即可放行
    api.smokeTest.mockResolvedValue({ success: true })
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step5-retry-btn'))
    })
    await waitReady()
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('从 Step 4 返回再进入时恢复已就绪态，不重复安装', () => {
    setup({ initialReady: true })

    expect(screen.getByText('主检索引擎安装完成，可以开始使用了！')).toBeDefined()
    expect(api.install).not.toHaveBeenCalled()
    expect((screen.getByTestId('welcome-enter-app-btn') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('welcome-step5-background-hint')).toBeDefined()
  })

  it('在线下载时实时展示下载速率指示器与数据量指示', async () => {
    let progressCallback: any
    api.onProgress = vi.fn((cb: any) => {
      progressCallback = cb
      return () => undefined
    })

    let resolveInstall: any
    let isFirst = true
    api.install = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          if (isFirst) {
            isFirst = false
            resolveInstall = resolve
          } else {
            resolve({ id: 'mock' })
          }
        })
    )

    setup()

    expect(screen.getByTestId('welcome-step5-download-speed-bar')).toBeDefined()

    // 触发下载进度事件，带速率与下载字节
    await act(async () => {
      progressCallback?.({
        moduleId: 'engine_gemma_unified',
        resourceId: 'emb-391b9a03',
        percentage: 45,
        speedBytesPerSec: 1024 * 1024 * 5.2, // 5.2 MB/s
        downloadedBytes: 1024 * 1024 * 110,
        expectedBytes: 1024 * 1024 * 242.2,
        state: 'downloading'
      })
    })

    const speedBar = screen.getByTestId('welcome-step5-download-speed-bar')
    expect(speedBar.textContent).toContain('5.2 MB/s')
    expect(speedBar.textContent).toContain('110.0 MB')
    expect(speedBar.textContent).toContain('242.2 MB')

    // 触发解压事件，展示解压状态
    await act(async () => {
      progressCallback?.({
        moduleId: 'engine_gemma_unified',
        resourceId: 'emb-391b9a03',
        percentage: 95,
        speedBytesPerSec: 0,
        downloadedBytes: 1024 * 1024 * 242.2,
        expectedBytes: 1024 * 1024 * 242.2,
        state: 'extracting'
      })
    })
    expect(speedBar.textContent).toContain('正在校验并安全解压安装包...')

    await act(async () => {
      resolveInstall({ id: 'mock' })
    })
    await waitReady()
  })

  it('引擎首次自检 (smoke_testing) 阶段明确展示下载已完成提示卡片与自检状态', async () => {
    let resolveSmoke: any
    api.smokeTest = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSmoke = resolve
        })
    )

    setup()

    await waitFor(() => {
      expect(screen.getByText('主检索引擎已下载完成，正在进行首次启动检验...')).toBeDefined()
    })

    const hint = screen.getByTestId('welcome-step5-smoke-testing-hint')
    expect(hint.textContent).toContain('核心组件已全部下载完成！')
    expect(hint.textContent).toContain('通常需要 5~15 秒')
    expect(screen.getByText(/自检中/)).toBeDefined()

    await act(async () => {
      resolveSmoke({ success: true })
    })
    await waitReady()
  })

  it('明暗自适应：不得写死亮色色值', async () => {
    setup()
    await waitReady()
    const html = screen.getByTestId('welcome-step5-container').innerHTML
    // 明暗自适应：必须使用主题语义色，严禁写死仅适配亮色的色值
    expect(html).not.toMatch(/\b(bg-white|bg-slate-\d+|text-slate-\d+|border-slate-\d+)\b/)
    expect(html).toContain('text-muted-foreground')
  })
})
