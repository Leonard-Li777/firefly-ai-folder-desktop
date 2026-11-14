import { describe, it, expect, vi } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
import { AISchemeGenerator, type AISchemeProvider } from '../AISchemeGenerator'
import { omniService } from '../../../system/omni-service'

vi.mock('../../../system/omni-service', () => ({
  omniService: {
    clusterDocuments: vi.fn(),
    batchEmbedText: vi.fn()
  }
}))

vi.mock('../../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: (key: string) => (key === 'AI_EMBEDDING_PROFILE' ? 'classic_light' : 3000),
      getEmbeddingDim: () => 384
    })
  }
}))

describe('AISchemeGenerator 智能聚类整树目录名称全局唯一性与防重名消歧', () => {
  it('智能聚类生成结果树中不应有两个相同的目录名且必须消除镜像倒错', async () => {
    // 模拟数据库返回 5 个文件
    const mockFiles = [
      {
        id: 1,
        path: 'C:\\Users\\lilun\\cloud_term_link_20260223.lnk',
        name: 'cloud_term_link_20260223.lnk',
        file_fingerprint: 'fp_1',
        contents_fp: 'fp_1',
        canonical_vector_state: 'ready'
      },
      {
        id: 2,
        path: 'C:\\Users\\lilun\\云盘工具_夸克网盘_20260223.lnk',
        name: '云盘工具_夸克网盘_20260223.lnk',
        file_fingerprint: 'fp_2',
        contents_fp: 'fp_2',
        canonical_vector_state: 'ready'
      },
      {
        id: 3,
        path: 'C:\\Users\\lilun\\云盘服务_阿里云盘_20260223.lnk',
        name: '云盘服务_阿里云盘_20260223.lnk',
        file_fingerprint: 'fp_3',
        contents_fp: 'fp_3',
        canonical_vector_state: 'ready'
      },
      {
        id: 4,
        path: 'C:\\Users\\lilun\\[程序][中国]歌曲创作_网易云音乐 XStudio.lnk',
        name: '[程序][中国]歌曲创作_网易云音乐 XStudio.lnk',
        file_fingerprint: 'fp_4',
        contents_fp: 'fp_4',
        canonical_vector_state: 'ready'
      },
      {
        id: 5,
        path: 'C:\\Users\\lilun\\style.css',
        name: 'style.css',
        file_fingerprint: 'fp_5',
        contents_fp: 'fp_5',
        canonical_vector_state: 'ready'
      }
    ]

    const mockDb: any = {
      prepare: vi.fn(() => ({
        all: () => mockFiles,
        get: () => ({})
      }))
    }

    const mockProvider: AISchemeProvider = {
      db: mockDb,
      createFromStrategy: vi.fn(),
      replaceFiles: vi.fn(),
      get: vi.fn(),
      getDimensionGroups: vi.fn()
    }

    const mockSemanticService: any = {
      getSemanticEvidences: vi.fn(async () => [
        { fileId: 1, fileFingerprint: 'fp_1', keywords: ['高质量', 'lilun'] },
        { fileId: 2, fileFingerprint: 'fp_2', keywords: ['高质量', '夸克网盘', '云盘'] },
        { fileId: 3, fileFingerprint: 'fp_3', keywords: ['高质量', '阿里云盘', '云盘'] },
        { fileId: 4, fileFingerprint: 'fp_4', keywords: ['高质量', '网易云音乐', '音乐'] },
        { fileId: 5, fileFingerprint: 'fp_5', keywords: ['CSS体积', '前端'] }
      ])
    }

    // 模拟 Omni 返回包含镜像倒错与跨层级重名的簇：
    // - 簇 A: 根 "高质量" -> 子 "lilun" (1个文件)
    // - 簇 B: 根 "高质量" -> 子 "CSS体积" (1个文件)
    // - 簇 C: 根 "lilun" -> 子 "高质量" (3个文件，互为镜像倒错)
    // - 簇 D: 根 "工具" -> 子 "高质量" (重名目录)
    vi.mocked(omniService.clusterDocuments).mockResolvedValueOnce({
      success: true,
      result: {
        clusters: [
          {
            fingerprints: ['fp_1'],
            folderName: 'lilun',
            path: ['高质量', 'lilun']
          },
          {
            fingerprints: ['fp_5'],
            folderName: 'CSS体积',
            path: ['高质量', 'CSS体积']
          },
          {
            fingerprints: ['fp_2', 'fp_3', 'fp_4'],
            folderName: '高质量',
            path: ['lilun', '高质量']
          },
          {
            fingerprints: ['fp_2'],
            folderName: '高质量',
            path: ['工具', '高质量']
          }
        ],
        unclassifiedFiles: [],
        durationMs: 12
      }
    } as any)

    const generator = new AISchemeGenerator(mockProvider, {
      semanticRepresentationService: mockSemanticService
    })
    const result = await generator.generateHACClusterScheme(1)

    expect(result).not.toBeNull()
    const directories = result!.directories

    // 1. 验证镜像倒错被消除：不应同时存在 ["高质量", "lilun"] 和 ["lilun", "高质量"]
    const rootNames = directories.map(d => d.name)
    expect(rootNames).toContain('高质量')
    expect(rootNames).not.toContain('lilun') // 镜像倒错簇已并入主路径，lilun 不再单独成根

    // 2. 收集整棵树中所有出现的目录名称
    const allDirectoryNames: string[] = []
    const traverse = (node: any) => {
      allDirectoryNames.push(node.name)
      if (node.subdirectories && node.subdirectories.length > 0) {
        for (const sub of node.subdirectories) {
          traverse(sub)
        }
      }
    }
    for (const root of directories) {
      traverse(root)
    }

    // 3. 核心断言：整棵结果目录树中绝对不允许有两个相同的目录名！
    const uniqueNames = new Set(allDirectoryNames)
    expect(uniqueNames.size).toBe(allDirectoryNames.length)
  })
})
