/**
 * Ticket 29 (P2-4): 独立能力探测结果缓存单元测试
 * 覆盖：PopplerDetector 进程级缓存命中与显式失效；OmniService 探针缓存不用于引擎可用性判定
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('electron-conf', () => ({
  Conf: class MockConf {
    store: Record<string, unknown> = {}
    get() {
      return undefined
    }
    set() {}
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
    getVersion: () => '0.0.0',
    getAppPath: () => process.cwd()
  },
  powerMonitor: {
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))
import { ResourceLocator } from '@firefly/shared'
import { logger } from '@firefly/shared'
import { PopplerDetector, popplerDetector } from '../poppler-detector'
import { OmniService, omniService } from '../omni-service/omni-service'
import { llmGatewayService } from '../../llm/llm-gateway-service'
import { modularResourceService } from '../modular-resource-service-core'

describe('Probe Result Cache (Ticket 29 / P2-4)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-probe-cache-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('PopplerDetector 首次探测后缓存结果（重复调用不再访问 ResourceLocator），invalidateCache 后重探', async () => {
    const fakeBin1 = path.join(tempDir, 'pdftoppm-v1.exe')
    const fakeBin2 = path.join(tempDir, 'pdftoppm-v2.exe')
    fs.writeFileSync(fakeBin1, 'bin1')
    fs.writeFileSync(fakeBin2, 'bin2')

    const resolveSpy = vi.spyOn(ResourceLocator, 'resolveBin').mockImplementation(() => fakeBin1)

    const detector = new PopplerDetector()
    const first = await detector.detectPoppler()
    expect(first).toEqual({ installed: true, path: fakeBin1 })
    const callCountAfterFirst = resolveSpy.mock.calls.length

    // 重复探测命中进程级缓存，不再触发 ResourceLocator / 磁盘探测
    const second = await detector.detectPoppler()
    expect(second).toEqual({ installed: true, path: fakeBin1 })
    expect(resolveSpy.mock.calls.length).toBe(callCountAfterFirst)

    // 替换二进制并显式失效缓存后，应取到新路径
    resolveSpy.mockImplementation(() => fakeBin2)
    detector.invalidateCache()
    const third = await detector.detectPoppler()
    expect(third).toEqual({ installed: true, path: fakeBin2 })
  })

  it('OmniService 探针缓存命中不得用于可用性判定（stopped 状态仍不可用）', () => {
    const omni = OmniService.getInstance() as any
    // 模拟已缓存可执行文件候选
    omni.cachedExecutableCandidates = [path.join(tempDir, 'firefly-omni.exe')]
    // 人为置为 stopped/未就绪状态
    omni.lastStatusEvent = { status: 'stopped', version: '1.0.0' }
    omni.managedProcess = null

    expect(omni.isReady()).toBe(false)
    expect(omni.isServiceRunning()).toBe(false)

    // 显式失效可清空可执行文件候选缓存
    omni.invalidateExecutableProbeCache()
    expect(omni.cachedExecutableCandidates).toBeNull()
  })

  it('ModularResourceService.invalidateUsedBytesCache 联动失效三大能力探针缓存', async () => {
    const omniSpy = vi
      .spyOn(omniService, 'invalidateExecutableProbeCache')
      .mockImplementation(() => {})
    const llmSpy = vi
      .spyOn(llmGatewayService, 'invalidateLocalProbeCache')
      .mockImplementation(() => {})
    const popplerSpy = vi.spyOn(popplerDetector, 'invalidateCache').mockImplementation(() => {})

    modularResourceService.invalidateUsedBytesCache('mod-test')

    await vi.waitFor(() => {
      expect(omniSpy).toHaveBeenCalledTimes(1)
      expect(llmSpy).toHaveBeenCalledTimes(1)
      expect(popplerSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('invalidateCapabilityProbeCaches 单个探针失效异常时显式告警且不阻断其余探针失效', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const omniSpy = vi
      .spyOn(omniService, 'invalidateExecutableProbeCache')
      .mockImplementation(() => {
        throw new Error('mock omni invalidate error')
      })
    const llmSpy = vi
      .spyOn(llmGatewayService, 'invalidateLocalProbeCache')
      .mockImplementation(() => {})
    const popplerSpy = vi.spyOn(popplerDetector, 'invalidateCache').mockImplementation(() => {})

    await expect(modularResourceService.invalidateCapabilityProbeCaches()).resolves.toBeUndefined()

    expect(omniSpy).toHaveBeenCalledTimes(1)
    expect(llmSpy).toHaveBeenCalledTimes(1)
    expect(popplerSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('omniService.invalidateExecutableProbeCache'),
      expect.any(Error)
    )
  })
})
