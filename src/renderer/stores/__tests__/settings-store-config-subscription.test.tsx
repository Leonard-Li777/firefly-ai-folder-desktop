import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// posthog 模块会连带初始化 tier-store / DOM 监听器，与本次断言无关，隔离掉
vi.mock('../../lib/posthog', () => ({ captureEvent: vi.fn() }))

import { useConfigValue, useSettingsConfig, useSettingsStore } from '../settings-store'

/**
 * 回归用例：设置面板「改完开关但 UI 不回显」
 *
 * 根因：设置面板普遍在 render 阶段用 `getConfigValue()` 读配置，而该函数引用在 store
 * 创建后恒定不变，zustand 选择器 `s => s.getConfigValue` 的结果永远相等 ⇒ config 被替换
 * 后组件不重渲染。修复手段是让组件订阅 config（`useSettingsConfig()` / `useConfigValue()`）。
 * 本文件同时用「渲染行为断言」与「静态订阅门禁」双重锁死该回归。
 */

/** 模拟修复后的设置开关：订阅 config + render 阶段 getConfigValue 读值 */
const FixedReadProbe: React.FC = () => {
  useSettingsConfig()
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  return <span data-testid="ocr">{String(getConfigValue<boolean>('ENABLE_IMAGE_OCR'))}</span>
}

/**
 * 对照探针：复现历史写法的 BUG 形态 —— 只取 `s.getConfigValue` 这个函数引用
 * （引用恒定，zustand 认为快照未变 ⇒ 不重渲染），render 阶段再拿它去读值。
 */
const UnsubscribedProbe: React.FC = () => {
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  return <span data-testid="ocr">{String(getConfigValue<boolean>('ENABLE_IMAGE_OCR'))}</span>
}

/**
 * 另一种正确写法（仓内已有先例，如 FileExplorerLayout）：在选择器内直接调用
 * getConfigValue，选择器返回原始值，天然具备重渲染能力。
 */
const SelectorCallProbe: React.FC = () => {
  const enabled = useSettingsStore(s => s.getConfigValue<boolean>('ENABLE_IMAGE_OCR'))
  return <span data-testid="ocr">{String(enabled)}</span>
}

const HookProbe: React.FC = () => {
  const reuse = useConfigValue<boolean>('REUSE_BASIC_ANALYSIS_DATA')
  return <span data-testid="reuse">{String(reuse)}</span>
}

describe('settings-store 配置订阅（UI 即时回显回归）', () => {
  beforeEach(() => {
    act(() => {
      useSettingsStore.setState({
        config: {} as any,
        originalConfig: null,
        hasUnsavedChanges: false
      })
    })
  })

  it('订阅 config 后，配置变更应即时反映到 render 读取的值', () => {
    render(<FixedReadProbe />)
    expect(screen.getByTestId('ocr').textContent).toBe('undefined')

    act(() => {
      useSettingsStore.setState({ config: { enableImageOcr: true } as any })
    })
    expect(screen.getByTestId('ocr').textContent).toBe('true')

    act(() => {
      useSettingsStore.setState({ config: { enableImageOcr: false } as any })
    })
    expect(screen.getByTestId('ocr').textContent).toBe('false')
  })

  it('选择内直接取值的写法同样能即时回显', () => {
    render(<SelectorCallProbe />)
    expect(screen.getByTestId('ocr').textContent).toBe('undefined')

    act(() => {
      useSettingsStore.setState({ config: { enableImageOcr: true } as any })
    })
    expect(screen.getByTestId('ocr').textContent).toBe('true')
  })

  it('对照：仅取 getConfigValue 函数引用的组件不会重渲染（即历史 BUG 形态）', () => {
    render(<UnsubscribedProbe />)
    expect(screen.getByTestId('ocr').textContent).toBe('undefined')

    act(() => {
      useSettingsStore.setState({ config: { enableImageOcr: true } as any })
    })
    // 仍停留在首次渲染的快照上 —— 这正是「开关拨了没反应」的表现
    expect(screen.getByTestId('ocr').textContent).toBe('undefined')
  })

  it('useConfigValue 读取 ConfigKey 时会跟随 config 变化重渲染', () => {
    render(<HookProbe />)
    expect(screen.getByTestId('reuse').textContent).toBe('undefined')

    act(() => {
      useSettingsStore.setState({ config: { reuseBasicAnalysisData: true } as any })
    })
    expect(screen.getByTestId('reuse').textContent).toBe('true')
  })

  it('updateConfigValue 写库前应先同步本地 config，保证乐观回显', async () => {
    act(() => {
      useSettingsStore.setState({ config: { enableImageOcr: false } as any })
    })
    render(<FixedReadProbe />)
    expect(screen.getByTestId('ocr').textContent).toBe('false')

    await act(async () => {
      await useSettingsStore.getState().updateConfigValue('ENABLE_IMAGE_OCR', true)
    })
    expect(useSettingsStore.getState().config.enableImageOcr).toBe(true)
    expect(screen.getByTestId('ocr').textContent).toBe('true')
  })
})

describe('设置面板订阅门禁（静态）', () => {
  const SETTINGS_DIR = resolve(__dirname, '../../components/settings')

  /**
   * 判定某文件是否具备「config 变更可触发重渲染」的订阅能力：
   * 1) 调用 useSettingsConfig()；
   * 2) 订阅整个 state：useSettingsStore()；
   * 3) 选择器直接订阅 config 或其字段：s => s.config...；
   * 4) 选择器内直接取值返回原始值：s => s.getConfigValue<...>('KEY')。
   */
  const subscribesConfig = (src: string): boolean =>
    // 必须是「真实调用」，仅 import 了符号不算订阅
    /useSettingsConfig\s*\(\s*\)/.test(src) ||
    /useSettingsStore\(\s*\)/.test(src) ||
    /s\s*=>\s*s\.config/.test(src) ||
    /s\s*=>\s*s\.getConfigValue\s*</.test(src)

  it('凡在 render 阶段使用 getConfigValue 的设置组件，都必须订阅 config', () => {
    const offenders = readdirSync(SETTINGS_DIR)
      .filter(name => name.endsWith('.tsx'))
      .map(name => ({ name, src: readFileSync(resolve(SETTINGS_DIR, name), 'utf-8') }))
      .filter(({ src }) => src.includes('getConfigValue'))
      .filter(({ src }) => !subscribesConfig(src))
      .map(({ name }) => name)

    expect(
      offenders,
      `以下设置组件用 getConfigValue 读配置却未订阅 config，改配置后 UI 不会回显：${offenders.join(', ')}`
    ).toEqual([])
  })
})
