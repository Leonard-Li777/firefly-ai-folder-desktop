// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UpdateNotification, UpdateStatePayload } from '../UpdateNotification'

// 确保在导入依赖模块前 window.electronAPI 存在
if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    update: {
      getState: vi.fn(),
      onStatusChanged: vi.fn(() => () => {}),
      check: vi.fn(),
      quitAndInstall: vi.fn(),
      exitApp: vi.fn()
    }
  }
  ;(window as any).close = vi.fn()
}

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (str: string, vars?: any) => {
    if (!vars) return str
    let res = str
    for (const [k, v] of Object.entries(vars)) {
      res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
    return res
  },
  default: {}
}))

// Mock 外部链接与官网域名
vi.mock('../../../lib/external-link', () => ({
  openExternalLink: vi.fn()
}))
vi.mock('../../../lib/marketing-link', () => ({
  getOfficialSiteDomain: () => 'https://example.com'
}))

import { openExternalLink } from '../../../lib/external-link'

/**
 * 构造 UpdateStatePayload
 */
function makeState(overrides: Partial<UpdateStatePayload> = {}): UpdateStatePayload {
  return {
    status: 'downloaded',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    minVersion: null,
    isMandatory: false,
    progress: { percent: 100, transferred: 700, total: 700, bytesPerSecond: 1024 * 1024 },
    error: null,
    currentTrack: 'r2',
    downloadedFilePath: null,
    releaseNotes: null,
    releaseDate: null,
    ...overrides
  }
}

describe('工单04 · UpdateNotification 渲染层', () => {
  let getStateMock: ReturnType<typeof vi.fn>
  let onStatusChangedMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    getStateMock = (window as any).electronAPI.update.getState as any
    onStatusChangedMock = (window as any).electronAPI.update.onStatusChanged as any
    // 默认：主进程初始无状态，订阅回调可控
    getStateMock.mockResolvedValue(null)
    onStatusChangedMock.mockImplementation(() => () => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ----------------------------------------------------------------
  // AC4.1 · isMandatory === false 且 DOWNLOADED → 浮窗，可点"稍后"关闭
  // ----------------------------------------------------------------
  it('AC4.1-A: isMandatory=false + status=downloaded → 渲染浮窗（显示「新版本已就绪」）', async () => {
    onStatusChangedMock.mockImplementation((cb: any) => {
      cb(makeState({ isMandatory: false, status: 'downloaded' }))
      return () => {}
    })

    render(<UpdateNotification />)

    // 等待 useEffect 拉到状态
    await waitFor(() => {
      expect(screen.getByText('新版本已就绪')).toBeInTheDocument()
    })
  })

  it('AC4.1-B: 浮窗下载完成态 → 点击「下次启动生效」后浮窗消失', async () => {
    onStatusChangedMock.mockImplementation((cb: any) => {
      cb(makeState({ isMandatory: false, status: 'downloaded' }))
      return () => {}
    })

    render(<UpdateNotification />)

    await waitFor(() => {
      expect(screen.getByText('新版本已就绪')).toBeInTheDocument()
    })

    // 「下次启动生效」按钮存在
    const laterBtn = screen.getByText('下次启动生效')
    expect(laterBtn).toBeInTheDocument()

    // 点击 → isDismissed=true → 浮窗消失
    fireEvent.click(laterBtn)
    expect(screen.queryByText('新版本已就绪')).not.toBeInTheDocument()
  })

  // ----------------------------------------------------------------
  // AC4.1 · isMandatory === true → 全屏阻断遮罩（无关闭按钮）
  // ----------------------------------------------------------------
  it('AC4.1-C: isMandatory=true + status=downloading → 全屏阻断遮罩（标题「重要版本更新提示」）', async () => {
    onStatusChangedMock.mockImplementation((cb: any) => {
      cb(
        makeState({
          isMandatory: true,
          status: 'downloading',
          progress: { percent: 45, transferred: 315, total: 700, bytesPerSecond: 2048 }
        })
      )
      return () => {}
    })

    render(<UpdateNotification />)

    await waitFor(() => {
      expect(screen.getByText('重要版本更新提示')).toBeInTheDocument()
    })

    // 强更遮罩**不应**有浮窗右上角的「关闭」按钮（浮窗才有关闭，遮罩无）
    expect(screen.queryByTitle('关闭')).not.toBeInTheDocument()
  })

  // ----------------------------------------------------------------
  // AC4.2 · ERROR 态 → 三个逃生按钮均可见可触发
  // ----------------------------------------------------------------
  it('AC4.2: 强更 ERROR 态 → 重试连接/官网手动下载/退出应用 三按钮均可见且可触发', async () => {
    const checkMock = (window as any).electronAPI.update.check as any
    const exitAppMock = (window as any).electronAPI.update.exitApp as any
    onStatusChangedMock.mockImplementation((cb: any) => {
      cb(
        makeState({
          isMandatory: true,
          status: 'error',
          error: '网络连接超时'
        })
      )
      return () => {}
    })

    render(<UpdateNotification />)

    await waitFor(() => {
      expect(screen.getByText('重要版本更新提示')).toBeInTheDocument()
    })

    // 1. 重试连接按钮可见可触发
    const retryBtn = screen.getByText('重试连接')
    expect(retryBtn).toBeInTheDocument()
    fireEvent.click(retryBtn)
    await waitFor(() => {
      expect(checkMock).toHaveBeenCalled()
    })

    // 2. 官网手动下载按钮可见可触发 → openExternalLink
    const officialBtn = screen.getByText('官网手动下载')
    expect(officialBtn).toBeInTheDocument()
    fireEvent.click(officialBtn)
    expect(openExternalLink).toHaveBeenCalled()

    // 3. 退出应用按钮可见可触发 → exitApp
    const exitBtn = screen.getByText('退出应用')
    expect(exitBtn).toBeInTheDocument()
    fireEvent.click(exitBtn)
    await waitFor(() => {
      expect(exitAppMock).toHaveBeenCalled()
    })
  })

  // ----------------------------------------------------------------
  // 边界 · 无 updateState → 不渲染任何内容
  // ----------------------------------------------------------------
  it('边界: 无更新状态时组件返回 null', async () => {
    getStateMock.mockResolvedValue(null)
    onStatusChangedMock.mockImplementation(() => () => {})

    const { container } = render(<UpdateNotification />)
    expect(container.firstChild).toBeNull()
  })

  // ----------------------------------------------------------------
  // AC4.3 · macOS/Linux 跨平台引导覆盖（打开安装包完成更新）
  // ----------------------------------------------------------------
  it('AC4.3-A: mac/linux + downloaded 强更 → 显示「打开安装包完成更新」并调用 openFileWithDefaultApp', async () => {
    const openMock = vi.fn()
    ;(window as any).electronAPI.utils = { getPlatform: () => 'darwin', openFileWithDefaultApp: openMock }

    onStatusChangedMock.mockImplementation((cb: any) => {
      cb(
        makeState({
          isMandatory: true,
          status: 'downloaded',
          downloadedFilePath: '/tmp/firefly.dmg'
        })
      )
      return () => {}
    })

    render(<UpdateNotification />)

    await waitFor(() => {
      expect(screen.getByText('重要版本更新提示')).toBeInTheDocument()
    })

    // 强更 downloaded 态在 mac/linux 下应显示「打开安装包完成更新」
    const openBtn = await waitFor(() => screen.getByText('打开安装包完成更新'))
    fireEvent.click(openBtn)

    expect(openMock).toHaveBeenCalledWith('/tmp/firefly.dmg')
    // 不应出现 Windows 专属的 quitAndInstall 文案
    expect(screen.queryByText('立即重启并生效')).not.toBeInTheDocument()
  })

  it('AC4.3-B: win32 + downloaded 强更 → 仍走「立即重启并生效」(quitAndInstall)', async () => {
    const openMock = vi.fn()
    ;(window as any).electronAPI.utils = { getPlatform: () => 'win32', openFileWithDefaultApp: openMock }
    const quitMock = (window as any).electronAPI.update.quitAndInstall as any

    onStatusChangedMock.mockImplementation((cb: any) => {
      cb(
        makeState({
          isMandatory: true,
          status: 'downloaded',
          downloadedFilePath: 'C:/tmp/setup.exe'
        })
      )
      return () => {}
    })

    render(<UpdateNotification />)

    await waitFor(() => {
      expect(screen.getByText('重要版本更新提示')).toBeInTheDocument()
    })

    // win32 应走 quitAndInstall 分支
    const restartBtn = await waitFor(() => screen.getByText('立即重启并生效'))
    fireEvent.click(restartBtn)

    expect(quitMock).toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
    expect(screen.queryByText('打开安装包完成更新')).not.toBeInTheDocument()
  })
})
