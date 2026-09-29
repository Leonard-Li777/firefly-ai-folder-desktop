import { describe, it, expect } from 'vitest'
import {
  computeGroupedMetrics,
  buildCoaxialTracks,
  FilterConfig,
  SubtaskItem
} from './analysis-time-utils'
import { MarkitdownBenchmark, Stage1Benchmark } from '@firefly/types'

// 简易测试翻译函数
const t = (k: string) => k

describe('analysis-time-utils: 耗时指标通用分组、过滤与物理拓扑计算', () => {
  const mockStage1: Stage1Benchmark = {
    totalMs: 100,
    fingerprintMs: 50,
    localReuseMs: 30,
    cloudReuseMs: 20
  }

  const mockStage2: MarkitdownBenchmark = {
    totalMs: 1500,
    magikaMs: 40,
    textMs: 120,
    ocrMs: 800,
    metadataMs: 60,
    thumbnailMs: 200,
    officePrePdfMs: 100, // 合并至封面图后应为 300ms
    tagMs: 1200,
    clipMs: 1100,
    clipEmbedMs: 700,
    clipMutualMs: 400,
    ramMs: 950,
    nsfwMs: 150,
    aestheticMs: 500,
    watermarkMs: 80,
    // 动态新增未定义字段（开闭原则测试）
    audio_mfcc_ms: 250,
    custom_subtask_ms: 180
  }

  const mockPhases = {
    hashAndTypeIdentification: 100,
    contentExtraction: 1500,
    qualityScoring: 600,
    dimensionAnalysis: 400
  }

  const defaultFilter: FilterConfig = {
    hiddenGroupIds: new Set<string>(),
    hideSubItems: new Set<string>(),
    hiddenKeys: new Set<string>(),
    collapsedGroupIds: new Set<string>()
  }

  it('1. 能够正确识别基础组、标签生成组、画质组，并自动归类动态增项', () => {
    const result = computeGroupedMetrics(
      mockStage1,
      mockStage2,
      mockPhases,
      defaultFilter,
      t
    )

    // 检查阶段 1 串行累加
    expect(result.stage1TotalMs).toBe(100) // 50 + 30 + 20

    // 检查标签生成组 (tag_group)
    const tagGroup = result.groups.find(g => g.id === 'tag_group')
    expect(tagGroup).toBeDefined()
    expect(tagGroup?.items.some(i => i.key === 'clipEmbedMs')).toBe(true)
    expect(tagGroup?.items.some(i => i.key === 'clipMutualMs')).toBe(true)
    expect(tagGroup?.items.some(i => i.key === 'ramMs')).toBe(true)
    expect(tagGroup?.items.some(i => i.key === 'nsfwMs')).toBe(true)

    // 检查画质形态组 (quality_group)
    const qualityGroup = result.groups.find(g => g.id === 'quality_group')
    expect(qualityGroup).toBeDefined()
    expect(qualityGroup?.items.some(i => i.key === 'aestheticMs')).toBe(true)
    expect(qualityGroup?.items.some(i => i.key === 'watermarkMs')).toBe(true)

    // 检查开闭原则动态增项 (other 组)
    const otherGroup = result.groups.find(g => g.id === 'other')
    expect(otherGroup).toBeDefined()
    expect(otherGroup?.items.some(i => i.key === 'audio_mfcc_ms')).toBe(true)
    expect(otherGroup?.items.some(i => i.key === 'custom_subtask_ms')).toBe(true)

    // 检查封面图是否合并了 officePrePdfMs (200 + 100 = 300)
    const contentGroup = result.groups.find(g => g.id === 'content')
    const thumbItem = contentGroup?.items.find(i => i.key === 'thumbnailMs')
    expect(thumbItem?.duration).toBe(300)
  })

  it('2. 正确区分同步(⚙️ 串行)与异步(⚡ 并发)，并精确标注长尾瓶颈', () => {
    const result = computeGroupedMetrics(
      mockStage1,
      mockStage2,
      mockPhases,
      defaultFilter,
      t
    )

    // 阶段 1 项应全部为 sync
    const stage1Group = result.groups.find(g => g.id === 'stage1')
    expect(stage1Group?.executionType).toBe('sync')
    stage1Group?.items.forEach(i => {
      expect(i.executionType).toBe('sync')
    })

    // 标签生成组中：CLIP 嵌入与互斥分类局部为 sync，RAM 与 NSFW 为 async
    const tagGroup = result.groups.find(g => g.id === 'tag_group')
    const embedItem = tagGroup?.items.find(i => i.key === 'clipEmbedMs')
    const mutualItem = tagGroup?.items.find(i => i.key === 'clipMutualMs')
    const ramItem = tagGroup?.items.find(i => i.key === 'ramMs')
    expect(embedItem?.executionType).toBe('sync')
    expect(mutualItem?.executionType).toBe('sync')
    expect(ramItem?.executionType).toBe('async')

    // 阶段 2 并发长尾瓶颈应为 tagMs (1200ms) 或 OCR (800ms) 中的最大值
    // 这里 tagMs 是 1200ms，在所有并发大项中耗时最长
    expect(tagGroup?.isBottleneck).toBe(true)
  })

  it('3. 支持隐藏整组：隐藏整个标签生成组后，阶段2耗时自动重算为剩余项的Max', () => {
    const filterWithHiddenTagGroup: FilterConfig = {
      ...defaultFilter,
      hiddenGroupIds: new Set(['tag_group'])
    }

    const result = computeGroupedMetrics(
      mockStage1,
      mockStage2,
      mockPhases,
      filterWithHiddenTagGroup,
      t
    )

    // 标签生成组不应在可见组中
    expect(result.groups.some(g => g.id === 'tag_group')).toBe(false)

    // 剩余项中：OCR 为 800ms，封面图为 300ms，画质组美学为 500ms，other 为 250ms
    // 阶段 2 并发最大耗时应自动变为 800ms (OCR 成为新的瓶颈)
    expect(result.stage2TotalMs).toBe(800)
    const contentGroup = result.groups.find(g => g.id === 'content')
    const ocrItem = contentGroup?.items.find(i => i.key === 'ocrMs')
    expect(ocrItem?.isBottleneck).toBe(true)
  })

  it('4. 支持隐藏子项：隐藏 clip 各子项后，仅保留父级汇总，同轴子轨道不生成', () => {
    const filterHideSubItems: FilterConfig = {
      ...defaultFilter,
      hideSubItems: new Set(['tag_group'])
    }

    const result = computeGroupedMetrics(
      mockStage1,
      mockStage2,
      mockPhases,
      filterHideSubItems,
      t
    )

    const tagGroup = result.groups.find(g => g.id === 'tag_group')
    expect(tagGroup).toBeDefined()
    // 仅保留父级项 tagMs，子项不应在 items 中
    expect(tagGroup?.items.length).toBe(1)
    expect(tagGroup?.items[0].key).toBe('tagMs')

    // 生成同轴轨道
    const tracks = buildCoaxialTracks(result, 'cpu', t)
    // 外环不应包含 stage2_tag_group 的细分子轨道
    const subTracks = tracks.filter(tr => tr.key.includes('sub_tag_group'))
    expect(subTracks.length).toBe(0)
  })

  it('5. 支持单独隐藏某个特定指标 (Item-level filter)', () => {
    const filterHideSingleItem: FilterConfig = {
      ...defaultFilter,
      hiddenKeys: new Set(['ocrMs']) // 用户单独隐藏 OCR
    }

    const result = computeGroupedMetrics(
      mockStage1,
      mockStage2,
      mockPhases,
      filterHideSingleItem,
      t
    )

    const contentGroup = result.groups.find(g => g.id === 'content')
    expect(contentGroup?.items.some(i => i.key === 'ocrMs')).toBe(false)
  })
})
