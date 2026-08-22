import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MagikaService } from '../magika-service'
import * as child_process from 'child_process'
import * as fs from 'fs'
import { app } from 'electron'

vi.mock('child_process')
vi.mock('fs')
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue('/mock/user/data')
  }
}))
vi.mock('@firefly/shared', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn()
  },
  LogCategory: {
    SYSTEM: 'SYSTEM'
  }
}))

describe('MagikaService', () => {
  let magikaService: any

  beforeEach(() => {
    vi.clearAllMocks()
    // @ts-ignore
    MagikaService.instance = undefined
    magikaService = MagikaService.getInstance()
  })

  it('should return mock category when binary is not found', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const result = await magikaService.identifyFile('test.pdf')
    expect(result.extensions).toContain('pdf')
    expect(result.group).toBe('')
  })

  it('should identify file correctly when binary exists', async () => {
    // Mock binary resolution
    vi.spyOn(magikaService, 'resolveMagikaBinaryPath' as any).mockReturnValue('/path/to/magika')
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)

    const mockOutput = [
      {
        path: 'test.py',
        result: {
          status: 'ok',
          value: {
            output: {
              description: 'Python source',
              extensions: ['py'],
              group: 'code',
              is_text: true,
              label: 'python',
              mime_type: 'text/x-python'
            },
            score: 0.99
          }
        }
      }
    ]

    ;(child_process.execFile as any).mockImplementation(
      (path: any, args: any, opts: any, callback: any) => {
        callback(null, JSON.stringify(mockOutput), '')
      }
    )

    const result = await magikaService.identifyFile('test.py')
    expect(result.group).toBe('code')
    expect(result.label).toBe('python')
    expect(result.score).toBe(0.99)
  })
})
