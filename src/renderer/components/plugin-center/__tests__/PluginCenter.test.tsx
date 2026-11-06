// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'

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

vi.mock('@voerkai18n/react', () => ({
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
}))

// Mock 子设置组件，加速渲染并隔离复杂依赖
vi.mock('../../settings/ai-engine-config-settings', () => ({
  AIEngineConfigSettings: () => (
    <div data-testid="mock-ai-engine-settings">AI Engine Settings Mock</div>
  )
}))

vi.mock('../../settings/tts-settings', () => ({
  TTSSettings: () => <div data-testid="mock-tts-settings">TTS Settings Mock</div>
}))

import { PluginCard, formatBytes } from '../PluginCard'
import { PluginCenterOverlay } from '../PluginCenterOverlay'
import { usePluginCenterStore, type PluginModuleItem } from '../../../stores/plugin-center-store'

describe('formatBytes', () => {
  it('正确换算字节为 MB / GB 且保留一位小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(216426086)).toBe('206.4 MB')
    expect(formatBytes(2314200000)).toBe('2.2 GB')
    expect(formatBytes(94500000)).toBe('90.1 MB')
  })
})

describe('PluginCard (插件卡片精简与状态呈现)', () => {
  const baseModule: PluginModuleItem = {
    id: 'offline_tts',
    name: '离线语音合成 TTS',
    version: '1.0.0',
    category: 'media',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    total_bytes: 216426086,
    install_state: 'active',
    description: '高质量离线自然语音朗读与伴音生成',
    icon: 'Volume2'
  }

  it('去除依赖资源折叠项，仅展示安装包总体积', () => {
    render(<PluginCard module={baseModule} />)
    expect(screen.getByText(/安装包总体积: 206.4 MB/)).toBeInTheDocument()
    // 断言不存在任何 Dependencies 或 依赖项 折叠文本
    expect(screen.queryByText(/Dependencies/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/依赖资源/i)).not.toBeInTheDocument()
  })

  it('官方插件作者动态输出 Firefly 官方', () => {
    render(<PluginCard module={baseModule} />)
    expect(screen.getByText('Firefly 官方')).toBeInTheDocument()
  })

  it('即将推出模块（如本地生图）：右上角展示即将推出灰度徽标且卡片禁用', () => {
    const comingSoonModule: PluginModuleItem = {
      ...baseModule,
      id: 'diffusion_studio',
      name: '本地生图 Studio',
      availability: 'coming_soon',
      install_state: 'not_installed'
    }

    render(<PluginCard module={comingSoonModule} />)
    const badges = screen.getAllByTestId('coming-soon-badge')
    expect(badges.length).toBeGreaterThan(0)
    expect(badges[0]).toHaveTextContent('即将推出')

    const disabledBtn = screen.getByRole('button', { name: '即将推出' })
    expect(disabledBtn).toBeDisabled()
  })

  it('未安装状态：展示下载安装按钮并触发回调', () => {
    const onInstall = vi.fn()
    const notInstalledModule: PluginModuleItem = {
      ...baseModule,
      install_state: 'not_installed'
    }

    render(<PluginCard module={notInstalledModule} onInstall={onInstall} />)
    const installBtn = screen.getByRole('button', { name: /下载安装/ })
    expect(installBtn).toBeInTheDocument()
    fireEvent.click(installBtn)
    expect(onInstall).toHaveBeenCalledWith('offline_tts')
  })

  it('下载中状态：展示复合进度条、速度与断点续传标记', () => {
    const downloadingModule: PluginModuleItem = {
      ...baseModule,
      install_state: 'downloading',
      download_progress: {
        percentage: 68,
        speed_bytes_per_sec: 1024 * 1024 * 5.5,
        is_resumed: true
      }
    }

    render(<PluginCard module={downloadingModule} />)
    expect(screen.getByText(/正在下载安装包/)).toBeInTheDocument()
    expect(screen.getByText('断点续传')).toBeInTheDocument()
    expect(screen.getByText(/68%/)).toBeInTheDocument()
    expect(screen.getByText(/5.5 MB\/s/)).toBeInTheDocument()
  })

  it('已安装状态：展示已启用 Switch 开关与配置按钮并触发回调', () => {
    const onToggleActive = vi.fn()
    const onConfigure = vi.fn()

    render(
      <PluginCard module={baseModule} onToggleActive={onToggleActive} onConfigure={onConfigure} />
    )

    const switchEl = screen.getByRole('switch', { name: '已启用' })
    expect(switchEl).toBeInTheDocument()
    expect(switchEl).toBeChecked()

    const configBtn = screen.getByRole('button', { name: /配置/ })
    expect(configBtn).toBeInTheDocument()
    fireEvent.click(configBtn)
    expect(onConfigure).toHaveBeenCalledWith('offline_tts')
  })
})

describe('PluginCenterOverlay (弹层交互、失焦保护与配置挂载)', () => {
  beforeEach(() => {
    act(() => {
      usePluginCenterStore.getState().resetForTest()
    })
  })

  it('打开弹层后渲染插件卡片，支持分类切换与关键词搜索', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByTestId('plugin-center-overlay')).toBeInTheDocument()
    expect(screen.getByText('全部插件')).toBeInTheDocument()

    // 搜索关键词
    const searchInput = screen.getByPlaceholderText('搜索插件名称或描述...')
    fireEvent.change(searchInput, { target: { value: 'TTS' } })

    // 应该只展示 TTS 插件卡片
    expect(screen.getByText('离线语音合成 TTS')).toBeInTheDocument()
    expect(screen.queryByText('CAD / 3D 图纸模型解析器')).not.toBeInTheDocument()
  })

  it('点击高级 AI 引擎配置按钮时挂载 AIEngineConfigSettings', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('advanced_ai_engine')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByTestId('mock-ai-engine-settings')).toBeInTheDocument()
    expect(screen.getByText('返回')).toBeInTheDocument()

    // 点击返回
    fireEvent.click(screen.getByText('返回'))
    expect(usePluginCenterStore.getState().configuringModuleId).toBeNull()
  })

  it('点击离线 TTS 配置按钮时挂载 TTSSettings', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('offline_tts')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByTestId('mock-tts-settings')).toBeInTheDocument()
  })

  it('点击其他支持 schema 的插件配置按钮时展示自定义 JSON 配置插槽', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('cad_3d_parser')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByText(/插件个性化配置项/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/请输入符合插件定义的 JSON 配置项/)).toBeInTheDocument()

    // 输入自定义 JSON 配置并保存
    const textarea = screen.getByPlaceholderText(/请输入符合插件定义的 JSON 配置项/)
    fireEvent.change(textarea, { target: { value: '{"renderQuality": "high"}' } })
    fireEvent.click(screen.getByText('保存配置'))

    expect(usePluginCenterStore.getState().configuringModuleId).toBeNull()
    const updated = usePluginCenterStore.getState().modules.find(m => m.id === 'cad_3d_parser')
    expect(updated?.user_config).toBe('{"renderQuality": "high"}')
  })

  it('自定义配置保存时拦截非法 JSON 并显示错误提示', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('cad_3d_parser')
    })

    render(<PluginCenterOverlay />)
    const textarea = screen.getByPlaceholderText(/请输入符合插件定义的 JSON 配置项/)
    fireEvent.change(textarea, { target: { value: '{ invalid json }' } })
    fireEvent.click(screen.getByText('保存配置'))

    // 仍停留在配置页面且报错
    expect(usePluginCenterStore.getState().configuringModuleId).toBe('cad_3d_parser')
    expect(screen.getByText(/配置格式错误，必须为合法的 JSON 格式字符串/)).toBeInTheDocument()
  })

  it('下载进度流转与安装状态切换完整验证', () => {
    act(() => {
      usePluginCenterStore.getState().installPlugin('asr_engine')
    })

    let asr = usePluginCenterStore.getState().modules.find(m => m.id === 'asr_engine')
    expect(asr?.install_state).toBe('downloading')

    act(() => {
      usePluginCenterStore.getState().updateDownloadProgress('asr_engine', {
        percentage: 100,
        speed_bytes_per_sec: 1024 * 1024 * 10,
        is_resumed: false
      })
    })

    asr = usePluginCenterStore.getState().modules.find(m => m.id === 'asr_engine')
    expect(asr?.install_state).toBe('active')
  })
})
