import { describe, it, expect } from 'vitest'
import {
  isPervasiveTag,
  isTagMatchingTokens,
  deterministicShuffle,
  getOrganizedSearchTags,
  PERVASIVE_GENERIC_TAGS
} from '../search-list-tag-utils'

describe('search-list-tag-utils', () => {
  describe('isPervasiveTag 泛化标签判定', () => {
    it('应正确识别系统默认泛化标签', () => {
      expect(isPervasiveTag('全年龄')).toBe(true)
      expect(isPervasiveTag('已归档')).toBe(true)
      expect(isPervasiveTag('未归档')).toBe(true)
      expect(isPervasiveTag('公开')).toBe(true)
      expect(isPervasiveTag('安全')).toBe(true)
      expect(isPervasiveTag('无水印')).toBe(true)
      expect(isPervasiveTag('无码')).toBe(true)
      expect(isPervasiveTag('All Ages')).toBe(true)
      expect(isPervasiveTag('archived')).toBe(true)
    })

    it('不应误伤业务内容标签', () => {
      expect(isPervasiveTag('海滩')).toBe(false)
      expect(isPervasiveTag('日落')).toBe(false)
      expect(isPervasiveTag('设计稿')).toBe(false)
      expect(isPervasiveTag('财务报表')).toBe(false)
      expect(isPervasiveTag('4K')).toBe(false)
    })
  })

  describe('isTagMatchingTokens 关键词匹配判定', () => {
    it('完全等值匹配', () => {
      expect(isTagMatchingTokens('风景', ['风景'])).toBe(true)
      expect(isTagMatchingTokens('Sunset', ['sunset'])).toBe(true)
    })

    it('标签包含搜索词', () => {
      expect(isTagMatchingTokens('热带海滩', ['海滩'])).toBe(true)
      expect(isTagMatchingTokens('海滩日落', ['日落'])).toBe(true)
    })

    it('搜索词包含标签（长查询词命中短标签）', () => {
      expect(isTagMatchingTokens('风景', ['高清风景大图'])).toBe(true)
    })

    it('无匹配时返回 false', () => {
      expect(isTagMatchingTokens('建筑', ['海滩', '日落'])).toBe(false)
    })
  })

  describe('deterministicShuffle 确定性打散算法', () => {
    const list = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

    it('同一种子多次打散结果必须 100% 恒定（虚拟滚动防重绘抖动）', () => {
      const res1 = deterministicShuffle(list, 'path/to/file1.png')
      const res2 = deterministicShuffle(list, 'path/to/file1.png')
      expect(res1).toEqual(res2)
    })

    it('不同种子打散顺序应呈现伪随机分布', () => {
      const res1 = deterministicShuffle(list, 'path/to/file1.png')
      const res2 = deterministicShuffle(list, 'different/path/another_file.jpg')
      expect(res1).not.toEqual(res2)
    })

    it('原数组内容元素集合完全保持不变', () => {
      const res = deterministicShuffle(list, 'seed-123')
      expect(res.sort()).toEqual([...list].sort())
    })
  })

  describe('getOrganizedSearchTags 完整三级梯队与过滤编排', () => {
    it('默认必须过滤掉“全年龄”、“已归档”、“无水印”等低区分度泛化标签', () => {
      const tags = ['全年龄', '已归档', '无水印', '海滩', '日落']
      const organized = getOrganizedSearchTags({
        tags,
        fusedTags: ['日落'],
        searchKeyword: '海滩'
      })

      const names = organized.map(t => t.name)
      expect(names).not.toContain('全年龄')
      expect(names).not.toContain('已归档')
      expect(names).not.toContain('无水印')
      expect(names).toContain('海滩')
      expect(names).toContain('日落')
    })

    it('当用户主动搜索“已归档”时，破例放行该标签并排在第一梯队', () => {
      const tags = ['全年龄', '已归档', '财务报表']
      const organized = getOrganizedSearchTags({
        tags,
        fusedTags: ['财务报表'],
        searchKeyword: '已归档'
      })

      const names = organized.map(t => t.name)
      expect(names).not.toContain('全年龄')
      expect(names[0]).toBe('已归档')
      expect(organized[0].tier).toBe('keyword')
      expect(organized[0].isKeywordMatch).toBe(true)
    })

    it('必须严格遵守三级排版顺序：关键词匹配优先 ➔ 融合标签次之 ➔ 其它标签随机', () => {
      const tags = ['海滩', '热带海滩', '日落', '4K', '壁纸', '自然']
      const fusedTags = ['日落', '自然'] // 融合标签
      const searchKeyword = '海滩'

      const organized = getOrganizedSearchTags({
        tags,
        fusedTags,
        searchKeyword,
        seed: 'test-seed-1'
      })

      const names = organized.map(t => t.name)

      // 第一梯队：命中关键词 "海滩"（热带海滩、海滩）
      expect(organized[0].tier).toBe('keyword')
      expect(organized[1].tier).toBe('keyword')
      expect(['海滩', '热带海滩']).toContain(names[0])
      expect(['海滩', '热带海滩']).toContain(names[1])

      // 第二梯队：融合标签 "日落"、"自然"（未命中关键词）
      expect(organized[2].tier).toBe('fused')
      expect(organized[3].tier).toBe('fused')
      expect(['日落', '自然']).toContain(names[2])
      expect(['日落', '自然']).toContain(names[3])

      // 第三梯队：剩余其它标签 "4K"、"壁纸"
      expect(organized[4].tier).toBe('other')
      expect(organized[5].tier).toBe('other')
      expect(['4K', '壁纸']).toContain(names[4])
      expect(['4K', '壁纸']).toContain(names[5])
    })

    it('关键词匹配梯队内按匹配度排序：精确匹配在子串匹配之前', () => {
      const tags = ['热带海滩度假村', '海滩']
      const organized = getOrganizedSearchTags({
        tags,
        searchKeyword: '海滩'
      })

      expect(organized[0].name).toBe('海滩')
      expect(organized[1].name).toBe('热带海滩度假村')
    })

    it('同名标签自动去重', () => {
      const tags = ['海滩', '海滩', '日落']
      const organized = getOrganizedSearchTags({
        tags,
        searchKeyword: '海滩'
      })

      const names = organized.map(t => t.name)
      expect(names.filter(n => n === '海滩').length).toBe(1)
    })
  })
})
