// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

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
import { PluginListItem, getPluginIcon, PLUGIN_ICON_MAP } from '../PluginListItem'
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

  it('已安装状态：展示【停用】、【配置】与【卸载】按钮并支持防误删确认弹窗 (TC-04)', () => {
    const onToggleActive = vi.fn()
    const onConfigure = vi.fn()
    const onUninstall = vi.fn()

    render(
      <PluginCard
        module={{ ...baseModule, capability_slot: 'voice_tts', slot_policy: 'exclusive_optional' }}
        slotPolicy="exclusive_optional"
        onToggleActive={onToggleActive}
        onConfigure={onConfigure}
        onUninstall={onUninstall}
      />
    )

    // 废除旧版 Switch 与单插件导出按钮
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('export-plugin-btn')).not.toBeInTheDocument()

    // 渲染停用按钮并触发回调
    const deactivateBtn = screen.getByTestId('deactivate-plugin-btn-offline_tts')
    expect(deactivateBtn).toHaveTextContent('停用')
    fireEvent.click(deactivateBtn)
    expect(onToggleActive).toHaveBeenCalledWith('offline_tts', false)

    const configBtn = screen.getByRole('button', { name: /配置/ })
    expect(configBtn).toBeInTheDocument()
    fireEvent.click(configBtn)
    expect(onConfigure).toHaveBeenCalledWith('offline_tts')

    // 点击卸载按钮 -> 弹出防误删确认弹窗并展示预计释放空间 (206.4 MB)
    const uninstallBtn = screen.getByTestId('uninstall-plugin-btn')
    fireEvent.click(uninstallBtn)
    const dialog = screen.getByTestId('plugin-confirm-dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent('确认卸载插件')
    expect(screen.getByTestId('confirm-dialog-desc')).toHaveTextContent(/206\.4 MB/)

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm-btn'))
    expect(onUninstall).toHaveBeenCalledWith('offline_tts')
  })

  it('崩溃态 (is_crashed = true)：同时展示崩溃警示、【重启】与【卸载】按钮并可安全卸载解除死锁 (TC-08)', () => {
    const onRestart = vi.fn()
    const onUninstall = vi.fn()
    const crashedModule: PluginModuleItem = {
      ...baseModule,
      install_state: 'active',
      is_crashed: true,
      slot_policy: 'exclusive_optional'
    }

    render(
      <PluginCard
        module={crashedModule}
        slotPolicy="exclusive_optional"
        onRestart={onRestart}
        onUninstall={onUninstall}
      />
    )

    expect(screen.getByTestId('crashed-badge')).toHaveTextContent('已崩溃，点击重启')
    const restartBtn = screen.getByTestId('restart-plugin-btn')
    expect(restartBtn).toHaveTextContent('重启')
    fireEvent.click(restartBtn)
    expect(onRestart).toHaveBeenCalledWith('offline_tts')

    const uninstallBtn = screen.getByTestId('uninstall-plugin-btn')
    expect(uninstallBtn).toBeInTheDocument()
    fireEvent.click(uninstallBtn)
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm-btn'))
    expect(onUninstall).toHaveBeenCalledWith('offline_tts')
  })

  it('动态图标映射 getPluginIcon 覆盖已知图标并在未知名称时回落 Package (TC-07)', () => {
    expect(getPluginIcon('Feather')).toBe(PLUGIN_ICON_MAP.feather)
    expect(getPluginIcon('Layers')).toBe(PLUGIN_ICON_MAP.layers)
    expect(getPluginIcon('Cpu')).toBe(PLUGIN_ICON_MAP.cpu)
    expect(getPluginIcon('ShieldAlert')).toBe(PLUGIN_ICON_MAP['shield-alert'])
    expect(getPluginIcon('Mic')).toBe(PLUGIN_ICON_MAP.mic)
    expect(getPluginIcon('Volume2')).toBe(PLUGIN_ICON_MAP['volume-2'])
    expect(getPluginIcon('Zap')).toBe(PLUGIN_ICON_MAP.zap)
    expect(getPluginIcon('Archive')).toBe(PLUGIN_ICON_MAP.archive)
    expect(getPluginIcon('nonexistent-icon-xyz', 'custom_unknown_id')).toBe(PLUGIN_ICON_MAP.package)
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
    fireEvent.change(searchInput, { target: { value: '朗读' } })

    // 应该只展示语音朗读相关插件卡片，不展示压缩包透视
    expect(screen.getByText('个性化声音克隆与朗读')).toBeInTheDocument()
    expect(screen.getByText('极速语音合成与朗读')).toBeInTheDocument()
    expect(screen.queryByText(/压缩包透视/)).not.toBeInTheDocument()

    // 清空搜索并切换至「格式解析」分类，验证 archive_vfs_parser 已归入 parser 分类
    fireEvent.change(searchInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '格式解析' }))
    expect(screen.getByText(/压缩包透视/)).toBeInTheDocument()
  })

  it('点击高级 AI 引擎配置按钮时挂载 AIEngineConfigSettings', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('engine_classic_light')
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
      usePluginCenterStore.getState().setConfiguringModuleId('tts_moss_onnx')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByTestId('mock-tts-settings')).toBeInTheDocument()
  })

  it('点击其他支持 schema 的插件配置按钮时展示自定义 JSON 配置插槽', async () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('archive_vfs_parser')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByText(/插件个性化配置项/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/请输入插件参数配置内容/)).toBeInTheDocument()

    // 输入自定义 JSON 配置并保存
    const textarea = screen.getByPlaceholderText(/请输入插件参数配置内容/)
    fireEvent.change(textarea, { target: { value: '{"renderQuality": "high"}' } })
    await act(async () => {
      fireEvent.click(screen.getByText('保存配置'))
    })

    expect(usePluginCenterStore.getState().configuringModuleId).toBeNull()
    const updated = usePluginCenterStore.getState().modules.find(m => m.id === 'archive_vfs_parser')
    expect(updated?.user_config).toBe('{"renderQuality": "high"}')
  })

  it('自定义配置保存时拦截非法 JSON 并显示错误提示；后端拒绝时回滚并停留配置页', async () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('archive_vfs_parser')
    })

    render(<PluginCenterOverlay />)
    const textarea = screen.getByPlaceholderText(/请输入插件参数配置内容/)
    fireEvent.change(textarea, { target: { value: '{ invalid json }' } })
    await act(async () => {
      fireEvent.click(screen.getByText('保存配置'))
    })

    // 仍停留在配置页面且报错
    expect(usePluginCenterStore.getState().configuringModuleId).toBe('archive_vfs_parser')
    expect(screen.getByText(/配置内容格式有误/)).toBeInTheDocument()

    // 模拟后端抛出 INVALID_USER_CONFIG 时应回滚且停留配置页展示大白话错误
    const { setModularResourceBridgeForTest } = await import('../../../stores/plugin-center-store')
    setModularResourceBridgeForTest({
      updateState: vi.fn().mockRejectedValue(new Error('INVALID_USER_CONFIG: 非法格式'))
    } as any)
    try {
      fireEvent.change(textarea, { target: { value: '{"renderQuality": "ultra"}' } })
      await act(async () => {
        fireEvent.click(screen.getByText('保存配置'))
      })
      expect(usePluginCenterStore.getState().configuringModuleId).toBe('archive_vfs_parser')
      expect(screen.getByText(/配置格式不正确/)).toBeInTheDocument()
      const modAfter = usePluginCenterStore
        .getState()
        .modules.find(m => m.id === 'archive_vfs_parser')
      expect(modAfter?.user_config).toBeUndefined()
    } finally {
      setModularResourceBridgeForTest(null)
    }

    // M4: 重新打开带有历史 user_config 的插件时自动回显，切换未配置插件时自动清空旧草稿与错误
    act(() => {
      usePluginCenterStore.setState(state => ({
        ...state,
        configuringModuleId: 'perception_nsfw',
        modules: state.modules.map(m =>
          m.id === 'perception_nsfw' ? { ...m, user_config: '{"threshold":0.8}' } : m
        )
      }))
    })
    expect(
      (screen.getByPlaceholderText(/请输入插件参数配置内容/) as HTMLTextAreaElement).value
    ).toBe('{"threshold":0.8}')
    expect(screen.queryByText(/配置格式不正确/)).not.toBeInTheDocument()

    act(() => {
      usePluginCenterStore.getState().setConfiguringModuleId('archive_vfs_parser')
    })
    expect(
      (screen.getByPlaceholderText(/请输入插件参数配置内容/) as HTMLTextAreaElement).value
    ).toBe('')
  })

  it('下载进度流转与安装状态切换完整验证', () => {
    const targetId = usePluginCenterStore
      .getState()
      .modules.some(m => m.id === 'asr_sensevoice_onnx')
      ? 'asr_sensevoice_onnx'
      : 'asr_engine'

    act(() => {
      usePluginCenterStore.getState().installPlugin(targetId)
    })

    let asr = usePluginCenterStore.getState().modules.find(m => m.id === targetId)
    expect(asr?.install_state).toBe('downloading')

    act(() => {
      usePluginCenterStore.getState().updateDownloadProgress(targetId, {
        percentage: 80,
        speed_bytes_per_sec: 1024 * 1024 * 10,
        is_resumed: false
      })
    })

    asr = usePluginCenterStore.getState().modules.find(m => m.id === targetId)
    expect(asr?.install_state).toBe('downloading')
    expect(asr?.download_progress?.percentage).toBe(80)
  })

  it('未打开时不渲染任何 DOM 节点 (return null)', () => {
    act(() => {
      usePluginCenterStore.getState().closeOverlay()
    })
    const { container } = render(<PluginCenterOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('呈现与全局搜索完全一致的主内容区域全局覆盖形态 (非弹窗)', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    render(<PluginCenterOverlay />)
    const overlay = screen.getByTestId('plugin-center-overlay')
    expect(overlay).toBeInTheDocument()
    expect(overlay).toHaveClass('absolute')
    expect(overlay).toHaveClass('inset-x-0')
    expect(overlay).toHaveClass('bottom-0')
    expect(overlay).toHaveClass('z-30')
    expect(overlay).toHaveClass('bg-background')
    expect(overlay.style.top).toBe('var(--app-header-height, 53px)')
  })

  it('点击右上角关闭按钮或按 Esc 键可退出插件中心', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    const { unmount } = render(<PluginCenterOverlay />)
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(true)

    // 点击右上角关闭按钮
    const closeBtn = screen.getByTitle('关闭插件中心 (Esc)')
    fireEvent.click(closeBtn)
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)

    unmount()

    // 重新打开，测试 Esc 快捷键关闭
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    render(<PluginCenterOverlay />)
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
  })

  it('在配置子模式下按 Esc 键优先返回插件列表而不是关闭覆盖层', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('advanced_ai_engine')
    })
    render(<PluginCenterOverlay />)
    expect(usePluginCenterStore.getState().configuringModuleId).toBe('advanced_ai_engine')

    // 按 Esc 键
    fireEvent.keyDown(window, { key: 'Escape' })
    // configuringModuleId 变为 null，但 isOverlayOpen 仍为 true
    expect(usePluginCenterStore.getState().configuringModuleId).toBeNull()
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(true)

    // 再次按 Esc 键，退出覆盖层
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(usePluginCenterStore.getState().isOverlayOpen).toBe(false)
  })

  it('PluginListItem 作为 List 行组件可正确呈现插件信息', () => {
    const mockModule: PluginModuleItem = {
      id: 'test_plugin',
      name: '测试扩展组件',
      version: '2.1.0',
      category: 'perception',
      author_code: 'community',
      author_name: '社区开发者',
      availability: 'available',
      total_bytes: 104857600, // 100 MB
      install_state: 'not_installed',
      description: '这是测试插件的详细功能说明'
    }
    render(<PluginListItem module={mockModule} />)
    expect(screen.getByText('测试扩展组件')).toBeInTheDocument()
    expect(screen.getByText('v2.1.0')).toBeInTheDocument()
    expect(screen.getByText('感知分析')).toBeInTheDocument()
    expect(screen.getByText('社区开发者')).toBeInTheDocument()
    expect(screen.getByText('这是测试插件的详细功能说明')).toBeInTheDocument()
    expect(screen.getByText(/安装包总体积: 100.0 MB/)).toBeInTheDocument()
  })
})

describe('方案 A: 能力槽位聚类分组与互斥语义 (Slot Grouping & Mutual Exclusion)', () => {
  beforeEach(() => {
    act(() => {
      usePluginCenterStore.getState().resetForTest()
    })
  })

  it('按能力槽位聚类分组渲染，展示对应槽位头部与排他策略 Badge', () => {
    act(() => {
      usePluginCenterStore.setState(state => ({
        ...state,
        isOverlayOpen: true,
        modules: [
          ...state.modules,
          {
            id: 'custom_general_tool',
            name: '智能扩展工具示例',
            version: '1.0.0',
            category: 'tool',
            capability_slot: 'general',
            slot_policy: 'multi_active',
            author_code: 'official',
            availability: 'approved',
            total_bytes: 1024,
            install_state: 'not_installed'
          } as any
        ]
      }))
    })
    render(<PluginCenterOverlay />)

    // 检查基础语义嵌入引擎槽位分组
    const embeddingGroup = screen.getByTestId('slot-group-base_embedding')
    expect(embeddingGroup).toBeInTheDocument()
    expect(embeddingGroup).toHaveTextContent('基础语义检索引擎')
    expect(embeddingGroup).toHaveTextContent('必选单例 · 二选一互斥')

    // 检查语音合成槽位分组
    const ttsGroup = screen.getByTestId('slot-group-voice_tts')
    expect(ttsGroup).toBeInTheDocument()
    expect(ttsGroup).toHaveTextContent('离线语音合成与朗读')
    expect(ttsGroup).toHaveTextContent('选配单选 · 互斥生效')

    // 检查本地生图已正确归位至高级视觉生成引擎槽位（不再错误掉入 general）
    const advGroup = screen.getByTestId('slot-group-advanced_ai_engine')
    expect(advGroup).toBeInTheDocument()
    expect(advGroup).toHaveTextContent('高级视觉生成引擎')
    expect(advGroup).toHaveTextContent('选配单选 · 独显推荐')

    // 检查通用多活槽位分组
    const generalGroup = screen.getByTestId('slot-group-general')
    expect(generalGroup).toBeInTheDocument()
    expect(generalGroup).toHaveTextContent('智能工具与扩展技能')
    expect(generalGroup).toHaveTextContent('多选并发 · 独立运行')
  })

  it('TC-02: exclusive_required 槽位激活项仅显示使用中徽标且无停用/卸载按钮，Store 侧亦拦截直接停用', async () => {
    act(() => {
      usePluginCenterStore.setState(state => ({
        ...state,
        isOverlayOpen: true,
        modules: state.modules.map(m =>
          m.id === 'engine_classic_light' ? { ...m, install_state: 'active' } : m
        )
      }))
    })
    render(<PluginCenterOverlay />)

    // 分组容器存在且包含槽位互斥标记
    expect(screen.getByTestId('slot-group-base_embedding')).toBeInTheDocument()

    // 查找 engine_classic_light (已激活的 exclusive_required 插件)
    const classicLightCard = screen.getByTestId('plugin-card-engine_classic_light')
    expect(classicLightCard).toBeInTheDocument()

    // 激活态必选底座只展示「使用中」徽标，无 Switch、无停用按钮、无卸载按钮
    expect(within(classicLightCard).getByTestId('active-in-use-badge')).toHaveTextContent('使用中')
    expect(within(classicLightCard).queryByRole('switch')).not.toBeInTheDocument()
    expect(
      within(classicLightCard).queryByTestId('deactivate-plugin-btn-engine_classic_light')
    ).not.toBeInTheDocument()
    expect(within(classicLightCard).queryByTestId('uninstall-plugin-btn')).not.toBeInTheDocument()

    // 即使代码层直接调用 Store togglePluginActive 尝试停用，也应拦截并保持 active
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await act(async () => {
        await usePluginCenterStore.getState().togglePluginActive('engine_classic_light', false)
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('拒绝停用必选底座'))
    } finally {
      warnSpy.mockRestore()
    }

    const mod = usePluginCenterStore.getState().modules.find(m => m.id === 'engine_classic_light')
    expect(mod?.install_state).toBe('active')
  })

  it('TC-13 UI: 必选底座存在健康备选 (can_uninstall=true) 时展示【切换并卸载】并弹窗提示', async () => {
    const seededModules = usePluginCenterStore.getState().modules.map(m => {
      if (m.id === 'engine_classic_light') {
        return { ...m, install_state: 'active' as const, can_uninstall: true }
      }
      if (m.id === 'engine_gemma_unified') {
        return { ...m, install_state: 'installed_inactive' as const, can_activate: true }
      }
      return m
    })
    const mockUninstall = vi.fn().mockResolvedValue({
      id: 'engine_classic_light',
      install_state: 'not_installed'
    })
    const { setModularResourceBridgeForTest } = await import('../../../stores/plugin-center-store')
    setModularResourceBridgeForTest({
      list: vi.fn().mockResolvedValue(seededModules),
      uninstall: mockUninstall
    } as any)

    try {
      await act(async () => {
        await usePluginCenterStore.getState().openOverlay()
      })

      render(<PluginCenterOverlay />)

      const classicCard = screen.getByTestId('plugin-card-engine_classic_light')
      expect(within(classicCard).getByTestId('active-in-use-badge')).toHaveTextContent('使用中')
      const switchUninstallBtn = within(classicCard).getByTestId('uninstall-plugin-btn')
      expect(switchUninstallBtn).toHaveTextContent('切换并卸载')

      await act(async () => {
        fireEvent.click(switchUninstallBtn)
      })

      expect(screen.getByTestId('confirm-dialog-title')).toHaveTextContent('确认切换并卸载当前引擎')
      expect(screen.getByTestId('confirm-dialog-desc')).toHaveTextContent(
        /自动切换至同类型的另一款已安装引擎/
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('confirm-dialog-confirm-btn'))
      })
      expect(mockUninstall).toHaveBeenCalledWith('engine_classic_light')
    } finally {
      setModularResourceBridgeForTest(null)
    }
  })

  it('C2 UI: 排他切换后前任插件恢复 can_activate=true，无需关窗即可再次切换回来', async () => {
    act(() => {
      usePluginCenterStore.setState({
        isOverlayOpen: true,
        isTogglingSlot: false,
        modules: [
          {
            id: 'tts_moss_onnx',
            name: 'MossTTS 离线语音合成',
            version: '1.0.0',
            category: 'media',
            capability_slot: 'voice_tts',
            slot_policy: 'exclusive_optional',
            author_code: 'official',
            author_name: null,
            availability: 'approved',
            total_bytes: 200000000,
            install_state: 'active',
            can_activate: false,
            description: 'MossTTS 离线模型',
            icon: 'Volume2'
          },
          {
            id: 'tts_chat_onnx',
            name: 'ChatTTS 拟真语音合成',
            version: '1.0.0',
            category: 'media',
            capability_slot: 'voice_tts',
            slot_policy: 'exclusive_optional',
            author_code: 'community',
            author_name: 'TTS Community',
            availability: 'approved',
            total_bytes: 300000000,
            install_state: 'installed_inactive',
            can_activate: true,
            description: 'ChatTTS 离线模型',
            icon: 'Volume2'
          }
        ]
      })
    })

    render(<PluginCenterOverlay />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('activate-plugin-btn-tts_chat_onnx'))
    })
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'tts_chat_onnx')?.install_state
    ).toBe('active')

    // 切换后前任 MossTTS 的【启用】按钮必须可点击（不再被 can_activate=false 锁死）
    const mossActivateBtn = screen.getByTestId('activate-plugin-btn-tts_moss_onnx')
    expect(mossActivateBtn).not.toBeDisabled()

    await act(async () => {
      fireEvent.click(mossActivateBtn)
    })
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'tts_moss_onnx')?.install_state
    ).toBe('active')
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'tts_chat_onnx')?.install_state
    ).toBe('installed_inactive')
  })

  it('TC-03 / TC-04 / TC-07: exclusive_optional 零阻断单选切换、并发防连点锁及已安装视图插槽归属徽标', async () => {
    // 设置初始状态：给 voice_tts 槽位添加两个插件，一个已激活，一个已安装但未激活
    act(() => {
      usePluginCenterStore.setState({
        isOverlayOpen: true,
        isTogglingSlot: false,
        modules: [
          {
            id: 'tts_moss_onnx',
            name: 'MossTTS 离线语音合成',
            version: '1.0.0',
            category: 'media',
            capability_slot: 'voice_tts',
            slot_policy: 'exclusive_optional',
            author_code: 'official',
            author_name: null,
            availability: 'available',
            total_bytes: 200000000,
            install_state: 'active',
            description: 'MossTTS 离线模型',
            icon: 'Volume2'
          },
          {
            id: 'tts_chat_onnx',
            name: 'ChatTTS 拟真语音合成',
            version: '1.0.0',
            category: 'media',
            capability_slot: 'voice_tts',
            slot_policy: 'exclusive_optional',
            author_code: 'community',
            author_name: 'TTS Community',
            availability: 'available',
            total_bytes: 300000000,
            install_state: 'installed_inactive',
            description: 'ChatTTS 离线模型',
            icon: 'Volume2'
          }
        ]
      })
    })

    render(<PluginCenterOverlay />)

    // 分组容器存在
    expect(screen.getByTestId('slot-group-voice_tts')).toBeInTheDocument()

    const chatTtsCard = screen.getByTestId('plugin-card-tts_chat_onnx')
    expect(chatTtsCard).toBeInTheDocument()

    // 验证 isTogglingSlot 为 true 时激活按钮处于禁用状态（防并发连点竞态）
    act(() => {
      usePluginCenterStore.setState({ isTogglingSlot: true })
    })
    expect(within(chatTtsCard).getByTestId('activate-plugin-btn-tts_chat_onnx')).toBeDisabled()
    act(() => {
      usePluginCenterStore.setState({ isTogglingSlot: false })
    })

    // 点击 ChatTTS 的【启用】按钮（零弹窗阻断直接切换）
    const chatTtsActivateBtn = within(chatTtsCard).getByTestId('activate-plugin-btn-tts_chat_onnx')
    await act(async () => {
      fireEvent.click(chatTtsActivateBtn)
    })

    // 未出现切换互斥确认弹窗
    expect(screen.queryByText('确认切换生效插件？')).not.toBeInTheDocument()

    // 断言 ChatTTS 激活，而 MossTTS 自动被互斥停用
    const chatMod = usePluginCenterStore.getState().modules.find(m => m.id === 'tts_chat_onnx')
    const mossMod = usePluginCenterStore.getState().modules.find(m => m.id === 'tts_moss_onnx')
    expect(chatMod?.install_state).toBe('active')
    expect(mossMod?.install_state).toBe('installed_inactive')

    // 切换至「已安装」Tab，验证卡片显示插槽归属徽标 slot-ownership-badge
    fireEvent.click(screen.getByRole('button', { name: /已安装/ }))
    const ownershipBadges = screen.getAllByTestId('slot-ownership-badge')
    expect(ownershipBadges.length).toBeGreaterThanOrEqual(2)
    expect(ownershipBadges[0]).toHaveTextContent(/离线语音合成与朗读/)
  })
})

describe('Ticket 05: 开发者模式双视图、4态徽标与安装事实门禁', () => {
  beforeEach(async () => {
    const { setModularResourceBridgeForTest } = await import('../../../stores/plugin-center-store')
    setModularResourceBridgeForTest(null)
    act(() => {
      usePluginCenterStore.getState().resetForTest()
    })
  })

  it('四态徽标正确展示：draft、delisted(一般下架)与安全违规(security_violation)', () => {
    const draftModule: PluginModuleItem = {
      id: 'local_draft_plugin',
      name: '本地草稿插件',
      version: '0.1.0',
      category: 'tool',
      author_code: 'third_party',
      availability: 'draft',
      total_bytes: 1024,
      install_state: 'installed_inactive',
      description: '本地草稿调试中'
    }
    const delistedGeneralModule: PluginModuleItem = {
      id: 'old_parser',
      name: '老旧解析器',
      version: '1.0.0',
      category: 'parser',
      author_code: 'official',
      availability: 'delisted',
      delist_reason: 'general_deprecation',
      total_bytes: 2048,
      install_state: 'not_installed',
      description: '已弃用'
    }
    const delistedSecurityModule: PluginModuleItem = {
      id: 'malicious_plugin',
      name: '恶意插件',
      version: '1.0.0',
      category: 'tool',
      author_code: 'community',
      availability: 'delisted',
      delist_reason: 'security_violation',
      total_bytes: 4096,
      install_state: 'installed_inactive',
      description: '存在安全漏洞'
    }

    const { rerender } = render(<PluginCard module={draftModule} />)
    expect(screen.getByTestId('draft-badge')).toHaveTextContent('开发版')

    rerender(<PluginCard module={delistedGeneralModule} />)
    expect(screen.getByTestId('delisted-badge')).toHaveTextContent('已下架')
    expect(screen.getByText('该模块已下架，不可安装')).toBeInTheDocument()

    rerender(<PluginCard module={delistedSecurityModule} />)
    expect(screen.getByTestId('security-violation-badge')).toHaveTextContent('安全停用')
    expect(screen.getByText('安全阻断')).toBeInTheDocument()
    // 安全阻断下没有开关
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('安装事实门禁：can_install===false 禁用下载按钮；can_activate===false 禁用启用Switch', () => {
    const cannotInstallModule: PluginModuleItem = {
      id: 'huge_model',
      name: '超大模型',
      version: '1.0.0',
      category: 'ai-engine',
      author_code: 'official',
      availability: 'approved',
      total_bytes: 9999999999,
      install_state: 'not_installed',
      can_install: false,
      description: '磁盘不足不可安装'
    }
    const cannotActivateModule: PluginModuleItem = {
      id: 'broken_plugin',
      name: '依赖缺失插件',
      version: '1.0.0',
      category: 'tool',
      author_code: 'official',
      availability: 'approved',
      total_bytes: 1024,
      install_state: 'installed_inactive',
      can_activate: false,
      description: '缺少外部运行时'
    }

    const { rerender } = render(<PluginCard module={cannotInstallModule} />)
    const installBtn = screen.getByRole('button', { name: /下载安装/ })
    expect(installBtn).toBeDisabled()

    rerender(<PluginCard module={cannotActivateModule} />)
    const activateBtn = screen.getByTestId('activate-plugin-btn-broken_plugin')
    expect(activateBtn).toBeDisabled()
  })

  it('开发者模式切换时触发 setDevMode 并在 UI 展现本地导入按钮', async () => {
    const mockBridge = {
      list: vi.fn().mockResolvedValue([]),
      setDevMode: vi.fn().mockResolvedValue(true),
      getDevMode: vi.fn().mockResolvedValue(false),
      getEnvironmentVisibility: vi.fn().mockResolvedValue({
        epoch: 'e-dev-test',
        revision: 1,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: false,
          allowDeveloperMode: true,
          allowLocalPluginImport: false,
          allowOfflineImport: true,
          allowOfflineExport: false
        }
      }),
      setDeveloperMode: vi.fn().mockImplementation(async ({ enabled }: { enabled: boolean }) => ({
        epoch: 'e-dev-test',
        revision: enabled ? 2 : 3,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: enabled,
          allowDeveloperMode: true,
          allowLocalPluginImport: enabled,
          allowOfflineImport: true,
          allowOfflineExport: enabled
        }
      })),
      install: vi.fn(),
      uninstall: vi.fn(),
      updateState: vi.fn(),
      pickAndImportLocalPlugin: vi
        .fn()
        .mockResolvedValue({ canceled: false, module: { id: 'imported' } })
    }
    const { setModularResourceBridgeForTest } = await import('../../../stores/plugin-center-store')
    setModularResourceBridgeForTest(mockBridge as any)

    try {
      await act(async () => {
        await usePluginCenterStore.getState().openOverlay()
      })

      render(<PluginCenterOverlay />)
      const devModeSwitch = screen.getByTestId('dev-mode-switch')
      expect(devModeSwitch).not.toBeChecked()
      expect(screen.queryByTestId('pick-local-plugin-btn')).not.toBeInTheDocument()

      // 开启开发者模式
      await act(async () => {
        fireEvent.click(devModeSwitch)
      })

      expect(mockBridge.setDeveloperMode).toHaveBeenCalledWith({ enabled: true })
      expect(screen.getByTestId('pick-local-plugin-btn')).toBeInTheDocument()

      // 点击导入本地插件
      await act(async () => {
        fireEvent.click(screen.getByTestId('pick-local-plugin-btn'))
      })
      expect(mockBridge.pickAndImportLocalPlugin).toHaveBeenCalled()
    } finally {
      setModularResourceBridgeForTest(null)
    }
  })

  it('双视图 Tab 切换 (market <-> installed) 触发过滤', async () => {
    act(() => {
      usePluginCenterStore.setState({
        isOverlayOpen: true,
        scope: 'market',
        modules: [
          {
            id: 'm1',
            name: '市场未安装插件',
            version: '1.0.0',
            category: 'tool',
            author_code: 'official',
            availability: 'approved',
            total_bytes: 100,
            install_state: 'not_installed',
            description: '未安装'
          },
          {
            id: 'm2',
            name: '本地已安装插件',
            version: '1.0.0',
            category: 'tool',
            author_code: 'official',
            availability: 'approved',
            total_bytes: 200,
            install_state: 'active',
            description: '已安装'
          }
        ]
      })
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByText('市场未安装插件')).toBeInTheDocument()
    expect(screen.getByText('本地已安装插件')).toBeInTheDocument()

    // 切换到 已安装 视图
    const installedTab = screen.getByTestId('scope-installed-tab')
    await act(async () => {
      fireEvent.click(installedTab)
    })

    expect(usePluginCenterStore.getState().scope).toBe('installed')
    // 在已安装视图中，未安装的 m1 应该被过滤掉
    expect(screen.queryByText('市场未安装插件')).not.toBeInTheDocument()
    expect(screen.getByText('本地已安装插件')).toBeInTheDocument()
  })

  it('PluginListItem 渲染小白通俗大白话描述与电脑硬件配置门槛徽标', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
    })
    render(<PluginCenterOverlay />)

    // 验证经典轻量引擎的大白话描述与硬件门槛
    expect(screen.getByText(/根据你描述的大致意思快速搜索照片和文档/)).toBeInTheDocument()
    expect(screen.getByText('配置要求极低 · 老电脑与轻薄本首选')).toBeInTheDocument()

    // 验证统一全模态引擎的大白话描述与硬件门槛
    expect(screen.getByText(/对复杂句子和图片.*的理解更深入精准/)).toBeInTheDocument()
    expect(screen.getByText('推荐配置 · 电脑内存 8GB 或以上')).toBeInTheDocument()

    // 验证语音合成 Moss-TTS 与 M5-TTS 的大白话描述
    expect(
      screen.getByText(/内置声音提取器，上传一段录音即可克隆专属声音朗读文章/)
    ).toBeInTheDocument()
    expect(screen.getByText('配置要求低 · 普通电脑流畅发音')).toBeInTheDocument()
    expect(screen.getByText(/按下播放毫秒级即刻发声/)).toBeInTheDocument()
    expect(screen.getByText('配置要求极低 · 普通轻薄本流畅发音')).toBeInTheDocument()

    // 验证轻量 CPU 引擎硬件徽标
    expect(screen.getByText('配置要求极低 · 纯CPU运行')).toBeInTheDocument()
  })

  it('TC-01: 彻底移除单插件导出按钮，仅开发者模式渲染顶部导出离线总包且全环境常驻导入离线包', async () => {
    const mockBridge = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'installed_mod',
          name: '已安装插件',
          version: '1.0.0',
          category: 'tool',
          author_code: 'official',
          availability: 'approved',
          total_bytes: 1024,
          install_state: 'active'
        }
      ]),
      setDevMode: vi.fn().mockResolvedValue(true),
      getDevMode: vi.fn().mockResolvedValue(true), // 开发模式启动
      getEnvironmentVisibility: vi.fn().mockResolvedValue({
        epoch: 'e-tc01',
        revision: 1,
        visibility: {
          isDev: true,
          isEnterpriseOffline: false,
          developerModeEnabled: true,
          allowDeveloperMode: true,
          allowLocalPluginImport: true,
          allowOfflineImport: true,
          allowOfflineExport: true
        }
      }),
      exportOfflinePackage: vi.fn().mockResolvedValue('/path/to/exported.ffp'),
      exportOfflineBundle: vi.fn().mockResolvedValue('/path/to/bundle.ffbundle'),
      importOfflinePackage: vi.fn().mockResolvedValue({ id: 'imported_pkg' })
    }
    const { setModularResourceBridgeForTest } = await import('../../../stores/plugin-center-store')
    setModularResourceBridgeForTest(mockBridge as any)

    try {
      await act(async () => {
        await usePluginCenterStore.getState().openOverlay()
      })

      render(<PluginCenterOverlay />)

      // 彻底移除单插件导出按钮与列表中行内导出按钮
      expect(screen.queryByTestId('export-offline-plugin-btn')).not.toBeInTheDocument()
      expect(screen.queryByTestId('export-plugin-btn')).not.toBeInTheDocument()

      // 开发模式下顶部导出离线总包按钮存在并可触发 exportOfflineBundle
      const exportBundleBtn = screen.getByTestId('export-offline-bundle-btn')
      expect(exportBundleBtn).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(exportBundleBtn)
      })
      expect(mockBridge.exportOfflineBundle).toHaveBeenCalled()

      // 点击导入离线包
      const importOfflineBtn = screen.getByTestId('import-offline-plugin-btn')
      expect(importOfflineBtn).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(importOfflineBtn)
      })
      expect(mockBridge.importOfflinePackage).toHaveBeenCalled()
    } finally {
      setModularResourceBridgeForTest(null)
    }
  })

  it('TC-14: 插件描述一行显示不完时多行显示，无强制单行截断类名', () => {
    const longDesc =
      '这是一段非常长非常详细的插件功能描述文案，旨在说明当前插件的各项高级特性与能力，在窄屏和宽屏下均可多行自适应折行完整呈现，杜绝单行截断'
    const mockModule: PluginModuleItem = {
      id: 'test_long_desc_plugin',
      name: '测试长描述插件',
      version: '1.0.0',
      category: 'perception',
      author_code: 'official',
      availability: 'available',
      total_bytes: 1048576,
      install_state: 'not_installed',
      description: longDesc
    }

    render(<PluginListItem module={mockModule} />)
    const descEl = screen.getByText(longDesc)
    expect(descEl).toBeInTheDocument()
    // 确认已移除强制单行与两行截断 line-clamp 类
    expect(descEl.className).not.toContain('line-clamp-1')
    expect(descEl.className).not.toContain('md:line-clamp-1')
    expect(descEl.className).not.toContain('line-clamp-2')
    expect(descEl.className).toContain('break-words')
  })

  it('TC-15: 切换基础语义检索引擎时触发二次确认弹窗，确认后才执行切换，取消则保持现状', async () => {
    act(() => {
      usePluginCenterStore.setState({
        isOverlayOpen: true,
        isTogglingSlot: false,
        modules: [
          {
            id: 'engine_classic_light',
            name: '经典轻量 AI 引擎',
            version: '1.0.0',
            category: 'ai-engine',
            capability_slot: 'base_embedding',
            slot_policy: 'exclusive_required',
            author_code: 'official',
            availability: 'approved',
            total_bytes: 50000000,
            install_state: 'active',
            can_activate: false,
            description: '轻量极速底座'
          },
          {
            id: 'engine_gemma_unified',
            name: '统一全模态 AI 引擎',
            version: '1.0.0',
            category: 'ai-engine',
            capability_slot: 'base_embedding',
            slot_policy: 'exclusive_required',
            author_code: 'official',
            availability: 'approved',
            total_bytes: 500000000,
            install_state: 'installed_inactive',
            can_activate: true,
            description: '全模态底座'
          }
        ]
      })
    })

    render(<PluginCenterOverlay />)

    // 初始状态：经典轻量引擎为使用中，统一全模态引擎有【启用】按钮
    const gemmaActivateBtn = screen.getByTestId('activate-plugin-btn-engine_gemma_unified')
    expect(gemmaActivateBtn).toBeInTheDocument()

    // 点击启用统一全模态引擎 -> 应触发二次确认弹窗，而不是直接切换
    await act(async () => {
      fireEvent.click(gemmaActivateBtn)
    })

    // 弹窗可见并包含指定提示文案
    const confirmDialog = screen.getByTestId('switch-engine-confirm-dialog')
    expect(confirmDialog).toBeInTheDocument()
    expect(screen.getByTestId('switch-engine-confirm-dialog-desc')).toHaveTextContent(
      '切换引擎需要重建文件索引，花费较多时间，是否切换？'
    )

    // 此时尚未切换：经典轻量依然是 active，全模态依然是 installed_inactive
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'engine_classic_light')
        ?.install_state
    ).toBe('active')
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'engine_gemma_unified')
        ?.install_state
    ).toBe('installed_inactive')

    // 1. 测试点击取消：弹窗关闭，保持原状
    const cancelBtn = screen.getByTestId('cancel-switch-engine-btn')
    await act(async () => {
      fireEvent.click(cancelBtn)
    })
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'engine_classic_light')
        ?.install_state
    ).toBe('active')
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'engine_gemma_unified')
        ?.install_state
    ).toBe('installed_inactive')

    // 2. 再次点击启用，并点击确认切换
    await act(async () => {
      fireEvent.click(screen.getByTestId('activate-plugin-btn-engine_gemma_unified'))
    })
    expect(screen.getByTestId('switch-engine-confirm-dialog')).toBeInTheDocument()

    const confirmBtn = screen.getByTestId('confirm-switch-engine-btn')
    await act(async () => {
      fireEvent.click(confirmBtn)
    })

    // 确认后完成切换：全模态变为 active，经典轻量自动降级为 installed_inactive
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'engine_gemma_unified')
        ?.install_state
    ).toBe('active')
    expect(
      usePluginCenterStore.getState().modules.find(m => m.id === 'engine_classic_light')
        ?.install_state
    ).toBe('installed_inactive')
  })
})
