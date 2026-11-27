import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_PLUGIN_CATALOG_META, readReadyMarkerSync } from '@firefly/shared'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => os.tmpdir())
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn()
  }
}))

import {
  commitPluginDirectoryWithTxn,
  recoverPendingPluginTxns,
  writePluginReadyMarkerWithVisualVocab,
  writeVisualTxnRecordSync
} from '../visual-vocab-txn'
import { OmniPerceptionHttpError, OmniService } from '../omni-service'
import { classifyVisualPerceptionError } from '../../analysis-queue-service/file-processor/analysis-error-classifier'

function writeDummyClipFiles(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(path.join(dirPath, 'chinese-clip-vit-b-16-int8.onnx'), Buffer.from('onnx-v'))
  fs.writeFileSync(path.join(dirPath, 'cn_clip_text.onnx'), Buffer.from('onnx-t'))
  fs.writeFileSync(path.join(dirPath, 'cn_clip_vocab.txt'), Buffer.from('vocab'))
  fs.writeFileSync(path.join(dirPath, 'vocab_v.f16'), Buffer.alloc(16, 1))
  fs.writeFileSync(
    path.join(dirPath, 'vocab_v.meta.json'),
    JSON.stringify({ version: '2.0.0', schema_version: 2, bake_revision: 1 })
  )
}

describe('Ticket 08: 视觉词表 .txn.json 事务、崩溃恢复与非阻断启动核验', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-visual-txn-test-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('暂存同源校验失败或 reload 返回目标槽非 ok 时完整回滚旧目录与旧 .ready.json 并再调 reload', async () => {
    const intentsDir = path.join(tmpRoot, '.intents')
    const destDir = path.join(tmpRoot, '_shared', 'emb-a42b0c8f')
    const stagingDir = path.join(tmpRoot, '_staging', 'clip-new')

    fs.mkdirSync(destDir, { recursive: true })
    fs.writeFileSync(path.join(destDir, 'old-marker.txt'), 'old-version')
    const oldMarkerSha = crypto.createHash('sha256').update('old-version').digest('hex')
    fs.writeFileSync(
      path.join(destDir, '.ready.json'),
      JSON.stringify({
        version: 1,
        algo: 'sha256-v1',
        resourceId: 'chinese-clip',
        sharedSubDir: 'emb-a42b0c8f',
        digest: oldMarkerSha,
        fileCount: 1,
        totalBytes: 11,
        generatedAt: new Date().toISOString()
      })
    )

    writeDummyClipFiles(stagingDir)
    const reloadCalls: number[] = []
    const res = await commitPluginDirectoryWithTxn({
      intentsDir,
      resourceId: 'chinese-clip',
      sharedSubDir: 'emb-a42b0c8f',
      stagingDir,
      destDir,
      targetMode: 'install',
      verifyFn: async dir => ({ ok: true, dir, encoderId: 2, bakeRevision: 1 }),
      reloadAssetsFn: async () => {
        reloadCalls.push(1)
        return {
          success: true,
          activeStatus: 'missing',
          byEncoder: { '2': { status: 'missing' } }
        }
      }
    })

    expect(res.ok).toBe(false)
    expect(res.rolledBack).toBe(true)
    expect(reloadCalls.length).toBe(2)
    expect(fs.existsSync(path.join(destDir, 'old-marker.txt'))).toBe(true)
    expect(readReadyMarkerSync(destDir)?.digest).toBe(oldMarkerSha)
    expect(fs.existsSync(path.join(intentsDir, 'visual-txn-chinese-clip.json'))).toBe(false)
  })

  it('模拟目录替换后写 .ready.json 前崩溃，重启恢复先本地复验补写 .ready.json 并移除 vocab_v.bin', async () => {
    const intentsDir = path.join(tmpRoot, '.intents')
    const destDir = path.join(tmpRoot, '_shared', 'emb-a42b0c8f')
    const stagingDir = path.join(tmpRoot, '_staging', 'clip-staged')
    const backupDir = `${destDir}.bak-crash`

    writeDummyClipFiles(destDir)
    fs.writeFileSync(path.join(destDir, 'vocab_v.bin'), Buffer.from('stale-legacy-bin'))
    fs.mkdirSync(backupDir, { recursive: true })
    writeVisualTxnRecordSync(intentsDir, {
      version: 1,
      resourceId: 'chinese-clip',
      sharedSubDir: 'emb-a42b0c8f',
      destDir,
      stagingDir,
      backupDir,
      phase: 'committing_ready',
      encoderId: 2,
      createdAt: Date.now()
    })

    let reloadCalled = false
    const rec = await recoverPendingPluginTxns({
      intentsDir,
      verifyFn: async dir => ({ ok: true, dir, encoderId: 2, bakeRevision: 1 }),
      reloadAssetsFn: async () => {
        reloadCalled = true
        return { success: true, activeStatus: 'ok' }
      }
    })

    expect(rec.healedReadyCount).toBe(1)
    expect(reloadCalled).toBe(true)
    expect(fs.existsSync(path.join(destDir, 'vocab_v.bin'))).toBe(false)
    const marker = readReadyMarkerSync(destDir)
    expect(marker?.visualVocab?.encoderId).toBe(2)
    expect(marker?.visualVocab?.pluginVersion).toBe(
      BUILTIN_PLUGIN_CATALOG_META['chinese-clip'].visualVocabMeta?.version
    )
    expect(fs.existsSync(backupDir)).toBe(false)
  })

  it('非视觉插件（bekko-a8m）省略 .ready.json.visualVocab 仍向后兼容', async () => {
    const bekkoDir = path.join(tmpRoot, '_shared', 'emb-a70ec85a')
    fs.mkdirSync(bekkoDir, { recursive: true })
    fs.writeFileSync(path.join(bekkoDir, 'model.onnx'), Buffer.from('bekko-onnx'))

    const payload = await writePluginReadyMarkerWithVisualVocab(bekkoDir, {
      resourceId: 'bekko-a8m',
      sharedSubDir: 'emb-a70ec85a'
    })
    expect(payload.visualVocab).toBeUndefined()
    expect(readReadyMarkerSync(bekkoDir)?.visualVocab).toBeUndefined()
  })

  it('启动探活遇到 stale / missing 不调用 stop()（纯文本不连坐），perceive 全非 2xx 均抛 OmniPerceptionHttpError', async () => {
    const svc = OmniService.getInstance()
    const stopSpy = vi.spyOn(svc, 'stop').mockResolvedValue(undefined)
    const reconcileSpy = vi
      .spyOn(svc as any, 'triggerStartupVisualReconcile')
      .mockResolvedValue(undefined)

    svc.handleStartupVisualVocabStatus({
      visualVocabStatus: 'stale',
      visualVocab: { activeStatus: 'stale', activeEncoderId: 2 }
    })
    expect(stopSpy).not.toHaveBeenCalled()
    expect(reconcileSpy).toHaveBeenCalledWith(2)
    expect(svc.isVisualTaggerAvailable()).toBe(false)

    svc.handleStartupVisualVocabStatus({
      visualVocabStatus: 'missing',
      visualVocab: { activeStatus: 'missing', activeEncoderId: 2 }
    })
    expect(stopSpy).not.toHaveBeenCalled()
    expect(svc.isVisualTaggerAvailable()).toBe(false)

    vi.spyOn(svc as any, 'omniFetch').mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          error: {
            code: 'ENGINE_NOT_READY',
            reason: 'visual_vocab_stale',
            encoder_id: 2,
            message: 'visual vocab stale'
          }
        })
    })
    await expect(svc.perceive('C:/tmp/a.png')).rejects.toMatchObject({
      name: 'OmniPerceptionHttpError',
      status: 409,
      code: 'ENGINE_NOT_READY',
      reason: 'visual_vocab_stale',
      encoderId: 2
    })

    vi.spyOn(svc as any, 'omniFetch').mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          error: { code: 'INPUT_REJECTED', message: 'corrupt image' }
        })
    })
    await expect(svc.perceive('C:/tmp/bad.png')).rejects.toBeInstanceOf(OmniPerceptionHttpError)

    // 校验 Rust pipeline_error_response 对 500 ASSET_MISSING 与 409 app_update_needed 的结构化穿透
    vi.spyOn(svc as any, 'omniFetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({
          error: {
            code: 'ASSET_MISSING',
            reason: 'ASSET_MISSING',
            message: 'ASSET_MISSING: encoder_id=2',
            encoder_id: 2
          },
          code: 'ASSET_MISSING',
          reason: 'ASSET_MISSING'
        })
    })
    try {
      await svc.perceive('C:/tmp/miss.png')
      expect.unreachable('should throw 500')
    } catch (e) {
      expect(classifyVisualPerceptionError(e)).toMatchObject({
        kind: 'asset_failure_500',
        failureCode: 'ASSET_MISSING',
        countsForBreaker: true,
        encoderId: 2
      })
    }

    vi.spyOn(svc as any, 'omniFetch').mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          error: {
            code: 'ENGINE_NOT_READY',
            reason: 'app_update_needed',
            message: 'VISUAL_VOCAB_STALE: app_update_needed',
            encoder_id: 3
          },
          code: 'ENGINE_NOT_READY',
          reason: 'app_update_needed'
        })
    })
    try {
      await svc.perceive('C:/tmp/v3.png')
      expect.unreachable('should throw 409')
    } catch (e) {
      expect(classifyVisualPerceptionError(e)).toMatchObject({
        kind: 'reconcile_409',
        failureCode: 'needs_app_update',
        reason: 'app_update_needed',
        encoderId: 3
      })
    }
  })

  it('R2 fixes: embeddinggemma-2-onnx 未发布 visualVocabMeta 时不受视觉事务门禁阻塞；reloadVisualAssets 隔离 inactive 槽并唤醒协调器；reconcile fail-closed', async () => {
    const { isVisualVocabPluginResource } = await import('../visual-vocab-txn')
    expect(isVisualVocabPluginResource('embeddinggemma-2-onnx')).toBe(false)
    expect(isVisualVocabPluginResource('chinese-clip')).toBe(true)
    expect(isVisualVocabPluginResource('mobile-clip')).toBe(true)

    const { OmniService } = await import('../omni-service/omni-service')
    const { visualTaggerCoordinator } = await import('../../analysis-queue-service/visual-tagger-coordinator')
    visualTaggerCoordinator.recordAssetFailureForBreaker(2, 0)
    visualTaggerCoordinator.recordAssetFailureForBreaker(2, 0)
    visualTaggerCoordinator.recordAssetFailureForBreaker(2, 0)
    expect(visualTaggerCoordinator.isVisualBreakerTripped()).toBe(true)

    const svc = new OmniService()
    vi.spyOn(svc as any, 'omniFetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        assets: {
          tagger: {
            status: 'ok',
            activeStatus: 'ok',
            activeEncoderId: 2,
            byEncoder: {
              '2': { encoderId: 2, status: 'ok' },
              '3': { encoderId: 3, status: 'missing', code: 'ASSET_MISSING' },
              '4': { encoderId: 4, status: 'missing', code: 'ASSET_MISSING' }
            }
          }
        }
      })
    })
    const reloadRes = await svc.reloadVisualAssets()
    expect(reloadRes.success).toBe(true)
    expect(reloadRes.activeStatus).toBe('ok')
    expect((svc as any).visualTaggerAvailable).toBe(true)

    const { ModularResourceService } = await import('../modular-resource-service-core')
    const clipDir = path.join(tmpRoot, 'reconcile-no-cli')
    fs.mkdirSync(clipDir, { recursive: true })
    const core = new (ModularResourceService as any)()
    vi.spyOn(core, 'withSlotMutex').mockImplementation(async (_id: string, fn: any) => fn())
    vi.spyOn(core, 'getDao').mockReturnValue({
      resources: { findByIdSync: () => ({ target_local_path: clipDir }) }
    })
    vi.spyOn(core, 'resolvePhysicalPath').mockReturnValue(clipDir)
    vi.spyOn(core, 'resolveDefaultVerifyVisualVocabFn').mockReturnValue(undefined)
    const rec = await core.reconcileVisualVocabResource('chinese-clip')
    expect(rec.ok).toBe(false)
    expect(fs.existsSync(path.join(clipDir, '.ready.json'))).toBe(false)

    // R3 [H-4]: commitPluginDirectoryWithTxn 与 recoverPendingPluginTxns 在无 verifyFn 时必须 fail-closed 回滚
    const { commitPluginDirectoryWithTxn, buildReadyVisualVocabMeta } = await import('../visual-vocab-txn')
    const txnIntents = path.join(tmpRoot, '.intents-no-cli')
    const txnDest = path.join(tmpRoot, '_shared', 'emb-r3-dest')
    const txnStaged = path.join(tmpRoot, '_staging', 'emb-r3-staged')
    writeDummyClipFiles(txnDest)
    writeDummyClipFiles(txnStaged)
    const noCliCommit = await commitPluginDirectoryWithTxn({
      intentsDir: txnIntents,
      resourceId: 'chinese-clip',
      sharedSubDir: 'emb-r3-dest',
      stagingDir: txnStaged,
      destDir: txnDest,
      targetMode: 'install',
      verifyFn: undefined
    })
    expect(noCliCommit.ok).toBe(false)
    expect(fs.existsSync(path.join(txnDest, '.ready.json'))).toBe(false)

    const recIntents = path.join(tmpRoot, '.intents-rec-no-cli')
    const recDest = path.join(tmpRoot, '_shared', 'emb-r3-rec')
    const recBak = `${recDest}.bak-r3`
    writeDummyClipFiles(recDest)
    writeDummyClipFiles(recBak)
    writeVisualTxnRecordSync(recIntents, {
      version: 1,
      resourceId: 'chinese-clip',
      sharedSubDir: 'emb-r3-rec',
      destDir: recDest,
      stagingDir: path.join(tmpRoot, '_staging', 'gone'),
      backupDir: recBak,
      phase: 'committing_ready',
      encoderId: 2,
      createdAt: Date.now()
    })
    const recNoCli = await recoverPendingPluginTxns({ intentsDir: recIntents, verifyFn: undefined })
    expect(recNoCli.healedReadyCount).toBe(0)
    expect(recNoCli.rolledBackCount).toBe(1)

    // R3 [H-3]: Gemma 实盘含 vocab_v.* 且 CLI 通过时，buildReadyVisualVocabMeta 可写出真实指纹（不再是死代码）
    const gemmaDir = path.join(tmpRoot, '_shared', 'emb-gemma-test')
    writeDummyClipFiles(gemmaDir)
    const gemmaMeta = buildReadyVisualVocabMeta('embeddinggemma-2-onnx', gemmaDir, {
      ok: true,
      dir: gemmaDir,
      encoderId: 4,
      bakeRevision: 3
    })
    expect(gemmaMeta?.encoderId).toBe(4)
    expect(gemmaMeta?.bakeRevision).toBe(3)
    expect(gemmaMeta?.matrixSha256).toHaveLength(64)
  })
})
