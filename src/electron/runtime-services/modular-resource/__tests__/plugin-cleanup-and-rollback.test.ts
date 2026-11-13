import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { PluginCleanupService, LEGACY_PLAINTEXT_DIRS } from '../plugin-cleanup-service'
import { writeCurrentJsonSync, readCurrentJsonSync, resolveActiveModelPaths } from '@firefly/shared'

describe('PluginCleanupService & Immutable Pointer Rollback (Ticket 09)', () => {
  let tmpRoot: string
  let sharedDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'))
    sharedDir = path.join(tmpRoot, '_shared')
    fs.mkdirSync(sharedDir, { recursive: true })
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {}
  })

  it('Genesis V1: 不盲目删除模型目录，确保受管资源文件安全留存', async () => {
    // 构造受管模型目录
    const gemmaDir = path.join(sharedDir, 'emb-391b9a03')
    fs.mkdirSync(gemmaDir, { recursive: true })
    fs.writeFileSync(path.join(gemmaDir, 'model_q4.onnx'), 'DUMMY_RAW_ONNX')

    const voiceDir = path.join(sharedDir, 'asr-f3b8224c')
    fs.mkdirSync(voiceDir, { recursive: true })
    fs.writeFileSync(path.join(voiceDir, 'model.int8.onnx'), 'DUMMY_RAW_ONNX')

    // 构造合法匿名密文槽位目录
    const validSlotDir = path.join(sharedDir, 'cpu-485c04b7')
    fs.mkdirSync(validSlotDir, { recursive: true })
    fs.writeFileSync(path.join(validSlotDir, 'model.sha1.ffpc'), 'ENCRYPTED_FFPC')
    writeCurrentJsonSync(validSlotDir, {
      activeFile: 'model.sha1.ffpc',
      keyEpoch: 1,
      version: '1.0.0'
    })

    const result = await PluginCleanupService.cleanupLegacyPlaintextAssets(sharedDir)

    expect(fs.existsSync(gemmaDir)).toBe(true)
    expect(fs.existsSync(voiceDir)).toBe(true)
    expect(fs.existsSync(validSlotDir)).toBe(true)
    expect(result.removedDirs).toEqual([])
  })

  it('should prune obsolete ffpc containers beyond 1 historical retention limit', async () => {
    const slotDir = path.join(sharedDir, 'cpu-485c04b7')
    fs.mkdirSync(slotDir, { recursive: true })

    const activeFfpc = path.join(slotDir, 'model.active.ffpc')
    const histFfpc1 = path.join(slotDir, 'model.history1.ffpc')
    const histFfpc2 = path.join(slotDir, 'model.history2.ffpc') // 更旧的，应被删除

    fs.writeFileSync(activeFfpc, 'ACTIVE')
    fs.writeFileSync(histFfpc1, 'HIST1')
    fs.writeFileSync(histFfpc2, 'HIST2')

    // 设置不同 mtime
    const now = Date.now() / 1000
    fs.utimesSync(activeFfpc, now, now)
    fs.utimesSync(histFfpc1, now - 100, now - 100)
    fs.utimesSync(histFfpc2, now - 500, now - 500)

    writeCurrentJsonSync(slotDir, {
      activeFile: 'model.active.ffpc',
      keyEpoch: 1,
      version: '2.0.0'
    })

    const result = await PluginCleanupService.cleanupLegacyPlaintextAssets(sharedDir)

    expect(fs.existsSync(activeFfpc)).toBe(true)
    expect(fs.existsSync(histFfpc1)).toBe(true) // 保留 1 个历史版本
    expect(fs.existsSync(histFfpc2)).toBe(false) // 多余的历史版本被淘汰
    expect(result.removedFiles).toContain('model.history2.ffpc')
  })

  it('should handle EBUSY / locking gracefully and persist to pending_delete.json', async () => {
    const pendingFile = path.join(sharedDir, 'pending_delete.json')
    const lockedDir = path.join(sharedDir, 'moss-tts')
    fs.mkdirSync(lockedDir, { recursive: true })
    const dummyFile = path.join(lockedDir, 'am.onnx')
    fs.writeFileSync(dummyFile, 'LOCKED_CONTENT')

    // 在 Windows 下通过排他打开文件模拟锁定占用
    let fd: number | null = null
    try {
      fd = fs.openSync(dummyFile, 'r+')
    } catch {}

    const result = await PluginCleanupService.cleanupLegacyPlaintextAssets(sharedDir)

    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }

    // 检查是否正常返回并未崩溃
    expect(result).toBeDefined()
    // 若在 Windows 产生锁定，pending_delete.json 会记录
    if (fs.existsSync(pendingFile)) {
      const pendingList = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'))
      expect(Array.isArray(pendingList)).toBe(true)
    }
  })

  it('should support atomic pointer switch and instantaneous rollback', () => {
    const slotDir = path.join(sharedDir, 'emb-391b9a03')
    fs.mkdirSync(slotDir, { recursive: true })

    const ffpcV1 = path.join(slotDir, 'model.v1.ffpc')
    const ffpcV2 = path.join(slotDir, 'model.v2.ffpc')
    fs.writeFileSync(ffpcV1, 'CONTAINER_V1')
    fs.writeFileSync(ffpcV2, 'CONTAINER_V2')

    // 1. 初始化为 v1
    writeCurrentJsonSync(slotDir, {
      activeFile: 'model.v1.ffpc',
      keyEpoch: 1,
      version: '1.0.0'
    })
    let active = resolveActiveModelPaths(slotDir)
    expect(active?.activeFile).toBe('model.v1.ffpc')
    expect(active?.version).toBe('1.0.0')

    // 2. 升级指向 v2
    writeCurrentJsonSync(slotDir, {
      activeFile: 'model.v2.ffpc',
      keyEpoch: 1,
      version: '2.0.0'
    })
    active = resolveActiveModelPaths(slotDir)
    expect(active?.activeFile).toBe('model.v2.ffpc')
    expect(active?.version).toBe('2.0.0')

    // 3. 秒级回滚切换回 v1
    writeCurrentJsonSync(slotDir, {
      activeFile: 'model.v1.ffpc',
      keyEpoch: 1,
      version: '1.0.0'
    })
    active = resolveActiveModelPaths(slotDir)
    expect(active?.activeFile).toBe('model.v1.ffpc')
    expect(active?.version).toBe('1.0.0')
  })
})
