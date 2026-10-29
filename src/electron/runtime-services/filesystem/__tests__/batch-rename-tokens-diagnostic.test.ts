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
          dimensionName: '文件类型',
          tagValue: '图片'
        },
        {
          dimensionId: null,
          dimensionCode: 'builtin.source_of_work',
          dimensionName: '作品来源',
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

  it('3. 验证多维标签防覆盖与语言细分映射：画幅/主色调/语言等细分维度不污染文件类型', async () => {
    // 模拟一个多模态图片文件具有多层标签：文件类型、画幅、主色调、语言细分
    const actualSqlRows = [
      {
        id: 2,
        path: 'D:\\workspace\\swan.png',
        name: 'swan.png',
        smartName: '天鹅肖像',
        rawSmartName: '天鹅肖像',
        extension: 'png',
        isAnalyzed: 1,
        is_analyzed: 1,
        author: 'AI画家'
      }
    ]

    const tagRows = [
      {
        file_id: 2,
        tag_code: 'builtin.image',
        via_parent_code: 'builtin.file_type',
        code_path: '/builtin.file_type/builtin.image',
        tag_name: '图片'
      },
      {
        file_id: 2,
        tag_code: 'builtin.square',
        via_parent_code: 'builtin.frame',
        code_path: '/builtin.file_type/builtin.image/builtin.frame/builtin.square',
        tag_name: '正方形'
      },
      {
        file_id: 2,
        tag_code: 'builtin.yellow',
        via_parent_code: 'builtin.main_color',
        code_path: '/builtin.file_type/builtin.image/builtin.main_color/builtin.yellow',
        tag_name: '黄色'
      },
      {
        file_id: 2,
        tag_code: 'builtin.chinese',
        via_parent_code: 'builtin.language_segmentation',
        code_path: '/builtin.file_type/builtin.image/builtin.language_segmentation/builtin.chinese',
        tag_name: '中文'
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
                id: 2,
                qualityScore: 9.0,
                exif: JSON.stringify({ ImageWidth: 1024, ImageHeight: 1024 }),
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

    // 验证 DatabaseHelper 产出的 dimensionTags 中每个标签的直接维度归属
    const dimTags = file.dimensionTags || []
    const tagMap = new Map<string, string>()
    for (const dt of dimTags) {
      tagMap.set(dt.tagValue, dt.dimensionName || '')
    }

    // 正方形维度必须是画幅，黄色必须是主色调，中文必须是语言细分，图片必须是文件类型！
    expect(tagMap.get('图片')).toBe('文件类型')
    expect(tagMap.get('正方形')).toBe('画幅')
    expect(tagMap.get('黄色')).toBe('主色调')
    expect(tagMap.get('中文')).toBe('语言细分')

    // 验证模板渲染：{TAG:文件类型} 绝不能被正方形或黄色覆盖！
    const previewType = NamingDSLEngine.generatePreview('[{TAG:文件类型}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewType[0].newName).toBe('[图片]_天鹅肖像.png')

    // 验证细分维度独立生效
    const previewFrame = NamingDSLEngine.generatePreview('[{TAG:画幅}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewFrame[0].newName).toBe('[正方形]_天鹅肖像.png')

    const previewColor = NamingDSLEngine.generatePreview('[{TAG:主色调}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewColor[0].newName).toBe('[黄色]_天鹅肖像.png')

    // 验证语言宏与语言细分标签映射
    const previewLangMacro = NamingDSLEngine.generatePreview('[{LANG}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewLangMacro[0].newName).toBe('[中文]_天鹅肖像.png')

    const previewTagLang = NamingDSLEngine.generatePreview('[{TAG:语言}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewTagLang[0].newName).toBe('[中文]_天鹅肖像.png')

    const previewTagLangSub = NamingDSLEngine.generatePreview('[{TAG:语言细分}]_{SMART_NAME}', [file as any], mockDb)
    expect(previewTagLangSub[0].newName).toBe('[中文]_天鹅肖像.png')

    // 验证质量分与分辨率复合模板
    const previewCombo = NamingDSLEngine.generatePreview('[{TAG:文件类型}]_{SMART_NAME}_<{META:分辨率}>_[Q{QUALITY_SCORE}]', [file as any], mockDb)
    expect(previewCombo[0].newName).toBe('[图片]_天鹅肖像_<1024x1024>_[Q9.0].png')
  })

  it('4. 验证多模态元数据（时长、页数、编码等）按需水合渲染', async () => {
    const videoFileRow = [
      {
        id: 3,
        path: 'D:\\workspace\\sample.mp4',
        name: 'sample.mp4',
        smartName: '演示视频',
        rawSmartName: '演示视频',
        extension: 'mp4',
        isAnalyzed: 1,
        is_analyzed: 1
      }
    ]

    const mockDb: any = {
      prepare: vi.fn((sql: string) => ({
        get: () => undefined,
        all: () => {
          if (sql.includes('file_tag_relations')) {
            return []
          }
          if (sql.includes('file_contents')) {
            return [
              {
                id: 3,
                qualityScore: 8.5,
                exif: JSON.stringify({
                  Duration: '01:23:45',
                  VideoCodec: 'H.264',
                  PageCount: 12
                }),
                contentMeta: JSON.stringify({}),
                fileMeta: JSON.stringify({})
              }
            ]
          }
          return videoFileRow
        }
      }))
    }

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1)
    const file = files[0]

    // 时长
    const previewDur = NamingDSLEngine.generatePreview('{SMART_NAME}_<{META:时长}>', [file as any], mockDb)
    expect(previewDur[0].newName).toBe('演示视频_<01时23分45秒>.mp4')

    // 编码格式
    const previewCodec = NamingDSLEngine.generatePreview('{SMART_NAME}_[{META:编码}]', [file as any], mockDb)
    expect(previewCodec[0].newName).toBe('演示视频_[H264].mp4')

    // 页数
    const previewPages = NamingDSLEngine.generatePreview('{SMART_NAME}_({META:页数})', [file as any], mockDb)
    expect(previewPages[0].newName).toBe('演示视频_(12P).mp4')
  })
})
