// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'

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

import { WelcomeStep2PluginSetup } from '../WelcomeStep2PluginSetup'
import {
  DEFAULT_HARDWARE,
  DEFAULT_WELCOME_SELECTION,
  type WelcomeSelection
} from '../welcome-types'

/** 模拟 16GB + 独显机器的向导推荐结果（ASR 自动勾选） */
const recommendedSelection: WelcomeSelection = {
  ...DEFAULT_WELCOME_SELECTION,
  selectedOptionals: {
    perception_nsfw: true,
    asr_sensevoice_onnx: true,
    tts_m5_onnx: true
  }
}

describe('WelcomeStep2PluginSetup (欢迎向导第二步：只选择、不安装)', () => {
  let mockInstall: any
  let mockImportOfflinePackage: any

  beforeEach(() => {
    mockInstall = vi.fn().mockResolvedValue({})
    mockImportOfflinePackage = vi.fn().mockResolvedValue(null)
    Object.assign(window, {
      electronAPI: {
        modularResource: {
          install: mockInstall,
          importOfflinePackage: mockImportOfflinePackage,
          smokeTest: vi.fn().mockResolvedValue({ success: true }),
          onProgress: vi.fn(() => () => undefined)
        }
      }
    })
  })

  const setup = (overrides: any = {}) => {
    const props = {
      selection: recommendedSelection,
      hardware: { ...DEFAULT_HARDWARE },
      isDetectingHw: false,
      onChange: vi.fn(),
      onBack: vi.fn(),
      onNext: vi.fn(),
      ...overrides
    }
    const view = render(<WelcomeStep2PluginSetup {...props} />)
    // 同一个 it 内多次渲染时必须显式卸载，否则上一份 DOM 的体积标签会叠加计数
    return { ...props, unmount: view.unmount }
  }

  it('硬件看板与去重精确体积：推荐组合 727.7 MiB', () => {
    setup()

    expect(screen.getByText('16 GB')).toBeDefined()
    expect(screen.getByText('50 GB')).toBeDefined()
    expect(screen.getByText('推荐档位：高智能全能版（理解更深入）')).toBeDefined()
    expect(screen.getByText('727.7 MiB')).toBeDefined()
  })

  it('本页绝不安装：没有「开启 Firefly」、没有离线导入按钮、没有进度条，点击也不触发任何安装 API', () => {
    const props = setup()

    expect(screen.queryByTestId('welcome-start-install-btn')).toBeNull()
    expect(screen.queryByTestId('welcome-import-offline-bundle-btn')).toBeNull()
    expect(screen.queryByText('开启 Firefly')).toBeNull()
    expect(screen.queryByText('插件获取方式（二选一）')).toBeNull()

    fireEvent.click(screen.getByTestId('welcome-step2-next-btn'))
    expect(props.onNext).toHaveBeenCalledTimes(1)
    expect(mockInstall).not.toHaveBeenCalled()
    expect(mockImportOfflinePackage).not.toHaveBeenCalled()
  })

  it('底部按钮统一改为「下一步」，返回触发 onBack', () => {
    const props = setup()

    const nextBtn = screen.getByTestId('welcome-step2-next-btn')
    expect(nextBtn.textContent).toContain('下一步')
    expect(screen.queryByText('下一步：选择安装目录')).toBeNull()

    fireEvent.click(screen.getByTestId('welcome-step2-back-btn'))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })

  it('三张选配插件卡片标题改为「能力名 + 技术缩写」，旧标题不再出现', () => {
    setup()

    expect(screen.getByText('私密与敏感图文识别（NSFW）')).toBeDefined()
    expect(screen.getByText('音视频转字幕文本（ASR）')).toBeDefined()
    expect(screen.getByText('离线语音朗读（TTS）')).toBeDefined()

    expect(screen.queryByText('私密与敏感照片识别')).toBeNull()
    expect(screen.queryByText('音视频转字幕与语音搜索')).toBeNull()
    expect(screen.queryByText('离线语音朗读')).toBeNull()
  })

  it('离线语音朗读：默认只装配 M5-TTS，不提供二选一，且不暴露插件型号', () => {
    setup()

    expect(screen.queryByText('声音克隆')).toBeNull()
    expect(screen.queryByText('极速轻量')).toBeNull()
    expect(screen.queryByText('支持克隆音色')).toBeNull()
    expect(screen.queryByText('237.6 MiB')).toBeNull()

    const ttsCard = screen.getByTestId('welcome-tts-m5-card')
    expect(ttsCard.textContent).toContain('离线语音朗读（TTS）')
    expect(ttsCard.className).toContain('border-emerald-500')
    expect(within(ttsCard).queryByTestId('welcome-tts-m5-only-tag')).toBeNull()
    expect(screen.queryByText('默认装配 M5-TTS 离线语音朗读插件')).toBeNull()
    expect(ttsCard.textContent).not.toContain('M5-TTS')

    const desc = within(ttsCard).getByTestId('welcome-tts-description')
    expect(desc.textContent).toContain('实时长文朗读')
    expect(desc.textContent).toContain('50+音色')
    expect(desc.textContent).toContain('中英文混读')
    expect(desc.textContent).toContain('文件分析结果直接收听')
    expect(desc.className).toContain('text-muted-foreground')
  })

  it('取消勾选离线语音朗读后体积精确减到 436.0 MiB，并通过 onChange 上报', () => {
    const props = setup()

    fireEvent.click(screen.getByText('离线语音朗读（TTS）'))

    expect(props.onChange).toHaveBeenCalledWith({
      selectedOptionals: {
        perception_nsfw: true,
        asr_sensevoice_onnx: true,
        tts_m5_onnx: false
      }
    })
    // 组件是受控的，单元测试里由外层决定新值；这里验证体积算法对不含 TTS 的组合仍精确
    setup({
      selection: {
        ...recommendedSelection,
        selectedOptionals: { ...recommendedSelection.selectedOptionals, tts_m5_onnx: false }
      }
    })
    expect(screen.getByText('436.0 MiB')).toBeDefined()
  })

  it('切换引擎通过 onChange 上报；4GB 内存推荐组合体积 692.2 MiB', () => {
    const lowMemorySelection: WelcomeSelection = {
      ...DEFAULT_WELCOME_SELECTION,
      selectedEngine: 'engine_classic_light',
      selectedOptionals: {
        perception_nsfw: true,
        asr_sensevoice_onnx: false,
        tts_m5_onnx: true
      }
    }
    const props = setup({ selection: lowMemorySelection, hardware: { ...DEFAULT_HARDWARE, totalMemGB: 4 } })

    expect(screen.getByText('轻量档位：极速轻巧版（低配电脑秒开）')).toBeDefined()
    expect(screen.getByText('692.2 MiB')).toBeDefined()

    fireEvent.click(screen.getByTestId('welcome-engine-gemma-card'))
    expect(props.onChange).toHaveBeenCalledWith({ selectedEngine: 'engine_gemma_unified' })
  })

  it('取消所有选配后仅剩必装引擎：242.2 MiB，全部勾选 Classic 组合 845.1 MiB', () => {
    const noOptionals: WelcomeSelection = {
      ...recommendedSelection,
      selectedOptionals: {
        perception_nsfw: false,
        asr_sensevoice_onnx: false,
        tts_m5_onnx: false
      }
    }
    const firstRender = setup({ selection: noOptionals })
    expect(screen.getAllByText('242.2 MiB').length).toBe(2)
    firstRender.unmount()

    const classicAll: WelcomeSelection = {
      ...recommendedSelection,
      selectedEngine: 'engine_classic_light'
    }
    setup({ selection: classicAll })
    expect(screen.getAllByText('304.4 MiB').length).toBe(1)
    expect(screen.getByText('845.1 MiB')).toBeDefined()
  })

  it('引擎能力差异文案：全能引擎支持音视频、轻巧引擎明确不支持音视频', () => {
    setup()

    const gemmaCard = screen.getByTestId('welcome-engine-gemma-card')
    const classicCard = screen.getByTestId('welcome-engine-classic-card')
    const gemmaTag = within(gemmaCard).getByTestId('engine-gemma-media-capability')
    const classicTag = within(classicCard).getByTestId('engine-classic-media-capability')

    expect(gemmaCard.textContent).toContain('视频和录音都能搜')
    expect(gemmaTag.textContent).toContain('支持音视频')
    expect(classicCard.textContent).toContain('只处理文档和图片')
    expect(classicTag.textContent).toContain('不支持音视频')
  })

  it('文件大小标签使用主题语义色（明暗模式均可读）', () => {
    setup()
    for (const sizeLabel of ['242.2 MiB', '304.4 MiB']) {
      const badge = screen.getByText(sizeLabel)
      const classes = badge.className.split(/\s+/)
      expect(classes.some(c => /^bg-(muted|card|secondary)/.test(c))).toBe(true)
      expect(classes.some(c => /^text-(foreground|muted-foreground)$/.test(c))).toBe(true)
    }
  })

  it('ENOSPC Guard：磁盘剩余 < 2GB 时禁用「下一步」并给出大白话提示', () => {
    setup({ hardware: { ...DEFAULT_HARDWARE, storageFreeGB: 1.2 } })

    expect(screen.getByText('磁盘剩余空间不足，请至少预留 2GB 空间以供下载与安装')).toBeDefined()
    expect((screen.getByTestId('welcome-step2-next-btn') as HTMLButtonElement).disabled).toBe(true)
  })

  it('安装方式在 Step 4 才决定：本页只提示「先挑本领、稍后再决定怎么装」，且不受 installMethod 影响', () => {
    const { unmount: unmountFirst } = setup()
    expect(screen.getByTestId('welcome-step2-later-method-hint').textContent).toContain(
      '现在还不会下载文件'
    )
    expect(screen.queryByTestId('welcome-step2-offline-hint')).toBeNull()
    unmountFirst()

    setup({ selection: { ...recommendedSelection, installMethod: 'offline' } })

    // 即便共享状态里已选离线，能力装配页也不再展示离线提示（该提示已移到 Step 4）
    expect(screen.queryByTestId('welcome-step2-offline-hint')).toBeNull()
    expect(screen.getByTestId('welcome-step2-later-method-hint').textContent).toContain(
      '现在还不会下载文件'
    )
    expect(screen.getByTestId('welcome-engine-gemma-card').className).toContain('cursor-pointer')
  })

  it('「预估下载大小」改为中性的「预计占用空间」，在线 / 离线两种拿插件方式都说得通', () => {
    setup()

    expect(screen.getByText('预计占用空间:')).toBeDefined()
    expect(screen.queryByText('预估下载大小:')).toBeNull()
  })

  it('明暗自适应：不得写死亮色色值', () => {
    setup()
    const html = screen.getByTestId('welcome-step2-container').innerHTML
    // 明暗自适应：必须使用主题语义色，严禁写死仅适配亮色的色值
    expect(html).not.toMatch(/\b(bg-white|bg-slate-\d+|text-slate-\d+|border-slate-\d+)\b/)
    expect(html).toContain('text-muted-foreground')
  })
})
