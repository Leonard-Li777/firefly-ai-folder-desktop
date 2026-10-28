import { describe, it, expect, vi } from 'vitest'
import { NamingDSLEngine } from '../naming-dsl-engine'
import { DatabaseHelper } from '../organize-real-directory-service/DatabaseHelper'

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

describe('批量更名模板标签验收测试 (Phase 2 & 3 Full Green Verification)', () => {
  it('1. 验证分类维度标签生效：{TAG:文件类型} 与 {TAG:作品来源} 正确匹配维度标签', () => {
    // 模拟 DatabaseHelper.appendDimensionTagsToFiles 返回的 dimensionTags
    const fileWithTags = {
      id: 1,
      path: 'D:\\workspace\\test.jpg',
      name: 'test.jpg',
      smartName: '画作',
      extension: 'jpg',
      isAnalyzed: true,
      dimensionTags: [
        {
          dimensionId: null,
          dimensionCode: 'builtin.file_type',
          tagValue: '图片'
        },
        {
          dimensionId: null,
          dimensionCode: 'builtin.source_of_work',
          tagValue: '原创'
        }
      ]
    }

    const previewType = NamingDSLEngine.generatePreview('[{TAG:文件类型}]_{SMART_NAME}', [fileWithTags as any])
    expect(previewType[0].newName).toBe('[图片]_画作.jpg')

    const previewSource = NamingDSLEngine.generatePreview('[{TAG:作品来源}]_{SMART_NAME}', [fileWithTags as any])
    expect(previewSource[0].newName).toBe('[原创]_画作.jpg')
  })

  it('2. 验证质量评分、作者、元数据在轻量入场查询与按需水合下全部生效', async () => {
    // 模拟 DatabaseHelper 真实入场轻量 SQL 查出的投影（包含 author 与 rawSmartName，不包含 heavy exif）
    const actualSqlRows = [
      {
        id: 1,
        path: 'D:\\workspace\\test.jpg',
        name: 'test.jpg',
        smartName: '测试画作',
        rawSmartName: '测试画作',
        extension: 'jpg',
        isAnalyzed: 1,
        is_analyzed: 1,
        author: '张大千'
      }
    ]

    const tagRows = [
      {
        file_id: 1,
        tag_code: 'builtin.image',
        via_parent_code: 'builtin.file_type',
        code_path: '/builtin.file_type/builtin.image',
        tag_name: '图片'
      }
    ]

    const mockDb: any = {
      prepare: vi.fn((sql: string) => ({
        get: () => undefined,
        all: () => {
          if (sql.includes('file_tag_relations')) {
            return tagRows
          }
          if (sql.includes('file_contents')) {
            return [
              {
                id: 1,
                qualityScore: 9.2,
                exif: JSON.stringify({ ImageWidth: 1920, ImageHeight: 1080 }),
                contentMeta: JSON.stringify({}),
                fileMeta: JSON.stringify({})
              }
            ]
          }
          return actualSqlRows
        }
      }))
    }

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1)
    const file = files[0]

    // 1. 作者应当从入场轻量文件字段生效
    const previewAuthor = NamingDSLEngine.generatePreview('[{AUTHOR}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewAuthor[0].newName).toBe('[张大千]_测试画作.jpg')

    // 2. 分类维度应当从轻量 tags 生效
    const previewDim = NamingDSLEngine.generatePreview('[{TAG:文件类型}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewDim[0].newName).toBe('[图片]_测试画作.jpg')

    // 3. 质量评分应当通过按需水合生效
    const previewQuality = NamingDSLEngine.generatePreview('{SMART_NAME}_[Q{QUALITY_SCORE}]', [file as any], mockDb)
    expect(previewQuality[0].newName).toBe('测试画作_[Q9.2].jpg')

    // 4. 元数据应当通过按需水合生效
    const previewMetaRes = NamingDSLEngine.generatePreview('{SMART_NAME}_<{META:分辨率}>', [file as any], mockDb)
    expect(previewMetaRes[0].newName).toBe('测试画作_<1920x1080>.jpg')
  })
})
