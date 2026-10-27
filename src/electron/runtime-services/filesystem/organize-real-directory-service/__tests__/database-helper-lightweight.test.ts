import { describe, it, expect, vi } from 'vitest'
import { DatabaseHelper } from '../DatabaseHelper'

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

/**
 * 构建可感知多次 prepare 调用的 mock DB
 * 主文件查询（包含 NULLIF(f.smart_name）返回 fileRows
 * appendDimensionTagsToFiles 的标签查询（包含 file_tag_relations）返回 tagRows
 */
function makeMultiSqlMockDb(
  fileRows: any[],
  tagRows: any[] = []
): { mockDb: any; preparedSqls: string[]; preparedParamsList: any[][] } {
  const preparedSqls: string[] = []
  const preparedParamsList: any[][] = []

  const mockDb: any = {
    prepare: vi.fn((sql: string) => {
      preparedSqls.push(sql.trim())
      return {
        get: () => undefined,
        all: (...params: any[]) => {
          preparedParamsList.push(params)
          if (sql.includes('file_tag_relations')) {
            return tagRows
          }
          return fileRows
        }
      }
    })
  }
  return { mockDb, preparedSqls, preparedParamsList }
}

describe('DatabaseHelper 轻量投影与极速统计回归测试 (ABI-safe Mock)', () => {
  it('getWorkspaceAnalyzedFileCount 正确执行极速 COUNT(*) 查询', () => {
    let capturedSql = ''
    let capturedParams: any[] = []

    const mockDb: any = {
      prepare: vi.fn((sql: string) => {
        capturedSql = sql
        return {
          get: (...params: any[]) => {
            capturedParams = params
            return { count: 42 }
          }
        }
      })
    }

    const helper = new DatabaseHelper(mockDb)
    const count = helper.getWorkspaceAnalyzedFileCount(1)

    expect(count).toBe(42)
    expect(capturedSql).toContain('SELECT COUNT(*) as count FROM workspace_files WHERE workspace_id = ?')
    expect(capturedSql).toContain('is_analyzed = 1')
    expect(capturedParams).toEqual([1])
  })

  it('getLightweightWorkspaceFiles 仅执行轻量投影单条 SQL，毫秒级返回；结果带 dimensionTags 字段', async () => {
    const { mockDb, preparedSqls, preparedParamsList } = makeMultiSqlMockDb(
      [{ id: 1, path: 'D:\\test\\a.txt', name: 'a.txt', smartName: null, extension: 'txt' }],
      [] // 无标签
    )

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1)

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      id: 1,
      path: 'D:\\test\\a.txt',
      name: 'a.txt',
      smartName: null,
      extension: 'txt'
    })
    // dimensionTags 已由 appendDimensionTagsToFiles 注入（无标签时为空数组）
    expect(Array.isArray(files[0].dimensionTags)).toBe(true)
    expect(files[0].dimensionTags).toHaveLength(0)

    // 关键架构不变量验证：严禁查 exif/BLOB
    const mainSql = preparedSqls.find(s => s.includes('NULLIF(f.smart_name'))
    expect(mainSql).toBeTruthy()
    expect(mainSql).toContain('wf.is_analyzed = 1')
    expect(mainSql).not.toContain('exif')
    const mainIdx = preparedSqls.indexOf(mainSql!)
    expect(preparedParamsList[mainIdx]).toEqual([1])
  })

  it('getLightweightWorkspaceFiles 附加 dimensionTags：有标签时 tagValue 正确返回', async () => {
    const { mockDb } = makeMultiSqlMockDb(
      [{ id: 1, path: 'D:\\test\\a.jpg', name: 'a.jpg', smartName: null, extension: 'jpg' }],
      [
        { file_id: 1, tag_code: 'omw.02084071.n', via_parent_code: 'builtin.subject_type', tag_name: '猫' },
        { file_id: 1, tag_code: 'builtin.indoor', via_parent_code: 'builtin.scene', tag_name: '室内' }
      ]
    )

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1)

    expect(files).toHaveLength(1)
    expect(files[0].dimensionTags).toHaveLength(2)
    expect(files[0].dimensionTags?.map(t => t.tagValue)).toEqual(['猫', '室内'])
    expect(files[0].dimensionTags?.[0].dimensionCode).toBe('builtin.subject_type')
  })

  it('getLightweightWorkspaceFiles 传入 selectedFileIds 时，严格使用 json_each 参数化绑定', async () => {
    const { mockDb, preparedSqls, preparedParamsList } = makeMultiSqlMockDb(
      [{ id: 101, path: 'D:\\test\\101.txt', name: '101.txt', smartName: '文件101', extension: 'txt' }]
    )

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1, [101, 102])

    expect(files).toHaveLength(1)
    // 关键架构不变量验证：规避巨型 IN (?, ?, ...)，严格使用 json_each(?) 与 CAST 转整
    const mainSql = preparedSqls.find(s => s.includes('NULLIF(f.smart_name'))
    expect(mainSql).toBeTruthy()
    expect(mainSql).toContain('wf.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))')
    const mainParams = preparedParamsList[preparedSqls.indexOf(mainSql!)]
    expect(mainParams).toEqual([1, JSON.stringify([101, 102])])
  })

  it('getLightweightWorkspaceFiles 传入未收录工作区路径但在 selectedFileIds 存在时，安全基于主键兜底返回且规避反斜杠 LIKE 查空', async () => {
    const { mockDb, preparedSqls } = makeMultiSqlMockDb(
      [{ id: 101, path: 'D:\\test\\101.txt', name: '101.txt', smartName: '文件101', extension: 'txt' }]
    )

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles('D:\\not_found_path', [101])

    expect(files).toHaveLength(1)
    const mainSql = preparedSqls.find(s => s.includes('NULLIF(f.smart_name'))
    expect(mainSql).toBeTruthy()
    expect(mainSql).toContain('wf.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))')
    expect(mainSql).not.toContain('LIKE')
  })

  it('getLightweightWorkspaceFiles 传入 limit 时，正确在 SQL 中追加 LIMIT ? 并参数化绑定', async () => {
    const { mockDb, preparedSqls, preparedParamsList } = makeMultiSqlMockDb(
      [{ id: 1, path: 'D:\\test\\1.txt', name: '1.txt', smartName: null, extension: 'txt' }]
    )

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1, undefined, 3000)

    expect(files).toHaveLength(1)
    const mainSql = preparedSqls.find(s => s.includes('NULLIF(f.smart_name'))
    expect(mainSql).toBeTruthy()
    expect(mainSql).toContain('ORDER BY wf.path ASC LIMIT ?')
    const mainParams = preparedParamsList[preparedSqls.indexOf(mainSql!)]
    expect(mainParams).toEqual([1, 3000])
  })
})
