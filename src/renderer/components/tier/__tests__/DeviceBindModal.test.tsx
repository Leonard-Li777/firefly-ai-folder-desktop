// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const mockSyncFromCloud = vi.fn().mockResolvedValue(undefined)

vi.mock('../../../stores/tier-store', () => ({
  useTierStore: () => ({
    syncFromCloud: mockSyncFromCloud
  })
}))

const mockToastSuccess = vi.fn()
const mockToastWarning = vi.fn()
const mockToastError = vi.fn()

vi.mock('../../common/Toast', () => ({
  toast: {
    success: (...args: any[]) => mockToastSuccess(...args),
    warning: (...args: any[]) => mockToastWarning(...args),
    error: (...args: any[]) => mockToastError(...args)
  }
}))

vi.mock('../DeviceEvictDialog', () => ({
  DeviceEvictDialog: ({ open, sessionToken }: { open: boolean; sessionToken?: string }) =>
    open ? (
      <div data-testid="device-evict-dialog-stub" data-session-token={sessionToken || ''} />
    ) : null
}))

import { DeviceBindModal } from '../DeviceBindModal'

describe('DeviceBindModal (Stage 2 关注公众号填口令 / 邮箱验证码二选一)', () => {
  const mockGetUnseatedSession = vi.fn()
  const mockHasActiveBindSession = vi.fn()
  const mockGetStatus = vi.fn()
  const mockSendEmailOtp = vi.fn()
  const mockCompleteEmailBinding = vi.fn()
  const mockCompleteOaContactBinding = vi.fn()
  const mockCreateCode = vi.fn()
  const mockPollResult = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUnseatedSession.mockResolvedValue({ unseated: false })
    mockHasActiveBindSession.mockResolvedValue(true)
    mockGetStatus.mockResolvedValue({ device_consumed_invitation: false })
    mockCreateCode.mockResolvedValue({
      success: true,
      code: 'MOCK_CODE',
      pollSecret: 'MOCK_SECRET',
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgo='
    })
    mockPollResult.mockResolvedValue({ success: true, status: 'pending' })
    ;(window as any).electronAPI = {
      deviceBind: {
        getUnseatedSession: mockGetUnseatedSession,
        hasActiveBindSession: mockHasActiveBindSession,
        getStatus: mockGetStatus,
        sendEmailOtp: mockSendEmailOtp,
        completeEmailBinding: mockCompleteEmailBinding,
        completeOaContactBinding: mockCompleteOaContactBinding,
        createCode: mockCreateCode,
        pollResult: mockPollResult
      }
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('默认展示「关注公众号填口令」Tab 与公众号二维码、口令输入框', async () => {
    render(<DeviceBindModal open={true} onOpenChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('panel-wechat-oa')).toBeDefined()
    })

    expect(screen.getByTestId('tab-wechat-oa')).toBeDefined()
    expect(screen.getByTestId('tab-email-otp')).toBeDefined()
    expect(screen.getByAltText('萤核智能文件夹公众号二维码')).toBeDefined()
    expect(screen.getByTestId('oa-passcode-input')).toBeDefined()
    expect(screen.queryByTestId('panel-email-otp')).toBeNull()
  })

  it('输入错误口令时直接在前端拦截，不调用 completeOaContactBinding', async () => {
    render(<DeviceBindModal open={true} onOpenChange={vi.fn()} />)

    const passcodeInput = await screen.findByTestId('oa-passcode-input')
    fireEvent.change(passcodeInput, { target: { value: '1234' } })

    const submitBtn = screen.getByTestId('stage2-submit-btn')
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
    })
    expect(mockCompleteOaContactBinding).not.toHaveBeenCalled()
    expect(screen.getByText(/口令不正确/)).toBeDefined()
  })

  it('输入正确口令 7394 与邀请码时调用 completeOaContactBinding 并激活成功', async () => {
    mockCompleteOaContactBinding.mockResolvedValue({
      success: true,
      status: 'active',
      seated: true,
      contact_channel: 'wechat_oa',
      invitation_result: { success: true }
    })

    render(<DeviceBindModal open={true} onOpenChange={vi.fn()} />)

    const passcodeInput = await screen.findByTestId('oa-passcode-input')
    fireEvent.change(passcodeInput, { target: { value: '7394' } })

    const inviteInput = screen.getByPlaceholderText('选填：输入好友的8位或16位邀请码或邀请链接')
    fireEvent.change(inviteInput, { target: { value: 'AB3K7MPQ' } })

    fireEvent.click(screen.getByTestId('stage2-submit-btn'))

    await waitFor(() => {
      expect(mockCompleteOaContactBinding).toHaveBeenCalledWith({
        invitationCode: 'AB3K7MPQ'
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('bind-success-badge')).toBeDefined()
    })
    expect(mockSyncFromCloud).toHaveBeenCalledTimes(1)
  })

  it('可切换至「邮箱验证码」Tab 并完成发送验证码与提交绑定', async () => {
    mockSendEmailOtp.mockResolvedValue({ success: true, cooldown_seconds: 60 })
    mockCompleteEmailBinding.mockResolvedValue({
      success: true,
      status: 'active',
      seated: true,
      contact_channel: 'email'
    })

    render(<DeviceBindModal open={true} onOpenChange={vi.fn()} />)

    const emailTab = await screen.findByTestId('tab-email-otp')
    fireEvent.click(emailTab)

    await waitFor(() => {
      expect(screen.getByTestId('panel-email-otp')).toBeDefined()
    })

    const emailInput = screen.getByPlaceholderText('例如 yourname@qq.com / 163.com')
    const otpInput = screen.getByPlaceholderText('6 位数字')
    fireEvent.change(emailInput, { target: { value: 'user@example.com' } })
    fireEvent.click(screen.getByText('获取验证码'))

    await waitFor(() => {
      expect(mockSendEmailOtp).toHaveBeenCalledWith({ email: 'user@example.com' })
    })

    fireEvent.change(otpInput, { target: { value: '654321' } })
    fireEvent.click(screen.getByTestId('stage2-submit-btn'))

    await waitFor(() => {
      expect(mockCompleteEmailBinding).toHaveBeenCalledWith({
        email: 'user@example.com',
        code: '654321',
        invitationCode: undefined
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('bind-success-badge')).toBeDefined()
    })
  })

  it('当 completeOaContactBinding 返回 need_evict 时打开换绑弹窗', async () => {
    mockCompleteOaContactBinding.mockResolvedValue({
      success: true,
      status: 'need_evict',
      need_evict: true,
      seated: false,
      device_token: 'session-tok-oa-99'
    })

    render(<DeviceBindModal open={true} onOpenChange={vi.fn()} />)

    const passcodeInput = await screen.findByTestId('oa-passcode-input')
    fireEvent.change(passcodeInput, { target: { value: '7394' } })
    fireEvent.click(screen.getByTestId('stage2-submit-btn'))

    await waitFor(() => {
      const evictStub = screen.getByTestId('device-evict-dialog-stub')
      expect(evictStub.getAttribute('data-session-token')).toBe('session-tok-oa-99')
    })
  })
})
