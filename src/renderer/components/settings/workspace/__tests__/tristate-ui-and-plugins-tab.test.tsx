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

    // 语音听写卡片内（具体配置项下）恰好 1 条级联提示（双字段同因严禁重复）
    expect(screen.getAllByText('已由上级开关关闭')).toHaveLength(1)
    expect(screen.getAllByText(/您已在本目录关闭语音听写功能/)).toHaveLength(1)
    // 提供「重新开启」一键引导
    expect(screen.getByRole('button', { name: '重新开启' })).toBeInTheDocument()
  })
})

describe('SLICE-08: TriStateCustomFieldsTable 用户自定义参数汇总表格 (v1.5)', () => {
  const rows: TriStateCustomFieldRow[] = [
    {
      key: 'videoQuotaMax',
      label: '单视频最大抓图数量',
      globalDefaultText: '32',
      workflowDefaultText: '16',
      customText: '150'
    },
    {
      key: 'videoCutSensitivity',
      label: '镜头切换捕捉敏锐度',
      globalDefaultText: '标准分段挑选代表画面',
      workflowDefaultText: '灵敏 (推荐)',
      customText: '极高 (防吞噬)'
    }
  ]

  it('绑定工作流：逐行标明参数项 + 全局默认值/工作流默认值/用户自定义值三列对照 + 行内恢复默认按钮', () => {
    const onRestore = vi.fn()
    render(<TriStateCustomFieldsTable rows={rows} hasBoundWorkflow={true} onRestore={onRestore} />)
    expect(screen.getByText('参数项')).toBeInTheDocument()
    expect(screen.getByText('全局默认值')).toBeInTheDocument()
    expect(screen.getByText('工作流默认值')).toBeInTheDocument()
    expect(screen.getByText('用户自定义值')).toBeInTheDocument()
    // 逐行标明参数项名称与三值对照
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
})
