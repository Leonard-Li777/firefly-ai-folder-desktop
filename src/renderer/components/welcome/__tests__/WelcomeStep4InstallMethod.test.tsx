// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

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

import { WelcomeStep4InstallMethod } from '../WelcomeStep4InstallMethod'

describe('WelcomeStep4InstallMethod (欢迎向导第四步：插件安装方式，只选不装)', () => {
  let mockInstall: any

  beforeEach(() => {
    mockInstall = vi.fn().mockResolvedValue({})
    Object.assign(window, {
      electronAPI: {
        modularResource: {
          install: mockInstall,
          importOfflinePackage: vi.fn().mockResolvedValue(null),
          onProgress: vi.fn(() => () => undefined)
        }
      }
    })
  })

  const setup = (overrides: any = {}) => {
    const props = {
      value: 'online' as const,
      onChange: vi.fn(),
      onBack: vi.fn(),
      onNext: vi.fn(),
      ...overrides
    }
    render(<WelcomeStep4InstallMethod {...props} />)
    return props
  }

  it('在线安装与导入离线总包两种方式并列展示，默认选中在线安装', () => {
    setup()

    expect(screen.getByText('插件怎么装？')).toBeDefined()
    expect(screen.getByTestId('welcome-method-online-card')).toBeDefined()
    expect(screen.getByTestId('welcome-method-offline-card')).toBeDefined()
    expect(screen.getByText('在线安装插件')).toBeDefined()
    expect(screen.getByText('导入离线总包')).toBeDefined()

    expect(screen.getByTestId('welcome-method-online-card').className).toContain(
      'border-primary'
    )
    expect(screen.getByTestId('welcome-method-offline-card').className).toContain(
      'border-border'
    )
    expect(screen.getByTestId('welcome-step4-hint').textContent).toContain('功能完全一样')
  })

  it('切换到导入离线总包只上报选择，绝不触发下载或导入', () => {
    const props = setup()

    fireEvent.click(screen.getByTestId('welcome-method-offline-card'))

    expect(props.onChange).toHaveBeenCalledWith('offline')
    expect(mockInstall).not.toHaveBeenCalled()
    expect(screen.getByTestId('welcome-step4-next-btn')).toBeDefined()
  })

  it('value=offline 时高亮离线总包卡片，并说明前面选好的插件在导入后如何生效', () => {
    setup({ value: 'offline' })

    expect(screen.getByTestId('welcome-method-offline-card').className).toContain(
      'border-emerald-500'
    )
    const hint = screen.getByTestId('welcome-step4-offline-hint')
    expect(hint.textContent).toContain('已经带了全部插件')
    expect(hint.textContent).toContain('优先启用')
  })

  it('value=online 时不展示离线总包专属说明', () => {
    setup()
    expect(screen.queryByTestId('welcome-step4-offline-hint')).toBeNull()
  })

  it('本页排在目录选择之后：文案明确插件与文件夹都已选好、下一步才会开始装', () => {
    setup()
    const html = screen.getByTestId('welcome-step4-container').innerHTML
    expect(html).toContain('插件和存放文件夹都定好了')
    expect(html).toContain('存放文件夹上一步已经选好')
    expect(html).not.toContain('后面选好存放文件夹')
  })

  it('底部按钮：返回触发 onBack，下一步触发 onNext', () => {
    const props = setup()

    fireEvent.click(screen.getByTestId('welcome-step4-back-btn'))
    expect(props.onBack).toHaveBeenCalledTimes(1)
    expect(props.onNext).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('welcome-step4-next-btn'))
    expect(props.onNext).toHaveBeenCalledTimes(1)
  })

  it('明暗自适应：不得写死亮色色值', () => {
    setup()
    const html = screen.getByTestId('welcome-step4-container').innerHTML
    // 明暗自适应：必须使用主题语义色，严禁写死仅适配亮色的色值
    expect(html).not.toMatch(/\b(bg-white|bg-slate-\d+|text-slate-\d+|border-slate-\d+)\b/)
    expect(html).toContain('text-muted-foreground')
  })
})
