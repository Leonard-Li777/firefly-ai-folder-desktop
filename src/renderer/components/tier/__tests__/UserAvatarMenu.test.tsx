// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { act } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { UserTier } from '@firefly/shared'

const mockLogout = vi.fn().mockResolvedValue(undefined)
const mockFetchProfile = vi.fn().mockResolvedValue(undefined)
const mockOpenRulesDialog = vi.fn()
const mockOpenSettings = vi.fn()

vi.mock('../../../stores/tier-store', () => ({
  useTierStore: () => ({
    tier: UserTier.PRO,
    firecores: 1000,
    subscription: {
      expires_at: '2028-12-31T23:59:59Z',
      plan: 'pro'
    },
    fetchProfile: mockFetchProfile,
    openRulesDialog: mockOpenRulesDialog,
    logout: mockLogout
  })
}))

vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: () => ({
    openSettings: mockOpenSettings
  })
}))

vi.mock('../../../stores/config-store', () => ({
  useConfigStore: (selector: any) => selector({ config: {} })
}))

vi.mock('../../../stores/analysis-queue-store', () => ({
  useAnalysisQueueStore: {
    getState: () => ({
      toggleQueue: vi.fn()
    })
  }
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/' })
}))

vi.mock('@app/languages', () => ({
  t: (key: string) => key
}))

import { UserAvatarMenu } from '../UserAvatarMenu'

describe('UserAvatarMenu - 退出登录功能', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('点击头像展开菜单后，能在右上角看到退出登录按钮', () => {
    render(<UserAvatarMenu />)

    // 点击头像按钮展开菜单
    const avatarTrigger = screen.getByRole('button')
    fireEvent.click(avatarTrigger)

    // 右上角应展示退出登录按钮
    const logoutBtn = screen.getByTestId('user-avatar-logout-btn')
    expect(logoutBtn).toBeDefined()
    expect(logoutBtn.textContent).toContain('退出登录')
  })

  it('点击退出登录直接执行登出逻辑，无需二次确认阻断', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')

    render(<UserAvatarMenu />)

    // 展开菜单
    const avatarTrigger = screen.getByRole('button')
    fireEvent.click(avatarTrigger)

    const logoutBtn = screen.getByTestId('user-avatar-logout-btn')
    await act(async () => {
      fireEvent.click(logoutBtn)
    })

    // 无二次弹窗，直接触发 logout
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(mockLogout).toHaveBeenCalledTimes(1)
  })
})
