/**
 * 智能聚类富文本证据口径回归（坍缩根因锁）。
 *
 * 复现缺陷：上一版把「智能命名 + 原始文件名 + 主题词」拼进同一段嵌入文本，
 * 而智能命名由模板生成，`[程序]` 前缀、尾随日期与 `.lnk` 扩展名几乎全库相同，
 * 把两两余弦相似度垫平后，约束层次聚类只能切出占据过半样本的巨型簇，
 * 用户表现为「任意提示词都只有一个目录、只是目录名在变」。
 */
import { describe, expect, it, vi } from 'vitest'

// 被测模块顶层引入了 Electron 侧重依赖（原生 sqlite、单例服务），
// 本用例只验证纯函数证据口径，逐一把它们替换为空壳避免加载真实运行时。
// 路径必须与被测模块自身的相对解析结果同一，否则 vi.mock 不会命中。
vi.mock('better-sqlite3', () => ({ default: {} }))
vi.mock('../../../../runtime-services/database/database-service', () => ({
  databaseService: {}
}))
vi.mock('../../../../runtime-services/engine-bridge', () => ({ engineBridgeService: {} }))
vi.mock('../../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: { getInstance: () => ({ getValue: () => '' }) }
}))
vi.mock('../../directory-context-service', () => ({ DirectoryContextService: {} }))
vi.mock('../../../../runtime-services/llama/unified-model-manager', () => ({
  unifiedModelManager: {}
}))
vi.mock('../../../../runtime-services/system/omni-service', () => ({ omniService: {} }))
vi.mock('../../../../services/omni-client', () => ({ omniClient: {} }))

import { buildClusterEmbeddingText } from '../AISchemeGenerator'

describe('buildClusterEmbeddingText 证据口径', () => {
  it('智能命名剥离骨架并融合主题词与描述，以句号连接且无模板前缀', () => {
    const text = buildClusterEmbeddingText({
      displayName: '[程序] 腾讯微云 2026-08-25',
      rawName: '系统工具_腾讯微云.lnk',
      keywords: ['云存储', '工具'],
      description: '腾讯公司推出的多端云存储与备份网盘客户端',
      contentSnippet: '快速上传下载，支持大文件传输与群组共享'
    })
    expect(text).toBe('腾讯微云。云存储 工具。腾讯公司推出的多端云存储与备份网盘客户端。快速上传下载，支持大文件传输与群组共享')
    expect(text).not.toContain('2026')
    expect(text).not.toContain('程序')
    expect(text).not.toContain('lnk')
    expect(text).not.toContain('文件名:')
    expect(text).not.toContain('核心标签:')
  })

  it('无主题词时回退到剥掉模板骨架的文件名（扩展名/方括号/尾随日期已剔除）', () => {
    const text = buildClusterEmbeddingText({
      displayName: '[程序] 腾讯微云 2026-08-25',
      rawName: '系统工具_腾讯微云.lnk',
      keywords: []
    })
    expect(text).toBe('腾讯微云')
  })

  it('智能命名缺失时以原始文件名为准，不重复拼同一份名字', () => {
    const text = buildClusterEmbeddingText({
      displayName: '会议纪要.docx',
      rawName: '会议纪要.docx',
      keywords: []
    })
    expect(text).toBe('会议纪要')
  })

  it('骨架剥尽后为空则返回空串，交由上层降级为向量证据', () => {
    const text = buildClusterEmbeddingText({
      displayName: '[程序] 2026-08-25.lnk',
      rawName: '[程序] 2026-08-25.lnk',
      keywords: []
    })
    expect(text).toBe('')
  })
})
