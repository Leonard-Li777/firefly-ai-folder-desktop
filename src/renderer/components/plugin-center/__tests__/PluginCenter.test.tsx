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
import { PluginListItem } from '../PluginListItem'
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
    expect(screen.getByText(/离线语音合成 TTS/)).toBeInTheDocument()
    expect(screen.queryByText(/压缩包透视/)).not.toBeInTheDocument()
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
      usePluginCenterStore.getState().setConfiguringModuleId('tts_moss_onnx')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByTestId('mock-tts-settings')).toBeInTheDocument()
  })

  it('点击其他支持 schema 的插件配置按钮时展示自定义 JSON 配置插槽', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('archive_vfs_parser')
    })

    render(<PluginCenterOverlay />)
    expect(screen.getByText(/插件个性化配置项/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/请输入符合插件定义的 JSON 配置项/)).toBeInTheDocument()

    // 输入自定义 JSON 配置并保存
    const textarea = screen.getByPlaceholderText(/请输入符合插件定义的 JSON 配置项/)
    fireEvent.change(textarea, { target: { value: '{"renderQuality": "high"}' } })
    fireEvent.click(screen.getByText('保存配置'))

    expect(usePluginCenterStore.getState().configuringModuleId).toBeNull()
    const updated = usePluginCenterStore.getState().modules.find(m => m.id === 'archive_vfs_parser')
    expect(updated?.user_config).toBe('{"renderQuality": "high"}')
  })

  it('自定义配置保存时拦截非法 JSON 并显示错误提示', () => {
    act(() => {
      usePluginCenterStore.getState().openOverlay()
      usePluginCenterStore.getState().setConfiguringModuleId('archive_vfs_parser')
    })

    render(<PluginCenterOverlay />)
    const textarea = screen.getByPlaceholderText(/请输入符合插件定义的 JSON 配置项/)
    fireEvent.change(textarea, { target: { value: '{ invalid json }' } })
    fireEvent.click(screen.getByText('保存配置'))

    // 仍停留在配置页面且报错
    expect(usePluginCenterStore.getState().configuringModuleId).toBe('archive_vfs_parser')
    expect(screen.getByText(/配置格式错误，必须为合法的 JSON 格式字符串/)).toBeInTheDocument()
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
        percentage: 100,
        speed_bytes_per_sec: 1024 * 1024 * 10,
        is_resumed: false
      })
    })

    asr = usePluginCenterStore.getState().modules.find(m => m.id === targetId)
    expect(asr?.install_state).toBe('active')
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
      usePluginCenterStore.getState().openOverlay()
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
    expect(ttsGroup).toHaveTextContent('离线语音合成与朗读 (TTS)')
    expect(ttsGroup).toHaveTextContent('选配单选 · 互斥生效')

    // 检查通用多活槽位分组
    const generalGroup = screen.getByTestId('slot-group-general')
    expect(generalGroup).toBeInTheDocument()
    expect(generalGroup).toHaveTextContent('智能工具与扩展技能')
    expect(generalGroup).toHaveTextContent('多选并发 · 独立运行')
  })

  it('exclusive_required 槽位拦截直接停用操作，并保持激活状态', async () => {
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

    // 查找 engine_classic_light (已激活的 exclusive_required 插件)
    const classicLightCard = screen.getByTestId('plugin-card-engine_classic_light')
    expect(classicLightCard).toBeInTheDocument()

    const switchBtn = within(classicLightCard).getByRole('switch')
    expect(switchBtn).toBeChecked()

    // 尝试点击 Switch 停用
    await act(async () => {
      fireEvent.click(switchBtn)
    })

    // 由于 exclusive_required 保护，插件仍然保持 active 状态
    const mod = usePluginCenterStore.getState().modules.find(m => m.id === 'engine_classic_light')
    expect(mod?.install_state).toBe('active')
  })

  it('exclusive_optional 槽位激活新插件时自动排他关闭同槽位已激活项', async () => {
    // 设置初始状态：给 voice_tts 槽位添加两个插件，一个已激活，一个已安装但未激活
    act(() => {
      usePluginCenterStore.setState({
        isOverlayOpen: true,
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

    const chatTtsCard = screen.getByTestId('plugin-card-tts_chat_onnx')
    expect(chatTtsCard).toBeInTheDocument()

    // 点击 ChatTTS 的启用开关
    const chatTtsSwitch = within(chatTtsCard).getByRole('switch')
    await act(async () => {
      fireEvent.click(chatTtsSwitch)
    })

    // 断言 ChatTTS 激活，而 MossTTS 自动被互斥停用
    const chatMod = usePluginCenterStore.getState().modules.find(m => m.id === 'tts_chat_onnx')
    const mossMod = usePluginCenterStore.getState().modules.find(m => m.id === 'tts_moss_onnx')
    expect(chatMod?.install_state).toBe('active')
    expect(mossMod?.install_state).toBe('installed_inactive')
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
    const switchEl = screen.getByRole('switch')
    expect(switchEl).toBeDisabled()
  })

  it('开发者模式切换时触发 setDevMode 并在 UI 展现本地导入按钮', async () => {
    const mockBridge = {
      list: vi.fn().mockResolvedValue([]),
      setDevMode: vi.fn().mockResolvedValue(true),
      getDevMode: vi.fn().mockResolvedValue(false),
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

      expect(mockBridge.setDevMode).toHaveBeenCalledWith({ enabled: true })
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
})
