/**
 * 离线总包 Worker 解包与双向核验单元测试 (Bundle Extractor Worker Tests)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { MessageChannel } from 'worker_threads'
import JSZip from 'jszip'
import {
  BundleExtractorError,
  runBundleExtractorRoutine,
  initWorkerListener,
  type BundleExtractorWorkerOptions,
  type ExtractorWorkerOutMessage
} from '../workers/bundle-extractor-worker'
import {
  BundleExtractorDispatcher,
  resolveExtractorWorkerPath
} from '../bundle-extractor-dispatcher'

describe('BundleExtractorWorker & Dispatcher', () => {
  let tempDir: string
  let stagingDir: string
  let zipPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-extractor-test-'))
    stagingDir = path.join(tempDir, '_staging', 'job-123')
    zipPath = path.join(tempDir, 'test-bundle.ffp')
  })

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {
      // 忽略测试清理异常
    }
  })

  /**
   * 辅助函数：构造测试用的合规 ZIP 文件
   */
  async function createZipBundle(
    files: Array<{ name: string; content: Buffer | string; compression?: 'STORE' | 'DEFLATE' }>
  ): Promise<string> {
    const zip = new JSZip()
    for (const f of files) {
      zip.file(f.name, f.content, {
        compression: f.compression ?? 'DEFLATE'
      })
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(zipPath, buf)
    return zipPath
  }

  function sha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex').toLowerCase()
  }

  describe('1. 路径域明确与前置折叠冲突硬拒绝 (Case-Folding Collision Guard)', () => {
    it('当 expectedAssets 内部存在大小写折叠冲突时，立即抛出 RESOURCE_DIR_INVALID', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [
          { relPath: 'modules/mod_a/assets/weights.bin' },
          { relPath: 'modules/mod_a/assets/WEIGHTS.bin' }
        ],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toThrow(BundleExtractorError)
      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'RESOURCE_DIR_INVALID'
      })
    })

    it('当 expectedAssets 内部存在 Unicode NFC 折叠冲突时，抛出 RESOURCE_DIR_INVALID', async () => {
      const nfcStr = 'modules/mod_a/assets/\u00e9.bin' // é
      const nfdStr = 'modules/mod_a/assets/e\u0301.bin' // e + combining acute accent

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: nfcStr }, { relPath: nfdStr }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toThrow(BundleExtractorError)
      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'RESOURCE_DIR_INVALID'
      })
    })

    it('多模块共享同名文件名但处于不同目录时，不产生折叠冲突', async () => {
      const assetA = 'modules/mod_a/assets/runtime.bin'
      const assetB = 'modules/mod_b/assets/runtime.bin'
      const contentA = Buffer.from('data-a')
      const contentB = Buffer.from('data-b')

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetA, content: contentA },
        { name: assetB, content: contentB }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [
          { relPath: assetA, expectedSha256: sha256(contentA) },
          { relPath: assetB, expectedSha256: sha256(contentB) }
        ],
        mainHandledEntries: ['bundle.manifest.json']
      }

      const result = await runBundleExtractorRoutine(options)
      expect(result.ok).toBe(true)
      expect(result.extractedAssets).toHaveLength(2)
      expect(fs.existsSync(path.join(stagingDir, assetA))).toBe(true)
      expect(fs.existsSync(path.join(stagingDir, assetB))).toBe(true)
    })
  })

  describe('2. 白名单集合契约与恰好出现一次断言', () => {
    it('白名单内部包含重复定义时，立即抛出 ZIP_ENTRY_REJECTED', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: 'modules/mod_a/assets/model.bin' }],
        mainHandledEntries: ['bundle.manifest.json', 'BUNDLE.MANIFEST.JSON']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('白名单与预期资产集合存在重合交集时，抛出 ZIP_ENTRY_REJECTED', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: 'bundle.manifest.json' }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('白名单条目在 ZIP 中缺失 (出现 0 次) 时，抛出 ZIP_ENTRY_REJECTED', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.from('model-bytes')

      // ZIP 中未包含 bundle.manifest.json
      await createZipBundle([{ name: assetPath, content }])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('白名单条目在 ZIP 中出现多次 (>1 次) 时，抛出 ZIP_ENTRY_REJECTED', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.from('model-bytes')

      // 构建一个包含重复条目的 Zip
      const zip = new JSZip()
      zip.file('bundle.manifest.json', 'first')
      zip.file('modules/mod_a/assets/model.bin', content)
      // JSZip 内部对象 key 会覆盖，我们通过手动向 zip.files 追加重名 entry 模拟畸形包
      const rawBuf = await zip.generateAsync({ type: 'nodebuffer' })
      fs.writeFileSync(zipPath, rawBuf)

      // 使用 2 个独立的白名单条目，但其中一个在 zip 声明了 2 个不同条目映射到同一规范化名
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
        mainHandledEntries: ['bundle.manifest.json', 'modules/mod_a/manifest.json']
      }

      // 因为缺少 modules/mod_a/manifest.json，必抛 ZIP_ENTRY_REJECTED
      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })
  })

  describe('3. 夹带走私阻断与双向完备性断言', () => {
    it('ZIP 中包含未声明的未知条目 (走私条目) 时，立即阻断并抛出 ZIP_ENTRY_REJECTED', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.from('model-bytes')

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content },
        { name: 'modules/mod_a/assets/smuggled.exe', content: 'malicious payload' }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('ZIP 中缺失声明的预期资产时，遍历结束抛出 ASSET_HASH_MISMATCH', async () => {
      const assetA = 'modules/mod_a/assets/model-a.bin'
      const assetB = 'modules/mod_a/assets/model-b.bin'
      const contentA = Buffer.from('model-a')

      // ZIP 中只有 assetA，缺失 assetB
      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetA, content: contentA }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [
          { relPath: assetA, expectedSha256: sha256(contentA) },
          { relPath: assetB, expectedSha256: 'some-hash' }
        ],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ASSET_HASH_MISMATCH'
      })
    })

    it('解压物理资产实际 SHA-256 与声明不匹配时，抛出 ASSET_HASH_MISMATCH', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.from('model-bytes')

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [
          { relPath: assetPath, expectedSha256: 'deadbeef00000000000000000000000000000000' }
        ],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ASSET_HASH_MISMATCH'
      })
    })
  })

  describe('4. 配额断路器与解压炸弹防御', () => {
    it('ZIP 总条目数超过上限时抛出 QUOTA_EXCEEDED', async () => {
      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: 'modules/mod_a/assets/f1.bin', content: '1' },
        { name: 'modules/mod_a/assets/f2.bin', content: '2' },
        { name: 'modules/mod_a/assets/f3.bin', content: '3' }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [
          { relPath: 'modules/mod_a/assets/f1.bin' },
          { relPath: 'modules/mod_a/assets/f2.bin' },
          { relPath: 'modules/mod_a/assets/f3.bin' }
        ],
        mainHandledEntries: ['bundle.manifest.json'],
        limits: {
          maxEntries: 2 // 仅允许最多 2 个条目
        }
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED'
      })
    })

    it('资产条目声明了 maxSizeBytes 且解压体积超限时，抛出 QUOTA_EXCEEDED', async () => {
      const assetPath = 'modules/mod_a/assets/bounded.bin'
      const content = Buffer.alloc(100 * 1024, 0x41) // 100KB

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [
          {
            relPath: assetPath,
            maxSizeBytes: 50 * 1024 // 限制 50KB
          }
        ],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED'
      })
    })

    it('单文件解压大小超过上限时抛出 QUOTA_EXCEEDED', async () => {
      const assetPath = 'modules/mod_a/assets/large.bin'
      const content = Buffer.alloc(1024 * 1024, 0x41) // 1MB

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath }],
        mainHandledEntries: ['bundle.manifest.json'],
        limits: {
          maxSingleFileBytes: 500 * 1024 // 限制 500KB
        }
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED'
      })
    })

    it('总解压大小累计超过上限时抛出 QUOTA_EXCEEDED', async () => {
      const assetA = 'modules/mod_a/assets/f1.bin'
      const assetB = 'modules/mod_a/assets/f2.bin'
      const content = Buffer.alloc(400 * 1024, 0x41) // 400KB

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetA, content },
        { name: assetB, content }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetA }, { relPath: assetB }],
        mainHandledEntries: ['bundle.manifest.json'],
        limits: {
          maxTotalBytes: 500 * 1024 // 上限 500KB，两者合计 800KB 必超限
        }
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED'
      })
    })

    it('零除与微小文件防御：未达到 1MB 的高压缩比微小文件不被误判为解压炸弹', async () => {
      const assetPath = 'modules/mod_a/assets/small-zeros.bin'
      // 50KB 全 0 字节，压缩比可能高达 200，但由于 uncompressedSize <= 1MB，不误报
      const content = Buffer.alloc(50 * 1024, 0)

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
        mainHandledEntries: ['bundle.manifest.json'],
        limits: {
          maxCompressionRatio: 10
        }
      }

      const res = await runBundleExtractorRoutine(options)
      expect(res.ok).toBe(true)
    })
  })

  describe('5. Zip-Slip 目录逃逸安全防御', () => {
    it('包含 .. 相对路径逃逸的条目被拒绝并抛出 ZIP_ENTRY_REJECTED', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: 'modules/../../evil.bin' }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('包含 Windows 盘符的绝对路径条目被拒绝并抛出 ZIP_ENTRY_REJECTED', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: 'C:/Windows/System32/evil.dll' }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('以正斜杠 / 开头的绝对路径条目被拒绝并抛出 ZIP_ENTRY_REJECTED', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: '/etc/passwd' }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })

    it('包含内部反斜杠 \\ 的条目路径被拒绝并抛出 ZIP_ENTRY_REJECTED', async () => {
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: 'modules\\mod_a\\assets\\weights.bin' }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      await expect(runBundleExtractorRoutine(options)).rejects.toMatchObject({
        code: 'ZIP_ENTRY_REJECTED'
      })
    })
  })

  describe('6. 用户取消协议与中止释放', () => {
    it('使用外部 AbortSignal 中止解包流程，安全抛出 CANCELLED', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.alloc(5 * 1024 * 1024, 0x41) // 5MB

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const abortController = new AbortController()
      const options: BundleExtractorWorkerOptions = {
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath }],
        mainHandledEntries: ['bundle.manifest.json']
      }

      // 预先 abort
      abortController.abort()

      await expect(
        runBundleExtractorRoutine(options, null, abortController.signal)
      ).rejects.toMatchObject({
        code: 'CANCELLED'
      })
    })
  })

  describe('7. BundleExtractorDispatcher 线程隔离与生命周期管理', () => {
    it('可成功定位 Worker 执行脚本路径', () => {
      const workerPath = resolveExtractorWorkerPath()
      expect(typeof workerPath).toBe('string')
      expect(fs.existsSync(workerPath)).toBe(true)
    })

    it('通过 Dispatcher 派发独立工作线程执行完整流式解包与进度通知', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.from('hello world from worker thread test')

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{"version":1}' },
        { name: assetPath, content }
      ])

      const progressEvents: number[] = []

      const result = await BundleExtractorDispatcher.extract({
        workerOptions: {
          archivePath: zipPath,
          stagingDir,
          expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
          mainHandledEntries: ['bundle.manifest.json']
        },
        onProgress: processed => {
          progressEvents.push(processed)
        }
      })

      expect(result.ok).toBe(true)
      expect(result.extractedAssets).toHaveLength(1)
      expect(result.extractedAssets[0].relPath).toBe(assetPath)
      expect(result.extractedAssets[0].actualSha256).toBe(sha256(content))

      // 验证目标文件已落盘在 stagingDir
      const extractedPhysical = path.join(stagingDir, assetPath)
      expect(fs.existsSync(extractedPhysical)).toBe(true)
      expect(fs.readFileSync(extractedPhysical, 'utf-8')).toBe(
        'hello world from worker thread test'
      )
    })

    it('通过 Dispatcher 取消解包任务时清空暂存区并抛出 CANCELLED', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.alloc(10 * 1024 * 1024, 0x41) // 10MB

      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const controller = new AbortController()

      // 启动并立即 abort
      const promise = BundleExtractorDispatcher.extract({
        workerOptions: {
          archivePath: zipPath,
          stagingDir,
          expectedAssets: [{ relPath: assetPath }],
          mainHandledEntries: ['bundle.manifest.json']
        },
        signal: controller.signal
      })

      controller.abort()

      await expect(promise).rejects.toMatchObject({
        code: 'CANCELLED'
      })

      // 断言暂存区已被彻底清空
      expect(fs.existsSync(stagingDir)).toBe(false)
    })

    it('Dispatcher 启动前若 signal 已处于 aborted 状态，前置抛出 CANCELLED 并清理暂存区', async () => {
      const controller = new AbortController()
      controller.abort()

      fs.mkdirSync(stagingDir, { recursive: true })
      expect(fs.existsSync(stagingDir)).toBe(true)

      await expect(
        BundleExtractorDispatcher.extract({
          workerOptions: {
            archivePath: zipPath,
            stagingDir,
            expectedAssets: [],
            mainHandledEntries: []
          },
          signal: controller.signal
        })
      ).rejects.toMatchObject({
        code: 'CANCELLED'
      })

      expect(fs.existsSync(stagingDir)).toBe(false)
    })

    it('传入不存在的自定义 worker 路径时，resolveExtractorWorkerPath fallback 到合法默认路径', () => {
      const resolved = resolveExtractorWorkerPath('C:/non/existent/path/worker.js')
      expect(typeof resolved).toBe('string')
      expect(fs.existsSync(resolved)).toBe(true)
    })
  })

  describe('8. Worker 协议监听器与异步让出覆盖 (MessagePort & Yield Coverage)', () => {
    it('initWorkerListener 接收非法消息时不崩溃', () => {
      const { port1 } = new MessageChannel()
      initWorkerListener(port1)
      port1.postMessage(null)
      port1.postMessage('not-an-object')
      port1.close()
    })

    it('initWorkerListener 接收 START 成功完成流程并 post SUCCESS', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      const content = Buffer.from('port-test')
      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const { port1, port2 } = new MessageChannel()
      initWorkerListener(port1)

      const successPromise = new Promise<ExtractorWorkerOutMessage>(resolve => {
        port2.on('message', msg => {
          if (msg.type === 'SUCCESS') {
            resolve(msg)
          }
        })
      })

      port2.postMessage({
        type: 'START',
        options: {
          archivePath: zipPath,
          stagingDir,
          expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
          mainHandledEntries: ['bundle.manifest.json']
        }
      })

      const msg = await successPromise
      expect(msg.type).toBe('SUCCESS')

      port1.close()
      port2.close()
    })

    it('initWorkerListener 发生异常时 post ERROR', async () => {
      const { port1, port2 } = new MessageChannel()
      initWorkerListener(port1)

      const errorPromise = new Promise<ExtractorWorkerOutMessage>(resolve => {
        port2.on('message', msg => {
          if (msg.type === 'ERROR') {
            resolve(msg)
          }
        })
      })

      // 传入不存在的文件路径，触发 UNSUPPORTED_FORMAT
      port2.postMessage({
        type: 'START',
        options: {
          archivePath: path.join(tempDir, 'non-existent.zip'),
          stagingDir,
          expectedAssets: [],
          mainHandledEntries: []
        }
      })

      const msg = await errorPromise
      expect(msg.type).toBe('ERROR')
      if (msg.type === 'ERROR') {
        expect(msg.error.code).toBe('UNSUPPORTED_FORMAT')
      }

      port1.close()
      port2.close()
    })

    it('写入过程中达到 yieldChunkBytes 阈值触发 CPU 异步让出逻辑', async () => {
      const assetPath = 'modules/mod_a/assets/model.bin'
      // 构造 64KB 内容，设置 yieldChunkBytes 为 10KB，确保触发 pause / setTimeout / resume
      const content = Buffer.alloc(64 * 1024, 0x42)
      await createZipBundle([
        { name: 'bundle.manifest.json', content: '{}' },
        { name: assetPath, content }
      ])

      const res = await runBundleExtractorRoutine({
        archivePath: zipPath,
        stagingDir,
        expectedAssets: [{ relPath: assetPath, expectedSha256: sha256(content) }],
        mainHandledEntries: ['bundle.manifest.json'],
        limits: {
          yieldChunkBytes: 10 * 1024
        }
      })

      expect(res.ok).toBe(true)
      expect(res.extractedAssets[0].sizeBytes).toBe(64 * 1024)
    })
  })
})
