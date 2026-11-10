/**
 * 零翻译单点命名原型预览树纯函数单测套件 (Spec v1.1 §2.3 & AC-4.1)
 */

import { describe, it, expect } from 'vitest'
import {
  buildPreviewTree,
  formatPrototypeFileName,
  type DirectoryTreeNode,
  type PreviewNode
} from '@firefly/shared'

describe('buildPreviewTree (Spec v1.1 §2.3 & AC-4.1)', () => {
  describe('格式化命名原型文件名 (formatPrototypeFileName)', () => {
    it('应将 DSL 占位符具象化为直观示例并补全扩展名', () => {
      const formatted = formatPrototypeFileName('[{TAG:设备}]{SMART_NAME}_{CRE:YYYYMMDD}', '.docx')
      expect(formatted).toBe('[分类标签]项目方案草稿_20261110.docx')
    })

    it('若无扩展名或为空时应容错处理', () => {
      const formatted = formatPrototypeFileName('', '.png')
      expect(formatted).toBe('示例文件.png')
    })
  })

  describe('DFS 先序首个最深叶子单点挂载与不可变性', () => {
    it('全树严格只挂载 1 个 naming-prototype 节点', () => {
      const sampleTree: DirectoryTreeNode[] = [
        {
          name: '10-设计规范',
          children: [{ name: '01-全局设计系统' }, { name: '02-原子组件与模板' }]
        },
        {
          name: '20-通用素材',
          children: [{ name: '01-图标素材' }]
        }
      ]

      const previewTree = buildPreviewTree(sampleTree, '{SMART_NAME}', '.fig')

      // 统计全树 naming-prototype 数量
      let prototypeCount = 0
      const countPrototypes = (nodes: readonly PreviewNode[]) => {
        for (const n of nodes) {
          if (n.kind === 'naming-prototype') {
            prototypeCount++
            expect(n.children).toEqual([]) // 恒锁定为空数组
          }
          if (n.children && n.children.length > 0) {
            countPrototypes(n.children)
          }
        }
      }
      countPrototypes(previewTree)

      expect(prototypeCount).toBe(1)
    })

    it('当存在多个深度相同的最深叶子时，严格取 DFS 先序遍历首个命中的叶子', () => {
      const tree: DirectoryTreeNode[] = [
        {
          name: '分支A',
          children: [{ name: '深度2-A1' }, { name: '深度2-A2' }]
        },
        {
          name: '分支B',
          children: [{ name: '深度2-B1' }]
        }
      ]

      const previewTree = buildPreviewTree(tree, '方案_{CRE:YYYYMMDD}', '.pdf')

      // 深度2-A1 是先序第一个最深叶子
      const branchA = previewTree[0]
      const leafA1 = branchA.children![0]
      const leafA2 = branchA.children![1]
      const branchB = previewTree[1]
      const leafB1 = branchB.children![0]

      // 断言挂载在 leafA1 下
      expect(leafA1.children).toBeDefined()
      expect(leafA1.children!.length).toBe(1)
      expect(leafA1.children![0].kind).toBe('naming-prototype')
      expect(leafA1.children![0].name).toBe('方案_20261110.pdf')

      // 断言 leafA2 与 leafB1 没有被挂载任何虚拟文件 (单树单挂载)
      expect(leafA2.children).toEqual([])
      expect(leafB1.children).toEqual([])
    })

    it('平铺/根目录蓝图 (tree 为空数组) 时，在 [当前工作目录] 下挂载 1 个原型', () => {
      const previewTree = buildPreviewTree([], '未分类草稿_{SEQ}', '.txt')

      expect(previewTree.length).toBe(1)
      expect(previewTree[0].name).toBe('[当前工作目录]')
      expect(previewTree[0].kind).toBe('directory')
      expect(previewTree[0].children!.length).toBe(1)
      expect(previewTree[0].children![0].kind).toBe('naming-prototype')
      expect(previewTree[0].children![0].name).toBe('未分类草稿_01.txt')
    })

    it('原始模板树经 Object.freeze 深度冻结，派生过程 100% 零修改', () => {
      const frozenTree: readonly DirectoryTreeNode[] = Object.freeze([
        Object.freeze({
          name: '只读目录',
          children: Object.freeze([
            Object.freeze({
              name: '只读子目录',
              children: Object.freeze([])
            })
          ])
        })
      ])

      expect(() => {
        const preview = buildPreviewTree(frozenTree, '测试文件', '.docx')
        expect(preview.length).toBe(1)
      }).not.toThrow()
    })
  })
})
