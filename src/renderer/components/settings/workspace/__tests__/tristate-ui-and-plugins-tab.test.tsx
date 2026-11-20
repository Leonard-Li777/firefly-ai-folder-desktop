import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import {
  TriStateFieldFeedback,
  getOcrModelSizeLabel
} from '../TriStateFieldFeedback'
import { WorkspacePluginsTab } from '../WorkspacePluginsTab'
import { ContentExtractionTab } from '../ContentExtractionTab'
import {
  WORKSPACE_CONFIGURABLE_PLUGIN_IDS,
  GLOBAL_ONLY_PLUGIN_IDS,
  submitWorkspacePolicyMutation,
  triggerWorkspaceIncrementalRecovery,
  type DegradationReasonCode,
  type InactiveReasonCode,
  type ResolvedPluginTriState,
  type ResolvedTriStateField,
  type WorkspaceRuntimeContextSnapshot
} from '../../../../lib/workspace-policy/workspace-ai-client'
import {
  useWorkspaceRuntimeContext,
  selectModuleStates
} from '../../../../stores/workspace-runtime-context-store'

// 禁止出现的底层工程黑话正则（AGENTS.md §2.16 & 规格书 §5.3）
const FORBIDDEN_JARGON_RE = /\b(ASR|OCR|CLIP|ONNX|gemma_unified|classic_light|LibreOffice|300s|Token)\b/

function makeSnapshot(overrides: Partial<WorkspaceRuntimeContextSnapshot> = {}): WorkspaceRuntimeContextSnapshot {
  return {
    contextEpoch: 1,
    workspaceId: 1,
    libreOfficeInstalled: true,
    generativeAiEnabled: true,
    globalEmbeddingProfile: 'gemma_unified',
    videoInferenceBackend: 'gpu',
    isProTier: false,
    moduleStates: {},
    ...overrides
  }
}

describe('SLICE-08: TriStateFieldFeedback & 15 条法定大白话', () => {
  it('默认正常态 (origin !== user_custom && active) 返回 null', () => {
    const field: ResolvedTriStateField<string> = {
      effectiveValue: 'full',
      desiredValue: 'full',
      origin: 'workflow_default',
      applicability: 'active',
      visible: true,
      isUserCustom: false
    }
    const { container } = render(
      <TriStateFieldFeedback
        field={field}
        effectiveText="全面分析"
        desiredText="全面分析"
        hasBoundWorkflow={true}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('user_custom && active：未绑定工作流时不误显「工作流默认」', () => {
    const onRestore = vi.fn()
    const field: ResolvedTriStateField<number> = {
      effectiveValue: 4096,
      desiredValue: 2048,
      origin: 'user_custom',
      applicability: 'active',
      visible: true,
      isUserCustom: true
    }
    render(
      <TriStateFieldFeedback
        field={field}
        effectiveText="4096 KB"
        desiredText="2048 KB"
        hasBoundWorkflow={false}
        onRestore={onRestore}
      />
    )
    expect(screen.getByText('用户自定义')).toBeInTheDocument()
    expect(screen.getByText(/默认配置：2048 KB/)).toBeInTheDocument()
    expect(screen.queryByText(/工作流默认/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /恢复默认配置/ }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('degraded：全部 9 种降级根因均渲染大白话且不含工程黑话', () => {
    const reasons: DegradationReasonCode[] = [
      'generative_ai_disabled',
      'gemma_unified_not_active',
      'global_plugin_not_installed',
      'global_plugin_inactive',
      'global_plugin_error',
      'libreoffice_missing',
      'cpu_hardware_clamp',
      'free_tier_video_limit',
      'ocr_disabled_cascade'
    ]

    for (const reason of reasons) {
      const onFixAction = vi.fn()
      const { container, unmount } = render(
        <TriStateFieldFeedback
          field={{
            effectiveValue: 'simple',
            desiredValue: 'full',
            origin: 'workflow_default',
            applicability: 'degraded',
            visible: true,
            isUserCustom: false,
            degradationReason: reason
          }}
          effectiveText="极速基础整理"
          desiredText="深度理解"
          hasBoundWorkflow={true}
          onFixAction={onFixAction}
        />
      )
      const text = container.textContent ?? ''
      expect(text).toContain('实际生效：极速基础整理')
      expect(text).not.toMatch(FORBIDDEN_JARGON_RE)
      unmount()
    }
  })

  it('cascaded_off：parent_plugin_off_by_user 触发 re_enable_parent_plugin 且其余非激活原因无黑话', () => {
    const onFixAction = vi.fn()
    render(
      <TriStateFieldFeedback
        field={{
          effectiveValue: 0,
          desiredValue: 60,
          origin: 'workflow_default',
          applicability: 'cascaded_off',
          visible: true,
          isUserCustom: false,
          inactiveReason: 'parent_plugin_off_by_user'
        }}
        effectiveText="0 秒"
        desiredText="60 秒"
        hasBoundWorkflow={true}
        onFixAction={onFixAction}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '重新开启' }))
    expect(onFixAction).toHaveBeenCalledWith('re_enable_parent_plugin')

    const otherReasons: InactiveReasonCode[] = [
      'parent_plugin_unavailable',
      'classic_engine_only',
      'plugin_downloading',
      'plugin_coming_soon',
      'ocr_disabled_cascade'
    ]
    for (const inactiveReason of otherReasons) {
      const { container, unmount } = render(
        <TriStateFieldFeedback
          field={{
            effectiveValue: false,
            desiredValue: true,
            origin: 'system_default',
            applicability: 'pending',
            visible: true,
            isUserCustom: false,
            inactiveReason
          }}
          effectiveText="关闭"
          desiredText="开启"
          hasBoundWorkflow={false}
        />
      )
      expect(container.textContent ?? '').not.toMatch(FORBIDDEN_JARGON_RE)
      unmount()
    }
  })

  it('getOcrModelSizeLabel 符合 §5.3 第 15 条法定大白话', () => {
    const tinyLabel = getOcrModelSizeLabel('tiny')
    const smallLabel = getOcrModelSizeLabel('small')
    expect(tinyLabel).toBe('极速识别（省电流畅）')
    expect(smallLabel).toBe('高清精识（适合票据与密字截图）')
    expect(tinyLabel).not.toMatch(FORBIDDEN_JARGON_RE)
    expect(smallLabel).not.toMatch(FORBIDDEN_JARGON_RE)
  })
})

describe('SLICE-08: WorkspacePluginsTab 目录插件双分区与补丁提交', () => {
  const mockApplyMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockApplyMutation.mockResolvedValue({ success: true, policyVersion: 2 })
    ;(window as any).electronAPI = {
      applyWorkspacePolicyMutation: mockApplyMutation
    }
  })

  it('严格仅渲染 6 个目录插件、绝不渲染 6 个全局插件，且预告区只读无假降级', () => {
    expect(WORKSPACE_CONFIGURABLE_PLUGIN_IDS).toHaveLength(6)
    expect(GLOBAL_ONLY_PLUGIN_IDS).toHaveLength(6)

    const { container } = render(
      <WorkspacePluginsTab
        workspaceId={42}
        plugins={{}}
        hasBoundWorkflow={false}
      />
    )

    // 仅主区 2 个插件带 Switch，预告区 4 个 coming_soon 只读无 Switch
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(2)

    const text = container.textContent ?? ''
    expect(text).toContain('语音听写')
    expect(text).toContain('内容安全识别')
    expect(text).toContain('压缩包直接浏览')
    expect(text).toContain('照片人物识别')
    expect(text).toContain('图片物体标记')
    expect(text).toContain('加密文件解密助手')
    expect(text).toContain('不会自动暴力破解')
    // 未绑定工作流时不得误提「当前工作流主题」
    expect(text).not.toContain('当前工作流主题')
    expect(text).not.toContain('本主题推荐')
    expect(text).not.toMatch(FORBIDDEN_JARGON_RE)

    for (const globalId of GLOBAL_ONLY_PLUGIN_IDS) {
      expect(text).not.toContain(globalId)
    }
  })

  it('主区 Switch 提交 pluginOverridePatch，恢复默认提交 restorePluginOverrideIds（严禁传 null）', async () => {
    const plugins: Record<string, ResolvedPluginTriState> = {
      asr_sensevoice_onnx: {
        pluginId: 'asr_sensevoice_onnx',
        effectiveValue: true,
        origin: 'user_custom',
        applicability: 'active',
        availability: 'approved',
        workflowRecommendation: 'workflow_default_off'
      }
    }

    render(
      <WorkspacePluginsTab
        workspaceId={9}
        plugins={plugins}
        hasBoundWorkflow={true}
      />
    )

    // 点击 Switch 切换
    const asrSwitch = screen.getByRole('switch', { name: '语音听写' })
    fireEvent.click(asrSwitch)
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(9, {
        pluginOverridePatch: { asr_sensevoice_onnx: false }
      })
    })

    // 点击恢复默认
    fireEvent.click(screen.getByRole('button', { name: /恢复默认/ }))
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(9, {
        restorePluginOverrideIds: ['asr_sensevoice_onnx']
      })
    })
  })
})

describe('SLICE-08: RuntimeContextStore & 补丁通道显式错误上报', () => {
  beforeEach(() => {
    useWorkspaceRuntimeContext.getState().dispose()
  })

  it('contextEpoch 单调递增：丢弃过旧或同 epoch 推送，接受更高 epoch', async () => {
    let listener: ((snap: WorkspaceRuntimeContextSnapshot) => void) | null = null
    ;(window as any).electronAPI = {
      getWorkspaceRuntimeContextSnapshot: vi.fn().mockResolvedValue(makeSnapshot({ contextEpoch: 5 })),
      onWorkspaceRuntimeContextUpdated: vi.fn((cb: (s: WorkspaceRuntimeContextSnapshot) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      })
    }

    await useWorkspaceRuntimeContext.getState().initialize(1)
    expect(useWorkspaceRuntimeContext.getState().snapshot?.contextEpoch).toBe(5)

    // 乱序旧 epoch 必须被忽略
    listener?.(makeSnapshot({ contextEpoch: 3, generativeAiEnabled: false }))
    expect(useWorkspaceRuntimeContext.getState().snapshot?.contextEpoch).toBe(5)
    expect(useWorkspaceRuntimeContext.getState().snapshot?.generativeAiEnabled).toBe(true)

    // 更高 epoch 生效
    listener?.(makeSnapshot({ contextEpoch: 6, generativeAiEnabled: false, recoverableCount: 12 }))
    expect(useWorkspaceRuntimeContext.getState().snapshot?.contextEpoch).toBe(6)
    expect(useWorkspaceRuntimeContext.getState().snapshot?.recoverableCount).toBe(12)
  })

  it('IPC 通道未就绪时显式返回失败，严禁静默假成功', async () => {
    ;(window as any).electronAPI = {}
    const mutRes = await submitWorkspacePolicyMutation(1, { overridePatch: { maxContentSizeKb: 2048 } })
    expect(mutRes.success).toBe(false)
    expect(mutRes.error).toBe('WORKSPACE_POLICY_MUTATION_CHANNEL_UNAVAILABLE')

    const recRes = await triggerWorkspaceIncrementalRecovery(1)
    expect(recRes.success).toBe(false)
    expect(recRes.error).toBe('WORKSPACE_INCREMENTAL_RECOVERY_CHANNEL_UNAVAILABLE')
  })
})

describe('SLICE-08: ContentExtractionTab 刻度重构与非标历史值保真', () => {
  beforeEach(() => {
    ;(window as any).electronAPI = {
      applyWorkspacePolicyMutation: vi.fn().mockResolvedValue({ success: true }),
      utils: {
        detectLibreOffice: vi.fn().mockResolvedValue({ installed: true, version: '24.2' })
      }
    }
  })

  it('支持 [256..16384, -1] 刻度并保真历史非标值 100 KB（不截断回 20 KB）', () => {
    const workspace: any = {
      id: 7,
      name: 'Docs',
      path: 'D:\\Docs',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'quick_name',
          maxContentSizeKb: 100,
          extractPages: 10,
          enableOfficeCover: true,
          enableImageOcr: true,
          maxDocumentOcrItems: 5,
          ocrModelSize: 'tiny',
          reuseBasicAnalysisData: true
        }
      })
    }

    const { container } = render(<ContentExtractionTab workspace={workspace} />)
    const text = container.textContent ?? ''
    expect(text).toContain('100 KB')
    expect(text).toContain('2048')
    expect(text).toContain('4096')
    expect(text).toContain('8192')
    expect(text).toContain('极速识别（省电流畅）')
    expect(text).toContain('高清精识（适合票据与密字截图）')
    expect(text).not.toMatch(FORBIDDEN_JARGON_RE)
  })
})

describe('SLICE-08 Round 1 审查修复回归', () => {
  beforeEach(() => {
    useWorkspaceRuntimeContext.getState().reset()
  })

  it('Store 引用计数保护：弹窗 dispose 不错杀 Footer 共享快照，且空态 selectModuleStates 返回稳定引用', async () => {
    const snap = makeSnapshot({ contextEpoch: 7, recoverableCount: 12 })
    const unsubscribe = vi.fn()
    ;(window as any).electronAPI = {
      getWorkspaceRuntimeContextSnapshot: vi.fn().mockResolvedValue(snap),
      onWorkspaceRuntimeContextUpdated: vi.fn().mockReturnValue(unsubscribe)
    }

    // 空快照时两次 selector 调用必须返回同一引用（防 Zustand 无限重渲染）
    const emptyA = selectModuleStates(useWorkspaceRuntimeContext.getState())
    const emptyB = selectModuleStates(useWorkspaceRuntimeContext.getState())
    expect(Object.is(emptyA, emptyB)).toBe(true)

    // Footer + WorkspaceSettingsDialog 双消费者先后 initialize
    await useWorkspaceRuntimeContext.getState().initialize(1)
    await useWorkspaceRuntimeContext.getState().initialize(1)
    expect(useWorkspaceRuntimeContext.getState().snapshot?.contextEpoch).toBe(7)
    expect(useWorkspaceRuntimeContext.getState().subscriberRefCount).toBe(2)

    // 弹窗关闭触发一次 dispose：仍有 Footer 存活，快照与订阅必须保持
    useWorkspaceRuntimeContext.getState().dispose()
    expect(useWorkspaceRuntimeContext.getState().snapshot?.contextEpoch).toBe(7)
    expect(unsubscribe).not.toHaveBeenCalled()

    // Footer 卸载触发最后一次 dispose：归零后才释放
    useWorkspaceRuntimeContext.getState().dispose()
    expect(useWorkspaceRuntimeContext.getState().snapshot).toBeNull()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('TriStateFieldFeedback：generative_ai_disabled「保持当前模式」可收起提示条，user_custom 优先显示 baselineText', () => {
    const degradedField: ResolvedTriStateField<string> = {
      effectiveValue: 'simple',
      desiredValue: 'full',
      origin: 'workflow_default',
      applicability: 'degraded',
      visible: true,
      isUserCustom: false,
      degradationReason: 'generative_ai_disabled',
      fixAction: 'open_generative_engine'
    }
    const { rerender } = render(
      <TriStateFieldFeedback
        field={degradedField}
        effectiveText="极速基础整理"
        desiredText="深度理解"
        hasBoundWorkflow={true}
      />
    )
    expect(screen.getByText(/智能理解引擎未开启/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保持当前模式' }))
    expect(screen.queryByText(/智能理解引擎未开启/)).not.toBeInTheDocument()

    // user_custom && active 必须对照 baselineText，而不是重复显示用户自定义值
    const customField: ResolvedTriStateField<string> = {
      effectiveValue: 'full',
      desiredValue: 'full',
      origin: 'user_custom',
      applicability: 'active',
      visible: true,
      isUserCustom: true
    }
    rerender(
      <TriStateFieldFeedback
        field={customField}
        effectiveText="深度理解"
        desiredText="深度理解"
        baselineText="平衡整理"
        hasBoundWorkflow={true}
      />
    )
    expect(screen.getByText('（工作流默认：平衡整理）')).toBeInTheDocument()
  })

  it('WorkspacePluginsTab：user_custom + degraded 仅显示 1 个恢复默认按钮，且期望值正确显示「开启」', () => {
    const plugins: Record<string, ResolvedPluginTriState> = {
      asr_sensevoice_onnx: {
        effectiveValue: false,
        origin: 'user_custom',
        applicability: 'degraded',
        degradationReason: 'global_plugin_not_installed',
        workflowRecommendation: 'workflow_default_off',
        globalAvailability: 'available'
      }
    }
    render(
      <WorkspacePluginsTab
        workspaceId={1}
        plugins={plugins}
        hasBoundWorkflow={true}
      />
    )
    expect(screen.getAllByRole('button', { name: '恢复默认' })).toHaveLength(1)
    expect(screen.getByText('（用户自定义：开启）')).toBeInTheDocument()
  })
})
