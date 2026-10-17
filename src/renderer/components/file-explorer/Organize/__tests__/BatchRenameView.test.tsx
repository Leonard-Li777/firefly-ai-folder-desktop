import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { BatchRenameView } from '../components/BatchRenameView'
import { FILE_DIMENSION_DATA } from '../../../../electron/config/file-dimension-source'

const { mockT } = vi.hoisted(() => {
  const tFn = (key: string, params?: any) => {
    if (params && typeof params === 'object') {
      let res = key
      for (const k in params) {
        res = res.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k])
      }
      return res
    }
    return key
  }
  return { mockT: tFn }
})

vi.mock('@app/languages', () => ({
  t: mockT,
  $t: (key: string) => key,
  Translate: ({ children }: any) => children,
  i18nScope: { t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' },
  default: { t: mockT, activeLanguage: 'zh-CN', defaultLanguage: 'zh-CN' }
}))

vi.mock('@voerkai18n/react', () => ({
  useVoerkaI18n: () => ({ activeLanguage: 'zh-CN', t: mockT })
}))

// Mock SplitPane
vi.mock('../../../common/SplitPane', () => ({
  SplitPane: ({ sections }: any) => (
    <div data-testid="split-pane">
      {sections.map((s: any) => (
        <div key={s.id} data-testid={`section-${s.id}`}>
          {s.content}
        </div>
      ))}
    </div>
  )
}))

// Mock Toast
vi.mock('../../../common/Toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('BatchRenameView - 属性标签资源池诊断与回归测试', () => {
  const mockFiles = [
    {
      id: 1,
      name: 'test_file.png',
      path: '/path/test_file.png',
      extension: 'png',
      size: 1024,
      is_analyzed: 1,
      isAnalyzed: true
    }
  ] as any

  const mockDimensionGroups = [
    {
      id: 1,
      name: '文件类型',
      level: 1,
      tags: [
        { dimensionId: 1, tagValue: '图片', fileCount: 1, level: 1 }
      ]
    },
    {
      id: 2,
      name: '文件用途',
      level: 1,
      tags: [
        { dimensionId: 2, tagValue: '工作文档', fileCount: 1, level: 1 }
      ]
    }
  ] as any

  beforeEach(() => {
    (window as any).electronAPI = {
      organizeBatch: {
        previewRename: vi.fn().mockResolvedValue([])
      }
    }
  })

  it('诊断 1: 核心与作者分类中必须包含「作者」标签，且分类徽标应为「核心与作者」', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 点击「核心与作者」Tab
    const coreTab = screen.getByRole('button', { name: /核心与作者/i })
    fireEvent.click(coreTab)

    // 分类徽标与 Tab 应均显示「核心与作者」而非「核心名称」
    const coreMatches = screen.getAllByText('核心与作者')
    expect(coreMatches.length).toBeGreaterThanOrEqual(2)

    // 必须有「作者」标签胶囊
    const authorButton = screen.getByRole('button', { name: /^作者\s*\{AUTHOR\}/ })
    expect(authorButton).toBeDefined()
    expect(authorButton.textContent).toContain('{AUTHOR}')
  })

  it('诊断 2: Tab 与类别名中严禁出现「无数据」，必须为「元数据」', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 严禁存在「无数据」按钮
    expect(screen.queryByRole('button', { name: /无数据/ })).toBeNull()

    // 必须存在「元数据」Tab 按钮
    const metaTab = screen.getByRole('button', { name: /元数据/ })
    expect(metaTab).toBeDefined()
    fireEvent.click(metaTab)

    // 必须包含分辨率、时长等元数据标签
    expect(screen.getByRole('button', { name: /分辨率/ })).toBeDefined()
  })

  it('诊断 3: 默认选中的「常用」Tab 必须正常展示，且常用中也应分类排布并补齐高频常用标签', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 默认展示「常用」内容，不应为空或提示「所有属性标签均已添加至上方模板」
    expect(screen.queryByText('所有属性标签均已添加至上方模板')).toBeNull()

    // 常用中应分类排布（包含子分类区块，如核心与作者、时间日期、分类维度、元数据、自增序号等）
    // 且常用中补齐了高频常用标签：如「原始文件名」、「扩展名」、「分辨率」等
    expect(screen.getByRole('button', { name: /原始文件名/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /文件扩展名/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /分辨率/ })).toBeDefined()
  })

  it('诊断 4: 分类维度中应包含子级维度，且子级维度需要按层级显示', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 切换到「分类维度」Tab
    const dimTab = screen.getByRole('button', { name: /分类维度/ })
    fireEvent.click(dimTab)

    // 应包含子级维度（如图片细分、视频细分、压缩包细分等）
    const imageSubDim = screen.getByRole('button', { name: /图片细分/ })
    expect(imageSubDim).toBeDefined()
    expect(screen.getByRole('button', { name: /压缩包细分/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /视频细分/ })).toBeDefined()

    // 子级维度应有层级提示与所属父级描述
    expect(imageSubDim.getAttribute('title')).toContain('文件类型')
  })

  it('诊断 5: 搜索过滤与模板去重应正确处理层级维度与元数据', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 搜索「细分」
    const searchInput = screen.getByPlaceholderText('过滤属性...')
    fireEvent.change(searchInput, { target: { value: '细分' } })

    // 应展示包含「细分」的维度
    expect(screen.getByRole('button', { name: /图片细分/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /压缩包细分/ })).toBeDefined()
  })

  it('诊断 6: 文件用途维度必须包含子维度（安全等级、处理状态、学科领域等），且文本细分与文档细分均作为维度呈现', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 切换到「分类维度」Tab
    const dimTab = screen.getByRole('button', { name: /分类维度/ })
    fireEvent.click(dimTab)

    // 必须有「文件用途」维度及其子维度
    expect(screen.getByRole('button', { name: /\{TAG:文件用途\}/ })).toBeDefined()
    const secLevelDim = screen.getByRole('button', { name: /\{TAG:安全等级\}/ })
    expect(secLevelDim).toBeDefined()
    expect(secLevelDim.getAttribute('title')).toContain('文件用途')

    const procStatusDim = screen.getByRole('button', { name: /\{TAG:处理状态\}/ })
    expect(procStatusDim).toBeDefined()
    expect(procStatusDim.getAttribute('title')).toContain('文件用途')

    // 必须包含「文本细分」与「文档细分」
    expect(screen.getByRole('button', { name: /\{TAG:文本细分\}/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /\{TAG:文档细分\}/ })).toBeDefined()
  })

  it('诊断 7: 选中一个维度加入模板后不应从列表中移除破坏树状结构，而应保持在原位并半透明化', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 切换到「分类维度」Tab
    const dimTab = screen.getByRole('button', { name: /分类维度/ })
    fireEvent.click(dimTab)

    // 选中「文件类型」维度
    const fileTypeBtn = screen.getByRole('button', { name: /\{TAG:文件类型\}/ })
    expect(fileTypeBtn).toBeDefined()
    // 点击加入模板
    fireEvent.click(fileTypeBtn)

    // 关键断言：点击后「文件类型」按钮依然存在于 DOM 树中（不被移除，不破坏树状结构）
    const fileTypeBtnAfter = screen.getByRole('button', { name: /\{TAG:文件类型\}/ })
    expect(fileTypeBtnAfter).toBeDefined()
    // 并且具有半透明样式类
    expect(fileTypeBtnAfter.className).toContain('opacity-40')
  })

  it('诊断 8: 严格按照维度树原生层级关系组织（根节点为原生维度名，无需人工自造分类名）', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 切换到「分类维度」Tab
    const dimTab = screen.getByRole('button', { name: /分类维度/ })
    fireEvent.click(dimTab)

    // 严禁包含人工臆造的分类名
    expect(screen.queryByText('文件类型与格式细分')).toBeNull()
    expect(screen.queryByText('工作流与管理')).toBeNull()
    expect(screen.queryByText('场景与生活娱乐')).toBeNull()

    // 根维度直接作为树根节点，无多余的 '根维度:' 标签或独立 title 文本
    expect(screen.queryByText('根维度:')).toBeNull()

    // 验证根维度胶囊直接作为树根节点可点击选用
    const fileTypeRootBtn = screen.getByRole('button', { name: /\{TAG:文件类型\}/ })
    expect(fileTypeRootBtn).toBeDefined()
    const purposeRootBtn = screen.getByRole('button', { name: /\{TAG:文件用途\}/ })
    expect(purposeRootBtn).toBeDefined()

    // 验证原生树分支指示符 ├─ 存在
    const branchSymbols = screen.getAllByText('├─')
    expect(branchSymbols.length).toBeGreaterThanOrEqual(3)

    // 验证文件用途下的原生子维度（安全等级、处理状态等）
    expect(screen.getByRole('button', { name: /\{TAG:安全等级\}/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /\{TAG:处理状态\}/ })).toBeDefined()

    // 验证文件类型下的原生子维度（图片细分、文档细分、文本细分）与孙维度（摄影照片细分等）
    expect(screen.getByRole('button', { name: /\{TAG:图片细分\}/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /\{TAG:摄影照片细分\}/ })).toBeDefined()
  })

  it('诊断 9: 全量系统维度树测试（包含二级作品来源、三级证照细分等，且敏感内容仅显示到2级维度）', () => {
    render(
      <BatchRenameView
        files={mockFiles}
        dimensionGroups={mockDimensionGroups}
        onExecuteRename={vi.fn()}
      />
    )

    // 切换到「分类维度」Tab
    const dimTab = screen.getByRole('button', { name: /分类维度/ })
    fireEvent.click(dimTab)

    // 必须包含二级维度「作品来源」
    expect(screen.getAllByRole('button', { name: /\{TAG:作品来源\}/ }).length).toBeGreaterThanOrEqual(1)

    // 必须包含三级维度「证照细分」
    expect(screen.getAllByRole('button', { name: /\{TAG:证照细分\}/ }).length).toBeGreaterThanOrEqual(1)

    // 敏感内容本身作为二级维度必须存在
    expect(screen.getByRole('button', { name: /\{TAG:敏感内容\}/ })).toBeDefined()

    // 敏感内容其下的 3、4 级细分子维度（如 色情细分、涉政细分、血腥细分、违规细分）严禁显示
    expect(screen.queryByRole('button', { name: /\{TAG:色情细分\}/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /\{TAG:涉政细分\}/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /\{TAG:血腥细分\}/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /\{TAG:违规细分\}/ })).toBeNull()
  })
})
