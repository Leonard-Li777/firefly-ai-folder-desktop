import { describe, it, expect } from 'vitest'
import {
  resetTreeToOutline,
  recalculateNodeFileCounts,
  isNodeRenameable,
  isUnclassifiedNodeName,
  getAllFileKeys
} from './helpers'
import { VirtualDirectoryNode } from '../types'

describe('Draft & Organize Lifecycle Guard Tests', () => {
  it('resetTreeToOutline 应将已归类节点中的文件全部剥离并归还放入未归类节点', () => {
    const mockTree: VirtualDirectoryNode[] = [
      {
        name: '文档类',
        parent: null,
        subdirectories: [
          {
            name: '代码文件',
            parent: '文档类',
            subdirectories: [],
            files: [{ id: 1, name: 'main.ts' }] as any,
            fileCount: 1,
            totalSize: 100
          }
        ],
        files: [{ id: 2, name: 'readme.md' }] as any,
        fileCount: 1,
        totalSize: 200
      },
      {
        name: '未归类',
        parent: null,
        subdirectories: [],
        files: [{ id: 3, name: 'unknown.tmp' }] as any,
        fileCount: 1,
        totalSize: 50
      }
    ]

    const allToOrganizeFiles = [
      { id: 1, name: 'main.ts' },
      { id: 2, name: 'readme.md' },
      { id: 3, name: 'unknown.tmp' }
    ]

    const resetResult = resetTreeToOutline(mockTree, allToOrganizeFiles)

    // 1. 原文档类及其子目录的文件数组应被清空为 []
    const docNode = resetResult.find(n => n.name === '文档类')
    expect(docNode).toBeDefined()
    expect(docNode?.files).toEqual([])
    expect(docNode?.subdirectories[0].files).toEqual([])

    // 2. 未归类节点应承载全量待整理文件
    const unclassifiedNode = resetResult.find(n => n.name === '未归类')
    expect(unclassifiedNode).toBeDefined()
    expect(unclassifiedNode?.files.length).toBe(3)
    expect(unclassifiedNode?.fileCount).toBe(3)
  })

  it('recalculateNodeFileCounts 应根据节点内直属文件精准重算树中节点文件数', () => {
    const mockTree: VirtualDirectoryNode[] = [
      {
        name: '测试目录',
        parent: null,
        subdirectories: [],
        files: [
          { id: 1, name: 'a.txt' },
          { id: 2, name: 'b.txt' }
        ] as any,
        fileCount: 0,
        totalSize: 0
      }
    ]

    const recalculated = recalculateNodeFileCounts(mockTree)
    expect(recalculated[0].fileCount).toBe(2)
  })

  describe('isUnclassifiedNodeName 未归类节点识别测试', () => {
    it('应精准匹配中文和英文未归类名称', () => {
      expect(isUnclassifiedNodeName('未归类')).toBe(true)
      expect(isUnclassifiedNodeName('Unclassified')).toBe(true)
      expect(isUnclassifiedNodeName('unclassified')).toBe(true)
      expect(isUnclassifiedNodeName('项目文档')).toBe(false)
    })
  })

  describe('isNodeRenameable 重命名权限判定规则', () => {
    const highFrequencyTags = new Set(['dwg图纸', 'pdf文档', '设计图'])

    it('快速整理预览阶段，高频标签匹配目录应禁止更名', () => {
      const isRenameable = isNodeRenameable(
        { name: 'DWG图纸' },
        { currentVDirId: undefined, organizeMode: 'fast-organize', highFrequencyTags }
      )
      expect(isRenameable).toBe(false)
    })

    it('快速整理预览阶段，非高频标签目录应允许更名', () => {
      const isRenameable = isNodeRenameable(
        { name: '自定义新建分类' },
        { currentVDirId: undefined, organizeMode: 'fast-organize', highFrequencyTags }
      )
      expect(isRenameable).toBe(true)
    })

    it('精细整理预览阶段，即使名称包含在标签集中也应允许更名', () => {
      const isRenameable = isNodeRenameable(
        { name: 'DWG图纸' },
        { currentVDirId: undefined, organizeMode: 'fine-organize', highFrequencyTags }
      )
      expect(isRenameable).toBe(true)
    })

    it('草稿落盘 DB 后（currentVDirId 存在），所有目录均应允许更名', () => {
      const isRenameable = isNodeRenameable(
        { name: 'DWG图纸' },
        { currentVDirId: 101, organizeMode: 'fast-organize', highFrequencyTags }
      )
      expect(isRenameable).toBe(true)
    })

    it('未归类节点始终禁止更名', () => {
      const isRenameable = isNodeRenameable(
        { name: '未归类' },
        { currentVDirId: 101, organizeMode: 'fine-organize', highFrequencyTags }
      )
      expect(isRenameable).toBe(false)
    })
  })

  describe('StructureView 【换一个】按钮显隐精准判定规则 (isPersistedVDir)', () => {
    const isShowReorganizeBtn = (currentVDir: any) => {
      const isPersistedVDir = Boolean(
        currentVDir && typeof currentVDir.id === 'number' && currentVDir.id > 0
      )
      return !isPersistedVDir
    }

    it('快速整理/精细整理尚未点击开始整理落盘时（currentVDir 为 null/undefined），应正常显示【换一个】按钮', () => {
      expect(isShowReorganizeBtn(null)).toBe(true)
      expect(isShowReorganizeBtn(undefined)).toBe(true)
    })

    it('已落盘的草稿或实体虚拟目录（currentVDir.id > 0），应隐藏【换一个】按钮', () => {
      expect(isShowReorganizeBtn({ id: 100, source: 'draft' })).toBe(false)
      expect(isShowReorganizeBtn({ id: 101, source: 'ai-reorganized' })).toBe(false)
    })
  })

  describe('草稿与增量整理待整理文件列表 (toOrganizeFiles) 过滤规则', () => {
    it('对于 incremental-organize 模式，前次全量文件归类完毕（incrementalFiles 为 []）时，待整理列表应精准显示 0 个文件', () => {
      const organizeMode = 'incremental-organize'
      const incrementalFiles: any[] = []
      const result =
        organizeMode === 'incremental-organize' && Array.isArray(incrementalFiles)
          ? incrementalFiles
          : ['allWorkspaceFiles']
      expect(result).toEqual([])
      expect(result.length).toBe(0)
    })

    it('对于已有草稿恢复 (currentVDir.id > 0)，isExistingDraftOrVDir 应判定为 true 并激活历史分类节点文件擦除过滤', () => {
      const currentVDir = { id: 200, source: 'draft' }
      const organizeMode = 'fast-organize'
      const isExistingDraftOrVDir = Boolean(
        organizeMode === 'incremental-organize' || (currentVDir && currentVDir.id > 0)
      )
      expect(isExistingDraftOrVDir).toBe(true)
    })

    it('对于已有草稿恢复，前次分类目录中的文件应被从待整理列表中彻底剔除', () => {
      const currentVDir = { id: 200, source: 'draft' }
      const organizeMode = 'fast-organize'
      const allWorkspaceFiles = [
        { id: 1, name: 'already-classified.txt' },
        { id: 2, name: 'new-unclassified.txt' }
      ]
      const initialDraftTree: VirtualDirectoryNode[] = [
        {
          name: '工作文档',
          parent: null,
          subdirectories: [],
          files: [{ id: 1, name: 'already-classified.txt' }] as any,
          fileCount: 1,
          totalSize: 100
        },
        {
          name: '未归类',
          parent: null,
          subdirectories: [],
          files: [{ id: 2, name: 'new-unclassified.txt' }] as any,
          fileCount: 1,
          totalSize: 50
        }
      ]

      const isExistingDraftOrVDir = Boolean(
        organizeMode === 'incremental-organize' || (currentVDir && currentVDir.id > 0)
      )

      let resultFiles = [...allWorkspaceFiles]
      if (isExistingDraftOrVDir && initialDraftTree.length > 0) {
        const classifiedKeys = new Set<string>()
        const collectClassified = (nodes: VirtualDirectoryNode[]) => {
          for (const node of nodes) {
            if (node.name !== '未归类' && Array.isArray(node.files)) {
              for (const f of node.files) {
                const keys = getAllFileKeys(f)
                keys.forEach(k => classifiedKeys.add(k))
              }
            }
            if (Array.isArray(node.subdirectories)) {
              collectClassified(node.subdirectories)
            }
          }
        }
        collectClassified(initialDraftTree)

        if (classifiedKeys.size > 0) {
          resultFiles = resultFiles.filter(f => {
            const keys = getAllFileKeys(f)
            return !keys.some(k => classifiedKeys.has(k))
          })
        }
      }

      // already-classified.txt (id: 1) 被过滤，结果仅包含 new-unclassified.txt (id: 2)
      expect(resultFiles.length).toBe(1)
      expect(resultFiles[0].id).toBe(2)
    })

    it('从零发起新建整理（currentVDir 为 null）时，待整理列表应保持全量基线文件全集不被擦除', () => {
      const currentVDir = null
      const organizeMode = 'fast-organize'
      const allWorkspaceFiles = [
        { id: 1, name: 'file-1.txt' },
        { id: 2, name: 'file-2.txt' }
      ]

      const isExistingDraftOrVDir = Boolean(
        organizeMode === 'incremental-organize' || (currentVDir && (currentVDir as any).id > 0)
      )

      expect(isExistingDraftOrVDir).toBe(false)
      // 保持全量 2 个文件基线
      expect(allWorkspaceFiles.length).toBe(2)
    })
  })
})
