import { describe, it, expect, vi } from 'vitest'
import {
  getFileUniqueKey,
  getAllFileKeys,
  mergeRescueResult,
  extractUnclassifiedFiles,
  countUnclassified,
  recalculateNodeFileCounts,
  sanitizeDirectoryName,
  extractFilesFromTree
} from './helpers'
import { VirtualDirectoryNode } from '@firefly/types'

// Mock 语言包 t 函数
vi.mock('@app/languages', () => ({
  t: (key: string) => key
}))

describe('Organize helpers comprehensive unit tests', () => {
  describe('getAllFileKeys', () => {
    it('应能完整提取文件的多维度特征 Key（ID, 指纹, 路径, 名称）', () => {
      const file = {
        id: 101,
        fileId: 101,
        file_id: 101,
        fileFingerprint: 'fp_abc123',
        path: 'D:\\documents\\test.docx',
        name: 'test.docx',
        smartName: '测试文档.docx'
      }

      const keys = getAllFileKeys(file)
      expect(keys).toContain('id:101')
      expect(keys).toContain('fp:fp_abc123')
      expect(keys).toContain('path:D:\\documents\\test.docx')
      expect(keys).toContain('name:test.docx')
    })

    it('当属性为空或为无效 0 时应忽略该维度', () => {
      const file = {
        id: 0,
        fileFingerprint: undefined,
        path: '',
        name: 'only_name.png'
      }

      const keys = getAllFileKeys(file)
      expect(keys).toEqual(['name:only_name.png'])
    })

    it('输入空值或 null 时应返回空数组', () => {
      expect(getAllFileKeys(null)).toEqual([])
      expect(getAllFileKeys(undefined)).toEqual([])
    })
  })

  describe('getFileUniqueKey', () => {
    it('应优先返回 ID，否则回退到指纹/路径/名称', () => {
      expect(getFileUniqueKey({ id: 88, name: 'foo.txt' })).toBe('88')
      expect(getFileUniqueKey({ fileFingerprint: 'fp99', name: 'bar.txt' })).toBe('fp99')
      expect(getFileUniqueKey({ path: '/tmp/test.log', name: 'test.log' })).toBe('/tmp/test.log')
      expect(getFileUniqueKey({ name: 'fallback.doc' })).toBe('fallback.doc')
    })
  })

  describe('mergeRescueResult', () => {
    it('应能将找补成功的实体目录文件点对点合并到原树，并从旧位置彻底清除防止跨节点重复', () => {
      const originalTree: VirtualDirectoryNode[] = [
        {
          name: '工作文档',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 1, name: '企划书.pdf', path: 'D:\\企划书.pdf' }]
        },
        {
          name: '未归类',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 2, name: '代码速查表.png', path: 'D:\\代码速查表.png' }]
        }
      ]

      // 后端找补结果：AI 将 id: 2 归类到了「技术资料」节点
      const rescuedTree: VirtualDirectoryNode[] = [
        {
          name: '技术资料',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 2, name: '代码速查表.png', path: 'D:\\代码速查表.png' }]
        },
        {
          name: '未归类',
          parent: null,
          fileCount: 0,
          totalSize: 0,
          subdirectories: [],
          files: []
        }
      ]

      const merged = mergeRescueResult(originalTree, rescuedTree)

      // 验证找补结果中包含「技术资料」节点，且包含 id: 2 文件
      const techNode = merged.find(n => n.name === '技术资料')
      expect(techNode).toBeDefined()
      expect(techNode?.files).toHaveLength(1)
      expect(techNode?.files[0].id).toBe(2)

      // 验证未归类节点里原有的 id: 2 文件已被清除，剩余 0 个
      const unclassifiedNode = merged.find(n => n.name === '未归类')
      expect(unclassifiedNode).toBeDefined()
      expect(unclassifiedNode?.files).toHaveLength(0)

      // 验证「工作文档」节点里的 id: 1 原有文件完好保留
      const workNode = merged.find(n => n.name === '工作文档')
      expect(workNode).toBeDefined()
      expect(workNode?.files).toHaveLength(1)
      expect(workNode?.files[0].id).toBe(1)
    })

    it('即使新旧对象的属性形态不一致（file_id vs path），已归类文件也绝不能泄漏进未归类列表', () => {
      const originalTree: VirtualDirectoryNode[] = [
        {
          name: '应用管理',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ file_id: 99, name: '腾讯会议.lnk', path: 'C:\\Users\\Desktop\\腾讯会议.lnk' }]
        },
        {
          name: '未归类',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: []
        }
      ]

      // 假设找补返回的未归类列表误带有了不同形态的腾讯会议对象
      const rescuedTree: VirtualDirectoryNode[] = [
        {
          name: '未归类',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [
            { id: 99, name: '腾讯会议.lnk' } // 仅带 id 属性
          ]
        }
      ]

      const merged = mergeRescueResult(originalTree, rescuedTree)
      const unclassifiedNode = merged.find(n => n.name === '未归类')

      // 腾讯会议已经存在于「应用管理」节点下，必须 100% 严格剔除，决不能流入未归类！
      expect(unclassifiedNode?.files).toHaveLength(0)
    })

    it('防重校验：同个未归类文件以不同形态（ID vs 路径）在找补结果与原未归类中同时存在时，只能录入一次，防止翻倍暴增', () => {
      const originalTree: VirtualDirectoryNode[] = [
        {
          name: '未归类',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 50, name: '未归类文档.pdf', path: 'D:\\未归类文档.pdf' }]
        }
      ]

      const rescuedTree: VirtualDirectoryNode[] = [
        {
          name: '未归类',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [
            { file_id: 50, name: '未归类文档.pdf' } // 找补返回的形态仅包含 file_id
          ]
        }
      ]

      const merged = mergeRescueResult(originalTree, rescuedTree)
      const unclassifiedNode = merged.find(n => n.name === '未归类')

      // 必须精准去重，结果数必须为 1，决不能因属性不全导致变多成 2 个！
      expect(unclassifiedNode?.files).toHaveLength(1)
    })
  })

  describe('extractUnclassifiedFiles & countUnclassified', () => {
    it('应能准确提取未归类节点下的所有文件', () => {
      const tree: VirtualDirectoryNode[] = [
        {
          name: '项目文档',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 1, name: 'a.txt' }]
        },
        {
          name: '未归类',
          parent: null,
          fileCount: 2,
          totalSize: 0,
          subdirectories: [],
          files: [
            { id: 2, name: 'b.txt' },
            { id: 3, name: 'c.txt' }
          ]
        }
      ]

      const unclassifiedFiles = extractUnclassifiedFiles(tree)
      expect(unclassifiedFiles).toHaveLength(2)
      expect(unclassifiedFiles.map(f => f.id)).toEqual([2, 3])

      const count = countUnclassified(tree)
      expect(count).toBe(2)
    })
  })

  describe('recalculateNodeFileCounts', () => {
    it('应正确递归重新计算父子节点的 fileCount', () => {
      const tree: VirtualDirectoryNode[] = [
        {
          name: '根目录',
          parent: null,
          fileCount: 0,
          totalSize: 0,
          files: [{ id: 1, name: 'root.txt' }],
          subdirectories: [
            {
              name: '子目录',
              parent: '根目录',
              fileCount: 0,
              totalSize: 0,
              files: [{ id: 2, name: 'sub.txt' }],
              subdirectories: []
            }
          ]
        }
      ]

      const updated = recalculateNodeFileCounts(tree)
      expect(updated[0].fileCount).toBe(2)
      expect(updated[0].subdirectories[0].fileCount).toBe(1)
    })

    it('extractFilesFromTree 应能无遗漏提取树中全量已归类与根层级文件', () => {
      const tree: VirtualDirectoryNode[] = [
        {
          name: '文档',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 101, name: 'doc1.pdf' }]
        },
        {
          name: '未归类',
          parent: null,
          fileCount: 1,
          totalSize: 0,
          subdirectories: [],
          files: [{ id: 102, name: 'other.txt' }]
        }
      ]

      const extracted = extractFilesFromTree(tree)
      expect(extracted).toHaveLength(2)
      expect(extracted.map(f => f.fileId)).toEqual([101, 102])
    })
  })

  describe('sanitizeDirectoryName', () => {
    it('应剔除目录名称中的非法文件名字符', () => {
      expect(sanitizeDirectoryName('项目/设计\\文件:1*2?3"4<5>6|7')).toBe('项目设计文件1234567')
      expect(sanitizeDirectoryName('  空  格  ')).toBe('空  格')
    })
  })
})
