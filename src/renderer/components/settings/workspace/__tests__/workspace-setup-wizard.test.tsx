// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceSetupWizard } from '../WorkspaceSetupWizard'
import { WorkspaceDirectory } from '@firefly/types'

// Mock 语言包
vi.mock('@app/languages', () => ({
  t: (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]))
      }
      return res
    }
    return key
  },
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: (s: string) => s, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

// Mock Toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

describe('WorkspaceSetupWizard (Spec v1.1 §2.3, §3.3 & Ticket 04)', () => {
  const mockWorkspace: WorkspaceDirectory = {
    id: 1,
    workspace_id: 1,
    path: 'D:/mock/desktop',
    name: 'desktop',
    type: 'SPEEDY',
    recursive: true,
    isActive: true,
    workspace_config: JSON.stringify({
      schemaVersion: 1,
      status: 'pending'
    })
  }

  const mockWorkflows = [
    {
      id: 'builtin.workflow.desktop-declutter',
      name: '电脑桌面急救与杂乱清理流',
      category: 'office',
      persona: '日常行政办公',
      summary: '针对临时截图与快捷方式的急救清理',
      // 覆盖「无常见扩展名清单」分支：预览树扩展名应回退到白名单首个扩展名规则
      extensions: JSON.stringify({ common: [] }),
      naming_template: '{YYYYMMDD}_{分类}_{原名}.{ext}',
      preset_directory_tree: JSON.stringify([
        {
          name: '01_快捷方式',
          subdirectories: [{ name: '常用办公', subdirectories: [] }]
        },
        {
          name: '02_截图草稿',
          subdirectories: []
        }
      ]),
      // 与生产预设 (organize-taxonomy-source.ts) 同构：白名单/排除规则为 IFilterRule 对象数组
      workspace_config: JSON.stringify({
        customWhitelistRules: [
          {
            id: 'builtin.workflow.desktop-declutter-common-1',
            type: 'extension',
            value: '.lnk',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-2',
            type: 'extension',
            value: '.png',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.desktop-declutter-common-3',
            type: 'extension',
            value: '.docx',
            isActive: true,
            isSystem: true
          }
        ],
        customIgnoreRules: [
          {
            id: 'builtin.workflow.desktop-declutter-ignore-1',
            type: 'directory',
            value: 'Desktop_Old_Backups',
            isActive: true,
            isSystem: true
          }
        ]
      })
    },
    {
      id: 'builtin.workflow.downloads-triage',
      name: '下载目录全景分流与清理流',
      category: 'office',
      persona: '网络下载全景分流',
      summary: '安装包与临时下载文档的一键归拢',
      extensions: JSON.stringify({ common: ['.exe', '.zip'] }),
      naming_template: '{YYYYMMDD}_{安装包名}.{ext}',
      preset_directory_tree: JSON.stringify([{ name: '01_安装程序', subdirectories: [] }]),
      // 无专属排除规则 (空数组)
      workspace_config: JSON.stringify({
        customWhitelistRules: [
          {
            id: 'builtin.workflow.downloads-triage-common-1',
            type: 'extension',
            value: '.exe',
            isActive: true,
            isSystem: true
          },
          {
            id: 'builtin.workflow.downloads-triage-common-2',
            type: 'extension',
            value: '.zip',
            isActive: true,
            isSystem: true
          }
        ],
        customIgnoreRules: []
      })
    },
    {
      id: 'builtin.workflow.generic-all-files',
      name: '通用全文件纳管流',
      category: 'office',
      persona: '通用文件管理',
      summary: '不限制扩展名，纳管全部受控文件',
      extensions: JSON.stringify({ common: ['.dat'] }),
      naming_template: '{YYYYMMDD}_{FileName}.{ext}',
      preset_directory_tree: '[]',
      // 空白名单
      workspace_config: JSON.stringify({
        customWhitelistRules: [],
        customIgnoreRules: []
      })
    },
    {
      id: 'wf-4',
      name: '创意设计流 1',
      category: 'creative',
      summary: '创意 1',
      workspace_config: '{}'
    },
    {
      id: 'wf-5',
      name: '创意设计流 2',
      category: 'creative',
      summary: '创意 2',
      workspace_config: '{}'
    },
    {
      id: 'wf-6',
      name: '娱乐生活流 1',
      category: 'entertainment',
      summary: '娱乐 1',
      workspace_config: '{}'
    },
    {
      id: 'wf-7',
      name: '娱乐生活流 2',
      category: 'entertainment',
      summary: '娱乐 2',
      workspace_config: '{}'
    },
    {
      id: 'wf-8',
      name: '测试工作流 8',
      category: 'office',
      summary: '测试 8',
      workspace_config: '{}'
    }
  ]

  const mockProfileResult = {
    detectedIntent: 'fast_archive',
    confidence: 0.9,
    stats: {
      totalSampled: 100,
      docCount: 30,
      imageCount: 40,
      videoCount: 10,
      otherCount: 20,
      durationMs: 45,
      hitTimeBudget: false,
      topExtensions: [
        { ext: '.png', count: 35 },
        { ext: '.lnk', count: 25 },
        { ext: '.docx', count: 15 },
        { ext: '.zip', count: 10 },
        { ext: '.log', count: 15 }
      ]
    }
  }

  let mockCommitWorkspacePolicy: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockCommitWorkspacePolicy = vi.fn().mockResolvedValue({
      success: true,
      policyVersion: 2,
      appliedConfig: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 2
      }
    })

    // Mock window.electronAPI
    ;(window as any).electronAPI = {
      getLocalWorkflows: vi.fn().mockResolvedValue({
        success: true,
        data: mockWorkflows
      }),
      utils: {
        probeDirectoryProfile: vi.fn().mockResolvedValue(mockProfileResult)
      },
      commitWorkspacePolicy: mockCommitWorkspacePolicy
    }
  })

  it('AC-4.2: 步骤 1 渲染全局比例条、通栏推荐横幅、分类 Tab 与 Top 6 卡片，并支持展开/收起', async () => {
    const onFinish = vi.fn()
    render(<WorkspaceSetupWizard workspace={mockWorkspace} onFinish={onFinish} />)

    // 等待工作流加载
    await waitFor(() => {
      expect(screen.getByText('当前目录文件构成特征')).toBeDefined()
    })

    // 全局比例条抽样数
    expect(screen.getByText(/抽样 100 个文件/)).toBeDefined()
    expect(screen.getByText('已完成多维画像嗅探')).toBeDefined()

    // 默认展示分类与卡片（mockWorkflows 共有 8 套，Top 6 限制下默认只呈现 6 套）
    expect(screen.getByText('全场景官方工作流矩阵库')).toBeDefined()
    const matches = screen.getAllByText('电脑桌面急救与杂乱清理流')
    expect(matches.length).toBeGreaterThan(0)

    // 展开按钮初始文案
    const toggleBtn = screen.getByText(/展示所有工作流 \(共 8 套\)/)
    expect(toggleBtn).toBeDefined()

    // 点击展开
    fireEvent.click(toggleBtn)
    expect(screen.getByText('收起工作流列表 (仅展示推荐)')).toBeDefined()
    expect(screen.getByText('测试工作流 8')).toBeDefined()

    // 再次点击收起
    fireEvent.click(screen.getByText('收起工作流列表 (仅展示推荐)'))
    expect(screen.getByText(/展示所有工作流 \(共 8 套\)/)).toBeDefined()

    // 右侧纯函数预览树检查单点原型
    expect(screen.getByText('预期整理目录结构')).toBeDefined()
    expect(screen.getByText('命名样例')).toBeDefined()
    expect(screen.getByText(/安全无损/)).toBeDefined()
  })

  it('AC-4.3 & AC-4.4: 步骤 2 自动隐藏推荐横幅，精准计算实测命中数；专属排除无则彻底隐藏 DOM', async () => {
    const onFinish = vi.fn()
    render(<WorkspaceSetupWizard workspace={mockWorkspace} onFinish={onFinish} />)

    await waitFor(() => {
      expect(screen.getAllByText('电脑桌面急救与杂乱清理流').length).toBeGreaterThan(0)
    })

    // 点击进入步骤 2
    const nextBtn = screen.getByRole('button', { name: /下一步/ })
    fireEvent.click(nextBtn)

    // 步骤 2 视图检查：推荐首选横幅已隐藏
    expect(screen.queryByText(/🔥 推荐首选/)).toBeNull()

    // 包含板块与实测命中数计算：
    // 白名单: .lnk (25) + .png (35) + .docx (15) = 75 / 100
    expect(screen.getByText(/基于当前目录扫描，预计将展示 75 \/ 100 个文件/)).toBeDefined()
    expect(screen.getByText(/其余 25 个非此类文件将安全隐藏/)).toBeDefined()

    // 专属排除卡片存在 (Desktop_Old_Backups)
    expect(screen.getByText('Desktop_Old_Backups')).toBeDefined()

    // 返回步骤 1
    const backBtn = screen.getByRole('button', { name: /上一步：重选工作流/ })
    fireEvent.click(backBtn)

    // 选中无专属排除规则且空白名单的工作流 '通用全文件纳管流'
    const genericCard = screen.getByText('通用全文件纳管流')
    fireEvent.click(genericCard)

    // 再次进入步骤 2
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }))

    // 空白名单：显示预计将展示全部 100 个文件
    expect(
      screen.getByText(
        '基于当前目录扫描，预计将展示全部 100 个文件（未启用格式过滤，所有受管文件均正常呈现）'
      )
    ).toBeDefined()

    // AC-4.4: 无专属排除项时，排除卡片彻底从 DOM 中移除 (toBeNull)
    expect(screen.queryByText('当前工作区专属排除目录与规则')).toBeNull()
  })

  it('AC-4.5 & AC-4.6: 双强主出口分别正确调用提交服务并路由，错误时呈现页内常驻错误条', async () => {
    const onFinish = vi.fn()
    render(<WorkspaceSetupWizard workspace={mockWorkspace} onFinish={onFinish} />)

    await waitFor(() => {
      expect(screen.getAllByText('电脑桌面急救与杂乱清理流').length).toBeGreaterThan(0)
    })

    // 进入步骤 2
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }))

    // 出口 1: 个性化微调工作目录配置
    const customizeBtn = screen.getByRole('button', {
      name: /个性化微调工作目录配置/
    })
    expect(customizeBtn).toBeDefined()
    fireEvent.click(customizeBtn)

    await waitFor(() => {
      expect(mockCommitWorkspacePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 1,
          boundWorkflowId: 'builtin.workflow.desktop-declutter'
        })
      )
      expect(onFinish).toHaveBeenCalledWith('customize', expect.any(Object))
    })

    // 测试出口 2 与错误状态处理
    mockCommitWorkspacePolicy.mockResolvedValueOnce({
      success: false,
      policyVersion: 1,
      error: {
        code: 'STORAGE',
        message: '磁盘读写权限受阻，数据库更新被拒绝'
      }
    })

    const completeBtn = screen.getByRole('button', {
      name: /立即应用并进入工作目录/
    })
    fireEvent.click(completeBtn)

    // 验证常驻错误条展示
    await waitFor(() => {
      expect(screen.getByText('策略保存失败')).toBeDefined()
      expect(screen.getByText('STORAGE')).toBeDefined()
      expect(screen.getByText('磁盘读写权限受阻，数据库更新被拒绝')).toBeDefined()
    })

    // 验证重试与留在当前页按钮
    expect(screen.getByRole('button', { name: /重试保存/ })).toBeDefined()
  })
})
