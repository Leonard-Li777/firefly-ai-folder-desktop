import { describe, it, expect } from 'vitest'
import { buildPreviewTree } from '../buildPreviewTree'
import { SelectedTag, DimensionGroup } from '@firefly/types'

describe('buildPreviewTree 导出预览树构建与文件桶分配', () => {
  const dimensionGroups: DimensionGroup[] = [
    {
      id: 1,
      name: '文件类型',
      level: 1,
      tags: [
        {
          dimensionId: 1,
          dimensionName: '文件类型',
          tagValue: '图片',
          code: 'omw.03234306.n',
          codePath: '/builtin.file_type/omw.03234306.n',
          fileCount: 2,
          level: 1
        },
        {
          dimensionId: 1,
          dimensionName: '文件类型',
          tagValue: '文档',
          code: 'omw.06410904.n',
          codePath: '/builtin.file_type/omw.06410904.n',
          fileCount: 1,
          level: 1
        }
      ]
    },
    {
      id: 2,
      name: '图片细分',
      level: 2,
      parentDimensionIds: [1],
      triggerConditions: [
        {
          parentDimension: '文件类型',
          triggerTags: ['图片']
        }
      ],
      tags: [
        {
          dimensionId: 2,
          dimensionName: '图片细分',
          tagValue: '摄影照片',
          code: 'builtin.photography',
          codePath: '/builtin.file_type/omw.03234306.n/builtin.photography',
          fileCount: 1,
          level: 2
        }
      ]
    }
  ]

  const mockFiles = [
    {
      id: '101',
      name: 'landscape.jpg',
      smartName: '风景照.jpg',
      size: 5000,
      tags: ['图片', '摄影照片', '全年龄'],
      tagCodes: ['omw.03234306.n', 'builtin.photography', 'builtin.all_ages']
    },
    {
      id: '102',
      name: 'avatar.png',
      smartName: '头像.png',
      size: 2000,
      // 模拟仅返回了受控码的情况（V4 底层受控形式）
      tags: ['全年龄'],
      tagCodes: ['omw.03234306.n', 'builtin.all_ages']
    },
    {
      id: '103',
      name: 'manual.docx',
      smartName: '使用手册.docx',
      size: 8000,
      tags: ['文档', '工作文档'],
      tagCodes: ['omw.06410904.n', 'builtin.work_docs']
    }
  ]

  it('单选根维度标签时，携带受控码或展示名的文件均应成功挂载并正确计数', () => {
    const selectedTags: SelectedTag[] = [
      {
        dimensionId: 1,
        dimensionName: '文件类型',
        tagValue: '图片',
        code: 'omw.03234306.n',
        codePath: '/builtin.file_type/omw.03234306.n',
        level: 1
      }
    ]

    const result = buildPreviewTree(selectedTags, dimensionGroups, mockFiles, {
      enableNestedClassification: false
    })

    expect(result).toHaveLength(1)
    const imgNode = result[0]
    expect(imgNode.name).toBe('图片')
    // 两个图片文件都应该被匹配并加入
    expect(imgNode.fileCount).toBe(2)
    expect(imgNode.files).toHaveLength(2)
    expect(imgNode.files.map(f => f.fileId)).toEqual([101, 102])
    expect(imgNode.totalSize).toBe(7000)
  })

  it('父子维度嵌套时，子目录文件应挂载到叶子节点，父节点应自底向上聚合总计数', () => {
    const selectedTags: SelectedTag[] = [
      {
        dimensionId: 1,
        dimensionName: '文件类型',
        tagValue: '图片',
        code: 'omw.03234306.n',
        codePath: '/builtin.file_type/omw.03234306.n',
        level: 1
      },
      {
        dimensionId: 2,
        dimensionName: '图片细分',
        tagValue: '摄影照片',
        code: 'builtin.photography',
        codePath: '/builtin.file_type/omw.03234306.n/builtin.photography',
        level: 2
      }
    ]

    const result = buildPreviewTree(selectedTags, dimensionGroups, mockFiles, {
      enableNestedClassification: true
    })

    expect(result).toHaveLength(1)
    const parentNode = result[0]
    expect(parentNode.name).toBe('图片')
    expect(parentNode.subdirectories).toHaveLength(1)

    const childNode = parentNode.subdirectories[0]
    expect(childNode.name).toBe('摄影照片')
    expect(childNode.fileCount).toBe(1)
    expect(childNode.files[0].fileId).toBe(101)

    // 父节点自底向上聚合：自身直接文件 + 子节点文件
    expect(parentNode.fileCount).toBeGreaterThanOrEqual(2)
  })

  it('无选中标签时应返回空数组', () => {
    const result = buildPreviewTree([], dimensionGroups, mockFiles, {
      enableNestedClassification: true
    })
    expect(result).toEqual([])
  })
})
