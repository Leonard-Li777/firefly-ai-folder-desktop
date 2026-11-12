import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
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
})
