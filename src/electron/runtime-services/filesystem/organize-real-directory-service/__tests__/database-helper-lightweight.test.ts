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

  it('getLightweightWorkspaceFiles 仅执行轻量投影单条 SQL，毫秒级返回', async () => {
    let capturedSql = ''
    let capturedParams: any[] = []

    const mockDb: any = {
      prepare: vi.fn((sql: string) => {
        capturedSql = sql
        return {
          all: (...params: any[]) => {
            capturedParams = params
            return [
              { id: 1, path: 'D:\\test\\a.txt', name: 'a.txt', smartName: null, extension: 'txt' }
            ]
          }
        }
      })
    }

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1)

    expect(files).toHaveLength(1)
    expect(files[0]).toEqual({
      id: 1,
      path: 'D:\\test\\a.txt',
      name: 'a.txt',
      smartName: null,
      extension: 'txt'
    })

    // 关键架构不变量验证：单条轻量 SQL 投影，严禁查 exif/BLOB
    expect(capturedSql).toContain('SELECT')
    expect(capturedSql).toContain('NULLIF(f.smart_name, wf.name) as smartName')
    expect(capturedSql).toContain('wf.is_analyzed = 1')
    expect(capturedSql).not.toContain('exif')
    expect(capturedParams).toEqual([1])
  })

  it('getLightweightWorkspaceFiles 传入 selectedFileIds 时，严格使用 json_each 参数化绑定', async () => {
    let capturedSql = ''
    let capturedParams: any[] = []

    const mockDb: any = {
      prepare: vi.fn((sql: string) => {
        capturedSql = sql
        return {
          all: (...params: any[]) => {
            capturedParams = params
            return [{ id: 101, path: 'D:\\test\\101.txt', name: '101.txt', smartName: '文件101', extension: 'txt' }]
          }
        }
      })
    }

    const helper = new DatabaseHelper(mockDb)
    const files = await helper.getLightweightWorkspaceFiles(1, [101, 102])

    expect(files).toHaveLength(1)
    // 关键架构不变量验证：规避巨型 IN (?, ?, ...)，严格使用 json_each(?)
    expect(capturedSql).toContain('wf.id IN (SELECT value FROM json_each(?))')
    expect(capturedParams).toEqual([1, JSON.stringify([101, 102])])
  })
})
