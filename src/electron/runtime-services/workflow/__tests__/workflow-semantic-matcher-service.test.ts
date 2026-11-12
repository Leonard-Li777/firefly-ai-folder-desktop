import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => {
  const electronMock = {
    app: {
      getPath: vi.fn(() => 'C:\\test'),
      getName: vi.fn(() => 'firefly'),
      isPackaged: false
    },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    shell: { showItemInFolder: vi.fn() }
  }
  return {
    ...electronMock,
    default: electronMock
  }
})

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

import { WorkflowSemanticMatcherService } from '../workflow-semantic-matcher-service'
import { OmniService } from '../../system/omni-service'
import { ConfigDbManager } from '../../config/config-db-manager'
import type { LocalWorkflowRecord, WorkflowSemanticsScoreRequest } from '@firefly/types'

describe('WorkflowSemanticMatcherService (Stage B)', () => {
  let matcher: WorkflowSemanticMatcherService
  let mockWorkflows: LocalWorkflowRecord[]

  beforeEach(() => {
    vi.restoreAllMocks()
    matcher = WorkflowSemanticMatcherService.getInstance()

    mockWorkflows = [
      {
        id: 'builtin.workflow.screenshots-screenrecord-vault',
        name: '屏幕截图与录屏归档资产库',
        summary: '整理日常截图与录屏文件',
        persona: 'general',
        preset_directory_tree: { name: '截图', children: [{ name: '2026' }] },
        workspace_config: { extensionWeights: { '.png': 0.6, '.jpg': 0.4 } },
        extensionWeights: { '.png': 0.6, '.jpg': 0.4 },
        source: 'preset',
        category: 'media',
        icon: 'camera',
        is_active: 1
      },
      {
        id: 'builtin.workflow.senior-medical-care-pipeline',
        name: '长辈就医挂号与体检随访',
        summary: '长辈就医病历、化验单与随访资料',
        persona: 'medical',
        preset_directory_tree: { name: '就医', children: [{ name: '挂号单' }] },
        workspace_config: { extensionWeights: { '.pdf': 0.5, '.docx': 0.5 } },
        extensionWeights: { '.pdf': 0.5, '.docx': 0.5 },
        source: 'preset',
        category: 'life',
        icon: 'heart',
        is_active: 1
      }
    ]

    vi.spyOn(ConfigDbManager, 'getInstance').mockReturnValue({
      getCurrentLanguage: () => 'zh-CN',
      getLocalWorkflows: () => mockWorkflows
    } as any)
  })

  it('准则 1: 双门禁解锁验证 (cos >= 0.65 且 sigma >= 1e-4 解锁，反之不解锁)', async () => {
    // 构造 2 维向量让 screenshots 余弦 = 0.72, medical 余弦 = 0.50
    // vDir = [1, 0]
    // screenshots = [0.72, sqrt(1 - 0.72^2)]
    // medical = [0.50, sqrt(1 - 0.50^2)]
    const y1 = Math.sqrt(Math.max(0, 1 - 0.72 * 0.72))
    const y2 = Math.sqrt(Math.max(0, 1 - 0.5 * 0.5))

    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 2 }),
      batchEmbedText: async (texts: string[]) => {
        // 如果是目录 batch 编码 [summaryText, stem1]
        if (texts.length <= 2 && texts[0].includes('测试相册')) {
          return {
            vectors: [
              [1, 0],
              [1, 0]
            ],
            count: texts.length,
            dim: 2,
            profile: 'classic_light',
            durationMs: 5
          }
        }
        // 如果是工作流 batch 编码
        return {
          vectors: [
            [0.72, y1],
            [0.5, y2]
          ],
          count: 2,
          dim: 2,
          profile: 'classic_light',
          durationMs: 10
        }
      }
    } as any)

    const req: WorkflowSemanticsScoreRequest = {
      probeSeq: 1,
      dirPath: 'C:\\Users\\Test\\Pictures\\测试相册',
      directoryName: '测试相册',
      countsByExt: { png: 50, jpg: 50 },
      sampledFileNames: [{ stem: 'screenshot_2026', count: 10 }]
    }

    const res = await matcher.scoreWorkflowSemantics(req)
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.batchSigma).toBeGreaterThan(1e-4)
      expect(res.unlockedWorkflowIds).toContain('builtin.workflow.screenshots-screenrecord-vault')
      expect(res.unlockedWorkflowIds).not.toContain('builtin.workflow.senior-medical-care-pipeline')
      expect(
        res.semanticScoresByWorkflowId['builtin.workflow.screenshots-screenrecord-vault']
      ).toBeGreaterThan(0.5)
    }
  })

  it('准则 2: 1200ms 物理超时中止保护与安全降级', async () => {
    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 4 }),
      batchEmbedText: async (_texts: string[], opts?: any) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              vectors: [[1, 0, 0, 0]],
              count: 1,
              dim: 4,
              profile: 'classic_light',
              durationMs: 2000
            })
          }, 2000)

          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              const abortErr = new Error('The operation was aborted')
              abortErr.name = 'AbortError'
              reject(abortErr)
            })
          }
        })
      }
    } as any)

    const req: WorkflowSemanticsScoreRequest = {
      probeSeq: 2,
      dirPath: 'C:\\Users\\Test\\Desktop',
      countsByExt: { png: 10 },
      sampledFileNames: [{ stem: 'test', count: 1 }]
    }

    const start = Date.now()
    const res = await matcher.scoreWorkflowSemantics(req)
    const elapsed = Date.now() - start

    expect(res.status).toBe('degraded')
    if (res.status === 'degraded') {
      expect(res.reason).toBe('timeout')
    }
    // 应该在 ~1200ms 触发中止，绝不超过 1800ms
    expect(elapsed).toBeLessThan(1800)
  })

  it('准则 3: 空词干退化为纯 summary 返回 status: ok，且非法输入安全拒接', async () => {
    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 2 }),
      batchEmbedText: async (texts: string[]) => {
        return {
          vectors: texts.map(() => [0.7071, 0.7071]),
          count: texts.length,
          dim: 2,
          profile: 'classic_light',
          durationMs: 5
        }
      }
    } as any)

    // 空词干
    const emptyStemsReq: WorkflowSemanticsScoreRequest = {
      probeSeq: 3,
      dirPath: 'C:\\Users\\Test\\Documents',
      directoryName: '工作文档',
      countsByExt: { docx: 20 },
      sampledFileNames: []
    }

    const res1 = await matcher.scoreWorkflowSemantics(emptyStemsReq)
    expect(res1.status).toBe('ok')

    // 非法输入: countsByExt 键数 > 64
    const excessiveCounts: Record<string, number> = {}
    for (let i = 0; i < 70; i++) {
      excessiveCounts[`ext_${i}`] = 1
    }
    const invalidReq: WorkflowSemanticsScoreRequest = {
      probeSeq: 4,
      dirPath: 'C:\\Users\\Test\\Invalid',
      countsByExt: excessiveCounts
    }

    const res2 = await matcher.scoreWorkflowSemantics(invalidReq)
    expect(res2.status).toBe('degraded')
    if (res2.status === 'degraded') {
      expect(res2.reason).toBe('invalid_input')
    }
  })

  it('准则 4: LRU 缓存与签名变更失效重算', async () => {
    let embedCalls = 0
    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 2 }),
      batchEmbedText: async (texts: string[]) => {
        embedCalls++
        return {
          vectors: texts.map(() => [1, 0]),
          count: texts.length,
          dim: 2,
          profile: 'classic_light',
          durationMs: 5
        }
      }
    } as any)

    const req: WorkflowSemanticsScoreRequest = {
      probeSeq: 5,
      dirPath: 'C:\\Users\\Test\\CacheTest',
      directoryName: '缓存测试',
      countsByExt: { png: 5 }
    }

    // 第一次请求，会调用 embed 编码官方工作流 + 目录
    const resA = await matcher.scoreWorkflowSemantics(req)
    expect(resA.status).toBe('ok')
    const initialEmbedCalls = embedCalls
    expect(initialEmbedCalls).toBeGreaterThan(0)

    // 第二次请求 (目录稍有差异)，官方工作流应该命中 LRU 缓存，不再重复编码官方工作流
    const req2: WorkflowSemanticsScoreRequest = {
      ...req,
      probeSeq: 6,
      dirPath: 'C:\\Users\\Test\\CacheTest2'
    }
    const resB = await matcher.scoreWorkflowSemantics(req2)
    expect(resB.status).toBe('ok')
    // 仅编码了一次目录本身 (batch size 1)
    expect(embedCalls - initialEmbedCalls).toBe(1)
  })
})
