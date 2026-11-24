import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { TriStateFieldFeedback, getOcrModelSizeLabel } from '../TriStateFieldFeedback'
import {
  TriStateCustomFieldsTable,
  type TriStateCustomFieldRow
} from '../TriStateCustomFieldsTable'
import { WorkspacePluginsTab } from '../WorkspacePluginsTab'
import { ContentExtractionTab } from '../ContentExtractionTab'
import { BasicAIEngineTab } from '../BasicAIEngineTab'
import { VIDEO_COVERAGE_GRADIENT } from '../policy-slider-kit'
import { WorkspaceConfigPanel } from '../../WorkspaceConfigPanel'
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
import { usePluginCenterStore } from '../../../../stores/plugin-center-store'

// 禁止出现的底层工程黑话正则（AGENTS.md §2.16 & 规格书 §5.3）
const FORBIDDEN_JARGON_RE =
  /\b(ASR|OCR|CLIP|ONNX|gemma_unified|classic_light|LibreOffice|300s|Token)\b/

function makeSnapshot(
  overrides: Partial<WorkspaceRuntimeContextSnapshot> = {}
): WorkspaceRuntimeContextSnapshot {
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
    fireEvent.click(screen.getByRole('button', { name: /恢复全局默认/ }))
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

  it('严格仅渲染 11 个目录插件、绝不渲染 6 个全局插件，且预告区只读无假降级', () => {
    expect(WORKSPACE_CONFIGURABLE_PLUGIN_IDS).toHaveLength(11)
    expect(GLOBAL_ONLY_PLUGIN_IDS).toHaveLength(6)

    const { container } = render(
      <WorkspacePluginsTab workspaceId={42} plugins={{}} hasBoundWorkflow={false} />
    )

    // 仅主区 2 个插件带 Switch，预告区 9 个 coming_soon 只读无 Switch
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(2)

    const text = container.textContent ?? ''
    expect(text).toContain('语音听写')
    expect(text).toContain('内容安全识别')
    expect(text).toContain('压缩包透视与深度解析器')
    expect(text).toContain('照片人物识别')
    expect(text).toContain('图片物体标记')
    expect(text).toContain('加密文件解密助手')
    expect(text).toContain('不会自动暴力破解')
    expect(text).toContain('图片视频高清化')
    expect(text).toContain('图片视频去打码')
    expect(text).toContain('图片视频去水印')
    expect(text).toContain('文件AI封面图')
    expect(text).toContain('设计稿透视与深度解析器')
    // 未绑定工作流时不得误提「当前工作流主题」
    expect(text).not.toContain('当前工作流主题')
    expect(text).not.toContain('本主题推荐')
    expect(text).not.toMatch(FORBIDDEN_JARGON_RE)

    for (const globalId of GLOBAL_ONLY_PLUGIN_IDS) {
      expect(text).not.toContain(globalId)
    }
  })

  it('主区 Switch 等值回退：关闭至基线值提交 restorePluginOverrideIds，开启至非基线值提交 pluginOverridePatch，恢复默认提交 restorePluginOverrideIds（严禁传 null）', async () => {
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

    const { unmount } = render(
      <WorkspacePluginsTab workspaceId={9} plugins={plugins} hasBoundWorkflow={true} />
    )

    // 点击 Switch 切换为关闭：目标值 false === 工作流默认 false -> 等值回退精确删键算回默认态
    const asrSwitch = screen.getByRole('switch', { name: '语音听写' })
    fireEvent.click(asrSwitch)
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(9, {
        restorePluginOverrideIds: ['asr_sensevoice_onnx']
      })
    })

    // 点击恢复默认
    fireEvent.click(screen.getByRole('button', { name: /恢复工作流默认/ }))
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(9, {
        restorePluginOverrideIds: ['asr_sensevoice_onnx']
      })
    })

    unmount()

    // 非等值：基线关闭、当前关闭，点 Switch 开启（true !== false）-> 写入覆盖键
    const pluginsOff: Record<string, ResolvedPluginTriState> = {
      asr_sensevoice_onnx: {
        pluginId: 'asr_sensevoice_onnx',
        effectiveValue: false,
        origin: 'workflow_default',
        applicability: 'active',
        availability: 'approved',
        workflowRecommendation: 'workflow_default_off'
      }
    }
    render(<WorkspacePluginsTab workspaceId={9} plugins={pluginsOff} hasBoundWorkflow={true} />)
    fireEvent.click(screen.getByRole('switch', { name: '语音听写' }))
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(9, {
        pluginOverridePatch: { asr_sensevoice_onnx: true }
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
      getWorkspaceRuntimeContextSnapshot: vi
        .fn()
        .mockResolvedValue(makeSnapshot({ contextEpoch: 5 })),
      onWorkspaceRuntimeContextUpdated: vi.fn(
        (cb: (s: WorkspaceRuntimeContextSnapshot) => void) => {
          listener = cb
          return () => {
            listener = null
          }
        }
      )
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
    const mutRes = await submitWorkspacePolicyMutation(1, {
      overridePatch: { maxContentSizeKb: 2048 }
    })
    expect(mutRes.success).toBe(false)
    expect(mutRes.error).toBe('WORKSPACE_POLICY_MUTATION_CHANNEL_UNAVAILABLE')

    const recRes = await triggerWorkspaceIncrementalRecovery(1)
    expect(recRes.success).toBe(false)
    expect(recRes.error).toBe('WORKSPACE_INCREMENTAL_RECOVERY_CHANNEL_UNAVAILABLE')
  })
})

describe('SLICE-08: ContentExtractionTab 刻度重构与非标历史值保真', () => {
  const mockApplyMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockApplyMutation.mockResolvedValue({ success: true, policyVersion: 2 })
    ;(window as any).electronAPI = {
      applyWorkspacePolicyMutation: mockApplyMutation,
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

  it('v1.5 等值回退写端：触碰字段设为非基线值提交 overridePatch，改回基线值提交 restoreOverrideFields 精确删键', async () => {
    const workspace: any = {
      id: 8,
      name: 'Media',
      path: 'D:\\Media',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'full',
          enableImageOcr: true,
          enableOfficeCover: true,
          reuseBasicAnalysisData: true
        }
      })
    }
    render(<ContentExtractionTab workspace={workspace} />)

    // 1. 关闭图片文字识别（false !== 基线 true）-> 防抖 500ms 后提交覆盖补丁
    //    （防抖 timer 回调与异步落库的 setState 必须整体包裹在 act 内捕获）
    const ocrSwitch = screen.getByRole('switch', { name: '开启图片文字识别' })
    await act(async () => {
      fireEvent.click(ocrSwitch)
      await new Promise(resolve => setTimeout(resolve, 620))
    })
    expect(mockApplyMutation).toHaveBeenCalledWith(8, {
      overridePatch: { enableImageOcr: false }
    })

    // 2. 再开启回基线值（true === 基线 true）-> 等值回退精确删键算回默认态，不写覆盖
    await act(async () => {
      fireEvent.click(ocrSwitch)
      await new Promise(resolve => setTimeout(resolve, 620))
    })
    expect(mockApplyMutation).toHaveBeenCalledWith(8, {
      restoreOverrideFields: ['enableImageOcr']
    })
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
    render(<WorkspacePluginsTab workspaceId={1} plugins={plugins} hasBoundWorkflow={true} />)
    expect(screen.getAllByRole('button', { name: '恢复工作流默认' })).toHaveLength(1)
    expect(screen.getByText('（用户自定义：开启）')).toBeInTheDocument()
  })
})

describe('SLICE-08: BasicAIEngineTab 视频档位联动与基线恢复 (v1.5 等值回退)', () => {
  const mockApplyMutation = vi.fn()
  const originalModules = usePluginCenterStore.getState().modules

  beforeEach(() => {
    vi.clearAllMocks()
    mockApplyMutation.mockResolvedValue({ success: true, policyVersion: 2 })
    ;(window as any).electronAPI = {
      applyWorkspacePolicyMutation: mockApplyMutation,
      isPackaged: false
    }
    // 视频档位区块仅在 gemma_unified 全模态底座下渲染（classic_light 隐藏），需激活全局底座模块
    usePluginCenterStore.setState({
      modules: [
        {
          id: 'engine_gemma_unified',
          name: '全能视觉引擎',
          capability_slot: 'base_embedding',
          install_state: 'active'
        } as any
      ]
    })
  })

  afterEach(() => {
    usePluginCenterStore.setState({ modules: originalModules })
  })

  it('切非基线档写入全局预设覆盖，切回基线所属档位整组恢复工作流基线（严禁残留用户自定义）', async () => {
    // 基线 quotaMax=16 落在 9~79 区间被推导为「均衡搜索」档，但 balanced 全局预设 quotaMax=60 ≠ 基线
    const workspace: any = {
      id: 11,
      name: 'Light',
      path: 'D:\\Light',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'full',
          clipTextEnabled: false,
          videoQuotaMax: 16,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 30,
          audioAnalysisDurationSec: 60,
          enableImageOcr: false,
          maxDocumentOcrItems: 0,
          ocrModelSize: 'tiny',
          extractPages: 10,
          maxContentSizeKb: 1024,
          enableOfficeCover: true,
          reuseBasicAnalysisData: true
        }
      })
    }
    render(<BasicAIEngineTab workspace={workspace} />)

    // 1. 切「深度寻帧」（非基线档）-> 写入全局预设值作为用户覆盖
    fireEvent.click(screen.getByText(/深度寻帧/))
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          overridePatch: {
            videoQuotaMax: 150,
            videoCutSensitivity: 'high',
            videoSoftTokenBudget: 140,
            videoAsrDurationSec: 120
          }
        })
      )
    })

    // 2. 切回「均衡搜索」（工作流基线所属档位）-> 整组恢复基线值：全部走等值回退精确删键，
    //    严禁写入 balanced 全局预设 (60/medium/48/60) 造成 quotaMax=60 与 asr=60 残留用户自定义
    fireEvent.click(screen.getByText(/均衡搜索/))
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledWith(
        11,
        expect.objectContaining({
          restoreOverrideFields: expect.arrayContaining([
            'videoQuotaMax',
            'videoCutSensitivity',
            'videoSoftTokenBudget',
            'videoAsrDurationSec'
          ])
        })
      )
    })
    const restoreCall = mockApplyMutation.mock.calls.find(
      c => c[1]?.restoreOverrideFields !== undefined
    )
    expect(restoreCall?.[1]?.overridePatch).toBeUndefined()
  })

  it('ASR 级联关闭：顶部汇总区不重复罗列双时长提示，语音听写卡片内恰好渲染 1 条', () => {
    // 取消绑定工作流后：ASR 双时长字段同因 cascaded_off（parent_plugin_off_by_user）
    const cascadedField: ResolvedTriStateField = {
      effectiveValue: 0,
      desiredValue: 60,
      origin: 'system_default',
      applicability: 'cascaded_off',
      visible: true,
      isUserCustom: false,
      inactiveReason: 'parent_plugin_off_by_user'
    }
    const workspace: any = {
      id: 12,
      name: 'Unbound',
      path: 'D:\\Unbound',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'full',
          clipTextEnabled: false,
          videoQuotaMax: 16,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 30,
          audioAnalysisDurationSec: 60,
          enableImageOcr: false,
          maxDocumentOcrItems: 0,
          ocrModelSize: 'tiny',
          extractPages: 10,
          maxContentSizeKb: 1024,
          enableOfficeCover: true,
          reuseBasicAnalysisData: true
        }
      })
    }
    render(
      <BasicAIEngineTab
        workspace={workspace}
        resolvedFields={{
          videoAsrDurationSec: cascadedField,
          audioAnalysisDurationSec: cascadedField
        }}
        hasBoundWorkflow={false}
        onFixAction={vi.fn()}
      />
    )

    // 语音听写已移入高级参数区：先展开微调面板
    fireEvent.click(screen.getByText('展开微调'))
    // 语音听写卡片内（具体配置项下）恰好 1 条级联提示（双字段同因严禁重复）
    expect(screen.getAllByText('已由上级开关关闭')).toHaveLength(1)
    expect(screen.getAllByText(/您已在本目录关闭语音听写功能/)).toHaveLength(1)
    // 提供「重新开启」一键引导
    expect(screen.getByRole('button', { name: '重新开启' })).toBeInTheDocument()
  })

  it('Spec §4.2: BasicAIEngineTab 彻底净化营销文案，消除 Nagware 叫卖与 5 分钟限制提示', () => {
    const cleanWorkspace: any = {
      id: 12,
      name: 'CleanTest',
      path: 'D:\\CleanTest',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'full',
          videoAnalyzeDurationSec: 1800,
          videoQuotaMax: 60,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 60,
          audioAnalysisDurationSec: 60,
          enableImageOcr: true,
          maxDocumentOcrItems: 0,
          ocrModelSize: 'tiny',
          extractPages: 10,
          maxContentSizeKb: 1024,
          enableOfficeCover: true,
          reuseBasicAnalysisData: true
        }
      })
    }

    render(<BasicAIEngineTab workspace={cleanWorkspace} />)

    // 1. 验证彻底删除了滑块旁的「解锁更长」
    expect(screen.queryByText('解锁更长')).toBeNull()

    // 2. 验证彻底删除了黄色营销大横幅
    expect(screen.queryByText(/免费版每个视频分析精彩前 5 分钟/)).toBeNull()
    expect(screen.queryByText('立即升级 Pro')).toBeNull()

    // 3. 验证删除了「当前你是免费用户，最终结算值为5分钟」提示
    expect(screen.queryByText(/最终结算值为5分钟/)).toBeNull()

    // 4. 验证中性引导卡片正常呈现并可直达「待补分析文件」
    expect(screen.getByTestId('video-fast-first-slice-guide')).toBeTruthy()
    expect(screen.getByText(/为避免长视频卡住其它文件/)).toBeTruthy()
    expect(screen.getByText('查看待补分析文件 →')).toBeTruthy()
  })

  it('Bugfix: 对比组三控件因果对齐、统一 3 小时分段标尺及冷暖渐变平滑联动', () => {
    const workspaceInitial: any = {
      id: 13,
      name: 'DurationTest',
      path: 'D:\\DurationTest',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'full',
          videoAnalyzeDurationSec: 300, // 初始 5 分钟 (1 个切片)
          videoQuotaMax: 60,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 60,
          audioAnalysisDurationSec: 60
        }
      })
    }

    const { container } = render(<BasicAIEngineTab workspace={workspaceInitial} />)

    const slider = screen.getByTestId('video-analyze-duration-slider')
    const durationCapFill = screen.getByTestId('duration-cap-fill')
    const benchmarkFill = screen.getByTestId('benchmark-video-fill')
    const fullVideoFill = screen.getByTestId('full-video-fill')

    const durationLegend = screen.getByTestId('duration-cap-legend')
    const benchmarkLegend = screen.getByTestId('benchmark-video-legend')
    const fullLegend = screen.getByTestId('full-video-legend')

    // 1. 验证三项同构标题与排列顺序（控制源「每个视频分析时长上限」置顶 -> 首次整理耗时 -> 整片测算）
    const titleCap = screen.getByText('每个视频分析时长上限')
    const titleFirst = screen.getByText('单视频首次整理耗时预估')
    const titleFull = screen.getByText('按整片时长测算')
    expect(
      Boolean(titleCap.compareDocumentPosition(titleFirst) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)
    expect(
      Boolean(titleFirst.compareDocumentPosition(titleFull) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)

    // 验证统一 3 小时分段刻度标尺（三项均展示 5 分钟 / 30 分钟 / 1 小时 / 3 小时）
    expect(screen.getAllByText('5 分钟').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('30 分钟').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('1 小时').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('3 小时').length).toBeGreaterThanOrEqual(3)

    // 验证冷暖梯度设置及无工程黑话 (§2.16 Zero Jargon)
    expect(durationCapFill.style.backgroundImage || VIDEO_COVERAGE_GRADIENT).toContain('#38bdf8')
    expect(
      benchmarkFill.style.backgroundImage ||
        'linear-gradient(90deg, #10b981 0%, #22c55e 25%, #f59e0b 55%, #f97316 78%, #ef4444 100%)'
    ).toContain('#10b981')
    expect(
      benchmarkFill.style.backgroundImage ||
        'linear-gradient(90deg, #10b981 0%, #22c55e 25%, #f59e0b 55%, #f97316 78%, #ef4444 100%)'
    ).toContain('#ef4444')
    expect(
      fullVideoFill.style.backgroundImage ||
        'linear-gradient(90deg, #10b981 0%, #22c55e 25%, #f59e0b 55%, #f97316 78%, #ef4444 100%)'
    ).toContain('#10b981')
    expect(container.textContent ?? '').not.toMatch(FORBIDDEN_JARGON_RE)

    // 2. 初态 5 分钟 (300s)：滑块填充对齐 25% 刻度，两根耗时条宽度相等（56s -> 4.67%），基准/整片图例均为 60 张
    expect(durationCapFill).toHaveStyle({ width: '25%' })
    expect(benchmarkFill).toHaveStyle({ width: '4.67%' })
    expect(fullVideoFill).toHaveStyle({ width: '4.67%' })
    expect(fullVideoFill.style.backgroundSize).toBe(`${(100 / 4.67) * 100}% 100%`)
    expect(
      within(durationLegend).getByText(/可检索视频前 5 分钟全部画面与台词/)
    ).toBeInTheDocument()
    expect(within(fullLegend).getByText(/60\s*张/)).toBeInTheDocument()
    expect(within(benchmarkLegend).getByText(/60\s*张/)).toBeInTheDocument()

    // 3. 模拟真实拖动至 30 分钟 (1800s = 6 个切片)
    fireEvent.change(slider, { target: { value: '1800' } })

    // 滑块填充跃迁对齐 50% (30分钟刻度)，整片耗时 (300s) 映射为 25%，显著大于首次快出 (4.67%)
    expect(durationCapFill).toHaveStyle({ width: '50%' })
    expect(benchmarkFill).toHaveStyle({ width: '4.67%' })
    expect(fullVideoFill).toHaveStyle({ width: '25%' })
    expect(fullVideoFill.style.backgroundSize).toBe('400% 100%')
    expect(
      within(durationLegend).getByText(/可检索视频前 30 分钟全部画面与台词/)
    ).toBeInTheDocument()
    expect(screen.getByText('上限 30 分钟')).toBeInTheDocument()
    expect(within(fullLegend).getByText(/360\s*张/)).toBeInTheDocument()
    expect(within(fullLegend).getByText(/台词识别/)).toBeInTheDocument()
    expect(within(fullLegend).getByText(/基础开销/)).toBeInTheDocument()
    expect(within(benchmarkLegend).getByText(/60\s*张/)).toBeInTheDocument()

    // 4. 模拟拖动至 1 小时 (3600s = 12 个切片)：验证 75% 刻度与小时辅助文案
    fireEvent.change(slider, { target: { value: '3600' } })
    expect(durationCapFill).toHaveStyle({ width: '75%' })
    expect(screen.getByText('(约 1.0 小时)')).toBeInTheDocument()

    // 5. 模拟拖动至极限 3 小时 (10800s = 36 个切片)
    fireEvent.change(slider, { target: { value: '10800' } })

    expect(durationCapFill).toHaveStyle({ width: '100%' })
    expect(fullVideoFill).toHaveStyle({ width: '49.4%' })
    expect(screen.getByText('上限 180 分钟')).toBeInTheDocument()
    expect(within(fullLegend).getByText(/2160\s*张/)).toBeInTheDocument()
    expect(within(benchmarkLegend).getByText(/60\s*张/)).toBeInTheDocument()
  })

  it('对比组交互安全性与落盘闭环：指针拖拽、右键/取消防护、刻度点击与键盘防 Tab 误保存', () => {
    const originalPointerEvent = (globalThis as any).PointerEvent
    // jsdom 默认未挂载 PointerEvent，补齐以 MouseEvent 为基类的构造器保证 clientX 与 button 透传
    if (!originalPointerEvent) {
      ;(globalThis as any).PointerEvent = class extends MouseEvent {
        pointerType: string
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params)
          this.pointerType = params.pointerType ?? 'mouse'
        }
      }
    }
    vi.useFakeTimers()
    try {
      const workspace: any = {
        id: 14,
        name: 'InteractionTest',
        path: 'D:\\InteractionTest',
        workspace_config: JSON.stringify({
          schemaVersion: 1,
          status: 'ready',
          policyVersion: 1,
          baseAIConfig: {
            analysisMode: 'full',
            videoAnalyzeDurationSec: 300,
            videoQuotaMax: 60,
            videoCutSensitivity: 'medium',
            videoSoftTokenBudget: 48,
            videoAsrDurationSec: 60,
            audioAnalysisDurationSec: 60
          }
        })
      }

      render(<BasicAIEngineTab workspace={workspace} />)

      const track = screen.getByTestId('video-analyze-duration-track')
      const slider = screen.getByTestId('video-analyze-duration-slider')
      const durationCapFill = screen.getByTestId('duration-cap-fill')

      vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 400,
        top: 0,
        bottom: 12,
        width: 400,
        height: 12,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })

      // 1. Tab 切入焦点抬起键不得误触发保存
      fireEvent.keyUp(slider, { key: 'Tab' })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).not.toHaveBeenCalled()

      // 2. 鼠标右键点击轨道不得修改值或提交
      fireEvent.pointerDown(track, { pointerType: 'mouse', button: 2, clientX: 300 })
      fireEvent.pointerUp(track, { pointerType: 'mouse', button: 2, clientX: 300 })
      expect(durationCapFill).toHaveStyle({ width: '25%' })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).not.toHaveBeenCalled()

      // 3. pointerCancel 中断拖拽时：回退初始值 300s (25%)，严禁读取 clientX:0 并提交
      fireEvent.pointerDown(track, { pointerType: 'mouse', button: 0, clientX: 200 })
      expect(durationCapFill).toHaveStyle({ width: '50%' })
      fireEvent.pointerCancel(track, { pointerType: 'mouse', button: 0, clientX: 0 })
      expect(durationCapFill).toHaveStyle({ width: '25%' })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).not.toHaveBeenCalled()

      // 4. 左键真实拖动并松手：clientX=300 (75% -> 3600s / 1小时)，推进防抖后精确提交 3600
      fireEvent.pointerDown(track, { pointerType: 'mouse', button: 0, clientX: 200 })
      fireEvent.pointerMove(track, { pointerType: 'mouse', button: 0, clientX: 300 })
      expect(durationCapFill).toHaveStyle({ width: '75%' })
      fireEvent.pointerUp(track, { pointerType: 'mouse', button: 0, clientX: 300 })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).toHaveBeenLastCalledWith(14, {
        overridePatch: { videoAnalyzeDurationSec: 3600 }
      })

      // 5. 点击「30 分钟」刻度按钮快捷跳转：立即跳转 1800s (50%) 并提交
      mockApplyMutation.mockClear()
      fireEvent.click(screen.getByRole('button', { name: '30 分钟' }))
      expect(durationCapFill).toHaveStyle({ width: '50%' })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).toHaveBeenLastCalledWith(14, {
        overridePatch: { videoAnalyzeDurationSec: 1800 }
      })

      // 6. 键盘导航改值 + keyUp 立即进入提交调度
      mockApplyMutation.mockClear()
      fireEvent.change(slider, { target: { value: '600' } })
      fireEvent.keyUp(slider, { key: 'ArrowLeft' })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).toHaveBeenLastCalledWith(14, {
        overridePatch: { videoAnalyzeDurationSec: 600 }
      })
    } finally {
      vi.useRealTimers()
      if (!originalPointerEvent) {
        delete (globalThis as any).PointerEvent
      } else {
        ;(globalThis as any).PointerEvent = originalPointerEvent
      }
    }
  })

  it('视频伴音台词与纯音频听写时长上限：四行同构风格对齐、刻度跳转及快速连续拖动防闪动回退', async () => {
    const originalPointerEvent = (globalThis as any).PointerEvent
    if (!originalPointerEvent) {
      ;(globalThis as any).PointerEvent = class extends MouseEvent {
        pointerType: string
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params)
          this.pointerType = params.pointerType ?? 'mouse'
        }
      }
    }
    vi.useFakeTimers()
    try {
      const makeWorkspace = (overrides?: Record<string, unknown>) => ({
        id: 15,
        name: 'AsrRaceTest',
        path: 'D:\\AsrRaceTest',
        workspace_config: JSON.stringify({
          schemaVersion: 1,
          status: 'ready',
          policyVersion: 1,
          baseAIConfig: {
            analysisMode: 'full',
            videoAnalyzeDurationSec: 300,
            videoQuotaMax: 60,
            videoCutSensitivity: 'medium',
            videoSoftTokenBudget: 48,
            videoAsrDurationSec: 30,
            audioAnalysisDurationSec: 60
          },
          ...(overrides ? { overrides } : {})
        })
      })

      let resolveFirstSave!: (val: any) => void
      const firstSavePromise = new Promise(resolve => {
        resolveFirstSave = resolve
      })
      mockApplyMutation
        .mockReturnValueOnce(firstSavePromise)
        .mockResolvedValue({ success: true, policyVersion: 2 })

      const { container, rerender } = render(
        <BasicAIEngineTab workspace={makeWorkspace() as any} />
      )

      // 展开微调面板显示 ASR 双滑块
      fireEvent.click(screen.getByText('展开微调'))

      const videoAsrTrack = screen.getByTestId('video-asr-cap-track')
      const videoAsrFill = screen.getByTestId('video-asr-cap-fill')
      const videoAsrLegend = screen.getByTestId('video-asr-cap-legend')

      const audioAsrTrack = screen.getByTestId('audio-analysis-cap-track')
      const audioAsrFill = screen.getByTestId('audio-analysis-cap-fill')
      const audioAsrLegend = screen.getByTestId('audio-analysis-cap-legend')

      // 1. 验证四行同构风格对齐：胶囊、渐变、刻度与无工程黑话 (§2.16)
      expect(screen.getAllByText('15 秒一档 · 最长 3 分钟')).toHaveLength(2)
      expect(screen.getAllByText('45 秒')).toHaveLength(2)
      expect(screen.getAllByText('90 秒')).toHaveLength(2)
      expect(screen.getAllByText('135 秒')).toHaveLength(2)
      expect(screen.getAllByText('3 分钟')).toHaveLength(2)

      expect(videoAsrFill.style.backgroundImage || VIDEO_COVERAGE_GRADIENT).toContain('#38bdf8')
      expect(audioAsrFill.style.backgroundImage || VIDEO_COVERAGE_GRADIENT).toContain('#38bdf8')
      expect(videoAsrFill).toHaveStyle({ width: '16.67%' }) // 30 / 180
      expect(audioAsrFill).toHaveStyle({ width: '33.33%' }) // 60 / 180
      expect(within(videoAsrLegend).getByText(/涵盖短视频与片头核心台词/)).toBeInTheDocument()
      expect(within(audioAsrLegend).getByText(/涵盖语音备忘与短录音/)).toBeInTheDocument()
      expect(container.textContent ?? '').not.toMatch(FORBIDDEN_JARGON_RE)

      // Mock 轨道几何尺寸 (width: 360 -> 1px = 0.5s, step=15s)
      const mockRect = {
        left: 0,
        right: 360,
        top: 0,
        bottom: 12,
        width: 360,
        height: 12,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }
      vi.spyOn(videoAsrTrack, 'getBoundingClientRect').mockReturnValue(mockRect)
      vi.spyOn(audioAsrTrack, 'getBoundingClientRect').mockReturnValue(mockRect)

      // 2. 防闪动回退核心复现场景：
      // (a) 先将「视频伴音台词识别上限」拖至 90s (clientX: 180 -> 50%) 松手，推进 550ms 发出第 1 次 IPC (飞行中)
      fireEvent.pointerDown(videoAsrTrack, { pointerType: 'mouse', button: 0, clientX: 180 })
      fireEvent.pointerUp(videoAsrTrack, { pointerType: 'mouse', button: 0, clientX: 180 })
      expect(videoAsrFill).toHaveStyle({ width: '50%' })
      act(() => {
        vi.advanceTimersByTime(550)
      })
      expect(mockApplyMutation).toHaveBeenCalledTimes(1)
      expect(mockApplyMutation).toHaveBeenLastCalledWith(15, {
        overridePatch: { videoAsrDurationSec: 90 }
      })

      // (b) 第 1 次 IPC 尚未返回，用户快速连续再次拖动并停在 150s (clientX: 300 -> 83.33%)，松手处于第 2 轮防抖窗口
      fireEvent.pointerDown(videoAsrTrack, { pointerType: 'mouse', button: 0, clientX: 210 })
      fireEvent.pointerMove(videoAsrTrack, { pointerType: 'mouse', button: 0, clientX: 300 })
      expect(videoAsrFill).toHaveStyle({ width: '83.33%' })
      fireEvent.pointerUp(videoAsrTrack, { pointerType: 'mouse', button: 0, clientX: 300 })

      // (c) 模拟外部异步旧快照回写 (携带上一轮 90s 或最初 30s 的 workspace_config)
      rerender(<BasicAIEngineTab workspace={makeWorkspace({ videoAsrDurationSec: 90 }) as any} />)

      // 核心断言：即使外部传入旧值 90s，控件绝不可闪动回退！仍稳固保持 150 秒 (83.33%)
      expect(videoAsrFill).toHaveStyle({ width: '83.33%' })
      expect(screen.getByText('150 秒')).toBeInTheDocument()

      // (d) 结束第 1 轮飞行，推进 600ms 验证最终落盘仍为最新值 150s
      await act(async () => {
        resolveFirstSave({ success: true, policyVersion: 2 })
        await Promise.resolve()
      })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).toHaveBeenLastCalledWith(15, {
        overridePatch: { videoAsrDurationSec: 150 }
      })

      // 3. 验证纯音频滑块拖拽中锁定不被外部刷退，以及 pointerCancel 复位、0s/3分钟刻度点击
      fireEvent.pointerDown(audioAsrTrack, { pointerType: 'mouse', button: 0, clientX: 270 }) // 135s (75%)
      expect(audioAsrFill).toHaveStyle({ width: '75%' })
      // 拖动中即使外部 rerender 传回旧值 60s，拖拽态仍牢牢锁住当前位置 135s
      rerender(
        <BasicAIEngineTab
          workspace={
            makeWorkspace({ videoAsrDurationSec: 150, audioAnalysisDurationSec: 60 }) as any
          }
        />
      )
      expect(audioAsrFill).toHaveStyle({ width: '75%' })
      // pointerCancel 中断后复位至 60s (33.33%) 且不误落盘
      fireEvent.pointerCancel(audioAsrTrack, { pointerType: 'mouse', button: 0, clientX: 0 })
      expect(audioAsrFill).toHaveStyle({ width: '33.33%' })

      // 点击纯音频第 2 组刻度「0」按钮 -> 立即跳 0s 并显示不听写与暂停态
      mockApplyMutation.mockClear()
      const zeroButtons = screen.getAllByRole('button', { name: '0' })
      fireEvent.click(zeroButtons[1])
      expect(audioAsrFill).toHaveStyle({ width: '0%' })
      expect(within(audioAsrLegend).getByText(/已关闭纯音频听写/)).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(mockApplyMutation).toHaveBeenLastCalledWith(15, {
        overridePatch: { audioAnalysisDurationSec: 0 }
      })
    } finally {
      vi.useRealTimers()
      if (!originalPointerEvent) {
        delete (globalThis as any).PointerEvent
      } else {
        ;(globalThis as any).PointerEvent = originalPointerEvent
      }
    }
  })
})

describe('SLICE-08: 设置值四态表格（四态表格）', () => {
  const rows: TriStateCustomFieldRow[] = [
    {
      key: 'videoQuotaMax',
      label: '单视频最大抓图数量',
      globalDefaultText: '32',
      workflowDefaultText: '16',
      customText: '150',
      finalText: '80'
    },
    {
      key: 'videoCutSensitivity',
      label: '镜头切换捕捉敏锐度',
      globalDefaultText: '标准分段挑选代表画面',
      workflowDefaultText: '灵敏 (推荐)',
      customText: '极高 (防吞噬)',
      finalText: '灵敏 (推荐)'
    }
  ]

  it('绑定工作流：逐行标明参数项 + 全局默认值/工作流默认值/用户自定义值三列对照 + 行内恢复默认按钮', () => {
    const onRestore = vi.fn()
    render(<TriStateCustomFieldsTable rows={rows} hasBoundWorkflow={true} onRestore={onRestore} />)
    expect(screen.getByText('参数项')).toBeInTheDocument()
    expect(screen.getByText('全局默认值')).toBeInTheDocument()
    expect(screen.getByText('工作流默认值')).toBeInTheDocument()
    expect(screen.getByText('用户自定义值')).toBeInTheDocument()
    expect(screen.getByText('最终结算值')).toBeInTheDocument()
    expect(screen.getByText('80')).toBeInTheDocument()
    // 逐行标明参数项名称与四值对照
    expect(screen.getByText('单视频最大抓图数量')).toBeInTheDocument()
    expect(screen.getByText('镜头切换捕捉敏锐度')).toBeInTheDocument()
    expect(screen.getByText('16')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument()
    // 行内恢复工作流默认按钮透出字段键
    const restoreButtons = screen.getAllByRole('button', { name: /恢复工作流默认/ })
    expect(restoreButtons).toHaveLength(2)
    fireEvent.click(restoreButtons[0])
    expect(onRestore).toHaveBeenCalledWith('videoQuotaMax')
  })

  it('未绑定工作流：不渲染工作流默认值列（基线即全局默认值），按钮文案为恢复全局默认', () => {
    const onRestore = vi.fn()
    render(<TriStateCustomFieldsTable rows={rows} hasBoundWorkflow={false} onRestore={onRestore} />)
    expect(screen.getByText('全局默认值')).toBeInTheDocument()
    expect(screen.queryByText('工作流默认值')).not.toBeInTheDocument()
    expect(screen.queryByText('恢复工作流默认')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /恢复全局默认/ })[0])
    expect(onRestore).toHaveBeenCalledWith('videoQuotaMax')
  })

  it('空行集返回 null（零冗余，不渲染空表壳）', () => {
    const { container } = render(
      <TriStateCustomFieldsTable rows={[]} hasBoundWorkflow={true} onRestore={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('SLICE-08: Round 2 盲审修复回归 (防抖竞态与面板等值分流)', () => {
  const mockApplyMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockApplyMutation.mockResolvedValue({ success: true, policyVersion: 3 })
    ;(window as any).electronAPI = {
      applyWorkspacePolicyMutation: mockApplyMutation
    }
  })

  it('HIGH-1 防抖竞态：500ms 窗口内改值后点行内恢复，先冲刷 patch 再发 restore（严禁恢复被静默写回撤销）', async () => {
    const workspace: any = {
      id: 13,
      name: 'Race',
      path: 'D:\Race',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        baseAIConfig: {
          analysisMode: 'full',
          clipTextEnabled: false,
          videoQuotaMax: 16,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 30,
          audioAnalysisDurationSec: 60,
          enableImageOcr: true,
          maxDocumentOcrItems: 0,
          ocrModelSize: 'tiny',
          extractPages: 10,
          maxContentSizeKb: 1024,
          enableOfficeCover: true,
          reuseBasicAnalysisData: true
        }
      })
    }
    const customOcrField: ResolvedTriStateField = {
      effectiveValue: true,
      desiredValue: true,
      origin: 'user_custom',
      applicability: 'active',
      visible: true,
      isUserCustom: true
    }
    render(
      <ContentExtractionTab
        workspace={workspace}
        resolvedFields={{ enableImageOcr: customOcrField }}
        hasBoundWorkflow={false}
      />
    )

    // 1. 关闭图片文字识别（false ≠ 基线 true）→ patch 进入 500ms 防抖队列
    fireEvent.click(screen.getByRole('switch', { name: '开启图片文字识别' }))
    // 2. 500ms 窗口内立即点表格行内「恢复全局默认」→ 必须先冲刷 patch 再发 restore
    //    （顶部还有同名「恢复全部」按钮，须 within 表格定位行内按钮）
    const tableEl = screen.getByText('参数项').closest('table') as HTMLElement
    fireEvent.click(within(tableEl).getAllByRole('button', { name: /恢复全局默认/ })[0])
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledTimes(2)
    })
    // 服务端按到达序处理：patch 先落盘、restore 后到删除 → 最终该键被恢复
    expect(mockApplyMutation.mock.calls[0][1]).toEqual({
      overridePatch: { enableImageOcr: false }
    })
    expect(mockApplyMutation.mock.calls[1][1]).toEqual({
      restoreOverrideFields: ['enableImageOcr']
    })
  })

  it('HIGH-2 面板等值分流：ready 时以存储 baseAIConfig 判等（等值键走 restore、非等值键走 patch）', async () => {
    const workspace: any = {
      id: 14,
      name: 'Panel',
      path: 'D:\Panel',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        intent: 'video_production',
        baseAIConfig: {
          analysisMode: 'full',
          clipTextEnabled: false,
          videoQuotaMax: 80,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 60,
          audioAnalysisDurationSec: 90,
          enableImageOcr: true,
          maxDocumentOcrItems: 0,
          ocrModelSize: 'tiny',
          extractPages: 10,
          maxContentSizeKb: 1024,
          enableOfficeCover: true,
          reuseBasicAnalysisData: true
        },
        // 存量覆盖：videoQuotaMax 与存储基线等值（须 restore）、enableImageOcr 非等值（须 patch）
        overrides: { videoQuotaMax: 80, enableImageOcr: false }
      })
    }
    render(<WorkspaceConfigPanel workspace={workspace} />)
    fireEvent.click(screen.getByRole('button', { name: /保存并应用策略/ }))
    await waitFor(() => {
      expect(mockApplyMutation).toHaveBeenCalledTimes(1)
    })
    const mutation = mockApplyMutation.mock.calls[0][1]
    expect(mutation.restoreOverrideFields).toContain('videoQuotaMax')
    expect(mutation.overridePatch).toEqual({ enableImageOcr: false })
  })

  describe('SLICE-08: ContentExtractionTab 三控件同构风格与无闪回滑块', () => {
    const makeContentWorkspace = (overridesObj: Record<string, any> = {}) => ({
      id: 20,
      name: 'ContentWS',
      path: 'D:\\ContentWS',
      workspace_config: JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        intent: 'office_doc',
        baseAIConfig: {
          analysisMode: 'simple',
          clipTextEnabled: true,
          videoQuotaMax: 32,
          videoCutSensitivity: 'medium',
          videoSoftTokenBudget: 48,
          videoAsrDurationSec: 30,
          audioAnalysisDurationSec: 60,
          enableImageOcr: true,
          maxDocumentOcrItems: 3,
          ocrModelSize: 'tiny',
          extractPages: 2,
          maxContentSizeKb: 1024,
          enableOfficeCover: false,
          reuseBasicAnalysisData: true
        },
        overrides: overridesObj
      })
    })

    it('ContentExtractionTab 三滑块四行同构、胶囊、渐变及无工程黑话', () => {
      const { container } = render(
        <ContentExtractionTab workspace={makeContentWorkspace() as any} />
      )

      // 1. 正文提取大小上限
      const contentTrack = screen.getByTestId('max-content-size-track')
      const contentFill = screen.getByTestId('max-content-size-fill')
      const contentSlider = screen.getByTestId('max-content-size-slider')
      const contentLegend = screen.getByTestId('max-content-size-legend')
      expect(contentTrack).toBeInTheDocument()
      expect(contentSlider).toBeInTheDocument()
      expect(contentFill.style.backgroundImage || VIDEO_COVERAGE_GRADIENT).toContain('#38bdf8')
      expect(screen.getByText('按需选择 · 可设不限')).toBeInTheDocument()
      expect(within(contentLegend).getByText(/涵盖日常文档与短文章/)).toBeInTheDocument()

      // 2. PDF 提取页数
      const pdfTrack = screen.getByTestId('pdf-extract-pages-track')
      const pdfFill = screen.getByTestId('pdf-extract-pages-fill')
      const pdfSlider = screen.getByTestId('pdf-extract-pages-slider')
      const pdfLegend = screen.getByTestId('pdf-extract-pages-legend')
      expect(pdfTrack).toBeInTheDocument()
      expect(pdfSlider).toBeInTheDocument()
      expect(pdfFill.style.backgroundImage || VIDEO_COVERAGE_GRADIENT).toContain('#38bdf8')
      expect(screen.getByText('1 页一档 · 可全本不限')).toBeInTheDocument()
      expect(within(pdfLegend).getByText(/涵盖摘要与目录页/)).toBeInTheDocument()

      // 3. 文档内嵌图片识别数量上限
      const ocrTrack = screen.getByTestId('max-doc-ocr-items-track')
      const ocrFill = screen.getByTestId('max-doc-ocr-items-fill')
      const ocrSlider = screen.getByTestId('max-doc-ocr-items-slider')
      const ocrLegend = screen.getByTestId('max-doc-ocr-items-legend')
      expect(ocrTrack).toBeInTheDocument()
      expect(ocrSlider).toBeInTheDocument()
      expect(ocrFill.style.backgroundImage || VIDEO_COVERAGE_GRADIENT).toContain('#38bdf8')
      expect(screen.getByText('0 为关闭 · 可设不限')).toBeInTheDocument()
      expect(within(ocrLegend).getByText(/涵盖带插图的常见文档/)).toBeInTheDocument()

      // 绝无工程黑话
      expect(container.textContent ?? '').not.toMatch(FORBIDDEN_JARGON_RE)
    })

    it('刻度点击交互：4096 KB、全本不限、关闭(0)', async () => {
      vi.useFakeTimers()
      mockApplyMutation.mockResolvedValue({ success: true, policyVersion: 2 })
      try {
        render(<ContentExtractionTab workspace={makeContentWorkspace() as any} />)

        // (a) 点 4096 刻度
        const btn4096 = screen.getByRole('button', { name: '4096' })
        fireEvent.click(btn4096)
        act(() => {
          vi.advanceTimersByTime(550)
        })
        expect(mockApplyMutation).toHaveBeenCalledTimes(1)
        expect(mockApplyMutation).toHaveBeenLastCalledWith(20, {
          overridePatch: { maxContentSizeKb: 4096 }
        })

        // (b) 点全本不限刻度
        mockApplyMutation.mockClear()
        const btnAllPages = screen.getByRole('button', { name: '全本不限' })
        fireEvent.click(btnAllPages)
        act(() => {
          vi.advanceTimersByTime(550)
        })
        expect(mockApplyMutation).toHaveBeenCalledTimes(1)
        expect(mockApplyMutation).toHaveBeenLastCalledWith(20, {
          overridePatch: { extractPages: -1 }
        })

        // (c) 点 0 (关闭文档内图片识别)
        mockApplyMutation.mockClear()
        const zeroBtn = screen.getByRole('button', { name: '0' })
        fireEvent.click(zeroBtn)
        const ocrLegend = screen.getByTestId('max-doc-ocr-items-legend')
        expect(within(ocrLegend).getByText(/已关闭文档图片识别/)).toBeInTheDocument()
        act(() => {
          vi.advanceTimersByTime(550)
        })
        expect(mockApplyMutation).toHaveBeenCalledTimes(1)
        expect(mockApplyMutation).toHaveBeenLastCalledWith(20, {
          overridePatch: { maxDocumentOcrItems: 0 }
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('历史非标值（如 100 KB）保真展示，不被静默落回其它刻度', () => {
      render(
        <ContentExtractionTab workspace={makeContentWorkspace({ maxContentSizeKb: 100 }) as any} />
      )
      expect(screen.getByText('100 KB')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '100' })).toBeInTheDocument()
    })

    it('真实 inFlight 飞行中防闪回：pendingPatch 为空时旧快照回传不闪回', async () => {
      vi.useFakeTimers()
      let resolveFirstSave!: (val: any) => void
      const firstSavePromise = new Promise(resolve => {
        resolveFirstSave = resolve
      })
      mockApplyMutation
        .mockReturnValueOnce(firstSavePromise)
        .mockResolvedValue({ success: true, policyVersion: 2 })

      try {
        const { rerender } = render(
          <ContentExtractionTab workspace={makeContentWorkspace() as any} />
        )

        // 1. 点 2048 刻度，推进 550ms 进入飞行中 (此时 pendingPatchRef === null)
        fireEvent.click(screen.getByRole('button', { name: '2048' }))
        act(() => {
          vi.advanceTimersByTime(550)
        })
        expect(mockApplyMutation).toHaveBeenCalledTimes(1)
        expect(screen.getByText('2048 KB')).toBeInTheDocument()

        // 2. 模拟外部异步带回旧快照 (maxContentSizeKb: 1024)
        rerender(
          <ContentExtractionTab
            workspace={makeContentWorkspace({ maxContentSizeKb: 1024 }) as any}
          />
        )

        // 核心断言：在途登记层 (inFlightRef) 牢牢锁住 2048 KB，绝对不闪回 1024 KB！
        expect(screen.getByText('2048 KB')).toBeInTheDocument()

        // 3. 飞行中请求成功返回
        await act(async () => {
          resolveFirstSave({ success: true, policyVersion: 2 })
          await Promise.resolve()
        })

        // 再次传入旧快照（此时位于 ackedRef 保护层中），依然稳固保持 2048 KB
        rerender(
          <ContentExtractionTab
            workspace={makeContentWorkspace({ maxContentSizeKb: 1024 }) as any}
          />
        )
        expect(screen.getByText('2048 KB')).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    it('onConfigSaved 引用频繁变更不击穿防抖窗口', async () => {
      vi.useFakeTimers()
      mockApplyMutation.mockResolvedValue({ success: true, policyVersion: 2 })
      try {
        let callbackCount = 0
        const { rerender } = render(
          <ContentExtractionTab
            workspace={makeContentWorkspace() as any}
            onConfigSaved={() => {
              callbackCount++
            }}
          />
        )

        // 触发变更
        fireEvent.click(screen.getByRole('button', { name: '4096' }))
        act(() => {
          vi.advanceTimersByTime(200)
        })

        // rerender 并更换新的 onConfigSaved 引用
        rerender(
          <ContentExtractionTab
            workspace={makeContentWorkspace() as any}
            onConfigSaved={() => {
              callbackCount += 10
            }}
          />
        )

        // 再过 200ms（总计 400ms，未到 500ms），绝不可提前触发
        act(() => {
          vi.advanceTimersByTime(200)
        })
        expect(mockApplyMutation).toHaveBeenCalledTimes(0)

        // 推进到 550ms，触发且仅触发 1 次，并调用最新的 callback
        act(() => {
          vi.advanceTimersByTime(150)
        })
        expect(mockApplyMutation).toHaveBeenCalledTimes(1)
        await act(async () => {
          await Promise.resolve()
        })
        expect(callbackCount).toBe(10)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
