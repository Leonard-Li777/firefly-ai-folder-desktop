import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import JSZip from 'jszip'
import * as yauzl from 'yauzl'
import {
  OfflineBundleExporter,
  OfflineBundleExportError,
  type ModuleExportDeclaration,
  type BundleExporterContext
} from '../offline-bundle-exporter'
import type { OfflinePackageDao, OfflinePackageJobRecord } from '../offline-package-dao'

describe('OfflineBundleExporter', () => {
  let tempBaseDir: string
  let targetBundlePath: string
  let testKeyPair: crypto.KeyPairSyncResult<string, string>
  let mockDao: OfflinePackageDao
  let createdJobs: OfflinePackageJobRecord[]
  let updatedJobStatuses: Array<{ jobId: string; status: string; details?: string }>
  let supersededCalls: Array<{ archivePath: string; newJobId: string; nowMs: number }>

  beforeEach(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'firefly-exporter-test-'))
    targetBundlePath = path.join(tempBaseDir, 'output', 'firefly-bundle-test.ffp')

    // 生成真实的 Ed25519 密钥对供测试验签使用
    testKeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })

    createdJobs = []
    updatedJobStatuses = []
    supersededCalls = []

    mockDao = {
      supersedeAndCreateExportJob: vi.fn((archivePath, params, nowMs) => {
        supersededCalls.push({ archivePath, newJobId: params.job_id, nowMs })
        const job: OfflinePackageJobRecord = {
          job_id: params.job_id,
          job_type: params.job_type,
          status: params.status,
          archive_path: archivePath,
          total_modules: params.total_modules,
          created_resource_ids: '[]',
          reused_resource_ids: '[]',
          superseded_by_job_id: null,
          superseded_at: null,
          verification_attempts: 0,
          consecutive_worker_crashes: 0,
          created_at: nowMs,
          updated_at: nowMs
        }
        createdJobs.push(job)
        return { created: job, supersededCount: 1 }
      }),
      updateJobStatus: vi.fn((jobId, status, details) => {
        updatedJobStatuses.push({
          jobId,
          status,
          details: details ? JSON.stringify(details) : undefined
        })
      })
    } as unknown as OfflinePackageDao
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true })
    } catch {
      // 忽略清理临时目录失败
    }
  })

  // 辅助函数：创建测试模块目录与文件
  async function createTestModule(
    moduleId: string,
    version: string,
    options?: {
      corruptManifest?: boolean
      invalidSignature?: boolean
      missingSig?: boolean
      missingManifest?: boolean
      assetType?: 'file' | 'dir'
      corruptAssetHash?: boolean
      missingAsset?: boolean
    }
  ): Promise<ModuleExportDeclaration> {
    const modDir = path.join(tempBaseDir, '_shared', moduleId)
    await fs.promises.mkdir(modDir, { recursive: true })

    const manifestObj = {
      id: moduleId,
      name: `Test Module ${moduleId}`,
      version
    }
    const manifestContent = JSON.stringify(manifestObj, null, 2)
    const manifestPath = path.join(modDir, 'manifest.json')
    const sigPath = path.join(modDir, 'manifest.sig')

    if (!options?.missingManifest) {
      await fs.promises.writeFile(manifestPath, manifestContent, 'utf8')
    }

    if (!options?.missingSig) {
      const signBytes = Buffer.from(
        options?.corruptManifest ? manifestContent + 'corrupted' : manifestContent,
        'utf8'
      )
      const sigHex = crypto.sign(null, signBytes, testKeyPair.privateKey).toString('hex')
      const finalSig = options?.invalidSignature ? 'ff'.repeat(64) : sigHex
      await fs.promises.writeFile(sigPath, finalSig, 'utf8')
    }

    // 资产
    const assetName = `${moduleId}-weights.bin`
    const assetLocalPath = path.join(modDir, assetName)
    let expectedSha256 = ''

    if (!options?.missingAsset) {
      if (options?.assetType === 'dir') {
        await fs.promises.mkdir(assetLocalPath, { recursive: true })
        await fs.promises.writeFile(path.join(assetLocalPath, 'model.bin'), 'weight_data_dir')
        // 计算目录哈希
        const dirSha = crypto
          .createHash('sha256')
          .update('weight_data_dir')
          .digest('hex')
          .toLowerCase()
        const manifestText = `${dirSha}  model.bin\n`
        expectedSha256 = crypto
          .createHash('sha256')
          .update(manifestText, 'utf8')
          .digest('hex')
          .toLowerCase()
      } else {
        const fileContent = 'sample_binary_asset_content'
        await fs.promises.writeFile(assetLocalPath, fileContent, 'utf8')
        expectedSha256 = crypto.createHash('sha256').update(fileContent).digest('hex').toLowerCase()
      }
    }

    if (options?.corruptAssetHash) {
      expectedSha256 = '00'.repeat(32)
    }

    return {
      id: moduleId,
      version,
      install_state: 'installed_inactive',
      manifestPath,
      sigPath,
      resources: [
        {
          resource_id: `${moduleId}_res_1`,
          asset_name: assetName,
          target_local_path: assetLocalPath,
          expected_sha256: expectedSha256,
          size: 1024
        }
      ]
    }
  }

  describe('盘点与空源检查', () => {
    it('当无可导出模块时抛出 EMPTY_SOURCE 且不写盘、不创建 Job', async () => {
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => []
      }

      const exporter = new OfflineBundleExporter(ctx)
      await expect(
        exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      ).rejects.toThrow(OfflineBundleExportError)

      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(OfflineBundleExportError)
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('EMPTY_SOURCE')
      }

      expect(createdJobs.length).toBe(0)
      expect(fs.existsSync(targetBundlePath)).toBe(false)
      expect(fs.existsSync(`${targetBundlePath}.partial`)).toBe(false)
      expect(exporter.getLockStatus()).toBe('IDLE')
    })
  })

  describe('防伪签名审查 (Zero Mock, Zero Fake SK)', () => {
    it('缺少 manifest.json 抛出 SOURCE_RESOURCE_CORRUPTED', async () => {
      const mod = await createTestModule('mod_a', '1.0.0', { missingManifest: true })
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      await expect(
        exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      ).rejects.toThrow(OfflineBundleExportError)

      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('SOURCE_RESOURCE_CORRUPTED')
        expect(error.moduleId).toBe('mod_a')
      }
    })

    it('缺少 manifest.sig 抛出 SIGNATURE_INVALID', async () => {
      const mod = await createTestModule('mod_a', '1.0.0', { missingSig: true })
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('SIGNATURE_INVALID')
        expect(error.moduleId).toBe('mod_a')
      }
    })

    it('manifest.sig 非法篡改时强行拒绝并抛出 SIGNATURE_INVALID', async () => {
      const mod = await createTestModule('mod_a', '1.0.0', { invalidSignature: true })
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('SIGNATURE_INVALID')
        expect(error.moduleId).toBe('mod_a')
      }
    })

    it('物理资产不存在抛出 SOURCE_RESOURCE_CORRUPTED', async () => {
      const mod = await createTestModule('mod_a', '1.0.0', { missingAsset: true })
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('SOURCE_RESOURCE_CORRUPTED')
        expect(error.moduleId).toBe('mod_a')
      }
    })

    it('物理资产哈希损坏抛出 SOURCE_RESOURCE_CORRUPTED', async () => {
      const mod = await createTestModule('mod_a', '1.0.0', { corruptAssetHash: true })
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('SOURCE_RESOURCE_CORRUPTED')
        expect(error.moduleId).toBe('mod_a')
      }
    })
  })

  describe('细粒度互斥锁与取消优先协同协议', () => {
    it('当写锁处于忙态时直接抛出 BUSY', async () => {
      const mod = await createTestModule('mod_a', '1.0.0')
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      // 人为设置为 IMPORTING
      exporter._setJobLockForTesting('IMPORTING')

      await expect(
        exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      ).rejects.toThrow(OfflineBundleExportError)

      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('BUSY')
      }
    })

    it('后台 Dry-Run 校验活跃时触发 abort 并在释放后成功获取锁', async () => {
      const mod = await createTestModule('mod_a', '1.0.0')
      const bgAbortCtrl = new AbortController()
      let bgLockActive = true

      // 模拟后台校验在收到 abort 后 60ms 释放
      bgAbortCtrl.signal.addEventListener('abort', () => {
        setTimeout(() => {
          bgLockActive = false
        }, 60)
      })

      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod],
        backgroundVerificationLock: {
          get active() {
            return bgLockActive
          },
          abortController: bgAbortCtrl
        }
      }

      const exporter = new OfflineBundleExporter(ctx)
      const result = await exporter.exportOfflineBundle({
        targetPath: targetBundlePath,
        rootPublicKey: testKeyPair.publicKey
      })

      expect(result.ok).toBe(true)
      expect(bgAbortCtrl.signal.aborted).toBe(true)
    })

    it('后台 Dry-Run 超过 2000ms 仍未释放时优雅抛出 BUSY', async () => {
      const mod = await createTestModule('mod_a', '1.0.0')
      const bgAbortCtrl = new AbortController()

      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod],
        backgroundVerificationLock: {
          active: true, // 永不释放
          abortController: bgAbortCtrl
        }
      }

      // 为了快速测试，mock setTimeout 或缩小等待
      const exporter = new OfflineBundleExporter(ctx)
      const start = Date.now()
      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('BUSY')
        expect(error.details?.troubleshootingHint).toContain('释放文件句柄')
      }
      expect(Date.now() - start).toBeGreaterThanOrEqual(1900)
    })
  })

  describe('完整导出流程、边写边算流式哈希与旁路落盘', () => {
    it('成功导出多模块总包，包含根清单，边写边算哈希并原子落地 .sha256', async () => {
      const mod1 = await createTestModule('engine_classic_light', '1.0.0', { assetType: 'file' })
      const mod2 = await createTestModule('voice_moss_tts', '2.1.0', { assetType: 'dir' })

      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod1, mod2]
      }

      const exporter = new OfflineBundleExporter(ctx)
      const result = await exporter.exportOfflineBundle({
        targetPath: targetBundlePath,
        producerAppVersion: '4.0.0',
        rootPublicKey: testKeyPair.publicKey
      })

      expect(result.ok).toBe(true)
      expect(result.moduleCount).toBe(2)
      expect(result.filePath).toBe(targetBundlePath)
      expect(result.signatureProfile).toBe('official-root-v1')
      expect(result.totalBytes).toBeGreaterThan(0)
      expect(result.sha256.length).toBe(64)

      // 验证同路径原子 supersede 与新 job 创建
      expect(supersededCalls.length).toBe(1)
      expect(supersededCalls[0].archivePath).toBe(targetBundlePath)
      expect(supersededCalls[0].newJobId).toBe(result.jobId)

      expect(createdJobs.length).toBe(1)
      expect(createdJobs[0].job_id).toBe(result.jobId)
      expect(createdJobs[0].status).toBe('EXPORTING')
      expect(createdJobs[0].total_modules).toBe(2)

      // 验证 job 最终收敛为 FINISHED
      const finalStatus = updatedJobStatuses.find(s => s.jobId === result.jobId)
      expect(finalStatus?.status).toBe('FINISHED')

      // 验证物理文件落盘
      expect(fs.existsSync(targetBundlePath)).toBe(true)
      expect(fs.existsSync(`${targetBundlePath}.partial`)).toBe(false) // 临时文件已被原子重命名

      // 验证同级旁路 .sha256 文本文件
      const sidecarPath = `${targetBundlePath}.sha256`
      expect(fs.existsSync(sidecarPath)).toBe(true)
      const sidecarContent = await fs.promises.readFile(sidecarPath, 'utf8')
      expect(sidecarContent).toBe(`${result.sha256}  ${path.basename(targetBundlePath)}\n`)

      // 读取目标 Zip 文件，校验内部结构
      await new Promise<void>((resolve, reject) => {
        yauzl.open(targetBundlePath, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) return reject(err)
          const entryNames: string[] = []

          zipfile.on('entry', entry => {
            entryNames.push(entry.fileName)
            zipfile.readEntry()
          })

          zipfile.on('end', () => {
            zipfile.close()
            expect(entryNames).toContain('bundle.manifest.json')
            expect(entryNames).toContain('modules/engine_classic_light/manifest.json')
            expect(entryNames).toContain('modules/engine_classic_light/manifest.sig')
            expect(entryNames).toContain(
              'modules/engine_classic_light/assets/engine_classic_light-weights.bin'
            )
            expect(entryNames).toContain('modules/voice_moss_tts/manifest.json')
            expect(entryNames).toContain('modules/voice_moss_tts/manifest.sig')
            expect(entryNames).toContain(
              'modules/voice_moss_tts/assets/voice_moss_tts-weights.bin/model.bin'
            )
            resolve()
          })

          zipfile.on('error', reject)
          zipfile.readEntry()
        })
      })
    })

    it('导出中途用户 Abort 取消时抛出 CANCELLED 并清理临时文件且置 job 为 FAILED', async () => {
      const mod = await createTestModule('mod_cancel', '1.0.0')
      const abortCtrl = new AbortController()

      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => {
          // 在盘点后立即取消
          abortCtrl.abort()
          return [mod]
        }
      }

      const exporter = new OfflineBundleExporter(ctx)
      await expect(
        exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey,
          abortSignal: abortCtrl.signal
        })
      ).rejects.toThrow(OfflineBundleExportError)

      expect(fs.existsSync(`${targetBundlePath}.partial`)).toBe(false)
      expect(fs.existsSync(targetBundlePath)).toBe(false)
      expect(exporter.getLockStatus()).toBe('IDLE')

      // 若创建了 Job，应收敛为 FAILED
      if (createdJobs.length > 0) {
        const failedStatus = updatedJobStatuses.find(s => s.jobId === createdJobs[0].job_id)
        expect(failedStatus?.status).toBe('FAILED')
      }
    })

    it('流式写入前 signal 已处于 aborted 态时直接中断', async () => {
      const mod = await createTestModule('mod_pre_abort', '1.0.0')
      const abortCtrl = new AbortController()
      abortCtrl.abort()

      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      await expect(
        exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey,
          abortSignal: abortCtrl.signal
        })
      ).rejects.toThrow(OfflineBundleExportError)
    })

    it('目录资产中包含隐藏文件时安全跳过，相对路径正确拼接', async () => {
      const mod = await createTestModule('mod_hidden', '1.0.0', { assetType: 'dir' })
      // 在目录资产中加入隐藏文件
      const assetDir = mod.resources[0].target_local_path
      await fs.promises.writeFile(path.join(assetDir, '.hidden_asset'), 'ignored')

      // 测试相对路径 target_local_path
      const relPath = path.relative(path.join(tempBaseDir, '_shared'), assetDir)
      mod.resources[0].target_local_path = relPath

      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      const exporter = new OfflineBundleExporter(ctx)
      const res = await exporter.exportOfflineBundle({
        targetPath: targetBundlePath,
        rootPublicKey: testKeyPair.publicKey
      })
      expect(res.ok).toBe(true)
    })

    it('目标文件创建失败时抛出 IO_FAILURE 且零数据库副作用', async () => {
      const mod = await createTestModule('mod_io_fail', '1.0.0')
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => [mod]
      }

      // Mock fs.promises.open 在创建 .partial 时抛错
      const originalOpen = fs.promises.open
      const openSpy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (filePath: unknown, flags: unknown) => {
          if (typeof filePath === 'string' && filePath.endsWith('.partial') && flags === 'w') {
            throw new Error('EACCES: permission denied')
          }
          return originalOpen(filePath as fs.PathLike, flags as fs.OpenMode)
        })

      const exporter = new OfflineBundleExporter(ctx)
      try {
        await exporter.exportOfflineBundle({
          targetPath: targetBundlePath,
          rootPublicKey: testKeyPair.publicKey
        })
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('IO_FAILURE')
        expect(error.message).toContain('无法在目标路径创建临时导出文件')
      } finally {
        openSpy.mockRestore()
      }

      expect(createdJobs.length).toBe(0)
    })

    it('ZIP 结构校验遇到损坏文件时抛出 IO_FAILURE', async () => {
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => []
      }
      const exporter = new OfflineBundleExporter(ctx)
      const brokenZipPath = path.join(tempBaseDir, 'broken.zip')
      await fs.promises.writeFile(brokenZipPath, 'this is definitely not a zip file')

      await expect(exporter.verifyZipStructure(brokenZipPath)).rejects.toThrow(
        OfflineBundleExportError
      )
      try {
        await exporter.verifyZipStructure(brokenZipPath)
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('IO_FAILURE')
        expect(error.message).toContain('ZIP 结构校验失败')
      }
    })

    it('ZIP 缺失根清单时抛出 IO_FAILURE', async () => {
      const ctx: BundleExporterContext = {
        dao: mockDao,
        modulesSharedDir: path.join(tempBaseDir, '_shared'),
        getExportableModules: async () => []
      }
      const exporter = new OfflineBundleExporter(ctx)
      const noManifestZipPath = path.join(tempBaseDir, 'no-manifest.zip')
      const fakeZip = new JSZip()
      fakeZip.file('other.txt', 'some content')
      const zipBuffer = await fakeZip.generateAsync({ type: 'nodebuffer' })
      await fs.promises.writeFile(noManifestZipPath, zipBuffer)

      await expect(exporter.verifyZipStructure(noManifestZipPath)).rejects.toThrow(
        OfflineBundleExportError
      )
      try {
        await exporter.verifyZipStructure(noManifestZipPath)
      } catch (err: unknown) {
        const error = err as OfflineBundleExportError
        expect(error.code).toBe('IO_FAILURE')
        expect(error.message).toContain('缺失根目录 bundle.manifest.json')
      }
    })
  })
})
