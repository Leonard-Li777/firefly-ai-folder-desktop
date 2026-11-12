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

const mocks = vi.hoisted(() => ({
  state: {
    dirInfo: {
      currentPath: 'D:\\FireflyModules',
      currentDir: 'D:\\FireflyModules',
      committedDir: 'D:\\FireflyModules',
      isDefault: true,
      defaultDirNonAscii: false,
      usedBytes: 512 * 1024 * 1024,
      freeBytes: 80 * 1024 * 1024 * 1024,
      phase: 'STABLE'
    } as any,
    dirPhase: 'STABLE',
    dirMigrationProgress: null as any
  },
  loadDirInfo: vi.fn().mockResolvedValue(null),
  pickDirectory: vi.fn(),
  validatePluginDir: vi.fn(),
  changePluginDir: vi.fn(),
  subscribeDirMigrationProgress: vi.fn(() => () => undefined)
}))

// 只替换渲染层依赖的 store 门面，真实 store / 主进程校验器均不改动
vi.mock('@stores/plugin-center-store', () => ({
  usePluginCenterStore: (selector: any) =>
    selector({
      ...mocks.state,
      loadDirInfo: mocks.loadDirInfo,
      pickDirectory: mocks.pickDirectory,
      validatePluginDir: mocks.validatePluginDir,
      changePluginDir: mocks.changePluginDir,
      subscribeDirMigrationProgress: mocks.subscribeDirMigrationProgress
    }),
  formatPluginErrorMessage: (err: any) => {
    const dict: Record<string, string> = {
      PATH_NOT_ASCII: '文件夹路径不能包含中文，请选择纯英文路径',
      PATH_HAS_WHITESPACE: '文件夹路径中不能有空格，请去掉空格后重试',
      INSUFFICIENT_SPACE: '目标磁盘可用空间不足，请清理磁盘后重试',
      DIR_CHANGE_GATE_ACTIVE: '插件目录变更需重启软件生效，暂无法进行其他操作'
    }
    return dict[String(err?.code || '')] || '插件操作发生未知异常，请稍后重试。'
  }
}))

import { WelcomeStep3PluginDir } from '../WelcomeStep3PluginDir'

describe('WelcomeStep3PluginDir (欢迎向导第三步：首次运行目录设定)', () => {
  let applyInitialPluginDir: any

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.dirInfo = {
      currentPath: 'D:\\FireflyModules',
      currentDir: 'D:\\FireflyModules',
      committedDir: 'D:\\FireflyModules',
      isDefault: true,
      defaultDirNonAscii: false,
      usedBytes: 512 * 1024 * 1024,
      freeBytes: 80 * 1024 * 1024 * 1024,
      phase: 'STABLE'
    }
    mocks.state.dirPhase = 'STABLE'
    mocks.loadDirInfo.mockResolvedValue(null)
    mocks.pickDirectory.mockResolvedValue(null)
    mocks.validatePluginDir.mockResolvedValue({ valid: true })
    mocks.changePluginDir.mockResolvedValue({ success: true })
    mocks.subscribeDirMigrationProgress.mockReturnValue(() => undefined)

    applyInitialPluginDir = vi.fn().mockResolvedValue({
      success: true,
      appliedPath: 'E:\\FireflyAI'
    })
    Object.assign(window, {
      electronAPI: {
        modularResource: { applyInitialPluginDir }
      }
    })
  })

  it('默认展示当前插件目录与空间信息，文案强调足够空间并建议固态硬盘', () => {
    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)

    expect(screen.getByText('选择插件安装目录')).toBeDefined()
    expect(screen.getByTestId('welcome-step3-current-path').textContent).toContain(
      'D:\\FireflyModules'
    )
    expect(screen.getByText('512.0 MB')).toBeDefined()
    expect(screen.getByText('80.0 GB')).toBeDefined()

    const hint = screen.getByTestId('welcome-step3-space-hint')
    expect(hint.textContent).toContain('足够可用空间')
    expect(hint.textContent).toContain('建议至少预留 10GB 以上')
    expect(hint.textContent).toContain('固态硬盘（SSD）')
    expect(hint.textContent).toContain('纯英文路径')

    expect(mocks.loadDirInfo).toHaveBeenCalled()
    expect(screen.getByTestId('welcome-step3-pick-dir-btn')).toBeDefined()
  })

  it('默认目录含中文时展示与插件中心一致的稳定性警告', () => {
    mocks.state.dirInfo.defaultDirNonAscii = true
    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)

    const banner = screen.getByTestId('welcome-step3-nonascii-warning')
    expect(banner.textContent).toContain('包含中文字符')
    expect(banner.textContent).toContain('纯英文磁盘目录')
  })

  it('目录校验失败：大白话提示错误码，不出现候选卡片、不触发任何目录写入', async () => {
    mocks.pickDirectory.mockResolvedValue('D:\\中文插件目录')
    mocks.validatePluginDir.mockResolvedValue({
      valid: false,
      errorCode: 'PATH_NOT_ASCII',
      errorMessage: 'raw internal error'
    })

    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('welcome-step3-dir-error').textContent).toContain(
        '文件夹路径不能包含中文，请选择纯英文路径'
      )
    })
    expect(mocks.validatePluginDir).toHaveBeenCalledWith('D:\\中文插件目录')
    expect(applyInitialPluginDir).not.toHaveBeenCalled()
    expect(mocks.changePluginDir).not.toHaveBeenCalled()
  })

  it('空间不足错误码翻译成大白话', async () => {
    mocks.pickDirectory.mockResolvedValue('E:\\FireflyAI')
    mocks.validatePluginDir.mockResolvedValue({ valid: false, errorCode: 'INSUFFICIENT_SPACE' })

    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    expect(screen.getByTestId('welcome-step3-dir-error').textContent).toContain(
      '目标磁盘可用空间不足'
    )
  })

  it('选中当前默认目录：等同「不改直接沿用」，不报错、不触发任何目录写入', async () => {
    const onDirApplied = vi.fn()
    mocks.pickDirectory.mockResolvedValue('D:\\FireflyModules')
    mocks.validatePluginDir.mockResolvedValue({
      valid: false,
      errorCode: 'SAME_AS_CURRENT'
    })

    render(
      <WelcomeStep3PluginDir
        onBack={vi.fn()}
        onNext={vi.fn()}
        onDirApplied={onDirApplied}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    expect(screen.queryByTestId('welcome-step3-dir-error')).toBeNull()
    expect(screen.getByTestId('welcome-step3-applied-banner')).toBeDefined()
    expect(onDirApplied).toHaveBeenCalledWith('D:\\FireflyModules')
    expect(applyInitialPluginDir).not.toHaveBeenCalled()
    expect(mocks.changePluginDir).not.toHaveBeenCalled()
  })

  it('校验通过并一步到位直接应用：走首次运行目录设定通道，无需二次确认，绝不调用会置 PENDING_RESTART 的迁移事务', async () => {
    const onDirApplied = vi.fn()
    mocks.pickDirectory.mockResolvedValue('E:\\FireflyAI')
    mocks.validatePluginDir.mockResolvedValue({
      valid: true,
      diagnostics: {
        targetDiskFreeBytes: 120 * 1024 * 1024 * 1024,
        currentDirUsedBytes: 512 * 1024 * 1024,
        estimatedDurationSeconds: 12,
        hasConflictModules: false
      }
    })

    render(
      <WelcomeStep3PluginDir
        onBack={vi.fn()}
        onNext={vi.fn()}
        onDirApplied={onDirApplied}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    expect(applyInitialPluginDir).toHaveBeenCalledWith('E:\\FireflyAI')
    // 关键回归：changePluginDir 会冻结所有安装写操作，欢迎向导必须绕开它
    expect(mocks.changePluginDir).not.toHaveBeenCalled()
    expect(screen.getByTestId('welcome-step3-applied-banner').textContent).toContain('无需重启软件')
    expect(onDirApplied).toHaveBeenCalledWith('E:\\FireflyAI')
  })

  it('已有资产导致主进程拒绝跳过迁移时，给出向导语境的大白话提示', async () => {
    applyInitialPluginDir.mockResolvedValue({
      success: false,
      errorCode: 'DIR_CHANGE_GATE_ACTIVE'
    })
    mocks.pickDirectory.mockResolvedValue('E:\\FireflyAI')
    mocks.validatePluginDir.mockResolvedValue({ valid: true })

    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    expect(screen.getByTestId('welcome-step3-dir-error').textContent).toContain(
      '请沿用默认目录'
    )
    expect(screen.queryByTestId('welcome-step3-applied-banner')).toBeNull()
  })

  it('设定失败时展示错误码提示，不误报成功', async () => {
    applyInitialPluginDir.mockResolvedValue({
      success: false,
      errorCode: 'INSUFFICIENT_SPACE'
    })
    mocks.pickDirectory.mockResolvedValue('E:\\FireflyAI')
    mocks.validatePluginDir.mockResolvedValue({ valid: true })

    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    expect(screen.getByTestId('welcome-step3-dir-error').textContent).toContain(
      '目标磁盘可用空间不足'
    )
  })

  it('用户在系统文件选择器中取消时不报错、不校验、不写入', async () => {
    mocks.pickDirectory.mockResolvedValue(null)

    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('welcome-step3-pick-dir-btn'))
    })

    expect(mocks.validatePluginDir).not.toHaveBeenCalled()
    expect(applyInitialPluginDir).not.toHaveBeenCalled()
    expect(screen.queryByTestId('welcome-step3-dir-error')).toBeNull()
  })

  it('底部按钮：返回触发 onBack，下一步触发 onNext（文案不再是完成设置）', () => {
    const onBack = vi.fn()
    const onNext = vi.fn()

    render(<WelcomeStep3PluginDir onBack={onBack} onNext={onNext} />)

    const nextBtn = screen.getByTestId('welcome-step3-next-btn')
    expect(nextBtn.textContent).toContain('下一步')
    expect(screen.queryByText('完成设置，进入 Firefly')).toBeNull()

    fireEvent.click(screen.getByTestId('welcome-step3-back-btn'))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onNext).not.toHaveBeenCalled()

    fireEvent.click(nextBtn)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('明暗自适应：不得写死亮色色值', () => {
    render(<WelcomeStep3PluginDir onBack={vi.fn()} onNext={vi.fn()} />)

    const html = screen.getByTestId('welcome-step3-container').innerHTML
    // 明暗自适应：必须使用主题语义色，严禁写死仅适配亮色的色值
    expect(html).not.toMatch(/\b(bg-white|bg-slate-\d+|text-slate-\d+|border-slate-\d+)\b/)
    expect(html).toContain('text-muted-foreground')
  })
})
