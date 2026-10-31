/**
 * 智能聚类兜底文本的证据口径回归（坍缩根因锁）。
 *
 * 复现缺陷：上一版把「智能命名 + 原始文件名 + 主题词」拼进同一段嵌入文本，
 * 而智能命名由模板生成，`[程序]` 前缀、尾随日期与 `.lnk` 扩展名几乎全库相同，
 * 把两两余弦相似度垫平后，约束层次聚类只能切出占据过半样本的巨型簇，
 * 用户表现为「任意提示词都只有一个目录、只是目录名在变」。
 *
 * 工单 08（AC8）起，聚类兜底文本不再维护本模块私有公式（旧 `buildClusterEmbeddingText`
 * 已删除），统一复用 `@firefly/shared` 的 `buildSemanticText`。本用例保留为**口径回归锁**：
 * 一旦上游改写分段逻辑导致模板骨架回流，这里会先红。
 */
import { describe, expect, it } from 'vitest'
import { buildSemanticText } from '@firefly/shared'

describe('聚类兜底文本（buildSemanticText）证据口径', () => {
  it('智能命名剥离骨架并融合主题标签与描述，以句号连接且无模板前缀', () => {
    const text = buildSemanticText({
      displayName: '[程序] 腾讯微云 2026-08-25',
      rawName: '系统工具_腾讯微云.lnk',
      tags: [
        { name: '云存储', tagGroup: 'fused' },
        { name: '工具', tagGroup: 'ai' }
      ],
      description: '腾讯公司推出的多端云存储与备份网盘客户端',
      contentSnippet: '快速上传下载，支持大文件传输与群组共享'
    })
    expect(text.startsWith('腾讯微云')).toBe(true)
    expect(text).toContain('云存储')
    expect(text).toContain('工具')
    expect(text).toContain('腾讯公司推出的多端云存储与备份网盘客户端')
    expect(text).toContain('快速上传下载，支持大文件传输与群组共享')
    // 坍缩根因：模板骨架一旦回流，全库向量被垫平
    expect(text).not.toContain('2026')
    expect(text).not.toContain('程序')
    expect(text).not.toContain('lnk')
    // 固定字段名模板前缀同样禁止
    expect(text).not.toContain('文件名:')
    expect(text).not.toContain('核心标签:')
  })

  it('无主题标签时回退到剥掉模板骨架的文件名（扩展名/方括号/尾随日期已剔除）', () => {
    const text = buildSemanticText({
      displayName: '[程序] 腾讯微云 2026-08-25',
      rawName: '系统工具_腾讯微云.lnk',
      tags: []
    })
    expect(text.startsWith('腾讯微云')).toBe(true)
    expect(text).not.toContain('2026')
    expect(text).not.toContain('程序')
    expect(text).not.toContain('lnk')
  })

  it('智能命名缺失时以原始文件名为准，不重复拼同一份名字', () => {
    const text = buildSemanticText({
      displayName: '会议纪要.docx',
      rawName: '会议纪要.docx',
      tags: []
    })
    expect(text).toBe('会议纪要')
  })

  it('骨架剥尽后为空则返回空串，交由上层判定 skipped 并降级为向量证据', () => {
    const text = buildSemanticText({
      displayName: '[程序] 2026-08-25.lnk',
      rawName: '[程序] 2026-08-25.lnk',
      tags: []
    })
    expect(text).toBe('')
  })

  it('未标注 tagGroup 的标签 fail-closed 丢弃，不因缺分组而放行元数据事实词', () => {
    const text = buildSemanticText({
      displayName: '月度报表.xlsx',
      rawName: '月度报表.xlsx',
      tags: [{ name: 'xlsx' }, { name: '报表', tagGroup: 'ai' }]
    })
    expect(text).toContain('报表')
    expect(text).not.toContain('xlsx')
  })
})
