import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: () => undefined
    })
  }
}))

vi.mock('../../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: () => undefined
    })
  }
}))

import {
  HybridSearchSession,
  HybridSearchCollaborators
} from '../hybrid-search-session'
import type { HybridRankPool } from '../HybridSearchArbiter'
import type { FilterFilesParams } from '../TagTreeQuery'

describe('HybridSearchSession 候选层物理资格过滤与分页恒等式 (TC-HARD-05)', () => {
  function createMockCollaborators(pool: Partial<HybridRankPool>): HybridSearchCollaborators {
    const fullPool: HybridRankPool = {
      candidates: pool.candidates || [],
      unanalyzedHits: pool.unanalyzedHits || [],
      failures: pool.failures || {}
    }
    return {
      searchHybrid: vi.fn().mockResolvedValue(fullPool),
      fetchFieldCoverageRefs: vi.fn().mockReturnValue({
        analyzed: [],
        unanalyzed: []
      }),
      fetchRowsByFingerprints: vi.fn().mockImplementation((fps: string[]) =>
        fps.map(fp => ({ file_fingerprint: fp, name: `${fp}.txt` }))
      ),
      mapFilesToItems: vi.fn().mockImplementation((rows: any[]) =>
        rows.map(r => ({
          id: 1,
          name: r.name,
          path: `/${r.name}`,
          fileFingerprint: r.file_fingerprint,
          similarity: 0.5
        }))
      ),
      fetchContentsForSearch: vi.fn().mockReturnValue(new Map()),
      enrichSearchPage: vi.fn().mockResolvedValue(new Map()),
      synthesizeUnanalyzedItem: vi.fn().mockImplementation(ref => ({
        id: 2,
        name: ref.name,
        path: ref.path,
        fileFingerprint: ref.fileFingerprint,
        similarity: 1
      })),
      fallbackPaged: vi.fn().mockResolvedValue({ total: 0, items: [] })
    }
  }

  it('exactMinScore=true 时：精确按通道判定 eligibility，拒绝低分语义项并保证 total=合格池大小', async () => {
    const collaborators = createMockCollaborators({
      candidates: [
        // 1. exact/fuzzy 通道：有字面命中 -> 应该放行
        {
          fileFingerprint: 'fp-literal',
          hasLiteral: true,
          score: 0.35,
          nameBoost: 0
        },
        // 2. semantic 通道：vecScore 0.58 >= 0.55 -> 应该放行
        {
          fileFingerprint: 'fp-semantic-pass',
          hasLiteral: false,
          vecScore: 0.58,
          score: 0.32,
          nameBoost: 0
        },
        // 3. semantic 通道：vecScore 0.48 < 0.55 -> 应该拦截
        {
          fileFingerprint: 'fp-semantic-fail',
          hasLiteral: false,
          vecScore: 0.48,
          score: 0.38, // RRF 分可能较高，但余弦不足
          nameBoost: 0
        },
        // 4. clip 通道：clipScore 0.60 >= 0.55 -> 应该放行
        {
          fileFingerprint: 'fp-clip-pass',
          hasLiteral: false,
          clipScore: 0.6,
          score: 0.28,
          nameBoost: 0
        },
        // 5. clip 通道：clipScore 0.45 < 0.55 -> 应该拦截
        {
          fileFingerprint: 'fp-clip-fail',
          hasLiteral: false,
          clipScore: 0.45,
          score: 0.30,
          nameBoost: 0
        }
      ]
    })

    const session = new HybridSearchSession(collaborators)
    const params: FilterFilesParams = {
      similarityThreshold: 0.55,
      exactMinScore: true,
      limit: 10,
      offset: 0
    }

    const res = await session.runPaged(params, '发票', { whereClauses: [], queryParams: [] })

    // 合格项为 3 条：fp-literal, fp-semantic-pass, fp-clip-pass
    expect(res.total).toBe(3)
    expect(res.items).toHaveLength(3)
    const returnedFps = res.items.map((i: any) => i.fileFingerprint)
    expect(returnedFps).toContain('fp-literal')
    expect(returnedFps).toContain('fp-semantic-pass')
    expect(returnedFps).toContain('fp-clip-pass')
    expect(returnedFps).not.toContain('fp-semantic-fail')
    expect(returnedFps).not.toContain('fp-clip-fail')
  })

  it('分页恒等式与 limit=1 切片验证：total 跨页恒定，彻底杜绝 got=0', async () => {
    const collaborators = createMockCollaborators({
      candidates: [
        { fileFingerprint: 'fp-1', hasLiteral: true, score: 0.4, nameBoost: 0 },
        { fileFingerprint: 'fp-2', hasLiteral: true, score: 0.3, nameBoost: 0 },
        { fileFingerprint: 'fp-3', hasLiteral: true, score: 0.2, nameBoost: 0 }
      ]
    })

    const session = new HybridSearchSession(collaborators)

    // limit=1, offset=0
    const page1 = await session.runPaged(
      { similarityThreshold: 0.55, exactMinScore: true, limit: 1, offset: 0 },
      'test',
      { whereClauses: [], queryParams: [] }
    )
    expect(page1.total).toBe(3)
    expect(page1.items).toHaveLength(1)
    expect(page1.items[0].fileFingerprint).toBe('fp-1')

    // limit=1, offset=1
    const page2 = await session.runPaged(
      { similarityThreshold: 0.55, exactMinScore: true, limit: 1, offset: 1 },
      'test',
      { whereClauses: [], queryParams: [] }
    )
    expect(page2.total).toBe(3)
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0].fileFingerprint).toBe('fp-2')

    // offset 越界：offset=5, total=3 -> items 长度为 0，但 total=3
    const pageEmpty = await session.runPaged(
      { similarityThreshold: 0.55, exactMinScore: true, limit: 1, offset: 5 },
      'test',
      { whereClauses: [], queryParams: [] }
    )
    expect(pageEmpty.total).toBe(3)
    expect(pageEmpty.items).toHaveLength(0)
  })

  it('视频切片锚定双阈值：乱码无锚定时回退至 minScore 拦截 0.46 切片；有锚定时放行 0.48 切片', async () => {
    // 场景 A：纯乱码检索，无字面命中、无正文文本命中、视频最高切片 0.46 (< 0.50) -> 未锚定，门限为 max(0.45, 0.55) = 0.55
    const collaboratorsUnanchored = createMockCollaborators({
      candidates: [
        {
          fileFingerprint: 'fp-video-noise',
          hasLiteral: false,
          score: 0.3,
          nameBoost: 0,
          matchedChunk: {
            chunkIndex: 1,
            startSec: 0,
            endSec: 10,
            similarity: 0.46
          }
        }
      ]
    })

    const sessionUnanchored = new HybridSearchSession(collaboratorsUnanchored)
    const resA = await sessionUnanchored.runPaged(
      {
        similarityThreshold: 0.55,
        videoMinScore: 0.45,
        exactMinScore: true,
        limit: 10,
        offset: 0
      },
      'zzzqqqxxx789',
      { whereClauses: [], queryParams: [] }
    )
    // 乱码切片被 0.55 门限拦截，召回严格归零！
    expect(resA.total).toBe(0)
    expect(resA.items).toHaveLength(0)

    // 场景 B：存在字面命中锚定（或高光波峰 >= 0.50）时，生效 videoMinScore=0.45，放行 0.48 切片
    const collaboratorsAnchored = createMockCollaborators({
      candidates: [
        {
          fileFingerprint: 'fp-video-target',
          hasLiteral: false,
          score: 0.35,
          nameBoost: 0,
          matchedChunk: {
            chunkIndex: 2,
            startSec: 10,
            endSec: 20,
            similarity: 0.48
          }
        },
        {
          fileFingerprint: 'fp-anchor-doc',
          hasLiteral: false,
          vecScore: 0.56, // >= 0.55 锚定点
          score: 0.4,
          nameBoost: 0
        }
      ]
    })

    const sessionAnchored = new HybridSearchSession(collaboratorsAnchored)
    const resB = await sessionAnchored.runPaged(
      {
        similarityThreshold: 0.55,
        videoMinScore: 0.45,
        exactMinScore: true,
        limit: 10,
        offset: 0
      },
      '麦田',
      { whereClauses: [], queryParams: [] }
    )
    expect(resB.total).toBe(2)
    const fps = resB.items.map((i: any) => i.fileFingerprint)
    expect(fps).toContain('fp-video-target')
    expect(fps).toContain('fp-anchor-doc')
  })

  it('exactMinScore=false 时：保持既有桌面端逻辑，不执行 eligibility 过滤，100% 杜绝误伤桌面端', async () => {
    const collaborators = createMockCollaborators({
      candidates: [
        {
          fileFingerprint: 'fp-low-score',
          hasLiteral: false,
          vecScore: 0.3,
          score: 0.25,
          nameBoost: 0
        }
      ]
    })

    const session = new HybridSearchSession(collaborators)
    const res = await session.runPaged(
      {
        similarityThreshold: 0.55,
        exactMinScore: false,
        limit: 10,
        offset: 0
      },
      'query',
      { whereClauses: [], queryParams: [] }
    )
    expect(res.total).toBe(1)
    expect(res.items).toHaveLength(1)
  })
})
