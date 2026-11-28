// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import Database from 'better-sqlite3'
import JSZip from 'jszip'

const { execFileMockState } = vi.hoisted(() => ({
  execFileMockState: {
    handler: null as null | ((dir: string, encoderId?: string) => Record<string, any>)
  }
}))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const mockedExecFile = (file: any, args: any, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback
    const opts = typeof options === 'function' ? {} : options
    if (Array.isArray(args) && args[0] === 'verify-visual-vocab' && execFileMockState.handler) {
      const encoderIdx = args.indexOf('--encoder-id')
      const encoderId = encoderIdx >= 0 ? args[encoderIdx + 1] : undefined
      const result = execFileMockState.handler(String(args[1]), encoderId)
      cb?.(null, { stdout: JSON.stringify(result), stderr: '' })
      return {} as any
    }
    return actual.execFile(file, args, opts, (err: any, stdout: any, stderr: any) =>
      cb?.(err, { stdout, stderr })
    )
  }
  return {
    ...actual,
    execFile: mockedExecFile,
    default: { ...actual, execFile: mockedExecFile }
  }
})

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const mockedExecFile = (file: any, args: any, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback
    const opts = typeof options === 'function' ? {} : options
    if (Array.isArray(args) && args[0] === 'verify-visual-vocab' && execFileMockState.handler) {
      const encoderIdx = args.indexOf('--encoder-id')
      const encoderId = encoderIdx >= 0 ? args[encoderIdx + 1] : undefined
      const result = execFileMockState.handler(String(args[1]), encoderId)
      cb?.(null, { stdout: JSON.stringify(result), stderr: '' })
      return {} as any
    }
    return actual.execFile(file, args, opts, (err: any, stdout: any, stderr: any) =>
      cb?.(err, { stdout, stderr })
    )
  }
  return {
    ...actual,
    execFile: mockedExecFile,
    default: { ...actual, execFile: mockedExecFile }
  }
})

import { PluginPathResolver, readReadyMarker, isValidReadyMarkerPayload } from '@firefly/shared'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { ModularResourceDao } from '../../database/dao/modular-resource-dao'
import {
  OfflinePackageService,
  OfflinePackageVerificationError,
  ZipSlipSecurityError,
  signManifest,
  TEST_ED25519_SK
} from '../offline-package-service'
import { computeResourceDirSha256 } from '../deterministic-hasher'
import { omniService } from '../../system/omni-service'
import * as visualVocabTxn from '../../system/visual-vocab-txn'

/**
 * 构造真实可用的全量离线总包 (.ffp) 归档文件用于端到端单元测试
 */
async function buildTestFullOfflineBundle(options: {
  outPath: string
  privateKeyPem?: string
  tamperModuleId?: string
  badTargetPathModule?: boolean
  withNestedZipResource?: boolean
  modules: Array<{
    module_id: string
    name: string
    version: string
    capability_slot: string
    slot_policy: string
    backend_type: string
    resources: Array<{
      resource_id: string
      asset_name: string
      target_local_path: string
      fileName: string
      fileContent: string
      extraFiles?: Record<string, string | Buffer>
      asZipArchive?: boolean
    }>
  }>
}): Promise<void> {
  const zip = new JSZip()
  const keyPem = options.privateKeyPem ?? TEST_ED25519_SK
  const tmpBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffp-build-'))

  try {
    const bundleModules: Array<{
      module_id: string
      version: string
      manifest_sha256: string
    }> = []

    for (const mod of options.modules) {
      const resourcesMeta: Array<{
        resource_id: string
        asset_name: string
        target_local_path: string
        expected_sha256: string
        size: number
      }> = []

      for (const res of mod.resources) {
        if (res.asZipArchive) {
          const innerZip = new JSZip()
          innerZip.file(res.fileName, res.fileContent)
          if (res.extraFiles) {
            for (const [extraName, extraData] of Object.entries(res.extraFiles)) {
              innerZip.file(extraName, extraData)
            }
          }
          const zipBuf = await innerZip.generateAsync({ type: 'nodebuffer' })
          const zipPathInArchive = `modules/${mod.module_id}/assets/${res.asset_name}`
          zip.file(zipPathInArchive, zipBuf)

          const sha256 = crypto.createHash('sha256').update(zipBuf).digest('hex')
          resourcesMeta.push({
            resource_id: res.resource_id,
            asset_name: res.asset_name,
            target_local_path: options.badTargetPathModule
              ? '../../evil-escape/payload.bin'
              : res.target_local_path,
            expected_sha256: sha256,
            size: zipBuf.length
          })
        } else {
          const resDir = path.join(tmpBuildDir, mod.module_id, res.resource_id)
          fs.mkdirSync(resDir, { recursive: true })
          const filePath = path.join(resDir, res.fileName)
          fs.writeFileSync(filePath, res.fileContent, 'utf-8')
          const dirSha256 = await computeResourceDirSha256(resDir, res.resource_id)

          zip.file(
            `modules/${mod.module_id}/assets/${res.asset_name}/${res.fileName}`,
            res.fileContent
          )
          resourcesMeta.push({
            resource_id: res.resource_id,
            asset_name: res.asset_name,
            target_local_path: options.badTargetPathModule
              ? '../../evil-escape/payload.bin'
              : res.target_local_path,
            expected_sha256: dirSha256,
            size: Buffer.byteLength(res.fileContent, 'utf-8')
          })
        }
      }

      const manifestObj = {
        version: 1,
        created_at: new Date().toISOString(),
        module: {
          module_id: mod.module_id,
          name: mod.name,
          version: mod.version,
          capability_slot: mod.capability_slot,
          slot_policy: mod.slot_policy,
          backend_type: mod.backend_type
        },
        resources: resourcesMeta
      }

      const manifestStr = JSON.stringify(manifestObj, null, 2)
      const sigHex = signManifest(manifestStr, keyPem)

      // 篡改签名后的 manifest 以模拟攻击或损坏
      const writtenManifestStr =
        options.tamperModuleId === mod.module_id
          ? manifestStr.replace(mod.name, `${mod.name} [TAMPERED]`)
          : manifestStr

      const manifestSha256 = crypto
        .createHash('sha256')
        .update(writtenManifestStr, 'utf-8')
        .digest('hex')

      zip.file(`modules/${mod.module_id}/manifest.json`, writtenManifestStr)
      zip.file(`modules/${mod.module_id}/manifest.sig`, sigHex)

      bundleModules.push({
        module_id: mod.module_id,
        version: mod.version,
        manifest_sha256: manifestSha256
      })
    }

    const bundleManifest = {
      format_version: 1,
      bundle_type: 'full_offline_bundle',
      signature_profile: 'official-root-v1',
      created_at: new Date().toISOString(),
      producer_app_version: '4.0.0-test',
      modules: bundleModules
    }

    zip.file('bundle.manifest.json', JSON.stringify(bundleManifest, null, 2))
    const outBuf = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(options.outPath, outBuf)
  } finally {
    fs.rmSync(tmpBuildDir, { recursive: true, force: true })
  }
}

describe('OfflinePackageService (全量离线总包导入测试)', () => {
  let tmpDir: string
  let pluginsRoot: string
  let testDb: Database.Database
  let dao: ModularResourceDao
  let testPublicKeyPem: string
  let testPrivateKeyPem: string
  let notifySpy: ReturnType<typeof vi.fn>
  let fakeService: any

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-bundle-test-'))
    pluginsRoot = path.join(tmpDir, 'plugins')
    fs.mkdirSync(pluginsRoot, { recursive: true })

    PluginPathResolver.resetForTesting()
    PluginPathResolver.initialize(pluginsRoot)

    testDb = new Database(':memory:')
    testDb.exec(GENESIS_V1_SCHEMA)
    dao = new ModularResourceDao(testDb)

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    testPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    testPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

    notifySpy = vi.fn().mockResolvedValue(undefined)
    fakeService = {
      getDb: () => testDb,
      getDao: () => dao,
      getPluginsRootDir: () => pluginsRoot,
      getBaseDir: () => pluginsRoot,
      resolvePhysicalPath: (relPath: string) =>
        PluginPathResolver.resolvePhysicalPathForRoot(pluginsRoot, relPath),
      getModule: (moduleId: string) => {
        const mod = dao.modules.findByIdSync(moduleId)
        if (!mod) return null
        return {
          ...mod,
          state: mod.install_state
        }
      },
      notifyRuntimePluginTopologyChanged: notifySpy
    }
  })

  afterEach(() => {
    execFileMockState.handler = null
    vi.restoreAllMocks()
    try {
      testDb.close()
    } catch {}
    PluginPathResolver.resetForTesting()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('成功导入包含双基础引擎与可选插件的离线总包，写入 .ready.json 且严格激活 preferredEngineId 避免双活冲突', async () => {
    const bundlePath = path.join(tmpDir, 'firefly-full-bundle.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'engine_gemma_unified',
          name: '全能多模态引擎 (Gemma)',
          version: '1.0.0',
          capability_slot: 'base_embedding',
          slot_policy: 'exclusive_required',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'embeddinggemma-300m',
              asset_name: 'embeddinggemma-300m',
              target_local_path: 'models/embeddinggemma-300m',
              fileName: 'model.onnx',
              fileContent: 'dummy-gemma-onnx-weights'
            }
          ]
        },
        {
          module_id: 'engine_classic_light',
          name: '极速轻巧引擎 (Classic)',
          version: '1.0.0',
          capability_slot: 'base_embedding',
          slot_policy: 'exclusive_required',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'mobile-clip-s2',
              asset_name: 'mobile-clip-s2.zip',
              target_local_path: 'models/mobile-clip-s2',
              fileName: 'clip.onnx',
              fileContent: 'dummy-classic-clip-weights',
              asZipArchive: true
            }
          ]
        },
        {
          module_id: 'perception_nsfw',
          name: '私密与敏感照片识别',
          version: '1.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'nsfw-mobilenetv2',
              asset_name: 'nsfw-mobilenetv2',
              target_local_path: 'models/nsfw-mobilenetv2',
              fileName: 'nsfw.onnx',
              fileContent: 'dummy-nsfw-weights'
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    const primary = await pkgService.importOfflinePackage(bundlePath, {
      rootPublicKey: testPublicKeyPem,
      preferredEngineId: 'engine_classic_light'
    })

    // 返回被激活的 preferredEngineId
    expect(primary.id).toBe('engine_classic_light')
    expect(dao.modules.findByIdSync('engine_classic_light')?.install_state).toBe('active')
    expect(dao.modules.findByIdSync('engine_gemma_unified')?.install_state).toBe(
      'installed_inactive'
    )
    expect(dao.modules.findByIdSync('perception_nsfw')?.install_state).toBe('installed_inactive')

    // .zip 资源已解压至目标目录，目录资源均生成 .ready.json
    const classicDir = path.join(pluginsRoot, 'models', 'mobile-clip-s2')
    const gemmaDir = path.join(pluginsRoot, 'models', 'embeddinggemma-300m')
    expect(fs.existsSync(path.join(classicDir, 'clip.onnx'))).toBe(true)
    expect(fs.existsSync(path.join(gemmaDir, 'model.onnx'))).toBe(true)

    const classicReady = await readReadyMarker(classicDir)
    const gemmaReady = await readReadyMarker(gemmaDir)
    expect(isValidReadyMarkerPayload(classicReady)).toBe(true)
    expect(isValidReadyMarkerPayload(gemmaReady)).toBe(true)

    // 资源表与 topology 通知完整落库
    expect(dao.resources.findByIdSync('mobile-clip-s2')?.download_state).toBe('completed')
    expect(dao.resources.findByIdSync('embeddinggemma-300m')?.download_state).toBe('completed')
    expect(dao.resources.findByIdSync('nsfw-mobilenetv2')?.download_state).toBe('completed')
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('Sign-Then-Extract：离线总包内任一模块签名被篡改时直接阻断，禁止写盘或写入数据库', async () => {
    const bundlePath = path.join(tmpDir, 'tampered-bundle.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      tamperModuleId: 'engine_gemma_unified',
      modules: [
        {
          module_id: 'engine_gemma_unified',
          name: '全能多模态引擎 (Gemma)',
          version: '1.0.0',
          capability_slot: 'base_embedding',
          slot_policy: 'exclusive_required',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'embeddinggemma-300m',
              asset_name: 'embeddinggemma-300m',
              target_local_path: 'models/embeddinggemma-300m',
              fileName: 'model.onnx',
              fileContent: 'tampered-payload'
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    await expect(
      pkgService.importOfflinePackage(bundlePath, {
        rootPublicKey: testPublicKeyPem
      })
    ).rejects.toThrow(OfflinePackageVerificationError)

    expect(fs.existsSync(path.join(pluginsRoot, 'models', 'embeddinggemma-300m'))).toBe(false)
    expect(dao.modules.findByIdSync('engine_gemma_unified')).toBeNull()
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('Zip-Slip 防御：manifest 声明越权 target_local_path 时抛出 ZipSlipSecurityError 并拒绝落盘', async () => {
    const bundlePath = path.join(tmpDir, 'zipslip-bundle.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      badTargetPathModule: true,
      modules: [
        {
          module_id: 'engine_gemma_unified',
          name: '全能多模态引擎 (Gemma)',
          version: '1.0.0',
          capability_slot: 'base_embedding',
          slot_policy: 'exclusive_required',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'embeddinggemma-300m',
              asset_name: 'embeddinggemma-300m',
              target_local_path: 'models/embeddinggemma-300m',
              fileName: 'model.onnx',
              fileContent: 'evil-payload'
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    await expect(
      pkgService.importOfflinePackage(bundlePath, {
        rootPublicKey: testPublicKeyPem
      })
    ).rejects.toThrow(ZipSlipSecurityError)

    expect(dao.modules.findByIdSync('engine_gemma_unified')).toBeNull()
  })

  it('视觉插件缺失 vocab_v.meta.json 时在暂存区拦截，绝不破坏既有可用目录并输出大白话提示', async () => {
    const existingTargetDir = fakeService.resolvePhysicalPath('modules/_shared/emb-a42b0c8f')
    fs.mkdirSync(existingTargetDir, { recursive: true })
    const sentinelFile = path.join(existingTargetDir, 'existing-valid-sentinel.txt')
    fs.writeFileSync(sentinelFile, 'existing-valid-payload', 'utf-8')
    const existingReadyPath = path.join(existingTargetDir, '.ready.json')
    fs.writeFileSync(existingReadyPath, JSON.stringify({ version: 1, digest: 'keep-me' }), 'utf-8')

    const fakeExe = path.join(tmpDir, 'firefly-omni.exe')
    fs.writeFileSync(fakeExe, 'stub-binary', 'utf-8')
    vi.spyOn(omniService, 'resolveOmniExecutable').mockReturnValue(fakeExe)

    execFileMockState.handler = dir => {
      // 必须发生在 .staging-* 暂存目录，绝不能是正式目录
      expect(path.basename(dir)).toContain('.staging-')
      expect(dir).not.toBe(existingTargetDir)
      return {
        ok: false,
        dir,
        status: 'missing',
        code: 'ASSET_MISSING',
        error: `ASSET_MISSING: tagger（${path.join(dir, 'vocab_v.meta.json')} 缺失）`
      }
    }

    const bundlePath = path.join(tmpDir, 'outdated-clip-v5.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'clip_visual_tagger',
          name: '轻量图片语义搜索',
          version: '5.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'chinese-clip',
              asset_name: 'chinese-clip-int8-v5.zip',
              target_local_path: 'modules/_shared/emb-a42b0c8f',
              fileName: 'chinese-clip-vit-b-16-int8.onnx',
              fileContent: 'v5-without-vocab-meta',
              asZipArchive: true
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    let caughtError: Error | undefined
    try {
      await pkgService.importOfflinePackage(bundlePath, {
        rootPublicKey: testPublicKeyPem
      })
    } catch (err: any) {
      caughtError = err
    }

    expect(caughtError).toBeDefined()
    const msg = caughtError!.message
    expect(msg).toContain('离线包')
    expect(msg).toContain('词表文件')
    // 禁止向 UI 泄漏底层工程/算法术语
    expect(msg).not.toMatch(/CLI|ASSET_MISSING|tagger|vocab_v\.meta\.json|ONNX/i)

    // 既有可用目录与 .ready.json 100% 完好无损
    expect(fs.existsSync(sentinelFile)).toBe(true)
    expect(fs.readFileSync(sentinelFile, 'utf-8')).toBe('existing-valid-payload')
    expect(JSON.parse(fs.readFileSync(existingReadyPath, 'utf-8'))).toMatchObject({
      digest: 'keep-me'
    })

    // 确认无残留 .staging-* 或 .backup-* 临时目录
    const sharedEntries = fs.readdirSync(path.join(pluginsRoot, '_shared'))
    expect(
      sharedEntries.some(name => name.startsWith('.staging-') || name.startsWith('.backup-'))
    ).toBe(false)
    expect(dao.modules.findByIdSync('clip_visual_tagger')).toBeNull()
  })

  it('切换或写入 .ready.json 异常时自动从备份回滚恢复既有目录并清理临时目录', async () => {
    const existingTargetDir = path.join(pluginsRoot, 'models', 'embeddinggemma-300m')
    fs.mkdirSync(existingTargetDir, { recursive: true })
    fs.writeFileSync(path.join(existingTargetDir, 'old-model.onnx'), 'original-weights', 'utf-8')

    vi.spyOn(visualVocabTxn, 'writePluginReadyMarkerWithVisualVocab').mockRejectedValueOnce(
      new Error('模拟磁盘写入失败')
    )

    const bundlePath = path.join(tmpDir, 'rollback-test.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'engine_gemma_unified',
          name: '全能多模态引擎',
          version: '2.0.0',
          capability_slot: 'base_embedding',
          slot_policy: 'exclusive_required',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'embeddinggemma-300m',
              asset_name: 'embeddinggemma-300m',
              target_local_path: 'models/embeddinggemma-300m',
              fileName: 'new-model.onnx',
              fileContent: 'new-weights'
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    await expect(
      pkgService.importOfflinePackage(bundlePath, {
        rootPublicKey: testPublicKeyPem
      })
    ).rejects.toThrow('模拟磁盘写入失败')

    // 原目录与文件已完整恢复，新文件未残留
    expect(fs.existsSync(path.join(existingTargetDir, 'old-model.onnx'))).toBe(true)
    expect(fs.readFileSync(path.join(existingTargetDir, 'old-model.onnx'), 'utf-8')).toBe(
      'original-weights'
    )
    expect(fs.existsSync(path.join(existingTargetDir, 'new-model.onnx'))).toBe(false)

    const modelsEntries = fs.readdirSync(path.join(pluginsRoot, 'models'))
    expect(
      modelsEntries.some(name => name.startsWith('.staging-') || name.startsWith('.backup-'))
    ).toBe(false)
  })

  it('合法视觉离线包通过前置校验后原子切换并写入 .ready.json.visualVocab 契约块', async () => {
    const fakeExe = path.join(tmpDir, 'firefly-omni.exe')
    fs.writeFileSync(fakeExe, 'stub-binary', 'utf-8')
    vi.spyOn(omniService, 'resolveOmniExecutable').mockReturnValue(fakeExe)

    execFileMockState.handler = dir => ({
      ok: true,
      dir,
      encoderId: 2,
      encoderDigest: 'digest-clip-v6',
      embeddingSpaceId: 'chinese-clip-v6',
      bakeRevision: 6,
      version: '2.0.0',
      entryCount: 4096
    })

    const bundlePath = path.join(tmpDir, 'valid-clip-v6.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'clip_visual_tagger',
          name: '轻量图片语义搜索',
          version: '6.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'chinese-clip',
              asset_name: 'chinese-clip-int8-v6.zip',
              target_local_path: 'modules/_shared/emb-a42b0c8f',
              fileName: 'chinese-clip-vit-b-16-int8.onnx',
              fileContent: 'v6-complete-weights',
              extraFiles: {
                'vocab_v.f16': Buffer.alloc(16, 2),
                'vocab_v.meta.json': JSON.stringify({ version: '2.0.0', bake_revision: 6 })
              },
              asZipArchive: true
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    await pkgService.importOfflinePackage(bundlePath, {
      rootPublicKey: testPublicKeyPem
    })

    const targetDir = fakeService.resolvePhysicalPath('modules/_shared/emb-a42b0c8f')
    expect(fs.existsSync(path.join(targetDir, 'chinese-clip-vit-b-16-int8.onnx'))).toBe(true)
    const readyMarker = await readReadyMarker(targetDir)
    expect(isValidReadyMarkerPayload(readyMarker)).toBe(true)
    expect(readyMarker?.visualVocab?.bakeRevision).toBe(6)
    expect(readyMarker?.visualVocab?.encoderId).toBe(2)
    expect(readyMarker?.visualVocab?.matrixSha256).toHaveLength(64)
    expect(readyMarker?.visualVocab?.metaSha256).toHaveLength(64)
  })

  it('多模块总包在模块 2 视觉校验失败时全包零破坏：模块 1 既有资产与清单均不被覆盖', async () => {
    const existingGemmaDir = fakeService.resolvePhysicalPath('models/embeddinggemma-300m')
    fs.mkdirSync(existingGemmaDir, { recursive: true })
    fs.writeFileSync(path.join(existingGemmaDir, 'model.onnx'), 'original-gemma-v1', 'utf-8')

    const existingManifestDir = PluginPathResolver.getModuleManifestDirForRoot(
      pluginsRoot,
      'engine_gemma_unified'
    )
    fs.mkdirSync(existingManifestDir, { recursive: true })
    fs.writeFileSync(
      path.join(existingManifestDir, 'manifest.json'),
      JSON.stringify({ module: { module_id: 'engine_gemma_unified', version: '1.0.0' } }),
      'utf-8'
    )

    const existingClipDir = fakeService.resolvePhysicalPath('modules/_shared/emb-a42b0c8f')
    fs.mkdirSync(existingClipDir, { recursive: true })
    fs.writeFileSync(path.join(existingClipDir, 'clip.onnx'), 'original-clip-ok', 'utf-8')

    const fakeExe = path.join(tmpDir, 'firefly-omni.exe')
    fs.writeFileSync(fakeExe, 'stub-binary', 'utf-8')
    vi.spyOn(omniService, 'resolveOmniExecutable').mockReturnValue(fakeExe)

    execFileMockState.handler = dir => ({
      ok: false,
      dir,
      status: 'missing',
      code: 'ASSET_MISSING',
      error: 'ASSET_MISSING: tagger (vocab_v.meta.json missing)'
    })

    const bundlePath = path.join(tmpDir, 'multi-module-partial-fail.ffp')
    await buildTestFullOfflineBundle({
      outPath: bundlePath,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'engine_gemma_unified',
          name: '全能多模态引擎',
          version: '2.0.0',
          capability_slot: 'base_embedding',
          slot_policy: 'exclusive_required',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'embeddinggemma-300m',
              asset_name: 'embeddinggemma-300m',
              target_local_path: 'models/embeddinggemma-300m',
              fileName: 'model.onnx',
              fileContent: 'new-gemma-v2-should-never-land'
            }
          ]
        },
        {
          module_id: 'clip_visual_tagger',
          name: '轻量图片语义搜索',
          version: '5.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'omni_onnx',
          resources: [
            {
              resource_id: 'chinese-clip',
              asset_name: 'chinese-clip-int8-v5.zip',
              target_local_path: 'modules/_shared/emb-a42b0c8f',
              fileName: 'chinese-clip-vit-b-16-int8.onnx',
              fileContent: 'v5-without-vocab',
              asZipArchive: true
            }
          ]
        }
      ]
    })

    const pkgService = new OfflinePackageService(fakeService)
    await expect(
      pkgService.importOfflinePackage(bundlePath, {
        rootPublicKey: testPublicKeyPem
      })
    ).rejects.toThrow(/词表文件/)

    // 关键：模块 1 既有资产与原有 manifest、模块 2 既有资产 100% 未被覆盖
    expect(fs.readFileSync(path.join(existingGemmaDir, 'model.onnx'), 'utf-8')).toBe(
      'original-gemma-v1'
    )
    expect(
      JSON.parse(fs.readFileSync(path.join(existingManifestDir, 'manifest.json'), 'utf-8')).module
        .version
    ).toBe('1.0.0')
    expect(fs.readFileSync(path.join(existingClipDir, 'clip.onnx'), 'utf-8')).toBe(
      'original-clip-ok'
    )
    expect(dao.modules.findByIdSync('engine_gemma_unified')).toBeNull()
    expect(dao.modules.findByIdSync('clip_visual_tagger')).toBeNull()
    expect(
      fs
        .readdirSync(path.join(pluginsRoot, 'models'))
        .some(n => n.startsWith('.staging-') || n.startsWith('.backup-'))
    ).toBe(false)
  })

  it('打包环境缺少校验程序与视觉插件非目录异常均 fail-closed 并返回零术语大白话', async () => {
    const validStageDir = path.join(tmpDir, 'staged-clip')
    fs.mkdirSync(validStageDir, { recursive: true })

    await expect(
      visualVocabTxn.verifyStagedVisualVocabDir({
        dirPath: validStageDir,
        resourceId: 'chinese-clip',
        callerTag: 'Test',
        exePath: null,
        isPackaged: true
      })
    ).rejects.toThrow('当前软件缺少本地校验组件')

    // 若已注册视觉插件以普通单文件形式存在，也必须 fail-closed 拦截
    const singleFilePath = path.join(tmpDir, 'bad-clip.onnx')
    fs.writeFileSync(singleFilePath, 'not-a-directory')
    let fileErr: Error | undefined
    try {
      await visualVocabTxn.verifyStagedVisualVocabDir({
        dirPath: singleFilePath,
        resourceId: 'chinese-clip',
        callerTag: 'Test',
        exePath: null,
        isPackaged: false
      })
    } catch (e: any) {
      fileErr = e
    }
    expect(fileErr).toBeDefined()
    expect(fileErr!.message).toContain('词表文件')
    expect(fileErr!.message).not.toMatch(/CLI|ASSET_MISSING|tagger|vocab_v/i)
  })

  it('单文件资产覆盖时先备份再切换，若 DB 提交失败则逆序回滚单文件与清单', async () => {
    const existingFile = fakeService.resolvePhysicalPath('models/single-weight.bin')
    fs.mkdirSync(path.dirname(existingFile), { recursive: true })
    fs.writeFileSync(existingFile, 'old-single-file-content', 'utf-8')

    // 模拟数据库提交抛错，验证单文件物理资产与清单逆序回滚
    const originalDb = testDb
    const brokenService = {
      ...fakeService,
      getDb: () => ({
        transaction: () => () => {
          throw new Error('模拟数据库事务提交失败')
        }
      }),
      getDao: () => fakeService.getDao()
    }

    const bundlePath = path.join(tmpDir, 'single-file-rollback.ffp')
    const zip = new JSZip()
    const payload = Buffer.from('new-single-file-content', 'utf-8')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    zip.file('modules/single_mod/assets/single-weight.bin', payload)
    const modManifest = JSON.stringify(
      {
        version: 1,
        created_at: new Date().toISOString(),
        module: {
          module_id: 'single_mod',
          name: '单文件测试模块',
          version: '1.1.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'builtin'
        },
        resources: [
          {
            resource_id: 'single-weight-res',
            asset_name: 'single-weight.bin',
            target_local_path: 'models/single-weight.bin',
            expected_sha256: sha,
            size: payload.length
          }
        ]
      },
      null,
      2
    )
    zip.file('modules/single_mod/manifest.json', modManifest)
    zip.file('modules/single_mod/manifest.sig', signManifest(modManifest, testPrivateKeyPem))
    zip.file(
      'bundle.manifest.json',
      JSON.stringify({
        format_version: 1,
        bundle_type: 'full_offline_bundle',
        signature_profile: 'official-root-v1',
        created_at: new Date().toISOString(),
        producer_app_version: '4.0.0-test',
        modules: [
          {
            module_id: 'single_mod',
            version: '1.1.0',
            manifest_sha256: crypto.createHash('sha256').update(modManifest, 'utf-8').digest('hex')
          }
        ]
      })
    )
    fs.writeFileSync(bundlePath, await zip.generateAsync({ type: 'nodebuffer' }))

    const pkgService = new OfflinePackageService(brokenService)
    await expect(
      pkgService.importOfflinePackage(bundlePath, {
        rootPublicKey: testPublicKeyPem
      })
    ).rejects.toThrow('模拟数据库事务提交失败')

    // 原单文件已恢复，manifest 未残留
    expect(fs.readFileSync(existingFile, 'utf-8')).toBe('old-single-file-content')
    const manifestDir = PluginPathResolver.getModuleManifestDirForRoot(pluginsRoot, 'single_mod')
    expect(fs.existsSync(path.join(manifestDir, 'manifest.json'))).toBe(false)
    expect(originalDb.prepare('SELECT id FROM builtin_modules').all()).toEqual([])
  })

  it('Phase 1 拦截跨资源同目标路径碰撞，并以整批单锁保护 Phase 2 执行无嵌套死锁', async () => {
    const existingTargetDir = fakeService.resolvePhysicalPath('models/shared-collide-dir')
    fs.mkdirSync(existingTargetDir, { recursive: true })
    fs.writeFileSync(path.join(existingTargetDir, 'keep.txt'), 'original-untouched', 'utf-8')

    const collisionBundle = path.join(tmpDir, 'path-collision.ffp')
    await buildTestFullOfflineBundle({
      outPath: collisionBundle,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'mod_a',
          name: '模块 A',
          version: '1.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'builtin',
          resources: [
            {
              resource_id: 'res_a',
              asset_name: 'res_a',
              target_local_path: 'models/shared-collide-dir',
              fileName: 'a.bin',
              fileContent: 'aaa'
            }
          ]
        },
        {
          module_id: 'mod_b',
          name: '模块 B',
          version: '1.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'builtin',
          resources: [
            {
              resource_id: 'res_b',
              asset_name: 'res_b',
              target_local_path: 'models/shared-collide-dir',
              fileName: 'b.bin',
              fileContent: 'bbb'
            }
          ]
        }
      ]
    })

    const mutexCalls: string[] = []
    const mutexService = {
      ...fakeService,
      withSlotMutex: vi.fn(async (key: string, fn: () => Promise<any>) => {
        mutexCalls.push(key)
        return await fn()
      })
    }

    const pkgService = new OfflinePackageService(mutexService)
    await expect(
      pkgService.importOfflinePackage(collisionBundle, {
        rootPublicKey: testPublicKeyPem
      })
    ).rejects.toThrow(/路径碰撞/)

    // Phase 1 拦截未触碰正式目录，也未进入 Phase 2 加锁
    expect(fs.readFileSync(path.join(existingTargetDir, 'keep.txt'), 'utf-8')).toBe(
      'original-untouched'
    )
    expect(mutexCalls).toEqual([])

    // 正常两资源包导入时，Phase 2 仅以单一 __offline_bundle_import__ 锁执行一次
    const cleanBundle = path.join(tmpDir, 'clean-batch-lock.ffp')
    await buildTestFullOfflineBundle({
      outPath: cleanBundle,
      privateKeyPem: testPrivateKeyPem,
      modules: [
        {
          module_id: 'mod_clean_1',
          name: '正常模块 1',
          version: '1.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'builtin',
          resources: [
            {
              resource_id: 'clean_res_1',
              asset_name: 'clean_res_1',
              target_local_path: 'models/clean_1',
              fileName: '1.bin',
              fileContent: '111'
            }
          ]
        },
        {
          module_id: 'mod_clean_2',
          name: '正常模块 2',
          version: '1.0.0',
          capability_slot: 'general',
          slot_policy: 'multi_active',
          backend_type: 'builtin',
          resources: [
            {
              resource_id: 'clean_res_2',
              asset_name: 'clean_res_2',
              target_local_path: 'models/clean_2',
              fileName: '2.bin',
              fileContent: '222'
            }
          ]
        }
      ]
    })

    await pkgService.importOfflinePackage(cleanBundle, { rootPublicKey: testPublicKeyPem })
    expect(mutexCalls).toEqual(['__offline_bundle_import__'])
  })
})
