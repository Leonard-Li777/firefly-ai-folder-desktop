import { describe, it, vi } from 'vitest'

vi.mock('electron', () => {
  const m = {
    app: { getPath: vi.fn(() => 'C:\\test'), getName: vi.fn(() => 'firefly'), isPackaged: false },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    shell: { showItemInFolder: vi.fn() }
  }
  return { ...m, default: m }
})
vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

import { loadIgnoreRules, getSystemExclusionRules } from '../../analysis/analysis-exclusion-service'

describe('DIAG loadIgnoreRules', () => {
  it('输出真实返回', () => {
    console.log('DIAG systemRules:', JSON.stringify(getSystemExclusionRules()))
    console.log('DIAG loadIgnoreRules:', JSON.stringify(loadIgnoreRules()))
  })
})
