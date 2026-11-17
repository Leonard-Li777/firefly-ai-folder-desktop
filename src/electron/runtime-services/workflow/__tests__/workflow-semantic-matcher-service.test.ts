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
      },
      {
        id: 'builtin.workflow.dev-code-workspace',
        name: '软件研发与代码仓库',
        summary: '整理工程代码与脚本',
        persona: 'developer',
        preset_directory_tree: { name: 'src', children: [{ name: 'tests' }] },
        workspace_config: { extensionWeights: { '.ts': 0.5, '.rs': 0.5 } },
        extensionWeights: { '.ts': 0.5, '.rs': 0.5 },
        source: 'preset',
        category: 'developer',
        icon: 'code',
        is_active: 1
      },
      {
        id: 'builtin.workflow.personal-finance-accounting',
        name: '个人财务与记账收纳',
        summary: '发票报销与账单明细',
        persona: 'finance',
        preset_directory_tree: { name: '账单', children: [{ name: '2026' }] },
        workspace_config: { extensionWeights: { '.xlsx': 0.5, '.csv': 0.5 } },
        extensionWeights: { '.xlsx': 0.5, '.csv': 0.5 },
        source: 'preset',
        category: 'life',
        icon: 'dollar',
        is_active: 1
      }
    ]

    vi.spyOn(ConfigDbManager, 'getInstance').mockReturnValue({
      getCurrentLanguage: () => 'zh-CN',
      getLocalWorkflows: () => mockWorkflows
    } as any)
  })

  it('准则 1: 统计显著性严密解锁门禁 (cos >= 0.52 且 cos >= mean + 1.5 * sigma 解锁，反之不解锁)', async () => {
    // 构造 2 维向量让 screenshots 余弦 = 0.85, medical/dev/finance 余弦 = 0.40
    // vDir = [1, 0]
    // screenshots = [0.85, sqrt(1 - 0.85^2)]
    // medical/dev/finance = [0.40, sqrt(1 - 0.40^2)]
    const y1 = Math.sqrt(Math.max(0, 1 - 0.85 * 0.85))
    const y2 = Math.sqrt(Math.max(0, 1 - 0.4 * 0.4))

    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 2 }),
      batchEmbedText: async (texts: string[]) => {
        // 如果是目录 batch 编码 [dirText]
        if (texts.length === 1 && texts[0].includes('测试相册')) {
          return {
            vectors: [[1, 0]],
            count: 1,
            dim: 2,
            profile: 'classic_light',
            durationMs: 5
          }
        }
        // 如果是工作流 batch 编码 (4 个)
        return {
          vectors: [
            [0.85, y1],
            [0.4, y2],
            [0.4, y2],
            [0.4, y2]
          ],
          count: 4,
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
      expect(res.unlockedWorkflowIds).not.toContain('builtin.workflow.dev-code-workspace')
      expect(res.unlockedWorkflowIds).not.toContain('builtin.workflow.personal-finance-accounting')
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

  it('AC-01: 工作流目录树 JSON 字符串反序列化与去噪 (保护 3D/4K 前缀)', () => {
    // 动态提取私有方法进行原子测试
    const m = matcher as any
    const rawTreeJson = JSON.stringify({
      name: '10-设计规范',
      description: '公司全局UI规范',
      children: [
        { name: '3D模型库' },
        { name: '4K超清素材' },
        { name: '(01) 阶段初稿' },
        { name: '2D动效分镜' }
      ]
    })
    const text = m.buildWorkflowSemanticText({
      name: '三维设计流水线',
      summary: '管理3D建模与设计资产',
      preset_directory_tree: rawTreeJson
    })

    // 验证标号被剥离，3D/4K/2D 等业务词被严格保护
    expect(text).toContain('目录结构包含：')
    expect(text).toContain('设计规范')
    expect(text).not.toContain('10-设计规范')
    expect(text).toContain('3D模型库')
    expect(text).toContain('4K超清素材')
    expect(text).toContain('阶段初稿')
    expect(text).not.toContain('(01) 阶段初稿')
    expect(text).toContain('2D动效分镜')
  })

  it('AC-02 & AC-03: 双级路径自然语言上下文组装与单次自注意力整句编码', async () => {
    const m = matcher as any

    // 1. 验证双级路径提取并过滤 Windows 盘符
    const reqDual: WorkflowSemanticsScoreRequest = {
      probeSeq: 10,
      dirPath: 'D:\\Projects\\FireflyApp\\01-Drafts\\',
      countsByExt: { txt: 2 },
      sampledFileNames: [
        { stem: '第一章', count: 1 },
        { stem: '人物设定', count: 2 }
      ]
    }
    const textDual = m.buildDirectorySemanticText(reqDual)
    expect(textDual).toContain('工作目录：FireflyApp / 01-Drafts')
    expect(textDual).toContain('包含的主要文件有：第一章、人物设定')
    expect(textDual).not.toContain('D:')
    expect(textDual).not.toContain('doc:')
    expect(textDual).not.toContain('image:')

    // 2. 根盘符安全兜底
    const reqRoot: WorkflowSemanticsScoreRequest = {
      probeSeq: 11,
      dirPath: 'C:\\'
    }
    const textRoot = m.buildDirectorySemanticText(reqRoot)
    expect(textRoot).toContain('工作目录：C:')

    // 3. 验证仅发起单次整句 embedding 调用
    let embeddedBatchTexts: string[][] = []
    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 2 }),
      batchEmbedText: async (texts: string[]) => {
        embeddedBatchTexts.push(texts)
        return {
          vectors: texts.map(() => [1, 0]),
          count: texts.length,
          dim: 2,
          profile: 'classic_light',
          durationMs: 5
        }
      }
    } as any)

    await matcher.scoreWorkflowSemantics(reqDual)
    // 目录端请求只应调用一次 batchEmbedText，且 batch 长度为 1 (单句自注意力编码)
    const dirCall = embeddedBatchTexts.find(batch =>
      batch[0].includes('工作目录：FireflyApp / 01-Drafts')
    )
    expect(dirCall).toBeDefined()
    expect(dirCall?.length).toBe(1)
  })

  it('回归防炸门禁: 无主题杂乱目录在低方差下绝不因微小噪声误解锁垂直工作流或制造剧烈分差', async () => {
    // 构造 4 个低方差余弦：一个无关工作流偶然 0.585，其余 3 个为 0.54
    // mean = 0.55125, sigma ≈ 0.0195，0.585 高出均值 1.73 * sigma，但绝对超额仅 0.03375 < 0.06
    const vec = (cos: number) => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))]
    // 使签名唯一，避免命中前序用例缓存
    mockWorkflows[1].summary = '长辈就医病历、化验单与随访资料（低方差噪声测试）'

    vi.spyOn(OmniService, 'getInstance').mockReturnValue({
      isReady: () => true,
      resolveEmbeddingTarget: async () => ({ profile: 'classic_light', dim: 2 }),
      batchEmbedText: async (texts: string[]) => {
        if (texts.length === 1 && texts[0].includes('杂乱桌面')) {
          return {
            vectors: [[1, 0]],
            count: 1,
            dim: 2,
            profile: 'classic_light',
            durationMs: 5
          }
        }
        return {
          vectors: [vec(0.54), vec(0.585), vec(0.54), vec(0.54)],
          count: 4,
          dim: 2,
          profile: 'classic_light',
          durationMs: 10
        }
      }
    } as any)

    const req: WorkflowSemanticsScoreRequest = {
      probeSeq: 99,
      dirPath: 'C:\\Users\\Test\\杂乱桌面',
      countsByExt: { lnk: 45, jpg: 21, docx: 20, mp3: 6, js: 4, mp4: 2 },
      sampledFileNames: [
        { stem: 'Chrome', count: 1 },
        { stem: '微信', count: 1 }
      ]
    }

    const res = await matcher.scoreWorkflowSemantics(req)
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      // 绝对超额不足 0.06，严禁误解锁
      expect(res.unlockedWorkflowIds).toEqual([])
      // 有效标准差地板 0.045 平滑后，sSem 应温和位于 (0.5, 0.85)，不得狂飙至 > 0.90
      const noisyScore =
        res.semanticScoresByWorkflowId['builtin.workflow.senior-medical-care-pipeline']
      expect(noisyScore).toBeGreaterThan(0.5)
      expect(noisyScore).toBeLessThan(0.85)
    }
  })

  it('回归防偏斜: 顶层子目录名 sampledSubDirNames 应拼入目录语义文本，防止单个孤立文件绑架主题', () => {
    const m = matcher as any
    const req: WorkflowSemanticsScoreRequest = {
      probeSeq: 100,
      dirPath: 'F:\\项目创意',
      countsByExt: { zip: 4, json: 27, jpg: 17, png: 22 },
      sampledSubDirNames: ['创意封面秒设计', '朋友圈图文', '工作流', '萤核智能文件夹'],
      sampledFileNames: [{ stem: 'workflow', count: 5 }]
    }
    const text = m.buildDirectorySemanticText(req)
    expect(text).toContain('工作目录：项目创意')
    expect(text).toContain('包含的子目录有：创意封面秒设计、朋友圈图文、工作流、萤核智能文件夹')
    expect(text).toContain('包含的主要文件有：workflow')
  })
})
