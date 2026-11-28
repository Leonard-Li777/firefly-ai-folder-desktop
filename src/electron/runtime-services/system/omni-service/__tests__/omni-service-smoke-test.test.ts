// @vitest-environment node
import * as os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => os.tmpdir())
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  powerMonitor: { on: vi.fn() },
  shell: { openPath: vi.fn() }
}))

vi.mock('../helpers', () => ({
  broadcastOmniStatus: vi.fn()
}))

vi.mock('../../../../main/worktree-env', () => ({
  isLocalDevRuntime: vi.fn(() => false)
}))

vi.mock('../../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: vi.fn(() => ({
      getValue: vi.fn(),
      onValueChange: vi.fn(() => () => {})
    }))
  }
}))

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))

vi.mock('../../../database', () => ({
  databaseService: {
    getDbPath: vi.fn(() => null)
  }
}))

import { OmniService } from '../omni-service'

describe('OmniService.runSmokeTest 冷启动超时预算', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    ;(OmniService as any).instance = undefined
  })

  it('gemma_unified 默认给予 30000ms 预算，classic_light 默认给予 15000ms，支持显式 timeoutMs 覆盖', async () => {
    const svc = OmniService.getInstance()
    vi.spyOn(svc as any, 'ensureRunning').mockResolvedValue(undefined)
    vi.spyOn(svc as any, 'waitForEnginePortReady').mockResolvedValue(true)
    vi.spyOn(svc as any, 'verifyMountManifestStatus').mockResolvedValue({ ok: true })
    const batchSpy = vi.spyOn(svc as any, 'batchEmbedText').mockResolvedValue({
      vectors: [new Array(768).fill(0.1)],
      durationMs: 120
    })

    const gemmaRes = await svc.runSmokeTest({
      profile: 'gemma_unified',
      test_tokens: ['test']
    })
    expect(gemmaRes.success).toBe(true)
    expect(batchSpy).toHaveBeenNthCalledWith(1, ['test'], {
      profile: 'gemma_unified',
      timeoutMs: 30_000
    })

    const classicRes = await svc.runSmokeTest({
      profile: 'classic_light',
      test_tokens: ['test']
    })
    expect(classicRes.success).toBe(true)
    expect(batchSpy).toHaveBeenNthCalledWith(2, ['test'], {
      profile: 'classic_light',
      timeoutMs: 15_000
    })

    await svc.runSmokeTest({
      profile: 'gemma_unified',
      test_tokens: ['test'],
      timeoutMs: 45_000
    })
    expect(batchSpy).toHaveBeenNthCalledWith(3, ['test'], {
      profile: 'gemma_unified',
      timeoutMs: 45_000
    })
  })
})
